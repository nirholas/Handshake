// Shared helpers for Solana attestation parsing, validation, and indexing.
// Used by the cron crawler and the read endpoints.

import { PublicKey } from '@solana/web3.js';
import { solanaConnection } from './solana/connection.js';
import { signaturesSinceCursor } from './solana/cursor-recovery.js';
import { sql } from './db.js';

export const RPC = {
	mainnet: process.env.SOLANA_RPC_URL        || 'https://api.mainnet-beta.solana.com',
	devnet:  process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
};

export const KIND_MAP = {
	feedback:   'threews.feedback.v1',
	validation: 'threews.validation.v1',
	task:       'threews.task.v1',
	accept:     'threews.accept.v1',
	revoke:     'threews.revoke.v1',
	dispute:    'threews.dispute.v1',
	stake:      'threews.stake.v1',
	unstake:    'threews.unstake.v1',
	review:     'threews.review.v1',
};
export const KINDS_ALL = Object.values(KIND_MAP);
export const MIN_STAKE_LAMPORTS = 1_000_000n; // 0.001 SOL

// Subkind marking a glTF/GLB schema validation (the Solana analog of the EVM
// ValidationRegistry's recordValidation glb-schema attestation). It rides on the
// threews.validation.v1 kind but carries proof_hash/proof_uri instead of task_hash.
export const SUBKIND_GLB_SCHEMA = 'glb-schema';

// Validate a parsed memo payload against its schema. Returns true iff well-formed.
export function validatePayload(p) {
	if (!p || typeof p !== 'object') return false;
	if (p.v !== 1) return false;
	if (typeof p.agent !== 'string' || p.agent.length < 32 || p.agent.length > 44) return false;
	switch (p.kind) {
		case 'threews.feedback.v1':
			return Number.isInteger(p.score) && p.score >= 1 && p.score <= 5;
		case 'threews.validation.v1':
			// Model (glTF/GLB schema) validations carry a content proof hash + URI;
			// task validations carry a task_hash. Either form must declare passed.
			if (p.subkind === SUBKIND_GLB_SCHEMA) {
				return typeof p.proof_hash === 'string' && p.proof_hash.length > 0
					&& typeof p.passed === 'boolean';
			}
			return typeof p.task_hash === 'string' && typeof p.passed === 'boolean';
		case 'threews.task.v1':
			return typeof p.task_id === 'string' && typeof p.scope_hash === 'string';
		case 'threews.accept.v1':
			return typeof p.task_id === 'string';
		case 'threews.revoke.v1':
		case 'threews.dispute.v1':
			return typeof p.target_signature === 'string';
		case 'threews.stake.v1':
			return Number.isInteger(p.score) && p.score >= 1 && p.score <= 5;
		case 'threews.unstake.v1':
			// Retires the conviction a specific stake expressed. `principal` is a
			// decimal lamport STRING, not a number, so a payout larger than
			// Number.MAX_SAFE_INTEGER survives the JSON round-trip intact.
			return typeof p.stake === 'string' && p.stake.length >= 64 && p.stake.length <= 88
				&& typeof p.principal === 'string' && /^\d+$/.test(p.principal);
		case 'threews.review.v1':
			return Number.isInteger(p.rating) && p.rating >= 1 && p.rating <= 5
				&& typeof p.review_id === 'string' && p.review_id.length > 0;
		default:
			return false;
	}
}

// For stake attestations: the lamports the attester (signer) sent in the same tx.
// Returns 0n if no positive transfer from attester is detected.
export function lamportsTransferredFromAttester(tx, attester) {
	if (!tx?.meta || !attester) return 0n;
	const keys = (tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [])
		.map((k) => (typeof k?.toBase58 === 'function' ? k.toBase58() : String(k)));
	const idx = keys.indexOf(attester);
	if (idx < 0) return 0n;
	const pre = BigInt(tx.meta.preBalances?.[idx] ?? 0);
	const post = BigInt(tx.meta.postBalances?.[idx] ?? 0);
	const fee = BigInt(tx.meta.fee ?? 0);
	const delta = pre - post - fee;
	return delta > 0n ? delta : 0n;
}

