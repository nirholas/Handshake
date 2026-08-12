// @ts-check
// Verifiable Proof-of-Custody — server prover.
//
// Snapshots every custodial agent wallet's PUBLIC facts (address, live on-chain
// balance, a commitment to its authorized-state head from the custody ledger),
// builds a Merkle tree over all wallets, persists the epoch + leaves, and anchors
// the Merkle root on-chain as a signed SPL-Memo. Owners later fetch a per-wallet
// inclusion proof and verify it themselves in the browser against the on-chain
// root (src/proof-of-custody/verifier.js) — "don't trust, verify".
//
// The leaf encoding + tree construction live in src/proof-of-custody/merkle.js —
// the SAME module the browser verifier imports — so prover and verifier can never
// drift. This file must never hash a leaf any other way.

import {
	PublicKey,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
import { sendAndConfirm } from './solana/confirm.js';

import { sql } from './db.js';
import { mapPool } from './pool.js';
import { solanaConnection } from './solana/connection.js';
import { RPC } from './solana-attestations.js';
import { loadAttesterKeypair } from './attest-event.js';
import { explorerTxUrl } from './avatar-wallet.js';
import {
	computeLeafHash,
	buildMerkleTree,
	getMerkleProof,
} from '../../src/proof-of-custody/merkle.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ANCHOR_KIND = 'threews.custody.v1';
const TX_TIMEOUT_MS = 20_000;

// Wall-clock budget for the snapshot phase (balance + ledger-head reads). When
// public RPC is rate-limited, the rotating fetch can sweep the whole endpoint
// chain per read — sequential and unbounded, N wallets × sweep once blew clean
// past the function's maxDuration and 504'd the cron (July 2026). Wallets not
// read before the deadline are skipped this epoch exactly like an RPC failure:
// never attested with a guessed balance, picked up again next epoch. Budget +
// TX_TIMEOUT_MS + persistence must stay under the route's maxDuration (120s).
const SNAPSHOT_BUDGET_MS = 80_000;
// Read balances in small concurrent batches: enough to cut wall-clock ~5×,
// small enough not to worsen the very 429s the rotating fetch is dodging.
const BALANCE_READ_CONCURRENCY = 5;

// The balances are read on the network the custodial wallets actually operate on
// (mainnet). The root commitment is a hash with no value, so it is anchored on
// the cheaper devnet by default — still a real, independently-fetchable on-chain
// artifact. Both are overridable for operators who want mainnet anchoring.
export const SNAPSHOT_NETWORK = process.env.CUSTODY_SNAPSHOT_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
export const ANCHOR_NETWORK = process.env.CUSTODY_ANCHOR_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';

// Reconciliation fee tolerance: a withdraw burns ~5k lamports of network fee that
// the ledger's recorded amount does not include, and a SOL "max" sweep leaves a
// rent/fee reserve. Allow a small floor plus per-authorized-event headroom so a
// legitimately-explained drop is never flagged as unexplained.
const RECON_FEE_FLOOR_LAMPORTS = 1_000_000n; // 0.001 SOL
const RECON_FEE_PER_EVENT_LAMPORTS = 50_000n; // generous per-tx fee allowance

function isValidSolAddress(addr) {
	if (typeof addr !== 'string' || addr.length < 32 || addr.length > 44) return false;
	if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) return false;
	try { new PublicKey(addr); return true; } catch { return false; }
}

/** Enumerate every custodial wallet with a syntactically valid Solana address. */
export async function listCustodialWallets() {
	const rows = await sql`
		SELECT id, user_id, meta->>'solana_address' AS address
		FROM agent_identities
		WHERE deleted_at IS NULL
		  AND meta->>'solana_address' IS NOT NULL
		ORDER BY id ASC
	`;
	return rows
		.filter((r) => isValidSolAddress(r.address))
		.map((r) => ({ agentId: r.id, userId: r.user_id, address: r.address }));
}

/**
 * Commitment to a wallet's authorized-state head: the id (and signature) of the
 * most recent custody-ledger event for that agent on the snapshot network, or
 * 'genesis' if the wallet has no recorded custody events yet. Folding the ledger
 * head into the leaf is what ties verification to the movement ledger — any
 * authorized change advances the head, so the leaf changes epoch-over-epoch in a
 * way the owner can map to a logged reason.
 */
export async function ledgerHeadFor(agentId, network = SNAPSHOT_NETWORK) {
	const [row] = await sql`
		SELECT id, signature
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND network = ${network}
		ORDER BY id DESC
		LIMIT 1
	`;
	if (!row) return 'genesis';
	return `${row.id}:${row.signature || ''}`;
}

