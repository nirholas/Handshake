// GET /api/audit-log              — JSON list of the caller's audit events
// GET /api/audit-log?format=csv   — CSV download (same data, last 90 days)
//
// Backs the "Action log" panel on /dashboard-next/account. Reads from the
// audit_log table populated by api/_lib/audit.js. JSON form is cursor-
// paginated (opaque cursor = the created_at + id of the last row).
//
// Schema:
//   api/_lib/migrations/2026-05-01-audit-log.sql          — base table
//   api/_lib/migrations/2026-05-25-audit-log-context.sql  — ip + user_agent
//
// Retention: rows older than 365 days are pruned by the audit-log-cleanup
// cron (vercel.json). The CSV export caps at 90 days to keep the download
// small and predictable.

import { sql } from './_lib/db.js';
import { getSessionUser } from './_lib/auth.js';
import { cors, error, json, method, wrap } from './_lib/http.js';
import { limits } from './_lib/rate-limit.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CSV_DAYS = 90;

// Cursors are base64url("<iso-ts>|<uuid>") — the timestamp+id of the last row
// returned, used as a stable strictly-less-than key for the next page.
function encodeCursor(createdAt, id) {
	const raw = `${new Date(createdAt).toISOString()}|${id}`;
	return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
	if (!cursor) return null;
	try {
		const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
		const [iso, id] = raw.split('|');
		if (!iso || !id) return null;
		if (Number.isNaN(Date.parse(iso))) return null;
		if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
		return { iso, id };
	} catch {
		return null;
	}
}

function csvEscape(value) {
	if (value === null || value === undefined) return '';
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.auditLogRead(session.id);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const format = (url.searchParams.get('format') || '').toLowerCase();

	if (format === 'csv') return handleCsv(session.id, res);
	return handleList(session.id, url, res);
});

async function handleList(userId, url, res) {
	const rawLimit = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
	const cursor = decodeCursor(url.searchParams.get('cursor'));

	const rows = cursor
		? await sql`
			select id, action, resource_id, meta, ip, user_agent, created_at
			from audit_log
			where user_id = ${userId}
			  and (created_at, id) < (${cursor.iso}::timestamptz, ${cursor.id}::uuid)
			order by created_at desc, id desc
			limit ${limit + 1}
		`
		: await sql`
			select id, action, resource_id, meta, ip, user_agent, created_at
			from audit_log
			where user_id = ${userId}
			order by created_at desc, id desc
			limit ${limit + 1}
		`;

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;

	return json(res, 200, {
		items: page.map((r) => ({
			id: r.id,
			action: r.action,
			resource_id: r.resource_id,
			meta: r.meta,
			ip: r.ip,
			user_agent: r.user_agent,
			created_at: r.created_at,
		})),
		next_cursor: nextCursor,
		has_more: hasMore,
	});
}

async function handleCsv(userId, res) {
	const rows = await sql`
		select action, resource_id, meta, ip, user_agent, created_at
		from audit_log
		where user_id = ${userId}
		  and created_at > now() - (${CSV_DAYS} || ' days')::interval
		order by created_at desc
		limit 5000
	`;

	const header = ['when', 'action', 'resource_id', 'ip', 'user_agent', 'meta'];
	const lines = [header.join(',')];
	for (const r of rows) {
		lines.push([
			csvEscape(new Date(r.created_at).toISOString()),
			csvEscape(r.action),
			csvEscape(r.resource_id),
			csvEscape(r.ip),
			csvEscape(r.user_agent),
			csvEscape(r.meta),
		].join(','));
	}

	const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
	res.statusCode = 200;
	res.setHeader('content-type', 'text/csv; charset=utf-8');
	res.setHeader('content-disposition', `attachment; filename="${filename}"`);
	res.setHeader('cache-control', 'no-store');
	res.end(lines.join('\n') + '\n');
}
