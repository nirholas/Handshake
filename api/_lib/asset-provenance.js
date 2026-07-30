/**
 * Signed provenance for generated/minted 3D assets — writes to the SAME
 * append-only `agent_actions` ledger that `@three-ws/provenance-mcp` reads and
 * verifies (api/agent-actions.js, packages/provenance-mcp). Every asset this
 * platform produces gets a durable, cryptographically-verifiable record of who
 * made it, from what prompt/model, and (for a remix/mint) its parent lineage —
 * the "creator, prompt, parent lineage, model hash, timestamp" provenance line
 * from the roadmap campaign, work order 08 (crypto-native creation; retired,
 * see git history).
 *
 * Canonicalization + signing here is a byte-for-byte mirror of
 * packages/provenance-mcp/src/lib/signing.js (same ACTION_SIG_VERSION, same
 * canonical form, same ERC-191 message framing) — the same relationship
 * api/_lib/brain-sign.js already has with the memory-ledger's client-side
 * verification primitive. A record this module writes verifies identically
 * through `query_action` / `list_agent_actions` (provenance-mcp) or any
 * third-party offline `ecrecover` check. Packages are intentionally NOT
 * cross-imported across the workspace boundary (a published npm package must
 * not couple its versioning to the platform's serverless deploys) — mirroring
 * is the established pattern here, not an oversight.
 *
 * Every write is best-effort: an agent with no provisioned EVM wallet gets an
 * honest `unsigned` record (never blocks the mint/generation it accompanies),
 * matching the "unsigned ≠ failure" contract in packages/provenance-mcp/README.md.
 */

import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';

import { sql } from './db.js';
import { loadAgentSigner } from './brain-sign.js';

// Same domain-separating prefix as packages/provenance-mcp/src/lib/signing.js —
// do not change independently; bump both together on a breaking format change.
export const ACTION_SIG_VERSION = 'threews:action:v1';

/** Deterministic, recursive JSON serialization with sorted object keys. */
export function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',');
	return `{${body}}`;
}

/** Canonical signable form of an action — mirrors provenance-mcp's canonicalizeAction. */
export function canonicalizeAction(action) {
	const agentId = action.agent_id ?? action.agentId ?? '';
	const type = action.type ?? '';
	const payload = action.payload ?? {};
	const sourceSkill = action.source_skill ?? action.sourceSkill ?? null;
	return stableStringify({
		v: ACTION_SIG_VERSION,
		agentId: String(agentId),
		type: String(type),
		payload,
		sourceSkill: sourceSkill == null ? null : String(sourceSkill),
	});
}

export function actionDigest(action) {
	return createHash('sha256').update(canonicalizeAction(action)).digest('hex');
}

function signMessageBody(digest) {
	return `${ACTION_SIG_VERSION}:${digest}`;
}

/** Pure crypto — the offline check any third party runs to trust a written action. */
export function verifyActionSignature(action, { signature, signer_address } = {}) {
	const digest = actionDigest(action);
	if (!signature || !signer_address) return { valid: false, recovered: null, digest, reason: 'unsigned' };
	let recovered = null;
	try {
		recovered = verifyMessage(signMessageBody(digest), signature);
	} catch {
		return { valid: false, recovered: null, digest, reason: 'malformed_signature' };
	}
	const valid = recovered.toLowerCase() === String(signer_address).toLowerCase();
	return { valid, recovered, digest, reason: valid ? 'ok' : 'signer_mismatch' };
}

/**
 * Append a signed (best-effort) provenance record to the agent_actions ledger.
 * Never throws — a signing or DB failure is caught and reported in the return
 * shape so a provenance write can never break the asset flow it accompanies.
 *
 * @param {object} p
 * @param {string} p.agentId       owning agent (agent_identities.id) — required;
 *   callers with no resolved agent should skip the call rather than pass one.
 * @param {string} p.type          ledger action type (<=64 chars, e.g. "tokenize_3d.mint")
 * @param {object} p.payload       provenance payload (creator, prompt, model, lineage…)
 * @param {string} [p.sourceSkill]
 * @returns {Promise<{ recorded:boolean, signed:boolean, action_id:string|null,
 *   signer_address:string|null, digest:string|null, reason?:string }>}
 */
export async function writeAssetProvenance({ agentId, type, payload, sourceSkill = 'tokenize-3d' }) {
	if (!agentId) {
		return { recorded: false, signed: false, action_id: null, signer_address: null, digest: null, reason: 'no_agent' };
	}

	const action = { agentId, type: String(type).slice(0, 64), payload: payload || {}, sourceSkill };
	const digest = actionDigest(action);

	let signature = null;
	let signerAddress = null;
	try {
		const signer = await loadAgentSigner(agentId);
		if (signer) {
			signature = await new Wallet(signer.privKey).signMessage(signMessageBody(digest));
			signerAddress = signer.address;
		}
	} catch (err) {
		// Best-effort: an unsigned record is an honest outcome, not a failure —
		// never let a vault/decrypt error drop the underlying asset write.
		console.warn('[asset-provenance] signing failed, recording unsigned:', err?.message);
	}

	try {
		const [row] = await sql`
			INSERT INTO agent_actions (agent_id, type, payload, source_skill, signature, signer_address)
			VALUES (${agentId}, ${action.type}, ${JSON.stringify(action.payload)}::jsonb, ${sourceSkill},
			        ${signature}, ${signerAddress})
			RETURNING id
		`;
		return {
			recorded: true,
			signed: Boolean(signature),
			action_id: row?.id != null ? String(row.id) : null,
			signer_address: signerAddress,
			digest,
		};
	} catch (err) {
		console.error('[asset-provenance] ledger insert failed:', err?.message);
		return { recorded: false, signed: false, action_id: null, signer_address: null, digest, reason: 'ledger_write_failed' };
	}
}

/**
 * Resolve the agent linked to an avatar (agent_identities.avatar_id), if any.
 * Provenance is agent-scoped (the ledger's FK), so an avatar with no
 * provisioned agent yet simply has no ledger entry — never an error.
 */
export async function agentIdForAvatar(avatarId) {
	if (!avatarId) return null;
	const rows = await sql`
		SELECT id FROM agent_identities
		WHERE avatar_id = ${avatarId} AND deleted_at IS NULL
		ORDER BY created_at ASC LIMIT 1
	`;
	return rows[0]?.id ?? null;
}
