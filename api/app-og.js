/**
 * Server-rendered OG page for /app?agent=<id>
 * -------------------------------------------
 * GET /api/app-og?agent=<agentId>
 *
 * Wired via vercel.json: when a social crawler hits /app?agent=<uuid>,
 * a "has" condition on User-Agent rewrites the request here. Returns
 * a minimal HTML page with Open Graph + Twitter Card + oEmbed tags so
 * the shared link shows the agent's name, description, and thumbnail.
 *
 * Real browsers never reach this route — the rewrite only fires for
 * known bot User-Agents.
 */

import { sql } from './_lib/db.js';
import { publicUrl } from './_lib/r2.js';
import { env } from './_lib/env.js';
import { cors, wrap } from './_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent');

	if (!agentId || !isUuid(agentId)) {
		return passthrough(res);
	}

	const [agent] = await sql`
		SELECT i.id, i.name, i.description, i.avatar_id, i.skills,
		       a.thumbnail_key AS avatar_thumbnail_key,
		       a.storage_key   AS avatar_storage_key,
		       a.visibility    AS avatar_visibility
		FROM agent_identities i
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		WHERE i.id = ${agentId} AND i.deleted_at IS NULL
		LIMIT 1
	`;

	if (!agent) return passthrough(res);

	const origin = env.APP_ORIGIN || 'https://three.ws';
	const pageUrl = `${origin}/app?agent=${agentId}`;
	const title = agent.name || 'Agent';
	const desc = agent.description || 'An embodied AI agent on three.ws — with a body, a place, and an identity.';

	const thumbnailUrl = agent.avatar_thumbnail_key
		? publicUrl(agent.avatar_thumbnail_key)
		: null;
	const ogImage = thumbnailUrl
		|| `${origin}/api/agent/${agentId}/og`
		|| `${origin}/assets/og-image.png`;

	const skills = agent.skills || [];
	const skillText = skills.length
		? ` Skills: ${skills.slice(0, 5).join(', ')}${skills.length > 5 ? '…' : ''}.`
		: '';
	const fullDesc = desc + skillText;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc: fullDesc, pageUrl, ogImage, origin, agentId }));
});

function passthrough(res) {
	res.statusCode = 302;
	res.setHeader('location', '/app');
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function renderHtml(p) {
	const t = esc(p.title);
	const d = esc(p.desc);
	const spaUrl = `/app?agent=${p.agentId}`;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t} — three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#06070a">

	<meta property="og:type" content="profile">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t} — three.ws">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(p.pageUrl)}">
	<meta property="og:image" content="${esc(p.ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${t} on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${t} — three.ws">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(p.ogImage)}">
	<meta name="twitter:creator" content="@nichxbt">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(p.ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Meet ${t}">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(p.pageUrl)}">

	<link rel="canonical" href="${esc(p.pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#06070a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%;overflow:hidden}
		.shell{display:grid;place-items:center;height:100vh;text-align:center;padding:2rem;gap:1rem}
		.shell a{color:#8b5cf6;text-decoration:none}
		.shell a:hover{text-decoration:underline}
		.spinner{width:32px;height:32px;border:2px solid rgba(255,255,255,0.1);border-top-color:#8b5cf6;border-radius:50%;animation:spin 1s linear infinite}
		@keyframes spin{to{transform:rotate(360deg)}}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<h1>${t}</h1>
			<p>${d}</p>
			<p><a href="${esc(p.pageUrl)}">Open agent</a> · <a href="/discover">Browse agents</a></p>
		</div>
	</noscript>
	<div class="shell" id="loading" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading ${t}…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(spaUrl)});})()</script>
	<script type="application/ld+json">
${escJsonLd({
	'@context': 'https://schema.org',
	'@type': 'SoftwareApplication',
	name: p.title,
	description: p.desc,
	url: p.pageUrl,
	image: p.ogImage,
	applicationCategory: 'AIApplication',
	operatingSystem: 'Web',
	provider: { '@type': 'Organization', name: 'three.ws', url: p.origin },
})}
	</script>
</body>
</html>`;
}

function isUuid(s) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
}
function esc(s) {
	return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escJsonLd(obj) {
	return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}
