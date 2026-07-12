// @ts-check
// Ops alerts. Errors should find the operator, not wait to be hunted:
// serverError()/wrap() report 5xx server faults here and api/client-errors.js
// reports browser errors, so production failures surface seconds after they
// happen.
//
// Two independent sinks, and the DB one is always on:
//   1. The admin dashboard (PRIMARY). Every alert is upserted into `ops_alerts`
//      keyed by its stable signature — a recurring condition is ONE row with a
//      growing count, not a flood. This happens regardless of any Telegram
//      config, so the ops surface at /admin/ops always has the record. Read via
//      GET /api/admin/ops-alerts.
//   2. Telegram (OPTIONAL push). Only when BOTH vars are set:
//        TELEGRAM_BOT_TOKEN      — the platform bot
//        TELEGRAM_ALERTS_CHAT_ID — a PRIVATE ops chat/DM. Never the public
//                                  holders' channel: alerts carry stack traces,
//                                  URLs, and IPs. Absent → dashboard-only, which
//                                  is the intended default.
//
// Noise control on the Telegram push (the dashboard keeps the full count):
//   - per-signature dedup: one push per unique signature per hour
//   - global ceiling: max 20 pushes per hour, then one "throttled" notice
// Both windows live in the shared cache (Redis when configured, else in-memory).
//
// Fire-and-forget like sentry.js: every failure swallowed, the DB write is a
// single-row upsert, the Telegram send has a hard 2.5s abort. An alerting
// pipeline must never delay or break the request it's reporting on.

import { createHash } from 'node:crypto';
import { cacheGet, cacheSet } from './cache.js';

const DEDUP_TTL_S = 60 * 60;
const GLOBAL_LIMIT_PER_HOUR = 20;

function config() {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ALERTS_CHAT_ID;
	return token && chatId ? { token, chatId } : null;
}

/**
 * Whether the Telegram PUSH channel is wired. The dashboard sink is always on,
 * so this is not "are alerts working" — it is "do alerts also get pushed to
 * Telegram". /api/healthz reports it so a deliberately dashboard-only setup
 * reads as intentional rather than broken.
 * @returns {boolean}
 */
export function alertsConfigured() {
	return config() !== null;
}

function signatureOf(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Classify an alert by its title. Callers encode urgency with a leading emoji
 * (🚨 for compromise/leak/CRITICAL, ⚠️/💸/⛽/💵 for degradations); map that to a
 * stable severity the dashboard can sort and colour by. Overridable via
 * opts.severity.
 * @param {string} title
 * @returns {'critical'|'warn'|'info'}
 */
export function severityOf(title) {
	const t = String(title || '');
	if (/🚨/.test(t) || /\b(CRITICAL|LEAK|COMPROMISED|halted)\b/i.test(t)) return 'critical';
	if (/ℹ️|\binfo\b/i.test(t)) return 'info';
	return 'warn';
}

/**
 * Upsert the alert into `ops_alerts`. Best-effort and fail-soft: a missing DB,
 * an absent table (pre-migration), or any query error is swallowed so the
 * caller's error path is never affected. Keyed by signature so repeats
 * increment a count and refresh last_seen instead of piling up rows; a repeat
 * also clears a prior acknowledgement (the condition is happening again).
 * @param {{ sig: string, title: string, detail: string, severity: string, environment: string }} a
 */
async function persistAlert({ sig, title, detail, severity, environment }) {
	try {
		const [{ sql }, { databaseConfigured }] = await Promise.all([
			import('./db.js'),
			import('./env.js'),
		]);
		if (typeof databaseConfigured === 'function' && !databaseConfigured()) return;
		await sql`
			insert into ops_alerts (signature, title, detail, severity, environment, count, first_seen, last_seen)
			values (${sig}, ${title}, ${detail || null}, ${severity}, ${environment}, 1, now(), now())
			on conflict (signature) do update set
				title = excluded.title,
				detail = excluded.detail,
				severity = excluded.severity,
				environment = excluded.environment,
				count = ops_alerts.count + 1,
				last_seen = now(),
				acknowledged_at = null,
				acknowledged_by = null
		`;
	} catch {
		/* dashboard sink is best-effort — never throws into the caller */
	}
}

function post(cfg, text) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2500);
	fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: cfg.chatId,
			text: text.slice(0, 4000), // Telegram message hard limit is 4096
			disable_web_page_preview: true,
		}),
		signal: controller.signal,
		keepalive: true,
	})
		.catch(() => {})
		.finally(() => clearTimeout(timer));
}

/**
 * Send an ops alert. Always recorded to the dashboard (`ops_alerts`); also
 * pushed to Telegram when that channel is configured (deduped + throttled).
 * Safe to call on every error path — fail-soft, never throws.
 * @param {string} title    one-line summary, e.g. "5xx in /api/chat"
 * @param {string} [detail] body lines (message, ref, page, stack head)
 * @param {{ signature?: string, severity?: 'critical'|'warn'|'info' }} [opts]
 *        signature overrides the dedup/identity key when the title/detail carry
 *        per-event noise (ids, refs) that would otherwise defeat coalescing;
 *        severity overrides the title-derived classification.
 */
export async function sendOpsAlert(title, detail = '', opts = {}) {
	const environment = process.env.VERCEL_ENV || 'development';
	const sig = signatureOf(opts.signature || `${title}\n${detail}`);
	const severity = opts.severity || severityOf(title);

	// 1. Dashboard sink — always on, independent of Telegram.
	await persistAlert({ sig, title, detail, severity, environment });

	// 2. Telegram push — optional, only when a private ops chat is wired.
	const cfg = config();
	if (!cfg) return;
	try {
		if (await cacheGet(`alert:dedup:${sig}`)) return;
		await cacheSet(`alert:dedup:${sig}`, 1, DEDUP_TTL_S);

		const hourBucket = `alert:global:${Math.floor(Date.now() / 3_600_000)}`;
		const sent = Number((await cacheGet(hourBucket)) || 0);
		if (sent >= GLOBAL_LIMIT_PER_HOUR) {
			if (sent === GLOBAL_LIMIT_PER_HOUR) {
				await cacheSet(hourBucket, sent + 1, DEDUP_TTL_S);
				post(cfg, `⚠️ three.ws alerts throttled — over ${GLOBAL_LIMIT_PER_HOUR}/h. Check /admin/ops.`);
			}
			return;
		}
		await cacheSet(hourBucket, sent + 1, DEDUP_TTL_S);

		post(cfg, `🔴 three.ws [${environment}] ${title}${detail ? `\n${detail}` : ''}`);
	} catch {
		/* push is best-effort, never throws into the caller */
	}
}
