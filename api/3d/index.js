// @ts-check
// GET /api/3d — the front door to the free, keyless three.ws 3D API.
//
// One URL an agent (or a human wiring one up) hits to discover the whole API:
// every free endpoint, its inputs/outputs, and a live example — plus the paid
// ladder it graduates to (Forge Pro quality tiers → Rigged Avatars). The list is
// assembled at request time from the catalog (api/_lib/3d-catalog), so a new
// sibling endpoint appears here the moment it ships — nothing wired by hand.
//
// Content negotiation: `Accept: text/html` gets a browsable page; everything
// else (the agent path) gets JSON. Free means free — keyless, no account, a
// generous per-IP limit that only blunts abuse.

import { wrap, cors, method, json, text, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { loadCatalog } from '../_lib/3d-catalog/index.js';

const VERSION = '1.0.0';

// The paid tiers the free lanes funnel into. Kept here (not in the catalog dir)
// because these are paid x402 routes, not free-bundle members — the catalog only
// holds free endpoints.
const PAID_TIERS = [
	{
		name: 'Forge Pro',
		path: '/api/x402/forge',
		price: 'from $0.05 USDC',
		why: 'Production text→3D / image→3D: higher polygon budgets, PBR textures, draft/standard/high quality tiers. Pay-per-call over x402, no key.',
	},
	{
		name: 'Rigged Avatar',
		path: '/api/forge?action=rig',
		price: 'from $0.05 USDC',
		why: 'Turn a static GLB into an animation-ready humanoid: auto-detected skeleton, skin weights, and the pre-baked idle/walk clip library.',
	},
];

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Cheap metadata read; generous ceiling, bounded so it can't be scraped in a
	// tight loop. Reuses the shared per-IP bucket sized for this surface.
	const ip = clientIp(req);
	const rl = await limits.apiIp(ip, { limit: 240, window: '5 m' });
	if (!rl.success) return rateLimited(res, rl, 'too many requests to the 3D API index');

	const endpoints = await loadCatalog();
	const origin = env.APP_ORIGIN;

	const payload = {
		name: 'three.ws 3D API',
		free: true,
		keyless: true,
		version: VERSION,
		endpoints,
		count: endpoints.length,
		// Zero entries is a valid state, not an error — say so plainly.
		...(endpoints.length === 0
			? { note: 'Free 3D endpoints are rolling out. They list here automatically as they ship.' }
			: {}),
		paidTiers: PAID_TIERS,
		openapi: '/api/3d/openapi.json',
		docs: '/docs/3d-api',
		ts: new Date().toISOString(),
	};

	// Public + CDN-cacheable: the catalog only changes on deploy, so a short edge
	// cache keeps this instant without hiding new endpoints for long.
	// One URL, two representations (HTML for a browser, JSON for an agent), so it
	// MUST vary on Accept: without it the CDN caches whichever variant it saw
	// first and serves that to everyone for the next 5 minutes, which is how an
	// agent asking for JSON ends up parsing an HTML page.
	const cache = {
		'cache-control': 'public, s-maxage=300, stale-while-revalidate=600',
		vary: 'accept',
	};

	if (String(req.headers.accept || '').includes('text/html')) {
		return text(res, 200, renderHtml(payload, origin), {
			...cache,
			'content-type': 'text/html; charset=utf-8',
		});
	}
	return json(res, 200, payload, cache);
});

/** Escape untrusted-ish strings before dropping them into HTML. */
function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Human-friendly index page. Self-contained, theme-aware, responsive. Lists
 * every free endpoint with its methods, path, summary, and a copy-ready curl —
 * then the paid ladder it funnels into.
 * @param {any} p payload
 * @param {string} origin
 */
