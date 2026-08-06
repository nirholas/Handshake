/**
 * Agora life engine — the daily loop itself (Task 11 hardening).
 *
 * Every other Agora suite covers a pure module the loop calls; nothing covered
 * `tickCitizen`, the state machine that actually drives the economy:
 *
 *   IDLE → SEEK → CLAIM → WORK → PROVE → EARN → IDLE
 *
 * Three properties matter enough to pin, because breaking any of them corrupts
 * the world silently rather than loudly:
 *
 *   1. TRANSITIONS — each node returns its honest outcome, and a citizen that
 *      finds no work idles instead of inventing an action to project.
 *   2. IDEMPOTENCY — a re-run never double-projects an on-chain action. Every
 *      economic row carries the tx signature the DB's unique index dedups on
 *      (citizen_id, kind, tx_signature), and a task already worked in-process is
 *      never claimed twice.
 *   3. FAILURE ISOLATION — a throw anywhere in one citizen's tick is contained:
 *      it returns 'failed', releases the busy latch, and never propagates to the
 *      fleet loop.
 *
 * The chain (agenc.js), the work runners (work/index.js) and the demand policy
 * (demand.js) are mocked at the MODULE boundary — the same discipline
 * tests/agora-mcp-tools.test.js uses. The engine under test is the real one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const TASK_STATE = { Open: 0, InProgress: 1, PendingValidation: 2, Completed: 3, Cancelled: 4, Disputed: 5 };

// A real, valid base58 pubkey to stand in for a task PDA. Using a genuine
// PublicKey (not a string literal) keeps the engine's `new PublicKey(...)` and
// `.toBase58()` paths on their real code path.
const TASK_PDA = new PublicKey('11111111111111111111111111111112');
const AGENT_PDA = new PublicKey('SysvarC1ock11111111111111111111111111111111');

// The factory is hoisted above every const in this file, so the enum is inlined
// here and cross-checked against the module's real one in the first test below.
vi.mock('../workers/agora-citizens/agenc.js', () => ({
	TASK_STATE: { Open: 0, InProgress: 1, PendingValidation: 2, Completed: 3, Cancelled: 4, Disputed: 5 },
	makeReadClient: vi.fn(),
	makeSignerClient: vi.fn(),
	deriveIdentity: vi.fn(),
	ensureRegistered: vi.fn(),
	getAgent: vi.fn(),
	listCreatorTasks: vi.fn(),
	createTask: vi.fn(),
	claimTask: vi.fn(),
	completeTask: vi.fn(),
	generateTaskId: vi.fn(),
	deriveTaskPda: vi.fn(),
	getTask: vi.fn(),
	readEscrowLamports: vi.fn(),
	withRetry: vi.fn((fn) => fn()),
}));

vi.mock('../workers/agora-citizens/work/index.js', () => ({
	runProfession: vi.fn(),
}));

vi.mock('../workers/agora-citizens/demand.js', () => ({
	markPatrons: vi.fn(() => 0),
	maybePatronPost: vi.fn(),
	maybePatronVerify: vi.fn(),
	maybeHire: vi.fn(),
	hiringEnabled: vi.fn(() => false),
	subtaskReward: vi.fn(() => 1000),
}));

import { tickCitizen } from '../workers/agora-citizens/engine.js';
import { getAgent, claimTask, completeTask, getTask } from '../workers/agora-citizens/agenc.js';
import { runProfession } from '../workers/agora-citizens/work/index.js';
import { maybePatronPost, maybePatronVerify } from '../workers/agora-citizens/demand.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

/**
 * A recording stand-in for the projection sink (store.js). Records every write
 * so a test can assert WHAT was projected, not just that something was, and
 * applies the same (citizen_id, kind, tx_signature) uniqueness the real table's
 * partial index enforces — so "no double-projection" is tested against the real
 * dedup rule rather than a weaker in-memory one.
 */
