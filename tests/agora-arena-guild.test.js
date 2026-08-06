/**
 * Agora — Arena (Competitive) + Guild (Collaborative) multi-worker tasks (Task 09).
 *
 * Pure-logic coverage across every layer of the feature so it runs in CI with no
 * wallet, RPC, DB or browser:
 *   • the labour engine's task-type + per-type terminal + reconcile mapping (policy.js),
 *   • the demand schedule that posts occasional Arena/Guild tiers (demand.js),
 *   • the API's roster + settlement assembly from real activity rows (agora-task-live.js),
 *   • the front-end progress + badge helpers the 3D views read (task-progress / task-types).
 */

import { describe, it, expect } from 'vitest';
import {
	TASK_TYPES,
	normalizeTaskType,
	isMultiWorkerType,
	isArenaType,
	isGuildType,
	terminalKindsFor,
	reconcileTransition,
	decidePatronPost,
	EXCLUSIVE_TERMINAL_KINDS,
	MULTI_TERMINAL_KINDS,
	REPUTATION_BASELINE,
} from '../workers/agora-citizens/policy.js';
import { defaultPatronTiers } from '../workers/agora-citizens/demand.js';
import {
	deriveWorkerState,
	buildRoster,
	buildSettlement,
	assembleTaskLive,
} from '../api/_lib/agora-task-live.js';
import { stateProgress, rankRoster, guildFill, isDecided } from '../src/agora/task-progress.js';
import { taskTypeBadge, isArena, isGuild, isMultiWorker, taskTypeLabel } from '../src/agora/task-types.js';

// ── Engine: task types + terminal sets ────────────────────────────────────────
describe('task-type helpers (policy)', () => {
	it('normalizes free-form / lower-case types', () => {
		expect(normalizeTaskType('competitive')).toBe(TASK_TYPES.COMPETITIVE);
		expect(normalizeTaskType('Collaborative')).toBe(TASK_TYPES.COLLABORATIVE);
		expect(normalizeTaskType('nonsense')).toBe(TASK_TYPES.EXCLUSIVE);
		expect(normalizeTaskType(undefined)).toBe(TASK_TYPES.EXCLUSIVE);
	});

	it('classifies Arena / Guild as multi-worker; Exclusive is not', () => {
		expect(isArenaType('Competitive')).toBe(true);
		expect(isGuildType('Collaborative')).toBe(true);
		expect(isMultiWorkerType('Competitive')).toBe(true);
		expect(isMultiWorkerType('Collaborative')).toBe(true);
		expect(isMultiWorkerType('Exclusive')).toBe(false);
	});

	it('picks the right board-closing terminal set per type', () => {
		// Exclusive closes on its first claim; multi-worker stays live through claims.
		expect(terminalKindsFor('Exclusive')).toContain('claimed_task');
		expect(terminalKindsFor('Competitive')).not.toContain('claimed_task');
		expect(terminalKindsFor('Collaborative')).not.toContain('completed_task');
		expect(MULTI_TERMINAL_KINDS).toContain('settled');
		expect(EXCLUSIVE_TERMINAL_KINDS).toContain('completed_task');
	});
});

describe('reconcile mapping is task-type aware', () => {
	it('an Exclusive Completed closes as completed_task', () => {
		expect(reconcileTransition('Completed').kind).toBe('completed_task');
		expect(reconcileTransition('Completed', 'Exclusive').kind).toBe('completed_task');
	});

	it('a multi-worker Completed closes as the whole-task settle', () => {
		expect(reconcileTransition('Completed', 'Competitive').kind).toBe('settled');
		expect(reconcileTransition('Completed', 'Collaborative').kind).toBe('settled');
	});

	it('a claim (In Progress) never closes a multi-worker task via completed mapping', () => {
		// In Progress maps to claimed_task — which is NOT in the multi-worker terminal
		// set, so the Arena/Guild stays live. (The engine ignores this mapping for
		// multi-worker tasks; the terminal set is the guard.)
		expect(reconcileTransition('In Progress', 'Competitive').kind).toBe('claimed_task');
		expect(MULTI_TERMINAL_KINDS).not.toContain('claimed_task');
	});

	it('cancelled / expired still close a multi-worker task', () => {
		expect(reconcileTransition('cancelled', 'Collaborative').kind).toBe('cancelled_task');
		expect(reconcileTransition('expired', 'Collaborative').kind).toBe('expired_task');
		expect(MULTI_TERMINAL_KINDS).toEqual(expect.arrayContaining(['cancelled_task', 'expired_task', 'slashed']));
	});
});

