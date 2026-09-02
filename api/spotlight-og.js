/**
 * SSR OG page for an Agent Spotlight entry (/spotlight/:id)
 * ---------------------------------------------------------
 * GET /api/spotlight-og?id=<entryId>
 *
 * Wired via vercel.json: when a social crawler hits /spotlight/<uuid>, a
 * User-Agent "has" condition rewrites here. The entry page itself is client
 * rendered, so without this every shared write-up would unfurl as the generic
 * showcase page: same title, same image, for all of them. A showcase whose links
 * do not unfurl is a showcase nobody shares.
 *
 * Real browsers never reach this route. Mirrors api/agent-detail-og.js.
 *
 * The card image is the agent's own trading card (api/og/agent.js), because the
 * subject of the share is that agent; the headline and one-liner supply the
 * text. That pairing is why this does not need an image renderer of its own.
 */

import { sql } from './_lib/db.js';
import { cors, method, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { isUuid } from './_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id');
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!id || !isUuid(id)) return passthrough(res, origin);

	let entry;
	try {
		[entry] = await sql`
			select s.id, s.title, s.tagline, s.source, s.category,
			       i.id as agent_id, i.name as agent_name,
			       u.display_name as builder_display_name, u.username as builder_username
			from agent_showcase s
			join agent_identities i on i.id = s.agent_id and i.deleted_at is null and i.is_public = true
			left join users u on u.id = i.user_id and u.deleted_at is null
			where s.id = ${id} and s.deleted_at is null and s.status = 'published'
			limit 1
		`;
	} catch {
		return passthrough(res, origin);
	}
	if (!entry) return passthrough(res, origin);

	const builder = entry.builder_display_name || entry.builder_username || null;
	const credit =
		entry.source === 'curated'
			? `${entry.agent_name} on three.ws${builder ? `, built by ${builder}` : ''}.`
			: `${entry.agent_name} on three.ws${builder ? `, by ${builder}` : ''}.`;

	const pageUrl = `${origin}/spotlight/${entry.id}`;
	const ogImage = `${origin}/api/og/agent?id=${encodeURIComponent(entry.agent_id)}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(
		renderHtml({
			entryId: entry.id,
			title: entry.title,
			desc: `${entry.tagline} ${credit}`,
			agentName: entry.agent_name,
			pageUrl,
			ogImage,
			origin,
		}),
	);
});

function passthrough(res, origin) {
	res.statusCode = 302;
	res.setHeader('location', `${origin}/spotlight`);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function renderHtml({ entryId, title, desc, agentName, pageUrl, ogImage, origin }) {
	const t = esc(title);
	const d = esc(desc);
	const entryUrl = `/spotlight/${entryId}`;
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${t} — Agent Spotlight — three.ws</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#06070a">

	<meta property="og:type" content="article">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(agentName)} on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(ogImage)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Meet ${esc(agentName)}">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(pageUrl)}">

	<link rel="canonical" href="${esc(pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#06070a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;height:100%}
		.shell{display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;gap:1rem}
		.shell a{color:#e0e0e0;text-decoration:underline;text-underline-offset:3px}
		p{margin:0;color:rgba(255,255,255,0.5);font-size:14px}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<h1>${t}</h1>
			<p>${d}</p>
			<p><a href="${esc(pageUrl)}">Read the write-up</a> · <a href="${esc(origin)}/spotlight">Agent Spotlight</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<p>Loading ${t}…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(entryUrl)});})()</script>
</body>
</html>`;
}

function esc(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
