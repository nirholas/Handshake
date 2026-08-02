// Ghost-copy: paper-copy any verified leader, replayed over their REAL trades.
// ---------------------------------------------------------------------------
// The bridge between "I'll never let a bot touch my wallet" and actually copying
// one. A visitor picks a leader, a budget and a window, and we replay that
// leader's actual on-chain round-trips (`agent_sniper_positions`) through the
// SAME sizing and guard engine the live copy-fanout cron uses
// (`copy-engine.planCopyOrder`), against a hypothetical wallet. The answer is
// the sentence the whole funnel turns on: "if you'd ghost-copied this agent for
// 7 days with 1 SOL, you'd be +0.34 SOL."
//
// Zero custody, zero signing, no funded signer, no account: it is arithmetic
// over trades that already happened. Because the sizing path is literally the
// production copy-engine, a ghost result is not a marketing number. It is what
// the copy engine WOULD have generated, including every skip.
//
// Honesty rules baked in (a dishonest sim is worse than no sim):
//   - Realized P&L per trade is derived from the exact chain lamports
//     (realized_pnl / entry_quote), never from a stored percentage that could
//     drift. Trades whose entry we cannot price are dropped and counted.
//   - Survivorship-honest: every losing round-trip counts. Nothing is filtered.
//   - The ghost wallet has a real cash constraint. Capital locked in an open
//     copy is unavailable, so a leader who runs 30 concurrent positions cannot
//     be "copied" on 1 SOL without skips, and those skips are reported.
//   - The leader's still-open positions are marked at THEIR last on-chain quote
//     (`last_value_lamports`) and reported as unrealized, separately from the
//     realized headline. Never folded in silently.
//   - Every skipped copy carries a machine reason and a human sentence.
//
// $THREE is the only coin this platform promotes. The coins that appear here are
// whatever the leader actually traded: runtime data, never an endorsement.

import { sql } from './db.js';
import { normalizeSubscriptionInput, planCopyOrder } from './copy-engine.js';
import { WINDOWS, windowStartIso } from './trader-stats.js';

const LAMPORTS = 1e9;
const lamToSol = (l) => (l == null ? 0 : Number(l) / LAMPORTS);
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const round2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export const GHOST_WINDOWS = WINDOWS;
export const MAX_GHOST_TRADES = 500;

// ---------------------------------------------------------------------------
// Sizing defaults. A visitor should only have to type a budget, so every guard
// derives from it unless they override. These mirror the shape of a real
// copy_subscriptions row so the ghost and the live subscription behave the same.
// ---------------------------------------------------------------------------

/**
 * Build a normalized, copy-engine-compatible subscription from a budget plus
 * optional overrides. Returns { ok, value, error } like normalizeSubscriptionInput.
 */
export function buildGhostSubscription({
	budgetSol,
	sizing_rule = 'fixed',
	fixed_sol,
	multiplier,
	per_trade_cap_sol,
	min_order_sol,
	daily_budget_sol,
	max_open_copies,
} = {}) {
	const budget = num(budgetSol);
	if (budget == null || budget <= 0) return { ok: false, error: 'budget must be a positive number of SOL' };

	// Deploy the budget in roughly ten slices, never more than a quarter of it in
	// one trade, and recycle the whole budget at most once per UTC day.
	const draft = {
		sizing_rule: ['fixed', 'multiplier'].includes(sizing_rule) ? sizing_rule : 'fixed',
		fixed_sol: num(fixed_sol) ?? round4(budget / 10),
		multiplier: num(multiplier) ?? 0.1,
		per_trade_cap_sol: num(per_trade_cap_sol) ?? round4(budget / 4),
		min_order_sol: num(min_order_sol) ?? round4(Math.min(budget / 1000, budget / 4)),
		daily_budget_sol: num(daily_budget_sol) ?? budget,
		max_open_copies: num(max_open_copies) ?? 5,
		copy_sells: true,
		require_safety_pass: false,
		perf_fee_bps: 0, // ghosts never accrue a fee; nothing was earned
	};

	const normalized = normalizeSubscriptionInput(draft);
	if (!normalized.ok) return normalized;
	// planCopyOrder gates on status; a ghost is always "active".
	return { ok: true, value: { ...normalized.value, status: 'active' } };
}

// ---------------------------------------------------------------------------
// The simulator. PURE: no DB, no network, no clock. Deterministic over its
// input, which is what tests/ghost-copy.test.js pins.
// ---------------------------------------------------------------------------

