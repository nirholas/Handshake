// @ts-check
// GET /api/crypto: the front door to the free, keyless Crypto Data API bundle.
//
// One URL an agent (or a human wiring one up) hits to discover the entire API:
// every endpoint, its inputs/outputs, and a live example. This is what makes the
// bundle feel like one product instead of a handful of loose routes. The list is
// assembled at request time from the catalog (api/_lib/crypto-catalog), so a new
// sibling endpoint appears here the moment it ships, with nothing to wire by hand.
//
// Content negotiation: `Accept: text/html` gets a browsable page; everything
// else (the agent path) gets JSON. Free means free: keyless, no account, a
// generous per-IP limit that only blunts abuse.

import { wrap, cors, method, json, text, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { loadCatalog } from '../_lib/crypto-catalog/index.js';

const VERSION = '1.0.0';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Cheap metadata read; generous ceiling, bounded so it can't be scraped in a
	// tight loop. Reuses the shared per-IP bucket sized for this surface.
	const ip = clientIp(req);
	const rl = await limits.apiIp(ip, { limit: 240, window: '5 m' });
	if (!rl.success) return rateLimited(res, rl, 'too many requests to the crypto API index');

	const endpoints = await loadCatalog();
	const origin = env.APP_ORIGIN;

	const payload = {
		name: 'three.ws Crypto Data API',
		free: true,
		keyless: true,
		version: VERSION,
		endpoints,
		count: endpoints.length,
		// Zero entries is a valid state, not an error, so say so plainly.
		...(endpoints.length === 0
			? {
					note: 'Endpoints are coming soon. They list here automatically as they ship.',
				}
			: {}),
		openapi: '/api/crypto/openapi.json',
		docs: '/docs/crypto-api',
		ts: new Date().toISOString(),
	};

	// Public + CDN-cacheable: the catalog only changes on deploy, so a short edge
	// cache keeps this instant without hiding new endpoints for long.
	const cache = { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=600' };

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
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Human-friendly index page. Self-contained, theme-aware, responsive. Lists
 * every endpoint with its method, path, summary, and a copy-ready curl example.
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
					const curl = `curl ${esc(origin)}${esc(e.path)}`;
					return `
			<article class="ep">
				<header>
					<span class="method">${esc((e.methods && e.methods.length ? e.methods : [e.method]).join(' / '))}</span>
					<code class="path">${esc(e.path)}</code>
				</header>
				<h3>${esc(e.title)}</h3>
				${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
				<pre class="curl"><code>${esc(curl)}</code></pre>
				${example ? `<details><summary>Example response</summary><pre><code>${example}</code></pre></details>` : ''}
			</article>`;
				})
				.join('')
		: `<div class="empty">
				<h3>Endpoints are coming soon</h3>
				<p>This bundle lists every endpoint here automatically as it ships. Check back shortly, or watch the <a href="/changelog">changelog</a>.</p>
			</div>`;

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>three.ws Crypto Data API: free &amp; keyless</title>
	<meta name="description" content="A free, keyless crypto data bundle for AI agents. One URL to discover every endpoint." />
	<style>
		:root {
			--bg: #ffffff; --fg: #0b0d12; --muted: #5b6472; --card: #f6f8fa;
			--border: #e4e8ee; --accent: #6d4aff; --code: #eef1f6;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #0b0d12; --fg: #e9edf4; --muted: #99a3b3; --card: #12151c;
				--border: #232935; --accent: #9d86ff; --code: #171b23;
			}
		}
		* { box-sizing: border-box; }
		body {
			margin: 0; background: var(--bg); color: var(--fg);
			font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			padding: 2.5rem 1.25rem 4rem;
		}
		main { max-width: 860px; margin: 0 auto; }
		.badges { display: flex; gap: .5rem; flex-wrap: wrap; margin: .75rem 0 0; }
		.badge {
			font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
			background: var(--accent); color: #fff; padding: .2rem .55rem; border-radius: 999px;
		}
		h1 { font-size: 1.9rem; margin: 0; letter-spacing: -.02em; }
		.lede { color: var(--muted); margin: .6rem 0 0; }
		.meta { color: var(--muted); font-size: .85rem; margin-top: 1rem; }
		.meta a { color: var(--accent); }
		.grid { display: grid; gap: 1rem; margin-top: 2rem; }
		.ep {
			background: var(--card); border: 1px solid var(--border); border-radius: 14px;
			padding: 1.1rem 1.2rem; transition: border-color .15s ease, transform .15s ease;
		}
		.ep:hover { border-color: var(--accent); }
		.ep header { display: flex; align-items: center; gap: .6rem; }
		.method {
			font-size: .72rem; font-weight: 700; color: #fff; background: #2f8f4e;
			padding: .12rem .5rem; border-radius: 6px; letter-spacing: .03em;
		}
		.path { font-size: .9rem; color: var(--fg); }
		.ep h3 { margin: .7rem 0 .25rem; font-size: 1.05rem; }
		.ep p { margin: 0 0 .7rem; color: var(--muted); }
		pre {
			background: var(--code); border: 1px solid var(--border); border-radius: 8px;
			padding: .7rem .8rem; overflow-x: auto; margin: .4rem 0 0; font-size: .82rem;
		}
		pre code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		details { margin-top: .5rem; }
		summary { cursor: pointer; color: var(--accent); font-size: .85rem; }
		.empty {
			text-align: center; padding: 3rem 1rem; background: var(--card);
			border: 1px dashed var(--border); border-radius: 14px; color: var(--muted);
		}
		.empty a { color: var(--accent); }
		footer { margin-top: 2.5rem; color: var(--muted); font-size: .82rem; }
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
		<p class="lede">One URL to discover the entire bundle: every endpoint, its inputs and outputs, and a live example. No account, no API key.</p>
		<p class="meta">
			${p.count} endpoint${p.count === 1 ? '' : 's'} ·
			<a href="/api/crypto/openapi.json">OpenAPI 3.1</a> ·
			<a href="/docs/crypto-api">Docs</a> ·
			<a href="/api/crypto">JSON</a>
		</p>
		<section class="grid">
			${rows}
		</section>
		<footer>Built for agents. <a href="/docs/crypto-api">Read the docs →</a></footer>
	</main>
</body>
</html>`;
}
