/**
 * Agent Sniper — public leaderboard + recent trades.
 *
 *   GET /api/sniper/leaderboard?network=mainnet&window=30d&sort=score&verified=1
 *
 * Ranks agents by their composite TraderScore (or a chosen metric) over a time
 * window, computed by the shared trader-stats truth layer so this board and the
 * /trader/:id profile can never disagree. Also returns the most recent closed
 * trades + currently-open positions for the /play arena's initial render. Public
 * + IP rate-limited — the on-chain tx signatures are the proof, so the whole
 * point is that anyone can watch.
 *
 * Backward-compatible: every field the arena already reads is still present; the
 * board rows are now a SUPERSET (win_rate, score, verified, roi_pct, drawdown, …).
 *
 * Also returns `real_stats`: an all-time, on-chain-ONLY aggregate over
 * agent_sniper_positions (buy_sig present and not the 'SIMULATED' sentinel). It
 * powers the homepage "real positions · no simulation" scoreboard, which must
 * never count paper fills the engine writes in simulate mode. Shape:
 *   { closed, wins, losses, win_rate, open, best_realized_pct,
 *     best_realized_multiple, best_peak_multiple, realized_pnl_sol }
 * This is deliberately separate from the trader-stats board rows, which include
 * paper fills so an agent's track record stays continuous across practice runs.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getLeaderboard, WINDOWS, LEADERBOARD_SORTS } from '../_lib/trader-stats.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

// kolscan publishes 24h / 7d / 30d windows; the board's "all-time" view has no
// live analogue, so it borrows the widest available window for the fallback.
const KOL_WINDOW = { '24h': '24h', '7d': '7d', '30d': '30d', all: '30d' };

function solscan(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet'
		? `https://solscan.io/tx/${sig}?cluster=devnet`
		: `https://solscan.io/tx/${sig}`;
}

function shortWallet(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// Live top-trader fallback. When no three.ws agent has a provable track record in
// the window yet, the flagship board surfaces the real, public kolscan ranking of
// top Solana traders (realized SOL profit) so it is never an empty void — clearly
// labelled as live market data, every wallet deep-linked to its on-chain account.
// Real data only: a kolscan/parse/price outage degrades to [] and the page shows
// its honest "be the first" empty state. mainnet-only — kolscan has no devnet.
async function liveTraders({ network, window, solUsd, limit }) {
	if (network !== 'mainnet') return [];
	const win = KOL_WINDOW[window] || '7d';
	let items;
	try {
		const { getLeaderboard: getKolLeaderboard } = await import('../../src/kol/leaderboard.js');
		items = await getKolLeaderboard({ window: win, limit });
	} catch {
		return [];
	}
	if (!Array.isArray(items) || !items.length) return [];
	return items.map((r) => {
		const pnlSol = Number.isFinite(r.pnlSol)
			? r.pnlSol
			: solUsd && Number.isFinite(r.pnlUsd) ? r.pnlUsd / solUsd : null;
		return {
			rank: r.rank,
			wallet: r.wallet,
			wallet_short: shortWallet(r.wallet),
			realized_pnl_sol: pnlSol,
			realized_pnl_usd: Number.isFinite(r.pnlUsd) ? r.pnlUsd : null,
			win_rate: Number(r.winRate) || 0,
			trades: Number(r.trades) || 0,
			account_url: `https://solscan.io/account/${r.wallet}`,
		};
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	// Default 'all' preserves the arena's historical lifetime ranking; the flagship
	// /leaderboard page requests an explicit window.
	const window = WINDOWS.has(params.get('window')) ? params.get('window') : 'all';
	const sort = LEADERBOARD_SORTS.has(params.get('sort')) ? params.get('sort') : 'score';
	const verifiedOnly = params.get('verified') === '1' || params.get('verified') === 'true';

	const [boardResult, recent, open, realAgg] = await Promise.all([
		getLeaderboard({ network, window, sort, verifiedOnly, limit: 100 }),
		sql`
			select p.id, p.agent_id, a.name as agent_name, p.mint, p.symbol, p.name,
			       p.entry_quote_lamports, p.exit_quote_lamports, p.realized_pnl_lamports,
			       p.realized_pnl_pct, p.exit_reason, p.buy_sig, p.sell_sig, p.closed_at
			from agent_sniper_positions p
			join agent_identities a on a.id = p.agent_id
			where p.network = ${network} and p.status = 'closed'
			order by p.closed_at desc
			limit 30
		`,
		sql`
			select p.id, p.agent_id, a.name as agent_name, p.mint, p.symbol, p.name,
			       p.entry_quote_lamports, p.last_value_lamports, p.peak_value_lamports,
			       p.buy_sig, p.opened_at
			from agent_sniper_positions p
			join agent_identities a on a.id = p.agent_id
			where p.network = ${network} and p.status = 'open'
			order by p.opened_at desc
			limit 50
		`,
		// Real, on-chain-only aggregate. A position counts here ONLY if it landed a
		// genuine broadcast signature (buy_sig present and not the 'SIMULATED'
		// sentinel simulate-mode writes) — so the homepage "no simulation" scoreboard
		// can never inflate itself with paper fills. All-time, network-scoped.
		sql`
			select
				count(*) filter (where status = 'closed')                              as real_closed,
				count(*) filter (where status = 'closed' and realized_pnl_lamports > 0) as real_wins,
				count(*) filter (where status = 'open')                                as real_open,
				max(realized_pnl_pct) filter (where status = 'closed')                 as best_realized_pct,
				max((peak_value_lamports::numeric) / nullif(entry_quote_lamports, 0))
					filter (where peak_value_lamports is not null and entry_quote_lamports > 0) as best_peak_multiple,
				coalesce(sum(realized_pnl_lamports) filter (where status = 'closed'), 0) as realized_pnl_lamports
			from agent_sniper_positions
			where network = ${network}
			  and buy_sig is not null and buy_sig <> 'SIMULATED'
		`.catch(() => [{}]),
	]);

	// Real-trade scoreboard (on-chain fills only). Powers the homepage KPIs that
	// claim "real positions · no simulation" — kept structurally separate from the
	// trader-stats board (which includes paper fills for track-record continuity).
	const ra = realAgg[0] || {};
	const realClosed = Number(ra.real_closed) || 0;
	const realWins = Number(ra.real_wins) || 0;
	const bestPeak = ra.best_peak_multiple != null ? Number(ra.best_peak_multiple) : null;
	const bestRealizedPct = ra.best_realized_pct != null ? Number(ra.best_realized_pct) : null;
	const real_stats = {
		closed: realClosed,
		wins: realWins,
		losses: Math.max(0, realClosed - realWins),
		win_rate: realClosed > 0 ? Math.round((realWins / realClosed) * 100) : null,
		open: Number(ra.real_open) || 0,
		best_realized_pct: bestRealizedPct,
		best_realized_multiple: bestRealizedPct != null ? Number((1 + bestRealizedPct / 100).toFixed(2)) : null,
		best_peak_multiple: bestPeak != null ? Number(bestPeak.toFixed(2)) : null,
		realized_pnl_sol: ra.realized_pnl_lamports != null
			? Number((Number(BigInt(ra.realized_pnl_lamports)) / 1e9).toFixed(6)) : 0,
	};

	const trades = recent.map((t) => ({
		id: t.id,
		agent_id: t.agent_id,
		agent_name: t.agent_name,
		mint: t.mint,
		symbol: t.symbol,
		name: t.name,
		entry_sol: t.entry_quote_lamports != null ? Number(BigInt(t.entry_quote_lamports)) / 1e9 : null,
		exit_sol: t.exit_quote_lamports != null ? Number(BigInt(t.exit_quote_lamports)) / 1e9 : null,
		pnl_sol: t.realized_pnl_lamports != null ? Number(BigInt(t.realized_pnl_lamports)) / 1e9 : null,
		pnl_pct: t.realized_pnl_pct != null ? Number(t.realized_pnl_pct) : null,
		exit_reason: t.exit_reason,
		buy_url: solscan(t.buy_sig, network),
		sell_url: solscan(t.sell_sig, network),
		at: t.closed_at,
	}));

	const positions = open.map((o) => {
		const entry = o.entry_quote_lamports != null ? Number(BigInt(o.entry_quote_lamports)) : 0;
		const last = o.last_value_lamports != null ? Number(BigInt(o.last_value_lamports)) : entry;
		return {
			id: o.id,
			agent_id: o.agent_id,
			agent_name: o.agent_name,
			mint: o.mint,
			symbol: o.symbol,
			name: o.name,
			entry_sol: entry / 1e9,
			current_sol: last / 1e9,
			unrealized_pct: entry > 0 ? ((last - entry) / entry) * 100 : 0,
			buy_url: solscan(o.buy_sig, network),
			at: o.opened_at,
		};
	});

	// Hybrid board: provable three.ws agent track records are primary. Until any
	// agent has traded in this window, fall back to the live kolscan top-trader
	// ranking so the flagship is real + populated from day one — never an empty
	// void — and naturally hands back to the agent board as records accrue.
	const hasAgents = boardResult.leaderboard.length > 0;
	const live = hasAgents ? [] : await liveTraders({
		network, window, solUsd: boardResult.sol_usd, limit: 100,
	});
	const source = hasAgents ? 'agents' : live.length ? 'live' : 'empty';

	return json(res, 200, {
		network,
		window,
		sort,
		source,
		sol_usd: boardResult.sol_usd,
		leaderboard: boardResult.leaderboard,
		real_stats,
		live_traders: live,
		live_window: source === 'live' ? (KOL_WINDOW[window] || '7d') : null,
		trades,
		positions,
		t: Date.now(),
	}, { 'cache-control': 'public, max-age=10, s-maxage=20' });
});
