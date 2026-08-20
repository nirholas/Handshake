/**
 * Device-aware AR launch: GET /api/ar?src=<glbUrl>&title=<name>&kind=<avatar?>
 * -----------------------------------------------------------------------------
 * Places a generated GLB in the user's space, branching on the request's
 * User-Agent (server-side, from the header, no client round-trip):
 *
 *   • Android → a straight 302 to a Google Scene Viewer ARCore intent:// URL
 *     (GLB as the source), with a browser fallback to the WebGL viewer.
 *   • iOS / desktop / any live avatar → an interstitial that carries this
 *     model's real og:image/title so a pasted link still unfurls, then hands
 *     off to /ar/view (pages/ar-view.html), which generates a real USDZ from
 *     the GLB on the device (three.js USDZExporter) before offering Apple
 *     Quick Look. <model-viewer> does not do that conversion on its own, so
 *     the actual AR page has to be a real Vite-bundled page rather than HTML
 *     this handler writes inline (a bare `three` import does not resolve
 *     outside a bundle). See api/_lib/ar-launch.js for the full routing
 *     rationale. A plain 302 here would drop the unfurl (crawlers don't run
 *     the JS on the redirect target), which is why this branch gets a real
 *     page instead of Android's clean redirect.
 *
 * `kind=avatar` marks a LIVE asset (a rigged avatar, an agent's body). AR is how
 * three.ws agents cross into the physical world, so an avatar launch always
 * lands on /ar/view (Android included) with a "Bring it to life" hand-off into
 * /irl?avatar=<glb>: camera passthrough, animation, movement, and conversation
 * with the AI in the user's real room, alongside the static AR placement.
 *
 * Bad input (non-https, non-GLB, missing) is rejected at the boundary with a
 * clean, designed error page, never a crash. Zero payment/coin surface.
 */

import { cors, method, wrap } from './_lib/http.js';
import { planArLaunch } from './_lib/ar-launch.js';

function esc(s) {
	return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function originFrom(req) {
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'three.ws';
	const proto = req.headers['x-forwarded-proto'] || (/^localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
	return `${proto}://${host}`;
}

function errorPage(message) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>View in AR · three.ws</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(130% 130% at 50% 0%,#14161c,#08090c);color:#e8eaf0;text-align:center;padding:28px}
.c{max-width:38ch}.h{font-size:16px;font-weight:600;margin-bottom:10px}.m{color:#9aa3b2;font-size:13px;line-height:1.5}
a{display:inline-block;margin-top:16px;color:#dbe9ff;background:rgba(110,168,254,.16);border:1px solid rgba(110,168,254,.42);
border-radius:10px;padding:9px 14px;text-decoration:none;font-weight:600;font-size:13px}</style></head>
<body><div class="c"><div class="h">Can't open this in AR</div><div class="m">${esc(message)}</div>
<a href="https://three.ws">Create a 3D model</a></div></body></html>`;
}

// A crawler (X, Discord, iMessage) reads only this static HTML and never runs
// the redirect script, so the unfurl meta has to be right here rather than on
// /ar/view. A real visitor's browser runs the one-line redirect immediately;
// there is no visible interstitial in practice.
function interstitialPage({ target, asset, title, irlUrl, origin, pageUrl }) {
	const t = title ? esc(title) : irlUrl ? '3D avatar' : '3D model';
	const ogImage = `${origin}/api/render/glb?glbUrl=${encodeURIComponent(asset)}&width=1200&height=630`;
	const ogDesc = irlUrl
		? 'A living AI agent. Open on your phone to place it in your room, or bring it to life to walk and talk with it.'
		: 'Open on your phone to place this 3D model in your room at real size. Made on three.ws: type a sentence, get a 3D model.';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>View ${t} in AR · three.ws</title><meta name="robots" content="noindex"/>
<meta http-equiv="refresh" content="0;url=${esc(target)}"/>
<meta property="og:type" content="website"/>
<meta property="og:site_name" content="three.ws"/>
<meta property="og:title" content="Place ${t} in your room"/>
<meta property="og:description" content="${esc(ogDesc)}"/>
<meta property="og:image" content="${esc(ogImage)}"/>
<meta property="og:url" content="${esc(pageUrl)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="Place ${t} in your room"/>
<meta name="twitter:description" content="${esc(ogDesc)}"/>
<meta name="twitter:image" content="${esc(ogImage)}"/>
<style>:root{color-scheme:dark}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(130% 130% at 50% 0%,#14161c,#08090c);color:#9aa3b2;font-size:13px}</style>
<script>location.replace(${JSON.stringify(target)});</script>
</head><body>Opening AR…</body></html>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// The CORS preflight already advertises GET only; enforce it too, so a POST
	// gets a 405 with an Allow header instead of a redirect.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const src = url.searchParams.get('src') || '';
	const title = (url.searchParams.get('title') || '').slice(0, 120);
	// kind=avatar marks a rigged agent body; it unlocks the IRL living handoff.
	const live = url.searchParams.get('kind') === 'avatar';
	const origin = originFrom(req);

	let plan;
	try {
		plan = planArLaunch({ glbUrl: src, userAgent: req.headers['user-agent'], origin, title, live });
	} catch (err) {
		res.statusCode = 400;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(errorPage(err.arUserMessage ? err.message : 'That model link could not be opened.'));
		return;
	}

	// Every branch here is device-specific (Android gets Scene Viewer, everyone
	// else gets /ar/view), so a shared CDN cache must never serve one device's
	// response to another.
	res.setHeader('vary', 'user-agent');
	res.setHeader('cache-control', 'no-store');

	if (plan.url.startsWith('intent://')) {
		res.statusCode = 302;
		res.setHeader('location', plan.url);
		res.end();
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(
		interstitialPage({
			target: plan.url,
			asset: plan.asset,
			title,
			irlUrl: plan.irlUrl,
			origin,
			pageUrl: `${origin}${req.url}`,
		}),
	);
});