/**
 * Replay a leader's positions against a hypothetical wallet.
 *
 * @param {object} p
 * @param {Array}  p.trades        normalized trades (see normalizeLeaderTrades), any order.
 * @param {number} p.budgetSol     the ghost wallet's starting SOL.
 * @param {object} p.subscription  a buildGhostSubscription() value.
 * @param {number} [p.maxCurvePoints] downsample ceiling for the equity curve.
 * @returns {object} fills, skipped, equity_curve, summary, honesty
 */
export function simulateGhostCopy({ trades = [], budgetSol, subscription, maxCurvePoints = 160 }) {
	const sub = { ...subscription, status: 'active' };
	const start = Number(budgetSol);

	let cash = start;
	const open = new Map();           // trade id -> { order_sol, trade }
	const fills = [];
	const skipped = [];
	const spentByDay = new Map();
	const curve = [{ t: null, equity_sol: round4(start) }];

	// Close events free capital, so they must settle before same-instant opens.
	const events = [];
	for (const t of trades) {
		if (!t.opened_at) continue;
		events.push({ ts: t.opened_at, rank: 1, kind: 'open', t });
		if (t.closed_at && t.status === 'closed') events.push({ ts: t.closed_at, rank: 0, kind: 'close', t });
	}
	events.sort((a, b) => (a.ts === b.ts ? a.rank - b.rank : a.ts < b.ts ? -1 : 1));
	// Anchor the curve's origin to the first thing that actually happened, so the
	// chart's x-axis starts where the leader started rather than at a null.
	if (events.length) curve[0].t = events[0].ts;

	const lockedSol = () => {
		let s = 0;
		for (const f of open.values()) s += f.order_sol;
		return s;
	};
	const pushCurve = (ts) => curve.push({ t: ts, equity_sol: round4(cash + lockedSol()) });

	for (const ev of events) {
		const t = ev.t;
		if (ev.kind === 'open') {
			const day = String(ev.ts).slice(0, 10);
			const spentToday = spentByDay.get(day) || 0;

			const plan = planCopyOrder({
				subscription: sub,
				position: { direction: 'buy', entry_sol: t.entry_sol },
				coin: t.coin || null,
				copierBalanceSol: cash,
				spentTodaySol: spentToday,
				openCopies: open.size,
			});

			if (plan.action !== 'copy') {
				skipped.push({
					mint: t.mint, symbol: t.symbol, at: ev.ts,
					reason: plan.reason, detail: plan.detail || null,
					leader_entry_sol: round4(t.entry_sol),
				});
				continue;
			}

			const order = plan.order_sol;
			if (order > cash + 1e-12) {
				skipped.push({
					mint: t.mint, symbol: t.symbol, at: ev.ts,
					reason: 'ghost_cash_locked',
					detail: `Your ghost wallet had ${round4(cash)} SOL free (the rest was locked in open copies); this copy needed ${round4(order)} SOL.`,
					leader_entry_sol: round4(t.entry_sol),
				});
				continue;
			}

			cash -= order;
			spentByDay.set(day, spentToday + order);
			open.set(t.id, { order_sol: order, trade: t, opened_at: ev.ts });
			continue;
		}

		// close
		const held = open.get(t.id);
		if (!held) continue; // the leader closed a trade the ghost never entered
		const proceeds = held.order_sol * (1 + t.pnl_pct / 100);
		cash += proceeds;
		open.delete(t.id);

		fills.push({
			mint: t.mint, symbol: t.symbol, name: t.name,
			order_sol: round4(held.order_sol),
			proceeds_sol: round4(proceeds),
			pnl_sol: round4(proceeds - held.order_sol),
			pnl_pct: round2(t.pnl_pct),
			multiple: round2(1 + t.pnl_pct / 100),
			opened_at: held.opened_at, closed_at: ev.ts,
			hold_seconds: holdSeconds(held.opened_at, ev.ts),
			exit_reason: t.exit_reason || null,
			leader_entry_sol: round4(t.entry_sol),
			buy_sig: t.buy_sig || null, sell_sig: t.sell_sig || null,
		});
		pushCurve(ev.ts);
	}

	// Still-open ghost copies, marked at the LEADER's last on-chain quote.
	const stillOpen = [];
	let unrealized = 0;
	for (const f of open.values()) {
		const markPct = f.trade.mark_pct;
		const value = markPct == null ? f.order_sol : f.order_sol * (1 + markPct / 100);
		unrealized += value - f.order_sol;
		stillOpen.push({
			mint: f.trade.mint, symbol: f.trade.symbol, name: f.trade.name,
			order_sol: round4(f.order_sol),
			opened_at: f.opened_at,
			mark_pct: markPct == null ? null : round2(markPct),
			unrealized_sol: round4(value - f.order_sol),
			marked: markPct == null ? 'cost' : 'leader_last_quote',
		});
	}

	const realizedPnl = cash + lockedSol() - start;
	const wins = fills.filter((f) => f.pnl_sol > 0).length;
	const losses = fills.length - wins;
	const deployed = fills.reduce((s, f) => s + f.order_sol, 0) + lockedSol();
	const best = fills.length ? fills.reduce((a, b) => (b.pnl_pct > a.pnl_pct ? b : a)) : null;
	const worst = fills.length ? fills.reduce((a, b) => (b.pnl_pct < a.pnl_pct ? b : a)) : null;

	return {
		fills,
		skipped,
		still_open: stillOpen,
		equity_curve: downsampleCurve(curve, maxCurvePoints),
		summary: {
			start_sol: round4(start),
			end_sol: round4(cash + lockedSol()),
			realized_pnl_sol: round4(realizedPnl),
			realized_pnl_pct: start > 0 ? round2((realizedPnl / start) * 100) : null,
			unrealized_pnl_sol: round4(unrealized),
			mark_to_market_sol: round4(cash + lockedSol() + unrealized),
			copied: fills.length,
			wins,
			losses,
			win_rate_pct: fills.length ? round2((wins / fills.length) * 100) : null,
			deployed_sol: round4(deployed),
			idle_sol: round4(cash),
			max_drawdown_pct: maxDrawdownPct(curve),
			best: best && { symbol: best.symbol, mint: best.mint, pnl_pct: best.pnl_pct, pnl_sol: best.pnl_sol },
			worst: worst && { symbol: worst.symbol, mint: worst.mint, pnl_pct: worst.pnl_pct, pnl_sol: worst.pnl_sol },
			leader_trades: trades.length,
			skipped_count: skipped.length,
			still_open_count: stillOpen.length,
			avg_hold_seconds: avgHold(fills),
		},
		honesty: honestyNotes({ fills, skipped, stillOpen, trades }),
	};
}

