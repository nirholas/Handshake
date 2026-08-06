// agora-citizens — the on-chain layer. A thin, retry-wrapped adapter over
// @three-ws/solana-agent (which wraps @tetsuo-ai/sdk → the AgenC coordination
// protocol on Solana). The SDK ships as TS and is imported LAZILY (dynamic
// import, cached) so module load never crashes when its dist/ isn't built yet —
// exactly how api/agora/[action].js reaches the write SDK. Every mutating call is
// wrapped in bounded retry/backoff so a transient RPC failure for one citizen
// never halts the fleet.

import { PublicKey } from '@solana/web3.js';
import { log } from './log.js';

// AgenC TaskState enum (from @tetsuo-ai/sdk). Open tasks are claimable.
export const TASK_STATE = {
	Open: 0,
	InProgress: 1,
	PendingValidation: 2,
	Completed: 3,
	Cancelled: 4,
	Disputed: 5,
};

let _sdk = null;
async function sdk() {
	if (_sdk) return _sdk;
	_sdk = await import('@three-ws/solana-agent');
	return _sdk;
}

// The upstream protocol SDK — for PDA derivation helpers the three.ws adapter
// uses internally but doesn't re-export (e.g. deriveTaskPda). Same lazy pattern.
let _tetsuo = null;
async function tetsuo() {
	if (_tetsuo) return _tetsuo;
	_tetsuo = await import('@tetsuo-ai/sdk');
	return _tetsuo;
}

/**
 * Derive a task's on-chain PDA from its creator + 32-byte taskId. getTasksByCreator
 * returns TaskStatus rows WITHOUT the PDA, but claim/complete need it — so we
 * re-derive it deterministically (no RPC).
 */
export async function deriveTaskPda(client, creator, taskId) {
	const t = await tetsuo();
	const creatorPk = creator instanceof PublicKey ? creator : new PublicKey(creator);
	return t.deriveTaskPda(creatorPk, taskId, client.programId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an on-chain call with bounded exponential backoff. Returns the result, or
 * rethrows the last error after cfg.maxRetries attempts so the caller can decide
 * (per-citizen) whether to skip this tick.
 */
export async function withRetry(fn, cfg, label) {
	let lastErr = null;
	for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt === cfg.maxRetries) break;
			const waitMs = cfg.retryBaseMs * Math.pow(2, attempt) + Math.floor(cfg.retryBaseMs * 0.5);
			log.warn('onchain retry', { label, attempt: attempt + 1, err: err?.message, retryMs: waitMs });
			await sleep(waitMs);
		}
	}
	throw lastErr;
}

/**
 * Derive a citizen's canonical AgenC identity from its identity proofs
 * (composite > erc8004 > mpl-core > handle) via the identity bridge — no new
 * namespace invented. Returns the 32-byte id (bytes + hex), the provenance, and
 * the metadataUri to register with.
 */
export async function deriveIdentity(ref) {
	const s = await sdk();
	const result = s.getCanonicalThreewsAgenCId(ref);
	const agentIdHex = s.agenCAgentIdToHex(result.agenCAgentId);
	const metadataUri = s.buildThreewsMetadataUri(ref);
	return {
		agentIdBytes: result.agenCAgentId,
		agentIdHex,
		source: result.source,
		label: result.label,
		metadataUri,
	};
}

export async function makeReadClient(cfg) {
	const s = await sdk();
	return s.createAgenCClient({ cluster: cfg.cluster, rpcUrl: cfg.rpcUrl });
}

export async function makeSignerClient(cfg, signer) {
	const s = await sdk();
	return s.createAgenCClient({ cluster: cfg.cluster, rpcUrl: cfg.rpcUrl, signer });
}

export async function derivePda(client, agentIdHex) {
	const s = await sdk();
	return s.deriveAgenCAgentPda(client, agentIdHex);
}

export async function getAgent(client, pda) {
	const s = await sdk();
	return s.getAgenCAgent(client, pda);
}

