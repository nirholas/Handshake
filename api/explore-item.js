/**
 * GET /api/explore-item?kind=onchain&chain=<id>&id=<agentId>
 * GET /api/explore-item?kind=avatar&id=<avatarId>
 * GET /api/explore-item?kind=solana&id=<asset_pubkey>
 *
 * Returns a single item in the same shape as the /api/explore feed items.
 */

import { sql } from './_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';
import { publicUrl, thumbnailUrl } from './_lib/r2.js';
import { isErc8004AgentId, isUuid } from './_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const kind = url.searchParams.get('kind');
	const id = url.searchParams.get('id');

	if (!kind || !id) return error(res, 400, 'validation_error', 'kind and id are required');

	if (kind === 'onchain') {
		const chainId = parseInt(url.searchParams.get('chain') || '', 10);
		if (!Number.isFinite(chainId)) return error(res, 400, 'validation_error', 'chain is required for onchain items');
		// agent_id is a TEXT column holding a uint256 token id. Match on the raw
		// digit string: parseInt() would round anything past 2^53 into exponent
		// notation that matches no row, and turn a non-numeric id into NaN.
		if (!isErc8004AgentId(id)) return error(res, 404, 'not_found', 'agent not found');

		const rows = await sql`
			SELECT chain_id, agent_id, owner, name, description, image, glb_url,
			       has_3d, x402_support, registered_at, registered_tx,
			       services, agent_uri
			FROM erc8004_agents_index
			WHERE active = true
			  AND chain_id = ${chainId}
			  AND agent_id = ${id}
			LIMIT 1
		`;

		if (!rows.length) return error(res, 404, 'not_found', 'agent not found');

		const r = rows[0];
		const chain = CHAIN_BY_ID[r.chain_id];
		const item = {
			kind: 'onchain',
			chainId: r.chain_id,
			chainName: chain?.name || `Chain ${r.chain_id}`,
			explorerBase: chain?.explorer || null,
			agentId: r.agent_id,
			owner: r.owner,
			ownerShort: shortAddr(r.owner),
			name: r.name || `Agent #${r.agent_id}`,
			description: r.description || '',
			image: r.image || null,
			glbUrl: r.glb_url || null,
			has3d: r.has_3d,
			x402Support: r.x402_support,
			registeredAt: r.registered_at,
			registeredTx: r.registered_tx || null,
			tokenExplorerUrl: tokenExplorerUrl(r.chain_id, r.agent_id),
			ownerExplorerUrl: addressExplorerUrl(r.chain_id, r.owner),
			viewerUrl: r.glb_url ? `/app#model=${encodeURIComponent(r.glb_url)}` : null,
			services: (r.services || []).map((s) => ({
				name: s?.name || null,
				endpoint: s?.endpoint || null,
				version: s?.version || null,
			})),
		};

		return json(res, 200, { item });
	}

	if (kind === 'avatar') {
		// avatars.id is a uuid column: an unvalidated id reaches Postgres as an
		// invalid-text-representation error (22P02) and surfaced as a 500 on a
		// public endpoint. A malformed id names no avatar, so answer 404, which is
		// also the status the detail page renders its "Not found" state for.
		if (!isUuid(id)) return error(res, 404, 'not_found', 'avatar not found');

		const rows = await sql`
			SELECT a.id, a.slug, a.name, a.description, a.storage_key, a.thumbnail_key,
			       a.tags, a.created_at, a.source,
			       coalesce(a.featured, false) AS featured,
			       coalesce(a.view_count, 0)   AS view_count,
			       u.username        AS owner_username,
			       u.display_name    AS owner_display_name,
			       u.wallet_address  AS owner_wallet
			FROM avatars a
			LEFT JOIN users u ON u.id = a.owner_id AND u.deleted_at IS NULL
			WHERE a.deleted_at IS NULL
			  AND a.visibility = 'public'
			  AND a.id = ${id}
			LIMIT 1
		`;

		if (!rows.length) return error(res, 404, 'not_found', 'avatar not found');

		const r = rows[0];
		const glb = publicUrl(r.storage_key);
		const handle = r.owner_username
			? `@${r.owner_username}`
			: r.owner_wallet
				? shortAddr(r.owner_wallet)
				: null;

		const item = {
			kind: 'avatar',
			avatarId: r.id,
			slug: r.slug,
			name: r.name,
			description: r.description || '',
			image: thumbnailUrl(r.thumbnail_key),
			glbUrl: glb,
			has3d: true,
			tags: r.tags || [],
			source: r.source || null,
			featured: r.featured === true || r.featured === 't',
			viewCount: Number(r.view_count) || 0,
			createdAt: r.created_at,
			viewerUrl: `/app#model=${encodeURIComponent(glb)}`,
			author: handle
				? {
					handle,
					displayName: r.owner_display_name || r.owner_username || handle,
					profileUrl: r.owner_username ? `/u/${r.owner_username}` : null,
				}
				: null,
		};

		return json(res, 200, { item });
	}

	if (kind === 'solana') {
		const rows = await sql`
			SELECT ai.id, ai.name, ai.description, ai.wallet_address, ai.skills,
			       ai.meta, ai.created_at,
			       a.thumbnail_key AS avatar_thumb
			FROM agent_identities ai
			LEFT JOIN avatars a ON a.id = ai.avatar_id AND a.deleted_at IS NULL
			WHERE ai.deleted_at IS NULL
			  AND ai.meta->>'chain_type' = 'solana'
			  AND ai.meta->>'sol_mint_address' = ${id}
			LIMIT 1
		`;

		// Not one of ours: fall back to the crawled directory of external Solana
		// agents. /discover lists those rows and links every one of them to
		// /discover/a/sol/<asset>, so without this branch the home chain's whole
		// external directory (the Metaplex and AgenC registries) is a wall of dead
		// links while the EVM half opens fine.
		if (!rows.length) return solanaDirectoryItem(res, id);

		const r = rows[0];
		const asset = r.meta?.sol_mint_address;
		const network = r.meta?.network || 'mainnet';
		const thumb = thumbnailUrl(r.avatar_thumb);
		const item = {
			kind: 'solana',
			asset,
			name: r.name || 'Solana Agent',
			description: r.description || '',
			image: thumb,
			has3d: !!r.avatar_thumb,
			skills: r.skills || [],
			owner: r.wallet_address,
			ownerShort: shortAddr(r.wallet_address),
			createdAt: r.created_at,
			network,
			explorerUrl: asset ? `https://solscan.io/token/${asset}` : null,
			ownerExplorerUrl: r.wallet_address ? `https://solscan.io/account/${r.wallet_address}` : null,
		};

		return json(res, 200, { item });
	}

	return error(res, 400, 'validation_error', 'kind must be onchain, avatar, or solana');
});

