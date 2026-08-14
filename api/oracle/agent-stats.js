/**
 * Oracle — public agent track record.
 *
 *   GET /api/oracle/agent-stats?agent_id=<uuid>&network=mainnet&limit=20
 *
 * Returns an agent's oracle trading summary (win rate, realized PnL, ROI) plus
 * the N most recent actions so any visitor can verify the track record.
 * This endpoint is public — no auth required. It's the evidence behind copy-
 * trading: followers can see exactly which conviction calls were made and how
 * they resolved before choosing to mirror a leader.
 *
 * An agent with no oracle activity returns 200 with an empty summary
 * (summary.total === 0), not a 404 — "no track record yet" is a valid state the
 * widget hides, and most agents never trade through the oracle. Only a malformed
 * agent_id is a 400.
 *
 * Cache: 60s public CDN (the data changes only when the settle-loop runs).
 */

import { cors, json, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { recentActions, actionsSummary } from '../_lib/oracle/store.js';
import { isUuid } from '../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
export default async function handleAgentStats(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const agentId = params.get('agent_id') || '';
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	// parseInt('abc') is NaN, and Math.max/min propagate it — an unparseable limit
	// used to reach the SQL `limit NaN`, which the store's read catches into an
	// empty array. The caller then got a 200 whose summary said 17 actions next to
	// an empty recent_actions and an empty by_tier. Fall back to the documented
	// default instead of shipping that contradiction.
	const limitRaw = parseInt(params.get('limit') || '20', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;

	if (!isUuid(agentId)) {
		return json(res, 400, { error: 'invalid_agent_id', message: 'agent_id must be a UUID' });
	}

	// The track record lives in oracle_watch_actions, keyed by agent_id alone.
	// The agent_identities row only enriches the response with a name/avatar so
	// callers don't need a separate /api/agents fetch. Most agents never trade
	// through the oracle, so a missing identity row is the common case — not an
	// error: return an empty record (summary.total === 0) and let the caller hide
	// the widget rather than 404'ing every agent page. All three reads are
	// independent, so run them concurrently.
	const [agentRow, summary, actions] = await Promise.all([
		sql`select name, description, image_url from agent_identities where id = ${agentId}`
			.then((rows) => rows[0] || null)
			.catch(() => null),
		actionsSummary(agentId, network),
		recentActions(agentId, network, limit),
	]);

	// Per-tier breakdown from the action ledger.
	const byTier = {};
	for (const a of actions) {
		if (!a.tier) continue;
		if (!byTier[a.tier]) byTier[a.tier] = { total: 0, wins: 0, losses: 0 };
		byTier[a.tier].total++;
		if (a.outcome === 'win') byTier[a.tier].wins++;
		else if (a.outcome === 'loss') byTier[a.tier].losses++;
	}
	for (const t of Object.values(byTier)) {
		const resolved = t.wins + t.losses;
		t.win_rate = resolved > 0 ? Math.round((t.wins / resolved) * 100) : null;
	}

	return json(res, 200, {
		agent: {
			id: agentId,
			name: agentRow?.name || null,
			description: agentRow?.description || null,
			image_url: agentRow?.image_url || null,
		},
		network,
		summary,
		by_tier: byTier,
		recent_actions: actions.map((a) => ({
			mint: a.mint,
			symbol: a.symbol,
			conviction: a.conviction,
			tier: a.tier,
			mode: a.mode,
			size_sol: a.size_sol != null ? Number(a.size_sol) : null,
			status: a.status,
			reason: a.reason,
			peak_multiple: a.peak_multiple != null ? Number(a.peak_multiple) : null,
			realized_pnl_sol: a.realized_pnl_sol != null ? Number(a.realized_pnl_sol) : null,
			outcome: a.outcome || 'open',
			acted_at: a.acted_at,
			pump_url: `https://pump.fun/coin/${a.mint}`,
			oracle_url: `https://three.ws/oracle?mint=${a.mint}`,
		})),
	}, { 'cache-control': 'public, max-age=60, s-maxage=60' });
}
