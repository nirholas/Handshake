// One place where a raw message from any lane becomes a delivery.
//
//   lane poll  ->  contact match  ->  triage  ->  stored event  ->  notification
//
// The notification is the delivery mechanism, deliberately: it is already the
// path that reaches every surface the user has (the bell, Web Push on a phone,
// and the "avatar" channel, where the walking companion turns around and says
// the line out loud). What the companion adds on top is whose voice and whose
// body it arrives in.

import { sql } from '../db.js';
import { insertNotification } from '../notify.js';
import { loadUserProviderKeys } from '../provider-keys.js';
import { inQuietHours } from '@three-ws/companion/triage';
import { triage } from './triage.js';
import {
	getSettings,
	matchContact,
	insertEvent,
	recordSourceResult,
	dueSources,
} from './store.js';
import { decryptConfig } from './crypto.js';
import { pollTelegram, verifyTelegram } from './lanes/telegram.js';
import { pollCalendar, verifyCalendar } from './lanes/calendar.js';
import { pollEmail, verifyEmail } from './lanes/email.js';

const LANES = {
	telegram: { poll: pollTelegram, verify: verifyTelegram },
	calendar: { poll: pollCalendar, verify: verifyCalendar },
	email: { poll: pollEmail, verify: verifyEmail },
};

export function laneFor(kind) {
	return LANES[kind] || null;
}

// Quiet hours are evaluated in the user's own timezone, and a window that wraps
// midnight (22 to 7) is the normal case. Re-exported from the rules package so
// the server, the CLI, and any third-party body agree on when to stay silent.
export { inQuietHours };

async function anthropicKeyFor(userId) {
	try {
		const [row] = await sql`select provider_keys from users where id = ${userId}`;
		const keys = await loadUserProviderKeys(row?.provider_keys);
		return keys.anthropic || null;
	} catch {
		return null;
	}
}

/**
 * Store one raw lane item as a triaged event, and deliver it when it clears the
 * user's bar. Returns the stored row, or null when it was a duplicate.
 *
 * @param {object} settings row from companion_settings
 * @param {object} raw  { source_kind, source_id?, external_id, sender, sender_id,
 *                        identity_candidates?, title, body, url, occurs_at, priority_hint? }
 * @param {object} opts { anthropicKey }
 */
export async function ingestItem(settings, raw, { anthropicKey = null } = {}) {
	const userId = settings.user_id;
	const contact = await matchContact(userId, raw.identity_candidates?.length
		? raw.identity_candidates
		: [raw.sender_id, raw.sender].filter(Boolean));

	const verdict = await triage(raw, contact, { anthropicKey, userId });

	const stored = await insertEvent(userId, {
		source_id: raw.source_id ?? null,
		source_kind: raw.source_kind,
		external_id: raw.external_id,
		contact_id: contact?.id ?? null,
		sender: raw.sender ?? null,
		sender_id: raw.sender_id ?? null,
		title: raw.title,
		body: raw.body ?? null,
		url: raw.url ?? null,
		importance: verdict.importance,
		reason: verdict.reason,
		spoken_line: verdict.line,
		triage_engine: verdict.engine,
		occurs_at: raw.occurs_at ?? null,
	});
	// Already seen on an earlier poll: nothing to say a second time.
	if (!stored) return null;

	const loud = settings.enabled
		&& verdict.importance >= settings.threshold
		&& !inQuietHours(settings);

	if (loud) {
		await insertNotification(userId, 'companion_delivery', {
			event_id: stored.id,
			source: raw.source_kind,
			sender: contact?.display_name || raw.sender || null,
			title: raw.title,
			line: verdict.line,
			importance: verdict.importance,
			reason: verdict.reason,
			avatar_glb_url: contact?.avatar_glb_url || settings.avatar_glb_url || null,
			voice: contact?.voice || settings.voice || null,
			link: '/companion',
		});
		await sql`update companion_events set delivered_at = now() where id = ${stored.id}`;
		stored.delivered_at = new Date().toISOString();
	}

	return { ...stored, contact, delivered: loud };
}

/**
 * Poll one source row and ingest everything new on it.
 * Never throws: a lane failure is recorded on the source so the setup page can
 * show the user exactly what their provider said.
 */
export async function pollSource(sourceRow, { settings = null, anthropicKey = null } = {}) {
	const lane = laneFor(sourceRow.kind);
	if (!lane) return { ok: false, error: `unknown source kind: ${sourceRow.kind}`, ingested: 0 };

	const resolvedSettings = settings || (await getSettings(sourceRow.user_id));
	const key = anthropicKey ?? (await anthropicKeyFor(sourceRow.user_id));

	try {
		const config = sourceRow.config || (await decryptConfig(sourceRow.config_encrypted));
		const { items, cursor } = await lane.poll({ config, cursor: sourceRow.cursor || {} });

		let ingested = 0;
		for (const item of items) {
			const stored = await ingestItem(
				resolvedSettings,
				{ ...item, source_kind: sourceRow.kind, source_id: sourceRow.id },
				{ anthropicKey: key },
			);
			if (stored) ingested += 1;
		}

		await recordSourceResult(sourceRow.id, {
			status: 'ok',
			error: null,
			cursor,
			sawEvent: ingested > 0,
		});
		return { ok: true, ingested, scanned: items.length };
	} catch (err) {
		const message = String(err?.message || err).slice(0, 400);
		await recordSourceResult(sourceRow.id, { status: 'error', error: message });
		return { ok: false, error: message, ingested: 0 };
	}
}

/** Poll every enabled source on one account (the "check now" button). */
export async function pollUser(userId, { sourceId = null } = {}) {
	const settings = await getSettings(userId);
	const rows = sourceId
		? await sql`
			select id, user_id, kind, label, config_encrypted, cursor
			from companion_sources where id = ${sourceId} and user_id = ${userId}
		`
		: await sql`
			select id, user_id, kind, label, config_encrypted, cursor
			from companion_sources where user_id = ${userId} and enabled = true
		`;
	const anthropicKey = await anthropicKeyFor(userId);
	const results = [];
	for (const row of rows) {
		const result = await pollSource(row, { settings, anthropicKey });
		results.push({ source_id: row.id, kind: row.kind, label: row.label, ...result });
	}
	return { sources: results, ingested: results.reduce((n, r) => n + r.ingested, 0) };
}

/**
 * The cron pass: the least recently polled sources across every account, inside
 * a wall-clock budget. Whatever the budget does not reach keeps its old
 * last_polled_at and therefore sorts to the front of the next tick, so a slow
 * lane can never starve the others.
 */
export async function pollDue({ limit = 40, budgetMs = 100_000 } = {}) {
	const started = Date.now();
	const rows = await dueSources(limit);
	const summary = { considered: rows.length, polled: 0, ingested: 0, failed: 0, skipped: 0 };
	const settingsCache = new Map();
	const keyCache = new Map();

	for (const row of rows) {
		if (Date.now() - started > budgetMs) {
			summary.skipped = rows.length - summary.polled;
			break;
		}
		if (!settingsCache.has(row.user_id)) settingsCache.set(row.user_id, await getSettings(row.user_id));
		if (!keyCache.has(row.user_id)) keyCache.set(row.user_id, await anthropicKeyFor(row.user_id));
		const result = await pollSource(row, {
			settings: settingsCache.get(row.user_id),
			anthropicKey: keyCache.get(row.user_id),
		});
		summary.polled += 1;
		summary.ingested += result.ingested;
		if (!result.ok) summary.failed += 1;
	}
	return summary;
}