function makeRecordingStore() {
	const activities = [];
	const feed = [];
	const statuses = [];
	const updates = [];
	return {
		activities,
		feed,
		statuses,
		updates,
		async appendActivity(a) {
			const dup =
				a.txSignature &&
				activities.some((x) => x.citizenId === a.citizenId && x.kind === a.kind && x.txSignature === a.txSignature);
			if (dup) return null;
			activities.push(a);
			return `row-${activities.length}`;
		},
		async publishFeed(e) {
			feed.push(e);
			return e;
		},
		async setStatus(citizenId, status, pos) {
			statuses.push({ citizenId, status, pos });
		},
		async updateCitizen(citizenId, patch) {
			updates.push({ citizenId, ...patch });
		},
		async activityExists() {
			return false;
		},
		async taskActivityExists() {
			return false;
		},
		async winnerNameForTask() {
			return null;
		},
		async recentUnverifiedDeliverable() {
			return null;
		},
		async heartbeat() {},
	};
}

function makeCitizen(overrides = {}) {
	return {
		spec: { displayName: 'Aria', profession: 'fetcher', key: 'aria' },
		id: 'citizen-1',
		agentIdHex: 'a'.repeat(64),
		agentPda: AGENT_PDA,
		pubkey: 'FakePubkey1111111111111111111111111111111111',
		signer: {},
		client: {},
		capabilityBits: 1n,
		reputation: 5,
		claimed: new Set(),
		home: { x: 10, z: -4 },
		busy: false,
		patron: false,
		...overrides,
	};
}

function makeCtx(store, boardTasks = []) {
	return {
		cfg: {
			cluster: 'devnet',
			apiBase: 'https://three.ws',
			taskRewardLamports: 50_000_000,
			minOpenTasks: 1,
			maxOpenTasks: 4,
			taskDeadlineSecs: 3600,
		},
		store,
		readClient: {},
		dispatcher: null, // no devnet dispatcher — the board is the only supply
		citizens: [],
		// `at: Date.now()` keeps refreshBoard inside its TTL so the tick never
		// reaches out over HTTP; the board content is supplied directly.
		board: { at: Date.now(), services: [], tasks: boardTasks },
		lastSupplyAt: Date.now(),
	};
}

/** An open, claimable board bounty with a live deadline. */
function openBoardTask(extra = {}) {
	return {
		source: 'agenc',
		taskPda: TASK_PDA.toBase58(),
		requiredCapabilities: 1,
		minReputation: 0,
		taskType: 'Exclusive',
		maxWorkers: 1,
		reward: { amountAtomic: 50_000_000 },
		creator: { id: 'someone-else' },
		...extra,
	};
}

/** The on-chain view of that task: Open, one free slot, deadline in the future. */
function onchainOpen(extra = {}) {
	return {
		state: TASK_STATE.Open,
		currentWorkers: 0,
		maxWorkers: 1,
		deadline: Math.floor(Date.now() / 1000) + 3600,
		...extra,
	};
}

/** The proof shape every WORK runner returns (see work/README.md). */
function workResult(extra = {}) {
	return {
		proofHashBytes: new Uint8Array(32).fill(7),
		proofHashHex: '07'.repeat(32),
		resultData: 'https://three.ws/deliverable.json',
		deliverableUrl: 'https://three.ws/deliverable.json',
		target: 'https://api.three.ws/health',
		summary: 'Fetched a live service and fingerprinted the response',
		...extra,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getAgent).mockResolvedValue({ reputation: 5 });
	vi.mocked(getTask).mockResolvedValue(onchainOpen());
	vi.mocked(claimTask).mockResolvedValue({ txSignature: 'claimtx1111' });
	vi.mocked(completeTask).mockResolvedValue({ txSignature: 'completetx2222' });
	vi.mocked(runProfession).mockResolvedValue(workResult());
});

// ── 0. The mock's contract with the real module ──────────────────────────────

describe('agenc mock fidelity', () => {
	it('mirrors the real TaskState enum', async () => {
		// If agenc.js renumbers a state, every "is it still Open?" assertion below
		// would keep passing against a stale enum. Pin the mock to the real thing.
		const actual = await vi.importActual('../workers/agora-citizens/agenc.js');
		expect(TASK_STATE).toEqual(actual.TASK_STATE);
	});
});

// ── 1. Loop transitions ──────────────────────────────────────────────────────