function renderHtml(p, origin) {
	const rows = p.endpoints.length
		? p.endpoints
				.map((e) => {
					const example =
						e.example && typeof e.example === 'object'
							? esc(JSON.stringify(e.example, null, 2))
							: '';
					const methods = (e.methods || ['GET']).join(' · ');
					const isPost = (e.methods || []).includes('POST');
					const curl = isPost
						? `curl -X POST ${esc(origin)}${esc(e.path)} -H 'content-type: application/json' -d '{ … }'`
						: `curl ${esc(origin)}${esc(e.path)}`;
					return `
			<article class="ep">
				<header>
					<span class="method">${esc(methods)}</span>
					<code class="path">${esc(e.path)}</code>
				</header>
				<h3>${esc(e.title)}</h3>
				${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
				${e.useCase ? `<p class="use"><strong>Who uses it:</strong> ${esc(e.useCase)}</p>` : ''}
				<pre class="curl"><code>${esc(curl)}</code></pre>
				${example ? `<details><summary>Example</summary><pre><code>${example}</code></pre></details>` : ''}
			</article>`;
				})
				.join('')
		: `<div class="empty">
				<h3>Free 3D endpoints are rolling out</h3>
				<p>This bundle lists every endpoint here automatically as it ships. Meanwhile, jump straight to the paid tiers below, or watch the <a href="/changelog">changelog</a>.</p>
			</div>`;

	const tiers = p.paidTiers
		.map(
			(t) => `
			<article class="tier">
				<header><h3>${esc(t.name)}</h3><span class="price">${esc(t.price)}</span></header>
				<code class="path">${esc(t.path)}</code>
				<p>${esc(t.why)}</p>
			</article>`,
		)
		.join('');

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>three.ws 3D API — free text→3D + inspection for agents</title>
	<meta name="description" content="A free, keyless 3D API for AI agents: turn text into a GLB, inspect any glTF/GLB, and graduate to paid Forge Pro + Rigged Avatars. One URL to discover it all." />
	<style>
		:root {
			--bg: #ffffff; --fg: #0b0d12; --muted: #5b6472; --card: #f6f8fa;
			--border: #e4e8ee; --accent: #6d4aff; --code: #eef1f6; --pay: #b8860b;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #0b0d12; --fg: #e9edf4; --muted: #99a3b3; --card: #12151c;
				--border: #232935; --accent: #9d86ff; --code: #171b23; --pay: #e2b53c;
			}
		}
		* { box-sizing: border-box; }
		body {
			margin: 0; background: var(--bg); color: var(--fg);
			font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			padding: 2.5rem 1.25rem 4rem;
		}
		main { max-width: 880px; margin: 0 auto; }
		.badges { display: flex; gap: .5rem; flex-wrap: wrap; margin: .75rem 0 0; }
		.badge {
			font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
			background: var(--accent); color: #fff; padding: .2rem .55rem; border-radius: 999px;
		}
		h1 { font-size: 1.9rem; margin: 0; letter-spacing: -.02em; }
		h2 { font-size: 1.2rem; margin: 2.6rem 0 .3rem; letter-spacing: -.01em; }
		.lede { color: var(--muted); margin: .6rem 0 0; }
		.meta { color: var(--muted); font-size: .85rem; margin-top: 1rem; }
		.meta a { color: var(--accent); }
		.grid { display: grid; gap: 1rem; margin-top: 1.2rem; }
		.ep, .tier {
			background: var(--card); border: 1px solid var(--border); border-radius: 14px;
			padding: 1.1rem 1.2rem; transition: border-color .15s ease;
		}
		.ep:hover, .tier:hover { border-color: var(--accent); }
		.ep header, .tier header { display: flex; align-items: center; gap: .6rem; }
		.method {
			font-size: .72rem; font-weight: 700; color: #fff; background: #2f8f4e;
			padding: .12rem .5rem; border-radius: 6px; letter-spacing: .03em; white-space: nowrap;
		}
		.path { font-size: .9rem; color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		.ep h3, .tier h3 { margin: .7rem 0 .25rem; font-size: 1.05rem; }
		.tier h3 { margin: 0; }
		.tier .price { margin-left: auto; color: var(--pay); font-weight: 700; font-size: .82rem; }
		.tier code.path { display: inline-block; margin: .5rem 0 .3rem; }
		.ep p, .tier p { margin: 0 0 .7rem; color: var(--muted); }
		.ep p.use { font-size: .86rem; }
		pre {
			background: var(--code); border: 1px solid var(--border); border-radius: 8px;
			padding: .7rem .8rem; overflow-x: auto; margin: .4rem 0 0; font-size: .82rem;
		}
		pre code, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		details { margin-top: .5rem; }
		summary { cursor: pointer; color: var(--accent); font-size: .85rem; }
		.empty {
			text-align: center; padding: 3rem 1rem; background: var(--card);
			border: 1px dashed var(--border); border-radius: 14px; color: var(--muted);
		}
		.empty a { color: var(--accent); }
		footer { margin-top: 2.5rem; color: var(--muted); font-size: .82rem; }
		footer a { color: var(--accent); }
	</style>
</head>
<body>
	<main>
		<h1>${esc(p.name)}</h1>
		<div class="badges">
			<span class="badge">Free</span>
			<span class="badge">Keyless</span>
			<span class="badge">v${esc(p.version)}</span>
		</div>
		<p class="lede">One URL to discover the whole API — every free endpoint, its inputs and outputs, a live example, and the paid tiers it graduates to. No account, no API key.</p>
		<p class="meta">
			${p.count} free endpoint${p.count === 1 ? '' : 's'} ·
			<a href="/api/3d/openapi.json">OpenAPI 3.1</a> ·
			<a href="/docs/3d-api">Docs</a> ·
			<a href="/api/3d">JSON</a>
		</p>
		<h2>Free endpoints</h2>
		<section class="grid">
			${rows}
		</section>
		<h2>Paid tiers</h2>
		<p class="lede">When a draft isn't enough — production quality and rigging, pay-per-call over x402.</p>
		<section class="grid">
			${tiers}
		</section>
		<footer>Built for agents. <a href="/docs/3d-api">Read the docs →</a></footer>
	</main>
</body>
</html>`;
}