function holdSeconds(a, b) {
	const t0 = Date.parse(a), t1 = Date.parse(b);
	return Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? Math.round((t1 - t0) / 1000) : null;
}

function avgHold(fills) {
	const held = fills.map((f) => f.hold_seconds).filter((s) => s != null);
	return held.length ? Math.round(held.reduce((a, b) => a + b, 0) / held.length) : null;
}

/** Peak-to-trough drop on the ghost equity curve, as a pct of the running peak. */
export function maxDrawdownPct(curve) {
	let peak = -Infinity, worst = 0;
	for (const p of curve) {
		const v = p.equity_sol;
		if (v > peak) peak = v;
		if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100);
	}
	return round2(worst);
}

/** Keep the first and last points exactly; thin the middle evenly. */
export function downsampleCurve(curve, maxPoints) {
	if (curve.length <= maxPoints) return curve;
	const out = [curve[0]];
	const step = (curve.length - 2) / (maxPoints - 2);
	for (let i = 1; i < maxPoints - 1; i++) out.push(curve[Math.round(i * step)]);
	out.push(curve[curve.length - 1]);
	return out;
}

function honestyNotes({ fills, skipped, stillOpen, trades }) {
	const notes = [];
	notes.push('Paper only. No wallet was connected, nothing was signed, and no fee was charged.');
	notes.push('Every trade replayed here is a real on-chain round-trip by this leader, priced from the exact lamports of their entry and exit. Losses are included.');
	if (skipped.length) {
		notes.push(`${skipped.length} of the leader's ${trades.length} trades were NOT copied, because your budget, caps or open-position limit blocked them. The live copy engine would have skipped them too, for the same reasons.`);
	}
	if (stillOpen.length) {
		notes.push(`${stillOpen.length} position${stillOpen.length === 1 ? ' is' : 's are'} still open. Those are marked at the leader's last on-chain quote and reported as unrealized, never in the realized headline.`);
	}
	if (fills.length) {
		notes.push('Real copying adds slippage, priority fees and latency against you: your fills would land after the leader\'s, not at the same price. Treat this as the ceiling of the outcome, not the outcome.');
	}
	notes.push('Past results do not predict future results. This is a track record, not a forecast.');
	return notes;
}