/**
 * Does this registration failure mean the agent account already exists? The AgenC
 * program allocates the agent PDA, so a repeat registration fails in the System
 * program with "already in use" (custom program error 0x0) rather than a protocol
 * error. Matched on the allocate message, not the bare error code, which is far too
 * generic to key off.
 */
export function isAlreadyRegisteredError(err) {
	const message = [err?.message, ...(Array.isArray(err?.logs) ? err.logs : [])].filter(Boolean).join('\n');
	return /already in use/i.test(message);
}

/**
 * Ensure a wallet is registered as an AgenC agent (idempotent). If the PDA
 * already exists on-chain we reconcile from it rather than re-registering.
 * Returns { agentPda, txSignature|null, existed, agent }.
 */
export async function ensureRegistered(client, agentIdHex, params, cfg) {
	const s = await sdk();
	const pda = s.deriveAgenCAgentPda(client, agentIdHex);
	const existing = await withRetry(() => s.getAgenCAgent(client, pda), cfg, 'getAgent');
	if (existing) {
		return { agentPda: pda, txSignature: null, existed: true, agent: existing };
	}
	let result;
	try {
		result = await withRetry(
			() =>
				s.registerAgenCAgent(client, {
					agentId: agentIdHex,
					capabilities: params.capabilities,
					endpoint: params.endpoint,
					metadataUri: params.metadataUri ?? null,
					stakeAmount: params.stakeLamports,
				}),
			cfg,
			'registerAgent',
		);
	} catch (err) {
		// A registration that fails because the account is ALREADY IN USE is proof
		// the agent is registered: the pre-flight read above just missed it (a
		// rate-limited or lagging RPC returns "account does not exist" for an account
		// that is really there). Re-read and reconcile instead of dropping the
		// citizen: losing every citizen this way takes the whole fleet down.
		if (!isAlreadyRegisteredError(err)) throw err;
		const recovered = await withRetry(() => s.getAgenCAgent(client, pda), cfg, 'getAgent:afterInUse');
		if (!recovered) throw err;
		log.warn('agent already registered on-chain, reconciled after a stale read', { pda: pda.toBase58() });
		return { agentPda: pda, txSignature: null, existed: true, agent: recovered };
	}
	const agent = await withRetry(() => s.getAgenCAgent(client, result.agentPda), cfg, 'getAgent:postRegister');
	return { agentPda: result.agentPda, txSignature: result.txSignature, existed: false, agent };
}

/** List every task created by a wallet (used to reconcile the dispatcher pool). */
export async function listCreatorTasks(client, creator) {
	const s = await sdk();
	const pk = creator instanceof PublicKey ? creator : new PublicKey(creator);
	return withRetry(() => s.listAgenCTasksByCreator(client, pk), { maxRetries: 2, retryBaseMs: 1000 }, 'listTasksByCreator');
}

export async function getTask(client, taskPda) {
	const s = await sdk();
	return s.getAgenCTask(client, taskPda instanceof PublicKey ? taskPda : new PublicKey(taskPda));
}

/** Post a real on-chain task (used by the internal devnet work dispatcher). */
export async function createTask(client, args, cfg) {
	const s = await sdk();
	return withRetry(() => s.createAgenCTask(client, args), cfg, 'createTask');
}

/**
 * Does this claim failure mean THIS worker already holds the claim? AgenC rejects a
 * second claim from the same worker with `AlreadyClaimed`, which is what a retry sees
 * when the first attempt landed on-chain but its RPC response was lost. Distinct from
 * losing a slot to someone else (`TaskFull` / a state change), which is a real failure.
 */
export function isAlreadyClaimedError(err) {
	const message = [err?.message, ...(Array.isArray(err?.logs) ? err.logs : [])].filter(Boolean).join('\n');
	return /AlreadyClaimed|already claimed this task/i.test(message);
}

