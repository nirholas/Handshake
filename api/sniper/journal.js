/**
 * Agent Sniper — trade journal for the authenticated owner.
 *
 *   GET /api/sniper/journal?network=mainnet&limit=100&agent_id=<uuid>
 *
 * The "learn what works" surface: every entry and every exit leg with its
 * reasoning (why bought — trigger/mcap/score; why/how much sold — take-initials/
 * trailing/stop/timeout, the fraction, the leg PnL). Unlike /api/sniper/history
 * (closed positions only), the journal shows the full decision trail including
 * partial take-initials legs on positions that are still open.
 *
 * Auth: session cookie OR bearer token (same as /api/sniper/strategy).
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const sol = (l) => (l != null ? Number(l) / 1e9 : null);

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
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to view your trade journal');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const limitN = Math.min(500, Math.max(1, Number(params.get('limit')) || 100));
	const agentIdParam = (params.get('agent_id') || '').trim();
	const agentId = isUuid(agentIdParam) ? agentIdParam : null;

	// The journal is joined to the caller's own strategies so a user only ever
	// sees journal rows for agents they own — trading_journal has no user_id of
	// its own, so ownership is enforced through agent_sniper_strategies.
	let rows = [];
	try {
		rows = agentId
			? await sql`
				select j.* from trading_journal j
				where j.network = ${network} and j.agent_id = ${agentId}
				  and exists (select 1 from agent_sniper_strategies s
				              where s.agent_id = j.agent_id and s.user_id = ${userId})
				order by j.ts desc limit ${limitN}
			`
			: await sql`
				select j.* from trading_journal j
				where j.network = ${network}
				  and exists (select 1 from agent_sniper_strategies s
				              where s.agent_id = j.agent_id and s.user_id = ${userId})
				order by j.ts desc limit ${limitN}
			`;
	} catch (err) {
		// Table not created yet (no trades journaled) — return an empty journal
		// rather than a 500, so a fresh experiment reads cleanly.
		if (/relation .*trading_journal.* does not exist/i.test(err?.message || '')) {
			return json(res, 200, { journal: [], total: 0, network });
		}
		throw err;
	}

	const journal = rows.map((r) => ({
		id: Number(r.id),
		ts: r.ts,
		agent_id: r.agent_id,
		position_id: r.position_id != null ? Number(r.position_id) : null,
		mint: r.mint,
		symbol: r.symbol || 'UNKNOWN',
		event: r.event,
		reason: r.reason,
		mode: r.mode,
		venue: r.venue,
		sold_fraction: r.sold_fraction != null ? Number(r.sold_fraction) : null,
		leg_pnl_sol: sol(r.leg_pnl_lamports),
		market_cap_usd: r.market_cap_usd != null ? Number(r.market_cap_usd) : null,
		score: r.score != null ? Number(r.score) : null,
		rationale: r.rationale,
	}));

	return json(res, 200, { journal, total: journal.length, network });
});
