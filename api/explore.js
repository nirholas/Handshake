/**
 * GET /api/explore — paginated directory of ERC-8004 agents + public avatars.
 *
 * Query params:
 *   only3d=1       — only rows where has_3d = true (avatars are always 3D)
 *   chain=<id>     — filter by chainId (excludes public avatars; they're off-chain)
 *   q=<text>       — name/description substring
 *   cursor=<iso>   — created_at/registered_at ISO string for pagination
 *   limit=<int>    — page size, default 24, max 60
 *   source=<all|onchain|avatar|solana> — restrict feed to one source. Default 'all'.
 *   quality=<all|high> — avatar quality filter. 'high' (default) hides
 *                        autonamed/filename-like junk and surfaces named
 *                        community + curated avatars first.
 */

// Names we never want surfaced in marketplace-quality views. Mirrors the
// auto-naming patterns used by the avatar editor and by raw filename uploads
// (mo-prefixed short IDs, draft slugs, UUIDs, "Avatar #abcd12", etc.).
const NAME_AUTONAMED_RE =
	/^(Avatar #[0-9a-f]{6}|Avatar \d+\/\d+\/\d{4}.*|mo[a-z0-9]{4,}|draft-[a-z0-9]+|[a-f0-9-]{30,}|new_project_\d+|TEST|test|Untitled.*)$/i;

function isAutoNamed(name) {
	if (!name || !name.trim()) return true;
	return NAME_AUTONAMED_RE.test(name.trim());
}

import { sql } from './_lib/db.js';
import { cacheWrap } from './_lib/cache.js';
import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';
// thumbnailUrl() drops keys that can't resolve to a real image (see r2.js) so a
// gallery renders its placeholder instead of a 404 the browser blocks as ORB.
import { publicUrl, thumbnailUrl } from './_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const only3d = url.searchParams.get('only3d') === '1';
	const chainId = parseInt(url.searchParams.get('chain') || '', 10);
	// Strip NUL and other C0/C1 control characters before the value reaches
	// Postgres: a NUL or invalid byte in the search term throws "invalid byte
	// sequence for encoding UTF8" (22021) out of the ILIKE query → an unhandled
	// 500 on a public endpoint.
	const q = (url.searchParams.get('q') || '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
		.trim()
		.slice(0, 80);
	const cursor = url.searchParams.get('cursor');
	// parseInt('test') is NaN, and Math.min/max propagate NaN — which then reaches
	// the LIMIT bigint parameter and throws 22P02 ("invalid input syntax for type
	// bigint: NaN") on this public endpoint. Coerce non-numeric input to the default.
	const limitRaw = parseInt(url.searchParams.get('limit') || '24', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 250) : 24;
	const sourceFilter = url.searchParams.get('source') || 'all';
	const quality = url.searchParams.get('quality') === 'all' ? 'all' : 'high';

	// model_category filter — null means 'all categories'. Accepts a single
	// category or a comma-separated list (e.g. category=avatar,creature) so a
	// caller can scope a feed to character-like models without dropping creatures.
	const VALID_CATEGORIES = new Set(['avatar', 'accessory', 'item', 'scene', 'creature', 'vehicle', 'other']);
	const categoryFilterList = (url.searchParams.get('category') || '')
		.split(',')
		.map((c) => c.trim())
		.filter(Boolean);
	const invalidCategory = categoryFilterList.find((c) => !VALID_CATEGORIES.has(c));
	if (invalidCategory) {
		return error(res, 400, 'validation_error', `unknown category: ${invalidCategory}`);
	}
	const categoryFilter = categoryFilterList.length ? categoryFilterList : null;

	const cursorDate = cursor ? new Date(cursor) : null;
	if (cursor && isNaN(cursorDate?.getTime())) {
		return error(res, 400, 'validation_error', 'cursor must be an ISO date');
	}

	// Setting a chainId implicitly excludes avatars (they're off-chain).
	// `source=agents` is the agent-directory meta-source: every on-chain agent
	// (EVM + Solana, ours and external) but no avatars — what /agents renders.
	const agentsView = sourceFilter === 'agents';
	const includeOnchain = sourceFilter === 'all' || sourceFilter === 'onchain' || agentsView;
	const includeAvatars = (sourceFilter === 'all' || sourceFilter === 'avatar') && !Number.isFinite(chainId);
	const includeSolana = sourceFilter === 'all' || sourceFilter === 'solana' || agentsView;
	// External Solana agents (Metaplex Agent Registry + AgenC) are off the EVM
	// chains entirely, so a chainId filter excludes them.
	const includeExternalSolana = (sourceFilter === 'all' || sourceFilter === 'solana' || agentsView) && !Number.isFinite(chainId);

	// Filter construction via template fragments kept inline because Neon's
	// tagged-template driver doesn't compose them the way pg.Client does; a
	// single query with optional predicates guarded by nulls is clearer.
	// The three source feeds are independent — run them concurrently so the
	// endpoint's DB time is the slowest single query, not the sum of all three.
	// A leading-wildcard ILIKE scan on one source no longer serializes in front of
	// the others, which is what pushed slow searches past the function budget → 504.
	const [onchainRows, avatarRows, solanaRows, externalSolanaRows] = await Promise.all([
		includeOnchain
			? sql`
		SELECT chain_id, agent_id, owner, name, description, image, glb_url,
		       has_3d, x402_support, registered_at, registered_tx,
		       services, agent_uri
		FROM erc8004_agents_index
		WHERE active = true
		  AND (${only3d ? true : null}::boolean IS NULL OR has_3d = true)
		  AND (${Number.isFinite(chainId) ? chainId : null}::integer IS NULL OR chain_id = ${Number.isFinite(chainId) ? chainId : null})
		  AND (${q || null}::text IS NULL OR (
		       coalesce(name,'') ILIKE ${'%' + q + '%'}
		    OR coalesce(description,'') ILIKE ${'%' + q + '%'}
		  ))
		  AND (${cursorDate ? cursorDate.toISOString() : null}::timestamptz IS NULL OR registered_at < ${cursorDate ? cursorDate.toISOString() : null}::timestamptz)
		ORDER BY registered_at DESC NULLS LAST
		LIMIT ${limit + 1}
	`
			: [],
		includeAvatars
			? sql`
		SELECT a.id, a.slug, a.name, a.description, a.storage_key, a.thumbnail_key,
		       a.tags, a.created_at, a.source, a.model_category,
		       coalesce(a.featured, false)   AS featured,
		       coalesce(a.view_count, 0)     AS view_count,
		       u.username AS owner_username,
		       u.display_name AS owner_display_name,
		       u.wallet_address AS owner_wallet,
		       ap.amount        AS price_amount,
		       ap.currency_mint AS price_currency_mint,
		       ap.chain         AS price_chain,
		       ap.mint_decimals AS price_mint_decimals
		FROM avatars a
		LEFT JOIN users u ON u.id = a.owner_id AND u.deleted_at IS NULL
		LEFT JOIN asset_prices ap
		       ON ap.item_type = 'avatar' AND ap.item_id = a.id AND ap.is_active = true
		WHERE a.deleted_at IS NULL
		  AND a.visibility = 'public'
		  AND (${q || null}::text IS NULL OR (
		       coalesce(a.name,'') ILIKE ${'%' + q + '%'}
		    OR coalesce(a.description,'') ILIKE ${'%' + q + '%'}
		  ))
		  AND (${categoryFilter}::text[] IS NULL OR a.model_category = ANY(${categoryFilter}::text[]))
		  AND (${cursorDate ? cursorDate.toISOString() : null}::timestamptz IS NULL OR a.created_at < ${cursorDate ? cursorDate.toISOString() : null}::timestamptz)
		ORDER BY coalesce(a.featured, false) DESC, a.created_at DESC
		LIMIT ${(limit + 1) * 3}
	`
			: [],
		includeSolana
			? sql`
		SELECT ai.id, ai.name, ai.description, ai.wallet_address, ai.skills,
		       ai.meta, ai.created_at,
		       a.thumbnail_key AS avatar_thumb
		FROM agent_identities ai
		LEFT JOIN avatars a ON a.id = ai.avatar_id AND a.deleted_at IS NULL
		WHERE ai.deleted_at IS NULL
		  AND ai.meta->>'chain_type' = 'solana'
		  AND ai.meta->>'network' = 'mainnet'
		  AND (${q || null}::text IS NULL OR (
		       coalesce(ai.name,'') ILIKE ${'%' + q + '%'}
		    OR coalesce(ai.description,'') ILIKE ${'%' + q + '%'}
		  ))
		  AND (${cursorDate ? cursorDate.toISOString() : null}::timestamptz IS NULL OR ai.created_at < ${cursorDate ? cursorDate.toISOString() : null}::timestamptz)
		ORDER BY ai.created_at DESC NULLS LAST
		LIMIT ${limit + 1}
	`
			: [],
		includeExternalSolana
			? sql`
		SELECT source, ref, owner, asset, agent_id, name, description, image, glb_url,
		       endpoint, capabilities, reputation, status, has_3d, x402_support,
		       registered_at
		FROM solana_agents_index
		WHERE active = true
		  AND (${q || null}::text IS NULL OR (
		       coalesce(name,'') ILIKE ${'%' + q + '%'}
		    OR coalesce(description,'') ILIKE ${'%' + q + '%'}
		  ))
		  AND (${cursorDate ? cursorDate.toISOString() : null}::timestamptz IS NULL OR registered_at < ${cursorDate ? cursorDate.toISOString() : null}::timestamptz)
		ORDER BY registered_at DESC NULLS LAST
		LIMIT ${limit + 1}
	`
			: [],
	]);

	const onchainItems = onchainRows.map((r) => {
		const chain = CHAIN_BY_ID[r.chain_id];
		return {
			kind: 'onchain',
			sortDate: r.registered_at,
			chainId: r.chain_id,
			chainName: chain?.name || `Chain ${r.chain_id}`,
			chainShortName: chain?.name || `#${r.chain_id}`,
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
			tokenExplorerUrl: tokenExplorerUrl(r.chain_id, r.agent_id),
			ownerExplorerUrl: addressExplorerUrl(r.chain_id, r.owner),
			viewerUrl: r.glb_url ? `/app#model=${encodeURIComponent(r.glb_url)}` : null,
			services: (r.services || []).map((s) => ({
				name: s?.name || null,
				endpoint: s?.endpoint || null,
				version: s?.version || null,
			})),
		};
	});

	const solanaItems = solanaRows.map((r) => {
		const asset = r.meta?.sol_mint_address;
		const thumb = thumbnailUrl(r.avatar_thumb);
		return {
			kind: 'solana',
			source: 'three.ws',
			sortDate: r.created_at,
			asset,
			agentId: r.id,
			name: r.name || 'Solana Agent',
			description: r.description || '',
			image: thumb,
			has3d: !!r.avatar_thumb,
			skills: r.skills || [],
			owner: r.wallet_address,
			ownerShort: shortAddr(r.wallet_address),
			createdAt: r.created_at,
			viewerUrl: `/agent/${r.id}`,
			explorerUrl: asset ? `https://solscan.io/token/${asset}` : null,
			ownerExplorerUrl: r.wallet_address ? `https://solscan.io/account/${r.wallet_address}` : null,
			network: r.meta?.network || 'mainnet',
		};
	});

	// External Solana agents crawled from the Metaplex Agent Registry + AgenC.
	// Dedup against our own Solana agents by Core-asset pubkey so an agent we
	// launched AND registered upstream doesn't appear twice (ours wins — it has
	// the richer profile + chat history).
	const ownSolanaAssets = new Set(solanaItems.map((s) => s.asset).filter(Boolean));
	const externalSolanaItems = externalSolanaRows
		.filter((r) => !(r.asset && ownSolanaAssets.has(r.asset)))
		.map((r) => {
			const ref = r.asset || r.ref;
			const explorerTarget = r.asset || r.ref;
			return {
				kind: 'solana',
				source: r.source, // 'metaplex' | 'agenc'
				sortDate: r.registered_at,
				asset: r.asset || null,
				agentId: ref,
				name: r.name || (r.source === 'agenc' ? 'AgenC Agent' : 'Metaplex Agent'),
				description: r.description || '',
				image: r.image || null,
				glbUrl: r.glb_url || null,
				has3d: !!r.has_3d,
				x402Support: !!r.x402_support,
				endpoint: r.endpoint || null,
				reputation: r.reputation ?? null,
				skills: [],
				owner: r.owner || null,
				ownerShort: shortAddr(r.owner),
				createdAt: r.registered_at,
				viewerUrl: r.glb_url ? `/app#model=${encodeURIComponent(r.glb_url)}` : null,
				explorerUrl: explorerTarget ? `https://solscan.io/account/${explorerTarget}` : null,
				ownerExplorerUrl: r.owner ? `https://solscan.io/account/${r.owner}` : null,
				network: r.network || 'mainnet',
				external: true,
			};
		});

	let avatarItems = avatarRows.map((r) => {
		const glb = publicUrl(r.storage_key);
		const handle = r.owner_username
			? `@${r.owner_username}`
			: r.owner_wallet
				? shortAddr(r.owner_wallet)
				: null;
		const price = r.price_amount != null
			? {
				amount: String(r.price_amount),
				currency_mint: r.price_currency_mint,
				chain: r.price_chain,
				mint_decimals: r.price_mint_decimals ?? 6,
			}
			: null;
		return {
			kind: 'avatar',
			sortDate: r.created_at,
			avatarId: r.id,
			slug: r.slug,
			name: r.name,
			description: r.description || '',
			image: thumbnailUrl(r.thumbnail_key),
			glbUrl: glb,
			has3d: true,
			tags: r.tags || [],
			source: r.source || null,
			modelCategory: r.model_category || 'avatar',
			featured: r.featured === true || r.featured === 't',
			viewCount: Number(r.view_count) || 0,
			createdAt: r.created_at,
			viewerUrl: `/app#model=${encodeURIComponent(glb)}`,
			price,
			author: handle
				? {
					handle,
					displayName: r.owner_display_name || r.owner_username || handle,
					profileUrl: r.owner_username ? `/u/${r.owner_username}` : null,
				}
				: null,
			autoNamed: isAutoNamed(r.name),
		};
	});

	// Quality filter: hide auto-named/junk by default. The marketplace UI uses
	// quality=high to populate a "Community Avatars" wall that should look
	// curated, not like a debug dump.
	if (includeAvatars && quality === 'high') {
		avatarItems = avatarItems.filter((a) => !a.autoNamed);
	}
	// Cap to requested limit after filtering (we overfetch above).
	if (avatarItems.length > limit + 1) avatarItems = avatarItems.slice(0, limit + 1);

	const merged = [...onchainItems, ...solanaItems, ...externalSolanaItems, ...avatarItems].sort(
		(a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime(),
	);

	const hasMore = merged.length > limit;
	const items = merged.slice(0, limit);
	const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].sortDate : null;

	// Directory totals are four full-table COUNT(*) scans that are identical for
	// every visitor and change slowly — cache them for 60s so the discover page
	// doesn't re-scan four growing tables on every request.
	const { onchainTotal, onchain3d, avatarTotal, solanaTotal, externalSolanaTotal } = await cacheWrap(
		'explore:totals:v2',
		60,
		async () => {
			const [{ total: onchainTotal }] = await sql`
				SELECT count(*)::text as total FROM erc8004_agents_index WHERE active = true
			`;
			const [{ total3d: onchain3d }] = await sql`
				SELECT count(*)::text as total3d FROM erc8004_agents_index WHERE active = true AND has_3d = true
			`;
			const [{ total: avatarTotal }] = await sql`
				SELECT count(*)::text as total FROM avatars WHERE deleted_at IS NULL AND visibility = 'public'
			`;
			const [{ total: solanaTotal }] = await sql`
				SELECT count(*)::text as total FROM agent_identities
				WHERE deleted_at IS NULL AND meta->>'chain_type' = 'solana' AND meta->>'network' = 'mainnet'
			`;
			const [{ total: externalSolanaTotal }] = await sql`
				SELECT count(*)::text as total FROM solana_agents_index WHERE active = true
			`.catch(() => [{ total: '0' }]);
			return { onchainTotal, onchain3d, avatarTotal, solanaTotal, externalSolanaTotal };
		},
	);
	const avatarCount = Number(avatarTotal);
	const solCount = Number(solanaTotal);
	const extSolCount = Number(externalSolanaTotal || 0);
	const allTotal = Number(onchainTotal) + solCount + extSolCount + avatarCount;
	const threeDTotal = Number(onchain3d) + avatarCount;

	return json(
		res,
		200,
		{
			items,
			nextCursor,
			totals: {
				all: allTotal,
				threeD: threeDTotal,
				onchain: Number(onchainTotal),
				solana: solCount + extSolCount,
				solanaExternal: extSolCount,
				avatars: avatarCount,
			},
		},
		// Public, non-personalized discover feed (incl. the leading-wildcard search
		// scan). CDN-cache by full URL so repeated queries and the firehose of new
		// visitors are served from the edge instead of re-scanning on every hit.
		{ 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' },
	);
});

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
