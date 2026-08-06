// GET /api/deployments — the on-chain agent deployment feed: every agent that
// lands on-chain, the moment it does, across every supported chain.
//
// Two real on-chain sources are folded into one chronological stream — NO
// synthetic entries:
//   • EVM   — ERC-8004 Identity Registry registrations crawled from chain logs
//             into `erc8004_agents_index` (api/cron/erc8004-crawl.js).
//   • Solana — Metaplex Core agent mints. Two upstreams:
//       · three.ws's own mints in `agent_identities` (meta.chain_type='solana'),
//         minted into the "three.ws Agents" Metaplex collection + Agent Registry
//         by api/_lib/onchain-deploy.js.
//       · the external Metaplex Agent Registry crawled into `solana_agents_index`
//         (source='metaplex'); deduped against our own mints by Core asset pubkey.
// If a chain is quiet, the feed is honestly empty.
//
// Views:
//   GET /api/deployments                  — live feed, keyset paginated (newest first)
//   GET /api/deployments?cursor=<c>       — load older
//   GET /api/deployments?view=stats       — aggregate registry intelligence
//
// Filters: network=mainnet|testnet, chain=<chainId>, kind=all|3d|x402.
// Solana appears as a chain: mainnet-beta=101, devnet=103 (Solana cluster indices).