/**
 * Claim a task for a worker. Idempotent under a lost RPC response: a retry that comes
 * back `AlreadyClaimed` means the earlier attempt succeeded on-chain, so we report the
 * claim as held rather than as a failure. Getting this wrong is expensive on a
 * multi-worker task: the worker really does hold a slot, and treating it as failed
 * strands the slot with nobody working it until the deadline expires. The signature is
 * null because the winning attempt's response never came back; the projection records
 * an honest "no signature captured" rather than a fabricated one.
 */
export async function claimTask(client, args, cfg) {
	const s = await sdk();
	try {
		return await withRetry(() => s.claimAgenCTask(client, args), cfg, 'claimTask');
	} catch (err) {
		if (!isAlreadyClaimedError(err)) throw err;
		log.warn('claim already held on-chain, recovered after a lost response', { taskPda: String(args?.taskPda) });
		return { txSignature: null, alreadyClaimed: true };
	}
}

export async function completeTask(client, args, cfg) {
	const s = await sdk();
	return withRetry(() => s.completeAgenCTask(client, args), cfg, 'completeTask');
}

/**
 * Cancel a task and refund its escrowed reward to the creator. Only the creator can
 * do this, and it is the ONLY way an expired bounty gives its money back: the reward
 * sits locked in escrow until someone cancels. Used by the reconcile sweep when a
 * posting passes its deadline unfilled (an Arena nobody raced, a Guild that missed
 * its worker target), so the pool returns instead of being stranded on-chain.
 */
export async function cancelTask(client, args, cfg) {
	const s = await sdk();
	return withRetry(() => s.cancelAgenCTask(client, args), cfg, 'cancelTask');
}

/** Fetch a task's lifecycle summary (timeline + fill + settlement) for reconcile / arena reads. */
export async function getTaskLifecycle(client, taskPda) {
	const s = await sdk();
	return s.getAgenCTaskLifecycle(client, taskPda instanceof PublicKey ? taskPda : new PublicKey(taskPda));
}

/**
 * Read the task's escrow PDA state (native-SOL devnet plumbing): its lamport balance
 * and the rent reserve keeping the account alive. The escrow holds the locked reward
 * until completion releases it; bracketing a completeTask with two reads measures what
 * a Guild contribution actually paid out, a REAL on-chain figure and never a fabricated
 * split. Returns null when the escrow can't be read (RPC hiccup) so the caller degrades
 * to "share settling" rather than guessing.
 */
export async function readEscrowState(client, taskPda) {
	try {
		const t = await tetsuo();
		const pda = taskPda instanceof PublicKey ? taskPda : new PublicKey(taskPda);
		const escrowPda = t.deriveEscrowPda(pda, client.programId);
		const info = await client.connection.getAccountInfo(escrowPda);
		if (!info) return { lamports: 0n, rentReserve: 0n };
		const rentReserve = BigInt(await client.connection.getMinimumBalanceForRentExemption(info.data.length));
		return { lamports: BigInt(info.lamports), rentReserve };
	} catch {
		return null;
	}
}

/**
 * What a single completion actually drew out of escrow as REWARD, in atomic units.
 *
 * The naive `before - after` overstates the last contributor's share: the completion
 * that empties the escrow closes the account, so it also sweeps the rent reserve, which
 * was never reward money (on devnet that read a 0.002 SOL share as 0.003). Subtract the
 * reserve exactly when the account closed. Returns null when either read is missing, so
 * the caller shows "settling" instead of a wrong number.
 */
export function measuredShareAtomic(before, after) {
	if (!before || !after) return null;
	const closed = after.lamports === 0n;
	const drawn = before.lamports - after.lamports - (closed ? before.rentReserve : 0n);
	return drawn > 0n ? drawn : null;
}

export async function formatTaskState(state) {
	const s = await sdk();
	try {
		return s.formatTaskState(state);
	} catch {
		return String(state);
	}
}

/** Generate a fresh 32-byte task id (dispatcher posts unique tasks). */
export async function generateTaskId() {
	const s = await sdk();
	return s.generateAgenCTaskId();
}