describe('tickCitizen — loop transitions', () => {
	it('idles honestly when there is no claimable work, and projects NO activity', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store), makeCitizen());

		expect(node).toBe('idle');
		// The critical honesty property: an idle citizen invents nothing. Wandering
		// is world motion, not an economic action, so it earns no activity row.
		expect(store.activities).toHaveLength(0);
		expect(store.feed).toHaveLength(0);
		expect(store.statuses.at(-1)).toMatchObject({ status: 'idle' });
	});

	it('runs the full SEEK → CLAIM → WORK → PROVE → EARN path on an open bounty', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		expect(node).toBe('completed');
		expect(claimTask).toHaveBeenCalledTimes(1);
		expect(runProfession).toHaveBeenCalledTimes(1);
		expect(completeTask).toHaveBeenCalledTimes(1);

		// Transitions are written in order: seeking → busy → (idle via updateCitizen).
		expect(store.statuses.map((s) => s.status)).toEqual(['seeking', 'busy']);
		expect(store.updates.at(-1)).toMatchObject({ status: 'idle', tasksCompletedDelta: 1 });

		// And the economy is projected as three real rows: the claim, the
		// completion (with its proof), and the earning.
		expect(store.activities.map((a) => a.kind)).toEqual(['claimed_task', 'completed_task', 'earned']);
	});

	it('dispatches the WORK step by profession, not by a hardcoded runner', async () => {
		const store = makeRecordingStore();
		await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen({ spec: { displayName: 'Mira', profession: 'sculptor' } }));

		expect(vi.mocked(runProfession).mock.calls[0][0]).toBe('sculptor');
	});

	it('works a verification bounty as the Verifier regardless of the citizen craft', async () => {
		const store = makeRecordingStore();
		const task = openBoardTask({ target: { taskPda: 'other-task', deliverableUrl: 'https://three.ws/x.json' } });
		await tickCitizen(makeCtx(store, [task]), makeCitizen({ spec: { displayName: 'Wren', profession: 'sculptor' } }));

		// A Sculptor holding a verification bounty runs runVerifier — the trust loop
		// depends on the target, not on the claimant's headline profession.
		expect(vi.mocked(runProfession).mock.calls[0][0]).toBe('verifier');
	});

	it('backs off to idle without projecting anything when the claim loses the race', async () => {
		vi.mocked(claimTask).mockRejectedValue(new Error('task already claimed'));
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		expect(node).toBe('claim-failed');
		expect(store.activities).toHaveLength(0); // never project an action that did not land
		expect(runProfession).not.toHaveBeenCalled(); // and never do the work you did not win
		expect(store.statuses.at(-1)).toMatchObject({ status: 'idle' });
	});

	it('skips a bounty above the citizen reputation gate (the career ladder holds)', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(
			makeCtx(store, [openBoardTask({ minReputation: 20 })]),
			makeCitizen({ reputation: 2 }),
		);

		expect(node).toBe('idle');
		expect(claimTask).not.toHaveBeenCalled();
	});

	it('never claims its own posting', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask({ creator: { id: 'citizen-1' } })]), makeCitizen());

		expect(node).toBe('idle');
		expect(claimTask).not.toHaveBeenCalled();
	});

	it('ignores a board task the chain says is no longer Open', async () => {
		vi.mocked(getTask).mockResolvedValue(onchainOpen({ state: TASK_STATE.Completed }));
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		// The projection can be stale; the chain is the truth. Trusting the board
		// here would burn a claim on a settled task every tick.
		expect(node).toBe('idle');
		expect(claimTask).not.toHaveBeenCalled();
	});

	it('ignores a board task whose deadline has passed', async () => {
		vi.mocked(getTask).mockResolvedValue(onchainOpen({ deadline: Math.floor(Date.now() / 1000) - 60 }));
		const store = makeRecordingStore();
		expect(await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen())).toBe('idle');
		expect(claimTask).not.toHaveBeenCalled();
	});

	it('lets an idle patron post demand, and reports the patron-idle node', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store), makeCitizen({ patron: true }));

		expect(node).toBe('patron-idle');
		expect(maybePatronPost).toHaveBeenCalledTimes(1);
		expect(maybePatronVerify).toHaveBeenCalledTimes(1);
	});

	it('refuses to run a citizen that is already mid-tick', async () => {
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen({ busy: true }));

		// The busy latch is what stops a slow tick from being re-entered by its own
		// next timer and double-claiming.
		expect(node).toBe('busy-skip');
		expect(claimTask).not.toHaveBeenCalled();
	});
});

