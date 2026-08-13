// Audit log helper — fire-and-forget INSERT into audit_log.
//
// Policy: log sensitive state changes that need an after-the-fact "who did
// what, when" trail (deletions, revocations, ownership transfers). Reads,
// idempotent updates, and analytics belong in usage_events, not here.
//
// Schema:
//   api/_lib/migrations/2026-05-01-audit-log.sql          — base table
//   api/_lib/migrations/2026-05-25-audit-log-context.sql  — ip + user_agent
// Audit data starts 2026-05-01 — earlier deletions/revocations have no row.

import { sql } from './db.js';
import { withDbRetry } from './db-retry.js';
import { clientIp } from './rate-limit.js';

const UA_MAX = 512;

/**
 * Fire-and-forget audit log write. Never throws, never blocks the response.
 * @param {object} entry
 * @param {string|null} entry.userId      — actor (null only when actor is unknown / system)
 * @param {string} entry.action           — short kebab-case verb, e.g. 'delete_avatar'
 * @param {string|null} [entry.resourceId]
 * @param {object|null} [entry.meta]      — small JSON blob; avoid PII
 * @param {object} [entry.req]            — request, used to capture IP + UA
 * @param {string|null} [entry.ip]        — explicit override (otherwise derived from req)
 * @param {string|null} [entry.userAgent] — explicit override (otherwise derived from req)
 */
export function logAudit(entry) {
	queueMicrotask(() => { logAuditNow(entry); });
}

/**
 * The same write, awaitable. Resolves true when the row landed, false when it
 * was dropped; never throws, so a caller can report whether the trail actually
 * recorded without the write being able to fail their request.
 *
 * Use this only where the row IS the deliverable and the caller reports the
 * outcome (the legal acceptance endpoints). Everything else wants `logAudit`:
 * bookkeeping must not add DB latency to a response nobody reads it from.
 *
 * @param {Parameters<typeof logAudit>[0]} entry
 * @returns {Promise<boolean>}
 */
export async function logAuditNow({ userId, action, resourceId = null, meta = null, req = null, ip = null, userAgent = null }) {
	const resolvedIp = ip ?? (req ? clientIp(req) : null);
	const rawUa = userAgent ?? (req ? req.headers?.['user-agent'] : null);
	const resolvedUa = rawUa ? String(rawUa).slice(0, UA_MAX) : null;
	try {
		await withDbRetry(() => sql`
			insert into audit_log (user_id, action, resource_id, meta, ip, user_agent)
			values (${userId}, ${action}, ${resourceId}, ${meta}, ${resolvedIp}, ${resolvedUa})
		`, { timeoutMs: 5_000 });
		return true;
	} catch (err) {
		// A transient DB stall (Neon scale-to-zero wake, a connection blip, see
		// db-retry.js) is infrastructure, not a code fault: it drops this one
		// best-effort row but breaks nothing. Logging it at error level trips
		// false alarms, so classify it the same way db-retry/avatar-agent do and
		// warn instead; reserve error for genuinely unexpected failures.
		const detail = { action, resourceId, error: err?.message };
		const transient =
			err?.code === 'DB_TIMEOUT' ||
			/fetch failed|connecting to database|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminat/i.test(
				err?.message || '',
			);
		if (transient) console.warn('[audit] insert dropped (transient DB stall)', detail);
		else console.error('[audit] insert failed', detail);
		return false;
	}
}
