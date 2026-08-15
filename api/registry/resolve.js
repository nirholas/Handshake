// GET /api/registry/resolve?q=<input>
// ---------------------------------------------------------------------------
// Public agent-registry lookup. Detects the input type and normalises any of
//   • a Solana Core asset mint (base58, 32–44 chars)
//   • an agent identity UUID  / avatar UUID
//   • an avatar slug
// into one JSON record describing the agent's 3D body + on-chain identity.
//
// Never leaks a private GLB: modelUrl is only resolved for public/unlisted
// avatars (resolveAvatarUrl would otherwise mint a presigned URL for a private
// object). Unknown input resolves to { state: 'not_found' } with a 200 — the
// page renders a clean not-found, never a 500.

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, fetchAssetV1, findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { sql } from '../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { resolveAvatarUrl } from '../_lib/avatars.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { solanaConnection } from '../_lib/solana/connection.js';

// Solana base58 pubkey — excludes 0/O/I/l, length 32–44. A UUID contains
// hyphens so it can never match; we still check isUuid() first for clarity.
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// A read-only Umi per network. fetchAssetV1 hits the RPC; findAssetSignerPda is
// pure program-derived address math (no network), so it works for either.
const _umi = {};
function readUmi(network) {
	// A multi-endpoint failover Connection (not a bare URL): fetchAssetV1's RPC read
	// rotates across the endpoint chain, so a single node returning a malformed/empty
	// 200 body fails over instead of throwing the `StructError: … but received:` crash.
	if (!_umi[network]) _umi[network] = createUmi(solanaConnection({ network })).use(mplCore());
	return _umi[network];
}

function explorerLinks(mint, network) {
	const devnet = network === 'devnet';
	return {
		metaplex: `https://core.metaplex.com/explorer/${mint}${devnet ? '?env=devnet' : ''}`,
		solscan: `https://solscan.io/token/${mint}${devnet ? '?cluster=devnet' : ''}`,
		magiceden: `https://magiceden.io/item-details/${mint}`,
	};
}

// Derive the asset signer PDA (the agent's on-chain wallet) for a Core asset.
// Pure derivation — returns null only if the mint is not a valid pubkey.
function assetSignerWalletFor(mint) {
	try {
		const [pda] = findAssetSignerPda(readUmi('mainnet'), { asset: umiPublicKey(mint) });
		return pda.toString();
	} catch {
		return null;
	}
}

// Genesis rank: an agent's 1-based position among every on-chain-deployed
// agent, ordered by the moment it was minted. cz, the first agent deployed,
// is Genesis #1. Null for agents that aren't minted yet.
async function genesisRankFor(agentId) {
	if (!agentId) return null;
	const [row] = await sql`
		WITH ranked AS (
			SELECT id,
				row_number() OVER (
					ORDER BY COALESCE((meta->'onchain'->>'confirmed_at')::timestamptz, created_at) ASC,
					         created_at ASC, id ASC
				) AS rank
			FROM agent_identities
			WHERE deleted_at IS NULL
			  AND (meta->>'sol_mint_address' IS NOT NULL
			       OR meta->'devnet'->>'sol_mint_address' IS NOT NULL)
		)
		SELECT rank FROM ranked WHERE id = ${agentId}
	`;
	return row ? Number(row.rank) : null;
}

// Pull the on-chain coordinates out of an agent's meta blob, picking the
// network the agent was actually deployed on (mainnet preferred).
function onchainCoords(meta) {
	if (!meta || typeof meta !== 'object') return null;
	const mainMint = meta.sol_mint_address || null;
	const devMint = meta.devnet?.sol_mint_address || null;
	const mint = mainMint || devMint || meta.onchain?.sol_asset || null;
	if (!mint) return null;
	const network = mainMint ? 'mainnet' : devMint ? 'devnet' : meta.network || 'mainnet';
	const net = mainMint ? meta : devMint ? meta.devnet : meta;
	return {
		mint,
		network,
		collection: net?.collection || meta.collection || null,
		owner: net?.onchain?.owner || meta.onchain?.owner || null,
	};
}

