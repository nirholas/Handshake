/**
 * Brain anchoring — record a content-addressed brain milestone on-chain.
 *
 * The agent's curated mind (its persona version + the sorted set of signed
 * memory content-hashes) collapses to a single `brain_hash`. Anchoring writes
 * that hash to the real ERC-8004 ValidationRegistry via recordValidation(...)
 * under a brain-specific `kind`, signed by the platform validator key — the
 * same path that backs GLB validation attestations. The pinned "brain passport"
 * (proofURI) is the human-readable provenance document the hash commits to.
 *
 * This gives a forker/buyer an on-chain, timestamped proof that the agent's
 * mind was in a known state at a known block — verifiable growth, not a claim.
 *
 * Best-effort by contract, mirroring validation-attest: every failure carries a
 * machine-readable `.code` and is recorded as a `failed` row in
 * agent_brain_anchors (never a silent skip, never a fake "verified" badge).
 */

import { createHash } from 'node:crypto';
import { Contract, Wallet, keccak256, toUtf8Bytes } from 'ethers';

import { env } from './env.js';
import { sql } from './db.js';
import { CHAIN_BY_ID, VALIDATION_REGISTRY_ABI, validationRegistryFor } from './erc8004-chains.js';
import { evmFallbackProvider } from './evm/rpc.js';
import { explorerLink } from './onchain.js';
import { putObject, publicUrl } from './r2.js';
import { computeBrainHash } from './brain-bundle.js';
import { signDigest, loadAgentSigner } from './brain-sign.js';

export const BRAIN_ANCHOR_KIND = 'threews.brain-anchor.v1';

export class BrainAnchorError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'BrainAnchorError';
		this.code = code;
	}
}

/**
 * Build the curated brain state for an agent: persona hash + the signed memory
 * content-hashes that constitute the anchorable mind. Only memories that carry
 * a content_hash are included (an unsigned/unhashed memory can't be anchored).
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {boolean} [opts.publicOnly=false] anchor only public memories
 * @returns {Promise<{ agent: object, persona: object, memoryHashes: string[], publicCount: number, total: number }>}
 */
