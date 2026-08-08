// @ts-check
/**
 * Agent Sniper — fleet solvency.
 *
 * The failure this module exists to make visible: between 2026-07-29 and
 * 2026-08-08 the sniper fleet booked over a thousand consecutive failed entries
 * and closed zero trades, while `/api/sniper/status` reported `state: "live"`
 * the entire time. Everything the status endpoint measured was true — the
 * process was up, the feed was connected, strategies were armed — and none of
 * it was the thing that mattered. The wallets were too poor to place a single
 * buy, and the funding master they refill from was itself down to dust, so the
 * auto-funder could not fix it either.
 *
 * Liveness is not solvency. A trading worker has two ways to be dead and the
 * loud one (process down, feed silent) was already covered. This covers the
 * quiet one: financially unable to trade, indistinguishable from healthy to
 * every check that only looks at the process.
 *
 * The rule that keeps this honest: a wallet's trade state is decided by
 * `resolveEntrySize` — the SAME function the executor calls to size or skip a
 * real entry (api/_lib/agent-trade-guards.js, used at workers/agent-sniper/
 * executor.js step 4). Duplicating its thresholds here is how this surface
 * would drift into claiming "tradeable" for a wallet the executor skips, which
 * is the exact class of bug it was written to catch. Ask the decider, don't
 * re-derive the decision.
 *
 * Pure over its inputs: no DB, no RPC. The worker's auto-funder already reads
 * every armed wallet's balance on its 5-minute tick and feeds the result here,
 * so the public status path stays DB-only and pays no RPC hop.
 */

import { resolveEntrySize } from './agent-trade-guards.js';
import { fundTargetSol } from './agent-funding-policy.js';

/** Smallest entry worth placing, matching the worker's SNIPER_MIN_TRADE_LAMPORTS default. */
export const DEFAULT_MIN_TRADE_LAMPORTS = 10_000n;

/**
 * A master wallet at exactly the deficit can't actually cover it: the transfers
 * themselves cost fees, and `fundAgentForLaunch` enforces its own balance buffer
 * underneath. This is the margin above the raw deficit at which we are willing
 * to say "the master can fix this on its own".
 */
export const MASTER_COVER_BUFFER_SOL = 0.01;

function toLamports(sol) {
	const n = Number(sol);
	if (!Number.isFinite(n) || n <= 0) return 0n;
	return BigInt(Math.round(n * 1e9));
}

/**
 * What one wallet can do with its next entry, per the executor's own sizing rule.
 *
 *   'funded'  — can place the arm's configured size
 *   'shrunk'  — can still trade, but only below the configured size (the
 *               executor shrinks rather than skips: learning > profit)
 *   'starved' — cannot place any entry; the executor sits this wallet out
 *
 * @param {number} balanceSol current wallet balance
 * @param {number} perTradeSol the arm's configured per-trade size
 * @param {bigint} [minTradeLamports] smallest size worth placing
 * @returns {'funded'|'shrunk'|'starved'}
 */
export function walletTradeState(balanceSol, perTradeSol, minTradeLamports = DEFAULT_MIN_TRADE_LAMPORTS) {
	const wallet = toLamports(balanceSol);
	const want = toLamports(perTradeSol);
	// An arm with no configured size can't be sized against; treat the wallet as
	// starved only if it couldn't even cover the minimum trade.
	const target = want > 0n ? want : BigInt(minTradeLamports);
	const sized = resolveEntrySize(wallet, target, minTradeLamports);
	if (sized.skip) return 'starved';
	return sized.sizeLamports < target ? 'shrunk' : 'funded';
}

/**
 * Roll per-wallet balances up into one fleet verdict.
 *
 * `state` is the headline, and it is deliberately about capability rather than
 * count: a fleet where every wallet is starved is `starved` no matter how many
 * strategies are armed, because the honest answer to "is the sniper working" is
 * no. One tradeable wallet among starved ones is `degraded` — it still trades,
 * just not at fleet strength.
 *
 *   'unknown'  — nothing measured yet (no armed wallets, or balances unread)
 *   'funded'   — every wallet can place its configured size
 *   'degraded' — at least one wallet can still trade, at least one cannot
 *   'starved'  — no wallet can place any entry; the fleet is financially dead
 *
 * `deficitSol` is what it would cost to lift every starved wallet back to its
 * own refill target — i.e. the number to hand an operator who asks "how much
 * SOL does this need?". `masterCanCover` answers whether the auto-funder can
 * close that gap by itself, which is the difference between "it will heal in
 * five minutes" and "a human has to move money".
 *
 * @param {object} p
 * @param {Array<{agentId?: string, address?: string, balanceSol?: number|null, perTradeSol?: number}>} p.wallets
 * @param {number|null} [p.masterSol] funding master balance, null when unread/unconfigured
 * @param {bigint} [p.minTradeLamports]
 * @returns {{
 *   state: 'unknown'|'funded'|'degraded'|'starved',
 *   agents: number, funded: number, shrunk: number, starved: number,
 *   tradeable: number, deficitSol: number,
 *   masterSol: number|null, masterCanCover: boolean|null,
 *   wallets: Array<{agentId: string|null, address: string|null, balanceSol: number, state: string}>,
 * }}
 */