// Extract the JSON envelope from a confirmed-tx's memo log.
// SPL Memo emits `Program log: Memo (len): "<json>"`.
export function extractMemoPayload(tx) {
	const memoLog = (tx.meta?.logMessages || []).find((l) => l.includes('Program log: Memo'));
	if (!memoLog) return null;
	const start = memoLog.indexOf('"');
	const end   = memoLog.lastIndexOf('"');
	if (start < 0 || end <= start) return null;
	const raw = memoLog.slice(start + 1, end).replace(/\\"/g, '"');
	try { return JSON.parse(raw); } catch { return null; }
}

export function attesterFromTx(tx) {
	return tx.transaction.message.staticAccountKeys?.[0]?.toBase58?.()
		|| tx.transaction.message.accountKeys?.[0]?.toBase58?.()
		|| null;
}

// Crawl recent signatures for one agent and upsert into solana_attestations.
// Returns { scanned, inserted, skipped, cursorReset }.
export async function crawlAgentAttestations({ agentAsset, network, ownerWallet, limit = 200 }) {
	const conn = solanaConnection({ url: RPC[network] || RPC.devnet, commitment: 'confirmed' });
	const agentKey = new PublicKey(agentAsset);

	const [cursor] = await sql`
		select last_signature from solana_attestations_cursor
		where agent_asset = ${agentAsset} and network = ${network}
		limit 1
	`;
	const until = cursor?.last_signature || undefined;

	const { sigs, cursorReset } = await signaturesSinceCursor(conn, agentKey, limit, until);
	if (sigs.length === 0) {
		// A reset cursor must NOT be written back: re-storing the pruned signature
		// would re-arm the exact stall this recovery exists to clear.
		const keep = cursorReset ? null : until || null;
		await sql`
			insert into solana_attestations_cursor (agent_asset, network, last_signature, last_indexed_at)
			values (${agentAsset}, ${network}, ${keep}, now())
			on conflict (agent_asset) do update
				set last_signature = excluded.last_signature, last_indexed_at = now()
		`;
		return { scanned: 0, inserted: 0, skipped: 0, cursorReset };
	}

	const txs = await conn.getTransactions(
		sigs.filter((s) => !s.err).map((s) => s.signature),
		{ maxSupportedTransactionVersion: 0 },
	);

	let inserted = 0, skipped = 0;
	for (let i = 0; i < sigs.length; i++) {
		const s = sigs[i];
		const tx = txs[i];
		if (!tx) { skipped++; continue; }
		const payload = extractMemoPayload(tx);
		if (!payload || payload.agent !== agentAsset) { skipped++; continue; }
		if (!KINDS_ALL.includes(payload.kind)) { skipped++; continue; }

		const attester = attesterFromTx(tx);
		const taskId   = payload.task_id || null;
		const target   = payload.target_signature || null;

		// For stake attestations, fold the lamports actually transferred into the payload
		// and require it to meet the minimum. Unverified if the transfer is below threshold.
		let stakedLamports = 0n;
		if (payload.kind === 'threews.stake.v1') {
			stakedLamports = lamportsTransferredFromAttester(tx, attester);
			payload.lamports = stakedLamports.toString();
		}

		const verified = payload.kind === 'threews.stake.v1'
			? stakedLamports >= MIN_STAKE_LAMPORTS
			: computeVerified({ payload, attester, ownerWallet });

		const result = await sql`
			insert into solana_attestations (
				signature, network, slot, block_time, agent_asset, attester,
				kind, payload, task_id, target_signature, verified
			)
			values (
				${s.signature}, ${network}, ${s.slot},
				${s.blockTime ? new Date(s.blockTime * 1000) : null},
				${agentAsset}, ${attester}, ${payload.kind},
				${JSON.stringify(payload)}::jsonb,
				${taskId}, ${target}, ${verified}
			)
			on conflict (signature) do nothing
			returning signature
		`;
		if (result.length > 0) inserted++;
	}

	// Apply revoke/dispute side-effects: flip flags on target rows.
	await applyRevocations({ agentAsset, ownerWallet });

	await sql`
		insert into solana_attestations_cursor (agent_asset, network, last_signature, last_indexed_at)
		values (${agentAsset}, ${network}, ${sigs[0].signature}, now())
		on conflict (agent_asset) do update
			set last_signature = excluded.last_signature, last_indexed_at = now()
	`;

	return { scanned: sigs.length, inserted, skipped, cursorReset };
}

// Verify rules — applied at index time, can be re-run.
function computeVerified({ payload, attester, ownerWallet }) {
	if (payload.kind === 'threews.accept.v1' || payload.kind === 'threews.dispute.v1') {
		// Only the agent owner can accept tasks or dispute.
		return !!ownerWallet && attester === ownerWallet;
	}
	if (payload.kind === 'threews.revoke.v1') {
		// Verified at apply-time by checking attester matches original.
		return true;
	}
	// feedback/validation/task: structurally valid is enough at this stage.
	// task linkage is computed by the reputation endpoint.
	return validatePayload(payload);
}

async function applyRevocations({ agentAsset, ownerWallet }) {
	// Mark revoked when a revoke attestation exists from the same attester as the target.
	await sql`
		update solana_attestations t set revoked = true
		from solana_attestations r
		where r.agent_asset = ${agentAsset}
		  and r.kind = 'threews.revoke.v1'
		  and r.target_signature = t.signature
		  and r.attester = t.attester
		  and t.revoked = false
	`;
	// Mark disputed when an owner-signed dispute references the target.
	if (ownerWallet) {
		await sql`
			update solana_attestations t set disputed = true
			from solana_attestations d
			where d.agent_asset = ${agentAsset}
			  and d.kind = 'threews.dispute.v1'
			  and d.target_signature = t.signature
			  and d.attester = ${ownerWallet}
			  and t.disputed = false
		`;
	}
}
