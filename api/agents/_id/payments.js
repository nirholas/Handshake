import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	return bearer ? { userId: bearer.userId } : null;
}

// GET /api/agents/:id/payments?direction=sent|received&limit=20&cursor=
export const handlePayments = wrap(async (req, res, id) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [agent] = await sql`
		select id, user_id from agent_identities
		where id = ${id} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const url = new URL(req.url, 'http://x');
	const direction = url.searchParams.get('direction') === 'received' ? 'received' : 'sent';

	// `parseInt` yields NaN on a non-numeric limit and a negative on `?limit=-5`,
	// both of which reached Postgres as `LIMIT NaN` / `LIMIT -4` and 500'd the
	// endpoint. Clamp to the supported window instead.
	const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
	const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

	// Cursor format: `<iso_timestamp>|<uuid>`, matching the agent action log
	// (api/agents/_id/_sub.js). The rows are ordered by `created_at`, so the old
	// `id < cursor` keyset compared random v4 uuids against a timestamp ordering
	// and silently skipped or repeated rows across pages; the id is only the
	// tiebreaker for rows sharing a `created_at`. A malformed cursor used to hit
	// Postgres as an invalid uuid literal and 500 — it is validated here instead.
	const rawCursor = url.searchParams.get('cursor');
	let cursorTs = null;
	let cursorId = null;
	if (rawCursor) {
		const pipe = rawCursor.indexOf('|');
		const ts = pipe > 0 ? rawCursor.slice(0, pipe) : rawCursor;
		const rowId = pipe > 0 ? rawCursor.slice(pipe + 1) : null;
		if (Number.isNaN(Date.parse(ts)) || (rowId !== null && !isUuid(rowId))) {
			return error(res, 400, 'validation_error', 'cursor must be `<iso_timestamp>|<uuid>`');
		}
		cursorTs = ts;
		cursorId = rowId;
	}

	const rows =
		direction === 'sent'
			? await sql`
				select
					ap.id, ap.payer_agent_id, ap.payee_agent_id,
					ap.amount_wei, ap.chain_id, ap.tx_hash, ap.memo, ap.status, ap.created_at,
					ms.name as skill_name, ms.slug as skill_slug,
					payee.name as payee_name
				from agent_payments ap
				left join marketplace_skills ms on ms.id = ap.skill_id
				left join agent_identities payee on payee.id = ap.payee_agent_id
				where ap.payer_agent_id = ${id}
				  and (
					${cursorTs}::timestamptz is null
					or ap.created_at < ${cursorTs}::timestamptz
					or (ap.created_at = ${cursorTs}::timestamptz
					    and (${cursorId}::uuid is null or ap.id < ${cursorId}::uuid))
				  )
				order by ap.created_at desc, ap.id desc
				limit ${limit + 1}
			`
			: await sql`
				select
					ap.id, ap.payer_agent_id, ap.payee_agent_id,
					ap.amount_wei, ap.chain_id, ap.tx_hash, ap.memo, ap.status, ap.created_at,
					ms.name as skill_name, ms.slug as skill_slug,
					payer.name as payer_name
				from agent_payments ap
				left join marketplace_skills ms on ms.id = ap.skill_id
				left join agent_identities payer on payer.id = ap.payer_agent_id
				where ap.payee_agent_id = ${id}
				  and (
					${cursorTs}::timestamptz is null
					or ap.created_at < ${cursorTs}::timestamptz
					or (ap.created_at = ${cursorTs}::timestamptz
					    and (${cursorId}::uuid is null or ap.id < ${cursorId}::uuid))
				  )
				order by ap.created_at desc, ap.id desc
				limit ${limit + 1}
			`;

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null;

	return json(res, 200, { payments: page, next_cursor: nextCursor, direction });
});