// ── 2. Idempotency — no double-projection ────────────────────────────────────

describe('tickCitizen — idempotency', () => {
	it('does not re-claim a task it already worked this process', async () => {
		const store = makeRecordingStore();
		const ctx = makeCtx(store, [openBoardTask()]);
		const citizen = makeCitizen();

		expect(await tickCitizen(ctx, citizen)).toBe('completed');
		expect(citizen.claimed.has(TASK_PDA.toBase58())).toBe(true);

		// Same board, same citizen, second tick: the task is in `claimed`, so SEEK
		// passes it over rather than paying to claim a task it already settled.
		const second = await tickCitizen(ctx, citizen);
		expect(second).toBe('idle');
		expect(claimTask).toHaveBeenCalledTimes(1);
	});

	it('stamps every economic row with the tx signature the DB dedups on', async () => {
		const store = makeRecordingStore();
		await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		// agora_activity's unique index is (citizen_id, kind, tx_signature) WHERE
		// tx_signature IS NOT NULL. A row with a null signature is invisible to it
		// and would double-project on a replay.
		for (const a of store.activities) {
			expect(a.txSignature, `${a.kind} must carry a tx signature`).toBeTruthy();
			expect(a.citizenId).toBe('citizen-1');
		}
		expect(store.activities.find((a) => a.kind === 'claimed_task').txSignature).toBe('claimtx1111');
		expect(store.activities.find((a) => a.kind === 'completed_task').txSignature).toBe('completetx2222');
		expect(store.activities.find((a) => a.kind === 'earned').txSignature).toBe('completetx2222');
	});

	it('replaying the same tick projects the economy exactly once', async () => {
		const store = makeRecordingStore();
		// A fresh citizen object each time models a worker restart: the in-process
		// `claimed` set is gone, so ONLY the DB uniqueness rule stands between a
		// replay and a double-counted economy.
		await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());
		await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		expect(store.activities.filter((a) => a.kind === 'completed_task')).toHaveLength(1);
		expect(store.activities.filter((a) => a.kind === 'earned')).toHaveLength(1);
		expect(store.activities.filter((a) => a.kind === 'claimed_task')).toHaveLength(1);
	});

	it('carries the on-chain proof and deliverable onto the completion row', async () => {
		const store = makeRecordingStore();
		await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		// Without both of these a Verifier cannot re-download the bytes and
		// re-derive the hash, and the whole verifiable supply chain is decorative.
		const done = store.activities.find((a) => a.kind === 'completed_task');
		expect(done.proofHash).toBe('07'.repeat(32));
		expect(done.deliverableUrl).toBe('https://three.ws/deliverable.json');
	});

	it('projects the trust-loop vouch on the same completion tx as the work', async () => {
		vi.mocked(runProfession).mockResolvedValue(
			workResult({
				vouch: {
					match: true,
					verdict: 'pass',
					claimed: 'ab'.repeat(32),
					recomputed: 'ab'.repeat(32),
					targetTaskPda: 'target-task',
					targetCitizenId: 'citizen-2',
					targetDeliverableUrl: 'https://three.ws/other.json',
					targetProfession: 'sculptor',
				},
			}),
		);
		const store = makeRecordingStore();
		const task = openBoardTask({ target: { taskPda: 'target-task' } });
		await tickCitizen(makeCtx(store, [task]), makeCitizen());

		const vouch = store.activities.find((a) => a.kind === 'vouched');
		expect(vouch.txSignature).toBe('completetx2222'); // dedups with the completion
		expect(vouch.counterpartyCitizenId).toBe('citizen-2');
		expect(store.feed.some((e) => e.type === 'agora-vouched')).toBe(true);
	});

	it('records a failed verification as a flag, never a silent pass', async () => {
		vi.mocked(runProfession).mockResolvedValue(
			workResult({
				vouch: {
					match: false,
					verdict: 'mismatch',
					claimed: 'ab'.repeat(32),
					recomputed: 'cd'.repeat(32),
					targetTaskPda: 'target-task',
					targetCitizenId: 'citizen-2',
				},
			}),
		);
		const store = makeRecordingStore();
		await tickCitizen(makeCtx(store, [openBoardTask({ target: { taskPda: 'target-task' } })]), makeCitizen());

		expect(store.feed.some((e) => e.type === 'agora-flagged')).toBe(true);
		expect(store.feed.some((e) => e.type === 'agora-vouched')).toBe(false);
		expect(store.activities.find((a) => a.kind === 'vouched').meta.verdict).toBe('mismatch');
	});
});

