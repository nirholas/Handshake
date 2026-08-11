/**
 * Solana on-chain attestations for three.ws agents.
 *
 * ERC-8004 analog (Reputation + Validation registries) without deploying any
 * custom program. Each attestation is a signed SPL Memo transaction whose
 * memo payload is a JSON envelope, and which references the agent's Metaplex
 * Core asset pubkey as a read-only account so `getSignaturesForAddress(agent)`
 * returns every attestation about it.
 *
 * Schemas:
 *   { v: 1, kind: 'threews.feedback.v1',
 *     agent: <asset_pubkey>, score: 1..5, task_id?: string, uri?: string }
 *   { v: 1, kind: 'threews.validation.v1',
 *     agent: <asset_pubkey>, task_hash: string, passed: boolean, uri?: string }
 *
 * Identity itself is the existing Metaplex Core NFT (see solana.js).
 */

import { loadSolanaWeb3 } from './peer.js';
import { detectSolanaProvider } from './solana.js';

const MEMO_PROGRAM_ADDRESS = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const RPC = {
	mainnet: 'https://api.mainnet-beta.solana.com',
	devnet:  'https://api.devnet.solana.com',
};

const MAX_MEMO_BYTES = 566; // SPL Memo per-tx upper bound; we stay well under.

async function buildMemoIx(payload, agentAsset) {
	const bytes = new TextEncoder().encode(payload);
	if (bytes.length > MAX_MEMO_BYTES) throw new Error('attestation payload too large');
	const { PublicKey, TransactionInstruction } = await loadSolanaWeb3('Solana attestations');
	return new TransactionInstruction({
		programId: new PublicKey(MEMO_PROGRAM_ADDRESS),
		// Reference the agent asset pubkey as a (non-signer, read-only) key so
		// it shows up under getSignaturesForAddress(agent).
		keys: [{ pubkey: new PublicKey(agentAsset), isSigner: false, isWritable: false }],
		data: Buffer.from(bytes),
	});
}

async function signAndSend({ network, preferred, ix, feePayer }) {
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	if (!provider.publicKey) await provider.connect();

	const { Connection, Transaction } = await loadSolanaWeb3('Solana attestations');
	const conn = new Connection(RPC[network] || RPC.devnet, 'confirmed');
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');

	const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(ix);
	const { signature } = await provider.signAndSendTransaction(tx);
	const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
	// A confirmed-but-reverted tx carries its error in value.err rather than
	// throwing — surface it so a failed attestation never looks like a success.
	if (conf?.value?.err) {
		throw new Error(`attestation tx ${signature} reverted on-chain: ${JSON.stringify(conf.value.err)}`);
	}
	return signature;
}

/**
 * Issue a feedback attestation about a Solana-registered agent.
 *
 * @param {object} opts
 * @param {string} opts.agentAsset    Metaplex Core asset pubkey (the agent's identity)
 * @param {number} opts.score         1..5
 * @param {string} [opts.taskId]
 * @param {string} [opts.uri]         Off-chain detail (Arweave/IPFS/HTTPS)
 * @param {'mainnet'|'devnet'} [opts.network='devnet']
 * @param {string} [opts.preferred]
 * @returns {Promise<{signature: string, memo: object}>}
 */
