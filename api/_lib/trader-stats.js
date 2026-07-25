/**
 * Trader track-record truth layer.
 *
 * The single source of truth for every "how good is this trader" number on
 * three.ws — the leaderboard, the trader profile, the Proof tab, the copy-trading
 * verification badge. Built on `agent_sniper_positions`, which is the canonical
 * per-position ledger: each row already carries realized P&L (lamports + pct),
 * entry/exit SOL, hold window (opened_at → closed_at), and the on-chain buy/sell
 * signatures that PROVE every number. We never invent a metric we can't trace to
 * a tx.
 *
 * Two layers, by design:
 *   - computeTraderMetrics(positions, opts)  — PURE. No DB, no network. Deterministic
 *     over an array of position rows. This is what the tests pin to fixtures, and
 *     what guarantees the leaderboard and the profile can never disagree.
 *   - getTraderStats / getLeaderboard        — fetch rows, price SOL→USD, attach
 *     identity, then defer all arithmetic to computeTraderMetrics.
 *
 * Honesty rules baked in:
 *   - SOL amounts are exact (from chain). USD is an enrichment that degrades to
 *     null if the price feed is down — we never fabricate a dollar figure.
 *   - `churn_pct` is an explicit heuristic (near-flat in-and-out churn) and is
 *     named as such.
 *   - Survivorship-honest: closed losers are counted, never hidden.
 *   - Anti-gaming, when the caller supplies the evidence: realized P&L from
 *     round-trips on the trader's OWN coins (`selfDealMints`) is NOT credited to
 *     the verifiable record — you cannot pump a token you launched and call it a
 *     track record. The excluded total is reported transparently, never silently
 *     dropped. Snipe hit-rate (`mintCreatedAt`) is the win rate on entries made
 *     within minutes of a coin's on-chain birth — the hardest, most-faked flex,
 *     here computed only over launches whose creation slot we can actually prove.
 */

import { sql } from './db.js';
import { solUsdPrice } from './avatar-wallet.js';
import { actionsSummary } from './oracle/store.js';

const LAMPORTS_PER_SOL = 1e9;

/** Supported leaderboard / profile time windows. */
export const WINDOWS = new Set(['24h', '7d', '30d', 'all']);
const WINDOW_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };

/** ISO lower-bound for a window, or null for 'all'. `now` injectable for tests. */
export function windowStartIso(window, now = Date.now()) {
	const span = WINDOW_MS[window];
	return span ? new Date(now - span).toISOString() : null;
}

// --- Score / badge tuning. Transparent, named, tunable. -----------------------
// A trader's composite score (0–100) is a documented weighted blend of win rate,
// profit factor, signed realized P&L, consistency (Sharpe-ish), drawdown, and
// churn — regressed toward neutral until they have enough closed trades to trust.
const SCORE_WEIGHTS = { winRate: 0.30, profitFactor: 0.22, pnl: 0.26, consistency: 0.12, drawdown: 0.10 };
const CHURN_SCORE_PENALTY = 0.10; // churn subtracts up to this much from raw score
const CONFIDENCE_FULL_AT = 14;    // closed trades for full statistical confidence
const NEUTRAL_RAW = 0.42;         // unproven traders regress toward this (slightly below mid)
const PNL_TANH_SOL = 5;           // ~5 SOL realized ≈ a strongly positive pnl sub-score
const SHARPE_TANH = 2;            // consistency normalization

// Verification badge ("proven track record") gate — every condition must hold.
const BADGE = { minClosed: 12, minUniqueCoins: 5, maxChurnPct: 40 };

// Churn heuristic: a position opened and closed inside this window with a
// near-flat result is in-and-out churn that pads trade counts without real risk.
const CHURN_HOLD_SECONDS = 25;
const CHURN_FLAT_PCT = 1.5;

// Snipe window: an entry is a "snipe" when it lands within this long after the
// coin's on-chain birth. 5 minutes is generous enough to survive the gap between
// our DB open timestamp and the chain's block time, tight enough to mean "early".
const SNIPE_WINDOW_MS = 5 * 60_000;
// Grace for clock skew between our recorded open time and the launch block time —
// a buy can never truly precede the mint, so a few seconds of negative drift is noise.
const SNIPE_SKEW_GRACE_MS = 3_000;