// ---------------------------------------------------------------------------
// Data access.
//
// These queries deliberately do NOT swallow their errors into an empty array. On
// this surface an empty result is a real, meaningful answer ("this leader has no
// settled record yet") that the page renders as a designed empty state. If a
// database outage returned the same empty array, the page would confidently tell
// a visitor a profitable trader has no track record. A failure has to surface as
// a failure, so it reaches the endpoint's error boundary and the page's retry.
// ---------------------------------------------------------------------------

/**
 * Normalize raw agent_sniper_positions rows into simulator input. Rows whose
 * entry we cannot price are dropped (and counted by the caller) rather than
 * guessed at.
 */
export function normalizeLeaderTrades(rows = []) {
	const trades = [];
	let unpriced = 0;
	for (const r of rows) {
		const entrySol = lamToSol(r.entry_quote_lamports);
		if (!(entrySol > 0)) { unpriced++; continue; }

		// Derive the percentage from exact chain lamports; fall back to the stored
		// pct only when the P&L column is absent.
		let pnlPct = null;
		if (r.realized_pnl_lamports != null) pnlPct = (lamToSol(r.realized_pnl_lamports) / entrySol) * 100;
		else if (r.realized_pnl_pct != null) pnlPct = Number(r.realized_pnl_pct);

		const status = r.status === 'closed' ? 'closed' : 'open';
		if (status === 'closed' && pnlPct == null) { unpriced++; continue; }

		const lastValue = r.last_value_lamports == null ? null : lamToSol(r.last_value_lamports);
		trades.push({
			id: String(r.id),
			mint: r.mint,
			symbol: r.symbol || null,
			name: r.name || null,
			status,
			entry_sol: entrySol,
			pnl_pct: pnlPct == null ? 0 : pnlPct,
			mark_pct: status === 'open' && lastValue != null && lastValue > 0 ? ((lastValue - entrySol) / entrySol) * 100 : null,
			opened_at: toIso(r.opened_at),
			closed_at: toIso(r.closed_at),
			exit_reason: r.exit_reason || null,
			buy_sig: r.buy_sig || null,
			sell_sig: r.sell_sig || null,
			coin: null,
		});
	}
	trades.sort((a, b) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : 0));
	return { trades, unpriced };
}

function toIso(v) {
	if (!v) return null;
	if (typeof v === 'string') return v;
	try { return new Date(v).toISOString(); } catch { return null; }
}

/** The leader's identity card for the header. Null when the agent is not public. */
export async function fetchGhostLeader(agentId, network = 'mainnet') {
	const rows = await sql`
		select a.id, a.name, a.avatar_url, a.profile_image_url,
		       count(p.id) filter (where p.status = 'closed')::int as settled,
		       min(p.opened_at) as first_trade_at,
		       max(p.closed_at) as last_close_at
		from agent_identities a
		left join agent_sniper_positions p
		       on p.agent_id = a.id and p.network = ${network}
		where a.id = ${agentId} and a.deleted_at is null and a.is_public <> false
		group by a.id, a.name, a.avatar_url, a.profile_image_url
		limit 1
	`;
	const r = rows[0];
	if (!r) return null;
	return {
		agent_id: r.id,
		name: r.name || 'Unnamed trader',
		avatar: r.avatar_url || r.profile_image_url || null,
		settled: Number(r.settled || 0),
		first_trade_at: toIso(r.first_trade_at),
		last_close_at: toIso(r.last_close_at),
		profile_url: `/trader/${r.id}`,
	};
}

/** The leader's positions inside the window, oldest first. */
export async function fetchLeaderTrades(agentId, network = 'mainnet', sinceIso = null) {
	const rows = sinceIso
		? await sql`
			select id, mint, symbol, name, status, exit_reason,
			       entry_quote_lamports, realized_pnl_lamports, realized_pnl_pct,
			       last_value_lamports, opened_at, closed_at, buy_sig, sell_sig
			from agent_sniper_positions
			where agent_id = ${agentId} and network = ${network}
			  and status in ('open', 'closed') and opened_at >= ${sinceIso}
			order by opened_at asc
			limit ${MAX_GHOST_TRADES}
		`
		: await sql`
			select id, mint, symbol, name, status, exit_reason,
			       entry_quote_lamports, realized_pnl_lamports, realized_pnl_pct,
			       last_value_lamports, opened_at, closed_at, buy_sig, sell_sig
			from agent_sniper_positions
			where agent_id = ${agentId} and network = ${network}
			  and status in ('open', 'closed')
			order by opened_at asc
			limit ${MAX_GHOST_TRADES}
		`;
	return rows;
}

