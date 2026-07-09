/**
 * Agent Sniper — closed trade history for the authenticated owner.
 *
 *   GET /api/sniper/history?network=mainnet&limit=50&agent_id=<uuid>
 *
 * Returns the calling user's own closed sniper positions — the exact rows that
 * feed the summary stats on /dashboard/sniper, but as individual trades so the
 * owner can audit every win and loss.
 *
 * Auth: session cookie OR bearer token (same as /api/sniper/strategy).
 * Rate-limited: authIp bucket.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
function solscan(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

const sol = (l) => (l != null ? Number(BigInt(l)) / 1e9 : null);

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to view your trade history');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limitN = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
	const agentIdParam = (params.get('agent_id') || '').trim();
	const agentId = isUuid(agentIdParam) ? agentIdParam : null;

	const rows = agentId
		? await sql`
			select p.id, p.agent_id, p.network, p.mint, p.symbol, p.name,
			       p.status, p.exit_reason, p.entry_quote_lamports, p.exit_quote_lamports,
			       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
			       p.exec_route, p.tip_lamports, p.priority_fee_microlamports, p.landed_ms,
			       p.opened_at, p.closed_at,
			       a.name as agent_name, a.profile_image_url as agent_image, a.avatar_url as agent_avatar
			from agent_sniper_positions p
			join agent_identities a on a.id = p.agent_id
			where p.user_id = ${userId}
			  and p.network = ${network}
			  and p.agent_id = ${agentId}
			  and p.status = 'closed'
			order by p.closed_at desc
			limit ${limitN}
		`
		: await sql`
			select p.id, p.agent_id, p.network, p.mint, p.symbol, p.name,
			       p.status, p.exit_reason, p.entry_quote_lamports, p.exit_quote_lamports,
			       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
			       p.exec_route, p.tip_lamports, p.priority_fee_microlamports, p.landed_ms,
			       p.opened_at, p.closed_at,
			       a.name as agent_name, a.profile_image_url as agent_image, a.avatar_url as agent_avatar
			from agent_sniper_positions p
			join agent_identities a on a.id = p.agent_id
			where p.user_id = ${userId}
			  and p.network = ${network}
			  and p.status = 'closed'
			order by p.closed_at desc
			limit ${limitN}
		`;

	const trades = rows.map((r) => ({
		id: r.id,
		agent_id: r.agent_id,
		agent_name: r.agent_name,
		agent_image: r.agent_image || r.agent_avatar || null,
		mint: r.mint,
		symbol: r.symbol || r.name || 'UNKNOWN',
		exit_reason: r.exit_reason,
		entry_sol: sol(r.entry_quote_lamports),
		exit_sol: sol(r.exit_quote_lamports),
		pnl_sol: sol(r.realized_pnl_lamports),
		pnl_pct: r.realized_pnl_pct != null ? Number(r.realized_pnl_pct) : null,
		buy_url: solscan(r.buy_sig, network),
		sell_url: solscan(r.sell_sig, network),
		exec_route: r.exec_route || null,
		tip_lamports: r.tip_lamports != null ? Number(r.tip_lamports) : null,
		priority_fee_microlamports: r.priority_fee_microlamports != null ? Number(r.priority_fee_microlamports) : null,
		landed_ms: r.landed_ms != null ? Number(r.landed_ms) : null,
		opened_at: r.opened_at,
		closed_at: r.closed_at,
	}));

	return json(res, 200, { trades, total: trades.length, network });
});