const big = (v) => {
	try { return Number(BigInt(v)); } catch { return Number(v) || 0; }
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const tanh = (x) => Math.tanh(x);

function median(sorted) {
	if (!sorted.length) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values, mean) {
	if (values.length < 2) return 0;
	const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

/**
 * Max drawdown over the realized equity curve (cumulative realized P&L in
 * lamports, ordered oldest→newest close). Returns both the absolute SOL drop from
 * a running peak and that drop as a pct of the peak equity. A monotonically
 * rising book has zero drawdown.
 */
function maxDrawdown(closedOrderedLamports) {
	let equity = 0, peak = 0, maxDropLamports = 0, maxDropPct = 0;
	for (const pnl of closedOrderedLamports) {
		equity += pnl;
		if (equity > peak) peak = equity;
		const drop = peak - equity;
		if (drop > maxDropLamports) {
			maxDropLamports = drop;
			maxDropPct = peak > 0 ? (drop / peak) * 100 : 0;
		}
	}
	return { sol: maxDropLamports / LAMPORTS_PER_SOL, pct: maxDropPct };
}

/**
 * Compact cumulative-realized-equity series (SOL) for a sparkline. Takes the
 * per-close realized P&L in lamports, oldest→newest, and returns the running
 * equity in SOL downsampled to at most `maxPoints` points — small enough to ship
 * on every one of the ~100 leaderboard rows without bloating the payload, yet
 * enough to read the shape of the run. The last point is always the final
 * realized equity so the sparkline's endpoint matches the row's headline P&L.
 * Fewer than two closes returns [] (the caller renders a flat "no trend yet"
 * placeholder rather than a misleading single dot).
 */
function cumulativeEquitySeries(pnlsLamports, maxPoints = 24) {
	if (!Array.isArray(pnlsLamports) || pnlsLamports.length < 2) return [];
	const equity = [];
	let running = 0;
	for (const p of pnlsLamports) {
		running += p;
		equity.push(running / LAMPORTS_PER_SOL);
	}
	if (equity.length <= maxPoints) return equity.map((v) => Number(v.toFixed(4)));
	// Even stride, but force-include the final point so the endpoint is exact.
	const out = [];
	const stride = (equity.length - 1) / (maxPoints - 1);
	for (let i = 0; i < maxPoints - 1; i++) out.push(equity[Math.round(i * stride)]);
	out.push(equity[equity.length - 1]);
	return out.map((v) => Number(v.toFixed(4)));
}

/**
 * Compute the full metric set for one trader from their position rows.
 *
 * @param {Array<object>} positions  agent_sniper_positions rows (closed + open).
 *   Required fields per row: status, realized_pnl_lamports, realized_pnl_pct,
 *   entry_quote_lamports, exit_quote_lamports, last_value_lamports, mint,
 *   opened_at, closed_at.
 * @param {object} [opts]
 * @param {number|null} [opts.solUsd]  USD per SOL, or null to omit USD fields.
 * @param {Set<string>|Record<string,true>|null} [opts.selfDealMints]  Mints the
 *   trader's own account launched/created. Positions on these are split out of the
 *   credited record (anti-gaming) and reported under `self_dealing_*`. Omit/null
 *   to credit every position (legacy behaviour).
 * @param {Map<string,number|string>|Record<string,number|string>|null} [opts.mintCreatedAt]
 *   Mint → on-chain creation time (ms epoch or ISO). Drives snipe hit-rate. Only
 *   mints present here count toward the snipe sample — unknown launches are not
 *   guessed at.
 * @returns {object} canonical metrics — see fields below.
 */
export function computeTraderMetrics(positions, { solUsd = null, selfDealMints = null, mintCreatedAt = null } = {}) {
	const isSelfDeal = (mint) =>
		!!(mint && selfDealMints && (typeof selfDealMints.has === 'function' ? selfDealMints.has(mint) : selfDealMints[mint]));
	const launchOf = (mint) => {
		if (!mint || !mintCreatedAt) return null;
		const v = typeof mintCreatedAt.get === 'function' ? mintCreatedAt.get(mint) : mintCreatedAt[mint];
		if (v == null) return null;
		const t = typeof v === 'number' ? v : Date.parse(v);
		return Number.isFinite(t) ? t : null;
	};

	// Anti-gaming: round-trips on the trader's OWN coins are split out before any
	// credited metric is computed. They are counted and reported, never hidden, but
	// they cannot inflate the verifiable record.
	const selfDealPositions = positions.filter((p) => isSelfDeal(p.mint));
	const credited = selfDealPositions.length ? positions.filter((p) => !isSelfDeal(p.mint)) : positions;

	const closed = credited.filter((p) => p.status === 'closed');
	const open = credited.filter((p) => p.status === 'open' || p.status === 'opening' || p.status === 'closing');

	// --- Realized (closed positions) ---
	let realizedLamports = 0n;
	let grossProfit = 0n, grossLoss = 0n; // grossLoss kept positive
	let wins = 0, losses = 0;
	let invested = 0n;
	const pnlPcts = [];
	const winPcts = [], lossPcts = [];
	const holdSeconds = [];
	const coins = new Set();
	// Per-coin realized P&L aggregation — the "what they made it on" breakdown. A
	// trader can round-trip the same mint several times, so we sum lamports per mint
	// and pick the winner(s) after the loop. Provable: every lamport traces to a
	// closed position's realized_pnl_lamports.
	const coinAgg = new Map(); // mint -> { pnl, invested, trades, wins, symbol, name }
	let churn = 0;
	let bestPct = null, worstPct = null;
	let firstActive = null, lastActive = null;
	// Snipe hit-rate: only positions whose mint has a proven on-chain birth count
	// toward the sample, so the number is honest about its own coverage.
	let snipeSample = 0, snipeCount = 0, snipeWins = 0;

	// Oldest→newest by close time for the equity curve.
	const closedOrdered = [...closed].sort(
		(a, b) => new Date(a.closed_at || a.opened_at).getTime() - new Date(b.closed_at || b.opened_at).getTime(),
	);
	const equityPnls = [];

	for (const p of closedOrdered) {
		const pnl = BigInt(p.realized_pnl_lamports ?? 0);
		realizedLamports += pnl;
		equityPnls.push(big(p.realized_pnl_lamports));
		if (pnl > 0n) { wins += 1; grossProfit += pnl; } else if (pnl < 0n) { losses += 1; grossLoss += -pnl; }
		invested += BigInt(p.entry_quote_lamports ?? 0);
		if (p.mint) {
			coins.add(p.mint);
			let ca = coinAgg.get(p.mint);
			if (!ca) { ca = { pnl: 0n, invested: 0n, trades: 0, wins: 0, symbol: p.symbol || null, name: p.name || null }; coinAgg.set(p.mint, ca); }
			ca.pnl += pnl;
			ca.invested += BigInt(p.entry_quote_lamports ?? 0);
			ca.trades += 1;
			if (pnl > 0n) ca.wins += 1;
			if (!ca.symbol && p.symbol) ca.symbol = p.symbol;
			if (!ca.name && p.name) ca.name = p.name;
		}

		const pct = p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null;
		if (pct != null && Number.isFinite(pct)) {
			pnlPcts.push(pct);
			if (pct > 0) winPcts.push(pct); else if (pct < 0) lossPcts.push(pct);
			bestPct = bestPct == null ? pct : Math.max(bestPct, pct);
			worstPct = worstPct == null ? pct : Math.min(worstPct, pct);
		}

		const opened = new Date(p.opened_at).getTime();
		const closedAt = new Date(p.closed_at || p.opened_at).getTime();
		const held = Math.max(0, (closedAt - opened) / 1000);
		holdSeconds.push(held);
		if (held <= CHURN_HOLD_SECONDS && pct != null && Math.abs(pct) <= CHURN_FLAT_PCT) churn += 1;

		const launchMs = launchOf(p.mint);
		if (launchMs != null) {
			snipeSample += 1;
			const sinceLaunch = opened - launchMs;
			if (sinceLaunch >= -SNIPE_SKEW_GRACE_MS && sinceLaunch <= SNIPE_WINDOW_MS) {
				snipeCount += 1;
				if (pnl > 0n) snipeWins += 1;
			}
		}

		if (firstActive == null || opened < firstActive) firstActive = opened;
		if (lastActive == null || closedAt > lastActive) lastActive = closedAt;
	}

	// --- Unrealized (open positions) ---
	let openExposure = 0n;
	let unrealizedLamports = 0n;
	for (const p of open) {
		const entry = BigInt(p.entry_quote_lamports ?? 0);
		const last = p.last_value_lamports != null ? BigInt(p.last_value_lamports) : entry;
		openExposure += entry;
		unrealizedLamports += last - entry;
		const opened = new Date(p.opened_at).getTime();
		if (firstActive == null || opened < firstActive) firstActive = opened;
		if (lastActive == null || opened > lastActive) lastActive = opened;
	}

	const closedCount = closed.length;
	const realizedSol = big(realizedLamports.toString()) / LAMPORTS_PER_SOL;
	const investedSol = big(invested.toString()) / LAMPORTS_PER_SOL;
	const unrealizedSol = big(unrealizedLamports.toString()) / LAMPORTS_PER_SOL;
	const openExposureSol = big(openExposure.toString()) / LAMPORTS_PER_SOL;

	const winRate = closedCount ? wins / closedCount : 0;
	const profitFactor = grossLoss > 0n
		? big(grossProfit.toString()) / big(grossLoss.toString())
		: (grossProfit > 0n ? Infinity : 0);
	const roiPct = investedSol > 0 ? (realizedSol / investedSol) * 100 : 0;
	const avgPnlPct = pnlPcts.length ? pnlPcts.reduce((a, v) => a + v, 0) / pnlPcts.length : 0;
	const avgWinPct = winPcts.length ? winPcts.reduce((a, v) => a + v, 0) / winPcts.length : 0;
	const avgLossPct = lossPcts.length ? lossPcts.reduce((a, v) => a + v, 0) / lossPcts.length : 0;
	const holdSorted = [...holdSeconds].sort((a, b) => a - b);
	const avgHoldSeconds = holdSeconds.length ? holdSeconds.reduce((a, v) => a + v, 0) / holdSeconds.length : 0;
	const sharpe = pnlPcts.length > 1 ? avgPnlPct / (stddev(pnlPcts, avgPnlPct) || 1) : 0;
	const churnPct = closedCount ? (churn / closedCount) * 100 : 0;
	const drawdown = maxDrawdown(equityPnls);

	// --- Composite score (0–100), transparent + confidence-regressed ---
	const pfComponent = profitFactor === Infinity ? 1 : profitFactor / (profitFactor + 1);
	const pnlComponent = 0.5 + 0.5 * tanh(realizedSol / PNL_TANH_SOL);
	const consistencyComponent = 0.5 + 0.5 * tanh(sharpe / SHARPE_TANH);
	const drawdownComponent = 1 - clamp(drawdown.pct / 100, 0, 1);
	let raw =
		SCORE_WEIGHTS.winRate * winRate +
		SCORE_WEIGHTS.profitFactor * pfComponent +
		SCORE_WEIGHTS.pnl * pnlComponent +
		SCORE_WEIGHTS.consistency * consistencyComponent +
		SCORE_WEIGHTS.drawdown * drawdownComponent;
	raw = clamp(raw - CHURN_SCORE_PENALTY * clamp(churnPct / 100, 0, 1), 0, 1);
	const confidence = clamp(closedCount / CONFIDENCE_FULL_AT, 0, 1);
	const effective = raw * confidence + NEUTRAL_RAW * (1 - confidence);
	const score = Math.round(100 * effective);

	const verified =
		closedCount >= BADGE.minClosed &&
		realizedSol > 0 &&
		coins.size >= BADGE.minUniqueCoins &&
		churnPct <= BADGE.maxChurnPct;

	const usd = (sol) => (solUsd != null ? sol * solUsd : null);

	// --- "What they made it on" — per-coin realized P&L, best first ---
	// Ranked by realized SOL contribution. The trades a coin cost them count too
	// (survivorship-honest), so a coin can rank with a negative total; the surfaces
	// only badge `top_coin` as a signature win when it is net-positive.
	const coinPnl = [...coinAgg.entries()]
		.map(([mint, c]) => {
			const pnlSol = big(c.pnl.toString()) / LAMPORTS_PER_SOL;
			const investedSol = big(c.invested.toString()) / LAMPORTS_PER_SOL;
			return {
				mint,
				symbol: c.symbol,
				name: c.name,
				pnl_sol: Number(pnlSol.toFixed(6)),
				pnl_usd: usd(pnlSol) != null ? Number(usd(pnlSol).toFixed(2)) : null,
				roi_pct: investedSol > 0 ? Number(((pnlSol / investedSol) * 100).toFixed(2)) : null,
				trades: c.trades,
				wins: c.wins,
			};
		})
		.sort((a, b) => b.pnl_sol - a.pnl_sol);
	const topCoin = coinPnl.length ? coinPnl[0] : null;

	// Self-dealing summary (transparent, never folded into the credited numbers).
	let selfDealClosed = 0;
	let selfDealPnlLamports = 0n;
	for (const p of selfDealPositions) {
		if (p.status === 'closed') {
			selfDealClosed += 1;
			selfDealPnlLamports += BigInt(p.realized_pnl_lamports ?? 0);
		}
	}
	const selfDealPnlSol = big(selfDealPnlLamports.toString()) / LAMPORTS_PER_SOL;
	const snipeHitRate = snipeCount ? snipeWins / snipeCount : null;

	return {
		score,
		verified,
		confidence: Number(confidence.toFixed(3)),

		closed_count: closedCount,
		open_count: open.length,
		wins,
		losses,
		win_rate: Number(winRate.toFixed(4)),

		realized_pnl_lamports: realizedLamports.toString(),
		realized_pnl_sol: Number(realizedSol.toFixed(6)),
		realized_pnl_usd: usd(realizedSol) != null ? Number(usd(realizedSol).toFixed(2)) : null,
		unrealized_pnl_sol: Number(unrealizedSol.toFixed(6)),
		unrealized_pnl_usd: usd(unrealizedSol) != null ? Number(usd(unrealizedSol).toFixed(2)) : null,

		invested_sol: Number(investedSol.toFixed(6)),
		roi_pct: Number(roiPct.toFixed(2)),
		open_exposure_sol: Number(openExposureSol.toFixed(6)),
		open_exposure_usd: usd(openExposureSol) != null ? Number(usd(openExposureSol).toFixed(2)) : null,

		profit_factor: profitFactor === Infinity ? null : Number(profitFactor.toFixed(3)),
		avg_pnl_pct: Number(avgPnlPct.toFixed(2)),
		avg_win_pct: Number(avgWinPct.toFixed(2)),
		avg_loss_pct: Number(avgLossPct.toFixed(2)),
		best_pnl_pct: bestPct != null ? Number(bestPct.toFixed(2)) : null,
		worst_pnl_pct: worstPct != null ? Number(worstPct.toFixed(2)) : null,
		sharpe: Number(sharpe.toFixed(3)),

		max_drawdown_sol: Number(drawdown.sol.toFixed(6)),
		max_drawdown_pct: Number(drawdown.pct.toFixed(2)),

		// Compact cumulative-realized-equity curve (SOL, oldest→newest, ≤24 pts) so
		// the leaderboard row and profile can draw a P&L sparkline without a second
		// query. Endpoint equals realized_pnl_sol; [] when < 2 closed trades.
		pnl_series: cumulativeEquitySeries(equityPnls),

		avg_hold_seconds: Math.round(avgHoldSeconds),
		median_hold_seconds: Math.round(median(holdSorted)),
		unique_coins: coins.size,
		churn_pct: Number(churnPct.toFixed(2)),

		// Moon-bag policy in numbers: closed rows where the initials came out but
		// tokens still ride. "Closed" here means the stake is recovered, not that
		// the trader sold 100% — these two fields are what makes that legible.
		moonbags_held: closed.filter((p) => Number(p.moonbag_base_amount || 0) > 0).length,
		moonbag_value_sol: Number((closed.reduce(
			(a, p) => a + (Number(p.moonbag_base_amount || 0) > 0 ? big(p.moonbag_last_value_lamports || 0) : 0), 0,
		) / LAMPORTS_PER_SOL).toFixed(6)),

		// What they made it on — the single top-earning coin plus a short breakdown,
		// each number traceable to the closed positions above. `top_coin` is null
		// only when the trader has no closed positions with a mint in this window.
		top_coin: topCoin,
		top_coins: coinPnl.slice(0, 3),

		// Snipe hit-rate — win rate on entries inside SNIPE_WINDOW_MS of a coin's
		// proven on-chain birth. null until at least one such launch is in the
		// sample; `snipe_sample` exposes the coverage so the rate is never overclaimed.
		snipe_count: snipeCount,
		snipe_wins: snipeWins,
		snipe_sample: snipeSample,
		snipe_hit_rate: snipeHitRate != null ? Number(snipeHitRate.toFixed(4)) : null,

		// Anti-gaming: round-trips on the trader's OWN coins, excluded from every
		// credited metric above and surfaced here so the exclusion is auditable.
		self_dealing_count: selfDealClosed,
		self_dealing_excluded_pnl_sol: Number(selfDealPnlSol.toFixed(6)),
		self_dealing_excluded_pnl_usd: usd(selfDealPnlSol) != null ? Number(usd(selfDealPnlSol).toFixed(2)) : null,

		first_active_at: firstActive ? new Date(firstActive).toISOString() : null,
		last_active_at: lastActive ? new Date(lastActive).toISOString() : null,
	};
}

// --- DB layer ---------------------------------------------------------------
//
// NOTE: the Neon HTTP driver's tagged template does not compose nested `sql`
// fragments (a `${sql`…`}` would bind as a parameter), so the position column
// list is written literally into each query below. It is static SQL with no user
// input — duplication here is the safe, correct trade-off.

// A trader's verifiable round-trip record is NOT confined to the sniper arena.
// Strategy Objects (`agent_strategy_positions`) close real, on-chain, sell-signed
// positions with the same realized-P&L shape — an agent that earns its track
// record by running strategies is exactly as proven as one that snipes. Both
// surfaces feed this single truth layer, so the leaderboard, profiles, copy-trade
// badge, and the Back-an-Agent vault gate all credit the same real history.
//
// agent_strategy_positions uses different column names (entry_lamports, exit_sig,
// …) and is a newer table, so each query aliases its rows into the canonical
// position shape and the fetch degrades to [] if the table isn't migrated —
// matching every other optional-source read below. It has no per-trade wallet
// column (custody is at the agent level), so wallet is null for strategy-origin
// rows; that only affects the display wallet, never a metric.

/** Strategy-Objects round-trips for one agent, canonical-shaped. Best-effort. */
async function fetchStrategyPositions({ agentId, network, start }) {
	try {
		return start
			? await sql`
				select s.id, s.agent_id, null::text as wallet, s.mint, s.symbol, s.name, s.status, s.exit_reason,
				       s.entry_lamports as entry_quote_lamports, s.exit_lamports as exit_quote_lamports,
				       s.last_value_lamports, s.peak_value_lamports,
				       s.realized_pnl_lamports, s.realized_pnl_pct,
				       s.entry_sig as buy_sig, s.exit_sig as sell_sig,
				       s.opened_at, s.closed_at
				from agent_strategy_positions s
				where s.agent_id = ${agentId} and s.network = ${network}
				  and (s.status in ('open','closing') or s.closed_at >= ${start})
			`
			: await sql`
				select s.id, s.agent_id, null::text as wallet, s.mint, s.symbol, s.name, s.status, s.exit_reason,
				       s.entry_lamports as entry_quote_lamports, s.exit_lamports as exit_quote_lamports,
				       s.last_value_lamports, s.peak_value_lamports,
				       s.realized_pnl_lamports, s.realized_pnl_pct,
				       s.entry_sig as buy_sig, s.exit_sig as sell_sig,
				       s.opened_at, s.closed_at
				from agent_strategy_positions s
				where s.agent_id = ${agentId} and s.network = ${network}
			`;
	} catch {
		return []; // table not migrated yet → sniper record stands alone
	}
}

/**
 * Fetch a trader's positions for a window. Closed positions are window-bounded by
 * close time; open positions are ALWAYS included (current exposure is "now",
 * regardless of window). Unifies the sniper arena and Strategy Objects ledgers so
 * the whole reputation surface counts every real round-trip.
 */
export async function fetchTraderPositions({ agentId, network, window = 'all', now = Date.now() }) {
	const start = windowStartIso(window, now);
	const [sniper, strategy] = await Promise.all([
		start
			? sql`
				select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.name, p.status, p.exit_reason,
				       p.entry_quote_lamports, p.exit_quote_lamports, p.last_value_lamports, p.peak_value_lamports,
				       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
				       p.opened_at, p.closed_at,
				       p.moonbag_base_amount, p.moonbag_last_value_lamports, p.initials_recovered
				from agent_sniper_positions p
				where p.agent_id = ${agentId} and p.network = ${network}
				  and (p.status in ('open','opening','closing') or p.closed_at >= ${start})
				order by coalesce(p.closed_at, p.opened_at) desc
			`
			: sql`
				select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.name, p.status, p.exit_reason,
				       p.entry_quote_lamports, p.exit_quote_lamports, p.last_value_lamports, p.peak_value_lamports,
				       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
				       p.opened_at, p.closed_at,
				       p.moonbag_base_amount, p.moonbag_last_value_lamports, p.initials_recovered
				from agent_sniper_positions p
				where p.agent_id = ${agentId} and p.network = ${network}
				order by coalesce(p.closed_at, p.opened_at) desc
			`,
		fetchStrategyPositions({ agentId, network, start }),
	]);
	if (!strategy.length) return sniper;
	// Merge both real ledgers, newest activity first — computeTraderMetrics re-sorts
	// the closed subset for its equity curve, so this ordering is only for callers
	// that render the raw list (profile history, open positions).
	return [...sniper, ...strategy].sort(
		(a, b) =>
			new Date(b.closed_at || b.opened_at).getTime() - new Date(a.closed_at || a.opened_at).getTime(),
	);
}

/** SOL/USD with a short module cache so a burst of stat requests prices once. */
let _solCache = { usd: null, at: 0 };
async function cachedSolUsd() {
	const now = Date.now();
	if (_solCache.usd != null && now - _solCache.at < 60_000) return _solCache.usd;
	try {
		const usd = await solUsdPrice();
		_solCache = { usd, at: now };
		return usd;
	} catch {
		// Degrade to last known price if we have one, else null (SOL stays exact).
		return _solCache.usd;
	}
}

function solscanUrl(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

/**
 * Active copiers per leader on a network → Map(agentId → count). Best-effort: if
 * the copy_subscriptions table isn't migrated yet, degrade to an empty map rather
 * than failing the whole leaderboard.
 */
async function activeCopierCounts(network) {
	try {
		const rows = await sql`
			select leader_agent_id, count(*)::int as copiers
			from copy_subscriptions
			where network = ${network} and status = 'active'
			group by leader_agent_id
		`;
		return new Map(rows.map((r) => [r.leader_agent_id, Number(r.copiers) || 0]));
	} catch {
		return new Map();
	}
}

/** Active copier count for one leader. Best-effort (see activeCopierCounts). */
async function copierCountForAgent(agentId, network) {
	try {
		const [row] = await sql`
			select count(*)::int as copiers from copy_subscriptions
			where leader_agent_id = ${agentId} and network = ${network} and status = 'active'
		`;
		return Number(row?.copiers) || 0;
	} catch {
		return 0;
	}
}

/** Shape a closed position for the profile history + Proof tab (every number → tx). */
export function shapeClosed(p, network) {
	// A closed row with a moon-bag is NOT a 100% sell: the initials came out and
	// the remaining tokens still ride (owner policy: sell the buy-in at 2x, hold
	// the rest even to zero). Surface that or the track record misreads as
	// full exits.
	const moonbagTokens = p.moonbag_base_amount != null ? Number(p.moonbag_base_amount) : 0;
	return {
		id: p.id,
		mint: p.mint,
		symbol: p.symbol,
		name: p.name,
		entry_sol: p.entry_quote_lamports != null ? big(p.entry_quote_lamports) / LAMPORTS_PER_SOL : null,
		exit_sol: p.exit_quote_lamports != null ? big(p.exit_quote_lamports) / LAMPORTS_PER_SOL : null,
		pnl_sol: p.realized_pnl_lamports != null ? big(p.realized_pnl_lamports) / LAMPORTS_PER_SOL : null,
		pnl_pct: p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null,
		exit_reason: p.exit_reason,
		opened_at: p.opened_at,
		closed_at: p.closed_at,
		buy_url: solscanUrl(p.buy_sig, network),
		sell_url: solscanUrl(p.sell_sig, network),
		moonbag_held: moonbagTokens > 0,
		moonbag_value_sol: moonbagTokens > 0 && p.moonbag_last_value_lamports != null
			? big(p.moonbag_last_value_lamports) / LAMPORTS_PER_SOL
			: null,
	};
}

/** Shape an open position with live unrealized P&L. */
export function shapeOpen(p, network) {
	const entry = p.entry_quote_lamports != null ? big(p.entry_quote_lamports) : 0;
	const last = p.last_value_lamports != null ? big(p.last_value_lamports) : entry;
	return {
		id: p.id,
		mint: p.mint,
		symbol: p.symbol,
		name: p.name,
		entry_sol: entry / LAMPORTS_PER_SOL,
		current_sol: last / LAMPORTS_PER_SOL,
		unrealized_pct: entry > 0 ? ((last - entry) / entry) * 100 : 0,
		opened_at: p.opened_at,
		buy_url: solscanUrl(p.buy_sig, network),
	};
}

/**
 * Mints the trader's own account launched/created — trading these is self-dealing,
 * not skill, so the truth layer excludes their P&L. Sourced from real launch
 * records: pump_agent_mints (coins launched through the platform by this user) plus
 * the user's agent-identity token mints. Best-effort: degrades to an empty set if a
 * table is absent, which simply credits every position (legacy behaviour).
 */
export async function selfDealMintsForUser(userId, network) {
	const set = new Set();
	if (!userId) return set;
	try {
		const rows = await sql`
			select mint from pump_agent_mints where user_id = ${userId} and network = ${network}
			union
			select meta->'token'->>'mint' as mint from agent_identities
			where user_id = ${userId} and meta->'token'->>'mint' is not null
		`;
		for (const r of rows) if (r.mint) set.add(r.mint);
	} catch { /* launch tables not migrated → no exclusions */ }
	return set;
}

/**
 * On-chain birth time for a set of mints, from the radar's `create` precursors
 * (observed_ts = the block time of the create instruction — provable on-chain).
 * Returns Map(mint → ms-epoch). Best-effort: an unmigrated radar table or a launch
 * we never observed just yields no snipe sample for that mint — we never guess.
 */
export async function mintLaunchTimes(mints, network) {
	const map = new Map();
	const list = [...new Set((mints || []).filter(Boolean))];
	if (!list.length) return map;
	try {
		const rows = await sql`
			select mint, min(observed_ts) as created_at
			from radar_events
			where network = ${network} and kind = 'create' and observed_ts is not null
			  and mint = any(${list}::text[])
			group by mint
		`;
		for (const r of rows) if (r.mint && r.created_at) map.set(r.mint, new Date(r.created_at).getTime());
	} catch { /* radar table not migrated → no snipe sample */ }
	return map;
}

/** Self-deal mint sets for many users at once (leaderboard). Map(userId → Set(mint)). */
async function selfDealMintsByUsers(userIds, network) {
	const byUser = new Map();
	const ids = [...new Set((userIds || []).filter(Boolean))];
	if (!ids.length) return byUser;
	try {
		const rows = await sql`
			select user_id, mint from pump_agent_mints
			where network = ${network} and user_id = any(${ids}::uuid[])
			union
			select user_id, meta->'token'->>'mint' as mint from agent_identities
			where user_id = any(${ids}::uuid[]) and meta->'token'->>'mint' is not null
		`;
		for (const r of rows) {
			if (!r.mint) continue;
			let s = byUser.get(r.user_id);
			if (!s) { s = new Set(); byUser.set(r.user_id, s); }
			s.add(r.mint);
		}
	} catch { /* launch tables not migrated → no exclusions */ }
	return byUser;
}

/** Tag a shaped closed-trade row with its self-deal / snipe provenance for the Proof tab. */
function annotateProvenance(row, position, { selfDealMints, mintCreatedAt }) {
	row.self_dealing = !!(selfDealMints && selfDealMints.has(position.mint));
	const launch = mintCreatedAt ? mintCreatedAt.get(position.mint) : null;
	if (launch != null) {
		const dt = new Date(position.opened_at).getTime() - launch;
		row.launch_at = new Date(launch).toISOString();
		row.seconds_after_launch = Math.round(dt / 1000);
		row.snipe = dt >= -SNIPE_SKEW_GRACE_MS && dt <= SNIPE_WINDOW_MS;
	}
	return row;
}

/**
 * Full trader profile: identity + metrics for the window + closed history (proof)
 * + open positions. Returns null if the agent has no positions on this network.
 */
export async function getTraderStats({ agentId, network, window = 'all', now = Date.now() }) {
	const [idRows, positions, solUsd, copiers, oracleSummary, projection] = await Promise.all([
		sql`
			select id, user_id, name, description, avatar_url, profile_image_url, is_public
			from agent_identities where id = ${agentId} limit 1
		`,
		fetchTraderPositions({ agentId, network, window, now }),
		cachedSolUsd(),
		copierCountForAgent(agentId, network),
		actionsSummary(agentId, network).catch(() => null),
		latestProjection(agentId, network).catch(() => null),
	]);
	const identity = idRows[0];
	if (!identity) return null;

	// Real anti-gaming evidence: which of this trader's coins are self-launched, and
	// the proven on-chain birth time of every coin they touched (for snipe hit-rate).
	const mints = [...new Set(positions.map((p) => p.mint).filter(Boolean))];
	const [selfDealMints, mintCreatedAt] = await Promise.all([
		selfDealMintsForUser(identity.user_id, network),
		mintLaunchTimes(mints, network),
	]);

	const metrics = computeTraderMetrics(positions, { solUsd, selfDealMints, mintCreatedAt });
	const closed = positions
		.filter((p) => p.status === 'closed')
		.map((p) => annotateProvenance(shapeClosed(p, network), p, { selfDealMints, mintCreatedAt }));
	const open = positions
		.filter((p) => p.status === 'open' || p.status === 'opening' || p.status === 'closing')
		.map((p) => shapeOpen(p, network));
	const wallet = positions[0]?.wallet || null;

	return {
		agent: {
			id: identity.id,
			name: identity.name,
			description: identity.description || null,
			image: identity.profile_image_url || identity.avatar_url || null,
			is_public: identity.is_public !== false,
			wallet,
			copiers,
		},
		network,
		window,
		sol_usd: solUsd,
		metrics,
		closed,
		open,
		oracle: oracleSummary && oracleSummary.total > 0 ? oracleSummary : null,
		projection: projection ? buildProjectionComparison(projection, metrics) : null,
	};
}

/**
 * Latest backtest snapshot linked to this agent — the projection the owner armed
 * against. Read-only; returns null when the table is absent or no snapshot exists.
 */
async function latestProjection(agentId, network) {
	const [row] = await sql`
		select metrics, sample_size, window_days, ran_at
		from strategy_backtests
		where agent_id = ${agentId} and network = ${network}
		order by ran_at desc limit 1
	`;
	return row || null;
}

/**
 * Pair the armed projection against what actually happened, so the projection is
 * accountable — not marketing. Realized numbers come straight from
 * computeTraderMetrics (chain-proven); projected numbers from the stored backtest.
 */
function buildProjectionComparison(snap, metrics) {
	const m = snap.metrics || {};
	const bt = m.metrics || {};
	const projWinRate = typeof bt.win_rate === 'number' ? bt.win_rate : null;
	const projEv = typeof bt.expected_value_pct === 'number' ? bt.expected_value_pct : null;
	const projDrawdown = typeof bt.max_drawdown_pct === 'number' ? bt.max_drawdown_pct : null;
	return {
		ran_at: snap.ran_at,
		window_days: snap.window_days,
		sample_size: snap.sample_size,
		confidence: m.caveats?.confidence || null,
		insufficient_data: !!m.insufficient_data,
		projected: {
			win_rate: projWinRate,
			expected_value_pct: projEv,
			roi_median_pct: typeof bt.roi_median_pct === 'number' ? bt.roi_median_pct : null,
			max_drawdown_pct: projDrawdown,
		},
		realized: {
			win_rate: metrics.win_rate,
			avg_pnl_pct: metrics.avg_pnl_pct,
			roi_pct: metrics.roi_pct,
			max_drawdown_pct: metrics.max_drawdown_pct,
			closed_count: metrics.closed_count,
		},
	};
}

/**
 * Public, canonical-shaped Strategy-Objects positions across a network, for the
 * leaderboard. Mirrors the sniper leaderboard query (joined to agent_identities,
 * public agents only) so strategy traders rank alongside snipers. Best-effort: an
 * unmigrated table yields no extra rows rather than failing the whole board.
 */
async function fetchStrategyLeaderboardRows({ network, start }) {
	try {
		return start
			? await sql`
				select s.id, s.agent_id, null::text as wallet, s.mint, s.symbol, s.name, s.status, s.exit_reason,
				       s.entry_lamports as entry_quote_lamports, s.exit_lamports as exit_quote_lamports,
				       s.last_value_lamports, s.peak_value_lamports,
				       s.realized_pnl_lamports, s.realized_pnl_pct,
				       s.entry_sig as buy_sig, s.exit_sig as sell_sig,
				       s.opened_at, s.closed_at,
				       a.user_id as agent_user_id, a.name as agent_name, a.avatar_url as agent_avatar, a.profile_image_url as agent_image
				from agent_strategy_positions s
				join agent_identities a on a.id = s.agent_id
				where s.network = ${network} and a.is_public is not false
				  and (s.status in ('open','closing') or s.closed_at >= ${start})
			`
			: await sql`
				select s.id, s.agent_id, null::text as wallet, s.mint, s.symbol, s.name, s.status, s.exit_reason,
				       s.entry_lamports as entry_quote_lamports, s.exit_lamports as exit_quote_lamports,
				       s.last_value_lamports, s.peak_value_lamports,
				       s.realized_pnl_lamports, s.realized_pnl_pct,
				       s.entry_sig as buy_sig, s.exit_sig as sell_sig,
				       s.opened_at, s.closed_at,
				       a.user_id as agent_user_id, a.name as agent_name, a.avatar_url as agent_avatar, a.profile_image_url as agent_image
				from agent_strategy_positions s
				join agent_identities a on a.id = s.agent_id
				where s.network = ${network} and a.is_public is not false
			`;
	} catch {
		return [];
	}
}

/**
 * Leaderboard: every agent with real trading activity in the window, ranked by
 * composite score. Pulls in-window positions from both the sniper arena and
 * Strategy Objects, groups by agent, and runs each group through the SAME pure
 * `computeTraderMetrics` the profile uses, so the two surfaces can never disagree.
 * Scale note: the trader set is curated — if it ever grows past a few hundred
 * active traders per window, move the grouping into SQL with a windowed aggregate.
 */
export const LEADERBOARD_SORTS = new Set(['score', 'pnl', 'winrate', 'roi']);

const SORT_COMPARATORS = {
	score: (a, b) => b.score - a.score || b.realized_pnl_sol - a.realized_pnl_sol,
	pnl: (a, b) => b.realized_pnl_sol - a.realized_pnl_sol || b.score - a.score,
	winrate: (a, b) => b.win_rate - a.win_rate || b.closed - a.closed,
	roi: (a, b) => b.roi_pct - a.roi_pct || b.realized_pnl_sol - a.realized_pnl_sol,
};

export async function getLeaderboard({
	network, window = '30d', limit = 100, sort = 'score', verifiedOnly = false, now = Date.now(),
}) {
	const start = windowStartIso(window, now);
	const [rows, strategyRows] = await Promise.all([
		start
			? sql`
				select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.name, p.status, p.exit_reason,
				       p.entry_quote_lamports, p.exit_quote_lamports, p.last_value_lamports, p.peak_value_lamports,
				       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
				       p.opened_at, p.closed_at,
				       p.moonbag_base_amount, p.moonbag_last_value_lamports, p.initials_recovered,
				       a.user_id as agent_user_id, a.name as agent_name, a.avatar_url as agent_avatar, a.profile_image_url as agent_image
				from agent_sniper_positions p
				join agent_identities a on a.id = p.agent_id
				where p.network = ${network} and a.is_public is not false
				  and (p.status in ('open','opening','closing') or p.closed_at >= ${start})
			`
			: sql`
				select p.id, p.agent_id, p.wallet, p.mint, p.symbol, p.name, p.status, p.exit_reason,
				       p.entry_quote_lamports, p.exit_quote_lamports, p.last_value_lamports, p.peak_value_lamports,
				       p.realized_pnl_lamports, p.realized_pnl_pct, p.buy_sig, p.sell_sig,
				       p.opened_at, p.closed_at,
				       p.moonbag_base_amount, p.moonbag_last_value_lamports, p.initials_recovered,
				       a.user_id as agent_user_id, a.name as agent_name, a.avatar_url as agent_avatar, a.profile_image_url as agent_image
				from agent_sniper_positions p
				join agent_identities a on a.id = p.agent_id
				where p.network = ${network} and a.is_public is not false
			`,
		fetchStrategyLeaderboardRows({ network, start }),
	]);
	const allRows = strategyRows.length ? [...rows, ...strategyRows] : rows;
	const solUsd = await cachedSolUsd();
	const copiers = await activeCopierCounts(network);

	const byAgent = new Map();
	for (const r of allRows) {
		let g = byAgent.get(r.agent_id);
		if (!g) {
			g = {
				agent_id: r.agent_id,
				user_id: r.agent_user_id,
				agent_name: r.agent_name,
				image: r.agent_image || r.agent_avatar || null,
				wallet: r.wallet,
				positions: [],
			};
			byAgent.set(r.agent_id, g);
		}
		g.positions.push(r);
	}

	// One batch each for the whole board: self-deal mints per user, launch times per
	// mint. The same anti-gaming evidence the profile uses, so the two never disagree.
	const allMints = [...new Set(allRows.map((r) => r.mint).filter(Boolean))];
	const [selfDealByUser, mintCreatedAt] = await Promise.all([
		selfDealMintsByUsers([...byAgent.values()].map((g) => g.user_id), network),
		mintLaunchTimes(allMints, network),
	]);
	const EMPTY = new Set();

	const board = [...byAgent.values()]
		.map((g) => {
			const m = computeTraderMetrics(g.positions, {
				solUsd,
				selfDealMints: selfDealByUser.get(g.user_id) || EMPTY,
				mintCreatedAt,
			});
			return {
				agent_id: g.agent_id,
				agent_name: g.agent_name,
				image: g.image,
				wallet: g.wallet,
				score: m.score,
				verified: m.verified,
				closed: m.closed_count,
				open_positions: m.open_count,
				wins: m.wins,
				losses: m.losses,
				win_rate: m.win_rate,
				realized_pnl_lamports: m.realized_pnl_lamports,
				realized_pnl_sol: m.realized_pnl_sol,
				realized_pnl_usd: m.realized_pnl_usd,
				roi_pct: m.roi_pct,
				profit_factor: m.profit_factor,
				avg_pnl_pct: m.avg_pnl_pct,
				best_pnl_pct: m.best_pnl_pct,
				max_drawdown_pct: m.max_drawdown_pct,
				pnl_series: m.pnl_series,
				avg_hold_seconds: m.avg_hold_seconds,
				unique_coins: m.unique_coins,
				churn_pct: m.churn_pct,
				top_coin: m.top_coin,
				snipe_hit_rate: m.snipe_hit_rate,
				snipe_count: m.snipe_count,
				self_dealing_count: m.self_dealing_count,
				last_active_at: m.last_active_at,
				copiers: copiers.get(g.agent_id) || 0,
			};
		})
		.filter((r) => (verifiedOnly ? r.verified : true))
		.sort(SORT_COMPARATORS[sort] || SORT_COMPARATORS.score)
		.slice(0, limit)
		.map((r, i) => ({ rank: i + 1, ...r }));

	return { network, window, sort, sol_usd: solUsd, leaderboard: board, t: now };
}
