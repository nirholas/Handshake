// @three-ws/agenc — read client for the AgenC agent-coordination protocol on
// Solana (agenc.tech, by Tetsuo Corp). Thin, auth-free client over the public
// three.ws AgenC bridge (/api/agenc/*): discover a creator's tasks, read a
// single task's on-chain state + lifecycle timeline, and resolve the agent
// registry — no Anchor, IDL, or wallet. See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// The README documents reads that reject with a typed `AgenCError` carrying a
// `.code`. That is the platform's shared ThreeWsError under an ergonomic name,
// re-exported so `instanceof AgenCError` and `instanceof ThreeWsError` both hold.
export { ThreeWsError as AgenCError } from './http.js';

const CLUSTERS = ['mainnet', 'devnet'];

// Base58 alphabet (no 0, O, I, l). The bridge ultimately validates pubkeys, but
// catching an obviously-malformed creator before the round-trip turns a 400 into
// a local `invalid_input` with a clear message.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Create an AgenC read client bound to a base URL, fetch, and optional auth.
 * For most callers the zero-config defaults `listTasks()` / `getTask()` /
 * `getAgent()` are enough; use this to reuse a custom origin (a self-hosted
 * bridge), a custom fetch, or default headers across many reads.
 */
export function createAgenc(options = {}) {
	const request = createHttp(options);

	/** Every task a creator wallet posted. Wraps GET /api/agenc/list-tasks. */
	async function listTasks(creator, opts = {}) {
		const wallet = typeof creator === 'string' ? creator.trim() : '';
		if (!wallet) {
			throw new ThreeWsError('listTasks() needs a base58 creator wallet.', { code: 'invalid_input' });
		}
		if (!BASE58_RE.test(wallet)) {
			throw new ThreeWsError(`"${wallet}" is not a valid base58 creator wallet.`, { code: 'invalid_input' });
		}
		const res = await request('/api/agenc/list-tasks', {
			query: { action: 'list-tasks', creator: wallet, cluster: cluster(opts) },
			signal: opts.signal,
		});
		return shapeTaskList(res);
	}

	/**
	 * A single task's on-chain state and, with `{ lifecycle: true }`, its event
	 * timeline. Wraps GET /api/agenc/get-task. Resolve a task three ways:
	 *   getTask('TASK_PDA')                         // by PDA
	 *   getTask({ taskPda: 'TASK_PDA' })            // explicit
	 *   getTask({ creator: 'C', taskId: 'label' })  // derive the PDA
	 */
	async function getTask(idOrPda, opts = {}) {
		const query = { action: 'get-task', cluster: cluster(opts) };
		const sel = taskSelector(idOrPda);
		if (sel.taskPda) {
			query.taskPda = sel.taskPda;
		} else if (sel.creator && sel.taskId != null) {
			query.creator = sel.creator;
			query.taskId = sel.taskId;
		} else {
			throw new ThreeWsError('getTask() needs a taskPda, or a { creator, taskId } pair.', { code: 'invalid_input' });
		}
		if (opts.lifecycle) query.lifecycle = '1';

		const res = await request('/api/agenc/get-task', { query, signal: opts.signal });
		return shapeTaskDetail(res);
	}

	/**
	 * An agent's registry entry. Wraps GET /api/agenc/get-agent. Resolve by PDA
	 * or by id (hex, 0x-hex, or a UTF-8 label SHA-256 hashed by the bridge):
	 *   getAgent('AGENT_PDA')                  // by PDA
	 *   getAgent({ agentPda: 'AGENT_PDA' })    // explicit
	 *   getAgent({ agentId: 'my-label' })      // derive the PDA
	 *   getAgent('my-label')                   // bare string → agentId
	 */
	async function getAgent(idOrPda, opts = {}) {
		const query = { action: 'get-agent', cluster: cluster(opts) };
		const sel = agentSelector(idOrPda);
		if (sel.agentPda) {
			query.agentPda = sel.agentPda;
		} else if (sel.agentId) {
			query.agentId = sel.agentId;
		} else {
			throw new ThreeWsError('getAgent() needs an agentPda or agentId.', { code: 'invalid_input' });
		}

		const res = await request('/api/agenc/get-agent', { query, signal: opts.signal });
		return shapeAgentDetail(res);
	}

	return { listTasks, getTask, getAgent };
}

// A module-level default client for the zero-config path: `import { listTasks }`.
let shared = null;
function defaultClient() {
	return (shared ||= createAgenc());
}

/** Every task a creator wallet posted (mainnet by default). */
export function listTasks(creator, opts) {
	return defaultClient().listTasks(creator, opts);
}
/** A single task's state and (optionally) lifecycle timeline. */
export function getTask(idOrPda, opts) {
	return defaultClient().getTask(idOrPda, opts);
}
/** An agent's registry entry, resolved from a label, hex id, or PDA. */
export function getAgent(idOrPda, opts) {
	return defaultClient().getAgent(idOrPda, opts);
}

// ── input normalization ──────────────────────────────────────────────────────

