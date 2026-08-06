// Agora demand + labor-market policy — the REAL rules that decide when a citizen
// posts a bounty, who may claim it, when a worker hires a sub-agent, and how a
// reconcile sweep maps on-chain task state back onto the board.
//
// Every decision here is pure and deterministic: given the same citizen, clock,
// balance, and config it returns the same plan. No money moves in this file — the
// engine takes these plans and executes them on-chain. That separation is what
// makes the economics unit-testable without a wallet or an RPC.
//
// Honest scarcity is enforced HERE, in code: a patron with a real on-chain
// balance below the reward + fee headroom does NOT post. There is no infinite
// tap — when a citizen runs out of funds it stops creating demand.
//
// Pure module — no SDK / DB / network imports.

// Bit math lives in roster.js (the engine's profession registry) so there's one
// source of truth for the capability bitmap. These thin aliases keep this
// module's vocabulary ("capability subset", "bit for a profession") readable.
import { professionBits, capabilitiesSatisfy } from './roster.js';

const capabilityBitsFor = (keys) => professionBits(keys);
const satisfiesCapabilities = (worker, required) => capabilitiesSatisfy(worker, required);
const bitFor = (key) => professionBits([key]);

// ── Task types (AgenC IDL discriminants) → social structures ──────────────────
// Exclusive     — one worker (the founding labour market).
// Competitive   — the Arena: N workers race; the FIRST valid proof wins the whole
//                 escrow, everyone else gets nothing. Tiebreak = on-chain
//                 acceptance order (whichever completeTask lands first).
// Collaborative — a Guild: N workers each contribute a real sub-result and the
//                 reward SPLITS across the contributors per the program's rules.
export const TASK_TYPES = { EXCLUSIVE: 'Exclusive', COMPETITIVE: 'Competitive', COLLABORATIVE: 'Collaborative' };

/** Normalize a free-form / lower-case task type to its canonical AgenC name. */
export function normalizeTaskType(t) {
	const s = String(t || '').trim().toLowerCase();
	if (s === 'competitive') return TASK_TYPES.COMPETITIVE;
	if (s === 'collaborative') return TASK_TYPES.COLLABORATIVE;
	return TASK_TYPES.EXCLUSIVE;
}

/** A multi-worker task (Arena or Guild): several citizens engage the same PDA. */
export function isMultiWorkerType(t) {
	const n = normalizeTaskType(t);
	return n === TASK_TYPES.COMPETITIVE || n === TASK_TYPES.COLLABORATIVE;
}

export function isArenaType(t) { return normalizeTaskType(t) === TASK_TYPES.COMPETITIVE; }
export function isGuildType(t) { return normalizeTaskType(t) === TASK_TYPES.COLLABORATIVE; }

// ── Reputation ladder ─────────────────────────────────────────────────────────
// A visible career ladder: high-value work gates on reputation a new citizen
// hasn't earned yet, so newcomers must grind low-value jobs to climb. Tiers are
// documented here and surfaced in the worker README. minReputation is the
// on-chain gate written into each posted task.
//
// The gates are a DELTA above AgenC's registration baseline, not absolute
// numbers. AgenC starts every registered agent at REPUTATION_BASELINE and adds
// REPUTATION_PER_COMPLETION per accepted proof, so an absolute ladder of 0/5/20
// gates nothing at all: a citizen that has never worked a day already clears it
// by two orders of magnitude. Deltas make the ladder real, because a fresh
// citizen sits exactly at the baseline and has to complete real work to climb.
// Measured on devnet 2026-08-06: a freshly registered agent reads reputation
// 5000, and each completed task adds 100.
//
//   apprentice  baseline + 0    entry work, anyone (incl. brand-new citizens)
//   journeyman  baseline + 200  needs a short track record (2 completions)
//   master      baseline + 500  proven citizens only (5 completions)
export const REPUTATION_BASELINE = Number(process.env.AGORA_REPUTATION_BASELINE) || 5000;
export const REPUTATION_PER_COMPLETION = 100;

export const REPUTATION_LADDER = [
	{ tier: 'apprentice', minReputationDelta: 0 },
	{ tier: 'journeyman', minReputationDelta: 200 },
	{ tier: 'master', minReputationDelta: 500 },
].map((t) => ({ ...t, minReputation: REPUTATION_BASELINE + t.minReputationDelta }));

const LADDER_BY_TIER = new Map(REPUTATION_LADDER.map((t) => [t.tier, t]));

/** minReputation gate for a named tier (0 for an unknown tier — fail open, never lock the board). */
export function minReputationForTier(tier) {
	return LADDER_BY_TIER.get(String(tier || '').toLowerCase())?.minReputation ?? 0;
}

/**
 * Can this citizen claim this task? Two real gates, both on-chain facts:
 *   1. capability subset — the worker advertises every required bit.
 *   2. reputation — the worker's on-chain reputation clears the task's gate.
 * The engine additionally excludes a citizen's own postings and already-worked
 * tasks; this function answers only "is this citizen qualified."
 */
