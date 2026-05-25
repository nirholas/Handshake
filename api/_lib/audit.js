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
export function logAudit({ userId, action, resourceId = null, meta = null, req = null, ip = null, userAgent = null }) {
	const resolvedIp = ip ?? (req ? clientIp(req) : null);
	const rawUa = userAgent ?? (req ? req.headers?.['user-agent'] : null);
	const resolvedUa = rawUa ? String(rawUa).slice(0, UA_MAX) : null;
	queueMicrotask(async () => {
		try {
			await sql`
				insert into audit_log (user_id, action, resource_id, meta, ip, user_agent)
				values (${userId}, ${action}, ${resourceId}, ${meta}, ${resolvedIp}, ${resolvedUa})
			`;
		} catch (err) {
			console.error('[audit] insert failed', { action, resourceId, error: err?.message });
		}
	});
}
