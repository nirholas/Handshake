/**
 * SSR OG page for avatar detail (/avatars/:id)
 * --------------------------------------------
 * GET /api/avatar-detail-og?id=<avatarId>
 *
 * Wired via vercel.json: when a social crawler hits /avatars/<uuid>,
 * a User-Agent "has" condition rewrites to this endpoint. Returns a minimal
 * HTML page with OG + Twitter Card + Farcaster Frame meta so shared avatar
 * links unfurl with the avatar's real name, description, and rendered card.
 *
 * Real browsers never reach this route - the rewrite only fires for known
 * bot User-Agents. Mirrors api/agent-detail-og.js.
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
	const avatarId = url.searchParams.get('id');
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!avatarId || !isUuid(avatarId)) {
		return passthrough(res, origin);
	}

	let avatar;
	try {
		[avatar] = await sql`
			SELECT a.id, a.name, a.description, a.tags, a.model_category,
			       u.username AS owner_username
			FROM avatars a
			LEFT JOIN users u ON u.id = a.owner_id AND u.deleted_at IS NULL
			WHERE a.id = ${avatarId} AND a.deleted_at IS NULL AND a.visibility = 'public'
			LIMIT 1
		`;
	} catch {
		return passthrough(res, origin);
	}

	if (!avatar) return passthrough(res, origin);

	const title = avatar.name || 'Avatar';
	const baseDesc =
		avatar.description || 'A 3D avatar on three.ws - rigged, animated, and ready to become an agent.';
	const tags = avatar.tags || [];
	const tagSuffix = tags.length ? ` Tags: ${tags.slice(0, 4).join(', ')}${tags.length > 4 ? '…' : ''}.` : '';
	const byline = avatar.owner_username ? ` By @${avatar.owner_username}.` : '';
	const desc = baseDesc + byline + tagSuffix;

	// Unfurl with the rendered avatar card (api/avatar-og.js) - the avatar's own
	// turntable render with name plate, from real data. The card endpoint falls
	// back to the brand image if it can't render.
	const ogImage = `${origin}/api/avatars/${encodeURIComponent(avatarId)}/og`;

	const pageUrl = `${origin}/avatars/${avatarId}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ avatarId, title, desc, pageUrl, ogImage, origin }));
});

function passthrough(res, origin) {
	res.statusCode = 302;
	res.setHeader('location', `${origin}/gallery`);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function renderHtml({ avatarId, title, desc, pageUrl, ogImage, origin }) {
	const t = esc(title);
	const d = esc(desc);
	const avatarUrl = `/avatars/${avatarId}`;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t} · three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#06070a">

	<meta property="og:type" content="profile">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t} · three.ws">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${t} on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="${t} · three.ws">
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
			<p><a href="${esc(pageUrl)}">View avatar</a> · <a href="${esc(origin)}/gallery">Browse the gallery</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading ${t}…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(avatarUrl)});})()</script>
</body>
</html>`;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
