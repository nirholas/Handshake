// api/_lib/x402/pipelines/subscription-health.js
//
// Subscription Status Health Check — the work behind the
// `subscription-status-health-check` autonomous-registry entry (self). Runs daily.
//
// Every paying x402 subscriber holds an API key (x402_subscriptions) that bypasses
// the 402 challenge on our paid endpoints until it expires or is revoked. When a
// key silently lapses, the subscriber's integration starts getting charged (or
// hard-402'd) with no warning — a surprise service interruption that reads as our
// fault. This pipeline closes that gap:
//
//   1. Enumerates every subscription with the canonical listSubscriptions() lib
//      read (api-keys.js), the same book the payment gate consults. Never a
//      mock, always the real subscription table.
//   2. Classifies each one: active | expiring_soon (≤ EXPIRY_WARN_DAYS) | expired |
//      revoked, and computes days-to-expiry.
//   3. Emails the subscriber EXPIRY_WARN_DAYS (7) days before expiry — once per
//      expiry timestamp, so a renewal that pushes expires_at forward re-arms the
//      warning. Contact email is read from the subscription meta (email /
//      contact_email / contact / notify_email). No contact on file → recorded as
//      not-notifiable, never blocks the run.
//   4. Upserts each verdict into x402_subscription_health (the value sink) and
//      records ONE x402_autonomous_log row with a value_extracted summary.
//
// Free + read-only: this pipeline never moves funds (amountAtomic always 0) and
// runs even when the spend wallet is absent, mirroring the
// revenue-reconciliation precedent.
//
// Downstream consumer: ops alerting watches x402_subscription_health
// WHERE status IN ('expired','expiring_soon') to catch a lapse before a partner's
// integration breaks.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { listSubscriptions } from '../api-keys.js';
import { sendEmail } from '../../email.js';

const log = logger('x402-subscription-health');