// Resolve a target cluster: explicit option → default mainnet. Reject anything
// the bridge doesn't speak before spending a round-trip on it.
function cluster(opts) {
	const c = opts.cluster;
	if (c === undefined || c === null) return 'mainnet';
	if (!CLUSTERS.includes(c)) {
		throw new ThreeWsError(`Invalid cluster "${c}". Expected one of: ${CLUSTERS.join(', ')}.`, { code: 'invalid_input' });
	}
	return c;
}

// A bare string is a task PDA; an object names the PDA or a (creator, taskId)
// pair. taskId may be hex, 0x-hex, or any UTF-8 label — the bridge hashes it.
function taskSelector(idOrPda) {
	if (typeof idOrPda === 'string') return { taskPda: idOrPda.trim() || null };
	const o = idOrPda || {};
	return {
		taskPda: trimOrNull(o.taskPda),
		creator: trimOrNull(o.creator),
		taskId: o.taskId == null ? null : String(o.taskId).trim(),
	};
}

// A bare string is treated as an agentId label (the README's ergonomic default);
// an object names the PDA or the id explicitly.
function agentSelector(idOrPda) {
	if (typeof idOrPda === 'string') return { agentId: idOrPda.trim() || null };
	const o = idOrPda || {};
	return {
		agentPda: trimOrNull(o.agentPda),
		agentId: trimOrNull(o.agentId),
	};
}

function trimOrNull(v) {
	if (v == null) return null;
	const s = String(v).trim();
	return s || null;
}

// ── response shaping ─────────────────────────────────────────────────────────
// The bridge already returns decoded, camelCase fields (taskId, rewardAmount,
// state labels). We pass them through with stable defaults and a `.raw` escape
// hatch, normalizing the bridge's `programId` (a base58 string after serialize)
// and omitting the internal `ok` flag.

function ensureObject(res, what) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError(`Unexpected empty response from the AgenC bridge (${what}).`, { code: 'bad_response' });
	}
	return res;
}

function shapeTaskList(res) {
	ensureObject(res, 'list-tasks');
	return {
		cluster: res.cluster ?? null,
		programId: res.programId ?? null,
		creator: res.creator ?? null,
		count: typeof res.count === 'number' ? res.count : (res.tasks?.length ?? 0),
		tasks: Array.isArray(res.tasks) ? res.tasks.map(shapeTaskSummary) : [],
		fetchedAt: res.fetchedAt ?? null,
		raw: res,
	};
}

function shapeTaskSummary(t) {
	return {
		taskId: t.taskId ?? null,
		taskPda: t.taskPda ?? null,
		state: t.state ?? null,
		stateRaw: t.stateRaw ?? null,
		rewardAmount: t.rewardAmount ?? null,
		rewardMint: t.rewardMint ?? null,
		deadline: t.deadline ?? null,
		currentWorkers: t.currentWorkers ?? null,
		maxWorkers: t.maxWorkers ?? null,
		completedAt: t.completedAt ?? null,
		private: Boolean(t.private),
	};
}

function shapeTaskDetail(res) {
	ensureObject(res, 'get-task');
	const t = res.task || {};
	return {
		cluster: res.cluster ?? null,
		programId: res.programId ?? null,
		taskPda: res.taskPda ?? null,
		task: {
			...shapeTaskSummary(t),
			creator: t.creator ?? null,
			constraintHash: t.constraintHash ?? null,
		},
		lifecycle: shapeLifecycle(res.lifecycle),
		fetchedAt: res.fetchedAt ?? null,
		raw: res,
	};
}

function shapeLifecycle(lc) {
	if (!lc || typeof lc !== 'object') return null;
	return {
		currentState: lc.currentState ?? null,
		createdAt: lc.createdAt ?? null,
		currentWorkers: lc.currentWorkers ?? null,
		maxWorkers: lc.maxWorkers ?? null,
		timeline: Array.isArray(lc.timeline)
			? lc.timeline.map((e) => ({
					eventName: e.eventName ?? null,
					timestamp: e.timestamp ?? null,
					txSignature: e.txSignature ?? null,
					actor: e.actor ?? null,
				}))
			: [],
	};
}

function shapeAgentDetail(res) {
	ensureObject(res, 'get-agent');
	const a = res.agent || {};
	return {
		cluster: res.cluster ?? null,
		programId: res.programId ?? null,
		agentPda: res.agentPda ?? null,
		agent: {
			agentId: a.agentId ?? null,
			authority: a.authority ?? null,
			capabilities: a.capabilities ?? null,
			status: a.status ?? null,
			statusRaw: a.statusRaw ?? null,
			endpoint: a.endpoint ?? null,
			metadataUri: a.metadataUri ?? null,
			stakeAmount: a.stakeAmount ?? null,
			activeTasks: a.activeTasks ?? null,
			reputation: a.reputation ?? null,
			registeredAt: a.registeredAt ?? null,
		},
		fetchedAt: res.fetchedAt ?? null,
		raw: res,
	};
}