/**
 * Serve one external Solana agent from the crawled registry directory, in the
 * same item shape the native branch returns so the detail page renders it
 * without a second code path. Matches on the Metaplex Core asset or the
 * registry account, because /discover links whichever of the two it has.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} id asset or registry ref from the URL
 */
async function solanaDirectoryItem(res, id) {
	const rows = await sql`
		SELECT source, ref, owner, asset, name, description, image, glb_url,
		       endpoint, capabilities, has_3d, x402_support, network, registered_at
		FROM solana_agents_index
		WHERE active = true
		  AND (asset = ${id} OR ref = ${id})
		LIMIT 1
	`;

	if (!rows.length) return error(res, 404, 'not_found', 'solana agent not found');

	const r = rows[0];
	const asset = r.asset || r.ref;
	const cluster = r.network === 'devnet' ? '?cluster=devnet' : '';
	const item = {
		kind: 'solana',
		asset,
		name: r.name || 'Solana Agent',
		description: r.description || '',
		image: r.image || null,
		has3d: !!r.glb_url,
		glbUrl: r.glb_url || null,
		// Directory rows carry capabilities as free text (the registries publish a
		// comma or space separated list, not a JSON array), while the native branch
		// returns real skill records. Split it into the same slot so the page has
		// one shape to render.
		skills: splitCapabilities(r.capabilities),
		owner: r.owner,
		ownerShort: shortAddr(r.owner),
		// registered_at on a crawled row is first-seen, not on-chain registration
		// time. The On-chain history panel is where the real registration
		// timestamp comes from, read from the event index.
		createdAt: r.registered_at,
		network: r.network || 'mainnet',
		source: r.source,
		endpoint: r.endpoint || null,
		x402Support: !!r.x402_support,
		viewerUrl: r.glb_url ? `/app#model=${encodeURIComponent(r.glb_url)}` : null,
		explorerUrl: asset ? `https://solscan.io/token/${asset}${cluster}` : null,
		ownerExplorerUrl: r.owner ? `https://solscan.io/account/${r.owner}${cluster}` : null,
	};

	return json(res, 200, { item });
}

/**
 * Split a crawled directory row's free-text capabilities into a list, capped so
 * a registry entry padded with hundreds of keywords cannot flood the page.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function splitCapabilities(raw) {
	if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 24);
	if (typeof raw !== 'string') return [];
	return raw
		.split(/[,;|\n]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 24);
}

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