/** Live on-chain lamports for an address; null on RPC failure (caller decides). */
async function readLamports(conn, address) {
	try {
		return await conn.getBalance(new PublicKey(address), 'confirmed');
	} catch {
		return null;
	}
}

/** Next monotonic epoch number (max + 1, starting at 1). */
async function nextEpoch() {
	const [row] = await sql`SELECT COALESCE(MAX(epoch), 0) AS max FROM custody_attestation_epochs`;
	return BigInt(row?.max ?? 0) + 1n;
}

/**
 * Run one attestation round: snapshot → Merkle → persist → anchor on-chain.
 *
 * Idempotent-ish by monotonic epoch: each call mints a NEW epoch (epochs are a
 * monotonic, append-only log so rollback/replay is detectable). Anchoring is
 * best-effort — if the attester key is unfunded/unset the epoch is still recorded
 * with anchor_status 'pending' and can be anchored later, exactly like the other
 * on-chain payout lanes. Returns a summary.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.anchor=true]  set false to snapshot without an on-chain write
 */
export async function runAttestationEpoch({ anchor = true } = {}) {
	const startedAt = Date.now();
	const wallets = await listCustodialWallets();
	const conn = solanaConnection({ url: RPC[SNAPSHOT_NETWORK] || RPC.mainnet, commitment: 'confirmed' });

	const epoch = await nextEpoch();
	const epochNum = Number(epoch);

	// Build leaves in a stable order (wallets are already ordered by agent id).
	// Reads run in small concurrent batches under a wall-clock budget; results
	// are assembled in the original wallet order so the tree stays deterministic.
	const deadline = startedAt + SNAPSHOT_BUDGET_MS;
	const leaves = [];
	let totalLamports = 0n;
	let rpcFailures = 0;
	// A bounded pool rather than fixed batches: with batching, one slow RPC read
	// held its whole batch's slots idle until it drained. `mapPool` keeps every
	// slot busy and still returns results in wallet order, so the tree stays
	// deterministic.
	const results = await mapPool(wallets, BALANCE_READ_CONCURRENCY, async (w) => {
		// Out of snapshot time — skip the remaining wallets this epoch (same
		// contract as an RPC failure: never attest a balance we didn't read).
		if (Date.now() >= deadline) return null;
		const lamports = await readLamports(conn, w.address);
		// An RPC failure must not silently attest a wrong (zero) balance. Skip
		// the wallet this epoch rather than committing an unverifiable leaf; it
		// is included again next epoch once RPC recovers.
		if (lamports == null) return null;
		const balanceLamports = String(lamports);
		const ledgerHead = await ledgerHeadFor(w.agentId, SNAPSHOT_NETWORK);
		const leafHash = await computeLeafHash({
			agentId: w.agentId,
			address: w.address,
			balanceLamports,
			ledgerHead,
			epoch: epochNum,
		});
		return {
			agentId: w.agentId,
			address: w.address,
			balanceLamports,
			ledgerHead,
			leafHash,
		};
	});
	for (const leaf of results) {
		if (leaf == null) { rpcFailures++; continue; }
		leaves.push(leaf);
		totalLamports += BigInt(leaf.balanceLamports);
	}

	const tree = await buildMerkleTree(leaves.map((l) => l.leafHash));
	const root = tree.root;
	if (!root) {
		// No verifiable wallets this round — record an empty epoch so the chain of
		// epochs stays contiguous and the public page can show "0 wallets".
		await sql`
			INSERT INTO custody_attestation_epochs
				(epoch, network, anchor_network, merkle_root, wallet_count, total_lamports,
				 anchor_status, snapshot_ms)
			VALUES (${String(epoch)}, ${SNAPSHOT_NETWORK}, ${ANCHOR_NETWORK},
				${'0'.repeat(64)}, 0, 0, 'empty', ${Date.now() - startedAt})
		`;
		return { epoch: epochNum, wallet_count: 0, root: null, anchor_status: 'empty', rpc_failures: rpcFailures };
	}

	// Persist the epoch + leaves atomically so a proof read can never see a
	// half-written tree.
	await sql.transaction([
		sql`
			INSERT INTO custody_attestation_epochs
				(epoch, network, anchor_network, merkle_root, wallet_count, total_lamports,
				 anchor_status, snapshot_ms)
			VALUES (${String(epoch)}, ${SNAPSHOT_NETWORK}, ${ANCHOR_NETWORK}, ${root},
				${leaves.length}, ${String(totalLamports)}, 'pending', ${Date.now() - startedAt})
		`,
		...leaves.map((l, i) => sql`
			INSERT INTO custody_attestation_leaves
				(epoch, leaf_index, agent_id, address, balance_lamports, ledger_head, leaf_hash)
			VALUES (${String(epoch)}, ${i}, ${l.agentId}, ${l.address},
				${l.balanceLamports}, ${l.ledgerHead}, ${l.leafHash})
		`),
	]);

	let anchorResult = { status: 'pending', signature: null };
	if (anchor) {
		anchorResult = await anchorRoot({ epoch, root, walletCount: leaves.length });
	}

	return {
		epoch: epochNum,
		wallet_count: leaves.length,
		root,
		total_lamports: String(totalLamports),
		anchor_status: anchorResult.status,
		anchor_signature: anchorResult.signature,
		rpc_failures: rpcFailures,
		snapshot_ms: Date.now() - startedAt,
	};
}