// Build the unified response from a normalised record. `avatar` carries the
// raw storage row (storage_key + visibility) so we can gate the GLB; `meta` is
// the agent's meta blob (null for avatars with no linked agent).
async function build({ name, description, agentId, meta, avatar, ownerFallback }) {
	const coords = onchainCoords(meta);

	let modelUrl = null;
	const isPublicAvatar =
		avatar && (avatar.visibility === 'public' || avatar.visibility === 'unlisted');
	if (isPublicAvatar) {
		try {
			const resolved = await resolveAvatarUrl({
				storage_key: avatar.storage_key,
				visibility: avatar.visibility,
			});
			modelUrl = resolved?.url || null;
		} catch {
			modelUrl = null;
		}
	}

	// The thumbnail is a render of the avatar itself, so it is gated on exactly the
	// visibility that gates the GLB above: a private avatar yields identity
	// metadata and no imagery, the same gate api/characters.js, api/trending.js and
	// api/og/agent.js apply. thumbnailUrl() (never a bare publicUrl) is the one
	// resolver every read path uses, so a legacy origin-pointing `*_og.png` key is
	// dropped instead of published as a doomed <img> src; it reads S3_PUBLIC_DOMAIN,
	// which throws when unset, and an unconfigured var must degrade to no image
	// rather than 503 the whole identity lookup.
	let imageUrl = null;
	if (isPublicAvatar && avatar.thumbnail_key) {
		try {
			imageUrl = thumbnailUrl(avatar.thumbnail_key);
		} catch {
			imageUrl = null;
		}
	}

	let onchain = null;
	if (coords) {
		const owner = coords.owner || ownerFallback || null;
		onchain = {
			mint: coords.mint,
			collection: coords.collection,
			owner,
			assetSignerWallet: assetSignerWalletFor(coords.mint),
			active: true,
			x402Support: true,
			links: explorerLinks(coords.mint, coords.network),
		};
	}

	// State: a private avatar yields metadata + identity but no model.
	const state = avatar && avatar.visibility === 'private' ? 'private' : 'public';

	return {
		name: name || null,
		description: description || '',
		// On-platform identity: the canonical agent profile lives at
		// /agents/:id. Null for bare on-chain assets that aren't three.ws agents.
		agentId: agentId || null,
		genesisRank: await genesisRankFor(agentId),
		modelUrl,
		imageUrl,
		onchain,
		state,
	};
}

// ── resolvers ─────────────────────────────────────────────────────────────────
//
// Queries are written out in full per resolver. The Neon HTTP driver does not
// renumber placeholders across embedded `sql`…`` fragments, so composing a
// shared SELECT fragment with a parameterised WHERE produces invalid SQL.

function agentRowToRecord(r) {
	return {
		name: r.name,
		description: r.description,
		agentId: r.id,
		meta: r.meta,
		ownerFallback: r.wallet_address,
		avatar: r.storage_key
			? {
					storage_key: r.storage_key,
					visibility: r.visibility,
					content_type: r.content_type,
					thumbnail_key: r.thumbnail_key,
				}
			: null,
	};
}

async function resolveAgentById(id) {
	const [r] = await sql`
		SELECT ai.id, ai.name, ai.description, ai.wallet_address, ai.meta,
		       av.storage_key, av.visibility, av.content_type, av.thumbnail_key
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.id = ${id} AND ai.deleted_at IS NULL
		LIMIT 1
	`;
	return r ? agentRowToRecord(r) : null;
}

async function resolveByMint(mint) {
	const [r] = await sql`
		SELECT ai.id, ai.name, ai.description, ai.wallet_address, ai.meta,
		       av.storage_key, av.visibility, av.content_type, av.thumbnail_key
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.deleted_at IS NULL
		  AND (ai.meta->>'sol_mint_address' = ${mint}
		       OR ai.meta->'onchain'->>'sol_asset' = ${mint}
		       OR ai.meta->'devnet'->>'sol_mint_address' = ${mint})
		LIMIT 1
	`;
	if (r) return agentRowToRecord(r);

	// Not in our DB — read the asset on-chain and back-resolve via its URI,
	// which for three.ws agents points at /api/agents/<uuid>/registration.
	for (const network of ['mainnet', 'devnet']) {
		let asset;
		try {
			asset = await fetchAssetV1(readUmi(network), umiPublicKey(mint));
		} catch {
			continue;
		}
		const uri = asset?.uri || '';
		const m = uri.match(/\/api\/agents\/([0-9a-f-]{36})\b/i);
		if (m) {
			const rec = await resolveAgentById(m[1]);
			if (rec) return rec;
		}
		// Real on-chain asset that isn't a three.ws agent: surface its identity
		// without a model rather than a false not-found.
		return {
			name: asset?.name || null,
			description: '',
			agentId: null,
			meta: {
				sol_mint_address: mint,
				network,
				onchain: { owner: asset?.owner?.toString?.() || null },
			},
			ownerFallback: asset?.owner?.toString?.() || null,
			avatar: null,
		};
	}
	return null;
}

