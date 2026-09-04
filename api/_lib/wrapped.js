/**
 * Trader Wrapped: the season recap.
 *
 * A swipeable, shareable recap of one trading agent's window, built entirely from
 * the same provable ledger the leaderboard and the trader profile read
 * (`agent_sniper_positions` + `agent_strategy_positions`, via trader-stats). Every
 * slide traces to closed round-trips with on-chain buy/sell signatures. Nothing
 * here is estimated, projected, or padded.
 *
 * Two layers, matching trader-stats:
 *   - buildWrappedDeck(...)  PURE. No DB, no network. Deterministic over positions
 *     + the metrics trader-stats already computed + a peer-rank context object.
 *   - getWrapped(...)        fetches positions, prices SOL, resolves peer rank and
 *     the nearest rival, then defers every number to the pure layer.
 *
 * Honesty rules, inherited and extended:
 *   - A losing season is rendered as a losing season. There is no slide that only
 *     exists when the numbers are good, and no superlative that flips sign to
 *     flatter. The "worst trade" slide is not optional.
 *   - Percentile rank is computed only against peers with a comparable sample
 *     (MIN_PEER_CLOSED closed trades in the same window and network), and the peer
 *     count is always reported so the rank cannot be read as bigger than it is.
 *   - Self-dealt round-trips are already excluded upstream by computeTraderMetrics.
 *     The superlative slides re-apply the same exclusion so a self-launched coin
 *     can never become someone's "best trade".
 *   - A slide with no evidence is omitted, never filled with a zero.
 *
 * Coins named in a deck are runtime data: whatever the agent actually traded.
 * $THREE remains the only coin this platform promotes.
 */

import { sql } from './db.js';
import { solUsdPrice } from './avatar-wallet.js';
import {
	WINDOWS,
	windowStartIso,
	computeTraderMetrics,
	fetchTraderPositions,
	shapeClosed,
	selfDealMintsForUser,
	mintLaunchTimes,
} from './trader-stats.js';

const LAMPORTS_PER_SOL = 1e9;

/** Windows a deck can be cut over. Mirrors trader-stats so ranks stay comparable. */
export const WRAPPED_WINDOWS = new Set([...WINDOWS]);

/** Windows the UI offers by default. '24h' is accepted but is not a "season". */
export const WRAPPED_WINDOW_CHOICES = ['7d', '30d', 'all'];

/** Closed trades a peer needs before it counts toward the percentile denominator. */
const MIN_PEER_CLOSED = 3;

/** Closed trades this agent needs before a deck is worth cutting at all. */
const MIN_DECK_CLOSED = 3;

/** Exported so the endpoint and the picker's empty state quote the same gate. */
export const WRAPPED_MIN_CLOSED = MIN_DECK_CLOSED;

const num = (v) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);
const round4 = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : null);
const lam = (v) => {
	try { return Number(BigInt(v ?? 0)); } catch { return num(v); }
};
const toIso = (v) => (v ? new Date(v).toISOString() : null);
const utcDay = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