/**
 * Commit a Merkle root on-chain as a signed SPL-Memo and record the signature.
 * Best-effort: a missing/undecodable/unfunded attester key marks the epoch
 * 'anchor_failed' with the reason instead of throwing, so the snapshot still
 * stands and a later run can re-anchor.
 *
 * @returns {Promise<{ status: 'anchored'|'anchor_failed', signature: string|null, error?: string }>}
 */
export async function anchorRoot({ epoch, root, walletCount }) {
	let attester;
	try {
		attester = loadAttesterKeypair();
	} catch (e) {
		await markAnchorFailed(epoch, e.code || 'attester_key_not_configured');
		return { status: 'anchor_failed', signature: null, error: e.code || e.message };
	}

	const payload = {
		v: 1,
		kind: ANCHOR_KIND,
		epoch: Number(epoch),
		root,
		wallet_count: walletCount,
		snapshot_network: SNAPSHOT_NETWORK,
		ts: Math.floor(Date.now() / 1000),
	};
	const conn = solanaConnection({ url: RPC[ANCHOR_NETWORK] || RPC.devnet, commitment: 'confirmed' });
	const ix = new TransactionInstruction({
		programId: MEMO_PROGRAM_ID,
		keys: [{ pubkey: attester.publicKey, isSigner: true, isWritable: false }],
		data: Buffer.from(JSON.stringify(payload), 'utf8'),
	});
	const tx = new Transaction().add(ix);

	let signature;
	try {
		signature = await withTimeout(
			sendAndConfirm(conn, tx, [attester], { commitment: 'confirmed' }),
			TX_TIMEOUT_MS,
		);
	} catch (e) {
		await markAnchorFailed(epoch, (e && e.message) ? String(e.message).slice(0, 300) : 'anchor_send_failed');
		return { status: 'anchor_failed', signature: null, error: 'anchor_send_failed' };
	}

	await sql`
		UPDATE custody_attestation_epochs
		SET anchor_sig = ${signature}, anchor_status = 'anchored',
		    anchor_error = NULL, anchored_at = now()
		WHERE epoch = ${String(epoch)}
	`;
	return { status: 'anchored', signature };
}