// Avatar resolution (by UUID or slug) prefers a deployed agent linked to the
// avatar so an avatar id / slug resolves to the same on-chain view as the mint.
function avatarRowToRecord(r) {
	return {
		name: r.agent_name || r.name,
		description: r.agent_description || r.description,
		agentId: r.agent_id || null,
		meta: r.agent_meta || null,
		ownerFallback: r.agent_wallet || null,
		avatar: {
			storage_key: r.storage_key,
			visibility: r.visibility,
			content_type: r.content_type,
			thumbnail_key: r.thumbnail_key,
		},
	};
}

async function resolveAvatarById(id) {
	const [r] = await sql`
		SELECT av.id, av.name, av.description, av.slug, av.storage_key, av.visibility,
		       av.content_type, av.thumbnail_key,
		       ai.id AS agent_id, ai.name AS agent_name, ai.description AS agent_description,
		       ai.wallet_address AS agent_wallet, ai.meta AS agent_meta
		FROM avatars av
		LEFT JOIN LATERAL (
			SELECT id, name, description, wallet_address, meta
			FROM agent_identities
			WHERE avatar_id = av.id AND deleted_at IS NULL
			ORDER BY (meta->>'sol_mint_address') IS NOT NULL DESC, created_at ASC
			LIMIT 1
		) ai ON true
		WHERE av.id = ${id} AND av.deleted_at IS NULL
		LIMIT 1
	`;
	return r ? avatarRowToRecord(r) : null;
}

async function resolveBySlug(slug) {
	// Slug is unique per owner, so a bare slug can match several avatars; prefer
	// a public one, then the earliest. Never matches a private avatar (a public
	// lookup must not leak that a private slug exists).
	const [r] = await sql`
		SELECT av.id, av.name, av.description, av.slug, av.storage_key, av.visibility,
		       av.content_type, av.thumbnail_key,
		       ai.id AS agent_id, ai.name AS agent_name, ai.description AS agent_description,
		       ai.wallet_address AS agent_wallet, ai.meta AS agent_meta
		FROM avatars av
		LEFT JOIN LATERAL (
			SELECT id, name, description, wallet_address, meta
			FROM agent_identities
			WHERE avatar_id = av.id AND deleted_at IS NULL
			ORDER BY (meta->>'sol_mint_address') IS NOT NULL DESC, created_at ASC
			LIMIT 1
		) ai ON true
		WHERE av.slug = ${slug}
		  AND av.deleted_at IS NULL
		  AND av.visibility IN ('public', 'unlisted')
		ORDER BY av.created_at ASC
		LIMIT 1
	`;
	return r ? avatarRowToRecord(r) : null;
}

// ── handler ─────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const q = (req.query?.q || new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
	if (!q) return error(res, 400, 'validation_error', 'q is required');
	if (q.length > 64) return error(res, 400, 'validation_error', 'q is too long');

	let record = null;
	if (isUuid(q)) {
		record = (await resolveAgentById(q)) || (await resolveAvatarById(q));
	} else if (PUBKEY_RE.test(q)) {
		record = await resolveByMint(q);
	} else {
		record = await resolveBySlug(q);
	}

	if (!record) {
		return json(res, 200, {
			name: null,
			description: '',
			agentId: null,
			genesisRank: null,
			modelUrl: null,
			imageUrl: null,
			onchain: null,
			state: 'not_found',
		});
	}

	const result = await build(record);
	return json(res, 200, result, {
		'cache-control': 'public, max-age=30, s-maxage=120, stale-while-revalidate=600',
	});
});