export async function attestFeedback({
	agentAsset, score, taskId, uri,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset) throw new Error('agentAsset required');
	if (!(score >= 1 && score <= 5)) throw new Error('score must be 1..5');

	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();

	const memo = {
		v: 1, kind: 'threews.feedback.v1',
		agent: agentAsset, score,
		...(taskId ? { task_id: taskId } : {}),
		...(uri ? { uri } : {}),
		ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Issue a validation attestation (validator vouching for or rejecting agent work).
 *
 * @param {object} opts
 * @param {string} opts.agentAsset
 * @param {string} opts.taskHash       Hash of the task input/output being validated
 * @param {boolean} opts.passed
 * @param {string} [opts.uri]
 * @param {'mainnet'|'devnet'} [opts.network='devnet']
 * @param {string} [opts.preferred]
 */
export async function attestValidation({
	agentAsset, taskHash, passed, uri,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset) throw new Error('agentAsset required');
	if (!taskHash) throw new Error('taskHash required');

	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();

	const memo = {
		v: 1, kind: 'threews.validation.v1',
		agent: agentAsset, task_hash: taskHash, passed: !!passed,
		...(uri ? { uri } : {}),
		ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Client posts a task offer to an agent. Counterpart to acceptTask.
 */
export async function createTask({
	agentAsset, taskId, scopeHash, uri,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset || !taskId || !scopeHash) throw new Error('agentAsset, taskId, scopeHash required');
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();
	const memo = {
		v: 1, kind: 'threews.task.v1', agent: agentAsset,
		task_id: taskId, scope_hash: scopeHash,
		...(uri ? { uri } : {}), ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Agent owner accepts a task. Required for matching feedback to be "verified".
 * Must be signed by the wallet that owns the agent NFT.
 */
export async function acceptTask({
	agentAsset, taskId,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset || !taskId) throw new Error('agentAsset, taskId required');
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();
	const memo = {
		v: 1, kind: 'threews.accept.v1', agent: agentAsset, task_id: taskId,
		ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Revoke one of YOUR OWN previous attestations. Indexer flips the original's
 * `revoked` bit only if the revoke is signed by the same attester.
 */
export async function attestRevoke({
	agentAsset, targetSignature, reason,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset || !targetSignature) throw new Error('agentAsset, targetSignature required');
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();
	const memo = {
		v: 1, kind: 'threews.revoke.v1', agent: agentAsset,
		target_signature: targetSignature,
		...(reason ? { reason } : {}), ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Agent owner disputes someone else's attestation. Doesn't delete; flags
 * `disputed=true` in the indexer.
 */
export async function attestDispute({
	agentAsset, targetSignature, reason, uri,
	network = 'devnet', preferred = null,
} = {}) {
	if (!agentAsset || !targetSignature) throw new Error('agentAsset, targetSignature required');
	const provider = detectSolanaProvider(preferred);
	if (!provider) throw new Error('No Solana wallet detected');
	const { publicKey } = await provider.connect();
	const memo = {
		v: 1, kind: 'threews.dispute.v1', agent: agentAsset,
		target_signature: targetSignature,
		...(reason ? { reason } : {}),
		...(uri ? { uri } : {}),
		ts: Math.floor(Date.now() / 1000),
	};
	const ix = await buildMemoIx(JSON.stringify(memo), agentAsset);
	const signature = await signAndSend({ network, preferred, ix, feePayer: publicKey });
	return { signature, memo };
}

/**
 * Fetch indexed attestations for an agent from the three.ws indexer.
 * Prefer this over `listAttestations` (RPC) — sub-100ms vs seconds, and
 * includes verified/disputed/revoked flags.
 *
 * @param {object} opts
 * @param {string} opts.agentAsset
 * @param {string} [opts.kind='all']
 * @param {string} [opts.network='devnet']
 * @param {string} [opts.apiOrigin]   Defaults to current origin
 */
export async function fetchAttestations({
	agentAsset, kind = 'all', network = 'devnet', apiOrigin = '',
} = {}) {
	const u = `${apiOrigin}/api/agents/solana-attestations?asset=${encodeURIComponent(agentAsset)}&kind=${encodeURIComponent(kind)}&network=${network}`;
	const res = await fetch(u);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error_description || 'fetch failed');
	return data;
}

/**
 * Fetch computed reputation summary (verified vs unverified scores, disputes,
 * task acceptance counts) from the three.ws indexer.
 */
export async function fetchReputation({
	agentAsset, network = 'devnet', apiOrigin = '',
} = {}) {
	const u = `${apiOrigin}/api/agents/solana-reputation?asset=${encodeURIComponent(agentAsset)}&network=${network}`;
	const res = await fetch(u);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error_description || 'fetch failed');
	return data;
}

/**
 * Read attestations about an agent directly from RPC.
 *
 * Walks recent signatures for the agent asset pubkey, fetches each transaction,
 * extracts the memo log, and filters by schema kind.
 *
 * @param {object} opts
 * @param {string} opts.agentAsset
 * @param {'feedback'|'validation'|'all'} [opts.kind='all']
 * @param {number} [opts.limit=100]
 * @param {'mainnet'|'devnet'} [opts.network='devnet']
 * @returns {Promise<Array<{signature: string, slot: number, attester: string, memo: object}>>}
 */
export async function listAttestations({
	agentAsset, kind = 'all', limit = 100, network = 'devnet',
} = {}) {
	const { Connection, PublicKey } = await loadSolanaWeb3('listAttestations()');
	const conn = new Connection(RPC[network] || RPC.devnet, 'confirmed');
	const sigs = await conn.getSignaturesForAddress(new PublicKey(agentAsset), { limit });
	const wantKind = kind === 'all' ? null
		: kind === 'feedback' ? 'threews.feedback.v1'
		: kind === 'validation' ? 'threews.validation.v1' : null;

	const results = [];
	for (const s of sigs) {
		if (s.err) continue;
		const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
		if (!tx) continue;
		const memoLog = (tx.meta?.logMessages || []).find((l) => l.includes('Program log: Memo'));
		const jsonMatch = memoLog?.match(/"(\{.*\})"/);
		if (!jsonMatch) continue;
		let memo;
		try { memo = JSON.parse(jsonMatch[1].replace(/\\"/g, '"')); } catch { continue; }
		if (memo.agent !== agentAsset) continue;
		if (wantKind && memo.kind !== wantKind) continue;
		const attester = tx.transaction.message.staticAccountKeys?.[0]?.toBase58?.()
			|| tx.transaction.message.accountKeys?.[0]?.toBase58?.();
		results.push({ signature: s.signature, slot: s.slot, attester, memo });
	}
	return results;
}
