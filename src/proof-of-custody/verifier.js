/**
 * Proof-of-Custody — independent, in-browser verifier.
 *
 * Given a per-owner inclusion proof (from GET /api/agents/:id/solana/proof) this
 * verifies custody integrity WITHOUT trusting the three.ws server for the
 * verification itself:
 *   1. recompute the leaf hash from the public leaf fields,
 *   2. fold the Merkle path to a computed root,
 *   3. fetch the anchor transaction straight off-chain from a PUBLIC Solana RPC
 *      and read the root the platform actually committed,
 *   4. confirm computed root === on-chain root.
 *
 * It fails honestly and specifically: each step reports pass/fail with a reason,
 * and a failed anchor fetch is reported as "unverified", never "verified". The
 * leaf hashing + path folding reuse src/proof-of-custody/merkle.js — the exact
 * module the server prover used — so the two sides cannot drift.
 */

import { computeLeafHash, computeRootFromProof } from './merkle.js';

// Public, keyless RPC endpoints with permissive CORS, tried in order. These are
// deliberately NOT three.ws-operated for the on-chain read, so the verification
// does not route through our infrastructure. The /api/solana-rpc proxy is a last
// resort only if every public endpoint is unreachable from the browser.
const PUBLIC_RPC = {
	devnet: ['https://api.devnet.solana.com'],
	mainnet: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
};

// Per-endpoint deadline. Generous enough for a cold getTransaction on a free
// public node, short enough that walking all three endpoints stays inside the
// patience of someone watching a verification badge.
const RPC_ATTEMPT_TIMEOUT_MS = 10_000;

function rpcEndpoints(network) {
	const base = PUBLIC_RPC[network] || PUBLIC_RPC.mainnet;
	return [...base, `/api/solana-rpc?network=${encodeURIComponent(network)}`];
}

/** Fetch a confirmed transaction's parsed form from a public RPC, with failover. */
async function fetchTransaction(signature, network) {
	const body = {
		jsonrpc: '2.0',
		id: 1,
		method: 'getTransaction',
		params: [signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' }],
	};
	let lastErr = null;
	for (const url of rpcEndpoints(network)) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				// Without a per-attempt deadline the ordered endpoint list is
				// decorative: the first host to accept the connection and never
				// answer holds the whole chain behind it, and the verifier sits on
				// "Checking the chain…" instead of moving to the next endpoint.
				signal: AbortSignal.timeout(RPC_ATTEMPT_TIMEOUT_MS),
			});
			if (!res.ok) { lastErr = new Error(`rpc ${res.status}`); continue; }
			const j = await res.json();
			if (j.error) { lastErr = new Error(j.error.message || 'rpc error'); continue; }
			if (j.result) return { tx: j.result, endpoint: url };
			// result null = not found yet on this endpoint; try the next.
			lastErr = new Error('transaction not found');
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr || new Error('all RPC endpoints failed');
}

