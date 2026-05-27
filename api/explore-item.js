/**
 * GET /api/explore-item?kind=onchain&chain=<id>&id=<agentId>
 * GET /api/explore-item?kind=avatar&id=<avatarId>
 * GET /api/explore-item?kind=solana&id=<asset_pubkey>
 *
 * Returns a single item in the same shape as the /api/explore feed items.
 */

import { sql } from './_lib/db.js';
import { cors, json, method, wrap, error } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';
import { publicUrl } from './_lib/r2.js';
import { DEMO_AVATARS } from './_lib/demo-avatars.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const kind = url.searchParams.get('kind');
	const id = url.searchParams.get('id');

	if (!kind || !id) return error(res, 400, 'validation_error', 'kind and id are required');

	if (kind === 'onchain') {
		const chainId = parseInt(url.searchParams.get('chain') || '', 10);
		if (!Number.isFinite(chainId)) return error(res, 400, 'validation_error', 'chain is required for onchain items');

		const rows = await sql`
			SELECT chain_id, agent_id, owner, name, description, image, glb_url,
			       has_3d, x402_support, registered_at, registered_tx,
			       services, agent_uri
			FROM erc8004_agents_index
			WHERE active = true
			  AND chain_id = ${chainId}
			  AND agent_id = ${parseInt(id, 10)}
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
		// Check demo avatars first (no DB entry)
		const demo = DEMO_AVATARS.find((a) => String(a.avatarId) === String(id));
		if (demo) return json(res, 200, { item: demo });

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
			image: r.thumbnail_key ? publicUrl(r.thumbnail_key) : null,
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

		if (!rows.length) return error(res, 404, 'not_found', 'solana agent not found');

		const r = rows[0];
		const asset = r.meta?.sol_mint_address;
		const network = r.meta?.network || 'mainnet';
		const thumb = r.avatar_thumb ? publicUrl(r.avatar_thumb) : null;
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

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