// ── Engine: demand schedule posts Arena + Guild ──────────────────────────────
describe('patron demand schedule (Task 09)', () => {
	const cfg = {
		taskRewardLamports: 1_000_000,
		enableArena: true,
		enableGuild: true,
		arenaMaxWorkers: 3,
		guildMaxWorkers: 4,
		arenaRewardMultiplier: 6,
		guildRewardMultiplier: 5,
		arenaMinReputation: 3,
	};

	it('includes a Competitive Arena and a Collaborative Guild tier when enabled', () => {
		const tiers = defaultPatronTiers(cfg);
		const arena = tiers.find((t) => t.taskType === 'Competitive');
		const guild = tiers.find((t) => t.taskType === 'Collaborative');
		expect(arena).toBeTruthy();
		expect(arena.maxWorkers).toBe(3);
		expect(arena.rewardAtomic).toBe(6_000_000n);
		// The Arena gate is a delta above AgenC's registration baseline, so a purse
		// gated at "3" really means "3 above a fresh agent", not the absolute 3 that
		// every registered agent already clears.
		expect(arena.minReputation).toBe(REPUTATION_BASELINE + 3);
		expect(guild).toBeTruthy();
		expect(guild.maxWorkers).toBe(4);
		expect(guild.rewardAtomic).toBe(5_000_000n);
		expect(guild.minReputation).toBe(0); // open entry work
	});

	it('omits Arena/Guild tiers when disabled (single-worker board)', () => {
		const tiers = defaultPatronTiers({ ...cfg, enableArena: false, enableGuild: false });
		expect(tiers.some((t) => t.taskType === 'Competitive')).toBe(false);
		expect(tiers.some((t) => t.taskType === 'Collaborative')).toBe(false);
	});

	it('decidePatronPost forwards taskType + maxWorkers into the plan (single-lock escrow)', () => {
		const tiers = defaultPatronTiers(cfg);
		const arenaIdx = tiers.findIndex((t) => t.taskType === 'Competitive');
		const citizen = { patron: { tiers, minPostIntervalMs: 1000 } };
		const d = decidePatronPost({ citizen, now: 10_000, lastPostAt: 0, balanceAtomic: 500_000_000n, postedCount: arenaIdx });
		expect(d.post).toBe(true);
		expect(d.plan.taskType).toBe('Competitive');
		expect(d.plan.maxWorkers).toBe(3);
		// The patron locks the WHOLE purse once (winner-take-all) — the reward is the
		// full pool, not a per-worker figure.
		expect(d.plan.rewardAtomic).toBe(6_000_000n);
	});
});

// ── API: roster + settlement assembly ────────────────────────────────────────
const claimRow = (id, name, prof = 'fetcher', at = '2026-07-02T00:00:00Z', meta = {}) => ({
	kind: 'claimed_task', citizen_id: id, display_name: name, profession: prof, created_at: at, meta,
});
const completeRow = (id, name, outcome, tx, extra = {}) => ({
	kind: 'completed_task', citizen_id: id, display_name: name, profession: 'fetcher',
	tx_signature: tx, proof_hash: 'ab'.repeat(32), created_at: '2026-07-02T00:01:00Z',
	meta: { outcome, ...(extra.meta || {}) }, ...extra,
});
const earnedRow = (id, name, label, atomic) => ({
	kind: 'earned', citizen_id: id, display_name: name, profession: 'fetcher',
	reward_label: label, amount_atomic: atomic, created_at: '2026-07-02T00:01:05Z', meta: {},
});

