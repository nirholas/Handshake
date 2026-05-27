/**
 * SSR entry-point for discover detail pages
 * -----------------------------------------
 * GET /api/discover-detail?kind=onchain&chain=<id>&id=<agentId>
 * GET /api/discover-detail?kind=avatar&id=<avatarId>
 *
 * Wired to /discover/a/:chainId/:agentId and /discover/avatar/:id via vercel.json.
 *
 * Returns the detail.html shell with Open Graph + Twitter Card meta tags already
 * baked into the <head>, so link unfurlers (Slack, Discord, X, iMessage) get a
 * real preview. Browsers receive the same HTML; the inline __DETAIL_ITEM__ data
 * lets detail.js render without a second API round-trip.
 */

import { sql } from './_lib/db.js';
import { cors, wrap } from './_lib/http.js';
import { CHAIN_BY_ID, tokenExplorerUrl, addressExplorerUrl } from './_lib/erc8004-chains.js';
import { publicUrl } from './_lib/r2.js';
import { DEMO_AVATARS } from './_lib/demo-avatars.js';
import { env } from './_lib/env.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const kind = url.searchParams.get('kind');
	const id = url.searchParams.get('id');
	const origin = env.APP_ORIGIN;

	let item = null;
	let canonicalUrl = origin;
	let ogImageUrl = `${origin}/og-image.png`;

	if (kind === 'onchain') {
		const chainId = parseInt(url.searchParams.get('chain') || '', 10);
		if (!Number.isFinite(chainId) || !id) return sendShell(res, origin, null, null, null);

		const rows = await sql`
			SELECT chain_id, agent_id, owner, name, description, image, glb_url,
			       has_3d, x402_support, registered_at, registered_tx,
			       services, agent_uri
			FROM erc8004_agents_index
			WHERE active = true AND chain_id = ${chainId} AND agent_id = ${parseInt(id, 10)}
			LIMIT 1
		`.catch(() => []);

		if (rows.length) {
			const r = rows[0];
			const chain = CHAIN_BY_ID[r.chain_id];
			item = {
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
			canonicalUrl = `${origin}/discover/a/${chainId}/${id}`;
			ogImageUrl = `${origin}/api/a-og?chain=${chainId}&id=${encodeURIComponent(id)}`;
		}
	} else if (kind === 'solana') {
		const asset = url.searchParams.get('asset');
		if (!asset) return sendShell(res, origin, null, null, null);

		const rows = await sql`
			SELECT ai.id, ai.name, ai.description, ai.wallet_address, ai.skills,
			       ai.meta, ai.created_at,
			       a.thumbnail_key AS avatar_thumb
			FROM agent_identities ai
			LEFT JOIN avatars a ON a.id = ai.avatar_id AND a.deleted_at IS NULL
			WHERE ai.deleted_at IS NULL
			  AND ai.meta->>'chain_type' = 'solana'
			  AND ai.meta->>'sol_mint_address' = ${asset}
			LIMIT 1
		`.catch(() => []);

		if (rows.length) {
			const r = rows[0];
			const network = r.meta?.network || 'mainnet';
			const thumb = r.avatar_thumb ? publicUrl(r.avatar_thumb) : null;
			item = {
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
				explorerUrl: `https://solscan.io/token/${asset}`,
				ownerExplorerUrl: r.wallet_address ? `https://solscan.io/account/${r.wallet_address}` : null,
			};
			canonicalUrl = `${origin}/discover/a/sol/${asset}`;
			ogImageUrl = thumb || `${origin}/og-image.png`;
		}
	} else if (kind === 'avatar') {
		if (!id) return sendShell(res, origin, null, null, null);

		// Demo avatar
		const demo = DEMO_AVATARS.find((a) => String(a.avatarId) === String(id));
		if (demo) {
			item = demo;
		} else {
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
				WHERE a.deleted_at IS NULL AND a.visibility = 'public' AND a.id = ${id}
				LIMIT 1
			`.catch(() => []);

			if (rows.length) {
				const r = rows[0];
				const glb = publicUrl(r.storage_key);
				const handle = r.owner_username
					? `@${r.owner_username}`
					: r.owner_wallet
						? shortAddr(r.owner_wallet)
						: null;
				item = {
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
			}
		}

		if (item) {
			canonicalUrl = `${origin}/avatars/${id}`;
			ogImageUrl = `${origin}/api/avatar/${id}/og`;
		}
	}

	return sendShell(res, origin, item, canonicalUrl, ogImageUrl);
});

function sendShell(res, origin, item, canonicalUrl, ogImageUrl) {
	const title = item ? `${item.name} · three.ws` : 'three.ws';
	const desc = item?.description || (item ? `${item.name} on three.ws` : 'Discover agents on three.ws');
	const canonical = canonicalUrl || `${origin}/discover`;
	const ogImg = ogImageUrl || `${origin}/og-image.png`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', item
		? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
		: 'public, max-age=10',
	);

	res.end(`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="X-UA-Compatible" content="IE=edge" />
	<title>${esc(title)}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
	<meta name="description" content="${esc(desc)}" />
	<meta name="theme-color" content="#000000" />

	<meta property="og:type" content="profile" />
	<meta property="og:site_name" content="three.ws" />
	<meta property="og:title" content="${esc(title)}" />
	<meta property="og:description" content="${esc(desc)}" />
	<meta property="og:url" content="${esc(canonical)}" />
	<meta property="og:image" content="${esc(ogImg)}" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="${esc(title)}" />
	<meta name="twitter:description" content="${esc(desc)}" />
	<meta name="twitter:image" content="${esc(ogImg)}" />

	<link rel="canonical" href="${esc(canonical)}" />
	<link rel="shortcut icon" href="/favicon.ico" />
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
	<link rel="stylesheet" href="/style.css" />
	<link rel="stylesheet" href="/nav.css" />
	<link rel="stylesheet" href="/discover/detail.css" />
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" />
	${item ? `<script>window.__DETAIL_ITEM__ = ${JSON.stringify(item).replace(/</g, '\\u003c')};</script>` : ''}
</head>
<body class="features-page detail-page">
	<header>
		<div id="nav-container"></div>
	</header>
	<script src="/nav.js"></script>

	<main class="detail-main" data-role="main">
		<div class="detail-loading" data-role="loading">
			<div class="detail-skeleton detail-skeleton--hero"></div>
			<div class="detail-skeleton detail-skeleton--title"></div>
			<div class="detail-skeleton detail-skeleton--body"></div>
		</div>

		<div class="detail-error" data-role="error" hidden>
			<div class="detail-error-icon">⚠</div>
			<h2 data-role="error-title">Not found</h2>
			<p data-role="error-msg">This item could not be loaded.</p>
			<a href="/discover" class="detail-btn">← Back to Discover</a>
		</div>

		<div class="detail-content" data-role="content" hidden>
			<nav class="detail-breadcrumb">
				<a href="/discover" class="detail-breadcrumb-link" data-role="back-link">← Discover</a>
			</nav>

			<div class="detail-hero">
				<div class="detail-hero-media" data-role="hero-media"></div>
				<div class="detail-hero-body">
					<div class="detail-badges" data-role="badges"></div>
					<h1 class="detail-name" data-role="name"></h1>
					<p class="detail-desc" data-role="desc" hidden></p>
					<div class="detail-meta-row" data-role="meta-row"></div>
					<div class="detail-actions" data-role="actions"></div>
				</div>
			</div>

			<div class="detail-viewer-wrap" data-role="viewer-wrap" hidden>
				<div class="detail-section-label">3D Preview</div>
				<div class="detail-viewer" data-role="viewer"></div>
			</div>

			<div class="detail-panels">
				<div class="detail-panel" data-role="services-panel" hidden>
					<div class="detail-panel-head">
						<span class="detail-panel-title">Services</span>
						<span class="detail-panel-badge" data-role="service-count">0</span>
					</div>
					<ul class="detail-services" data-role="services"></ul>
				</div>

				<div class="detail-panel" data-role="tags-panel" hidden>
					<div class="detail-panel-head">
						<span class="detail-panel-title">Tags</span>
					</div>
					<div class="detail-tags" data-role="tags"></div>
				</div>

				<div class="detail-panel" data-role="onchain-panel" hidden>
					<div class="detail-panel-head">
						<span class="detail-panel-title">On-chain details</span>
					</div>
					<dl class="detail-dl" data-role="onchain-dl"></dl>
				</div>

				<div class="detail-panel" data-role="avatar-panel" hidden>
					<div class="detail-panel-head">
						<span class="detail-panel-title">Details</span>
					</div>
					<dl class="detail-dl" data-role="avatar-dl"></dl>
				</div>

				<div class="detail-panel" data-role="embed-panel" hidden>
					<div class="detail-panel-head">
						<span class="detail-panel-title">Embed</span>
					</div>
					<div class="detail-embed-tabs" data-role="embed-tabs"></div>
					<div class="detail-embed-panes" data-role="embed-panes"></div>
				</div>
			</div>
		</div>
	</main>

	<script type="module" src="/discover/detail.js"></script>
</body>
</html>`);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