export async function gatherBrainState(agentId, { publicOnly = false } = {}) {
	const [agent] = await sql`
		SELECT id, name, wallet_address, chain_id, erc8004_agent_id,
		       persona_prompt_hash, persona_extracted_at
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!agent) throw new BrainAnchorError('agent_not_found', 'agent not found');

	const rows = publicOnly
		? await sql`
			SELECT content_hash, is_public FROM agent_memories
			WHERE agent_id = ${agentId} AND content_hash IS NOT NULL AND is_public = true
			  AND (expires_at IS NULL OR expires_at > now())
		`
		: await sql`
			SELECT content_hash, is_public FROM agent_memories
			WHERE agent_id = ${agentId} AND content_hash IS NOT NULL
			  AND (expires_at IS NULL OR expires_at > now())
		`;

	const memoryHashes = rows.map((r) => r.content_hash);
	const publicCount = rows.filter((r) => r.is_public).length;
	return {
		agent,
		persona: { prompt_hash: agent.persona_prompt_hash, extracted_at: agent.persona_extracted_at },
		memoryHashes,
		publicCount,
		total: rows.length,
	};
}

/**
 * Compute (without writing) the brain_hash an anchor would commit to. Used by
 * the UI to show "current vs last-anchored" drift.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @returns {Promise<{ brainHash: string, memoryCount: number, publicCount: number, personaPromptHash: string|null }>}
 */
export async function previewBrainHash(agentId, opts = {}) {
	const state = await gatherBrainState(agentId, opts);
	const brainHash = computeBrainHash({
		personaPromptHash: state.persona.prompt_hash,
		memoryHashes: state.memoryHashes,
		agentId,
	});
	return {
		brainHash,
		memoryCount: state.total,
		publicCount: state.publicCount,
		personaPromptHash: state.persona.prompt_hash || null,
	};
}

/**
 * Anchor the current brain state on-chain. Records a row in agent_brain_anchors
 * for every attempt (anchored or failed).
 *
 * @param {object} p
 * @param {string} p.agentId
 * @param {string} p.anchoredAt ISO timestamp (server-supplied; deterministic)
 * @param {boolean} [p.publicOnly=false]
 * @returns {Promise<object>} the anchored row + explorer link
 */
export async function anchorBrain({ agentId, anchoredAt, publicOnly = false }) {
	const state = await gatherBrainState(agentId, { publicOnly });
	const { agent } = state;

	const brainHash = computeBrainHash({
		personaPromptHash: state.persona.prompt_hash,
		memoryHashes: state.memoryHashes,
		agentId,
	});

	// Sign the milestone with the agent's own wallet — proves the agent itself
	// attests to this brain state, independent of the platform validator.
	let agentSignature = null;
	let agentSigner = null;
	try {
		const signer = await loadAgentSigner(agentId, { agentId, reason: 'brain_anchor' });
		if (signer) {
			const { signature } = await signDigest(signer.privKey, brainHash);
			agentSignature = signature;
			agentSigner = signer.address;
		}
	} catch (err) {
		console.error('[brain-anchor] agent signature failed', agentId, err?.message);
	}

	const chainId = agent.chain_id || CHAIN_BY_ID[8453]?.id || 8453;

	// Record a pending row up front so a mid-flight failure still leaves a trail.
	const [pending] = await sql`
		INSERT INTO agent_brain_anchors
			(agent_id, brain_hash, kind, status, chain_id, erc8004_agent_id,
			 memory_count, public_count, persona_prompt_hash, signer_address, signature)
		VALUES (${agentId}, ${brainHash}, ${BRAIN_ANCHOR_KIND}, 'pending', ${chainId},
			${agent.erc8004_agent_id || null}, ${state.total}, ${state.publicCount},
			${state.persona.prompt_hash || null}, ${agentSigner}, ${agentSignature})
		RETURNING id
	`;
	const anchorId = pending.id;

	const fail = async (code, detail) => {
		await sql`
			UPDATE agent_brain_anchors
			SET status = 'failed', error_code = ${code}, error_detail = ${detail}
			WHERE id = ${anchorId}
		`;
		throw new BrainAnchorError(code, detail);
	};

	if (!agent.erc8004_agent_id) {
		await fail(
			'not_registered',
			'Agent has no ERC-8004 on-chain identity yet. Register the agent on-chain before anchoring its brain.',
		);
	}

	const chain = CHAIN_BY_ID[chainId];
	if (!chain) await fail('unsupported_chain', `unsupported chain ${chainId}`);

	const registryAddr = validationRegistryFor(chainId);
	if (!registryAddr) {
		await fail(
			'validation_registry_not_deployed',
			`ValidationRegistry is not deployed on ${chain.name} (chain ${chainId}).`,
		);
	}

	const pk = env.VALIDATOR_PRIVATE_KEY;
	if (!pk) await fail('validator_key_not_configured', 'VALIDATOR_PRIVATE_KEY is not set — cannot anchor.');

	// Build + pin the brain passport (the proof the hash commits to).
	const passport = {
		schema: BRAIN_ANCHOR_KIND,
		brain_hash: brainHash,
		agent: { id: String(agent.id), name: agent.name || null, erc8004_agent_id: String(agent.erc8004_agent_id) },
		persona_prompt_hash: state.persona.prompt_hash || null,
		memory_count: state.total,
		public_count: state.publicCount,
		signer_address: agentSigner,
		agent_signature: agentSignature,
		anchored_at: anchoredAt,
		chain_id: chainId,
	};
	const proofBody = Buffer.from(JSON.stringify(passport, null, 2));
	const proofKey = `brain-anchors/${chainId}/${agent.id}/${brainHash}.json`;
	let proofURI;
	try {
		await putObject({ key: proofKey, body: proofBody, contentType: 'application/json' });
		proofURI = publicUrl(proofKey);
	} catch (err) {
		await fail('proof_pin_failed', `could not pin brain passport: ${err.message}`);
	}
	const proofHash = keccak256(toUtf8Bytes(JSON.stringify(passport)));

	// Provider + validator wallet + registry. Quorum-1 failover across the
	// chain's endpoints, so a single dead RPC never blocks an anchor.
	const provider = await evmFallbackProvider(chainId);
	const wallet = new Wallet(pk, provider);
	const registry = new Contract(registryAddr, VALIDATION_REGISTRY_ABI, wallet);

	let allowed;
	try {
		allowed = await registry.isValidator(wallet.address);
	} catch (err) {
		await fail('registry_read_failed', `could not read validator allow-list: ${err.message}`);
	}
	if (!allowed) {
		await fail(
			'validator_not_allowlisted',
			`Validator ${wallet.address} is not allow-listed on ${chain.name}.`,
		);
	}

	let tx;
	try {
		tx = await registry.recordValidation(
			BigInt(agent.erc8004_agent_id),
			true,
			proofHash,
			proofURI,
			BRAIN_ANCHOR_KIND,
		);
	} catch (err) {
		await fail('record_failed', `recordValidation reverted: ${err.shortMessage || err.message}`);
	}
	await tx.wait();

	const [anchored] = await sql`
		UPDATE agent_brain_anchors
		SET status = 'anchored', proof_uri = ${proofURI}, proof_hash = ${proofHash},
		    tx_hash = ${tx.hash}, anchored_at = now()
		WHERE id = ${anchorId}
		RETURNING *
	`;

	return {
		...anchored,
		brain_hash: brainHash,
		explorer_url: explorerLink(chainId, 'tx', tx.hash) || null,
	};
}

/**
 * Latest anchor for an agent (any status), plus whether it still matches the
 * current brain state. The drift check is what makes "your brain has changed
 * since you last anchored" honest.
 *
 * @param {string} agentId
 * @returns {Promise<{ anchor: object|null, currentBrainHash: string, inSync: boolean }>}
 */
export async function latestAnchor(agentId) {
	const [anchor] = await sql`
		SELECT * FROM agent_brain_anchors
		WHERE agent_id = ${agentId} AND status = 'anchored'
		ORDER BY anchored_at DESC NULLS LAST, created_at DESC
		LIMIT 1
	`;
	const preview = await previewBrainHash(agentId);
	return {
		anchor: anchor
			? { ...anchor, explorer_url: anchor.tx_hash ? explorerLink(anchor.chain_id, 'tx', anchor.tx_hash) || null : null }
			: null,
		currentBrainHash: preview.brainHash,
		inSync: anchor ? anchor.brain_hash === preview.brainHash : false,
	};
}

// Stable hex for callers that want a quick sha256 of a string (e.g. proof byte check).
export function sha256Hex(input) {
	return createHash('sha256').update(input).digest('hex');
}