/**
 * Leaders worth ghost-copying: public agents with at least one closed round-trip
 * in the window, ranked by realized P&L. This is the picker's universe.
 */
export async function fetchGhostableLeaders(network = 'mainnet', { window = '7d', limit = 24, now = Date.now() } = {}) {
	const since = windowStartIso(WINDOWS.has(window) ? window : '7d', now);
	const rows = since
		? await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as settled,
			       count(p.id) filter (where p.realized_pnl_lamports > 0)::int as wins,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports,
			       coalesce(sum(p.entry_quote_lamports), 0)::text as entry_lamports,
			       max(p.closed_at) as last_close_at
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed'
			  and p.closed_at is not null and p.closed_at >= ${since}
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			order by sum(p.realized_pnl_lamports) desc nulls last
			limit ${Math.min(100, Math.max(1, limit))}
		`
		: await sql`
			select a.id, a.name, a.avatar_url, a.profile_image_url,
			       count(p.id)::int as settled,
			       count(p.id) filter (where p.realized_pnl_lamports > 0)::int as wins,
			       coalesce(sum(p.realized_pnl_lamports), 0)::text as pnl_lamports,
			       coalesce(sum(p.entry_quote_lamports), 0)::text as entry_lamports,
			       max(p.closed_at) as last_close_at
			from agent_identities a
			join agent_sniper_positions p on p.agent_id = a.id
			where a.deleted_at is null and a.is_public <> false
			  and p.network = ${network} and p.status = 'closed' and p.closed_at is not null
			group by a.id, a.name, a.avatar_url, a.profile_image_url
			order by sum(p.realized_pnl_lamports) desc nulls last
			limit ${Math.min(100, Math.max(1, limit))}
		`;

	return rows.map((r) => {
		const settled = Number(r.settled || 0);
		const wins = Number(r.wins || 0);
		const pnlSol = lamToSol(r.pnl_lamports);
		const entrySol = lamToSol(r.entry_lamports);
		return {
			agent_id: r.id,
			name: r.name || 'Unnamed trader',
			avatar: r.avatar_url || r.profile_image_url || null,
			settled,
			win_rate_pct: settled > 0 ? round2((wins / settled) * 100) : null,
			pnl_sol: round4(pnlSol),
			roi_pct: entrySol > 0 ? round2((pnlSol / entrySol) * 100) : null,
			last_close_at: toIso(r.last_close_at),
			profile_url: `/trader/${r.id}`,
		};
	});
}

/**
 * End-to-end ghost run: fetch, normalize, simulate. Returns null when the leader
 * is unknown or private.
 */
export async function runGhostCopy({ agentId, network = 'mainnet', window = '7d', budgetSol, overrides = {}, now = Date.now() }) {
	const built = buildGhostSubscription({ budgetSol, ...overrides });
	if (!built.ok) return { error: built.error };

	const leader = await fetchGhostLeader(agentId, network);
	if (!leader) return null;

	const win = WINDOWS.has(window) ? window : '7d';
	const since = windowStartIso(win, now);
	const rows = await fetchLeaderTrades(agentId, network, since);
	const { trades, unpriced } = normalizeLeaderTrades(rows);

	const result = simulateGhostCopy({ trades, budgetSol, subscription: built.value });
	if (unpriced > 0) {
		result.honesty.push(`${unpriced} of this leader's positions could not be priced from chain data and were excluded rather than estimated.`);
	}
	if (rows.length >= MAX_GHOST_TRADES) {
		result.honesty.push(`This leader has more than ${MAX_GHOST_TRADES} positions in this window; the replay covers the oldest ${MAX_GHOST_TRADES}.`);
	}

	return {
		leader,
		network,
		window: win,
		window_start: since,
		budget_sol: round4(Number(budgetSol)),
		sizing: built.value,
		...result,
	};
}