/** Extract the first SPL-Memo string from a parsed transaction. */
function extractMemo(tx) {
	const msg = tx?.transaction?.message;
	const instructions = msg?.instructions || [];
	for (const ix of instructions) {
		if (ix?.program === 'spl-memo' && typeof ix.parsed === 'string') return ix.parsed;
		// Some RPCs surface the memo string directly on `parsed` for the memo program id.
		if (ix?.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' && typeof ix.parsed === 'string') {
			return ix.parsed;
		}
	}
	// Fallback: parse the memo program log line.
	for (const line of tx?.meta?.logMessages || []) {
		const m = /Program log: Memo \(len \d+\): "(.*)"$/.exec(line);
		if (m) return m[1].replace(/\\"/g, '"');
	}
	return null;
}

/**
 * Read the committed Merkle root straight off the chain for an anchor signature.
 * Public + dependency-light — the /integrity page uses it to let anyone confirm
 * the platform's latest root on-chain without trusting our API.
 *
 * @returns {Promise<{ epoch: number, root: string, walletCount: number|null, endpoint: string }>}
 */
export async function readOnchainAnchor(signature, network, opts = {}) {
	const fetchTx = opts.fetchTx || fetchTransaction;
	const { tx, endpoint } = await fetchTx(signature, network);
	const memo = extractMemo(tx);
	if (!memo) throw new Error('no memo found in the anchor transaction');
	const payload = JSON.parse(memo);
	if (payload.kind !== 'threews.custody.v1') throw new Error('anchor memo is not a custody attestation');
	return {
		epoch: Number(payload.epoch),
		root: String(payload.root || '').toLowerCase(),
		walletCount: payload.wallet_count != null ? Number(payload.wallet_count) : null,
		endpoint,
	};
}

/**
 * Verify an inclusion proof end-to-end.
 *
 * @param {object} proof  the `data` object from GET /api/agents/:id/solana/proof
 * @param {object} [opts]
 * @param {(sig:string, net:string)=>Promise<{tx:object,endpoint:string}>} [opts.fetchTx]
 *        override the on-chain fetch (used by tests).
 * @returns {Promise<{ verified: boolean, steps: object[], summary: string,
 *                      onchain_root: string|null, computed_root: string|null }>}
 */
export async function verifyInclusionProof(proof, opts = {}) {
	const steps = [];
	const add = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };
	const done = (verified, summary, extra = {}) => ({
		verified, steps, summary, onchain_root: null, computed_root: null, ...extra,
	});

	if (!proof || proof.included === false) {
		add('proof_present', false, proof?.reason === 'no_leaf_yet'
			? 'This wallet has not been included in an attestation epoch yet — it was likely provisioned after the last snapshot. It will be covered in the next epoch.'
			: 'No inclusion proof was returned.');
		return done(false, 'No proof to verify yet.');
	}

	// 1. Recompute the leaf hash from the public fields.
	let computedLeaf;
	try {
		computedLeaf = await computeLeafHash({
			agentId: proof.leaf.agentId,
			address: proof.leaf.address,
			balanceLamports: proof.leaf.balanceLamports,
			ledgerHead: proof.leaf.ledgerHead,
			epoch: proof.leaf.epoch,
		});
	} catch (e) {
		add('leaf_recompute', false, `Could not recompute the leaf: ${e.message}`);
		return done(false, 'Leaf could not be recomputed from the public data.');
	}
	const leafMatches = computedLeaf === String(proof.leaf.leafHash).toLowerCase();
	add('leaf_recompute', leafMatches, leafMatches
		? 'Recomputed the leaf hash from your wallet address, balance, ledger head and epoch — it matches the served leaf.'
		: 'The leaf hash recomputed from the public data does NOT match the served leaf hash.');
	if (!leafMatches) return done(false, 'Leaf hash mismatch — the served leaf does not commit to the stated data.');

	// 2. Fold the Merkle path to a computed root.
	let computedRoot;
	try {
		computedRoot = await computeRootFromProof(computedLeaf, proof.proof || []);
	} catch (e) {
		add('merkle_path', false, `Could not walk the Merkle path: ${e.message}`);
		return done(false, 'Merkle path could not be evaluated.');
	}
	const rootMatchesServed = computedRoot === String(proof.merkle_root).toLowerCase();
	add('merkle_path', rootMatchesServed, rootMatchesServed
		? `Walked the ${proof.proof?.length || 0}-step Merkle path from your leaf to the root — it matches the epoch root.`
		: 'Walking the Merkle path did NOT reproduce the served root.');
	if (!rootMatchesServed) {
		return done(false, 'Merkle path does not lead to the stated root.', { computed_root: computedRoot });
	}

	// 3. Fetch the on-chain anchor and read the committed root.
	const anchor = proof.anchor || {};
	if (!anchor.signature) {
		add('onchain_anchor', false, anchor.status === 'pending'
			? 'The Merkle proof is internally valid, but this epoch has not been anchored on-chain yet. Verification is incomplete until the root is committed.'
			: `This epoch was not anchored on-chain (status: ${anchor.status || 'unknown'}). Treating as UNVERIFIED.`);
		return done(false, 'Awaiting on-chain anchor — proof is internally consistent but not yet verifiable against the chain.', { computed_root: computedRoot });
	}

	let onchainRoot = null;
	let endpoint = null;
	try {
		const fetchTx = opts.fetchTx || fetchTransaction;
		const { tx, endpoint: ep } = await fetchTx(anchor.signature, anchor.network);
		endpoint = ep;
		const memo = extractMemo(tx);
		if (!memo) throw new Error('no memo found in the anchor transaction');
		const payload = JSON.parse(memo);
		if (payload.kind !== 'threews.custody.v1') throw new Error('anchor memo is not a custody attestation');
		onchainRoot = String(payload.root || '').toLowerCase();
		if (Number(payload.epoch) !== Number(proof.epoch)) {
			add('onchain_anchor', false, `On-chain anchor is for epoch ${payload.epoch}, not epoch ${proof.epoch}.`);
			return done(false, 'On-chain anchor epoch does not match the proof epoch.', { computed_root: computedRoot, onchain_root: onchainRoot });
		}
	} catch (e) {
		add('onchain_anchor', false, `Could not read the anchor from the chain (${e.message}). Treating as UNVERIFIED rather than trusting the server.`);
		return done(false, 'Could not independently read the on-chain anchor — unverified.', { computed_root: computedRoot });
	}
	add('onchain_anchor', true, `Read the anchor transaction directly from a public Solana RPC (${endpoint}) — it commits epoch ${proof.epoch}.`);

	// 4. The decisive comparison: computed root vs on-chain root.
	const finalMatch = computedRoot === onchainRoot;
	add('root_match', finalMatch, finalMatch
		? 'The root you computed from your own leaf matches the root committed on-chain. Custody is cryptographically verified.'
		: 'The root computed from your leaf does NOT match the root committed on-chain. DO NOT TRUST.');

	return done(finalMatch,
		finalMatch
			? `Custody verified on-chain (epoch ${proof.epoch}).`
			: 'Verification FAILED: on-chain root does not match.',
		{ computed_root: computedRoot, onchain_root: onchainRoot });
}