describe('worker state derivation', () => {
	it('reads won / contributed / lost / working from real rows', () => {
		expect(deriveWorkerState([completeRow('a', 'Aria', 'won', 'TXW')])).toBe('won');
		expect(deriveWorkerState([completeRow('b', 'Sol', 'contributed', 'TXC')])).toBe('contributed');
		expect(deriveWorkerState([{ kind: 'claimed_task' }, { kind: 'stood_down' }])).toBe('lost');
		expect(deriveWorkerState([{ kind: 'claimed_task' }])).toBe('working');
		expect(deriveWorkerState([])).toBe('engaged');
	});
});

describe('Arena settlement (Competitive)', () => {
	const rows = [
		claimRow('a', 'Aria', 'fetcher', '2026-07-02T00:00:00Z'),
		claimRow('b', 'Sol', 'fetcher', '2026-07-02T00:00:10Z'),
		claimRow('c', 'Koa', 'fetcher', '2026-07-02T00:00:20Z'),
		completeRow('a', 'Aria', 'won', 'TX_WIN'),
		earnedRow('a', 'Aria', '0.0060 SOL', '6000000'),
		{ kind: 'stood_down', citizen_id: 'b', display_name: 'Sol', profession: 'fetcher', created_at: '2026-07-02T00:01:10Z', meta: { winner: 'Aria' } },
		{ kind: 'settled', citizen_id: 'a', display_name: 'Aria', created_at: '2026-07-02T00:01:11Z', meta: {} },
	];

	it('names the single winner and counts the stood-down racers', () => {
		const roster = buildRoster(rows);
		const s = buildSettlement({ taskType: 'Competitive', roster, chain: { currentState: 'Completed', maxWorkers: 3 }, posting: { rewardLabel: '0.0060 SOL' }, hasSettledRow: true });
		expect(s.type).toBe('arena');
		expect(s.settled).toBe(true);
		expect(s.winner.displayName).toBe('Aria');
		expect(s.winner.tx).toBe('TX_WIN');
		expect(s.winner.rewardLabel).toBe('0.0060 SOL');
		expect(s.stoodDownCount).toBe(1); // Sol stood down; Koa is still 'working' (no terminal row)
	});

	it('ranks the winner first, then racers, then the loser', () => {
		const roster = rankRoster(buildRoster(rows));
		expect(roster[0].displayName).toBe('Aria');
		expect(roster[0].won).toBe(true);
		expect(roster[roster.length - 1].state).toBe('lost');
	});

	it('a one-entrant race still settles honestly (single runner wins)', () => {
		const solo = [claimRow('a', 'Aria'), completeRow('a', 'Aria', 'won', 'TX_SOLO'), earnedRow('a', 'Aria', '0.0060 SOL', '6000000')];
		const roster = buildRoster(solo);
		const s = buildSettlement({ taskType: 'Competitive', roster, chain: { currentState: 'Completed', maxWorkers: 3 }, posting: { rewardLabel: '0.0060 SOL' } });
		expect(roster.length).toBe(1);
		expect(s.winner.displayName).toBe('Aria');
		expect(s.stoodDownCount).toBe(0);
	});
});