export function citizenCanClaim(citizen, task) {
	if (!citizen || !task) return false;
	if (!satisfiesCapabilities(citizen.capabilityBits, task.requiredCapabilities ?? 0)) return false;
	const rep = Number(citizen.reputation || 0);
	const gate = Number(task.minReputation || 0);
	return rep >= gate;
}

/**
 * Reason a citizen is NOT eligible — used for honest activity/heartbeat notes so
 * the world can narrate "Cole skipped the master bounty (needs rep 20, has 2)".
 * Returns null when the citizen IS eligible.
 */
export function ineligibilityReason(citizen, task) {
	if (!satisfiesCapabilities(citizen.capabilityBits, task.requiredCapabilities ?? 0)) {
		return 'missing_capability';
	}
	const rep = Number(citizen.reputation || 0);
	const gate = Number(task.minReputation || 0);
	if (rep < gate) return 'below_min_reputation';
	return null;
}

/**
 * Choose the next tier a patron posts, rotating through its configured tier
 * schedule by post count so the board shows a healthy spread (mostly apprentice
 * work, occasional journeyman/master rungs). `tiers` is the patron's authored
 * schedule of { profession, rewardAtomic, minReputation, taskType?, maxWorkers? }.
 */
export function pickTier(tiers, postedCount) {
	if (!Array.isArray(tiers) || tiers.length === 0) return null;
	const idx = ((Number(postedCount) || 0) % tiers.length + tiers.length) % tiers.length;
	return tiers[idx];
}

/**
 * Decide whether a patron citizen posts a bounty this tick.
 *
 * @param {object} args
 * @param {object} args.citizen           the would-be poster (needs .patron config)
 * @param {number} args.now               epoch ms
 * @param {number} args.lastPostAt        epoch ms of the citizen's last post (0 if never)
 * @param {bigint} args.balanceAtomic     the poster's REAL spendable balance (lamports on
 *                                         devnet, $THREE base units on mainnet)
 * @param {bigint} args.headroomAtomic    reserve kept for fees / rent (never spent on rewards)
 * @param {number} args.postedCount       how many bounties this patron has posted (tier rotation)
 * @returns {{post:boolean, reason:string, plan?:object}}
 */
export function decidePatronPost({ citizen, now, lastPostAt = 0, balanceAtomic, headroomAtomic = 0n, postedCount = 0 }) {
	const patron = citizen?.patron;
	if (!patron || !Array.isArray(patron.tiers) || patron.tiers.length === 0) {
		return { post: false, reason: 'not_patron' };
	}
	const interval = Number(patron.minPostIntervalMs) || 0;
	if (lastPostAt && now - lastPostAt < interval) {
		return { post: false, reason: 'interval_guard' };
	}

	const tier = pickTier(patron.tiers, postedCount);
	if (!tier) return { post: false, reason: 'no_tier' };

	const reward = toBig(tier.rewardAtomic);
	const need = reward + toBig(headroomAtomic);
	const bal = toBig(balanceAtomic);
	// Honest scarcity — no infinite tap. A patron that can't cover the reward
	// plus fee headroom simply stops creating demand until it earns/refills.
	if (bal < need) {
		return { post: false, reason: 'insufficient_funds' };
	}

	return {
		post: true,
		reason: 'patron_demand',
		plan: {
			profession: tier.profession,
			requiredCapabilities: capabilityBitsFor([tier.profession]),
			rewardAtomic: reward,
			minReputation: tier.minReputation ?? minReputationForTier(tier.tier),
			tier: tier.tier || null,
			taskType: tier.taskType || 'Exclusive',
			maxWorkers: tier.maxWorkers || 1,
		},
	};
}

/**
 * Decide whether a citizen mid-WORK hires a sub-agent for a capability it lacks
 * (true agent-to-agent hiring). The worker pays a sub-reward out of its own real
 * balance — same scarcity rule as a patron.
 *
 * @param {object} args
 * @param {string} args.neededProfession  the profession key the worker can't do itself
 * @param {bigint} args.balanceAtomic     the worker's spendable balance
 * @param {bigint} args.subRewardAtomic   reward offered for the sub-task
 * @param {bigint} args.headroomAtomic    fee/rent reserve
 * @returns {{hire:boolean, reason:string, plan?:object}}
 */
export function decideHire({ neededProfession, balanceAtomic, subRewardAtomic, headroomAtomic = 0n }) {
	const requiredCapabilities = bitFor(neededProfession);
	if (requiredCapabilities === 0n) return { hire: false, reason: 'unknown_profession' };
	const reward = toBig(subRewardAtomic);
	const need = reward + toBig(headroomAtomic);
	if (toBig(balanceAtomic) < need) return { hire: false, reason: 'insufficient_funds' };
	return {
		hire: true,
		reason: 'subtask_demand',
		plan: {
			profession: neededProfession,
			requiredCapabilities,
			rewardAtomic: reward,
			minReputation: 0, // sub-tasks are entry work so any qualified worker can pick them up fast
			taskType: 'Exclusive',
			maxWorkers: 1,
		},
	};
}