async function markAnchorFailed(epoch, reason) {
	await sql`
		UPDATE custody_attestation_epochs
		SET anchor_status = 'anchor_failed', anchor_error = ${String(reason).slice(0, 300)}
		WHERE epoch = ${String(epoch)} AND anchor_status <> 'anchored'
	`;
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`anchor rpc timeout after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function epochRowToPublic(row) {
	if (!row) return null;
	const anchorNet = row.anchor_network || ANCHOR_NETWORK;
	const totalLamports = String(row.total_lamports ?? '0');
	return {
		epoch: Number(row.epoch),
		network: row.network,
		anchor_network: anchorNet,
		merkle_root: row.merkle_root,
		wallet_count: row.wallet_count,
		total_lamports: totalLamports,
		total_sol: Number(BigInt(totalLamports)) / 1e9,
		anchor_sig: row.anchor_sig || null,
		anchor_explorer: row.anchor_sig ? explorerTxUrl(row.anchor_sig, anchorNet) : null,
		anchor_status: row.anchor_status,
		created_at: row.created_at,
		anchored_at: row.anchored_at || null,
	};
}

/** Public, no-auth aggregate for the integrity page — never per-wallet data. */
export async function getPublicIntegrity() {
	const [latest] = await sql`
		SELECT * FROM custody_attestation_epochs
		ORDER BY epoch DESC LIMIT 1
	`;
	const [agg] = await sql`
		SELECT COUNT(*)::int AS epochs, MIN(created_at) AS since,
		       COUNT(*) FILTER (WHERE anchor_status = 'anchored')::int AS anchored
		FROM custody_attestation_epochs
	`;
	const recent = await sql`
		SELECT epoch, network, anchor_network, merkle_root, wallet_count, total_lamports,
		       anchor_sig, anchor_status, created_at, anchored_at
		FROM custody_attestation_epochs
		ORDER BY epoch DESC LIMIT 12
	`;
	return {
		latest: epochRowToPublic(latest),
		epochs_total: agg?.epochs ?? 0,
		epochs_anchored: agg?.anchored ?? 0,
		since: agg?.since ?? null,
		recent: recent.map(epochRowToPublic),
	};
}

/** Public anchor reference for one epoch (lets a verifier cross-check the root). */
export async function getAnchorRef(epoch) {
	const [row] = await sql`
		SELECT * FROM custody_attestation_epochs WHERE epoch = ${String(epoch)}
	`;
	return epochRowToPublic(row);
}

/**
 * Public anchor reference for the newest epoch. One row, one query: the anchor
 * endpoint used to answer `?epoch=latest` out of getPublicIntegrity(), which
 * also runs a full-table aggregate and a 12-row recent list it then discards.
 */
export async function getLatestAnchorRef() {
	const [row] = await sql`
		SELECT * FROM custody_attestation_epochs ORDER BY epoch DESC LIMIT 1
	`;
	return epochRowToPublic(row);
}

/**
 * Owner-gated inclusion proof for one agent's wallet at the latest epoch in which
 * it was attested. Returns the leaf's public fields, the Merkle path to the root,
 * the on-chain anchor reference, and a movement reconciliation against the custody
 * ledger. The caller (api/agents/solana-wallet.js) has already verified ownership.
 *
 * @returns {Promise<object>} { included, ...proof } — included:false if the wallet
 *          has no leaf yet (e.g. provisioned after the last snapshot).
 */
export async function getInclusionProof(agentId) {
	// Latest epoch that actually contains this wallet's leaf.
	const [leafRow] = await sql`
		SELECT epoch, leaf_index, agent_id, address, balance_lamports, ledger_head, leaf_hash
		FROM custody_attestation_leaves
		WHERE agent_id = ${agentId}
		ORDER BY epoch DESC LIMIT 1
	`;
	if (!leafRow) {
		const [anyEpoch] = await sql`SELECT MAX(epoch) AS epoch FROM custody_attestation_epochs`;
		return {
			included: false,
			latest_epoch: anyEpoch?.epoch != null ? Number(anyEpoch.epoch) : null,
			reason: 'no_leaf_yet',
		};
	}

	const epoch = leafRow.epoch;
	const [epochRow] = await sql`SELECT * FROM custody_attestation_epochs WHERE epoch = ${String(epoch)}`;

	// Rebuild the epoch's tree from its stored leaves to emit a verifiable path.
	const all = await sql`
		SELECT leaf_index, leaf_hash FROM custody_attestation_leaves
		WHERE epoch = ${String(epoch)} ORDER BY leaf_index ASC
	`;
	const tree = await buildMerkleTree(all.map((r) => r.leaf_hash));
	const proof = getMerkleProof(tree.layers, leafRow.leaf_index);

	const reconciliation = await reconcile(agentId, epoch, leafRow);

	const anchorNet = epochRow.anchor_network || ANCHOR_NETWORK;
	return {
		included: true,
		epoch: Number(epoch),
		network: epochRow.network,
		anchor: {
			network: anchorNet,
			signature: epochRow.anchor_sig || null,
			explorer: epochRow.anchor_sig ? explorerTxUrl(epochRow.anchor_sig, anchorNet) : null,
			status: epochRow.anchor_status,
			kind: ANCHOR_KIND,
		},
		// Everything the browser needs to recompute the leaf hash itself.
		leaf: {
			agentId,
			address: leafRow.address,
			balanceLamports: String(leafRow.balance_lamports),
			balanceSol: Number(BigInt(String(leafRow.balance_lamports))) / 1e9,
			ledgerHead: leafRow.ledger_head,
			epoch: Number(epoch),
			index: leafRow.leaf_index,
			leafHash: leafRow.leaf_hash,
		},
		proof,
		// The server's claimed root. The verifier recomputes from leaf+proof and
		// then confirms THAT against the on-chain anchor — it never trusts this.
		merkle_root: epochRow.merkle_root,
		wallet_count: epochRow.wallet_count,
		snapshot_at: epochRow.created_at,
		reconciliation,
	};
}

/**
 * Movement reconciliation: does the balance change since the previous epoch map
 * to authorized, logged custody events? Surfaces "no unexplained movements" as a
 * verifiable claim and loudly flags an outflow the ledger can't account for.
 */
export async function reconcile(agentId, epoch, currentLeaf) {
	const [prev] = await sql`
		SELECT epoch, balance_lamports FROM custody_attestation_leaves
		WHERE agent_id = ${agentId} AND epoch < ${String(epoch)}
		ORDER BY epoch DESC LIMIT 1
	`;
	const currentBalance = BigInt(String(currentLeaf.balance_lamports));

	if (!prev) {
		return {
			status: 'baseline',
			human: 'First attested epoch for this wallet — nothing to reconcile against yet. Future epochs will check every balance change against your authorized custody events.',
			current_balance_lamports: String(currentBalance),
		};
	}

	const prevBalance = BigInt(String(prev.balance_lamports));
	const delta = currentBalance - prevBalance;

	// Window between the two epochs' snapshots.
	const [bounds] = await sql`
		SELECT
			(SELECT created_at FROM custody_attestation_epochs WHERE epoch = ${String(prev.epoch)}) AS prev_at,
			(SELECT created_at FROM custody_attestation_epochs WHERE epoch = ${String(epoch)}) AS cur_at
	`;
	const events = await sql`
		SELECT id, event_type, category, amount_lamports, usd, signature, reason, created_at
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${SNAPSHOT_NETWORK}
		  AND event_type IN ('withdraw', 'spend')
		  AND asset = 'SOL'
		  AND amount_lamports IS NOT NULL
		  AND created_at > ${bounds.prev_at}
		  AND created_at <= ${bounds.cur_at}
		ORDER BY id ASC
	`;
	let authorizedOutflow = 0n;
	for (const e of events) authorizedOutflow += BigInt(String(e.amount_lamports));
	const tolerance = RECON_FEE_FLOOR_LAMPORTS + BigInt(events.length) * RECON_FEE_PER_EVENT_LAMPORTS;

	const summarized = events.map((e) => ({
		id: String(e.id),
		event_type: e.event_type,
		category: e.category,
		amount_lamports: String(e.amount_lamports),
		amount_sol: Number(BigInt(String(e.amount_lamports))) / 1e9,
		reason: e.reason,
		signature: e.signature,
		explorer: e.signature ? explorerTxUrl(e.signature, SNAPSHOT_NETWORK) : null,
		created_at: e.created_at,
	}));

	if (delta >= 0n) {
		// Balance flat or up. Incoming deposits are external (not in the custody
		// ledger), so an increase is expected and benign; there is no unexplained
		// OUTFLOW, which is the property we attest.
		return {
			status: 'reconciled',
			prev_epoch: Number(prev.epoch),
			prev_balance_lamports: String(prevBalance),
			current_balance_lamports: String(currentBalance),
			delta_lamports: String(delta),
			delta_sol: Number(delta) / 1e9,
			authorized_outflow_lamports: String(authorizedOutflow),
			authorized_events: summarized,
			unexplained_lamports: '0',
			human: delta === 0n
				? 'Balance unchanged since the previous epoch. No movement, nothing unexplained.'
				: `Balance increased by ${(Number(delta) / 1e9).toFixed(6)} SOL — an incoming deposit. Deposits are external to custody and never move funds out, so there is nothing to authorize.`,
		};
	}

	const outflow = -delta;
	const unexplained = outflow > authorizedOutflow + tolerance ? outflow - authorizedOutflow : 0n;
	const reconciled = unexplained === 0n;
	return {
		status: reconciled ? 'reconciled' : 'unexplained',
		prev_epoch: Number(prev.epoch),
		prev_balance_lamports: String(prevBalance),
		current_balance_lamports: String(currentBalance),
		delta_lamports: String(delta),
		delta_sol: Number(delta) / 1e9,
		authorized_outflow_lamports: String(authorizedOutflow),
		authorized_events: summarized,
		unexplained_lamports: String(unexplained),
		human: reconciled
			? `Balance fell by ${(Number(outflow) / 1e9).toFixed(6)} SOL, fully explained by ${summarized.length} authorized custody event${summarized.length === 1 ? '' : 's'} (withdraw/spend) plus network fees. No unexplained movement.`
			: `⚠ Balance fell by ${(Number(outflow) / 1e9).toFixed(6)} SOL but only ${(Number(authorizedOutflow) / 1e9).toFixed(6)} SOL is accounted for by authorized custody events. ${(Number(unexplained) / 1e9).toFixed(6)} SOL of outflow is UNEXPLAINED — this should never happen and warrants investigation.`,
	};
}