/** "2h 14m", "38s", "3d 4h". Never a bare number of seconds in copy. */
export function humanDuration(seconds) {
	const s = Math.max(0, Math.round(num(seconds)));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`.replace(' 0s', '');
	if (s < 86400) {
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		return m ? `${h}h ${m}m` : `${h}h`;
	}
	const d = Math.floor(s / 86400);
	const h = Math.round((s % 86400) / 3600);
	return h ? `${d}d ${h}h` : `${d}d`;
}

/** Longest run of consecutive wins and of consecutive losses, oldest to newest. */
function streaks(closedOldestFirst) {
	let bestWin = 0, bestLoss = 0, runWin = 0, runLoss = 0;
	let bestWinEnd = null, bestLossEnd = null;
	for (const p of closedOldestFirst) {
		const pnl = lam(p.realized_pnl_lamports);
		if (pnl > 0) {
			runWin += 1; runLoss = 0;
			if (runWin > bestWin) { bestWin = runWin; bestWinEnd = p; }
		} else if (pnl < 0) {
			runLoss += 1; runWin = 0;
			if (runLoss > bestLoss) { bestLoss = runLoss; bestLossEnd = p; }
		} else {
			runWin = 0; runLoss = 0;
		}
	}
	return {
		longest_win_streak: bestWin,
		longest_win_streak_ended_at: toIso(bestWinEnd?.closed_at),
		longest_loss_streak: bestLoss,
		longest_loss_streak_ended_at: toIso(bestLossEnd?.closed_at),
	};
}

/** Per-UTC-day close counts and realized P&L. Drives the busiest and best day. */
function dayBreakdown(closed) {
	const byDay = new Map();
	for (const p of closed) {
		const day = utcDay(p.closed_at || p.opened_at);
		if (!day) continue;
		let d = byDay.get(day);
		if (!d) { d = { day, trades: 0, wins: 0, pnl_lamports: 0 }; byDay.set(day, d); }
		d.trades += 1;
		const pnl = lam(p.realized_pnl_lamports);
		d.pnl_lamports += pnl;
		if (pnl > 0) d.wins += 1;
	}
	const days = [...byDay.values()].map((d) => ({
		day: d.day,
		trades: d.trades,
		wins: d.wins,
		pnl_sol: round4(d.pnl_lamports / LAMPORTS_PER_SOL),
	}));
	days.sort((a, b) => (a.day < b.day ? -1 : 1));
	return days;
}

/** The UTC hour this trader opened the most positions in. Their body clock. */
function peakHour(positions) {
	const hours = new Array(24).fill(0);
	let total = 0;
	for (const p of positions) {
		if (!p.opened_at) continue;
		const h = new Date(p.opened_at).getUTCHours();
		if (!Number.isInteger(h)) continue;
		hours[h] += 1;
		total += 1;
	}
	if (!total) return null;
	let top = 0;
	for (let h = 1; h < 24; h += 1) if (hours[h] > hours[top]) top = h;
	return { hour_utc: top, entries: hours[top], share_pct: round2((hours[top] / total) * 100) };
}

/**
 * Build the recap from data that is already fetched and already credited.
 *
 * @param positions  raw position rows for the window (both ledgers, any status)
 * @param metrics    the output of computeTraderMetrics over the same rows
 * @param ctx        { network, window, agent, solUsd, selfDealMints, peers }
 */
export function buildWrappedDeck(positions, metrics, ctx = {}) {
	const { network = 'mainnet', window = '30d', agent = null, solUsd = null, peers = null } = ctx;
	const selfDealMints = ctx.selfDealMints || null;
	const isSelfDeal = (mint) =>
		!!(mint && selfDealMints && (typeof selfDealMints.has === 'function' ? selfDealMints.has(mint) : selfDealMints[mint]));

	// Superlatives are drawn from the SAME credited set the metrics used, so a coin
	// the trader launched themselves can never surface as their best trade.
	const credited = positions.filter((p) => !isSelfDeal(p.mint));
	const closed = credited.filter((p) => p.status === 'closed');
	const oldestFirst = [...closed].sort(
		(a, b) => new Date(a.closed_at || a.opened_at) - new Date(b.closed_at || b.opened_at),
	);

	const withPct = closed.filter((p) => p.realized_pnl_pct != null && Number.isFinite(Number(p.realized_pnl_pct)));
	const byPctDesc = [...withPct].sort((a, b) => Number(b.realized_pnl_pct) - Number(a.realized_pnl_pct));
	const best = byPctDesc[0] || null;
	const worst = byPctDesc.length > 1 ? byPctDesc[byPctDesc.length - 1] : null;

	const heldSeconds = (p) => {
		const o = new Date(p.opened_at).getTime();
		const c = new Date(p.closed_at || p.opened_at).getTime();
		return Math.max(0, (c - o) / 1000);
	};
	const winners = closed.filter((p) => lam(p.realized_pnl_lamports) > 0);
	const fastestWin = winners.length
		? winners.reduce((a, p) => (heldSeconds(p) < heldSeconds(a) ? p : a))
		: null;
	const longestHold = closed.length
		? closed.reduce((a, p) => (heldSeconds(p) > heldSeconds(a) ? p : a))
		: null;

	const days = dayBreakdown(closed);
	const busiestDay = days.length ? days.reduce((a, d) => (d.trades > a.trades ? d : a)) : null;
	const bestDay = days.length ? days.reduce((a, d) => (num(d.pnl_sol) > num(a.pnl_sol) ? d : a)) : null;
	const worstDay = days.length ? days.reduce((a, d) => (num(d.pnl_sol) < num(a.pnl_sol) ? d : a)) : null;

	const shape = (p) => {
		if (!p) return null;
		const s = shapeClosed(p, network);
		return {
			...s,
			pnl_usd: solUsd != null && s.pnl_sol != null ? round2(s.pnl_sol * solUsd) : null,
			held_seconds: Math.round(heldSeconds(p)),
			held_human: humanDuration(heldSeconds(p)),
			multiple: s.pnl_pct != null ? round2(1 + s.pnl_pct / 100) : null,
		};
	};

	const rhythm = {
		...streaks(oldestFirst),
		active_days: days.length,
		trades_per_active_day: days.length ? round2(closed.length / days.length) : null,
		peak_hour: peakHour(credited),
		busiest_day: busiestDay,
		best_day: bestDay,
		worst_day: worstDay,
		median_hold_human: humanDuration(metrics.median_hold_seconds),
		avg_hold_human: humanDuration(metrics.avg_hold_seconds),
	};

	// Slides are assembled in reading order. Each carries its own `kind` so the
	// client renders it without a per-field null dance, and a slide with no
	// evidence is dropped rather than shown empty.
	const slides = [];

	slides.push({
		kind: 'intro',
		title: agent?.name ? `${agent.name}, wrapped` : 'Your season, wrapped',
		window,
		first_active_at: metrics.first_active_at,
		last_active_at: metrics.last_active_at,
		closed_count: metrics.closed_count,
		unique_coins: metrics.unique_coins,
		active_days: rhythm.active_days,
	});

	slides.push({
		kind: 'scoreboard',
		realized_pnl_sol: metrics.realized_pnl_sol,
		realized_pnl_usd: metrics.realized_pnl_usd,
		roi_pct: metrics.roi_pct,
		invested_sol: metrics.invested_sol,
		win_rate: metrics.win_rate,
		wins: metrics.wins,
		losses: metrics.losses,
		profit_factor: metrics.profit_factor,
		pnl_series: metrics.pnl_series,
		verdict: seasonVerdict(metrics),
	});

	if (best) {
		slides.push({ kind: 'best_trade', trade: shape(best) });
	}
	if (worst && worst !== best) {
		slides.push({ kind: 'worst_trade', trade: shape(worst) });
	}
	if (metrics.top_coin) {
		slides.push({ kind: 'top_coins', top_coin: metrics.top_coin, top_coins: metrics.top_coins });
	}
	if (rhythm.active_days > 0) {
		slides.push({
			kind: 'rhythm',
			...rhythm,
			fastest_win: shape(fastestWin),
			longest_hold: shape(longestHold),
		});
	}
	if (peers && peers.sample >= 2) {
		slides.push({ kind: 'rank', ...peers });
	}
	slides.push({
		kind: 'receipt',
		score: metrics.score,
		verified: metrics.verified,
		confidence: metrics.confidence,
		max_drawdown_pct: metrics.max_drawdown_pct,
		sharpe: metrics.sharpe,
		snipe_hit_rate: metrics.snipe_hit_rate,
		snipe_sample: metrics.snipe_sample,
		self_dealing_count: metrics.self_dealing_count,
		self_dealing_excluded_pnl_sol: metrics.self_dealing_excluded_pnl_sol,
		moonbags_held: metrics.moonbags_held,
	});

	return {
		slides,
		rhythm,
		headline: headlineFor(metrics, best, agent),
	};
}

/**
 * One honest sentence about the season. A losing window says so; the copy never
 * spins a drawdown into a win, because the record is public and checkable.
 */
function seasonVerdict(metrics) {
	const pnl = num(metrics.realized_pnl_sol);
	if (metrics.closed_count === 0) return 'no_trades';
	if (pnl > 0) return 'green';
	if (pnl < 0) return 'red';
	return 'flat';
}

function headlineFor(metrics, best, agent) {
	const who = agent?.name || 'This trader';
	const pnl = num(metrics.realized_pnl_sol);
	const n = metrics.closed_count;
	if (!n) return `${who} closed no round-trips in this window.`;
	const sign = pnl >= 0 ? '+' : '';
	// A season can settle a few thousand lamports up. Rounding that to "+0.00 SOL"
	// reads as a typo, so small totals keep the digits that make them true.
	const mag = Math.abs(pnl);
	const dp = mag === 0 ? 2 : mag < 0.001 ? 6 : mag < 0.01 ? 4 : 2;
	const bestPct = best?.realized_pnl_pct != null ? Number(best.realized_pnl_pct) : null;
	const bestBit = bestPct != null && bestPct > 0
		? ` Best trade: +${Math.round(bestPct)}% on ${best.symbol ? `$${best.symbol}` : 'one coin'}.`
		: '';
	return `${who} closed ${n} round-trip${n === 1 ? '' : 's'} across ${metrics.unique_coins} coin${metrics.unique_coins === 1 ? '' : 's'} for ${sign}${pnl.toFixed(dp)} SOL.${bestBit}`;
}

// --- DB layer ---------------------------------------------------------------

/**
 * Peer rank for one agent inside a window: where their realized P&L lands among
 * every public agent with a comparable sample. Returns null when there are too few
 * peers to make a percentile mean anything.
 *
 * The nearest rival is the agent one place above (or, for the leader, one below),
 * which is what makes a recap worth arguing about.
 */
export async function peerRank({ agentId, network = 'mainnet', window = '30d', now = Date.now() }) {
	const since = windowStartIso(WRAPPED_WINDOWS.has(window) ? window : '30d', now);
	const rows = since
		? await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as closed,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed'
			  and p.closed_at is not null and p.closed_at >= ${since}
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			having count(p.id) >= ${MIN_PEER_CLOSED}
			order by sum(p.realized_pnl_lamports) desc nulls last
		`
		: await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as closed,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed' and p.closed_at is not null
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			having count(p.id) >= ${MIN_PEER_CLOSED}
			order by sum(p.realized_pnl_lamports) desc nulls last
		`;

	const sample = rows.length;
	const idx = rows.findIndex((r) => r.id === agentId);
	if (idx < 0 || sample < 2) return { sample, rank: null, beat_pct: null, rival: null, min_closed: MIN_PEER_CLOSED };

	const rivalRow = idx > 0 ? rows[idx - 1] : rows[1];
	const mine = lam(rows[idx].pnl_lamports) / LAMPORTS_PER_SOL;
	const theirs = rivalRow ? lam(rivalRow.pnl_lamports) / LAMPORTS_PER_SOL : null;

	return {
		sample,
		rank: idx + 1,
		// Share of the comparable field this trader finished ahead of. Reported as
		// a percentage of peers, never as a percentile of "all traders everywhere".
		beat_pct: round2(((sample - (idx + 1)) / (sample - 1)) * 100),
		min_closed: MIN_PEER_CLOSED,
		pnl_sol: round4(mine),
		rival: rivalRow
			? {
				agent_id: rivalRow.id,
				name: rivalRow.name || 'Unnamed trader',
				avatar: rivalRow.avatar_url || rivalRow.profile_image_url || null,
				closed: Number(rivalRow.closed || 0),
				pnl_sol: round4(theirs),
				gap_sol: round4(mine - theirs),
				ahead: idx > 0 ? 'them' : 'you',
				profile_url: `/trader/${rivalRow.id}`,
			}
			: null,
	};
}

/**
 * Public agents with enough settled history in the window to have a deck worth
 * cutting. This is the picker on /wrapped, ranked by activity rather than P&L so a
 * losing-but-busy season is still discoverable.
 */
export async function fetchWrappableTraders(network = 'mainnet', { window = '30d', limit = 24, now = Date.now() } = {}) {
	const since = windowStartIso(WRAPPED_WINDOWS.has(window) ? window : '30d', now);
	const rows = since
		? await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as closed,
			       count(p.id) filter (where p.realized_pnl_lamports > 0)::int as wins,
			       count(distinct p.mint)::int as coins,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports,
			       max(p.closed_at) as last_close_at
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed'
			  and p.closed_at is not null and p.closed_at >= ${since}
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			having count(p.id) >= ${MIN_DECK_CLOSED}
			order by count(p.id) desc, max(p.closed_at) desc
			limit ${Math.min(100, Math.max(1, limit))}
		`
		: await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as closed,
			       count(p.id) filter (where p.realized_pnl_lamports > 0)::int as wins,
			       count(distinct p.mint)::int as coins,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports,
			       max(p.closed_at) as last_close_at
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed' and p.closed_at is not null
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			having count(p.id) >= ${MIN_DECK_CLOSED}
			order by count(p.id) desc, max(p.closed_at) desc
			limit ${Math.min(100, Math.max(1, limit))}
		`;

	return rows.map((r) => {
		const closed = Number(r.closed || 0);
		const wins = Number(r.wins || 0);
		return {
			agent_id: r.id,
			name: r.name || 'Unnamed trader',
			avatar: r.avatar_url || r.profile_image_url || null,
			closed,
			coins: Number(r.coins || 0),
			win_rate_pct: closed > 0 ? round2((wins / closed) * 100) : null,
			pnl_sol: round4(lam(r.pnl_lamports) / LAMPORTS_PER_SOL),
			last_close_at: toIso(r.last_close_at),
			wrapped_url: `/wrapped?agent=${r.id}`,
			profile_url: `/trader/${r.id}`,
		};
	});
}

/** SOL/USD, best-effort. A missing price yields null USD, never a fabricated one. */
async function solUsd() {
	try {
		const p = await solUsdPrice();
		return Number.isFinite(p) && p > 0 ? p : null;
	} catch {
		return null;
	}
}

/**
 * The full deck for one agent. Returns null when the agent is unknown or private,
 * and a deck with `enough_history: false` when they exist but have too little
 * settled history for a recap to say anything true.
 */
export async function getWrapped({ agentId, network = 'mainnet', window = '30d', now = Date.now() }) {
	const win = WRAPPED_WINDOWS.has(window) ? window : '30d';

	const [idRows, positions, usd, peers] = await Promise.all([
		sql`
			select id, user_id, name, description, avatar_url, profile_image_url, is_public
			from agent_identities
			where id = ${agentId} and deleted_at is null
			limit 1
		`,
		fetchTraderPositions({ agentId, network, window: win, now }),
		solUsd(),
		peerRank({ agentId, network, window: win, now }).catch(() => null),
	]);

	const identity = idRows[0];
	if (!identity || identity.is_public === false) return null;

	const agent = {
		id: identity.id,
		name: identity.name || 'Unnamed trader',
		description: identity.description || null,
		image: identity.profile_image_url || identity.avatar_url || null,
		profile_url: `/trader/${identity.id}`,
	};

	const mints = [...new Set(positions.map((p) => p.mint).filter(Boolean))];
	const [selfDealMints, mintCreatedAt] = await Promise.all([
		selfDealMintsForUser(identity.user_id, network).catch(() => null),
		mintLaunchTimes(mints, network).catch(() => null),
	]);

	const metrics = computeTraderMetrics(positions, { solUsd: usd, selfDealMints, mintCreatedAt });

	if (metrics.closed_count < MIN_DECK_CLOSED) {
		return {
			agent,
			network,
			window: win,
			enough_history: false,
			min_closed: MIN_DECK_CLOSED,
			closed_count: metrics.closed_count,
			sol_usd: usd,
			slides: [],
			generated_at: new Date(now).toISOString(),
		};
	}

	const deck = buildWrappedDeck(positions, metrics, {
		network,
		window: win,
		agent,
		solUsd: usd,
		selfDealMints,
		peers,
	});

	return {
		agent,
		network,
		window: win,
		enough_history: true,
		min_closed: MIN_DECK_CLOSED,
		closed_count: metrics.closed_count,
		sol_usd: usd,
		metrics,
		...deck,
		share_url: `/wrapped/${identity.id}/share`,
		generated_at: new Date(now).toISOString(),
	};
}
