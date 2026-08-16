/**
 * SSR share page for 3D AI Agent collectible pages
 * -------------------------------------------------
 * GET /api/agent-share?id=<agentId>
 *
 * Wired via vercel.json: /agent/<agentId>/share → /api/agent-share?id=$1
 *
 * Bakes Open Graph + Twitter Card + Farcaster Frame meta into <head> so social
 * crawlers render a rich preview with the agent's name, avatar, and on-chain
 * status. Real browsers are JS-redirected to /agent/<agentId>.
 *
 * OG image: /api/og/agent?id=<agentId> — SVG card with avatar, name, chain badge.
 */

import { sql } from './_lib/db.js';
import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { isUuid } from './_lib/validate.js';

// Chain IDs → human-readable labels for EVM chains
const EVM_CHAIN = { 8453: 'Base', 1: 'Ethereum', 10: 'Optimism', 137: 'Polygon', 42161: 'Arbitrum' };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url    = new URL(req.url, 'http://x');
	const id     = (url.searchParams.get('id') || '').trim();
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!isUuid(id)) return redirect(res, `${origin}/agents`);

	let row;
	try {
		[row] = await sql`
			select i.id, i.name, i.description, i.chain_id,
			       i.erc8004_agent_id, i.meta,
			       a.thumbnail_key, a.storage_key, a.visibility
			from agent_identities i
			left join avatars a on a.id = i.avatar_id and a.deleted_at is null
			where i.id = ${id} and i.deleted_at is null
			limit 1
		`;
	} catch {
		return redirect(res, `${origin}/agent/${encodeURIComponent(id)}`);
	}

	if (!row) return redirect(res, `${origin}/agents`);

	const name        = row.name || 'Agent';
	const description = row.description || `A 3D AI Agent on three.ws`;
	const isOnchain   = Boolean(row.erc8004_agent_id) || Boolean(row.meta?.onchain);

	let chainLabel = null;
	if (isOnchain) {
		const onchainMeta = row.meta?.onchain;
		if (onchainMeta?.chain?.includes('solana')) {
			chainLabel = 'Solana';
		} else if (row.chain_id) {
			chainLabel = EVM_CHAIN[Number(row.chain_id)] || `Chain ${row.chain_id}`;
		} else {
			chainLabel = 'On-chain';
		}
	}

	// Build public thumbnail URL for OG image.
	// Read the bucket domain off process.env rather than env.S3_PUBLIC_DOMAIN: that
	// getter THROWS when the var is unset, so the `|| ${origin}/cdn` fallback below
	// could never run and an unconfigured deployment answered every crawler with a
	// 503 not_configured instead of a share card. Same rule api/og/agent.js follows:
	// a missing bucket domain degrades the image, it never 503s a crawler.
	const CDN_BASE = (process.env.S3_PUBLIC_DOMAIN || '').trim().replace(/\/$/, '') || `${origin}/cdn`;
	const thumbKey  = row.thumbnail_key;
	const thumbVis  = row.visibility;
	const thumbPublic = thumbVis === 'public' || thumbVis === 'unlisted';
	const thumbUrl  = thumbKey && thumbPublic ? `${CDN_BASE}/${thumbKey}` : null;

	// "Share my wallet" variant (?wallet=1) — the OG image becomes the SVG card
	// (which renders the vanity address + lifetime tips), the deep link lands on
	// the wallet view, and the social copy invites a tip/fork. This is the growth
	// loop: a wallet worth screenshotting that links back to pay or fork it.
	const walletShare = url.searchParams.get('wallet') === '1';

	const ogImage  = `${origin}/api/og/agent?id=${encodeURIComponent(id)}`;
	const pageUrl  = `${origin}/agent/${encodeURIComponent(id)}/share${walletShare ? '?wallet=1' : ''}`;
	const deepUrl  = walletShare
		? `${origin}/agent/${encodeURIComponent(id)}/wallet`
		: `${origin}/agent/${encodeURIComponent(id)}`;

	const title = walletShare
		? `Tip ${name}'s wallet · 3D AI Agent · three.ws`
		: isOnchain
			? `${name} · 3D AI Agent on ${chainLabel} · three.ws`
			: `${name} · 3D AI Agent · three.ws`;
	const desc  = walletShare
		? `${name} is a self-custodial 3D AI agent on three.ws. Tip it, or fork it to mint your own wallet.`
		: buildDesc({ description, isOnchain, chainLabel });

	// For a wallet share, always use the SVG card (it carries the wallet identity);
	// otherwise prefer the richer raw thumbnail when the avatar is public.
	const forcedOgImage = walletShare ? ogImage : null;

	// /api/oembed (extractAgentId) only resolves the canonical /agent/:id shape —
	// not the /share or /wallet variants — so discovery is only offered here.
	const oembedJsonUrl = walletShare
		? null
		: `${origin}/api/oembed?url=${encodeURIComponent(deepUrl)}&format=json`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc, pageUrl, deepUrl, ogImage, thumbUrl, forcedOgImage, name, origin, oembedJsonUrl }));
});

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function buildDesc({ description, isOnchain, chainLabel }) {
	const parts = [description.slice(0, 120)];
	if (isOnchain && chainLabel) parts.push(`Deployed on ${chainLabel}`);
	parts.push('3D AI Agent on three.ws');
	return parts.join(' · ');
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function renderHtml({ title, desc, pageUrl, deepUrl, ogImage, thumbUrl, forcedOgImage, name, origin, oembedJsonUrl }) {
	const t = esc(title);
	const d = esc(desc);
	// A wallet share forces the SVG card (it carries the wallet identity); otherwise
	// use the actual thumbnail when available — richer than the SVG card.
	const finalOgImage = forcedOgImage || thumbUrl || ogImage;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#050508">

	<meta property="og:type" content="profile">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(finalOgImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(name)} — 3D AI Agent on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(finalOgImage)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(finalOgImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="View agent →">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(deepUrl)}">
	<meta property="fc:frame:button:2" content="Browse agents">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(origin)}/agents">

	<link rel="canonical" href="${esc(pageUrl)}">
	${oembedJsonUrl ? `<link rel="alternate" type="application/json+oembed" href="${esc(oembedJsonUrl)}" title="${t} oEmbed">` : ''}
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#050508;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;height:100%}
		.shell{display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;gap:.75rem}
		.name{font-size:1.4rem;font-weight:800;color:#f9fafb}
		.spinner{width:24px;height:24px;border:2px solid rgba(255,255,255,.1);border-top-color:rgba(255,255,255,.5);border-radius:50%;animation:spin .9s linear infinite;margin:0 auto}
		@keyframes spin{to{transform:rotate(360deg)}}
		p{margin:0;color:rgba(255,255,255,.4);font-size:13px}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<div class="name">${esc(name)}</div>
			<p>${d}</p>
			<p><a href="${esc(deepUrl)}" style="color:#6366f1">View agent →</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading agent…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(deepUrl)});})()</script>
</body>
</html>`;
}
