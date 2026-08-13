// Signed agent manifests — the I/O half: read the agent, sign, pin, persist.
//
// The pure crypto lives in agent-manifest-sign.js. This module is the only place
// that touches the database, the platform attester key, and the IPFS pinning
// providers, so the sign/verify primitives an outside party runs stay free of
// every dependency we happen to have.
//
// Publishing is best-effort at the write boundary, deliberately: a persona save
// must never fail because an IPFS provider is having a bad minute. Every outcome
// is reported honestly through `reason` — there is no state in which an unpinned
// or unsigned manifest is presented as pinned or signed.

import { sql } from './db.js';
import { loadAttesterKeypair } from './attest-event.js';
import { pinToIPFS, ipfsGatewayUrl, ipfsPinningConfigured, fetchFromGateways, IPFS_READ_GATEWAYS } from './ipfs-pin.js';
import { publicUrl as r2PublicUrl } from './r2.js';
import {
	buildAgentManifest,
	signAgentManifest,
	envelopeBytes,
	manifestBodyDigest,
} from './agent-manifest-sign.js';

/**
 * Gateways a manifest can be fetched from, shared with every other IPFS reader
 * on the platform (api/_lib/ipfs-pin.js) so a dead host is retired in one place.
 */
export const IPFS_GATEWAYS = IPFS_READ_GATEWAYS;

const MAX_ENVELOPE_BYTES = 1024 * 1024;

function appOrigin() {
	return (process.env.PUBLIC_APP_ORIGIN || 'https://three.ws').replace(/\/$/, '');
}

/**
 * The platform's signing identity as a base58 ed25519 public key, or null when
 * the attester key is not configured here. Verifiers compare an envelope's
 * issuer against this: a valid signature from an unknown key proves only that
 * *someone* signed the document, which is not the same as three.ws vouching for
 * it.
 *
 * @returns {string|null}
 */
export function platformIssuer() {
	try {
		return loadAttesterKeypair().publicKey.toBase58();
	} catch {
		return null;
	}
}

/**
 * Read everything the manifest describes in one query and shape it into the
 * canonical manifest body. Exported because the verification endpoint diffs a
 * pinned manifest against exactly this, so both sides are built the same way.
 *
 * @param {string} agentId
 * @returns {Promise<{manifest:object, agent:object}|null>} null when the agent
 *   does not exist, is deleted, or has no compiled persona to attest.
 */
