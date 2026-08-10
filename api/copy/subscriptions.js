/**
 * Copy-trading subscriptions — the copier's follow list.
 *
 *   GET    /api/copy/subscriptions                 list mine (+ leader info, counts)
 *   POST   /api/copy/subscriptions                 create/update a subscription
 *   POST   /api/copy/subscriptions  { id, status } pause / resume / stop
 *   DELETE /api/copy/subscriptions?id=<id>         stop (soft — keeps history)
 *
 * Auth required (session cookie or bearer). Non-custodial: we store the copier's
 * own wallet and their sizing/guard rules — never keys, never custody.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { normalizeSubscriptionInput } from '../_lib/copy-engine.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Returns { userId, viaSession } or null (after writing a 401). Cookie-session
// writes additionally require a CSRF token; bearer clients are not CSRF-vulnerable.
async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	return { userId: session?.id ?? bearer.userId, viaSession: !!session };
}

async function listForUser(userId) {
	return sql`
		select s.*, a.name as leader_name, a.avatar_url as leader_avatar, a.profile_image_url as leader_image,
		       (select count(*) from copy_executions e where e.subscription_id = s.id and e.status = 'pending') as pending_count,
		       (select count(*) from copy_executions e where e.subscription_id = s.id and e.status = 'acted')   as acted_count
		from copy_subscriptions s
		join agent_identities a on a.id = s.leader_agent_id
		where s.copier_user_id = ${userId}
		order by s.created_at desc
	`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await requireUser(req, res);
	if (!auth) return;
	const { userId } = auth;

	if (req.method === 'GET') {
		const rows = await listForUser(userId);
		return json(res, 200, { subscriptions: rows });
	}

	// State-changing methods: enforce CSRF for cookie-session callers.
	if (auth.viaSession && !(await requireCsrf(req, res, userId))) return;

	if (req.method === 'DELETE') {
		const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
		if (!isUuid(id)) return error(res, 400, 'invalid_id', 'id must be a subscription UUID');
		const [row] = await sql`
			update copy_subscriptions set status = 'stopped', updated_at = now()
			where id = ${id} and copier_user_id = ${userId}
			returning id
		`;
		if (!row) return error(res, 404, 'not_found', 'No such subscription.');
		return json(res, 200, { ok: true, id, status: 'stopped' });
	}

	// POST
	const body = await readJson(req).catch(() => null);
	if (!body || typeof body !== 'object') return error(res, 400, 'bad_request', 'JSON body required');

	// Status-only update (pause / resume / stop).
	if (body.id && body.status && Object.keys(body).length <= 2) {
		if (!isUuid(body.id)) return error(res, 400, 'invalid_id', 'id must be a subscription UUID');
		if (!['active', 'paused', 'stopped'].includes(body.status)) {
			return error(res, 400, 'invalid_status', 'status must be active, paused, or stopped');
		}
		const [row] = await sql`
			update copy_subscriptions set status = ${body.status}, updated_at = now()
			where id = ${body.id} and copier_user_id = ${userId}
			returning *
		`;
		if (!row) return error(res, 404, 'not_found', 'No such subscription.');
		return json(res, 200, { subscription: row });
	}

	// Create / update.
	const leaderId = String(body.leader_agent_id || '').trim();
	const wallet = String(body.copier_wallet || '').trim();
	const network = NETWORKS.has(body.network) ? body.network : 'mainnet';
	if (!isUuid(leaderId)) return error(res, 400, 'invalid_leader', 'leader_agent_id must be an agent UUID');
	if (!BASE58_RE.test(wallet)) return error(res, 400, 'invalid_wallet', 'copier_wallet must be a valid Solana address');

	const [leader] = await sql`
		select id, is_public from agent_identities where id = ${leaderId} limit 1
	`;
	if (!leader || leader.is_public === false) return error(res, 404, 'leader_not_found', 'No such public trader.');

	const norm = normalizeSubscriptionInput(body);
	if (!norm.ok) return error(res, 400, 'invalid_config', norm.error);
	const v = norm.value;

	// Denormalize the leader's trading wallet from their most recent sniper position.
	const [pos] = await sql`
		select wallet from agent_sniper_positions
		where agent_id = ${leaderId} and network = ${network}
		order by opened_at desc limit 1
	`;
	const leaderWallet = pos?.wallet || null;

	const [row] = await sql`
		insert into copy_subscriptions (
			copier_user_id, copier_wallet, leader_agent_id, leader_wallet, network, status,
			sizing_rule, fixed_sol, multiplier, pct_balance,
			per_trade_cap_sol, min_order_sol, daily_budget_sol, max_open_copies,
			mcap_floor_usd, mcap_ceiling_usd, copy_sells, require_safety_pass, min_oracle_score, perf_fee_bps,
			telegram_chat_id
		) values (
			${userId}, ${wallet}, ${leaderId}, ${leaderWallet}, ${network}, 'active',
			${v.sizing_rule}, ${v.fixed_sol}, ${v.multiplier}, ${v.pct_balance},
			${v.per_trade_cap_sol}, ${v.min_order_sol}, ${v.daily_budget_sol}, ${v.max_open_copies},
			${v.mcap_floor_usd}, ${v.mcap_ceiling_usd}, ${v.copy_sells}, ${v.require_safety_pass}, ${v.min_oracle_score}, ${v.perf_fee_bps},
			${v.telegram_chat_id || null}
		)
		on conflict (copier_user_id, leader_agent_id, network) do update set
			copier_wallet = excluded.copier_wallet,
			leader_wallet = excluded.leader_wallet,
			status = 'active',
			sizing_rule = excluded.sizing_rule,
			fixed_sol = excluded.fixed_sol,
			multiplier = excluded.multiplier,
			pct_balance = excluded.pct_balance,
			per_trade_cap_sol = excluded.per_trade_cap_sol,
			min_order_sol = excluded.min_order_sol,
			daily_budget_sol = excluded.daily_budget_sol,
			max_open_copies = excluded.max_open_copies,
			mcap_floor_usd = excluded.mcap_floor_usd,
			mcap_ceiling_usd = excluded.mcap_ceiling_usd,
			copy_sells = excluded.copy_sells,
			require_safety_pass = excluded.require_safety_pass,
			min_oracle_score = excluded.min_oracle_score,
			perf_fee_bps = excluded.perf_fee_bps,
			telegram_chat_id = excluded.telegram_chat_id,
			updated_at = now()
		returning *
	`;
	return json(res, 200, { subscription: row });
});
