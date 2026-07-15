/**
 * Device-aware AR launch: GET /api/ar?src=<glbUrl>&title=<name>&kind=<avatar?>
 * -----------------------------------------------------------------------------
 * Places a generated GLB in the user's space, branching on the request's
 * User-Agent (server-side, from the header — no client round-trip):
 *
 *   • Android → 302 to a Google Scene Viewer ARCore intent:// URL (GLB as the
 *     source), with a browser fallback to the WebGL viewer.
 *   • iOS     → an HTML launch page with <model-viewer>; tapping "View in AR"
 *     enters Apple Quick Look, for which model-viewer generates a USDZ from the
 *     GLB on the fly (a real conversion via three.js USDZExporter, in-page).
 *   • desktop → the same launch page, which falls back to the interactive WebGL
 *     viewer (no AR hardware).
 *
 * `kind=avatar` marks a LIVE asset (a rigged avatar, an agent's body). AR is how
 * three.ws agents cross into the physical world, so an avatar launch always
 * serves the page (Android included) with a "Bring it to life" handoff into
 * /irl?avatar=<glb>: camera passthrough, animation, movement, and conversation
 * with the AI in the user's real room, alongside the static AR placement.
 *
 * Bad input (non-https, non-GLB, missing) is rejected at the boundary with a
 * clean, designed error page — never a crash. Zero payment/coin surface.
 */

import { cors, wrap } from './_lib/http.js';
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

function launchPage({ target, asset, viewerUrl, title, irlUrl }) {
	const t = title ? esc(title) : irlUrl ? '3D avatar' : '3D model';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>View ${t} in AR · three.ws</title><meta name="robots" content="noindex"/>
<script src="/model-viewer-meshopt.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>:root{color-scheme:dark;--accent:#6ea8fe}*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(130% 130% at 50% 0%,#14161c,#08090c);color:#e8eaf0;overflow:hidden}
.wrap{display:flex;flex-direction:column;height:100dvh}.stage{position:relative;flex:1 1 auto;min-height:0}
model-viewer{width:100%;height:100%;--progress-bar-color:var(--accent);background:transparent}
.bar{display:flex;gap:10px;align-items:center;justify-content:center;padding:14px 16px;border-top:1px solid rgba(255,255,255,.07);background:rgba(10,11,14,.55);backdrop-filter:blur(8px)}
button.ar,a.ar{appearance:none;cursor:pointer;text-decoration:none;font-size:14px;font-weight:700;color:#0b0c10;background:var(--accent);border:0;border-radius:12px;padding:12px 20px;display:inline-flex;align-items:center;gap:8px}
button.ar:active{transform:translateY(1px)}button.ar:focus-visible{outline:2px solid #fff;outline-offset:2px}
.ghost{appearance:none;cursor:pointer;text-decoration:none;font-size:14px;font-weight:700;color:var(--accent);background:rgba(110,168,254,.14);border:1px solid rgba(110,168,254,.45);border-radius:12px;padding:11px 18px;display:inline-flex;align-items:center;gap:8px;transition:background .15s ease}
.ghost:hover{background:rgba(110,168,254,.24)}.ghost:active{transform:translateY(1px)}.ghost:focus-visible{outline:2px solid #fff;outline-offset:2px}
.hint{position:absolute;left:0;right:0;bottom:16px;text-align:center;color:#9aa3b2;font-size:12px;pointer-events:none}
a.alt{color:#aeb6c4;font-size:12.5px;text-decoration:underline}</style></head>
<body><div class="wrap"><div class="stage">
<model-viewer id="mv" src="${esc(asset)}" alt="${t}" camera-controls auto-rotate touch-action="pan-y"
 environment-image="neutral" exposure="1.05" shadow-intensity="1" tone-mapping="aces"
 ar ar-modes="webxr scene-viewer quick-look" ar-scale="auto" ${target === 'ios' ? 'reveal="auto"' : ''}>
</model-viewer>
<div class="hint" id="hint">${irlUrl ? 'This is a living agent. Bring it to life to walk and talk with it in your room.' : 'Move your phone to place the model in your space.'}</div>
</div>
<div class="bar">
${irlUrl ? `<a class="ar" href="${esc(irlUrl)}" aria-label="Bring this avatar to life in your room: it moves and talks through your camera">🤖 Bring it to life</a>\n<button class="ghost" id="ar-btn" type="button" aria-label="Place a static copy of this avatar in augmented reality">📱 Place in your space</button>` : `<button class="ar" id="ar-btn" type="button" aria-label="View this model in augmented reality">📱 View in your space</button>`}
<a class="alt" href="${esc(viewerUrl)}">Open in 3D viewer</a>
</div></div>
<script>
(function(){var mv=document.getElementById('mv'),btn=document.getElementById('ar-btn'),hint=document.getElementById('hint'),live=${irlUrl ? 'true' : 'false'};
function sync(){ if(!mv.canActivateAR){ btn.textContent='View in 3D'; if(!live){ hint.style.display='none'; } } }
mv.addEventListener('load',sync);
btn.addEventListener('click',function(){ if(mv.canActivateAR){ try{mv.activateAR();}catch(e){} } else { window.location.href='${esc(viewerUrl)}'; } });
})();
</script></body></html>`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url = new URL(req.url, 'http://x');
	const src = url.searchParams.get('src') || '';
	const title = (url.searchParams.get('title') || '').slice(0, 120);
	// kind=avatar marks a rigged agent body; it unlocks the IRL living handoff.
	const live = url.searchParams.get('kind') === 'avatar';

	let plan;
	try {
		plan = planArLaunch({ glbUrl: src, userAgent: req.headers['user-agent'], origin: originFrom(req), title, live });
	} catch (err) {
		res.statusCode = 400;
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(errorPage(err.arUserMessage ? err.message : 'That model link could not be opened.'));
		return;
	}

	if (plan.action === 'redirect') {
		res.statusCode = 302;
		res.setHeader('location', plan.url);
		res.setHeader('cache-control', 'no-store');
		res.end();
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	// The page is UA-branched (iOS Quick Look vs desktop fallback) while Android
	// gets a 302 above — without Vary a CDN-cached desktop page can be served to
	// an Android phone and swallow the straight-into-AR redirect. Vary keeps the
	// browser cache (one UA per browser) and stops the cross-device bleed.
	res.setHeader('vary', 'user-agent');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600');
	res.end(launchPage({ target: plan.target, asset: plan.asset, viewerUrl: plan.viewerUrl, title, irlUrl: plan.irlUrl }));
});