export async function buildLiveAgentManifest(agentId) {
	const [row] = await sql`
		SELECT a.id, a.name, a.description, a.greeting, a.tags, a.skills, a.is_public,
		       a.persona_prompt, a.persona_tone_tags, a.persona_traits, a.persona_updated_at,
		       a.voice_provider, a.voice_id, a.chain_id, a.erc8004_agent_id, a.erc8004_registry,
		       a.created_at, a.manifest_cid, a.manifest_digest, a.manifest_issuer,
		       a.manifest_signature, a.manifest_pin_provider, a.manifest_signed_at,
		       av.storage_key, av.thumbnail_key, av.content_type, av.visibility
		FROM agent_identities a
		LEFT JOIN avatars av ON av.id = a.avatar_id AND av.deleted_at IS NULL
		WHERE a.id = ${agentId} AND a.deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) return null;
	if (!row.persona_prompt || !String(row.persona_prompt).trim()) return { manifest: null, agent: row };

	// Only a stable public URL belongs in a permanently pinned document. A
	// presigned URL for a private avatar would expire and turn the manifest into
	// a broken pointer, so a private body is simply omitted.
	const bodyPublic = row.storage_key && (row.visibility === 'public' || row.visibility === 'unlisted');
	const traits = row.persona_traits && typeof row.persona_traits === 'object' ? row.persona_traits.values || {} : {};

	const manifest = buildAgentManifest({
		agentId: row.id,
		name: row.name,
		description: row.description,
		tags: Array.isArray(row.tags) ? row.tags : [],
		image: row.thumbnail_key ? r2PublicUrl(row.thumbnail_key) : '',
		systemPrompt: row.persona_prompt,
		toneTags: Array.isArray(row.persona_tone_tags) ? row.persona_tone_tags : [],
		traits,
		greeting: row.greeting || '',
		body: bodyPublic ? { uri: r2PublicUrl(row.storage_key), format: row.content_type || 'gltf-binary' } : null,
		voice: row.voice_id ? { provider: row.voice_provider || 'elevenlabs', voiceId: row.voice_id } : null,
		skills: Array.isArray(row.skills) ? row.skills : [],
		registration:
			row.chain_id && row.erc8004_agent_id
				? { chainId: row.chain_id, registry: row.erc8004_registry, agentId: row.erc8004_agent_id }
				: null,
		homeUrl: `${appOrigin()}/agent/${row.id}`,
		createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
		updatedAt: row.persona_updated_at ? new Date(row.persona_updated_at).toISOString() : null,
	});

	return { manifest, agent: row };
}

/**
 * Sign the agent's current configuration, pin it to IPFS, and record the CID.
 *
 * Outcomes (all reported, never disguised):
 *   published  — signed and, when a provider is configured, pinned.
 *   unchanged  — configuration is byte-identical to the last publish; the
 *                existing CID still describes it, so nothing is re-pinned.
 *   skipped    — no persona yet, the agent is private, or the attester key is
 *                not configured on this deployment.
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {string} [opts.reason='persona_save'] what triggered the publish
 * @param {boolean} [opts.force=false] publish a non-public agent (owner-initiated)
 * @returns {Promise<{status:string, reason:string, cid:string|null, digest:string|null,
 *   issuer:string|null, signature:string|null, provider:string|null, signedAt:string|null,
 *   gatewayUrl:string|null, pinned:boolean}>}
 */
export async function publishAgentManifest(agentId, { reason = 'persona_save', force = false } = {}) {
	const skipped = (why) => ({
		status: 'skipped',
		reason: why,
		cid: null,
		digest: null,
		issuer: null,
		signature: null,
		provider: null,
		signedAt: null,
		gatewayUrl: null,
		pinned: false,
	});

	const built = await buildLiveAgentManifest(agentId);
	if (!built) return skipped('agent_not_found');
	if (!built.manifest) return skipped('no_persona');
	if (!built.agent.is_public && !force) return skipped('agent_private');

	let keypair;
	try {
		keypair = loadAttesterKeypair();
	} catch (err) {
		console.error('[agent-manifest] attester key unavailable:', err?.message);
		return skipped('signer_unavailable');
	}

	const bodyDigest = manifestBodyDigest(built.manifest);
	const [prior] = await sql`
		SELECT cid, digest, issuer, signature, provider, created_at
		FROM agent_manifest_pins
		WHERE agent_id = ${agentId} AND body_digest = ${bodyDigest}
		ORDER BY created_at DESC
		LIMIT 1
	`;
	if (prior && prior.cid) {
		return {
			status: 'unchanged',
			reason: 'configuration_identical_to_last_publish',
			cid: prior.cid,
			digest: prior.digest,
			issuer: prior.issuer,
			signature: prior.signature,
			provider: prior.provider,
			signedAt: prior.created_at ? new Date(prior.created_at).toISOString() : null,
			gatewayUrl: ipfsGatewayUrl(prior.cid),
			pinned: true,
		};
	}

	const envelope = signAgentManifest(built.manifest, keypair.secretKey);
	const bytes = envelopeBytes(envelope);

	let cid = null;
	let provider = null;
	let pinReason = 'published';
	if (ipfsPinningConfigured()) {
		try {
			const pinned = await pinToIPFS(bytes, `agent-${agentId}-manifest.json`);
			cid = pinned?.cid || null;
			provider = pinned?.provider || null;
		} catch (err) {
			// A pinning outage must not lose the signature. The envelope is stored
			// either way and stays verifiable by digest over the HTTPS copy; the
			// next save (or an explicit re-publish) pins it.
			console.error('[agent-manifest] pin failed for', agentId, err?.message);
			pinReason = 'signed_pin_failed';
		}
	} else {
		pinReason = 'signed_pinning_unconfigured';
	}

	await sql.transaction([
		sql`
			INSERT INTO agent_manifest_pins (agent_id, cid, digest, body_digest, issuer, signature, provider, envelope, reason)
			VALUES (${agentId}, ${cid}, ${envelope.digest}, ${bodyDigest}, ${envelope.issuer},
			        ${envelope.signature}, ${provider}, ${JSON.stringify(envelope)}::jsonb, ${reason})
			ON CONFLICT (digest) DO NOTHING
		`,
		sql`
			UPDATE agent_identities
			SET manifest_cid          = ${cid},
			    manifest_digest       = ${envelope.digest},
			    manifest_issuer       = ${envelope.issuer},
			    manifest_signature    = ${envelope.signature},
			    manifest_pin_provider = ${provider},
			    manifest_signed_at    = ${envelope.signedAt}
			WHERE id = ${agentId}
		`,
	]);

	return {
		status: 'published',
		reason: pinReason,
		cid,
		digest: envelope.digest,
		issuer: envelope.issuer,
		signature: envelope.signature,
		provider,
		signedAt: envelope.signedAt,
		gatewayUrl: cid ? ipfsGatewayUrl(cid) : null,
		pinned: Boolean(cid),
	};
}

/**
 * Publish without ever throwing into the caller's request. Used by the persona
 * write paths, where the save is the user's work and the manifest is a bonus.
 */
export async function publishAgentManifestSafely(agentId, opts) {
	try {
		return await publishAgentManifest(agentId, opts);
	} catch (err) {
		console.error('[agent-manifest] publish failed for', agentId, err?.message);
		return {
			status: 'skipped',
			reason: 'publish_error',
			cid: null,
			digest: null,
			issuer: null,
			signature: null,
			provider: null,
			signedAt: null,
			gatewayUrl: null,
			pinned: false,
		};
	}
}

/**
 * Fetch a signed envelope by CID from the IPFS gateway network, taking the
 * first gateway that answers. Independent of our database on purpose: this is
 * the same path an outside verifier walks, so if it works here it works for
 * them. The gateway that served it is returned so the caller can report which
 * copy of the network it actually checked.
 *
 * @param {string} cid
 * @returns {Promise<{envelope:object, gateway:string}>}
 * @throws {Error & {code:string}} when no gateway returns usable JSON
 */
export async function fetchEnvelopeFromIPFS(cid) {
	const { text, gateway } = await fetchFromGateways(cid, { maxBytes: MAX_ENVELOPE_BYTES });
	try {
		return { envelope: JSON.parse(text), gateway };
	} catch {
		throw Object.assign(new Error(`${gateway} served ${cid} but it is not JSON`), {
			code: 'gateway_unreachable',
		});
	}
}

/**
 * Look up a stored envelope by CID or digest. Lets verification answer for a
 * deployment with no pinning provider, and is what maps a CID back to its agent
 * so the live-config diff has something to compare against.
 *
 * @param {{cid?:string, digest?:string}} q
 * @returns {Promise<{agent_id:string, cid:string|null, digest:string, envelope:object, created_at:string}|null>}
 */
export async function findStoredManifest({ cid, digest }) {
	if (cid) {
		const [row] = await sql`
			SELECT agent_id, cid, digest, envelope, created_at
			FROM agent_manifest_pins WHERE cid = ${cid} ORDER BY created_at DESC LIMIT 1
		`;
		return row || null;
	}
	if (digest) {
		const [row] = await sql`
			SELECT agent_id, cid, digest, envelope, created_at
			FROM agent_manifest_pins WHERE digest = ${digest} LIMIT 1
		`;
		return row || null;
	}
	return null;
}
