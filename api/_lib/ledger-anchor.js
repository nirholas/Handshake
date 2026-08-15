/**
 * On-chain anchor for the Reasoning Ledger (server-side).
 *
 * Because each agent's ledger is a hash chain, the head entry_hash commits to the
 * ENTIRE prefix — so anchoring the head is a Merkle-root-equivalent tamper proof.
 * This writes a signed SPL-Memo (kind `threews.ledger.v1`) committing an agent's
 * chain head to Solana, and records it in `ledger_anchors`. Anyone can then prove
 * the history wasn't edited: GET /api/ledger/verify/:agentId recomputes the chain
 * and checks its head against this on-chain commitment.
 *
 * Best-effort by contract, exactly like trader-score-attest.js:
 *   - No funded attester key (ATTEST_AGENT_SECRET_KEY) → the commitment is still
 *     recorded locally with status 'pending' (no signature); the cron reports it
 *     rather than failing. The cryptographic tamper-evidence of the chain holds
 *     regardless; only the independent on-chain timestamp is deferred.
 *   - Idempotent per (agent_id, head_hash): re-anchoring the same head returns the
 *     existing row instead of broadcasting a duplicate.
 */

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { sendAndConfirm } from './solana/confirm.js';

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { RPC } from './solana-attestations.js';
import { loadAttesterKeypair } from './attest-event.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const LEDGER_KIND = 'threews.ledger.v1';
const TX_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`rpc timeout after ${ms}ms`), { code: 'RPC_TIMEOUT' })), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Anchor an agent's current chain head on-chain (best-effort).
 *
 * @param {object} p
 * @param {string} p.agentId
 * @param {'mainnet'|'devnet'} p.network
 * @param {string} p.headHash      entry_hash of the chain head (commits the whole chain)
 * @param {number} p.throughSeq    seq of the head entry
 * @param {number} p.entryCount    total entries committed
 * @param {number} [p.now]
 * @returns {Promise<{status:'anchored'|'deduped'|'pending'|'failed', signature:string|null, detail?:string}>}
 *
 * `pending` means the commitment was recorded locally because no attester key is
 * configured (a documented degraded mode). `failed` means the broadcast itself
 * was rejected, which is a real outage of the on-chain leg: same value in the
 * `ledger_anchors` row, so the caller can tell the two apart and alert on one.
 */
export async function anchorLedgerHead({ agentId, network = 'mainnet', headHash, throughSeq, entryCount, now = Date.now() }) {
	if (!agentId || !headHash) throw new Error('anchorLedgerHead: agentId and headHash required');

	// Idempotent: this exact head already committed?
	const [existing] = await sql`
		select status, signature from ledger_anchors
		where agent_id = ${agentId} and head_hash = ${headHash} limit 1
	`;
	if (existing && existing.status === 'anchored') {
		return { status: 'deduped', signature: existing.signature };
	}

	// Load the funded attester. Missing key → record the commitment locally as
	// pending; the chain's tamper-evidence does not depend on the on-chain write.
	let attester;
	try {
		attester = loadAttesterKeypair();
	} catch {
		await upsertAnchor({ agentId, network, throughSeq, headHash, entryCount, status: 'pending', detail: 'attester_key_not_configured', signature: null });
		return { status: 'pending', signature: null, detail: 'attester_key_not_configured' };
	}

	const payload = {
		v: 1,
		kind: LEDGER_KIND,
		agent_id: agentId,
		head_hash: headHash,
		through_seq: throughSeq,
		entry_count: entryCount,
		network,
		ts: Math.floor(now / 1000),
		source: 'threews.reasoning-ledger',
	};

	const conn = solanaConnection({ url: RPC[network] || RPC.devnet, commitment: 'confirmed' });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [{ pubkey: attester.publicKey, isSigner: true, isWritable: false }],
		data: Buffer.from(JSON.stringify(payload), 'utf8'),
	});

	let signature;
	try {
		signature = await withTimeout(
			sendAndConfirm(conn, new Transaction().add(ix), [attester], { commitment: 'confirmed' }),
			TX_TIMEOUT_MS,
		);
	} catch (err) {
		await upsertAnchor({ agentId, network, throughSeq, headHash, entryCount, status: 'failed', detail: `record_failed: ${err.message}`.slice(0, 280), signature: null });
		// Report the broadcast failure as `failed`, matching the row just written.
		// It used to come back as `pending`, which made an unfunded attester wallet
		// (every send rejected with "found no record of a prior credit") read as the
		// benign no-key-configured path: the cron logged a healthy 200 for months
		// while not one head ever reached the chain.
		return { status: 'failed', signature: null, detail: `record_failed: ${err.message}` };
	}

	await upsertAnchor({ agentId, network, throughSeq, headHash, entryCount, status: 'anchored', detail: null, signature });
	return { status: 'anchored', signature };
}

async function upsertAnchor({ agentId, network, throughSeq, headHash, entryCount, status, detail, signature }) {
	await sql`
		insert into ledger_anchors (agent_id, network, through_seq, head_hash, entry_count, signature, status, detail, anchored_at)
		values (${agentId}, ${network}, ${throughSeq}, ${headHash}, ${entryCount}, ${signature}, ${status}, ${detail},
		        ${status === 'anchored' ? new Date().toISOString() : null})
		on conflict (agent_id, head_hash) do update set
			status = excluded.status,
			signature = coalesce(excluded.signature, ledger_anchors.signature),
			detail = excluded.detail,
			through_seq = excluded.through_seq,
			entry_count = excluded.entry_count,
			anchored_at = coalesce(excluded.anchored_at, ledger_anchors.anchored_at)
	`;
}

/** Latest anchor row for an agent (any status), newest by through_seq. */
export async function latestAnchor(agentId) {
	const [row] = await sql`
		select network, through_seq, head_hash, entry_count, signature, status, detail, anchored_at
		from ledger_anchors where agent_id = ${agentId}
		order by through_seq desc, created_at desc limit 1
	`;
	return row || null;
}

/** Latest successfully-anchored row for an agent. */
export async function latestAnchoredAnchor(agentId) {
	const [row] = await sql`
		select network, through_seq, head_hash, entry_count, signature, status, anchored_at
		from ledger_anchors where agent_id = ${agentId} and status = 'anchored'
		order by through_seq desc limit 1
	`;
	return row || null;
}

export { LEDGER_KIND };