// ── 3. Failure isolation ─────────────────────────────────────────────────────

describe('tickCitizen — failure isolation', () => {
	it('contains a WORK failure and releases the busy latch', async () => {
		vi.mocked(runProfession).mockRejectedValue(new Error('forge lane down'));
		const store = makeRecordingStore();
		const citizen = makeCitizen();

		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), citizen);

		expect(node).toBe('failed');
		expect(citizen.busy).toBe(false); // else this citizen is wedged forever
		expect(store.statuses.at(-1)).toMatchObject({ status: 'idle' });
		// It claimed before it failed, so the claim IS projected (it really happened),
		// but nothing downstream of the failure is.
		expect(store.activities.map((a) => a.kind)).toEqual(['claimed_task']);
	});

	it('contains a PROVE failure without projecting an unearned reward', async () => {
		vi.mocked(completeTask).mockRejectedValue(new Error('rpc 429'));
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), makeCitizen());

		expect(node).toBe('failed');
		expect(store.activities.some((a) => a.kind === 'earned')).toBe(false);
		expect(store.updates).toHaveLength(0); // no balance moved
	});

	it('survives a projection-sink outage without throwing at the fleet loop', async () => {
		const store = makeRecordingStore();
		store.appendActivity = vi.fn().mockRejectedValue(new Error('neon unreachable'));
		const citizen = makeCitizen();

		const node = await tickCitizen(makeCtx(store, [openBoardTask()]), citizen);

		expect(node).toBe('failed');
		expect(citizen.busy).toBe(false);
	});

	it('survives a total projection outage — even the recovery write failing', async () => {
		const store = makeRecordingStore();
		store.appendActivity = vi.fn().mockRejectedValue(new Error('neon unreachable'));
		store.setStatus = vi.fn().mockRejectedValue(new Error('neon unreachable'));
		const citizen = makeCitizen();

		// The catch block's own recovery write is best-effort; if IT throws too, the
		// tick must still resolve, or one DB outage takes down the whole fleet.
		await expect(tickCitizen(makeCtx(store, [openBoardTask()]), citizen)).resolves.toBe('failed');
		expect(citizen.busy).toBe(false);
	});

	it('keeps working from the last-known reputation when reconcile RPC fails', async () => {
		vi.mocked(getAgent).mockRejectedValue(new Error('rpc timeout'));
		const store = makeRecordingStore();
		const citizen = makeCitizen({ reputation: 9 });

		const node = await tickCitizen(makeCtx(store, [openBoardTask({ minReputation: 5 })]), citizen);

		// A transient RPC failure must not silently demote a citizen to reputation 0
		// and lock it out of the bounties it has earned the right to claim.
		expect(node).toBe('completed');
		expect(claimTask).toHaveBeenCalledTimes(1);
	});

	it('does not let one citizen failure stop the next citizen from working', async () => {
		const store = makeRecordingStore();
		const ctx = makeCtx(store, [openBoardTask()]);
		vi.mocked(runProfession).mockRejectedValueOnce(new Error('boom'));

		const first = await tickCitizen(ctx, makeCitizen({ id: 'citizen-1', spec: { displayName: 'A', profession: 'fetcher' } }));
		const second = await tickCitizen(ctx, makeCitizen({ id: 'citizen-2', spec: { displayName: 'B', profession: 'fetcher' } }));

		expect(first).toBe('failed');
		expect(second).toBe('completed');
	});

	it('reports a patron post failure as an idle tick, not a crash', async () => {
		vi.mocked(maybePatronPost).mockRejectedValue(new Error('faucet dry'));
		const store = makeRecordingStore();
		const node = await tickCitizen(makeCtx(store), makeCitizen({ patron: true }));

		// Demand failing is a bad day for the board, not a dead citizen.
		expect(node).toBe('patron-idle');
	});
});