export function summarizeFleetSolvency({ wallets, masterSol = null, minTradeLamports = DEFAULT_MIN_TRADE_LAMPORTS } = {}) {
	const measured = [];
	for (const w of wallets || []) {
		// A balance we failed to read is not a balance of zero. Excluding it keeps
		// an RPC blip from reporting a healthy fleet as starved and paging someone.
		if (w?.balanceSol == null || !Number.isFinite(Number(w.balanceSol))) continue;
		const balanceSol = Number(w.balanceSol);
		const perTradeSol = Number(w.perTradeSol) || 0;
		measured.push({
			agentId: w.agentId ?? null,
			address: w.address ?? null,
			balanceSol,
			perTradeSol,
			state: walletTradeState(balanceSol, perTradeSol, minTradeLamports),
		});
	}

	const counts = { funded: 0, shrunk: 0, starved: 0 };
	let deficitSol = 0;
	for (const w of measured) {
		counts[w.state] += 1;
		if (w.state === 'starved') {
			deficitSol += Math.max(0, fundTargetSol({ perTradeSol: w.perTradeSol }) - w.balanceSol);
		}
	}

	const agents = measured.length;
	const tradeable = counts.funded + counts.shrunk;
	const state = agents === 0
		? 'unknown'
		: tradeable === 0
			? 'starved'
			: counts.starved > 0 || counts.shrunk > 0
				? 'degraded'
				: 'funded';

	deficitSol = Math.round(deficitSol * 1e9) / 1e9;
	const master = masterSol == null || !Number.isFinite(Number(masterSol)) ? null : Number(masterSol);

	return {
		state,
		agents,
		funded: counts.funded,
		shrunk: counts.shrunk,
		starved: counts.starved,
		tradeable,
		deficitSol,
		masterSol: master,
		masterCanCover: master == null ? null : master >= deficitSol + MASTER_COVER_BUFFER_SOL,
		wallets: measured.map(({ agentId, address, balanceSol, state: s }) => ({
			agentId, address, balanceSol, state: s,
		})),
	};
}

/**
 * The worker's overall state, combining process liveness with fleet solvency.
 *
 * Precedence is the point of this function. A dead process outranks everything
 * (nothing else can be true). Solvency outranks the feed checks: "no wallet can
 * pay for a trade" is both more specific and more actionable than "the feed is
 * quiet", and it is the condition that went unreported for ten days. An
 * unmeasured fleet ('unknown') never downgrades anything — absence of a
 * measurement is not evidence of insolvency.
 *
 * Pure. Exported so the verdict is testable without a DB or a live worker.
 *
 * @param {object} p
 * @param {boolean} p.alive       heartbeat within the freshness window
 * @param {boolean} p.feedLive    worker reports its feed subscription up
 * @param {boolean} p.feedSilent  no feed events past the watchdog window
 * @param {string}  [p.solvencyState] from summarizeFleetSolvency().state
 * @returns {'down'|'starved'|'degraded'|'live'}
 */
export function deriveSniperState({ alive, feedLive, feedSilent, solvencyState = 'unknown' }) {
	if (!alive) return 'down';
	if (solvencyState === 'starved') return 'starved';
	if (feedSilent || !feedLive || solvencyState === 'degraded') return 'degraded';
	return 'live';
}

/**
 * One-line operator summary of a solvency snapshot. Shared by the worker's alert
 * body and the status page so both describe the same condition the same way.
 *
 * @param {ReturnType<typeof summarizeFleetSolvency>} s
 * @returns {string}
 */
export function describeSolvency(s) {
	if (!s || s.state === 'unknown') return 'No armed wallet balances measured yet.';
	if (s.state === 'funded') return `All ${s.agents} armed wallets can place their configured size.`;
	const head = s.state === 'starved'
		? `No armed wallet can place an entry (${s.starved}/${s.agents} starved).`
		: `${s.tradeable}/${s.agents} armed wallets can still trade (${s.starved} starved, ${s.shrunk} shrunk).`;
	if (s.deficitSol <= 0) return head;
	const fix = s.masterCanCover === true
		? `The funding master holds ${s.masterSol?.toFixed(4)} SOL and will refill them automatically.`
		: s.masterCanCover === false
			? `The funding master holds only ${s.masterSol?.toFixed(4)} SOL, so it CANNOT refill them: a human must move SOL in.`
			: 'The funding master balance is unknown.';
	return `${head} Refilling them needs ${s.deficitSol.toFixed(4)} SOL. ${fix}`;
}