describe('Guild settlement (Collaborative)', () => {
	it('splits the pool across contributors, each with a real measured share', () => {
		const rows = [
			claimRow('a', 'Aria'), claimRow('b', 'Sol'), claimRow('c', 'Koa'),
			completeRow('a', 'Aria', 'contributed', 'TX_A', { meta: { shareAtomic: '2000000' } }),
			earnedRow('a', 'Aria', '0.0020 SOL', '2000000'),
			completeRow('b', 'Sol', 'contributed', 'TX_B', { meta: { shareAtomic: '2000000' } }),
			earnedRow('b', 'Sol', '0.0020 SOL', '2000000'),
			completeRow('c', 'Koa', 'contributed', 'TX_C', { meta: { shareAtomic: '2000000' } }),
			earnedRow('c', 'Koa', '0.0020 SOL', '2000000'),
			{ kind: 'settled', citizen_id: 'a', display_name: 'Aria', created_at: '2026-07-02T00:02:00Z', meta: {} },
		];
		const roster = buildRoster(rows);
		const s = buildSettlement({ taskType: 'Collaborative', roster, chain: { currentState: 'Completed', maxWorkers: 3 }, posting: { rewardLabel: '0.0060 SOL' }, hasSettledRow: true });
		expect(s.type).toBe('guild');
		expect(s.settled).toBe(true);
		expect(s.contributorCount).toBe(3);
		expect(s.expiredUnderTarget).toBe(false);
		expect(s.contributors.map((c) => c.shareLabel)).toEqual(['0.0020 SOL', '0.0020 SOL', '0.0020 SOL']);
		expect(s.contributors.every((c) => !!c.tx)).toBe(true);
	});

	it('a guild that misses its worker target before the deadline expires — reward returns', () => {
		const rows = [
			claimRow('a', 'Aria'),
			completeRow('a', 'Aria', 'contributed', 'TX_A', { meta: { shareAtomic: '2000000' } }),
			earnedRow('a', 'Aria', '0.0020 SOL', '2000000'),
		];
		const roster = buildRoster(rows);
		// Chain expired (deadline passed) with only 1/3 contributions in.
		const s = buildSettlement({ taskType: 'Collaborative', roster, chain: { currentState: 'Cancelled', maxWorkers: 3, isExpired: true }, posting: { rewardLabel: '0.0060 SOL' } });
		expect(s.settled).toBe(true);
		expect(s.contributorCount).toBe(1);
		expect(s.expiredUnderTarget).toBe(true); // fewer contributors than slots → pool returns
	});
});

describe('assembleTaskLive', () => {
	it('fills worker counts from chain and flags empty honestly', () => {
		const view = assembleTaskLive({
			taskPda: 'PDA1', cluster: 'devnet',
			posting: { taskType: 'Competitive', maxWorkers: 3, rewardLabel: '0.0060 SOL' },
			activityRows: [claimRow('a', 'Aria'), claimRow('b', 'Sol')],
			chain: { currentState: 'In Progress', currentWorkers: 2, maxWorkers: 3 },
		});
		expect(view.taskType).toBe('Competitive');
		expect(view.workersCurrent).toBe(2);
		expect(view.workersMax).toBe(3);
		expect(view.roster.length).toBe(2);
		expect(view.empty).toBe(false);
	});
});

// ── Front-end: progress + badges ─────────────────────────────────────────────
describe('task-progress (visual mapping)', () => {
	it('maps state to a monotonic race position', () => {
		expect(stateProgress('engaged')).toBeLessThan(stateProgress('working'));
		expect(stateProgress('working')).toBeLessThan(stateProgress('won'));
		expect(stateProgress('won')).toBe(1);
		expect(stateProgress('contributed')).toBe(1);
		// A stood-down racer froze mid-course; it never reaches the finish.
		expect(stateProgress('lost')).toBeLessThan(1);
	});

	it('guildFill is contributions over slots, clamped to 1', () => {
		expect(guildFill({ contributorCount: 0, workersMax: 4 })).toBe(0);
		expect(guildFill({ contributorCount: 2, workersMax: 4 })).toBe(0.5);
		expect(guildFill({ contributorCount: 9, workersMax: 4 })).toBe(1);
	});

	it('isDecided is true only once a winner emerges or the task settles', () => {
		expect(isDecided({ settlement: { type: 'arena', winner: null, settled: false } })).toBe(false);
		expect(isDecided({ settlement: { type: 'arena', winner: { displayName: 'Aria' } } })).toBe(true);
		expect(isDecided({ settlement: { type: 'guild', settled: true } })).toBe(true);
	});
});

describe('task-types (badges)', () => {
	it('badges Arena and Guild, but not Exclusive', () => {
		expect(taskTypeBadge('Competitive').kind).toBe('arena');
		expect(taskTypeBadge('Collaborative').kind).toBe('guild');
		expect(taskTypeBadge('Exclusive')).toBe(null);
		expect(isArena('Competitive')).toBe(true);
		expect(isGuild('Collaborative')).toBe(true);
		expect(isMultiWorker('Exclusive')).toBe(false);
		expect(taskTypeLabel('Competitive')).toBe('Arena');
		expect(taskTypeLabel('Collaborative')).toBe('Guild');
	});
});