// Stable identifier recorded as endpoint_url in x402_autonomous_log rows:
// it names the lib read that serves the data, not an HTTP route.
const ENDPOINT_ID = 'lib:x402/api-keys.listSubscriptions';
// Warn this many days before expiry. A 7-day window with a daily cadence means a
// subscriber gets at least one warning email before the key lapses.
const EXPIRY_WARN_DAYS = Number(process.env.X402_SUBSCRIPTION_WARN_DAYS || 7);
const DAY_MS = 86_400_000;

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS x402_subscription_health (
			subscription_id       text PRIMARY KEY,
			name                  text,
			key_prefix            text,
			status                text NOT NULL,           -- active | expiring_soon | expired | revoked
			rate_limit_per_minute integer,
			expires_at            timestamptz,
			revoked_at            timestamptz,
			days_to_expiry        integer,                 -- null when no expiry
			contact_email         text,
			notified_expiry_at    timestamptz,             -- the expires_at value we last emailed about
			notified_at           timestamptz,             -- when that email was sent
			last_checked_at       timestamptz NOT NULL DEFAULT now(),
			run_id                uuid,
			meta                  jsonb
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS x402_subscription_health_status_idx
		ON x402_subscription_health (status, expires_at)`;
	// Shared with other run()-style entries; idempotent.
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
	_schemaReady = true;
}

// Pull a contact email out of the subscription meta. Operators store partner
// contact details under a few conventional keys; accept the common ones and
// validate it looks like an address before we'd ever email it.
function contactEmail(meta) {
	if (!meta || typeof meta !== 'object') return null;
	const candidate =
		meta.email ||
		meta.contact_email ||
		meta.notify_email ||
		(typeof meta.contact === 'string' ? meta.contact : meta.contact?.email) ||
		null;
	if (!candidate || typeof candidate !== 'string') return null;
	const trimmed = candidate.trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

function toDate(v) {
	if (!v) return null;
	const d = v instanceof Date ? v : new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

// Pure classifier — returns { status, daysToExpiry }.
function classify(sub, now) {
	if (toDate(sub.revoked_at)) return { status: 'revoked', daysToExpiry: null };
	const exp = toDate(sub.expires_at);
	if (!exp) return { status: 'active', daysToExpiry: null };
	const days = Math.ceil((exp.getTime() - now) / DAY_MS);
	if (days <= 0) return { status: 'expired', daysToExpiry: days };
	if (days <= EXPIRY_WARN_DAYS) return { status: 'expiring_soon', daysToExpiry: days };
	return { status: 'active', daysToExpiry: days };
}

// Enumerate subscriptions with the canonical lib read, the same book the
// payment gate consults. Returns { rows, source } so the summary records which
// path served the data.
async function enumerateSubscriptions() {
	const rows = await listSubscriptions({ includeInactive: true });
	return { rows, source: 'lib' };
}

// Send the expiry warning email. Fire-and-forget at the email layer, but we await
// the send here so the per-subscription notified_at is only stamped on success.
async function sendExpiryWarning({ to, sub, daysToExpiry, expiresAt }) {
	const appUrl = env.APP_ORIGIN || 'https://three.ws';
	const when = expiresAt ? new Date(expiresAt).toUTCString() : 'soon';
	const label = sub.name || sub.id;
	const subject = `Your three.ws API subscription expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}`;
	const text =
		`Your three.ws x402 API subscription "${label}" (key ${sub.key_prefix}) expires on ${when} ` +
		`(${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'} from now).\n\n` +
		`Renew before then to avoid interruption — once the key lapses, requests on it ` +
		`will be charged per-call or rejected with a 402.\n\n` +
		`Manage your subscription: ${appUrl}/dashboard/\n\n` +
		`Questions? Reply to this email and we'll help.`;
	const html =
		`<!DOCTYPE html><html><body style="font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:#080814;color:#eee;margin:0;padding:32px 16px">` +
		`<div style="max-width:520px;margin:0 auto;background:#14141c;border:1px solid #2a2a36;border-radius:16px;padding:36px 32px">` +
		`<p style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6a5cff;margin:0 0 20px">three.ws</p>` +
		`<h1 style="font-size:22px;margin:0 0 12px">Your API subscription expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'}</h1>` +
		`<p style="color:#aaa;line-height:1.6;font-size:15px">Your subscription <strong>${esc(label)}</strong> (key <code>${esc(sub.key_prefix)}</code>) expires on <strong>${esc(when)}</strong>.</p>` +
		`<p style="color:#aaa;line-height:1.6;font-size:15px">Renew before then to avoid interruption — once the key lapses, requests on it are charged per-call or rejected with a 402.</p>` +
		`<a href="${appUrl}/dashboard/" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#6a5cff,#ff5ca8);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;margin:8px 0 20px">Manage subscription</a>` +
		`<hr style="border:none;border-top:1px solid #2a2a36;margin:24px 0">` +
		`<p style="color:#555;font-size:13px">Questions? Reply to this email and we'll help.</p>` +
		`</div></body></html>`;
	return sendEmail({ to, subject, html, text });
}

function esc(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Upsert one subscription's verdict. notified_* are only advanced when this run
// actually sent an email; otherwise the prior values are preserved so we never
// re-notify for an expiry timestamp already warned about.
async function upsert(runId, sub, verdict, contact, notifiedExpiryAt) {
	try {
		const expiresAt = toDate(sub.expires_at);
		const revokedAt = toDate(sub.revoked_at);
		const notifiedAt = notifiedExpiryAt ? new Date() : null;
		await sql`
			INSERT INTO x402_subscription_health
				(subscription_id, name, key_prefix, status, rate_limit_per_minute,
				 expires_at, revoked_at, days_to_expiry, contact_email,
				 notified_expiry_at, notified_at, last_checked_at, run_id, meta)
			VALUES
				(${sub.id}, ${sub.name || null}, ${sub.key_prefix || null}, ${verdict.status},
				 ${sub.rate_limit_per_minute ?? null}, ${expiresAt}, ${revokedAt},
				 ${verdict.daysToExpiry}, ${contact},
				 ${notifiedExpiryAt}, ${notifiedAt},
				 now(), ${runId}, ${sub.meta ? JSON.stringify(sub.meta) : null})
			ON CONFLICT (subscription_id) DO UPDATE SET
				name                  = EXCLUDED.name,
				key_prefix            = EXCLUDED.key_prefix,
				status                = EXCLUDED.status,
				rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
				expires_at            = EXCLUDED.expires_at,
				revoked_at            = EXCLUDED.revoked_at,
				days_to_expiry        = EXCLUDED.days_to_expiry,
				contact_email         = EXCLUDED.contact_email,
				notified_expiry_at    = COALESCE(EXCLUDED.notified_expiry_at, x402_subscription_health.notified_expiry_at),
				notified_at           = COALESCE(EXCLUDED.notified_at, x402_subscription_health.notified_at),
				last_checked_at       = now(),
				run_id                = EXCLUDED.run_id,
				meta                  = EXCLUDED.meta
		`;
	} catch (err) {
		log.warn('subscription_health_upsert_failed', { id: sub.id, message: err?.message });
	}
}

// Has this exact expiry timestamp already been warned about? Reads the prior
// health row so a daily cadence emails at most once per expiry window.
async function alreadyNotified(subId, expiresAt) {
	if (!expiresAt) return false;
	try {
		const rows = await sql`
			SELECT notified_expiry_at FROM x402_subscription_health
			WHERE subscription_id = ${subId} LIMIT 1
		`;
		const prev = toDate(rows[0]?.notified_expiry_at);
		return !!prev && prev.getTime() === new Date(expiresAt).getTime();
	} catch {
		return false;
	}
}

async function recordLogRow(runId, { endpointUrl, durationMs, success, errorMsg, summary }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'Subscription Status Health Check'}, ${endpointUrl},
				 ${'solana:mainnet'}, ${0}, ${null}, ${null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${summary ? JSON.stringify(summary) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'self'})
		`;
	} catch (err) {
		log.warn('subscription_health_log_insert_failed', { message: err?.message });
	}
}

/**
 * Run the subscription health check. Conforms to the run()-style registry
 * contract: the loop hands { origin, runId, ... }. Read-only + free, so it never
 * touches the spend wallet and runs standalone for manual testing.
 *
 * Returns the aggregate outcome the loop records — recorded:true since this
 * pipeline writes its own canonical x402_autonomous_log row.
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const endpointUrl = ENDPOINT_ID;
	const t0 = Date.now();

	try {
		await ensureSchema();
	} catch (err) {
		log.warn('subscription_health_schema_failed', { message: err?.message });
		return {
			success: false, skipped: true, recorded: false,
			amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}`,
		};
	}

	let rows = [];
	let source = 'lib';
	try {
		({ rows, source } = await enumerateSubscriptions());
	} catch (err) {
		const durationMs = Date.now() - t0;
		const errorMsg = err?.message || 'enumerate_failed';
		await recordLogRow(runId, { endpointUrl, durationMs, success: false, errorMsg, summary: null });
		return { success: false, recorded: true, amountAtomic: 0, errorMsg };
	}

	const now = Date.now();
	const summary = {
		source,
		checked: rows.length,
		active: 0,
		expiring_soon: 0,
		expired: 0,
		revoked: 0,
		emailed: 0,
		email_skipped_no_contact: 0,
		email_skipped_unconfigured: 0,
		email_failed: 0,
		expiring_sample: [],
	};

	for (const sub of rows) {
		const verdict = classify(sub, now);
		summary[verdict.status] = (summary[verdict.status] || 0) + 1;

		const contact = contactEmail(sub.meta);
		let notifiedExpiryAt = null;

		if (verdict.status === 'expiring_soon') {
			summary.expiring_sample.push({
				id: sub.id, name: sub.name || null, days: verdict.daysToExpiry, has_contact: !!contact,
			});
			if (!contact) {
				summary.email_skipped_no_contact += 1;
			} else if (await alreadyNotified(sub.id, sub.expires_at)) {
				// Already warned for this exact expiry window — nothing to do.
			} else {
				try {
					const result = await sendExpiryWarning({
						to: contact, sub, daysToExpiry: verdict.daysToExpiry, expiresAt: sub.expires_at,
					});
					if (result?.skipped) {
						// RESEND_API_KEY unset (dev/preview) — don't stamp notified, so the
						// warning fires for real once email is configured.
						summary.email_skipped_unconfigured += 1;
					} else {
						notifiedExpiryAt = toDate(sub.expires_at);
						summary.emailed += 1;
					}
				} catch (err) {
					summary.email_failed += 1;
					log.warn('subscription_expiry_email_failed', { id: sub.id, message: err?.message });
				}
			}
		}

		await upsert(runId, sub, verdict, contact, notifiedExpiryAt);
	}
	summary.expiring_sample = summary.expiring_sample.slice(0, 20);

	const durationMs = Date.now() - t0;
	await recordLogRow(runId, { endpointUrl, durationMs, success: true, errorMsg: null, summary });

	log.info('subscription_health_complete', {
		run_id: runId,
		source,
		checked: summary.checked,
		expiring_soon: summary.expiring_soon,
		expired: summary.expired,
		emailed: summary.emailed,
		duration_ms: durationMs,
	});

	return {
		success: true,
		recorded: true,
		amountAtomic: 0,
		txSig: null,
		errorMsg: null,
		responseData: {
			source: summary.source,
			checked: summary.checked,
			expiring_soon: summary.expiring_soon,
			expired: summary.expired,
			revoked: summary.revoked,
			emailed: summary.emailed,
		},
		valueExtracted: summary,
		note: `subs checked=${summary.checked} expiring=${summary.expiring_soon} expired=${summary.expired} emailed=${summary.emailed}`,
	};
}

// Pure helpers exposed for unit tests (no DB / network).
export const __test = { classify, contactEmail, EXPIRY_WARN_DAYS };
