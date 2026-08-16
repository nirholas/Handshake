/**
 * SSR OG page for agent detail (/agents/:id)
 * -------------------------------------------
 * GET /api/agent-detail-og?id=<agentId>
 *
 * Wired via vercel.json: when a social crawler hits /agents/<uuid>,
 * a User-Agent "has" condition rewrites to this endpoint. Returns a minimal
 * HTML page with OG + Twitter Card + Farcaster Frame meta so shared agent
 * links unfurl with a real image and description.
 *
 * Real browsers never reach this route — the rewrite only fires for known
 * bot User-Agents. Mirrors the pattern in api/app-og.js.
 */

import { sql } from './_lib/db.js';
import { cors, method, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { isUuid } from './_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// Crawler-only SSR read. Without this, a POST answered with the 302
	// passthrough instead of the 405 the advertised Allow set promises.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('id');
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!agentId || !isUuid(agentId)) {
		return passthrough(res, origin);
	}

	let agent;
	try {
		[agent] = await sql`
			SELECT i.id, i.name, i.description, i.skills
			FROM agent_identities i
			WHERE i.id = ${agentId} AND i.deleted_at IS NULL
			LIMIT 1
		`;
	} catch {
		return passthrough(res, origin);
	}

	if (!agent) return passthrough(res, origin);

	const title = agent.name || 'Agent';
	const baseDesc = agent.description || 'An AI agent on three.ws — with a body, a place, and an identity.';
	const skills = agent.skills || [];
	const skillSuffix = skills.length
		? ` Skills: ${skills.slice(0, 4).join(', ')}${skills.length > 4 ? '…' : ''}.`
		: '';
	const desc = baseDesc + skillSuffix;

	// Unfurl with the dynamic wallet TRADING CARD (api/og/agent.js) — the same
	// living card shown on the page (avatar, vanity address, live net worth, P&L,
	// reputation tier, finish), rendered from real data. The card embeds the
	// avatar itself, so a shared link previews with identity + wallet, not a bare
	// thumbnail. The card endpoint falls back to the brand image if it can't render.
	const ogImage = `${origin}/api/og/agent?id=${encodeURIComponent(agentId)}`;

	const pageUrl = `${origin}/agents/${agentId}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ agentId, title, desc, pageUrl, ogImage, origin }));
});

function passthrough(res, origin) {
	res.statusCode = 302;
	res.setHeader('location', `${origin}/agents`);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function renderHtml({ agentId, title, desc, pageUrl, ogImage, origin }) {
	const t = esc(title);
	const d = esc(desc);
	const agentUrl = `/agents/${agentId}`;
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
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${t} on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${t} — three.ws">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(ogImage)}">
	<meta name="twitter:creator" content="@trythreews">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Meet ${t}">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(pageUrl)}">

	<link rel="canonical" href="${esc(pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#06070a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%}
		.shell{display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;gap:1rem}
		.shell a{color:#e0e0e0;text-decoration:underline;text-underline-offset:3px}
		.spinner{width:28px;height:28px;border:2px solid rgba(255,255,255,0.1);border-top-color:rgba(255,255,255,0.6);border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto}
		@keyframes spin{to{transform:rotate(360deg)}}
		p{margin:0;color:rgba(255,255,255,0.5);font-size:14px}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<h1>${t}</h1>
			<p>${d}</p>
			<p><a href="${esc(pageUrl)}">View agent</a> · <a href="${esc(origin)}/agents">Browse agents</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading ${t}…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(agentUrl)});})()</script>
</body>
</html>`;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
