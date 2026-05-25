/**
 * Server-rendered metadata page for hosted agents
 * ------------------------------------------------
 * GET /api/agent-page?id=<agentId>
 *
 * Wired to /agent/:id via vercel.json. Returns an HTML page with
 * Open Graph + Twitter Player Card + oEmbed discovery + Farcaster Frame tags
 * so social crawlers get a rich preview. Real browsers are redirected to the
 * agent's Avatar Studio (/avatars/<avatar_id>) when the agent has an avatar,
 * or to the agent-home SPA fallback otherwise.
 */

import { sql } from './_lib/db.js';
import { env } from './_lib/env.js';
import { cors, wrap } from './_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('id');

	if (!agentId) return notFound(res, 'Invalid agent URL');
	if (!isUuid(agentId)) return notFound(res, 'Agent not found');

	const [agent] = await sql`
		SELECT id, name, description, avatar_id
		FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;

	if (!agent) return notFound(res, `Agent not found`);

	const origin = env.APP_ORIGIN;
	const pageUrl = `${origin}/agent/${agentId}`;
	const embedUrl = `${origin}/agent/${agentId}/embed`;
	const ogUrl = `${origin}/api/agent/${agentId}/og`;
	const oembedJs = `${origin}/api/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
	const spaUrl = agent.avatar_id ? `/avatars/${agent.avatar_id}` : `${pageUrl}?_spa=1`;

	const title = agent.name || 'Agent';
	const desc = agent.description || 'An embodied three.ws.';

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc, agentId, pageUrl, embedUrl, ogUrl, oembedJs, origin, spaUrl }));
});

function notFound(res, reason) {
	res.statusCode = 404;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60');
	res.end(
		`<!doctype html><meta charset="utf-8"><title>Agent not found — three.ws</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:2rem;max-width:520px}a{color:#8b5cf6}</style>
<main><h1>Agent not found</h1><p>${escapeHtml(reason)}</p><p><a href="/discover">Browse all agents</a> · <a href="/">Open viewer</a></p></main>`,
	);
}

function renderHtml(p) {
	const t = escapeHtml(p.title);
	const d = escapeHtml(p.desc);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t} — three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="profile">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${escapeAttr(p.pageUrl)}">
	<meta property="og:image" content="${escapeAttr(p.ogUrl)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${t} on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${escapeAttr(p.ogUrl)}">
	<meta name="twitter:player" content="${escapeAttr(p.embedUrl)}">
	<meta name="twitter:player:width" content="480">
	<meta name="twitter:player:height" content="600">

	<!-- Farcaster Frame (vNext) -->
	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${escapeAttr(p.ogUrl)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="View Agent">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${escapeAttr(p.pageUrl)}">
	<meta property="fc:frame:button:2" content="Discover">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${escapeAttr(p.origin)}/discover">

	<link rel="canonical" href="${escapeAttr(p.pageUrl)}">
	<link rel="alternate" type="application/json+oembed" href="${escapeAttr(p.oembedJs)}" title="${t}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#0a0a0a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%;overflow:hidden}
		.shell{display:grid;place-items:center;height:100vh;text-align:center;padding:2rem;gap:1rem}
		.shell a{color:#8b5cf6;text-decoration:none}
		.shell a:hover{text-decoration:underline}
		.spinner{width:32px;height:32px;border:2px solid rgba(255,255,255,0.1);border-top-color:#8b5cf6;border-radius:50%;animation:spin 1s linear infinite}
		@keyframes spin{to{transform:rotate(360deg)}}
		@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<h1>${t}</h1>
			<p>${d}</p>
			<p><a href="${escapeAttr(p.embedUrl)}">Open 3D viewer</a> · <a href="/discover">Browse agents</a></p>
		</div>
	</noscript>
	<div class="shell" id="loading" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading ${t}…</p>
	</div>
	<script>
		(function () {
			window.location.replace(${JSON.stringify(p.spaUrl)});
		})();
	</script>
	<script type="application/ld+json">
${escapeJsonLd({
	'@context': 'https://schema.org',
	'@graph': [
		{
			'@type': ['SoftwareApplication', 'Service'],
			'@id': `${p.pageUrl}#agent`,
			name: p.title,
			description: p.desc,
			url: p.pageUrl,
			image: p.ogUrl,
			applicationCategory: 'AIApplication',
			applicationSubCategory: 'EmbodiedAgent',
			operatingSystem: 'Web',
			browserRequirements: 'Requires WebGL2',
			provider: { '@id': `${p.origin}/#org` },
			offers: {
				'@type': 'Offer',
				price: '0',
				priceCurrency: 'USD',
				availability: 'https://schema.org/InStock',
				url: p.pageUrl,
			},
		},
		{
			'@type': 'Organization',
			'@id': `${p.origin}/#org`,
			name: 'three.ws',
			url: p.origin,
			logo: `${p.origin}/icon.png`,
		},
		{
			'@type': 'BreadcrumbList',
			itemListElement: [
				{ '@type': 'ListItem', position: 1, name: 'Home', item: p.origin },
				{ '@type': 'ListItem', position: 2, name: 'Discover', item: `${p.origin}/discover` },
				{ '@type': 'ListItem', position: 3, name: p.title, item: p.pageUrl },
			],
		},
	],
})}
	</script>
</body>
</html>`;
}

function isUuid(s) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function escapeAttr(s) {
	return escapeHtml(s);
}
function escapeJsonLd(obj) {
	const clean = JSON.parse(JSON.stringify(obj));
	return JSON.stringify(clean, null, 2).replace(/</g, '\\u003c');
}