// ── Reconcile mapping ───────────────────────────────────────────────────────
// On-chain task states are the REAL AgenC TaskState enum (@tetsuo-ai/sdk):
//   0 Open · 1 InProgress · 2 PendingValidation · 3 Completed · 4 Cancelled · 5 Disputed
// `formatTaskState` emits the spaced labels "Open" / "In Progress" /
// "Pending Validation" / "Completed" / "Cancelled" / "Disputed" — there is NO
// on-chain "Expired" or "Claimed" state (expiry is deadline-driven; a claimed
// task is InProgress). The board renders a posting as OPEN only while no later
// terminal projection exists for its PDA; this maps the chain's truth to the
// projection kind that closes it. Returning null means "still open — leave it on
// the board." Keys are space-stripped + lowercased (see reconcileTransition), so
// "In Progress" → 'inprogress'. Legacy aliases ('claimed'/'expired') are kept so
// a caller passing the human word still resolves; 'expired' is what the reconcile
// sweep hands us for a past-deadline Open task (there is no on-chain Expired).
const STATE_TRANSITIONS = {
	open: null,
	inprogress: { kind: 'claimed_task', verb: 'was claimed' },
	pendingvalidation: { kind: 'claimed_task', verb: 'is awaiting validation' },
	completed: { kind: 'completed_task', verb: 'was fulfilled' },
	cancelled: { kind: 'cancelled_task', verb: 'was cancelled' },
	// AgenC slashes stake on dispute resolution; a disputed task is no longer
	// claimable, so it drops off the open board under the slashed lane.
	disputed: { kind: 'slashed', verb: 'is under dispute' },
	// Aliases — not enum states, but honest transitions the sweep synthesizes:
	claimed: { kind: 'claimed_task', verb: 'was claimed' },
	expired: { kind: 'expired_task', verb: 'expired' }, // deadline passed while still Open
};

// The projection kinds that close a posting off the open board. An EXCLUSIVE
// posting is claimable by exactly one worker, so its first claim (or any later
// terminal) closes it. A MULTI-WORKER posting (Arena / Guild) stays live through
// its claims AND its per-contributor completions — it closes only when the whole
// task settles (`settled`), is cancelled, expires, or is slashed. The board query
// (api/agora/[action].js) and the reconcile sweep MUST agree on these sets.
export const EXCLUSIVE_TERMINAL_KINDS = ['claimed_task', 'completed_task', 'slashed', 'cancelled_task', 'expired_task'];
export const MULTI_TERMINAL_KINDS = ['settled', 'slashed', 'cancelled_task', 'expired_task'];
// Back-compat: the original single set is the Exclusive one (existing tests + the
// exclusive board lane import it by this name).
export const BOARD_TERMINAL_KINDS = EXCLUSIVE_TERMINAL_KINDS;

/** The board-closing projection kinds for a task of the given type. */
export function terminalKindsFor(taskType) {
	return isMultiWorkerType(taskType) ? MULTI_TERMINAL_KINDS : EXCLUSIVE_TERMINAL_KINDS;
}

/**
 * Map an on-chain task state to the projection transition that reflects it.
 * Accepts the human label ('Open', 'In Progress', …), the raw AgenC enum number
 * (0–5), or a synthesized word ('cancelled'/'expired'). Labels are normalized by
 * lowercasing and stripping spaces so "Pending Validation" → 'pendingvalidation'.
 *
 * `taskType` disambiguates a Completed chain state: for a multi-worker task the
 * whole escrow has now settled (Arena winner took all / Guild split paid out), so
 * we project the single authoritative `settled` terminal instead of a per-worker
 * `completed_task` — the board keeps the Arena/Guild live through its individual
 * completions and closes it only on this whole-task settle.
 */
export function reconcileTransition(stateLabel, taskType) {
	if (stateLabel == null) return null;
	let key;
	if (typeof stateLabel === 'number') {
		key = ['open', 'inprogress', 'pendingvalidation', 'completed', 'cancelled', 'disputed'][stateLabel];
	} else {
		key = String(stateLabel).trim().toLowerCase().replace(/\s+/g, '');
	}
	const t = STATE_TRANSITIONS[key] ?? null;
	if (t && t.kind === 'completed_task' && isMultiWorkerType(taskType)) {
		return { kind: 'settled', verb: t.verb };
	}
	return t;
}

function toBig(v) {
	if (typeof v === 'bigint') return v;
	if (v == null) return 0n;
	try {
		return BigInt(Math.trunc(Number(v)));
	} catch {
		return 0n;
	}
}
