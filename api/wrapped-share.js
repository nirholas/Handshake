/**
 * SSR share page for a Trader Wrapped recap.
 * -----------------------------------------
 * GET /api/wrapped-share?agent=<uuid>[&window=7d|30d|all][&ref=CODE]
 *
 * Wired via vercel.json: /wrapped/<agent_id>/share -> /api/wrapped-share?agent=$1
 *
 * Bakes Open Graph + Twitter Card + Farcaster Frame meta into <head> so a shared
 * recap previews with the real season card. Real browsers are redirected to the
 * deck at /wrapped?agent=<id>, carrying the referral code the sharer's link
 * arrived with so the loop pays whoever spread it.
 *
 * OG image: /api/wrapped-og?agent=<uuid>&window=<window>
 */

import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { isUuid } from './_lib/validate.js';
import { WRAPPED_WINDOWS, getWrapped } from './_lib/wrapped.js';

const REF_RE = /^[A-Z0-9]{3,20}$/;
const WINDOW_LABEL = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const agentId = (url.searchParams.get('agent') || url.searchParams.get('agent_id') || '').trim();
	const windowParam = url.searchParams.get('window');
	const window = WRAPPED_WINDOWS.has(windowParam) ? windowParam : '30d';
	const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
	const origin = env.APP_ORIGIN || 'https://three.ws';

	if (!isUuid(agentId)) return redirect(res, `${origin}/wrapped`);

	const deepParams = new URLSearchParams({ agent: agentId });
	if (window !== '30d') deepParams.set('window', window);
	if (REF_RE.test(ref)) deepParams.set('ref', ref);
	const deepUrl = `${origin}/wrapped?${deepParams}`;

	let deck = null;
	try {
		deck = await getWrapped({ agentId, network: 'mainnet', window });
	} catch {
		return redirect(res, deepUrl);
	}
	if (!deck) return redirect(res, `${origin}/wrapped`);

	const name = deck.agent.name || 'Trader';
	const windowLabel = WINDOW_LABEL[window] || window;

	const title = deck.enough_history
		? `${name} wrapped: ${windowLabel} on pump.fun · three.ws`
		: `${name} · Trader Wrapped · three.ws`;
	const desc = deck.enough_history
		? `${deck.headline} Verified against closed on-chain round-trips, not screenshots.`
		: `${name} has not settled enough round-trips in ${windowLabel} for a recap. Every three.ws Trader Wrapped is cut from closed on-chain trades or it is not cut at all.`;

	const shareParams = new URLSearchParams({ agent: agentId });
	if (window !== '30d') shareParams.set('window', window);
	const pageUrl = `${origin}/wrapped/${encodeURIComponent(agentId)}/share${window !== '30d' ? `?window=${encodeURIComponent(window)}` : ''}`;
	const ogImage = `${origin}/api/wrapped-og?${shareParams}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc, pageUrl, deepUrl, ogImage, name, deck, origin }));
});

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function renderHtml({ title, desc, pageUrl, deepUrl, ogImage, name, deck, origin }) {
	const t = esc(title);
	const d = esc(desc);
	const pnl = deck.enough_history ? Number(deck.metrics?.realized_pnl_sol ?? 0) : null;
	const pnlStr = pnl != null ? `${pnl > 0 ? '+' : ''}${pnl.toFixed(3).replace(/\.?0+$/, '') || '0'} SOL` : null;
	const pnlColor = pnl == null ? '#94a3b8' : pnl > 0 ? '#34d399' : pnl < 0 ? '#fb7185' : '#94a3b8';
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${t}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="article">
	<meta property="og:site_name" content="three.ws">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(name)}'s Trader Wrapped season recap on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(ogImage)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="Open the recap">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(deepUrl)}">
	<meta property="fc:frame:button:2" content="Verify on-chain">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(origin)}${esc(deck.agent.profile_url)}">

	<link rel="canonical" href="${esc(pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#08080a;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;height:100%}
		.shell{display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;gap:.75rem}
		.name{font-size:1.15rem;font-weight:700;color:#f6f6f8}
		.pnl{font-size:2.6rem;font-weight:800;line-height:1;color:${pnlColor}}
		.spinner{width:24px;height:24px;border:2px solid rgba(255,255,255,.1);border-top-color:rgba(255,255,255,.5);border-radius:50%;animation:spin .9s linear infinite;margin:0 auto}
		@keyframes spin{to{transform:rotate(360deg)}}
		p{margin:0;color:rgba(255,255,255,.42);font-size:13px;max-width:46ch}
		a{color:#f472b6}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<div class="name">${esc(name)}</div>
			${pnlStr ? `<div class="pnl">${esc(pnlStr)}</div>` : ''}
			<p>${d}</p>
			<p><a href="${esc(deepUrl)}">Open the recap</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Opening the recap…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(deepUrl)});})()</script>
</body>
</html>`;
}
