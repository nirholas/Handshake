/**
 * Copy-trading executions — the copier's intent inbox + history.
 *
 *   GET  /api/copy/executions?status=pending|acted|dismissed|skipped|all&limit=
 *        list the signed-in copier's copy intents (newest first), with leader + coin info.
 *   POST /api/copy/executions  { id, action: 'acted'|'dismissed', tx_signature? }
 *        the copier records that they acted on (or dismissed) a pending intent.
 *
 * Non-custodial: marking 'acted' just records that the copier executed it from
 * their own wallet (optionally with the fill signature for their records) — the
 * platform never signs or broadcasts here.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const STATUSES = new Set(['pending', 'acted', 'dismissed', 'skipped', 'expired', 'all']);

async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	return { userId: session?.id ?? bearer.userId, viaSession: !!session };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const { userId } = auth;

	if (req.method === 'GET') {
		const params = new URL(req.url, 'http://x').searchParams;
		const status = STATUSES.has(params.get('status')) ? params.get('status') : 'pending';
		const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));

		// Expire stale pending intents lazily on read so the inbox never shows
		// actionable copies for coins that have long since moved.
		await sql`
			update copy_executions set status = 'expired', updated_at = now()
			where copier_user_id = ${userId} and status = 'pending' and expires_at < now()
		`;

		const rows = status === 'all'
			? await sql`
				select e.*, a.name as leader_name, a.profile_image_url as leader_image, a.avatar_url as leader_avatar
				from copy_executions e
				join agent_identities a on a.id = e.leader_agent_id
				where e.copier_user_id = ${userId}
				order by e.created_at desc limit ${limit}
			`
			: await sql`
				select e.*, a.name as leader_name, a.profile_image_url as leader_image, a.avatar_url as leader_avatar
				from copy_executions e
				join agent_identities a on a.id = e.leader_agent_id
				where e.copier_user_id = ${userId} and e.status = ${status}
				order by e.created_at desc limit ${limit}
			`;
		return json(res, 200, { executions: rows });
	}

	// POST — act / dismiss. Enforce CSRF for cookie-session callers.
	if (auth.viaSession && !(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');
	const id = String(body.id || '').trim();
	const action = body.action;
	if (!isUuid(id)) return error(res, 400, 'invalid_id', 'id must be an execution UUID');
	if (!['acted', 'dismissed'].includes(action)) return error(res, 400, 'invalid_action', 'action must be acted or dismissed');

	const txSig = action === 'acted' && typeof body.tx_signature === 'string'
		? body.tx_signature.trim().slice(0, 128) || null : null;

	const [row] = await sql`
		update copy_executions
		set status = ${action}, tx_signature = ${txSig}, updated_at = now()
		where id = ${id} and copier_user_id = ${userId} and status = 'pending'
		returning *
	`;
	if (!row) return error(res, 409, 'not_actionable', 'No such pending intent (it may have expired or already been actioned).');
	return json(res, 200, { execution: row });
});