import { sql, isDbUnavailableError } from './_lib/db.js';
import { cors, json, method, error, serverError, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { cacheGet, cacheSet } from './_lib/cache.js';
import { publicUrl } from './_lib/r2.js';
import { CHAINS, CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';

const FEED_TTL_S = 20; // feed page cache — registrations land in minutes, not seconds
const STATS_TTL_S = 60; // aggregate stats cache
const MAX_LIMIT = 60;

// Solana cluster indices double as our synthetic chain ids so the feed, cursor,
// network toggle, and top-chains panel treat Solana like any other chain.
const SOLANA_MAINNET_CHAIN_ID = 101;
const SOLANA_DEVNET_CHAIN_ID = 103;
const SOLANA_CHAIN_IDS = new Set([SOLANA_MAINNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID]);

// Chain-id sets per network class, derived once from the canonical chain table so
// the network toggle never drifts from the deployed registries. Solana joins each
// class as an extra id (mainnet-beta on mainnet, devnet on testnet).
const MAINNET_CHAIN_IDS = CHAINS.filter((c) => !c.testnet).map((c) => c.id);
const TESTNET_CHAIN_IDS = CHAINS.filter((c) => c.testnet).map((c) => c.id);

function txExplorerUrl(chainId, tx) {
	const c = CHAIN_BY_ID[chainId];
	return c && tx ? `${c.explorer}/tx/${tx}` : null;
}

// ── Solana explorer + chain attribution ──────────────────────────────────────
function isSolanaChain(chainId) {
	return SOLANA_CHAIN_IDS.has(chainId);
}
function solanaTxUrl(chainId, sig) {
	if (!sig) return null;
	return chainId === SOLANA_DEVNET_CHAIN_ID
		? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
		: `https://solscan.io/tx/${sig}`;
}
function solanaAssetUrl(chainId, asset) {
	if (!asset) return null;
	return chainId === SOLANA_DEVNET_CHAIN_ID
		? `https://explorer.solana.com/address/${asset}?cluster=devnet`
		: `https://solscan.io/token/${asset}`;
}
function solanaAccountUrl(chainId, addr) {
	if (!addr) return null;
	return chainId === SOLANA_DEVNET_CHAIN_ID
		? `https://explorer.solana.com/address/${addr}?cluster=devnet`
		: `https://solscan.io/account/${addr}`;
}
function chainNameFor(chainId) {
	if (chainId === SOLANA_MAINNET_CHAIN_ID) return 'Solana';
	if (chainId === SOLANA_DEVNET_CHAIN_ID) return 'Solana Devnet';
	return CHAIN_BY_ID[chainId]?.name || `Chain ${chainId}`;
}
function chainExplorerFor(chainId) {
	if (chainId === SOLANA_MAINNET_CHAIN_ID) return 'https://solscan.io';
	if (chainId === SOLANA_DEVNET_CHAIN_ID) return 'https://explorer.solana.com';
	return CHAIN_BY_ID[chainId]?.explorer || null;
}

// Keyset cursor = base64("<epoch_ms>|<chain_id>|<agent_id>"). Ordering on
// (registered_at, chain_id, agent_id) gives a stable total order so paging never
// skips or repeats a row even as the crawler inserts concurrently.
function encodeCursor(tsIso, chainId, agentId) {
	const ms = new Date(tsIso).getTime();
	return Buffer.from(`${ms}|${chainId}|${agentId}`, 'utf8').toString('base64url');
}
function decodeCursor(raw) {
	if (!raw || typeof raw !== 'string') return null;
	try {
		const [ms, chainId, agentId] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
		const n = Number(ms);
		const cid = Number(chainId);
		if (!Number.isFinite(n) || !Number.isFinite(cid) || !agentId) return null;
		return { ts: new Date(n).toISOString(), chainId: cid, agentId };
	} catch {
		return null;
	}
}

// Shape one feed row (EVM or Solana) into the public deployment event the client
// renders. Pure. The `family` discriminator decides explorer-URL construction.
function shapeRow(r) {
	if (r.family === 'solana') {
		const asset = r.asset || r.agent_id;
		return {
			chain_id: r.chain_id,
			chain: chainNameFor(r.chain_id),
			testnet: r.chain_id === SOLANA_DEVNET_CHAIN_ID,
			family: 'solana',
			agent_id: r.agent_id,
			name: r.name || null,
			description: r.description || null,
			image: r.image || (r.image_key ? publicUrl(r.image_key) : null),
			owner: r.owner || null,
			has_3d: !!r.has_3d,
			x402_support: !!r.x402_support,
			registered_at: r.registered_at,
			agent_explorer: solanaAssetUrl(r.chain_id, asset),
			owner_explorer: solanaAccountUrl(r.chain_id, r.owner),
			tx_explorer: solanaTxUrl(r.chain_id, r.registered_tx),
		};
	}
	const chain = CHAIN_BY_ID[r.chain_id] || null;
	return {
		chain_id: r.chain_id,
		chain: chain ? chain.name : `Chain ${r.chain_id}`,
		testnet: chain ? !!chain.testnet : false,
		family: 'evm',
		agent_id: r.agent_id,
		name: r.name || null,
		description: r.description || null,
		image: r.image || null,
		owner: r.owner || null,
		has_3d: !!r.has_3d,
		x402_support: !!r.x402_support,
		registered_at: r.registered_at,
		agent_explorer: tokenExplorerUrl(r.chain_id, r.agent_id),
		owner_explorer: r.owner ? addressExplorerUrl(r.chain_id, r.owner) : null,
		tx_explorer: txExplorerUrl(r.chain_id, r.registered_tx),
	};
}

function evmChainIdsFor(network) {
	return network === 'testnet' ? TESTNET_CHAIN_IDS : MAINNET_CHAIN_IDS;
}

// ── source fragments ─────────────────────────────────────────────────────────
// Each returns a SELECT producing the common feed shape. Composed via UNION ALL
// into one CTE so the keyset cursor orders a single unified stream. `registered_at`
// is left nullable here (totals count untimed rows; the feed view filters them).
function evmSource(evmChainIds) {
	return sql`
		SELECT 'evm'::text AS family, e.chain_id, e.agent_id, e.owner,
		       e.name, e.description, e.image, NULL::text AS image_key,
		       e.has_3d, e.x402_support, e.registered_at, e.registered_tx,
		       NULL::text AS asset
		FROM erc8004_agents_index e
		WHERE e.active = true
		  AND e.chain_id = ANY(${evmChainIds})
	`;
}

// three.ws's own Metaplex Core mints. Mainnet fields live at the top of `meta`;
// devnet is isolated under meta.devnet (see api/_lib/onchain-deploy.js).
function solanaOwnSource(network) {
	if (network === 'testnet') {
		return sql`
			SELECT 'solana'::text AS family, ${SOLANA_DEVNET_CHAIN_ID}::int AS chain_id,
			       COALESCE(ai.meta->'devnet'->>'sol_mint_address', ai.meta->>'sol_mint_address') AS agent_id,
			       COALESCE(ai.meta->'devnet'->'onchain'->>'owner', ai.meta->'onchain'->>'wallet',
			                ai.meta->'onchain'->>'owner', ai.wallet_address) AS owner,
			       ai.name, ai.description, ai.profile_image_url AS image,
			       av.thumbnail_key AS image_key,
			       (ai.avatar_id IS NOT NULL) AS has_3d,
			       ((ai.meta->'payments'->>'configured') = 'true') AS x402_support,
			       COALESCE((ai.meta->'devnet'->'onchain'->>'confirmed_at')::timestamptz,
			                (ai.meta->'onchain'->>'confirmed_at')::timestamptz, ai.created_at) AS registered_at,
			       COALESCE(ai.meta->'devnet'->'onchain'->>'tx_hash', ai.meta->'onchain'->>'tx_hash',
			                ai.meta->>'tx_signature') AS registered_tx,
			       COALESCE(ai.meta->'devnet'->>'sol_mint_address', ai.meta->>'sol_mint_address') AS asset
			FROM agent_identities ai
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			WHERE ai.deleted_at IS NULL
			  AND (ai.meta->'devnet'->>'sol_mint_address' IS NOT NULL
			       OR (ai.meta->>'network' = 'devnet' AND ai.meta->>'sol_mint_address' IS NOT NULL))
		`;
	}
	return sql`
		SELECT 'solana'::text AS family, ${SOLANA_MAINNET_CHAIN_ID}::int AS chain_id,
		       ai.meta->>'sol_mint_address' AS agent_id,
		       COALESCE(ai.meta->'onchain'->>'wallet', ai.meta->'onchain'->>'owner', ai.wallet_address) AS owner,
		       ai.name, ai.description, ai.profile_image_url AS image,
		       av.thumbnail_key AS image_key,
		       (ai.avatar_id IS NOT NULL) AS has_3d,
		       ((ai.meta->'payments'->>'configured') = 'true') AS x402_support,
		       COALESCE((ai.meta->'onchain'->>'confirmed_at')::timestamptz, ai.created_at) AS registered_at,
		       COALESCE(ai.meta->'onchain'->>'tx_hash', ai.meta->>'tx_signature') AS registered_tx,
		       ai.meta->>'sol_mint_address' AS asset
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.deleted_at IS NULL
		  AND ai.meta->>'chain_type' = 'solana'
		  AND ai.meta->>'network' = 'mainnet'
		  AND ai.meta->>'sol_mint_address' IS NOT NULL
	`;
}

// The external Metaplex Agent Registry. Deduped against our own mints by Core
// asset pubkey — an agent we launched AND registered upstream appears once.
function solanaExternalSource(network) {
	const net = network === 'testnet' ? 'devnet' : 'mainnet';
	const chainId = network === 'testnet' ? SOLANA_DEVNET_CHAIN_ID : SOLANA_MAINNET_CHAIN_ID;
	return sql`
		SELECT 'solana'::text AS family, ${chainId}::int AS chain_id,
		       COALESCE(s.asset, s.ref) AS agent_id, s.owner,
		       s.name, s.description, s.image, NULL::text AS image_key,
		       s.has_3d, s.x402_support, s.registered_at, NULL::text AS registered_tx,
		       s.asset
		FROM solana_agents_index s
		WHERE s.active = true
		  AND s.source = 'metaplex'
		  AND s.network = ${net}
		  AND NOT EXISTS (
		    SELECT 1 FROM agent_identities o
		    WHERE o.deleted_at IS NULL
		      AND (o.meta->>'sol_mint_address' = s.asset
		           OR o.meta->'devnet'->>'sol_mint_address' = s.asset)
		  )
	`;
}

// One unified on-chain stream: EVM ⊎ Solana(ours) ⊎ Solana(external Metaplex).
function unionFor(network) {
	const evmChainIds = evmChainIdsFor(network);
	return sql`
		${evmSource(evmChainIds)}
		UNION ALL
		${solanaOwnSource(network)}
		UNION ALL
		${solanaExternalSource(network)}
	`;
}

// ── feed view ───────────────────────────────────────────────────────────────
async function handleFeed({ network, chain, kind, cursor }) {
	const limit = MAX_LIMIT;

	const chainFilter = chain ? sql`AND f.chain_id = ${chain}` : sql``;
	const kindFilter =
		kind === '3d' ? sql`AND f.has_3d = true` : kind === 'x402' ? sql`AND f.x402_support = true` : sql``;

	// Only rows with a known registration time can sit in a chronological feed;
	// untimed rows are counted in stats but never placed in time here (we never
	// invent an order).
	const cur = decodeCursor(cursor);
	const olderBound = cur
		? sql`AND (f.registered_at < ${cur.ts}
			OR (f.registered_at = ${cur.ts} AND f.chain_id < ${cur.chainId})
			OR (f.registered_at = ${cur.ts} AND f.chain_id = ${cur.chainId} AND f.agent_id < ${cur.agentId}))`
		: sql``;

	const rows = await sql`
		WITH feed AS (
			${unionFor(network)}
		)
		SELECT f.* FROM feed f
		WHERE f.registered_at IS NOT NULL
		  ${chainFilter}
		  ${kindFilter}
		  ${olderBound}
		ORDER BY f.registered_at DESC, f.chain_id DESC, f.agent_id DESC
		LIMIT ${limit + 1}
	`;

	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit).map(shapeRow);
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor(last.registered_at, last.chain_id, last.agent_id) : null;

	return {
		deployments: page,
		has_more: hasMore,
		next_cursor: nextCursor,
		network,
		chain: chain || null,
		kind,
	};
}

// ── aggregate stats view ──────────────────────────────────────────────────────
async function handleStats(network) {
	// Headline totals in one pass over the unified stream: registry size,
	// capability mix, deploy tempo. Untimed rows still count toward totals.
	const [totals] = await sql`
		WITH feed AS (
			${unionFor(network)}
		)
		SELECT
			COUNT(*)::int                                                              AS total,
			COUNT(*) FILTER (WHERE has_3d)::int                                        AS with_3d,
			COUNT(*) FILTER (WHERE x402_support)::int                                  AS x402,
			COUNT(DISTINCT chain_id)::int                                             AS chains,
			COUNT(*) FILTER (WHERE registered_at > now() - interval '24 hours')::int  AS d24,
			COUNT(*) FILTER (WHERE registered_at > now() - interval '7 days')::int    AS d7
		FROM feed
	`;

	// Most-populated chains — the registry's footprint at a glance.
	const topChainsRaw = await sql`
		WITH feed AS (
			${unionFor(network)}
		)
		SELECT chain_id, COUNT(*)::int AS n
		FROM feed
		GROUP BY chain_id
		ORDER BY n DESC
		LIMIT 8
	`;

	// 7-day registration series — a zero-filled daily count for the sparkline.
	const series = await sql`
		WITH feed AS (
			${unionFor(network)}
		),
		days AS (
			SELECT generate_series(
				date_trunc('day', now()) - interval '6 days',
				date_trunc('day', now()),
				interval '1 day'
			) AS day
		),
		ev AS (
			SELECT date_trunc('day', registered_at) AS day, COUNT(*)::int AS n
			FROM feed
			WHERE registered_at > date_trunc('day', now()) - interval '6 days'
			GROUP BY 1
		)
		SELECT to_char(days.day, 'Dy')        AS label,
		       to_char(days.day, 'YYYY-MM-DD') AS day,
		       COALESCE(ev.n, 0)               AS registrations
		FROM days
		LEFT JOIN ev ON ev.day = days.day
		ORDER BY days.day
	`;

	const total = Number(totals?.total || 0);
	const topChains = topChainsRaw.map((r) => ({
		chain_id: r.chain_id,
		chain: chainNameFor(r.chain_id),
		count: Number(r.n || 0),
		explorer: chainExplorerFor(r.chain_id),
	}));

	return {
		network,
		total_agents: total,
		active_chains: Number(totals?.chains || 0),
		deployed_24h: Number(totals?.d24 || 0),
		deployed_7d: Number(totals?.d7 || 0),
		with_3d: Number(totals?.with_3d || 0),
		with_3d_pct: total ? Math.round((Number(totals.with_3d) / total) * 100) : 0,
		x402: Number(totals?.x402 || 0),
		x402_pct: total ? Math.round((Number(totals.x402) / total) * 100) : 0,
		top_chains: topChains,
		series_7d: series.map((r) => ({
			label: r.label,
			day: r.day,
			registrations: Number(r.registrations || 0),
		})),
	};
}

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'testnet' ? 'testnet' : 'mainnet';
	const view = url.searchParams.get('view') || 'feed';
	const chainRaw = Number(url.searchParams.get('chain'));
	const chain = Number.isInteger(chainRaw) && chainRaw > 0 ? chainRaw : null;
	const kindRaw = url.searchParams.get('kind');
	const kind = kindRaw === '3d' || kindRaw === 'x402' ? kindRaw : 'all';
	const cursor = url.searchParams.get('cursor');
	if (cursor && !decodeCursor(cursor)) {
		return error(res, 400, 'bad_request', 'invalid cursor');
	}

	try {
		if (view === 'stats') {
			const cacheKey = `deployments:stats:${network}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleStats(network);
				await cacheSet(cacheKey, body, STATS_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=30');
			return json(res, 200, { data: body });
		}

		// First page of the unfiltered global feed is cached briefly to shield the DB
		// from a thundering herd; filtered/paged requests hit the DB directly.
		const isFirstGlobalPage = !cursor && !chain && kind === 'all';
		if (isFirstGlobalPage) {
			const cacheKey = `deployments:feed:${network}`;
			let body = await cacheGet(cacheKey);
			if (body === null) {
				body = await handleFeed({ network, chain, kind, cursor });
				await cacheSet(cacheKey, body, FEED_TTL_S);
			}
			res.setHeader('cache-control', 'public, max-age=12');
			return json(res, 200, { data: body });
		}

		const body = await handleFeed({ network, chain, kind, cursor });
		res.setHeader('cache-control', 'public, max-age=12');
		return json(res, 200, { data: body });
	} catch (e) {
		if (isDbUnavailableError(e)) {
			console.warn('[api/deployments] db unavailable:', e?.message);
			return serverError(res, 503, 'service_unavailable', e);
		}
		console.error('[api/deployments] failed', e?.message, e?.stack);
		return serverError(res, 502, 'deployments_failed', e);
	}
}
