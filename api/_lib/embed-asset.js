// Shared embed-asset resolver.
//
// Resolves a flexible embed ID spec to the minimal payload a viewer needs to
// render an agent or avatar: { glbUrl, name, poster, kind, ...minimal metadata }.
//
// Extracted from api/embed/resolve.js so the token-gate verifier
// (api/embed/gate-verify.js) can resolve the SAME asset shape — but only hand
// the glbUrl back once an on-chain balance check has passed. The public
// resolve endpoint keeps returning it unconditionally for ungated embeds.
//
// Supported ID specs (kept tiny on purpose):
//   - "<chainId>:<agentId>"         → on-chain ERC-8004 agent  e.g. "8453:42"
//   - "eip155:<chainId>:<agentId>"  → same, namespaced form    e.g. "eip155:8453:42"
//   - "avatar:<uuid>"               → public avatar            e.g. "avatar:8e3...c1"

import { sql } from './db.js';
import { CHAIN_BY_ID } from './erc8004-chains.js';
import { publicUrl, thumbnailUrl } from './r2.js';
import { isUuid } from './validate.js';

export const ONCHAIN_RE = /^(?:eip155:)?(\d{1,9})[:/](\d{1,12})$/;
export const AVATAR_RE = /^avatar:([a-zA-Z0-9_-]{3,64})$/;

/** True when `id` is a syntactically valid embed asset ref. */
export function isEmbedAssetRef(id) {
	const s = String(id || '').trim();
	return ONCHAIN_RE.test(s) || AVATAR_RE.test(s);
}

/**
 * Resolve an embed asset ref to its render payload.
 * @param {string} id
 * @returns {Promise<object|null>} payload, or null when not found / malformed.
 */
export async function resolveEmbedAsset(id) {
	const spec = String(id || '').trim();
	if (!spec) return null;

	const onchain = spec.match(ONCHAIN_RE);
	if (onchain) {
		const chainId = parseInt(onchain[1], 10);
		const agentId = parseInt(onchain[2], 10);
		const rows = await sql`
			SELECT chain_id, agent_id, name, description, image, glb_url, has_3d, x402_support
			FROM erc8004_agents_index
			WHERE active = true AND chain_id = ${chainId} AND agent_id = ${agentId}
			LIMIT 1
		`;
		if (!rows.length) return null;

		const r = rows[0];
		const chain = CHAIN_BY_ID[r.chain_id];
		return {
			kind: 'onchain',
			id: `${r.chain_id}:${r.agent_id}`,
			chainId: r.chain_id,
			chainName: chain?.name || `Chain ${r.chain_id}`,
			agentId: r.agent_id,
			name: r.name || `Agent #${r.agent_id}`,
			description: r.description || '',
			glbUrl: r.glb_url || null,
			poster: r.image || null,
			has3d: !!r.has_3d,
			x402: !!r.x402_support,
			passportUrl: `/discover/a/${r.chain_id}/${r.agent_id}`,
		};
	}

	const avatar = spec.match(AVATAR_RE);
	if (avatar) {
		const avatarId = avatar[1];
		// avatars.id is a uuid column — a non-UUID id here raises Postgres 22P02
		// (invalid input syntax) and surfaces as a 500. Treat it as not-found.
		if (!isUuid(avatarId)) return null;

		const rows = await sql`
			SELECT id, name, description, storage_key, thumbnail_key
			FROM avatars
			WHERE deleted_at IS NULL AND visibility = 'public' AND id = ${avatarId}
			LIMIT 1
		`;
		if (!rows.length) return null;

		const r = rows[0];
		return {
			kind: 'avatar',
			id: `avatar:${r.id}`,
			name: r.name,
			description: r.description || '',
			glbUrl: publicUrl(r.storage_key),
			poster: thumbnailUrl(r.thumbnail_key),
			has3d: true,
			x402: false,
			passportUrl: `/avatars/${r.id}`,
		};
	}

	return null;
}
