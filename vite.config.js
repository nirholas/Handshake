import { defineConfig } from 'vite';
import { resolve } from 'path';
import {
	readFileSync,
	readdirSync,
	copyFileSync,
	cpSync,
	createReadStream,
	existsSync,
	mkdirSync,
	statSync,
	rmSync,
} from 'fs';
import { extname, basename, relative, sep } from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { rewriteHead } from './server/seo-head.mjs';

// Dev parity for production's per-request <head> rewrite (server/seo-head.mjs).
// Shared-shell routes serve one template file for hundreds of paths (/docs/* and
// /tutorials/*), so in dev every one of them presented the shell's own title,
// description and canonical. Production rewrites that head from data/pages.json
// before the response leaves Cloud Run; without this the SEO of a docs page can
// only be checked after a deploy. Same module, same rules: a page whose shell
// already owns its canonical is untouched, and any error serves the plain shell.
function rewriteSeoHead(pathname, html) {
	try {
		return rewriteHead(pathname, html) || html;
	} catch {
		return html;
	}
}

// The build emits two targets controlled by the TARGET env var:
//
//   TARGET=lib    → builds dist-lib/agent-3d.js (ES module + UMD) for CDN use
//   TARGET=app    → (default) builds the editor/app site into dist/
//
//   npm run build        → app
//   npm run build:lib    → lib
//   npm run build:all    → both
const TARGET = process.env.TARGET || 'app';

// Entries that render inside a third-party page. They get neither the service
// worker (stripped after the build, below) nor the iOS bridge: both install
// document-level behaviour that belongs to three.ws, not to an embedder.
const IOS_BRIDGE_EXCLUDED = new Set([
	'widget.html',
	'embed.html',
	'avatar-embed.html',
	'agent-embed.html',
	'a-embed.html',
	'agent-token-page.html',
	'assistant-frame.html',
]);

// Any previously injected bridge tag, whatever hash it names, plus the
// whitespace the injector put in front of it.
const STALE_BRIDGE_TAG = /\s*<script type="module" src="\/ios-bridge\.[0-9a-f]+\.js"><\/script>/g;

// Prepended to every emitted chunk (app AND lib). `Object.hasOwn` is an ES2022
// *runtime API*, so esbuild's `target` never lowers it. It ships raw and throws
// "Object.hasOwn is not a function" on anything older than Chrome 93 / Safari
// 15.4. That killed /walk-embed outright on an Android 12 WebView (Chrome 91) in
// production. The embed's whole point is running inside third-party pages we
// don't control, so the floor has to be the old WebView, not our dev browser.
// defineProperty (not assignment) keeps it non-enumerable like the native one,
// so `for...in` over Object stays clean.
const LEGACY_RUNTIME_POLYFILL =
	'if(!Object.hasOwn){Object.defineProperty(Object,"hasOwn",{value:function(o,k){' +
	'if(o==null)throw new TypeError("Cannot convert undefined or null to object");' +
	'return Object.prototype.hasOwnProperty.call(Object(o),k)},' +
	'configurable:true,writable:true});}';

// Vercel serverless functions live under /api/* in production but Vite dev
// does not run them. Forward /api/* to a real upstream (default: production)
// so pages like /pumpfun see real SSE feeds and JSON responses in dev.
// Override with DEV_API_PROXY=http://localhost:3001 to point at vercel-dev.
const DEV_API_PROXY = process.env.DEV_API_PROXY || 'https://three.ws';
// Local override for /api/x402-pay (the demo's paid-call backend) so the agent
// payments settle from a locally-funded wallet in dev. Spin up the helper with
// `node scripts/dev-x402-pay-server.mjs` (reads .env for the agent wallet); Vite
// routes /api/x402-pay → here while other /api/* still proxy to prod. Defaults to
// the helper's port so a plain `npm run dev` works without an env prefix; if the
// helper isn't running the proxy's error handler below returns a clean 502 (not a
// crash). Set X402_PAY_DEV_URL='' to disable and fall back to the prod payer.
const X402_PAY_DEV_URL = process.env.X402_PAY_DEV_URL ?? 'http://localhost:3032';

// Auto-discover dashboard-next sub-pages so each agent can add an HTML file
// under pages/dashboard-next/ without touching this config. The Rollup input
// key is `dn-<filename>` (e.g. dn-index, dn-avatars). Missing directory is
// tolerated so the build keeps working before any page has landed.
function discoverDashboardNextInputs() {
	const dir = resolve(__dirname, 'pages/dashboard-next');
	if (!existsSync(dir)) return {};
	const entries = {};
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.html')) continue;
		const name = basename(f, '.html');
		entries[`dn-${name}`] = resolve(dir, f);
	}
	return entries;
}

// In a GitHub Codespace the browser reaches the dev server through the
// forwarded HTTPS domain (`<name>-3000.app.github.dev`) on port 443, not
// localhost:3000. Vite's HMR client otherwise tries to open a websocket to
// the raw host:port and both attempts fail ("[vite] failed to connect to
// websocket"), killing live-reload. Point the HMR client at the forwarded
// domain over wss/443 when those env vars are present; no-op locally.
// The forwarded host carries the dev server's OWN port, so read it back off the
// command line: concurrent agents routinely run `vite --port 3101`, and a
// hard-coded 3000 pointed their HMR client at a different (or absent) tunnel,
// which surfaces as a console error on every page rather than as a config bug.
const DEV_PORT = (() => {
	const i = process.argv.indexOf('--port');
	const n = i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT);
	return Number.isFinite(n) && n > 0 ? n : 3000;
})();
const CODESPACE_HMR =
	process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
		? {
				host: `${process.env.CODESPACE_NAME}-${DEV_PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
				protocol: 'wss',
				clientPort: 443,
			}
		: undefined;

// Content types for the file kinds `npm run build:chat` emits into public/chat.
// A dev-only static fallback needs exactly these; anything else is served as an
// octet-stream rather than guessed.
const CHAT_ASSET_TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
};

// Serve the built chat app (public/chat) for a /chat/* request. Used when the
// chat dev server on :5174 is unreachable, so a plain `npm run dev` still serves
// the same artifact production serves. Returns false when there is no build to
// serve, so the caller can explain how to make one.
function serveBuiltChat(req, res) {
	const root = resolve(__dirname, 'public/chat');
	if (!existsSync(resolve(root, 'index.html'))) return false;
	let pathname;
	try {
		pathname = decodeURIComponent((req.url || '/chat/').split('?')[0]);
	} catch {
		pathname = '/chat/';
	}
	const rel = pathname.replace(/^\/chat\/?/, '');
	const candidate = rel ? resolve(root, rel) : root;
	// Contain the fallback inside public/chat.
	const inRoot = candidate === root || candidate.startsWith(root + sep);
	const hit = inRoot && existsSync(candidate) && !statSync(candidate).isDirectory();
	let file;
	if (hit) {
		file = candidate;
	} else if (!extname(rel) || extname(rel).toLowerCase() === '.html') {
		// A document request the build has no file for: hand it the SPA shell,
		// which owns its own client-side routing.
		file = resolve(root, 'index.html');
	} else {
		// A missing asset has to read as missing. Answering it with the shell is
		// what made the browser refuse a module script for its text/html type.
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(`not found in public/chat: ${rel}\nrebuild with: npm run build:chat\n`);
		return true;
	}
	// writeHead (not setHeader) because Vite registers its own proxy error
	// handler after ours and answers 500 unless the headers are already
	// committed, which a streamed body only reaches on the next tick.
	res.writeHead(200, {
		'content-type': CHAT_ASSET_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
		'cache-control': 'no-store',
	});
	createReadStream(file).pipe(res);
	return true;
}

// Set by the threews-i18n-external-entry plugin's configResolved hook, read by
// its resolveId hook: a closure var rather than `this`, since Vite-only hooks
// (configResolved) aren't guaranteed the same PluginContext as Rollup hooks
// (resolveId).
let i18nExternalEntryIsBuild = true;

const appConfig = {
	server: {
		// Bind to 0.0.0.0 so the Codespace port-forwarder can reach the server.
		host: true,
		...(CODESPACE_HMR ? { hmr: CODESPACE_HMR } : {}),
		proxy: {
			'/r2-proxy': {
				target: 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/r2-proxy/, ''),
			},
			// PostHog serves its loader bundle and remote config from the assets
			// host under both /static/* and /array/* — route BOTH there. Without
			// the /array rule, `/ingest/array/<token>/config.js` falls through to
			// us.i.posthog.com (which doesn't serve it) and the browser refuses
			// the empty-MIME response: "not executable".
			'/ingest/static': {
				target: 'https://us-assets.i.posthog.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/ingest/, ''),
			},
			'/ingest/array': {
				target: 'https://us-assets.i.posthog.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/ingest/, ''),
			},
			'/ingest': {
				target: 'https://us.i.posthog.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/ingest/, ''),
			},
			'/chat': {
				// The chat UI is a separate Vite app served on :5174 (run
				// `cd chat && npm run dev`). `npm run dev` does not start it, so when
				// it is down every /chat request lands in this error handler: the
				// navigation AND each hashed asset the built HTML asks for. Answering
				// all of them with one HTML notice broke the route outright, because
				// the browser refuses /chat/assets/index-*.js for its text/html MIME
				// type and renders an empty <div id="app">. Serve the real built app
				// out of public/chat instead (what `npm run build:chat` emits and what
				// production serves), so /chat works locally with no second server.
				target: 'http://localhost:5174',
				changeOrigin: true,
				configure: (proxy) => {
					proxy.on('error', (err, req, res) => {
						if (!res || res.headersSent || res.writableEnded) return;
						if (serveBuiltChat(req, res)) return;
						res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
						res.end(
							`<!doctype html><meta charset="utf-8"><title>Chat build missing</title>` +
								`<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;` +
								`background:#0a0a0f;color:#e8e8f0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}` +
								`main{max-width:34rem;padding:2rem;text-align:center}code{background:#1a1a24;padding:.15em .45em;` +
								`border-radius:6px;font-size:.92em}a{color:#8ab4ff}</style>` +
								`<main><h1 style="margin:.2em 0;font-size:1.4rem">The chat app has not been built yet</h1>` +
								`<p>Build it once (it lands in <code>public/chat</code>, which this server then serves):</p>` +
								`<p><code>npm run build:chat</code></p>` +
								`<p>Or run it with hot reload in another terminal:</p>` +
								`<p><code>cd chat &amp;&amp; npm run dev</code></p>` +
								`<p style="opacity:.6;font-size:.9em">That dev server owns <code>:5174</code> and takes over ` +
								`<code>/chat</code> as soon as it is up. Dev-only notice ` +
								`(${(err && err.code) || 'upstream offline'}).</p></main>`,
						);
					});
				},
			},
			...(X402_PAY_DEV_URL
				? {
						'/api/x402-pay': {
							target: X402_PAY_DEV_URL,
							changeOrigin: true,
							secure: false,
							configure: (proxy) => {
								proxy.on('error', (err, req, res) => {
									if (!res || res.headersSent || res.writableEnded) return;
									const message =
										`x402-pay dev helper unreachable at ${X402_PAY_DEV_URL}: ${err.message}. ` +
										`Start it with: node scripts/dev-x402-pay-server.mjs`;
									// A read-only probe (the pay-wallet picker's ?balance=1 and ?agents=1)
									// gets the handler's real "no wallet here" shape, so dev renders the
									// designed neutral state instead of a red network error on every load.
									// These never fail over to the upstream: a paid call has to settle from
									// the locally funded helper, so a POST stays a hard 502 rather than
									// quietly spending production's wallet. writeHead (not setHeader)
									// because Vite registers its own proxy error handler after this one and
									// answers 500 unless the headers are already committed.
									if ((req.method || 'GET').toUpperCase() === 'GET') {
										res.writeHead(200, { 'content-type': 'application/json' });
										return res.end(
											JSON.stringify({
												configured: false,
												code: 'wallet_unconfigured',
												error: message,
												address: null,
												sol: 0,
												usdc: 0,
												agents: [],
											}),
										);
									}
									res.writeHead(502, { 'content-type': 'application/json' });
									res.end(JSON.stringify({ error: 'bad_gateway', message }));
								});
							},
						},
					}
				: {}),
			// /openapi.json is generated by the api/openapi-json function and
			// rewritten from /openapi.json in prod (vercel.json). Vite dev does
			// not run that function, so forward the bare path to the upstream so
			// the API-reference link on /pump-dashboard resolves in dev too.
			'/openapi.json': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
			},
			// Several /.well-known/* documents are generated by api/wk.js and
			// rewritten there by vercel.json (three-vanity.json, x402.json,
			// jwks.json, did.json …). Vite dev runs no functions, so pages that
			// pin themselves against one of those documents (e.g. /vanity/verify
			// pinning the vanity service key) could only ever see a 404 locally
			// and fell back to their degraded path on every dev run. Forward to
			// the upstream, but bypass anything that really is a static file
			// under public/.well-known so local edits to those still win.
			'/.well-known': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
				bypass: (req) => {
					const p = decodeURIComponent((req.url || '').split('?')[0]);
					if (p.includes('..')) return undefined;
					return existsSync(resolve(__dirname, 'public' + p)) ? req.url : undefined;
				},
			},
			// /oracle/coin/<mint> is a server-rendered share page: vercel.json
			// rewrites it to the api/oracle-share function, so no HTML file exists
			// for the dev route map to serve and the path 404s in dev while working
			// in prod. Every coin card on /watchlist and /launches links there, so
			// without this rule a local audit reports the page's primary link dead.
			// Mirror the production rewrite against the upstream instead.
			'^/oracle/coin/[1-9A-HJ-NP-Za-km-z]{32,44}/?$': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
				rewrite: (path) =>
					`/api/oracle-share?mint=${path.replace(/^\/oracle\/coin\//, '').replace(/\/$/, '')}`,
			},
			// /discover/a/<chain>/<id> and /discover/a/sol/<asset> are server-rendered
			// detail pages too: vercel.json rewrites them to the api/discover-detail
			// function, so no HTML file exists for the dev route map and the path 404s
			// in dev while working in prod. Every on-chain agent card on /search and
			// /discover links there, so without this rule a local audit reports those
			// results dead. Mirror the production rewrite against the upstream.
			'^/discover/a/(?:\\d+/\\d+|sol/[A-Za-z0-9]+)/?$': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
				rewrite: (path) => {
					const clean = path.replace(/\/$/, '');
					const onchain = clean.match(/^\/discover\/a\/(\d+)\/(\d+)$/);
					if (onchain) return `/api/discover-detail?kind=onchain&chain=${onchain[1]}&id=${onchain[2]}`;
					const solana = clean.match(/^\/discover\/a\/sol\/([A-Za-z0-9]+)$/);
					return `/api/discover-detail?kind=solana&asset=${solana[1]}`;
				},
			},
			'/api': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
				ws: true,
				// `api/_lib/**` is source code (library modules shared by serverless
				// handlers), never a routable endpoint — the leading underscore is
				// this repo's established "not a route" convention (mirrors Next/
				// Vercel). A few isomorphic BNB modules (src/bnb/move-sender.js,
				// src/agora/onchain-presence.js — prompts 15/16) import straight from
				// api/_lib/bnb/*.js via a relative path so the exact same code runs
				// server- and client-side with zero duplication. That relative import
				// resolves in the BROWSER to a same-origin request for
				// /api/_lib/bnb/*.js, which this proxy would otherwise swallow and
				// forward upstream (404 — no such route exists there), breaking those
				// modules in `vite dev` even though the production bundle (which
				// inlines everything at build time) never hits this path. Bypassing
				// the proxy for /api/_lib/** lets Vite's own static/module server
				// return the real source file instead, so dev and prod both work.
				bypass: (req) => {
					if (req.url && req.url.startsWith('/api/_lib/')) return req.url;
				},
				// SSE responses (text/event-stream) must not be buffered.
				// http-proxy + Node's stream pipe handle this when we don't
				// touch the response, so leave selfHandleResponse off.
				configure: (proxy) => {
					proxy.on('proxyReq', (proxyReq) => {
						// Disable any compression that would force buffering
						// of streaming responses on the upstream side.
						proxyReq.setHeader('accept-encoding', 'identity');
					});
					proxy.on('error', (err, _req, res) => {
						// Without this handler, an upstream connection failure
						// (ECONNREFUSED on a transient blip) bubbles up as an
						// uncaught exception and kills the dev server.
						if (!res || res.headersSent || res.writableEnded) return;
						// With ws:true, a failed WebSocket upgrade passes the raw
						// net.Socket here instead of an http ServerResponse. A socket
						// has no setHeader/statusCode, so calling them would itself
						// throw an uncaught exception and crash the dev server — which
						// is exactly the failure this handler exists to prevent. Just
						// close the socket and bail.
						if (typeof res.setHeader !== 'function') {
							res.destroy?.();
							return;
						}
						res.statusCode = 502;
						res.setHeader('content-type', 'application/json');
						res.end(
							JSON.stringify({
								error: 'bad_gateway',
								message: `api proxy → ${DEV_API_PROXY} failed: ${err.message}`,
							}),
						);
					});
				},
			},
		},
	},
	esbuild: {
		jsx: 'transform',
		jsxFactory: 'vhtml',
		jsxFragment: '"div"',
		jsxDev: false,
	},
	resolve: {
		// Force a single Three.js instance — addons (GLTFLoader, OrbitControls,
		// etc.) must share the same `three` module as the app, otherwise
		// Three's module-scoped registry warns "Multiple instances of Three.js".
		dedupe: ['three'],
		alias: {
			// Resolve `buffer` to the real (CommonJS) npm package instead of the
			// ESM shim vite-plugin-node-polyfills would otherwise alias it to. The
			// shim exposes only named exports, but Vite's dep-optimizer rewrites
			// `import { Buffer } from 'buffer'` into a CJS-interop *default* import
			// (`import m from 'buffer'; m.Buffer`). With the named-only shim that
			// default is missing and the module fails to link in dev with
			// "buffer.js does not provide an export named 'default'" (hit on /cz,
			// whose lib.js pulls Solana/Anchor deps served as source). The CJS
			// package, once prebundled by esbuild, exposes both default and named.
			buffer: resolve(__dirname, 'node_modules/buffer/index.js'),
			// `node-fetch` in a browser bundle is the platform fetch. Without this,
			// umi-http-fetch (inside @metaplex-foundation/umi-bundle-defaults, used
			// by /deploy-onchain) loads node-fetch's Node build, which dereferences
			// `stream.Readable.prototype` at module scope and crashes the page.
			'node-fetch': resolve(__dirname, 'src/shims/node-fetch-browser.js'),
		},
	},
	optimizeDeps: {
		include: [
			// Prebundle the real `buffer` package (see resolve.alias above) so
			// esbuild's CJS interop synthesizes the `default` export Vite's
			// dep-optimizer expects when rewriting named buffer imports.
			'buffer',
			'three',
			'three/addons/loaders/GLTFLoader.js',
			'three/addons/loaders/DRACOLoader.js',
			'three/addons/controls/OrbitControls.js',
			'three/addons/environments/RoomEnvironment.js',
			'three/addons/libs/meshopt_decoder.module.js',
			// Loaded lazily by src/shared/cinematic-render.js. Without it here the
			// dev optimizer discovers it mid-session and restarts the page under
			// whichever viewer just asked for an HDRI.
			'three/addons/loaders/HDRLoader.js',
		],
		exclude: ['@three-ws/agent-payments'],
	},
	// Web Workers go through their OWN rollup pass, so build.rollupOptions below
	// does not reach them: without this the grinder workers shipped unguarded
	// `Object.hasOwn` (eoa-grinder-worker did) and died on the same old WebViews.
	worker: {
		rollupOptions: { output: { banner: LEGACY_RUNTIME_POLYFILL } },
	},
	build: {
		chunkSizeWarningLimit: 1000,
		// Skip computing gzip/brotli sizes during build — saves several seconds on
		// large bundles (Three.js, ethers) without affecting the output.
		reportCompressedSize: false,
		rollupOptions: {
			external: [
				'/launch/launch.js',
				'/launch-studio/launch-studio.js',
				'/studio/launch-panel.js',
				'/studio/fees-panel.js',
				'./fees-panel.js',
				/^@three-ws\/agent-payments(\/.*)?$/,
			],
			output: {
				// Every chunk, not just entries: with ES modules a shared chunk's
				// body evaluates BEFORE the entry that imports it, so an
				// entry-only banner would land too late to protect it.
				banner: LEGACY_RUNTIME_POLYFILL,
				manualChunks(id) {
					// Node polyfills (buffer/process shims) get their own tiny chunk.
					// Without this, Rollup colocates the `buffer` module inside the
					// 1 MB `solana` chunk — and any chunk that needs the injected
					// Buffer global (e.g. three-addons via its exporters) then
					// imports the whole solana chunk, which transitively chains
					// ethers too. That single colocation put ~1.4 MB of crypto code
					// on the home page's critical path.
					if (
						id.includes('node_modules/buffer/') ||
						id.includes('node_modules/process/') ||
						id.includes('vite-plugin-node-polyfills')
					)
						return 'node-polyfills';
					if (id.includes('node_modules/three/')) {
						if (id.includes('three/examples/') || id.includes('three/addons/'))
							return 'three-addons';
						return 'three-core';
					}
					if (id.includes('node_modules/ethers/')) return 'ethers';
					if (
						id.includes('node_modules/@solana/') ||
						id.includes('node_modules/@coral-xyz/')
					)
						return 'solana';
					if (id.includes('node_modules/@mediapipe/')) return 'mediapipe';
					// Rapier is 2.2 MB of WASM glue and is ALWAYS loaded through a
					// dynamic import (see src/physics/physics-world.js). Left to
					// Rollup's automatic grouping it gets folded into whichever
					// shared chunk happens to also be statically reachable, and on
					// /play it was: it rode a shared world-HUD chunk onto the
					// critical path and cost the world 800 KB gzip before the first
					// frame. Pinning it here means no future static import can drag
					// the physics engine back in front of the world.
					if (id.includes('node_modules/@dimforge/')) return 'rapier';
				},
				// A few entries need stable, unhashed filenames so plain public/
				// scripts can load them by a predictable URL without knowing the
				// build hash: footer.js → /footer-bot.js, nav.js → /walk-companion.js.
				entryFileNames: (chunk) =>
					chunk.name === 'footer-bot' ||
					chunk.name === 'walk-companion' ||
					chunk.name === 'walk-playground' ||
					chunk.name === 'feature-tour' ||
					chunk.name === 'notifications' ||
					chunk.name === 'herald' ||
					chunk.name === 'nav-tier-badge' ||
					chunk.name === 'agent-bus' ||
					chunk.name === 'i18n'
						? `${chunk.name}.js`
						: 'assets/[name]-[hash].js',
			},
			input: {
				'footer-bot': resolve(__dirname, 'src/footer-bot.js'),
				'walk-companion': resolve(__dirname, 'src/walk-companion.js'),
				'agent-bus': resolve(__dirname, 'src/agents/agent-bus.js'),
				'walk-playground': resolve(__dirname, 'src/walk-playground.js'),
				'feature-tour': resolve(__dirname, 'src/feature-tour.js'),
				notifications: resolve(__dirname, 'src/notifications.js'),
				// /herald.js: the CDN build of @three-ws/herald, imported by
				// third-party pages and by /herald's own playground.
				herald: resolve(__dirname, 'src/herald-embed.js'),
				'nav-tier-badge': resolve(__dirname, 'src/nav-tier-badge.js'),
				i18n: resolve(__dirname, 'src/i18n.js'),
				drops: resolve(__dirname, 'pages/drops.html'),
				'home-scene': resolve(__dirname, 'pages/home-scene.html'),
				materialize: resolve(__dirname, 'pages/materialize.html'),
				'smart-home': resolve(__dirname, 'pages/smart-home.html'),
				'smart-home-join': resolve(__dirname, 'pages/smart-home-join.html'),
				'smart-home-plan': resolve(__dirname, 'pages/smart-home-plan.html'),
				'smart-home-privacy': resolve(__dirname, 'pages/smart-home-privacy.html'),
				'smart-home-satellite': resolve(__dirname, 'pages/smart-home-satellite.html'),
				'materialize-order': resolve(__dirname, 'pages/materialize-order.html'),
				'materialize-ops': resolve(__dirname, 'pages/materialize-ops.html'),
				'drop-collection': resolve(__dirname, 'pages/drop-collection.html'),
				spotlight: resolve(__dirname, 'pages/spotlight.html'),
				'spotlight-entry': resolve(__dirname, 'pages/spotlight-entry.html'),
				certificate: resolve(__dirname, 'pages/certificate.html'),
				'print-insert': resolve(__dirname, 'pages/print-insert.html'),
				app: resolve(__dirname, 'pages/app.html'),
				proof: resolve(__dirname, 'pages/proof.html'),
				stream: resolve(__dirname, 'pages/stream.html'),
				preflight: resolve(__dirname, 'pages/preflight.html'),
				'app-next': resolve(__dirname, 'pages/app-next.html'),
				home: resolve(__dirname, 'pages/home.html'),
				'what-is': resolve(__dirname, 'pages/what-is.html'),
				atlas: resolve(__dirname, 'pages/atlas.html'),
				tour: resolve(__dirname, 'pages/tour.html'),
				'tour-atlas': resolve(__dirname, 'pages/tour-atlas.html'),
				concierge: resolve(__dirname, 'pages/concierge.html'),
				drive: resolve(__dirname, 'pages/drive.html'),
				'voice-home': resolve(__dirname, 'pages/voice-home.html'),
				'tour-builder': resolve(__dirname, 'pages/tour-builder.html'),
				'agent-identities': resolve(__dirname, 'pages/agent-identities.html'),
				'mcp-tools': resolve(__dirname, 'pages/mcp-tools.html'),
				'render-lab': resolve(__dirname, 'pages/render-lab.html'),
				holo: resolve(__dirname, 'pages/holo.html'),
				bundles: resolve(__dirname, 'pages/bundles.html'),
				'embed-doctor': resolve(__dirname, 'pages/embed-doctor.html'),
				crews: resolve(__dirname, 'pages/crews.html'),
				inspect: resolve(__dirname, 'pages/inspect.html'),
				pitch: resolve(__dirname, 'pages/pitch.html'),
				timeline: resolve(__dirname, 'pages/timeline.html'),
				tracker: resolve(__dirname, 'pages/tracker.html'),
				features: resolve(__dirname, 'pages/features.html'),
				'features-ar': resolve(__dirname, 'pages/features/ar.html'),
				'features-forge': resolve(__dirname, 'pages/features/forge.html'),
				'features-scan': resolve(__dirname, 'pages/features/scan.html'),
				'features-play': resolve(__dirname, 'pages/features/play.html'),
				'features-walk': resolve(__dirname, 'pages/features/walk.html'),
				'features-studio': resolve(__dirname, 'pages/features/studio.html'),
				'features-marketplace': resolve(__dirname, 'pages/features/marketplace.html'),
				'features-agent-exchange': resolve(__dirname, 'pages/features/agent-exchange.html'),
				'features-deploy': resolve(__dirname, 'pages/features/deploy.html'),
				tutorials: resolve(__dirname, 'pages/tutorials.html'),
				walkthroughs: resolve(__dirname, 'pages/walkthroughs.html'),
				walkthrough: resolve(__dirname, 'pages/walkthrough.html'),
				tutorial: resolve(__dirname, 'pages/tutorial.html'),
				cookbook: resolve(__dirname, 'pages/cookbook.html'),
				recipe: resolve(__dirname, 'pages/recipe.html'),
				'pipeline-studio': resolve(__dirname, 'pages/pipeline-studio.html'),
				glossary: resolve(__dirname, 'pages/glossary.html'),
				playground: resolve(__dirname, 'pages/playground.html'),
				coin3d: resolve(__dirname, 'pages/coin3d.html'),
				'hero-demo': resolve(__dirname, 'pages/hero-demo.html'),
				constellation: resolve(__dirname, 'pages/constellation.html'),
				embed: resolve(__dirname, 'pages/embed.html'),
				'embed-demo': resolve(__dirname, 'pages/embed-demo.html'),
				assistant: resolve(__dirname, 'pages/assistant.html'),
				'assistant-frame': resolve(__dirname, 'pages/assistant-frame.html'),
				// Embodiment embed: a living, rigged agent body (lip-sync + emotion
				// + idle) that renders inline in ChatGPT/Claude. Registered as an
				// input so its inline module graph — /apps-sdk/embodiment/* → three
				// → src/animation-* + src/embodiment/* — gets bundled to /assets/*
				// chunks instead of shipping unresolved bare imports.
				'embodiment-embed': resolve(__dirname, 'pages/embodiment/embed.html'),
				integrations: resolve(__dirname, 'pages/integrations.html'),
				partners: resolve(__dirname, 'pages/partners.html'),
				sperax: resolve(__dirname, 'pages/sperax.html'),
				widget: resolve(__dirname, 'pages/widget.html'),
				launchpad: resolve(__dirname, 'pages/launchpad.html'),
				launch: resolve(__dirname, 'pages/launch.html'),
				'launch-studio': resolve(__dirname, 'pages/launch-studio.html'),
				start: resolve(__dirname, 'pages/start.html'),
				create: resolve(__dirname, 'pages/create.html'),
				'create-agent': resolve(__dirname, 'pages/create-agent.html'),
				forge: resolve(__dirname, 'pages/forge.html'),
				'nim-forge': resolve(__dirname, 'pages/nim-forge.html'),
				'forge-nim': resolve(__dirname, 'pages/forge-nim.html'),
				'forge-spark': resolve(__dirname, 'pages/forge-spark.html'),
				dad: resolve(__dirname, 'pages/dad.html'),
				'forge-studio': resolve(__dirname, 'pages/forge-studio.html'),
				'forge-embed': resolve(__dirname, 'pages/forge-embed.html'),
				restyle: resolve(__dirname, 'pages/restyle.html'),
				scene: resolve(__dirname, 'pages/scene.html'),
				segment: resolve(__dirname, 'pages/segment.html'),
				'create-selfie': resolve(__dirname, 'pages/create-selfie.html'),
				seeker: resolve(__dirname, 'pages/seeker.html'),
				'create-prompt': resolve(__dirname, 'pages/create-prompt.html'),
				genesis: resolve(__dirname, 'pages/genesis.html'),
				worlds: resolve(__dirname, 'pages/worlds.html'),
				'docs-world': resolve(__dirname, 'pages/docs-world.html'),
				'docs-freshness': resolve(__dirname, 'pages/docs-freshness.html'),
				'avatar-studio': resolve(__dirname, 'pages/avatar-studio.html'),
				'create-review': resolve(__dirname, 'pages/create-review.html'),
				'import-rpm': resolve(__dirname, 'pages/import-rpm.html'),
				marketplace: resolve(__dirname, 'pages/marketplace.html'),
				'marketplace-walk': resolve(__dirname, 'pages/marketplace-walk.html'),
				'marketplace-analytics': resolve(__dirname, 'pages/marketplace-analytics.html'),
				conversions: resolve(__dirname, 'pages/conversions.html'),
				collection: resolve(__dirname, 'pages/collection.html'),
				// Key must NOT be `notifications` — that key at the top of this input
				// object is the nav-bell module (src/notifications.js), which nav.js
				// loads on every page as /notifications.js. A duplicate key here
				// silently replaced it (later key wins), so the bell only worked
				// because this page's bundle happened to import the bell module
				// transitively. HTML output paths come from the source file path,
				// not the input key, so the page still emits dist/notifications.html.
				'notifications-page': resolve(__dirname, 'pages/notifications.html'),
				// The @three-ws/herald playground. Key must NOT be `herald`: that is
				// the CDN module entry above, and a duplicate key would silently
				// replace it.
				'herald-page': resolve(__dirname, 'pages/herald.html'),
				companion: resolve(__dirname, 'pages/companion.html'),
				knock: resolve(__dirname, 'pages/knock.html'),
				'knock-door': resolve(__dirname, 'pages/knock-door.html'),
				portal: resolve(__dirname, 'pages/portal.html'),
				feedback: resolve(__dirname, 'pages/feedback.html'),
				diff: resolve(__dirname, 'pages/diff.html'),
				'agent-edit': resolve(__dirname, 'pages/agent-edit.html'),
				'agent-mind': resolve(__dirname, 'pages/agent-mind.html'),
				'avatar-edit': resolve(__dirname, 'pages/avatar-edit.html'),
				'create-video': resolve(__dirname, 'pages/create/video.html'),
				'extension-privacy': resolve(__dirname, 'pages/extension-privacy.html'),
				'extension-terms': resolve(__dirname, 'pages/extension-terms.html'),
				'embed-walk': resolve(__dirname, 'pages/embed-walk.html'),
				'agent-embed': resolve(__dirname, 'pages/agent-embed.html'),
				'agent-detail': resolve(__dirname, 'pages/agent-detail.html'),
				'agent-detail-classic': resolve(__dirname, 'pages/agent-detail-classic.html'),
				'agent-screen': resolve(__dirname, 'pages/agent-screen.html'),
				'agents-live': resolve(__dirname, 'pages/agents-live.html'),
				monitor: resolve(__dirname, 'pages/monitor.html'),
				'agent-wallet': resolve(__dirname, 'pages/agent-wallet.html'),
				wallet: resolve(__dirname, 'pages/wallet.html'),
				guardian: resolve(__dirname, 'pages/guardian.html'),
				launches: resolve(__dirname, 'pages/launches.html'),
				minted: resolve(__dirname, 'pages/minted.html'),
				creations: resolve(__dirname, 'pages/creations.html'),
				pulse: resolve(__dirname, 'pages/pulse.html'),
				'economy-lab': resolve(__dirname, 'pages/economy-lab.html'),
				flow: resolve(__dirname, 'pages/flow.html'),
				symphony: resolve(__dirname, 'pages/symphony.html'),
				diorama: resolve(__dirname, 'pages/diorama.html'),
				receipts: resolve(__dirname, 'pages/receipts.html'),
				fits: resolve(__dirname, 'pages/fits.html'),
				viability: resolve(__dirname, 'pages/viability.html'),
				deployments: resolve(__dirname, 'pages/deployments.html'),
				deployOnchain: resolve(__dirname, 'pages/deploy-onchain.html'),
				pill: resolve(__dirname, 'pages/pill.html'),
				portfolio: resolve(__dirname, 'pages/portfolio.html'),
				airdrops: resolve(__dirname, 'pages/airdrops.html'),
				launcher: resolve(__dirname, 'pages/launcher.html'),
				'launch-detail': resolve(__dirname, 'pages/launch-detail.html'),
				model: resolve(__dirname, 'pages/model.html'),
				watchlist: resolve(__dirname, 'pages/watchlist.html'),
				leaderboard: resolve(__dirname, 'pages/leaderboard.html'),
				'labor-market': resolve(__dirname, 'pages/labor-market.html'),
				vaults: resolve(__dirname, 'pages/vaults.html'),
				'alpha-copilot': resolve(__dirname, 'pages/alpha-copilot.html'),
				'reasoning-ledger': resolve(__dirname, 'pages/reasoning-ledger.html'),
				'fact-check': resolve(__dirname, 'pages/fact-check.html'),
				mirror: resolve(__dirname, 'pages/mirror.html'),
				strategies: resolve(__dirname, 'pages/strategies.html'),
				swarms: resolve(__dirname, 'pages/swarms.html'),
				'ui-juice': resolve(__dirname, 'pages/ui-juice.html'),
				terminal: resolve(__dirname, 'pages/terminal.html'),
				trader: resolve(__dirname, 'pages/trader.html'),
				signals: resolve(__dirname, 'pages/signals.html'),
				'signal-detail': resolve(__dirname, 'pages/signal-detail.html'),
				trades: resolve(__dirname, 'pages/trades.html'),
				trading: resolve(__dirname, 'pages/trading.html'),
				'exit-lab': resolve(__dirname, 'pages/exit-lab.html'),
				'claim-wallet': resolve(__dirname, 'pages/claim-wallet.html'),
				'meta-allocator': resolve(__dirname, 'pages/meta-allocator.html'),
				'ghost-copy': resolve(__dirname, 'pages/ghost-copy.html'),
				wrapped: resolve(__dirname, 'pages/wrapped.html'),
				'clip-director': resolve(__dirname, 'pages/clip-director.html'),
				'avatar-embed': resolve(__dirname, 'pages/avatar-embed.html'),
				'avatar-wallet-chat': resolve(__dirname, 'pages/avatar-wallet-chat.html'),
				'agent-exchange': resolve(__dirname, 'pages/agent-exchange.html'),
				'demo-economy': resolve(__dirname, 'pages/demo-economy.html'),
				live: resolve(__dirname, 'pages/live.html'),
				'agent-economy': resolve(__dirname, 'pages/agent-economy.html'),
				'agent-economy-volume': resolve(__dirname, 'pages/agent-economy-volume.html'),
				economy: resolve(__dirname, 'pages/economy.html'),
				'overlay-control': resolve(__dirname, 'pages/overlay-control.html'),
				'mocap-studio': resolve(__dirname, 'pages/mocap-studio.html'),
				handle: resolve(__dirname, 'pages/handle.html'),
				'a-embed': resolve(__dirname, 'pages/a-embed.html'),
				'a-edit': resolve(__dirname, 'pages/a-edit.html'),
				'a-me': resolve(__dirname, 'pages/a-me.html'),
				labs: resolve(__dirname, 'pages/labs.html'),
				'quality-bench': resolve(__dirname, 'pages/quality-bench.html'),
				'likeness-bench': resolve(__dirname, 'pages/likeness-bench.html'),
				'payment-outcomes': resolve(__dirname, 'pages/payment-outcomes.html'),
				search: resolve(__dirname, 'pages/search.html'),
				rankings: resolve(__dirname, 'pages/rankings.html'),
				'daily-match': resolve(__dirname, 'pages/daily-match.html'),
				'fact-checker': resolve(__dirname, 'pages/fact-checker.html'),
				unstoppable: resolve(__dirname, 'pages/unstoppable.html'),
				shopper: resolve(__dirname, 'pages/shopper.html'),
				go: resolve(__dirname, 'pages/go.html'),
				bounties: resolve(__dirname, 'pages/bounties.html'),
				bounty: resolve(__dirname, 'pages/bounty.html'),
				'pump-live': resolve(__dirname, 'pages/pump-live.html'),
				radar: resolve(__dirname, 'pages/radar.html'),
				oracle: resolve(__dirname, 'pages/oracle.html'),
				'oracle-docs': resolve(__dirname, 'pages/oracle-docs.html'),
				arm: resolve(__dirname, 'pages/arm.html'),
				ca2x402: resolve(__dirname, 'pages/ca2x402.html'),
				activity: resolve(__dirname, 'pages/activity.html'),
				tty: resolve(__dirname, 'pages/tty.html'),
				guards: resolve(__dirname, 'pages/guards.html'),
				brownout: resolve(__dirname, 'pages/brownout.html'),
				pipeline: resolve(__dirname, 'pages/pipeline.html'),
				'coin-intel': resolve(__dirname, 'pages/coin-intel.html'),
				'oracle-lab': resolve(__dirname, 'pages/oracle-lab.html'),
				coins: resolve(__dirname, 'pages/coins.html'),
				coin: resolve(__dirname, 'pages/coin.html'),
				drop: resolve(__dirname, 'pages/drop.html'),
				markets: resolve(__dirname, 'pages/markets.html'),
				'markets-news': resolve(__dirname, 'pages/markets-news.html'),
				'news-digest': resolve(__dirname, 'pages/news-digest.html'),
				'news-article': resolve(__dirname, 'pages/news-article.html'),
				'news-archive': resolve(__dirname, 'pages/news-archive.html'),
				'fear-greed': resolve(__dirname, 'pages/fear-greed.html'),
				heatmap: resolve(__dirname, 'pages/heatmap.html'),
				gas: resolve(__dirname, 'pages/gas.html'),
				compare: resolve(__dirname, 'pages/compare.html'),
				screener: resolve(__dirname, 'pages/screener.html'),
				categories: resolve(__dirname, 'pages/categories.html'),
				exchanges: resolve(__dirname, 'pages/exchanges.html'),
				derivatives: resolve(__dirname, 'pages/derivatives.html'),
				converter: resolve(__dirname, 'pages/converter.html'),
				defi: resolve(__dirname, 'pages/defi.html'),
				chains: resolve(__dirname, 'pages/chains.html'),
				stablecoins: resolve(__dirname, 'pages/stablecoins.html'),
				exchange: resolve(__dirname, 'pages/exchange.html'),
				category: resolve(__dirname, 'pages/category.html'),
				yields: resolve(__dirname, 'pages/yields.html'),
				protocol: resolve(__dirname, 'pages/protocol.html'),
				chain: resolve(__dirname, 'pages/chain.html'),
				stablecoin: resolve(__dirname, 'pages/stablecoin.html'),
				'markets-trending': resolve(__dirname, 'pages/markets-trending.html'),
				'markets-robinhood': resolve(__dirname, 'pages/markets-robinhood.html'),
				fees: resolve(__dirname, 'pages/fees.html'),
				'sniper-experiments': resolve(__dirname, 'pages/sniper-experiments.html'),
				'dex-volumes': resolve(__dirname, 'pages/dex-volumes.html'),
				hacks: resolve(__dirname, 'pages/hacks.html'),
				bnb: resolve(__dirname, 'pages/bnb.html'),
				'bnb-latency': resolve(__dirname, 'pages/bnb-latency.html'),
				vault: resolve(__dirname, 'pages/vault.html'),
				trending: resolve(__dirname, 'pages/trending.html'),
				compose: resolve(__dirname, 'pages/compose.html'),
				'create-next': resolve(__dirname, 'pages/create-next.html'),
				'mint-success': resolve(__dirname, 'pages/mint-success.html'),
				'pump-dashboard': resolve(__dirname, 'pages/pump-dashboard.html'),
				autopilot: resolve(__dirname, 'pages/autopilot.html'),
				'pump-visualizer': resolve(__dirname, 'pages/pump-visualizer.html'),
				crypto: resolve(__dirname, 'pages/crypto.html'),
				'crypto-api': resolve(__dirname, 'pages/crypto-api.html'),
				three: resolve(__dirname, 'pages/three.html'),
				'three-live': resolve(__dirname, 'pages/three-live.html'),
				'three-token': resolve(__dirname, 'pages/three-token.html'),
				'avatar-artifact': resolve(__dirname, 'pages/avatar-artifact.html'),
				'launch-week': resolve(__dirname, 'pages/three-ws-launch-week.html'),
				community: resolve(__dirname, 'pages/community.html'),
				profile: resolve(__dirname, 'pages/profile.html'),
				feed: resolve(__dirname, 'pages/feed.html'),
				'threews-claim': resolve(__dirname, 'pages/threews-claim.html'),
				'events-build-3d-agents-live': resolve(
					__dirname,
					'pages/events/build-3d-agents-live.html',
				),
				'avatar-page': resolve(__dirname, 'pages/avatar-page.html'),
				'avatar-sdk': resolve(__dirname, 'pages/avatar-sdk.html'),
				'avatar-cli': resolve(__dirname, 'pages/avatar-cli.html'),
				'rig-doctor': resolve(__dirname, 'pages/rig-doctor.html'),
				brain: resolve(__dirname, 'pages/brain.html'),
				'agent-studio': resolve(__dirname, 'pages/agent-studio.html'),
				cosmos: resolve(__dirname, 'pages/cosmos.html'),
				voice: resolve(__dirname, 'pages/voice.html'),
				galaxy: resolve(__dirname, 'pages/galaxy.html'),
				examples: resolve(__dirname, 'pages/examples.html'),
				genome: resolve(__dirname, 'pages/genome.html'),
				'ar-page': resolve(__dirname, 'pages/ar.html'),
				pricing: resolve(__dirname, 'pages/pricing.html'),
				billing: resolve(__dirname, 'pages/billing.html'),
				credits: resolve(__dirname, 'pages/credits.html'),
				payments: resolve(__dirname, 'pages/payments.html'),
				'pay-simulator': resolve(__dirname, 'pages/pay-simulator.html'),
				'x-pricing': resolve(__dirname, 'pages/x-pricing.html'),
				'gallery-picker': resolve(__dirname, 'pages/gallery-picker.html'),
				status: resolve(__dirname, 'pages/status.html'),
				xr: resolve(__dirname, 'pages/xr.html'),
				temporary: resolve(__dirname, 'pages/temporary.html'),
				irl: resolve(__dirname, 'pages/irl.html'),
				daily: resolve(__dirname, 'pages/daily.html'),
				'ar-studio': resolve(__dirname, 'pages/ar-studio.html'),
				'ar-view': resolve(__dirname, 'pages/ar-view.html'),
				'irl-privacy': resolve(__dirname, 'pages/irl-privacy.html'),
				'world-lines': resolve(__dirname, 'pages/world-lines.html'),
				communities: resolve(__dirname, 'pages/communities.html'),
				clash: resolve(__dirname, 'pages/clash.html'),
				'walk-embed': resolve(__dirname, 'pages/walk-embed.html'),
				'walk-landing': resolve(__dirname, 'pages/walk-landing.html'),
				'walk-leaderboard': resolve(__dirname, 'pages/walk-leaderboard.html'),
				'walk-analytics': resolve(__dirname, 'pages/walk-analytics.html'),
				city: resolve(__dirname, 'pages/city.html'),
				agora: resolve(__dirname, 'pages/agora.html'),
				play: resolve(__dirname, 'pages/play.html'),
				'play-agent-wallet': resolve(__dirname, 'pages/play/agent-wallet.html'),
				'play-arena': resolve(__dirname, 'pages/play/arena.html'),
				'play-war': resolve(__dirname, 'pages/play/war.html'),
				'play-ufo': resolve(__dirname, 'pages/play/ufo.html'),
				event: resolve(__dirname, 'pages/event.html'),
				'play-economy': resolve(__dirname, 'pages/play/economy.html'),
				'play-solver': resolve(__dirname, 'pages/play/solver.html'),
				agi: resolve(__dirname, 'pages/agi.html'),
				arena: resolve(__dirname, 'pages/arena.html'),
				'smart-money': resolve(__dirname, 'pages/smart-money.html'),
				pose: resolve(__dirname, 'pages/pose.html'),
				'pose-mini': resolve(__dirname, 'pages/pose-mini.html'),
				animations: resolve(__dirname, 'pages/animations.html'),
				gestures: resolve(__dirname, 'pages/gestures.html'),
				choreograph: resolve(__dirname, 'pages/choreograph.html'),
				'character-library': resolve(__dirname, 'pages/character-library.html'),
				'sign-language': resolve(__dirname, 'pages/sign-language.html'),
				'asl-alphabet': resolve(__dirname, 'pages/asl-alphabet.html'),
				'sign-mirror': resolve(__dirname, 'pages/sign-mirror.html'),
				objects: resolve(__dirname, 'pages/objects.html'),
				forged: resolve(__dirname, 'pages/forged.html'),
				wardrobe: resolve(__dirname, 'pages/wardrobe.html'),
				'avatar-engines': resolve(__dirname, 'pages/avatar-engines.html'),
				splat: resolve(__dirname, 'pages/splat.html'),
				capture: resolve(__dirname, 'pages/capture.html'),
				'motion-swap': resolve(__dirname, 'pages/motion-swap.html'),
				club: resolve(__dirname, 'pages/club.html'),
				theater: resolve(__dirname, 'pages/theater.html'),
				stage: resolve(__dirname, 'pages/stage.html'),
				skills: resolve(__dirname, 'pages/skills.html'),
				'agenc-embodied': resolve(__dirname, 'pages/agenc/embodied.html'),
				'agenc-room': resolve(__dirname, 'pages/agenc/room.html'),
				studio: resolve(__dirname, 'public/studio/index.html'),
				reputation: resolve(__dirname, 'public/reputation/index.html'),
				// /reputation/market loads a module that imports the shared earnings
				// engine (src/shared/reputation-staking.js) and lazily pulls the Solana
				// signer (src/solana-stake.js). Served as a raw publicDir copy those
				// `/src/*` refs 404 in production and the market renders empty forever,
				// so register it as an input and promote the bundled output below.
				'reputation-market': resolve(__dirname, 'public/reputation/market/index.html'),
				hydrate: resolve(__dirname, 'public/hydrate/index.html'),
				// /agent/index.html is reachable as a static page (vercel.json
				// routes it to itself). Registering it as a Vite input bundles
				// its inline modules (incl. pump-modals, agent-token-widget)
				// instead of shipping /src/* refs that 404 in production.
				'agent-token-page': resolve(__dirname, 'public/agent/index.html'),
				// /login lives in public/ but its inline avatar module imports the
				// bare `@three-ws/agent-ui` specifier. Registering it as an input
				// bundles that module so the sign-in avatar renders in production
				// instead of shipping an unresolvable bare import.
				login: resolve(__dirname, 'public/login.html'),
				register: resolve(__dirname, 'public/register.html'),
				// /agents and /validation live in public/ and load module
				// scripts that pull bare npm specifiers (`ethers`, JSX
				// components). Registering them as inputs bundles those graphs
				// so resolved /assets/* chunks ship instead of raw /src/* refs
				// that throw "Failed to resolve module specifier" / "text/jsx"
				// in production. Promoted over the raw publicDir copy below.
				'agents-directory': resolve(__dirname, 'public/agents/index.html'),
				validation: resolve(__dirname, 'public/validation/index.html'),
				// /characters and /character/:id load `/src/characters.js` and
				// `/src/character.js`, both of which `import './ui-juice.css'` — a
				// Vite-only construct. Served raw, the browser fetched that CSS as a
				// module script, got `text/css`, and refused it under strict MIME
				// checking. The entry module never executed, so BOTH pages rendered an
				// empty grid in production. Registering them as inputs bundles the
				// graph and extracts the CSS into a <link>. Promoted below.
				characters: resolve(__dirname, 'public/characters.html'),
				character: resolve(__dirname, 'public/character.html'),
				// BEGIN:DISCOVER_ROUTE
				'my-agents': resolve(__dirname, 'public/my-agents/index.html'),
				discover: resolve(__dirname, 'public/discover/index.html'),
				gallery: resolve(__dirname, 'public/gallery/index.html'),
				// END:DISCOVER_ROUTE
				'vanity-wallet': resolve(__dirname, 'public/vanity-wallet.html'),
				'vanity-verify': resolve(__dirname, 'public/vanity/verify/index.html'),
				'vanity-gallery': resolve(__dirname, 'public/vanity/gallery/index.html'),
				'vanity-premium': resolve(__dirname, 'public/vanity/premium/index.html'),
				'vanity-bounties': resolve(__dirname, 'public/vanity/bounties/index.html'),
				'eth-vanity': resolve(__dirname, 'public/eth-vanity.html'),
				'evm-wallet': resolve(__dirname, 'public/evm-wallet.html'),
				pay: resolve(__dirname, 'public/pay/index.html'),
				'pay-calls': resolve(__dirname, 'public/pay/calls/index.html'),
				'pay-checkout': resolve(__dirname, 'public/pay/c/index.html'),
				'x402-stripe': resolve(__dirname, 'public/x402-stripe.html'),
				'x402-dashboard': resolve(__dirname, 'public/dashboard/x402.html'),
				sitemap: resolve(__dirname, 'public/sitemap/index.html'),
				'avatar-os-hub': resolve(__dirname, 'public/demo/avatar-os/index.html'),
				'avatar-os-studio': resolve(__dirname, 'public/demo/avatar-os/studio.html'),
				'avatar-os-selfie': resolve(__dirname, 'public/demo/avatar-os/selfie.html'),
				'avatar-os-combined': resolve(__dirname, 'public/demo/avatar-os/combined.html'),
				'demos-brain': resolve(__dirname, 'public/demos/brain.html'),
				'demos-lipsync-tts': resolve(__dirname, 'public/demos/lipsync-tts.html'),
				'demos-lipsync-mic': resolve(__dirname, 'public/demos/lipsync-mic.html'),
				'demos-audio2face': resolve(__dirname, 'public/demos/audio2face.html'),
				'demos-erc8004': resolve(__dirname, 'public/demos/erc8004.html'),
				'demos-button-jump': resolve(__dirname, 'public/demos/button-jump.html'),
				'demos-button': resolve(__dirname, 'public/demos/button.html'),
				'demos-3d-home': resolve(__dirname, 'public/demos/3d-home.html'),
				'demos-halfbody-xr': resolve(__dirname, 'public/demos/halfbody-xr.html'),
				// /demos/agents/* — agent interaction lab.
				'agents-index': resolve(__dirname, 'public/demos/agents/index.html'),
				'agents-cursor-follower': resolve(
					__dirname,
					'public/demos/agents/cursor-follower.html',
				),
				'agents-high-five': resolve(__dirname, 'public/demos/agents/high-five.html'),
				'agents-pickup-drop': resolve(__dirname, 'public/demos/agents/pickup-drop.html'),
				'agents-fall-from-top': resolve(
					__dirname,
					'public/demos/agents/fall-from-top.html',
				),
				'agents-trampoline': resolve(__dirname, 'public/demos/agents/trampoline.html'),
				'agents-wrecking-ball': resolve(
					__dirname,
					'public/demos/agents/wrecking-ball.html',
				),
				'agents-climb-title': resolve(__dirname, 'public/demos/agents/climb-title.html'),
				'agents-skateboard': resolve(__dirname, 'public/demos/agents/skateboard.html'),
				'agents-sit-in-body': resolve(__dirname, 'public/demos/agents/sit-in-body.html'),
				'agents-scroll-inertia': resolve(
					__dirname,
					'public/demos/agents/scroll-inertia.html',
				),
				'agents-walks-gutter': resolve(__dirname, 'public/demos/agents/walks-gutter.html'),
				'agents-holds-cta': resolve(__dirname, 'public/demos/agents/holds-cta.html'),
				'agents-falls-asleep': resolve(__dirname, 'public/demos/agents/falls-asleep.html'),
				'agents-builds-button': resolve(
					__dirname,
					'public/demos/agents/builds-button.html',
				),
				'agents-face-mocap': resolve(__dirname, 'public/demos/agents/face-mocap.html'),
				'agents-gemini-live': resolve(__dirname, 'public/demos/agents/gemini-live.html'),
				'agents-auto-rig': resolve(__dirname, 'public/demos/agents/auto-rig.html'),
				'aws-marketplace-welcome': resolve(__dirname, 'pages/aws-marketplace/welcome.html'),
				aws: resolve(__dirname, 'pages/aws/index.html'),
				openai: resolve(__dirname, 'pages/openai/index.html'),
				nvidia: resolve(__dirname, 'pages/nvidia/index.html'),
				press: resolve(__dirname, 'pages/press/index.html'),
				'agent-trade': resolve(__dirname, 'pages/agent-trade.html'),
				'autopilot-activity': resolve(__dirname, 'pages/autopilot-activity.html'),
				support: resolve(__dirname, 'pages/support.html'),
				// dashboard-next prototype — sub-pages auto-discovered so the parallel
				// agents that land new pages/dashboard-next/*.html files don't have to
				// touch this config to register them as Rollup inputs.
				...discoverDashboardNextInputs(),
			},
		},
	},
	plugins: [
		// Resolve the shared runtime i18n entry as an EXTERNAL script — but only
		// during BUILD. Many static pages load the locale runtime via
		// `<script type="module" src="/i18n.js">` (injected by
		// scripts/i18n-annotate.mjs --wire). That path is emitted at the dist root
		// by the `i18n` rollupOptions.input entry (see entryFileNames above), so it
		// exists at runtime. Without marking it external, Vite's build tries to
		// resolve `/i18n.js` as an on-disk module while processing each page's HTML
		// and fails ("Failed to resolve /i18n.js from pages/<page>.html"), breaking
		// the whole build for every wired page. Marking it external leaves the tag
		// untouched in the output HTML and lets the emitted chunk serve it.
		//
		// In DEV/serve mode there is no dist chunk yet, so treating it as external
		// left every wired page with a real 404 on `/i18n.js` (a console error
		// against the Definition-of-Done "no console errors" bar). Dev instead
		// resolves the tag straight to the source file, so the runtime loads and
		// behaves identically to the built page. Applies only to the exact
		// absolute path so nothing else is affected.
		{
			name: 'threews-i18n-external-entry',
			enforce: 'pre',
			configResolved(config) {
				i18nExternalEntryIsBuild = config.command === 'build';
			},
			resolveId(source) {
				if (source !== '/i18n.js') return null;
				if (i18nExternalEntryIsBuild) return { id: '/i18n.js', external: true };
				return resolve(__dirname, 'src/i18n.js');
			},
		},
		// Strip the VitePWA service-worker registration <script> from any
		// page meant to be embedded in a third-party iframe. Without this,
		// the slim /widget shell — loaded under arbitrary origins as an
		// iframe — would register a service worker scoped to three.ws, then
		// intercept and cache requests across every other page on the same
		// origin. Privacy & correctness hazard for embedders.
		//
		// VitePWA itself injects the script via its own enforce:'post'
		// transformIndexHtml, so this strip has to run *after* the bundle is
		// emitted to disk — a closeBundle hook on the dist/ output directory
		// is the only ordering that's stable across Vite versions.
		// Injects the iOS app's web-side bridge into every page of the built
		// site. The iOS app (ios/) is a Capacitor shell whose WebView loads the
		// live https://three.ws, so the code that makes it behave like an app
		// (native share sheet, off-site links to Safari, deep links, launch
		// screen) has to ship with the SITE rather than with the .ipa. It is a
		// no-op in every browser, gated on Capacitor.isNativePlatform().
		//
		// This runs on dist/ after the bundle is written rather than as a
		// transformIndexHtml, because the two surfaces the app most needs it on
		// (/viewer and /ar) are self-contained pages copied verbatim out of
		// public/ and are never seen by Vite's HTML pipeline. The module has no
		// imports, so it is copied rather than bundled, under a content-hashed
		// name so a change to it can never be served stale from the CDN.
		//
		// Embed entries are excluded for the same reason they have the service
		// worker stripped below: they render inside third-party pages, where
		// installing document-level click capture and a navigator.share
		// polyfill would be reaching into someone else's document. HTML
		// fragments (nav, footer) are skipped because they have no <body> to
		// inject into and are inlined into pages that already carry the tag.
		{
			name: 'three-ws-ios-native-bridge',
			apply: 'build',
			closeBundle: {
				sequential: true,
				order: 'post',
				async handler() {
					if (TARGET !== 'app') return;
					const { readdirSync, statSync, readFileSync, writeFileSync, existsSync } =
						await import('node:fs');
					const { createHash } = await import('node:crypto');
					const { join, resolve: resolvePath } = await import('node:path');
					const outDir = resolvePath(__dirname, 'dist');
					const source = resolvePath(__dirname, 'ios/src/native-bridge.js');
					if (!existsSync(outDir) || !existsSync(source)) return;

					const code = readFileSync(source, 'utf8');
					const hash = createHash('sha256').update(code).digest('hex').slice(0, 8);
					const assetName = `ios-bridge.${hash}.js`;
					writeFileSync(join(outDir, assetName), code);

					const tag = `<script type="module" src="/${assetName}"></script>`;
					const injected = [];
					const walk = (dir) => {
						for (const entry of readdirSync(dir)) {
							const full = join(dir, entry);
							if (statSync(full).isDirectory()) {
								walk(full);
								continue;
							}
							if (!entry.endsWith('.html')) continue;
							if (IOS_BRIDGE_EXCLUDED.has(entry)) continue;
							const html = readFileSync(full, 'utf8');
							// Fragments have no </body> to inject into.
							if (!html.includes('</body>')) continue;
							// Strip any bridge tag already present rather than skipping
							// the page. Skipping is only correct while every existing
							// tag names the CURRENT hash, and it does not: a build over
							// a dist/ the frontend step did not get to wipe leaves pages
							// pointing at a bundle this run never wrote, which 404s the
							// bridge on every one of them. Removing then re-adding is
							// idempotent and hash-correct in both cases.
							const cleaned = html.replace(STALE_BRIDGE_TAG, '');
							writeFileSync(full, cleaned.replace('</body>', `\t\t${tag}\n\t</body>`));
							injected.push(entry);
						}
					};
					walk(outDir);
					console.log(`[ios-bridge] ${assetName} injected into ${injected.length} page(s)`);
				},
			},
		},
		{
			name: 'three-ws-strip-sw-from-embeds',
			apply: 'build',
			closeBundle: {
				sequential: true,
				order: 'post',
				async handler() {
					const { readdirSync, statSync, readFileSync, writeFileSync } =
						await import('node:fs');
					const { join, resolve: resolvePath } = await import('node:path');
					const EMBED_ENTRIES = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
						'agent-token-page.html',
						'assistant-frame.html',
					]);
					const RE =
						/<script[^>]*id=["']vite-plugin-pwa:register-sw["'][^>]*><\/script>\s*/g;
					const outDir = resolvePath(__dirname, 'dist');
					const stripped = [];
					const walk = (dir) => {
						let entries;
						try {
							entries = readdirSync(dir);
						} catch {
							return;
						}
						for (const name of entries) {
							const full = join(dir, name);
							let s;
							try {
								s = statSync(full);
							} catch {
								continue;
							}
							if (s.isDirectory()) {
								walk(full);
								continue;
							}
							if (!EMBED_ENTRIES.has(name)) continue;
							const html = readFileSync(full, 'utf8');
							const next = html.replace(RE, '');
							if (next === html) continue;
							writeFileSync(full, next);
							stripped.push(full);
						}
					};
					walk(outDir);
					if (stripped.length) {
						// eslint-disable-next-line no-console
						console.log(
							'[strip-sw] removed registerSW script from:',
							stripped.map((p) => p.replace(outDir + '/', '')).join(', '),
						);
					}
				},
			},
		},
		// Polyfill the Node `process` global so @solana/web3.js (and any other dep
		// that touches `process`) works in the browser without the "Module has
		// been externalized" console warning. Scoped narrowly — we don't blanket-
		// polyfill all Node builtins because most pages don't need them.
		//
		// `buffer` is intentionally NOT in `include`: the plugin would alias it to
		// an ESM shim with named exports only, but Vite's dep-optimizer rewrites
		// named buffer imports into a CJS-interop *default* import, which then
		// fails to link ("buffer.js does not provide an export named 'default'").
		// Instead resolve.alias points `buffer` at the real CJS package (which
		// prebundles with both default and named) and `globals.Buffer` still
		// injects the global from it.
		nodePolyfills({
			include: ['process'],
			globals: { Buffer: true, process: true, global: true },
			protocolImports: true,
		}),
		// Dev only: serve the <agent-3d> custom-element bundle from the locally
		// built dist-lib/ and rewrite pages' absolute CDN loader to a same-origin
		// path. The homepage and other surfaces hardcode
		// https://three.ws/agent-3d/latest/agent-3d.js, which on localhost loads
		// the separately-deployed (and possibly stale) CDN bundle instead of the
		// local build — so element.js changes never showed up in dev. This makes
		// dev reflect the local lib. No effect on production builds (apply:'serve').
		{
			name: 'dev-local-agent-3d',
			apply: 'serve',
			configureServer(server) {
				const libFiles = {
					js: resolve(__dirname, 'dist-lib/agent-3d.js'),
					'umd.cjs': resolve(__dirname, 'dist-lib/agent-3d.umd.cjs'),
				};
				server.middlewares.use((req, res, next) => {
					const path = (req.url || '').split('?')[0];
					const m = /^\/agent-3d\/[^/]+\/agent-3d\.(js|umd\.cjs)$/.exec(path);
					if (!m) return next();
					const file = libFiles[m[1]];
					if (!file || !existsSync(file)) {
						res.statusCode = 503;
						res.setHeader('content-type', 'text/plain; charset=utf-8');
						return res.end('agent-3d dev bundle missing — run `npm run build:lib`');
					}
					res.setHeader('content-type', 'text/javascript; charset=utf-8');
					res.setHeader('cache-control', 'no-cache');
					res.setHeader('access-control-allow-origin', '*');
					return res.end(readFileSync(file));
				});
			},
			// Vite's dev-server warmup (server.preTransformRequests, on by default)
			// crawls <script type="module"> URLs found in HTML entry points and
			// resolves/loads/transforms them in-process via environment.warmupRequest,
			// which never touches the connect middleware above (that middleware only
			// intercepts real browser HTTP requests, which it does successfully).
			// Two problems for the warmup path specifically:
			//   1. No resolveId/load hook -> falls through to Vite's fs resolver,
			//      which can't find this virtual path on disk -> "Pre-transform
			//      error ... Does the file exist?".
			//   2. Loading the real dist-lib bundle lets Vite's import-analysis
			//      parse it, which chokes on the bundle's own internal
			//      dynamic import("/risk-ack.js") of a /public asset (not
			//      analyzable as an ES import per Vite's rules).
			// Neither affects real page loads (already served above), so for
			// warmup purposes only, resolve to a no-op stub that satisfies the
			// warmup without Vite ever parsing the real bundle.
			resolveId(id) {
				return /^\/agent-3d\/[^/]+\/agent-3d\.(js|umd\.cjs)$/.test(id) ? id : null;
			},
			load(id) {
				return /^\/agent-3d\/[^/]+\/agent-3d\.(js|umd\.cjs)$/.test(id)
					? 'export {};'
					: null;
			},
			transformIndexHtml: {
				order: 'pre',
				handler(html) {
					// Only the real loader <script src="…"></script> is rewritten;
					// the copy-paste snippet strings keep the absolute URL embedders
					// need (their escaped `\n`/`<\/script>` don't match this pattern).
					return html.replace(
						/(<script\b[^>]*\bsrc=")https:\/\/three\.ws(\/agent-3d\/[^"]+\/agent-3d\.js"\s*)><\/script>/g,
						'$1$2></script>',
					);
				},
			},
		},
		// public/risk-ack.js is the canonical runtime module for the money-gate
		// acknowledgment: app code reaches it via the src/shared/risk-ack.js
		// wrapper's non-analyzable dynamic import('/risk-ack.js'). In production
		// the file is served as-is from the public root, but Vite's dev transform
		// middleware 500s a module request for a /public asset ("should not be
		// imported from source code") — so in dev every money gate silently
		// degraded to the confirm() fallback. Serve it raw ahead of the transform
		// middleware so dev matches production. Serve-only; no build effect.
		{
			name: 'dev-serve-risk-ack',
			apply: 'serve',
			configureServer(server) {
				const file = resolve(__dirname, 'public/risk-ack.js');
				server.middlewares.use((req, res, next) => {
					if ((req.url || '').split('?')[0] !== '/risk-ack.js') return next();
					res.setHeader('content-type', 'text/javascript; charset=utf-8');
					res.setHeader('cache-control', 'no-cache');
					return res.end(readFileSync(file));
				});
			},
		},
		// Runtime ES modules that live in public/ (the /launch and /launch-studio
		// coin launchers and their /studio/*-panel.js chain) are loaded by URL at
		// runtime, never bundled. Production serves those files verbatim, but the
		// dev server routes a module request through the transform pipeline, which
		// refuses a publicDir file and answers 500 "should not be imported from
		// source code". The page then renders its designed fallback while the
		// console carries an error production never sees. Serve any existing
		// publicDir .js raw, ahead of the transform middleware, so dev resolves
		// these imports exactly the way the deployed site does. Serve-only; the
		// build already copies public/ as-is.
		{
			name: 'dev-serve-public-esm',
			apply: 'serve',
			configureServer(server) {
				const publicRoot = resolve(__dirname, 'public');
				server.middlewares.use((req, res, next) => {
					const path = (req.url || '').split('?')[0];
					if (!path.endsWith('.js')) return next();
					const file = resolve(publicRoot, '.' + path);
					// Containment check: a crafted ../ path must never escape public/.
					if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return next();
					if (!existsSync(file)) return next();
					res.setHeader('content-type', 'text/javascript; charset=utf-8');
					res.setHeader('cache-control', 'no-cache');
					return res.end(readFileSync(file));
				});
			},
		},
		{
			name: 'vercel-rewrites',
			configureServer(server) {
				const root = resolve(__dirname);
				const fileMap = {
					'/tour-builder': resolve(root, 'pages/tour-builder.html'),
					'/tour-builder/': resolve(root, 'pages/tour-builder.html'),
					'/agent-identities': resolve(root, 'pages/agent-identities.html'),
					'/agent-identities/': resolve(root, 'pages/agent-identities.html'),
					// Production routes /app to the Next viewer and leaves app.html
					// reachable only at /app-classic (vercel.json). Dev has to mirror
					// that, or every /app change gets exercised against the wrong page.
					'/app': resolve(root, 'pages/app-next.html'),
					'/app/': resolve(root, 'pages/app-next.html'),
					'/app-next': resolve(root, 'pages/app-next.html'),
					'/app-classic': resolve(root, 'pages/app.html'),
					'/widget': resolve(root, 'pages/widget.html'),
					'/widget/': resolve(root, 'pages/widget.html'),
					'/drive': resolve(root, 'pages/drive.html'),
					'/drive/': resolve(root, 'pages/drive.html'),
					'/login': resolve(root, 'public/login.html'),
					'/deploy': resolve(root, 'pages/app.html'),
					'/showcase': resolve(root, 'pages/app.html'),
					'/showcase/': resolve(root, 'pages/app.html'),
					'/agents': resolve(root, 'public/agents/index.html'),
					'/agents/': resolve(root, 'public/agents/index.html'),
					'/agents-live': resolve(root, 'pages/agents-live.html'),
					'/agents-live/': resolve(root, 'pages/agents-live.html'),
					'/monitor': resolve(root, 'pages/monitor.html'),
					'/monitor/': resolve(root, 'pages/monitor.html'),
					'/start': resolve(root, 'pages/start.html'),
					'/start/': resolve(root, 'pages/start.html'),
					'/create': resolve(root, 'pages/create.html'),
					'/create-agent': resolve(root, 'pages/create-agent.html'),
					'/seeker': resolve(root, 'pages/seeker.html'),
					'/seeker/': resolve(root, 'pages/seeker.html'),
					'/create/selfie': resolve(root, 'pages/create-selfie.html'),
					'/create/selfie/': resolve(root, 'pages/create-selfie.html'),
					'/create/prompt': resolve(root, 'pages/create-prompt.html'),
					'/create/prompt/': resolve(root, 'pages/create-prompt.html'),
					'/genesis': resolve(root, 'pages/genesis.html'),
					'/genesis/': resolve(root, 'pages/genesis.html'),
					'/create/video': resolve(root, 'pages/create/video.html'),
					'/create/video/': resolve(root, 'pages/create/video.html'),
					'/extension/privacy': resolve(root, 'pages/extension-privacy.html'),
					'/extension/privacy/': resolve(root, 'pages/extension-privacy.html'),
					'/extension/terms': resolve(root, 'pages/extension-terms.html'),
					'/extension/terms/': resolve(root, 'pages/extension-terms.html'),
					'/embed/walk': resolve(root, 'pages/embed-walk.html'),
					'/embed/walk/': resolve(root, 'pages/embed-walk.html'),
					'/paywall': resolve(root, 'public/paywall.html'),
					'/paywall/': resolve(root, 'public/paywall.html'),
					'/image-to-3d': resolve(root, 'pages/forge.html'),
					'/image-to-3d/': resolve(root, 'pages/forge.html'),
					'/forge-max': resolve(root, 'pages/forge.html'),
					'/forge-max/': resolve(root, 'pages/forge.html'),
					'/worlds': resolve(root, 'pages/worlds.html'),
					'/worlds/': resolve(root, 'pages/worlds.html'),
					'/create/studio': resolve(root, 'pages/avatar-studio.html'),
					'/create/studio/': resolve(root, 'pages/avatar-studio.html'),
					'/avatar-studio': resolve(root, 'pages/avatar-studio.html'),
					'/avatar-studio/': resolve(root, 'pages/avatar-studio.html'),
					'/create-review': resolve(root, 'pages/create-review.html'),
					'/create-review/': resolve(root, 'pages/create-review.html'),
					'/import/rpm': resolve(root, 'pages/import-rpm.html'),
					'/import/rpm/': resolve(root, 'pages/import-rpm.html'),
					'/dashboard': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard/': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard-classic': null,
					'/dashboard-classic/': null,
					'/dashboard-next': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard-next/': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard/avatars': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard/avatars/': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard-next/avatars': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard-next/avatars/': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard/holders': resolve(root, 'pages/dashboard-next/holders.html'),
					'/dashboard/holders/': resolve(root, 'pages/dashboard-next/holders.html'),
					'/dashboard/copy': resolve(root, 'pages/dashboard-next/copy.html'),
					'/dashboard/copy/': resolve(root, 'pages/dashboard-next/copy.html'),
					'/dashboard-next/holders': resolve(root, 'pages/dashboard-next/holders.html'),
					'/dashboard-next/holders/': resolve(root, 'pages/dashboard-next/holders.html'),
					'/studio': resolve(root, 'public/studio/index.html'),
					'/studio/': resolve(root, 'public/studio/index.html'),
					'/widgets': resolve(root, 'public/widgets-gallery/index.html'),
					'/widgets/': resolve(root, 'public/widgets-gallery/index.html'),
					'/docs/widgets': resolve(root, 'public/docs-widgets.html'),
					'/cz': resolve(root, 'public/cz/index.html'),
					'/cz/': resolve(root, 'public/cz/index.html'),
					'/validation': resolve(root, 'public/validation/index.html'),
					'/validation/': resolve(root, 'public/validation/index.html'),
					'/reputation': resolve(root, 'public/reputation/index.html'),
					'/reputation/': resolve(root, 'public/reputation/index.html'),
					// vercel.json serves /reputation/(.*) straight off the filesystem, so
					// the market sub-page needs its own dev entry or every link to it
					// (the Crypto API page carries one) 404s in dev but works in prod.
					'/reputation/market': resolve(root, 'public/reputation/market/index.html'),
					'/reputation/market/': resolve(root, 'public/reputation/market/index.html'),
					'/hydrate': resolve(root, 'public/hydrate/index.html'),
					'/hydrate/': resolve(root, 'public/hydrate/index.html'),
					'/artifact': resolve(root, 'public/artifact/index.html'),
					'/artifact/': resolve(root, 'public/artifact/index.html'),
					// BEGIN:DISCOVER_ROUTE
					'/my-agents': resolve(root, 'public/my-agents/index.html'),
					'/my-agents/': resolve(root, 'public/my-agents/index.html'),
					'/discover': resolve(root, 'public/discover/index.html'),
					'/discover/': resolve(root, 'public/discover/index.html'),
					'/gallery': resolve(root, 'public/gallery/index.html'),
					'/gallery/': resolve(root, 'public/gallery/index.html'),
					'/gallery-picker': resolve(root, 'pages/gallery-picker.html'),
					'/gallery-picker/': resolve(root, 'pages/gallery-picker.html'),
					'/status': resolve(root, 'pages/status.html'),
					'/atlas': resolve(root, 'pages/atlas.html'),
					'/atlas/': resolve(root, 'pages/atlas.html'),
					'/status/': resolve(root, 'pages/status.html'),
					'/smart-home/satellite': resolve(root, 'pages/smart-home-satellite.html'),
					'/smart-home/satellite/': resolve(root, 'pages/smart-home-satellite.html'),
					'/smart-home/plan': resolve(root, 'pages/smart-home-plan.html'),
					'/smart-home/plan/': resolve(root, 'pages/smart-home-plan.html'),
					'/smart-home/privacy': resolve(root, 'pages/smart-home-privacy.html'),
					'/smart-home/privacy/': resolve(root, 'pages/smart-home-privacy.html'),
					'/smart-home/join': resolve(root, 'pages/smart-home-join.html'),
					'/smart-home/join/': resolve(root, 'pages/smart-home-join.html'),
					'/marketplace': resolve(root, 'pages/marketplace.html'),
					'/marketplace/': resolve(root, 'pages/marketplace.html'),
					'/marketplace-walk': resolve(root, 'pages/marketplace-walk.html'),
					'/marketplace-walk/': resolve(root, 'pages/marketplace-walk.html'),
					'/marketplace/tools': resolve(root, 'pages/marketplace.html'),
					'/pay': resolve(root, 'public/pay/index.html'),
					'/pay/': resolve(root, 'public/pay/index.html'),
					'/pay/calls': resolve(root, 'public/pay/calls/index.html'),
					'/pay/calls/': resolve(root, 'public/pay/calls/index.html'),
					'/x402': resolve(root, 'public/x402-stripe.html'),
					'/x402/': resolve(root, 'public/x402-stripe.html'),
					'/dashboard/x402': resolve(root, 'public/dashboard/x402.html'),
					'/explore': resolve(root, 'public/discover/index.html'),
					'/explore/': resolve(root, 'public/discover/index.html'),
					// END:DISCOVER_ROUTE
					'/tutorials': resolve(root, 'pages/tutorials.html'),
					'/tutorials/': resolve(root, 'pages/tutorials.html'),
					'/cookbook': resolve(root, 'pages/cookbook.html'),
					'/cookbook/': resolve(root, 'pages/cookbook.html'),
					'/cookbook/pipeline': resolve(root, 'pages/pipeline-studio.html'),
					'/cookbook/pipeline/': resolve(root, 'pages/pipeline-studio.html'),
					'/glossary': resolve(root, 'pages/glossary.html'),
					'/glossary/': resolve(root, 'pages/glossary.html'),
					'/go': resolve(root, 'pages/go.html'),
					'/go/': resolve(root, 'pages/go.html'),
					'/bounties': resolve(root, 'pages/bounties.html'),
					'/bounties/': resolve(root, 'pages/bounties.html'),
					'/launches': resolve(root, 'pages/launches.html'),
					'/launches/': resolve(root, 'pages/launches.html'),
					'/wardrobe': resolve(root, 'pages/wardrobe.html'),
					'/wardrobe/': resolve(root, 'pages/wardrobe.html'),
					'/minted': resolve(root, 'pages/minted.html'),
					'/minted/': resolve(root, 'pages/minted.html'),
					'/creations': resolve(root, 'pages/creations.html'),
					'/creations/': resolve(root, 'pages/creations.html'),
					'/pulse': resolve(root, 'pages/pulse.html'),
					'/pulse/': resolve(root, 'pages/pulse.html'),
					'/flow': resolve(root, 'pages/flow.html'),
					'/flow/': resolve(root, 'pages/flow.html'),
					'/symphony': resolve(root, 'pages/symphony.html'),
					'/symphony/': resolve(root, 'pages/symphony.html'),
					'/receipts': resolve(root, 'pages/receipts.html'),
					'/receipts/': resolve(root, 'pages/receipts.html'),
					'/fits': resolve(root, 'pages/fits.html'),
					'/fits/': resolve(root, 'pages/fits.html'),
					'/viability': resolve(root, 'pages/viability.html'),
					'/viability/': resolve(root, 'pages/viability.html'),
					'/deployments': resolve(root, 'pages/deployments.html'),
					'/deployments/': resolve(root, 'pages/deployments.html'),
					'/deploy-onchain': resolve(root, 'pages/deploy-onchain.html'),
					'/deploy-onchain/': resolve(root, 'pages/deploy-onchain.html'),
					'/pill': resolve(root, 'pages/pill.html'),
					'/pill/': resolve(root, 'pages/pill.html'),
					'/portfolio': resolve(root, 'pages/portfolio.html'),
					'/portfolio/': resolve(root, 'pages/portfolio.html'),
					'/drops': resolve(root, 'pages/drops.html'),
					'/drops/': resolve(root, 'pages/drops.html'),
					'/spotlight': resolve(root, 'pages/spotlight.html'),
					'/spotlight/': resolve(root, 'pages/spotlight.html'),
					'/cert': resolve(root, 'pages/certificate.html'),
					'/cert/': resolve(root, 'pages/certificate.html'),
					'/airdrops': resolve(root, 'pages/airdrops.html'),
					'/airdrops/': resolve(root, 'pages/airdrops.html'),
					'/launcher': resolve(root, 'pages/launcher.html'),
					'/launcher/': resolve(root, 'pages/launcher.html'),
					'/clash': resolve(root, 'pages/clash.html'),
					'/clash/': resolve(root, 'pages/clash.html'),
					'/watchlist': resolve(root, 'pages/watchlist.html'),
					'/watchlist/': resolve(root, 'pages/watchlist.html'),
					'/leaderboard': resolve(root, 'pages/leaderboard.html'),
					'/leaderboard/': resolve(root, 'pages/leaderboard.html'),
					'/proof': resolve(root, 'pages/proof.html'),
					'/proof/': resolve(root, 'pages/proof.html'),
					'/labor-market': resolve(root, 'pages/labor-market.html'),
					'/labor-market/': resolve(root, 'pages/labor-market.html'),
					'/vaults': resolve(root, 'pages/vaults.html'),
					'/vaults/': resolve(root, 'pages/vaults.html'),
					'/alpha-copilot': resolve(root, 'pages/alpha-copilot.html'),
					'/alpha-copilot/': resolve(root, 'pages/alpha-copilot.html'),
					'/arena': resolve(root, 'pages/arena.html'),
					'/arena/': resolve(root, 'pages/arena.html'),
					'/mirror': resolve(root, 'pages/mirror.html'),
					'/mirror/': resolve(root, 'pages/mirror.html'),
					'/fact-check': resolve(root, 'pages/fact-check.html'),
					'/fact-check/': resolve(root, 'pages/fact-check.html'),
					'/strategies': resolve(root, 'pages/strategies.html'),
					'/strategies/': resolve(root, 'pages/strategies.html'),
					'/swarms': resolve(root, 'pages/swarms.html'),
					'/swarms/': resolve(root, 'pages/swarms.html'),
					'/ui-juice': resolve(root, 'pages/ui-juice.html'),
					'/ui-juice/': resolve(root, 'pages/ui-juice.html'),
					'/diorama': resolve(root, 'pages/diorama.html'),
					'/diorama/': resolve(root, 'pages/diorama.html'),
					'/trader': resolve(root, 'pages/trader.html'),
					'/trader/': resolve(root, 'pages/trader.html'),
					'/signals': resolve(root, 'pages/signals.html'),
					'/signals/': resolve(root, 'pages/signals.html'),
					'/trades': resolve(root, 'pages/trades.html'),
					'/trades/': resolve(root, 'pages/trades.html'),
					'/trading': resolve(root, 'pages/trading.html'),
					'/trading/': resolve(root, 'pages/trading.html'),
					'/exit-lab': resolve(root, 'pages/exit-lab.html'),
					'/exit-lab/': resolve(root, 'pages/exit-lab.html'),
					'/terminal': resolve(root, 'pages/terminal.html'),
					'/terminal/': resolve(root, 'pages/terminal.html'),
					'/claim-wallet': resolve(root, 'pages/claim-wallet.html'),
					'/claim-wallet/': resolve(root, 'pages/claim-wallet.html'),
					'/pump-live': resolve(root, 'pages/pump-live.html'),
					'/pump-live/': resolve(root, 'pages/pump-live.html'),
					'/radar': resolve(root, 'pages/radar.html'),
					'/radar/': resolve(root, 'pages/radar.html'),
					'/oracle': resolve(root, 'pages/oracle.html'),
					'/oracle/': resolve(root, 'pages/oracle.html'),
					'/oracle/docs': resolve(root, 'pages/oracle-docs.html'),
					'/oracle/docs/': resolve(root, 'pages/oracle-docs.html'),
					'/oracle/arm': resolve(root, 'pages/arm.html'),
					'/oracle/arm/': resolve(root, 'pages/arm.html'),
					'/arm': resolve(root, 'pages/arm.html'),
					'/arm/': resolve(root, 'pages/arm.html'),
					'/ca2x402': resolve(root, 'pages/ca2x402.html'),
					'/ca2x402/': resolve(root, 'pages/ca2x402.html'),
					'/activity': resolve(root, 'pages/activity.html'),
					'/activity/': resolve(root, 'pages/activity.html'),
					'/tty': resolve(root, 'pages/tty.html'),
					'/tty/': resolve(root, 'pages/tty.html'),
					'/tour/atlas': resolve(root, 'pages/tour-atlas.html'),
					'/tour/atlas/': resolve(root, 'pages/tour-atlas.html'),
					'/guards': resolve(root, 'pages/guards.html'),
					'/guards/': resolve(root, 'pages/guards.html'),
					'/brownout': resolve(root, 'pages/brownout.html'),
					'/brownout/': resolve(root, 'pages/brownout.html'),
					'/pipeline': resolve(root, 'pages/pipeline.html'),
					'/pipeline/': resolve(root, 'pages/pipeline.html'),
					'/trending': resolve(root, 'pages/trending.html'),
					'/trending/': resolve(root, 'pages/trending.html'),
					'/coin-intel': resolve(root, 'pages/coin-intel.html'),
					'/coin-intel/': resolve(root, 'pages/coin-intel.html'),
					'/oracle-lab': resolve(root, 'pages/oracle-lab.html'),
					'/oracle-lab/': resolve(root, 'pages/oracle-lab.html'),
					'/coins': resolve(root, 'pages/coins.html'),
					'/coins/': resolve(root, 'pages/coins.html'),
					'/markets': resolve(root, 'pages/markets.html'),
					'/markets/': resolve(root, 'pages/markets.html'),
					'/markets/robinhood': resolve(root, 'pages/markets-robinhood.html'),
					'/markets/robinhood/': resolve(root, 'pages/markets-robinhood.html'),
					'/markets/news': resolve(root, 'pages/markets-news.html'),
					'/markets/news/': resolve(root, 'pages/markets-news.html'),
					'/markets/digest': resolve(root, 'pages/news-digest.html'),
					'/markets/digest/': resolve(root, 'pages/news-digest.html'),
					'/markets/news/article': resolve(root, 'pages/news-article.html'),
					'/markets/news/article/': resolve(root, 'pages/news-article.html'),
					'/markets/archive': resolve(root, 'pages/news-archive.html'),
					'/markets/archive/': resolve(root, 'pages/news-archive.html'),
					'/fear-greed': resolve(root, 'pages/fear-greed.html'),
					'/fear-greed/': resolve(root, 'pages/fear-greed.html'),
					'/heatmap': resolve(root, 'pages/heatmap.html'),
					'/heatmap/': resolve(root, 'pages/heatmap.html'),
					'/gas': resolve(root, 'pages/gas.html'),
					'/gas/': resolve(root, 'pages/gas.html'),
					'/compare': resolve(root, 'pages/compare.html'),
					'/compare/': resolve(root, 'pages/compare.html'),
					'/screener': resolve(root, 'pages/screener.html'),
					'/screener/': resolve(root, 'pages/screener.html'),
					'/categories': resolve(root, 'pages/categories.html'),
					'/categories/': resolve(root, 'pages/categories.html'),
					'/exchanges': resolve(root, 'pages/exchanges.html'),
					'/exchanges/': resolve(root, 'pages/exchanges.html'),
					'/derivatives': resolve(root, 'pages/derivatives.html'),
					'/derivatives/': resolve(root, 'pages/derivatives.html'),
					'/converter': resolve(root, 'pages/converter.html'),
					'/converter/': resolve(root, 'pages/converter.html'),
					'/defi': resolve(root, 'pages/defi.html'),
					'/defi/': resolve(root, 'pages/defi.html'),
					'/chains': resolve(root, 'pages/chains.html'),
					'/chains/': resolve(root, 'pages/chains.html'),
					'/stablecoins': resolve(root, 'pages/stablecoins.html'),
					'/stablecoins/': resolve(root, 'pages/stablecoins.html'),
					'/yields': resolve(root, 'pages/yields.html'),
					'/yields/': resolve(root, 'pages/yields.html'),
					'/fees': resolve(root, 'pages/fees.html'),
					'/fees/': resolve(root, 'pages/fees.html'),
					'/sniper/experiments': resolve(root, 'pages/sniper-experiments.html'),
					'/sniper/experiments/': resolve(root, 'pages/sniper-experiments.html'),
					'/dex-volumes': resolve(root, 'pages/dex-volumes.html'),
					'/dex-volumes/': resolve(root, 'pages/dex-volumes.html'),
					'/hacks': resolve(root, 'pages/hacks.html'),
					'/hacks/': resolve(root, 'pages/hacks.html'),
					'/markets/trending': resolve(root, 'pages/markets-trending.html'),
					'/markets/trending/': resolve(root, 'pages/markets-trending.html'),
					'/bnb': resolve(root, 'pages/bnb.html'),
					'/bnb/': resolve(root, 'pages/bnb.html'),
					'/bnb-latency': resolve(root, 'pages/bnb-latency.html'),
					'/bnb-latency/': resolve(root, 'pages/bnb-latency.html'),
					'/vault': resolve(root, 'pages/vault.html'),
					'/vault/': resolve(root, 'pages/vault.html'),
					'/compose': resolve(root, 'pages/compose.html'),
					'/compose/': resolve(root, 'pages/compose.html'),
					'/create/next': resolve(root, 'pages/create-next.html'),
					'/create/next/': resolve(root, 'pages/create-next.html'),
					'/mint-success': resolve(root, 'pages/mint-success.html'),
					'/mint-success/': resolve(root, 'pages/mint-success.html'),
					'/pump-dashboard': resolve(root, 'pages/pump-dashboard.html'),
					'/pump-dashboard/': resolve(root, 'pages/pump-dashboard.html'),
					'/wallet': resolve(root, 'pages/wallet.html'),
					'/wallet/': resolve(root, 'pages/wallet.html'),
					'/autopilot': resolve(root, 'pages/autopilot.html'),
					'/autopilot/': resolve(root, 'pages/autopilot.html'),
					'/pump-visualizer': resolve(root, 'pages/pump-visualizer.html'),
					'/pump-visualizer/': resolve(root, 'pages/pump-visualizer.html'),
					'/three': resolve(root, 'pages/three.html'),
					'/three/': resolve(root, 'pages/three.html'),
					'/three-live': resolve(root, 'pages/three-live.html'),
					'/three-live/': resolve(root, 'pages/three-live.html'),
					'/three-token': resolve(root, 'pages/three-token.html'),
					'/three-token/': resolve(root, 'pages/three-token.html'),
					'/avatar-artifact': resolve(root, 'pages/avatar-artifact.html'),
					'/avatar-artifact/': resolve(root, 'pages/avatar-artifact.html'),
					'/temporary': resolve(root, 'pages/temporary.html'),
					'/temporary/': resolve(root, 'pages/temporary.html'),
					'/irl': resolve(root, 'pages/irl.html'),
					'/irl/': resolve(root, 'pages/irl.html'),
					'/ar/studio': resolve(root, 'pages/ar-studio.html'),
					'/ar/studio/': resolve(root, 'pages/ar-studio.html'),
					'/ar/view': resolve(root, 'pages/ar-view.html'),
					'/ar/view/': resolve(root, 'pages/ar-view.html'),
					// AR Forge lives in public/ (no bundler), so dev must map /ar the
					// same way vercel.json does or the route 404s only in dev.
					'/ar': resolve(root, 'public/ar-forge.html'),
					'/ar/': resolve(root, 'public/ar-forge.html'),
					'/daily': resolve(root, 'pages/daily.html'),
					'/daily/': resolve(root, 'pages/daily.html'),
					'/irl-privacy': resolve(root, 'pages/irl-privacy.html'),
					'/irl-privacy/': resolve(root, 'pages/irl-privacy.html'),
					'/world-lines': resolve(root, 'pages/world-lines.html'),
					'/world-lines/': resolve(root, 'pages/world-lines.html'),
					'/play': resolve(root, 'pages/play.html'),
					'/play/': resolve(root, 'pages/play.html'),
					'/play/agent-wallet': resolve(root, 'pages/play/agent-wallet.html'),
					'/play/agent-wallet/': resolve(root, 'pages/play/agent-wallet.html'),
					'/play/arena': resolve(root, 'pages/play/arena.html'),
					'/play/arena/': resolve(root, 'pages/play/arena.html'),
					'/play/war': resolve(root, 'pages/play/war.html'),
					'/play/war/': resolve(root, 'pages/play/war.html'),
					'/smart-money': resolve(root, 'pages/smart-money.html'),
					'/smart-money/': resolve(root, 'pages/smart-money.html'),
					'/guardian': resolve(root, 'pages/guardian.html'),
					'/guardian/': resolve(root, 'pages/guardian.html'),
					'/walk-embed': resolve(root, 'pages/walk-embed.html'),
					'/walk-embed/': resolve(root, 'pages/walk-embed.html'),
					'/assistant': resolve(root, 'pages/assistant.html'),
					'/assistant/': resolve(root, 'pages/assistant.html'),
					'/assistant-frame': resolve(root, 'pages/assistant-frame.html'),
					'/assistant-frame/': resolve(root, 'pages/assistant-frame.html'),
					'/walk': resolve(root, 'pages/walk-landing.html'),
					'/walk/': resolve(root, 'pages/walk-landing.html'),
					'/walk/app': resolve(root, 'pages/walk-embed.html'),
					'/walk/app/': resolve(root, 'pages/walk-embed.html'),
					'/walk-leaderboard': resolve(root, 'pages/walk-leaderboard.html'),
					'/walk-leaderboard/': resolve(root, 'pages/walk-leaderboard.html'),
					'/walk-analytics': resolve(root, 'pages/walk-analytics.html'),
					'/walk-analytics/': resolve(root, 'pages/walk-analytics.html'),
					'/demo': resolve(root, 'pages/demo-economy.html'),
					'/demo/': resolve(root, 'pages/demo-economy.html'),
					'/live': resolve(root, 'pages/live.html'),
					'/live/': resolve(root, 'pages/live.html'),
					'/avatar-wallet-chat': resolve(root, 'pages/avatar-wallet-chat.html'),
					'/avatar-wallet-chat/': resolve(root, 'pages/avatar-wallet-chat.html'),
					'/agent-exchange': resolve(root, 'pages/agent-exchange.html'),
					'/agent-exchange/': resolve(root, 'pages/agent-exchange.html'),
					'/pose': resolve(root, 'pages/pose.html'),
					'/pose/': resolve(root, 'pages/pose.html'),
					'/pose-mini': resolve(root, 'pages/pose-mini.html'),
					'/pose-mini/': resolve(root, 'pages/pose-mini.html'),
					'/club': resolve(root, 'pages/club.html'),
					'/club/': resolve(root, 'pages/club.html'),
					'/theater': resolve(root, 'pages/theater.html'),
					'/theater/': resolve(root, 'pages/theater.html'),
					'/stage': resolve(root, 'pages/stage.html'),
					'/stage/': resolve(root, 'pages/stage.html'),
					'/dad': resolve(root, 'pages/dad.html'),
					'/dad/': resolve(root, 'pages/dad.html'),
					'/embodiment/embed': resolve(root, 'pages/embodiment/embed.html'),
					'/embodiment/embed/': resolve(root, 'pages/embodiment/embed.html'),
					'/agenc/embodied': resolve(root, 'pages/agenc/embodied.html'),
					'/agenc/embodied/': resolve(root, 'pages/agenc/embodied.html'),
					'/agenc/room': resolve(root, 'pages/agenc/room.html'),
					'/agenc/room/': resolve(root, 'pages/agenc/room.html'),
					'/aws-marketplace/welcome': resolve(root, 'pages/aws-marketplace/welcome.html'),
					'/aws-marketplace/welcome/': resolve(
						root,
						'pages/aws-marketplace/welcome.html',
					),
					'/aws-marketplace/error': resolve(root, 'pages/aws-marketplace/welcome.html'),
					'/aws-marketplace/error/': resolve(root, 'pages/aws-marketplace/welcome.html'),
					'/aws': resolve(root, 'pages/aws/index.html'),
					'/aws/': resolve(root, 'pages/aws/index.html'),
					'/openai': resolve(root, 'pages/openai/index.html'),
					'/openai/': resolve(root, 'pages/openai/index.html'),
					'/nvidia': resolve(root, 'pages/nvidia/index.html'),
					'/nvidia/': resolve(root, 'pages/nvidia/index.html'),
					'/press': resolve(root, 'pages/press/index.html'),
					'/press/': resolve(root, 'pages/press/index.html'),
					'/support': resolve(root, 'pages/support.html'),
					'/support/': resolve(root, 'pages/support.html'),
					// Top-level galaxy/constellation are routed in vercel.json (prod) and
					// linked from the global nav — mirror them here so local dev matches prod
					// instead of 404ing.
					'/galaxy': resolve(root, 'pages/galaxy.html'),
					'/galaxy/': resolve(root, 'pages/galaxy.html'),
					'/examples': resolve(root, 'pages/examples.html'),
					'/examples/': resolve(root, 'pages/examples.html'),
					'/constellation': resolve(root, 'pages/constellation.html'),
					'/constellation/': resolve(root, 'pages/constellation.html'),
					'/voice': resolve(root, 'pages/voice.html'),
					'/voice/': resolve(root, 'pages/voice.html'),
					'/avatar-engines': resolve(root, 'pages/avatar-engines.html'),
					'/avatar-engines/': resolve(root, 'pages/avatar-engines.html'),
					'/splat': resolve(root, 'pages/splat.html'),
					'/splat/': resolve(root, 'pages/splat.html'),
					'/capture': resolve(root, 'pages/capture.html'),
					'/capture/': resolve(root, 'pages/capture.html'),
					'/motion-swap': resolve(root, 'pages/motion-swap.html'),
					'/motion-swap/': resolve(root, 'pages/motion-swap.html'),
					'/brain': resolve(root, 'pages/brain.html'),
					'/brain/': resolve(root, 'pages/brain.html'),
					'/lipsync': resolve(root, 'public/demos/lipsync-tts.html'),
					'/lipsync/': resolve(root, 'public/demos/lipsync-tts.html'),
					'/lipsync/mic': resolve(root, 'public/demos/lipsync-mic.html'),
					'/lipsync/mic/': resolve(root, 'public/demos/lipsync-mic.html'),
					'/launch-week': resolve(root, 'pages/three-ws-launch-week.html'),
					'/launch-week/': resolve(root, 'pages/three-ws-launch-week.html'),
					'/launchpad': resolve(root, 'pages/launchpad.html'),
					'/launchpad/': resolve(root, 'pages/launchpad.html'),
					'/launch': resolve(root, 'pages/launch.html'),
					'/launch/': resolve(root, 'pages/launch.html'),
					'/p': resolve(root, 'public/p/index.html'),
					'/p/': resolve(root, 'public/p/index.html'),
					'/eth-vanity': resolve(root, 'public/eth-vanity.html'),
					'/eth-vanity/': resolve(root, 'public/eth-vanity.html'),
					'/vanity/verify': resolve(root, 'public/vanity/verify/index.html'),
					'/vanity/verify/': resolve(root, 'public/vanity/verify/index.html'),
					'/vanity/gallery': resolve(root, 'public/vanity/gallery/index.html'),
					'/vanity/gallery/': resolve(root, 'public/vanity/gallery/index.html'),
					'/vanity/premium': resolve(root, 'public/vanity/premium/index.html'),
					'/vanity/premium/': resolve(root, 'public/vanity/premium/index.html'),
					'/vanity/bounties': resolve(root, 'public/vanity/bounties/index.html'),
					'/vanity/bounties/': resolve(root, 'public/vanity/bounties/index.html'),
					'/evm-wallet': resolve(root, 'public/evm-wallet.html'),
					'/evm-wallet/': resolve(root, 'public/evm-wallet.html'),
					'/strategy-lab': resolve(root, 'public/strategy-lab.html'),
					'/strategy-lab/': resolve(root, 'public/strategy-lab.html'),
					'/recurring': resolve(root, 'public/recurring.html'),
					'/recurring/': resolve(root, 'public/recurring.html'),
					'/sitemap': resolve(root, 'public/sitemap/index.html'),
					'/sitemap/': resolve(root, 'public/sitemap/index.html'),
					// Guessable aliases — prod 308s these to /sitemap (vercel.json)
					'/pages': resolve(root, 'public/sitemap/index.html'),
					'/directory': resolve(root, 'public/sitemap/index.html'),
					'/everything': resolve(root, 'public/sitemap/index.html'),
					'/all-pages': resolve(root, 'public/sitemap/index.html'),
					'/blog': resolve(root, 'blog/index.html'),
					'/blog/': resolve(root, 'blog/index.html'),
					'/demos': resolve(root, 'public/demos/index.html'),
					'/demos/': resolve(root, 'public/demos/index.html'),
					'/demos/agents': resolve(root, 'public/demos/agents/index.html'),
					'/demos/agents/': resolve(root, 'public/demos/agents/index.html'),
					'/demo/avatar-os': resolve(root, 'public/demo/avatar-os/index.html'),
					'/demo/avatar-os/': resolve(root, 'public/demo/avatar-os/index.html'),
					'/demo/coin': resolve(root, 'public/demo/coin/index.html'),
					'/demo/coin/': resolve(root, 'public/demo/coin/index.html'),
					'/': resolve(root, 'pages/home.html'),
					'/home': resolve(root, 'pages/home.html'),
					'/what-is': resolve(root, 'pages/what-is.html'),
					'/what-is/': resolve(root, 'pages/what-is.html'),
					'/pitch': resolve(root, 'pages/pitch.html'),
					'/pitch/': resolve(root, 'pages/pitch.html'),
					'/timeline': resolve(root, 'pages/timeline.html'),
					'/timeline/': resolve(root, 'pages/timeline.html'),
					'/tracker': resolve(root, 'pages/tracker.html'),
					'/tracker/': resolve(root, 'pages/tracker.html'),
					'/features': resolve(root, 'pages/features.html'),
					'/features/': resolve(root, 'pages/features.html'),
					'/docs': resolve(root, 'docs/index.html'),
					'/docs/': resolve(root, 'docs/index.html'),
					'/docs/world': resolve(root, 'pages/docs-world.html'),
					'/docs/world/': resolve(root, 'pages/docs-world.html'),
					'/docs/freshness': resolve(root, 'pages/docs-freshness.html'),
					'/docs/freshness/': resolve(root, 'pages/docs-freshness.html'),
					'/bazaar': resolve(root, 'public/bazaar.html'),
					'/bazaar/': resolve(root, 'public/bazaar.html'),
					'/labs': resolve(root, 'pages/labs.html'),
					'/labs/': resolve(root, 'pages/labs.html'),
					'/quality-bench': resolve(root, 'pages/quality-bench.html'),
					'/quality-bench/': resolve(root, 'pages/quality-bench.html'),
					'/likeness-bench': resolve(root, 'pages/likeness-bench.html'),
					'/likeness-bench/': resolve(root, 'pages/likeness-bench.html'),
					'/payment-outcomes': resolve(root, 'pages/payment-outcomes.html'),
					'/payment-outcomes/': resolve(root, 'pages/payment-outcomes.html'),
					'/materialize': resolve(root, 'pages/materialize.html'),
					'/materialize/': resolve(root, 'pages/materialize.html'),
					'/inspect': resolve(root, 'pages/inspect.html'),
					'/inspect/': resolve(root, 'pages/inspect.html'),
					'/render-lab': resolve(root, 'pages/render-lab.html'),
					'/render-lab/': resolve(root, 'pages/render-lab.html'),
					'/bundles': resolve(root, 'pages/bundles.html'),
					'/bundles/': resolve(root, 'pages/bundles.html'),
					'/search': resolve(root, 'pages/search.html'),
					'/search/': resolve(root, 'pages/search.html'),
					'/rankings': resolve(root, 'pages/rankings.html'),
					'/rankings/': resolve(root, 'pages/rankings.html'),
					'/daily-match': resolve(root, 'pages/daily-match.html'),
					'/daily-match/': resolve(root, 'pages/daily-match.html'),
					'/forever': resolve(root, 'public/forever.html'),
					'/forever/': resolve(root, 'public/forever.html'),
					'/arbitrage': resolve(root, 'public/arbitrage.html'),
					'/arbitrage/': resolve(root, 'public/arbitrage.html'),
					'/providers': resolve(root, 'public/providers.html'),
					'/providers/': resolve(root, 'public/providers.html'),
				};
				// Routes that resolve to public/<dir>/index.html — these need a
				// trailing slash so relative imports (./foo.js) inside the HTML
				// resolve to /<dir>/foo.js rather than /foo.js at the root.
				const dirRoutes = new Set([
					'/agents',
					'/dashboard',
					'/studio',
					'/widgets',
					'/cz',
					'/validation',
					'/reputation',
					'/hydrate',
					'/my-agents',
					'/discover',
					'/gallery',
					'/docs',
					'/demo/avatar-os',
					'/demo/coin',
				]);
				server.middlewares.use(async (req, res, next) => {
					const url = req.url || '/';
					// Don't intercept Vite's internal html-proxy / module requests —
					// it needs to serve the inline-script content for our HTML.
					if (
						url.includes('html-proxy') ||
						url.includes('@id/') ||
						url.includes('@vite/')
					)
						return next();
					const path = url.split('?')[0];
					let filePath;
					// /api/* is handled by the http proxy in server.proxy above —
					// the middleware must not intercept those requests.
					if (dirRoutes.has(path)) {
						res.statusCode = 301;
						res.setHeader('Location', path + '/' + (req.url.slice(path.length) || ''));
						return res.end();
					}
					// Legacy homepage variants (home-v2/v3/v4, classic, next) were
					// reconciled into the single canonical pages/home.html. One front
					// door: 301 every old variant URL to /. Mirrors vercel.json.
					if (/^\/home-(v2|v3|v4|classic|next)\/?$/.test(path)) {
						res.statusCode = 301;
						res.setHeader('Location', '/');
						return res.end();
					}
					// /explore is an alias for /discover — share the same JS bundle
					if (path === '/explore' || path === '/explore/') {
						res.statusCode = 301;
						res.setHeader('Location', '/discover/');
						return res.end();
					}
					// /discover/avatar/:id → canonical /avatars/:id (avatar studio page)
					const discoverAvatarM = path.match(/^\/discover\/avatar\/([^/]+)\/?$/);
					if (discoverAvatarM) {
						res.statusCode = 301;
						res.setHeader('Location', `/avatars/${discoverAvatarM[1]}`);
						return res.end();
					}
					// /widget-studio was a legacy standalone page; /studio is canonical
					if (path === '/widget-studio' || path === '/widget-studio/') {
						res.statusCode = 301;
						res.setHeader('Location', '/studio');
						return res.end();
					}
					// Creation-surface consolidation (roadmap campaign, the creation-consolidation
					// work order, phase 2). Each mirrors a vercel.json rule so dev matches prod.
					//
					// C1: /scan merged into /create/selfie — the selfie flow owns both the
					// live-camera and the upload input, so the scanner URL is retired.
					if (path === '/scan' || path === '/scan/') {
						res.statusCode = 301;
						res.setHeader('Location', '/create/selfie');
						return res.end();
					}
					// C2: /agent/new → /create-agent. A request carrying the avatar handoff
					// params is REWRITTEN (not redirected) so the wizard still receives
					// them; src/create-agent.js consumes them and canonicalises the URL.
					if (path === '/agent/new' || path === '/agent/new/') {
						const q = url.slice(path.length);
						if (/[?&]avatar_(id|glb)=/.test(q)) {
							filePath = resolve(root, 'pages/create-agent.html');
						} else {
							res.statusCode = 301;
							res.setHeader('Location', '/create-agent');
							return res.end();
						}
					}
					// C4: the standalone /avatar-edit landing is retired — the editor is
					// only reachable in-flow at /avatars/:id/edit (or the legacy ?id= form).
					if (
						(path === '/avatar-edit' || path === '/avatar-edit/') &&
						!/[?&]id=/.test(url)
					) {
						res.statusCode = 301;
						res.setHeader('Location', '/dashboard/avatars');
						return res.end();
					}
					// Bare /agent 301s to the agents directory in prod (vercel.json);
					// the standalone agent token page lives at /agent/index.html. Mirror
					// the redirect so dev matches prod instead of 404ing.
					if (path === '/agent' || path === '/agent/') {
						res.statusCode = 301;
						res.setHeader('Location', '/agents');
						return res.end();
					}
					// /coin is the legacy URL for /demo/coin (the lottery+reflection
					// demo). Kept as a 301 so old links and shares keep working.
					if (path === '/coin' || path === '/coin/') {
						res.statusCode = 301;
						res.setHeader('Location', '/demo/coin');
						return res.end();
					}
					// Chat sub-app is proxied to its own Vite dev server at :5174
					// which serves under /chat/. Redirect /chat → /chat/ so the
					// proxy can forward the trailing-slash form upstream.
					if (path === '/chat') {
						res.statusCode = 301;
						res.setHeader('Location', '/chat/');
						return res.end();
					}
					// /dashboard-classic/* → canonical /dashboard/* (mirrors vercel.json 301s)
					if (path === '/dashboard-classic' || path.startsWith('/dashboard-classic/')) {
						const classicSlugMap = {
							'portfolio/asset': '/dashboard/portfolio',
							portfolio: '/dashboard/portfolio',
							wallets: '/dashboard/account',
							sessions: '/dashboard/settings',
							actions: '/dashboard/account',
							'embed-policy': '/dashboard/api',
							memory: '/dashboard/agents',
							strategy: '/dashboard/library',
							voice: '/dashboard/settings',
							sns: '/dashboard/account',
							delegation: '/dashboard/account',
							tokens: '/dashboard/tokens',
							'agent-pumpfun': '/dashboard/tokens',
							x402: '/dashboard/monetize',
							storage: '/dashboard/settings',
							usage: '/dashboard/billing',
						};
						const slug = path.replace(/^\/dashboard-classic\/?/, '').replace(/\/$/, '');
						const dest = classicSlugMap[slug] || '/dashboard/';
						res.statusCode = 301;
						res.setHeader('Location', dest);
						return res.end();
					}
					if (!filePath) filePath = fileMap[path];
					// /blog/<slug>  → resolves to blog/<slug>.html on disk
					if (!filePath && /^\/blog\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/blog\//, '').replace(/\/$/, '');
						filePath = resolve(root, `blog/${slug}.html`);
					}
					// /news and /news/<slug>  → public/news/(index|<slug>).html on disk.
					// Mirrors the prod vercel.json rewrite so the homepage press-strip
					// links resolve in dev instead of 404ing (slug allows underscores
					// and the numeric post ids used by some entries).
					else if (!filePath && /^\/news\/?$/.test(path)) {
						filePath = resolve(root, 'public/news/index.html');
					} else if (!filePath && /^\/news\/[a-z0-9_-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/news\//, '').replace(/\/$/, '');
						const candidate = resolve(root, `public/news/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// /demos/<slug> or /demos/<slug>.html → resolves to public/demos/<slug>.html on disk
					else if (!filePath && /^\/demos\/[a-z0-9-]+(\.html)?\/?$/.test(path)) {
						const slug = path
							.replace(/^\/demos\//, '')
							.replace(/\.html$/, '')
							.replace(/\/$/, '');
						filePath = resolve(root, `public/demos/${slug}.html`);
					}
					// /demos/agents/<slug>(.html)? → public/demos/agents/<slug>.html.
					// Goes through transformIndexHtml so the inline `'three'` imports
					// inside each demo's <script type="module"> get bundled.
					else if (!filePath && /^\/demos\/agents\/[a-z0-9-]+(\.html)?\/?$/.test(path)) {
						const slug = path
							.replace(/^\/demos\/agents\//, '')
							.replace(/\.html$/, '')
							.replace(/\/$/, '');
						filePath = resolve(root, `public/demos/agents/${slug}.html`);
					}
					// /demo/coin/<base58 mint> → demo/coin index hydrates from the
					// mint address in the URL path. Mirrors vercel.json.
					else if (
						!filePath &&
						/^\/demo\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(path)
					) {
						filePath = resolve(root, 'public/demo/coin/index.html');
					}
					// /tutorials/<slug>  → dedicated tutorial viewer template
					else if (!filePath && /^\/tutorials\/[a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'pages/tutorial.html');
					// /walkthroughs/<slug>  → the walkthrough player shell. The index
					// (/walkthroughs) resolves through the generic single-segment
					// fallback below, but a two-segment path never reaches it, so
					// without this rule every walkthrough 404s in dev only. Mirrors
					// vercel.json. The `[a-z0-9-]+` shape (no dot) keeps
					// /walkthroughs/manifest.json on the static path it is served from.
					else if (!filePath && /^\/walkthroughs\/[a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'pages/walkthrough.html');
					// /cookbook/self-correcting-3d  → the committed notebook export, which is a
					// static nbconvert page, NOT a markdown recipe. It has to be matched before
					// the generic slug rule below or the viewer would shadow it. Mirrors vercel.json.
					else if (!filePath && /^\/cookbook\/self-correcting-3d\/?$/.test(path))
						filePath = resolve(root, 'public/cookbook/self-correcting-3d/index.html');
					// /cookbook/pipeline  → Pipeline Studio, an app page rather than a recipe.
					// Same reason as above: it must beat the generic slug rule. Mirrors vercel.json.
					else if (!filePath && /^\/cookbook\/pipeline\/?$/.test(path))
						filePath = resolve(root, 'pages/pipeline-studio.html');
					// /cookbook/<slug>  → recipe viewer, renders /docs/cookbook/<slug>.md
					else if (!filePath && /^\/cookbook\/[a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'pages/recipe.html');
					// /p/<slug>  → public Launchpad Studio renderer (hydrates from /api/launchpad/get)
					else if (!filePath && /^\/p\/[a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'public/p/index.html');
					// /pay/simulator  → spend policy dry run. Checked before the /pay/c
					// checkout rule, mirroring the order in vercel.json.
					else if (!filePath && /^\/pay\/simulator\/?$/.test(path))
						filePath = resolve(root, 'pages/pay-simulator.html');
					// /pay/c/<slug>  → hosted x402 checkout page (hydrates from /api/x402-skus?slug=)
					else if (!filePath && /^\/pay\/c\/[a-z0-9][a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'public/pay/c/index.html');
					// /dashboard/x402  → x402 SKU dashboard (already in fileMap)
					else if (!filePath && /^\/marketplace\/agents\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'pages/marketplace.html');
					else if (!filePath && /^\/marketplace\/avatars\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'pages/marketplace.html');
					else if (
						!filePath &&
						/^\/marketplace\/(tools|skills|animations|onchain)\/[^/]+\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/marketplace.html');
					// /agents/:id  → rich detail page (UUID expected, validated client-side)
					else if (!filePath && /^\/bounty\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'pages/bounty.html');
					// /signals/<slug>  → signal feed detail page (hydrates from /api/signals/feed)
					else if (!filePath && /^\/signals\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/signal-detail.html');
					// /ledger and /ledger/:agentId → the Reasoning Ledger surface
					else if (!filePath && /^\/ledger(\/[^/.]+)?\/?$/.test(path))
						filePath = resolve(root, 'pages/reasoning-ledger.html');
					// /trader/:agentId → the trader passport. Mirrors vercel.json's
					// `/trader/([^/]+)/?`; without it the "Copy trader" CTA that /trades
					// and the exit feed point at 404s in dev only. `/share` is an API
					// route in prod, so keep it out of the HTML shell here too.
					else if (!filePath && /^\/trader\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/trader.html');
					// `[^/.]+` (no dot) mirrors vercel.json's `/agents/([^/.]+)` so
					// static assets like /agents/boot.js fall through to public/
					// instead of being served the agent-detail HTML shell.
					// /agent/:id/wallet and /agents/:id/wallet → Agent Wallet hub
					// (must precede the /agent/:id and /agents/:id catch-alls below).
					else if (!filePath && /^\/agents?\/[^/.]+\/wallet\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-wallet.html');
					// /agents/:id/classic → the preserved pre-redesign profile layout
					else if (!filePath && /^\/agents?\/[^/.]+\/classic\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-detail-classic.html');
					// /agents/:id/profile → the long-form agent profile (capabilities,
					// economy, activity, trust, developer tools). /agents/:id itself is
					// the studio template both entity kinds share.
					else if (!filePath && /^\/agents\/[^/.]+\/profile\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-detail.html');
					// /agents/:id/ar → dedicated AR experience for the agent's body
					else if (!filePath && /^\/agents\/[^/.]+\/ar\/?$/.test(path))
						filePath = resolve(root, 'pages/ar.html');
					else if (!filePath && /^\/agents\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/avatar-page.html');
					else if (!filePath && /^\/agents?\/[^/]+\/mind\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-mind.html');
					else if (!filePath && /^\/agents?\/[^/]+\/edit$/.test(path))
						filePath = resolve(root, 'pages/agent-edit.html');
					else if (!filePath && /^\/agents?\/[^/]+\/embed$/.test(path))
						filePath = resolve(root, 'pages/agent-embed.html');
					// Legacy singular /agent/:id: vercel.json 301s it to /agents/:id,
					// so dev serves the same studio template it lands on in prod.
					else if (!filePath && /^\/agent\/[^/]+$/.test(path))
						filePath = resolve(root, 'pages/avatar-page.html');
					// /crews/<TAG> -> the Crew HQ page in its public-crew mode (mirrors
					// vercel.json's /crews/([A-Za-z0-9]{2,6})/? rewrite). Without this the
					// only reachable crew URL in dev is /crews itself, so every directory
					// card and every shared crew link 404s locally while working in prod.
					else if (!filePath && /^\/crews\/[A-Za-z0-9]{2,6}\/?$/.test(path))
						filePath = resolve(root, 'pages/crews.html');
					else if (!filePath && /^\/character\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'public/character.html');
					else if (!filePath && (path === '/characters' || path === '/characters/'))
						filePath = resolve(root, 'public/characters.html');
					// /a/<chainId>/<agentId>/edit  → chain-edit page
					else if (!filePath && /^\/a\/[^/]+(?:\/[^/]+){1,2}\/edit\/?$/.test(path))
						filePath = resolve(root, 'pages/a-edit.html');
					// /a/<chainId>/<agentId>/embed or /a/<chainId>/<registry>/<agentId>/embed  → iframe viewer
					else if (!filePath && /^\/a\/[^/]+(?:\/[^/]+){1,2}\/embed\/?$/.test(path))
						filePath = resolve(root, 'pages/a-embed.html');
					// /embed/avatar          → portable avatar embed (?id= / ?model=)
					// /embed/avatar/:handle  → portable avatar embed by handle
					else if (!filePath && /^\/embed\/avatar(\/[a-z0-9_-]{3,30})?\/?$/i.test(path))
						filePath = resolve(root, 'pages/avatar-embed.html');
					// /avatars/:id/ar  → dedicated AR experience (mirrors vercel.json rewrite)
					else if (!filePath && /^\/avatars\/[^/.]+\/ar\/?$/.test(path))
						filePath = resolve(root, 'pages/ar.html');
					// /avatars/:id/edit  → avatar customize page (mirrors vercel.json rewrite)
					else if (!filePath && /^\/avatars\/[^/.]+\/edit\/?$/.test(path))
						filePath = resolve(root, 'pages/avatar-edit.html');
					// /avatars/:id  → avatar studio page (mirrors vercel.json rewrite)
					else if (!filePath && /^\/avatars\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/avatar-page.html');
					// /changelog → public changelog page (mirrors vercel.json rewrite)
					else if (!filePath && /^\/events\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
						const slug = path.replace(/^\/events\//, '').replace(/\/$/, '');
						const candidate = resolve(root, `pages/events/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// /changelog → public changelog page (mirrors vercel.json rewrite)
					else if (!filePath && /^\/changelog\/?$/.test(path))
						filePath = resolve(root, 'public/changelog/index.html');
					// /ship → ship log: releases joined to their commits (mirrors vercel.json rewrite)
					else if (!filePath && /^\/ship\/?$/.test(path))
						filePath = resolve(root, 'public/ship/index.html');
					// /town  → communities (alias; mirrors vercel.json rewrite)
					else if (!filePath && /^\/town\/?$/.test(path))
						filePath = resolve(root, 'pages/communities.html');
					// /communities/:mint  → coin profile deep link
					else if (
						!filePath &&
						/^\/communities\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/communities.html');
					// /launches/:mint  → rich coin detail page
					else if (!filePath && /^\/launches\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(path))
						filePath = resolve(root, 'pages/launch-detail.html');
					// /coin/:id  → global coin detail page (CoinGecko slug or Solana mint)
					else if (!filePath && /^\/coin\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/?$/.test(path))
						filePath = resolve(root, 'pages/coin.html');
					// /m/:id  → model detail page (forge_creations uuid)
					else if (
						!filePath &&
						/^\/m\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/.test(
							path,
						)
					)
						filePath = resolve(root, 'pages/model.html');
					// /markets/robinhood/stock/:symbol  → Robinhood Chain Stock Token detail
					else if (
						!filePath &&
						/^\/markets\/robinhood\/stock\/[A-Za-z0-9.-]{1,10}\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/robinhood-stock.html');
					// /markets/robinhood/coin/:address  → Robinhood Chain coin detail
					else if (
						!filePath &&
						/^\/markets\/robinhood\/coin\/0x[0-9a-fA-F]{40}\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/robinhood-coin.html');
					// /spotlight/:id  → one Agent Spotlight entry (uuid).
					else if (!filePath && /^\/spotlight\/[0-9a-fA-F-]{36}\/?$/.test(path))
						filePath = resolve(root, 'pages/spotlight-entry.html');
					// /cert/:certId  → one Materialize certificate of authenticity (24 hex).
					else if (!filePath && /^\/cert\/[0-9a-f]{24}\/?$/.test(path))
						filePath = resolve(root, 'pages/certificate.html');
					// /materialize/insert/:certId  → the printable package insert card (ops).
					else if (!filePath && /^\/materialize\/insert\/[0-9a-f]{24}\/?$/.test(path))
						filePath = resolve(root, 'pages/print-insert.html');
					// /materialize/orders/:id  → one print order's timeline (uuid).
					else if (!filePath && /^\/materialize\/orders\/[0-9a-fA-F-]{36}\/?$/.test(path))
						filePath = resolve(root, 'pages/materialize-order.html');
					// The live 3D home (uuid), at both of its addresses. Mirrors
					// vercel.json: /smart-home/:id is where the connect flow's "Open"
					// lands, /smart-home/:id/settings is that home's settings card, and
					// /home/:id is the campaign's own address for the scene.
					else if (!filePath && /^\/smart-home\/[0-9a-fA-F-]{36}\/settings\/?$/.test(path))
						filePath = resolve(root, 'pages/smart-home.html');
					else if (!filePath && /^\/(?:smart-)?home\/[0-9a-fA-F-]{36}\/?$/.test(path))
						filePath = resolve(root, 'pages/home-scene.html');
					// /drops/:slug  → one generative 3D collection. Declared ahead of the
					// /drop/:id rule below so the singular sealed-gift route and this
					// plural collection route can never shadow each other.
					else if (!filePath && /^\/drops\/[a-z0-9][a-z0-9-]{1,47}\/?$/.test(path))
						filePath = resolve(root, 'pages/drop-collection.html');
					// /drop/:id  → sealed wallet gift claim page (24 lowercase hex chars,
					// matching api/vanity/drops.js's id format)
					else if (!filePath && /^\/drop\/[0-9a-f]{24}\/?$/.test(path))
						filePath = resolve(root, 'pages/drop.html');
					// /exchange/:id  → exchange detail page (CoinGecko exchange slug)
					else if (!filePath && /^\/exchange\/[a-z0-9_-]{1,60}\/?$/i.test(path))
						filePath = resolve(root, 'pages/exchange.html');
					// /category/:id  → crypto category detail page
					else if (!filePath && /^\/category\/[a-z0-9-]{1,80}\/?$/.test(path))
						filePath = resolve(root, 'pages/category.html');
					// /protocol/:slug  → DeFi protocol detail page. The charset covers
					// the parentheses, plus and bang DeFiLlama mints in a handful of
					// slugs (`dinero-(pxeth)`, `synthetix-v1+v2`, `yay!`), and the %
					// their percent-encoded form arrives as. Mirrors vercel.json.
					else if (!filePath && /^\/protocol\/[a-z0-9.!()+%-]{1,80}\/?$/i.test(path))
						filePath = resolve(root, 'pages/protocol.html');
					// /chain/:name  → chain TVL detail page
					else if (!filePath && /^\/chain\/[A-Za-z0-9 ._%-]{1,40}\/?$/.test(path))
						filePath = resolve(root, 'pages/chain.html');
					// /stablecoin/:id  → stablecoin detail page
					else if (!filePath && /^\/stablecoin\/[0-9]{1,6}\/?$/.test(path))
						filePath = resolve(root, 'pages/stablecoin.html');
					// /@<handle>  → public live profile page
					else if (!filePath && /^\/@[a-z0-9_-]{3,30}\/?$/i.test(path))
						filePath = resolve(root, 'pages/handle.html');
					else if (
						!filePath &&
						/^\/u\/(?:0x[0-9a-fA-F]{40}|[a-z0-9_-]{3,30})\/?$/i.test(path)
					)
						filePath = resolve(root, 'pages/profile.html');
					// /a/<chainId>/<agentId>  or  /a/<chainId>/<registry>/<agentId>
					else if (!filePath && /^\/a\/[^/]+(?:\/[^/]+){1,2}\/?$/.test(path))
						filePath = resolve(root, 'pages/app.html');
					// /pay/calls/<base58 tx sig> → permalink for a paid x402 call
					else if (!filePath && /^\/pay\/calls\/[1-9A-HJ-NP-Za-km-z]+\/?$/.test(path))
						filePath = resolve(root, 'public/pay/calls/index.html');
					// /dashboard/<tab> and /dashboard/edit/<id> → pages/dashboard-next/index.html (new SPA)
					else if (
						!filePath &&
						// A slug that owns a real pages/dashboard-next/<slug>.html is NOT a
						// legacy SPA tab: prod (vercel.json) routes it to that file, so dev
						// must fall through to the /dashboard/<page> rule below or the page
						// only exists in production. `account`, `agents` and `widgets` all
						// graduated out of the SPA and were still listed here, which served
						// the Overview page in dev under their URLs.
						/^\/dashboard\/(?:agents|avatars|create|upload|animations|widgets|embed|keys|mcp|monetization|payments|subscriptions|revenue|withdrawals|earnings|account)\/?$/.test(
							path,
						) &&
						!existsSync(
							resolve(
								root,
								`pages/dashboard-next/${path.replace(/^\/dashboard\//, '').replace(/\/$/, '')}.html`,
							),
						)
					)
						filePath = resolve(root, 'pages/dashboard-next/index.html');
					else if (!filePath && /^\/dashboard\/edit\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'pages/dashboard-next/index.html');
					// /dashboard-next/<slug> → pages/dashboard-next/<slug>.html
					// Mirrors vercel.json so the dev server resolves the sub-pages
					// landed by parallel agents without each one having to touch
					// this rewrite map.
					else if (!filePath && /^\/dashboard-next\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
						const slug = path.replace(/^\/dashboard-next\//, '').replace(/\/$/, '');
						const candidate = resolve(root, `pages/dashboard-next/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// /dashboard/<page> → pages/dashboard-next/<page>.html
					else if (!filePath && /^\/dashboard\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
						const slug = path.replace(/^\/dashboard\//, '').replace(/\/$/, '');
						const candidate = resolve(root, `pages/dashboard-next/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// /voice/home → pages/voice-home.html
					// Mirrors vercel.json: the hands-free voice loop lives under /voice/
					// but its page file is flat, so dev has to be told the same mapping.
					else if (!filePath && /^\/voice\/home\/?$/.test(path)) {
						filePath = resolve(root, 'pages/voice-home.html');
					}
					// /features/<slug> → pages/features/<slug>.html
					// Mirrors vercel.json so per-feature SEO landing pages work in dev.
					else if (!filePath && /^\/features\/[a-z0-9][a-z0-9-]*\/?$/.test(path)) {
						const slug = path.replace(/^\/features\//, '').replace(/\/$/, '');
						const candidate = resolve(root, `pages/features/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// Generic fallback: /<slug> or /<slug>.html → pages/<slug>.html
					// Catches the long tail of bundled root-level pages (community,
					// playground, embed, profile, …) without bloating fileMap.
					// /docs/<topic> -> mirror vercel.json: the walk sub-site is its own built
					// dir; every other topic is the docs SPA (docs/index.html), which client-
					// routes and fetches public/docs/<topic>.md at runtime.
					else if (!filePath && /^\/docs\/walk(\/[a-z0-9-]+)?\/?$/.test(path)) {
						const sub = path.replace(/^\/docs\/walk\/?/, '').replace(/\/$/, '');
						const cand = sub
							? resolve(root, `public/docs/walk/${sub}.html`)
							: resolve(root, 'public/docs/walk/index.html');
						if (existsSync(cand)) filePath = cand;
					}
					// Mirror vercel.json's `/docs/([^.]+?)/?` plus the server's
					// shell-page miss check (server/shell-pages.mjs): any dot-free
					// path under /docs/ naming a real article is a viewer topic,
					// nested ones (tutorials/first-agent,
					// agent-abilities/chapters/01-the-body) and capitalized ones
					// (DESIGN-TOKENS) included. Excluding dots is what keeps
					// /docs/<topic>.md and /docs/img/*.png resolving as real files.
					// A narrower pattern here 404s in dev every nested doc link that
					// works in production, which reads as a dead link; serving the
					// shell for a topic with no article would hide a real one.
					else if (!filePath && /^\/docs\/[^.]+?\/?$/.test(path)) {
						const topic = path.replace(/^\/docs\//, '').replace(/\/$/, '');
						const article = [
							resolve(root, `docs/${topic}.md`),
							resolve(root, `public/docs/${topic}.md`),
						].find((p) => existsSync(p));
						if (article) filePath = resolve(root, 'docs/index.html');
					}
					// /legal/<slug> -> public/legal/<slug>.html (privacy, tos)
					else if (!filePath && /^\/legal\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/legal\//, '').replace(/\/$/, '');
						const cand = resolve(root, `public/legal/${slug}.html`);
						if (existsSync(cand)) filePath = cand;
					}
					// /x402/<slug> -> public/x402/<slug>.html (e.g. /x402/studio)
					else if (!filePath && /^\/x402\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/x402\//, '').replace(/\/$/, '');
						const cand = resolve(root, `public/x402/${slug}.html`);
						if (existsSync(cand)) filePath = cand;
					}
					// /threews/<slug> -> pages/threews-<slug>.html (e.g. /threews/claim)
					else if (!filePath && /^\/threews\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/threews\//, '').replace(/\/$/, '');
						const cand = resolve(root, `pages/threews-${slug}.html`);
						if (existsSync(cand)) filePath = cand;
					}
					// /marketplace/analytics -> pages/marketplace-analytics.html
					else if (!filePath && path.replace(/\/$/, '') === '/marketplace/analytics')
						filePath = resolve(root, 'pages/marketplace-analytics.html');
					// /play/<slug> -> pages/play/<slug>.html (e.g. /play/ufo)
					else if (!filePath && /^\/play\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/play\//, '').replace(/\/$/, '');
						const cand = resolve(root, `pages/play/${slug}.html`);
						if (existsSync(cand)) filePath = cand;
					}
					// Generic fallback: /<slug> or /<slug>.html resolves to the page's HTML on
					// disk -- pages/ first, then public/ (file, then dir index). Catches the long
					// tail of root-level pages (community, playground, pumpfun, lookup, register,
					// settings, ...) without bloating fileMap.
					else if (!filePath && /^\/[a-z0-9][a-z0-9-]*(\.html)?\/?$/.test(path)) {
						const slug = path
							.replace(/^\//, '')
							.replace(/\.html$/, '')
							.replace(/\/$/, '');
						for (const rel of [
							`pages/${slug}.html`,
							`public/${slug}.html`,
							`public/${slug}/index.html`,
						]) {
							const candidate = resolve(root, rel);
							if (existsSync(candidate)) {
								filePath = candidate;
								break;
							}
						}
					}
					// /footer-bot.js — serve the Vite-processed src/footer-bot.js at a
					// stable URL in dev so footer.js can load it without knowing the hash.
					if (path === '/footer-bot.js') {
						req.url = '/src/footer-bot.js';
						return next();
					}
					// /walk-companion.js — same trick for nav.js's Walk Companion module
					// (built to a stable, unhashed name in prod; served from src in dev).
					if (path === '/walk-companion.js') {
						req.url = '/src/walk-companion.js';
						return next();
					}
					// /agent-bus.js — the Living-Agents nervous system at a stable URL so
					// nav.js can load it on any page for the ?agentbus=1 debug overlay.
					if (path === '/agent-bus.js') {
						req.url = '/src/agents/agent-bus.js';
						return next();
					}
					// /walk-playground.js — stable URL so any page (not just the nav
					// companion) can launch the full-page walk playground on demand.
					if (path === '/walk-playground.js') {
						req.url = '/src/walk-playground.js';
						return next();
					}
					// /feature-tour.js — nav.js's Guided Tour module, served from src
					// in dev at the stable, unhashed name it ships under in prod.
					if (path === '/feature-tour.js') {
						req.url = '/src/feature-tour.js';
						return next();
					}
					// /notifications.js — nav.js loads this module for the per-user inbox.
					if (path === '/notifications.js') {
						req.url = '/src/notifications.js';
						return next();
					}
					// /herald.js: the @three-ws/herald CDN build, served from src in
					// dev at the stable, unhashed name it ships under in production.
					if (path === '/herald.js') {
						req.url = '/src/herald-embed.js';
						return next();
					}
					// /nav-tier-badge.js — nav.js loads this module for the $THREE
					// holder tier chip (built to a stable, unhashed name in prod).
					if (path === '/nav-tier-badge.js') {
						req.url = '/src/nav-tier-badge.js';
						return next();
					}
					// /i18n.js — runtime locale swap + <lang-switcher>, served from
					// src in dev at the stable, unhashed name it ships under in prod so
					// any page can localize itself with one script tag.
					if (path === '/i18n.js') {
						req.url = '/src/i18n.js';
						return next();
					}
					// Character Studio fork: serve its production build out of
					// character-studio/build/ at /avatar-studio/<file> so the SDK demo
					// iframe (which addresses /avatar-studio/index.html) works in dev.
					// Run `npm run build --prefix character-studio` first to populate
					// the build dir. The BARE /avatar-studio and /avatar-studio/ paths
					// are deliberately NOT handled here: vercel.json routes both to the
					// platform's own sculpting page (pages/avatar-studio.html), and the
					// dev route map above mirrors that, so dev and prod agree.
					if (path.startsWith('/avatar-studio/') && path !== '/avatar-studio/') {
						const ext = path.split('.').pop().toLowerCase();
						const mimes = {
							js: 'application/javascript',
							map: 'application/json',
							css: 'text/css',
							json: 'application/json',
							html: 'text/html',
							ogg: 'audio/ogg',
							mp3: 'audio/mpeg',
							wav: 'audio/wav',
							glb: 'model/gltf-binary',
							gltf: 'model/gltf+json',
							vrm: 'application/octet-stream',
							obj: 'text/plain',
							png: 'image/png',
							jpg: 'image/jpeg',
							jpeg: 'image/jpeg',
							svg: 'image/svg+xml',
							ico: 'image/x-icon',
							woff2: 'font/woff2',
							woff: 'font/woff',
							ttf: 'font/ttf',
							otf: 'font/otf',
							wasm: 'application/wasm',
						};
						const rel = path.slice('/avatar-studio/'.length);
						const fileDisk = resolve(root, 'character-studio/build', rel);
						if (existsSync(fileDisk) && statSync(fileDisk).isFile()) {
							res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
							return createReadStream(fileDisk).pipe(res);
						}
						if (rel === 'index.html') {
							res.statusCode = 503;
							return res.end(
								'Character Studio build missing: run `npm run build --prefix character-studio`',
							);
						}
						return next();
					}
					if (!filePath) return next();
					try {
						const html = readFileSync(filePath, 'utf8');
						// Always use the actual on-disk file path as the URL for
						// transformIndexHtml so Vite can resolve html-proxy requests
						// for inline <script type="module"> back to the correct file,
						// regardless of which dynamic URL the page was served from.
						const rel = filePath.slice(root.length + 1).replace(/\\/g, '/');
						const fileUrl = '/' + rel;
						const transformed = await server.transformIndexHtml(fileUrl, html);
						res.setHeader('Content-Type', 'text/html; charset=utf-8');
						res.end(rewriteSeoHead(path, transformed));
					} catch {
						next();
					}
				});
			},
		},
		{
			name: 'posthog-analytics',
			transformIndexHtml: {
				order: 'pre',
				handler(_html, ctx) {
					const EMBED_FILES = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
					]);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (EMBED_FILES.has(filename)) return [];
					// The snippet below is PostHog's stock loader with ONE change: the
					// trailing `posthog.init(...)` is wrapped in `whenIdle(...)`.
					//
					// The stock snippet calls init() inline in <head>, and init() is
					// what inserts the <script src=".../static/array.js"> tag. That put
					// the analytics library into the page-load window on every route: a
					// Lighthouse desktop trace of / measured 1,110 ms of script
					// evaluation and a 907 ms long task for array.js, and /create paid
					// 837 ms of its 5,400 ms total blocking time for the same file. No
					// pixel of the product depends on it.
					//
					// Nothing is dropped by moving the call. The IIFE still runs
					// synchronously, so `window.posthog` and every capture method exist
					// from the first line of <head> onward; calls made before the real
					// library arrives queue on the stub array and replay once it loads.
					// That queueing is the whole point of PostHog's stub, and the init
					// arguments ride along in `posthog._i`.
					//
					// The wait is bounded at 2s and falls back to a plain timer where
					// requestIdleCallback is missing (Safari), so a visitor who leaves
					// early loses at most a 2s window rather than an unbounded one.
					// Waiting for the `load` event instead would have meant a 12s delay
					// on the heaviest page, which is the wrong trade.
					const whenIdle = (body) =>
						`!function(){var f=function(){${body}};'requestIdleCallback'in window?requestIdleCallback(f,{timeout:2000}):setTimeout(f,1200)}();`;
					const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){window.__posthog_blocked=!0},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias set_config reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_distinct_id get_session_id get_session_replay_url register register_once unregister on onFeatureFlags reloadFeatureFlags getFeatureFlag getFeatureFlagPayload isFeatureEnabled addExceptionStep captureException".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);${whenIdle(
						`posthog.init('phc_kvi8nrXqrNkLNy2NhaiwkbGyj77XpSJo54P5k2ZHYo9n',{api_host:'/ingest',ui_host:'https://us.posthog.com',defaults:'2026-01-30',person_profiles:'identified_only'})`,
					)}`;
					return [{ tag: 'script', children: SNIPPET, injectTo: 'head' }];
				},
			},
		},
		{
			// First-party client-side error reporting on every page (embeds
			// included — errors inside third-party iframe placements are exactly
			// the ones nobody's DevTools ever sees). The inline bootstrap installs
			// window error/unhandledrejection listeners synchronously so failures
			// during page load are captured, queuing raw events into
			// window.__threeErrQ; the deferred /error-reporter.js (public/) drains
			// the queue, dedupes/batches, and beacons to /api/client-errors.
			name: 'client-error-reporter',
			transformIndexHtml: {
				order: 'pre',
				handler() {
					const BOOTSTRAP =
						"window.__threeErrQ=window.__threeErrQ||[];window.__threeErrCap=1;addEventListener('error',function(e){window.__threeErrQ.push(e)},!0);addEventListener('unhandledrejection',function(e){window.__threeErrQ.push(e)});";
					return [
						{ tag: 'script', children: BOOTSTRAP, injectTo: 'head' },
						{
							tag: 'script',
							attrs: { defer: true, src: '/error-reporter.js' },
							injectTo: 'head',
						},
					];
				},
			},
		},
		{
			// Atlas: the site-wide Cmd+K palette. A global shortcut has to exist on
			// every page or it is not global, and there is no shared layout across the
			// 250+ standalone entry points to hang it off, so it gets injected here.
			// scripts/inject-atlas.mjs re-walks dist/ after the build and asserts the
			// coverage, because this hook has historically missed pages depending on
			// plugin ordering (see inject-tour-boot.mjs). Embeds and the nav/footer
			// FRAGMENTS are excluded for the same reasons as the view-transitions
			// plugin below: never steal Cmd+K inside someone else's page, and never
			// put a script tag in a string that gets assigned via innerHTML.
			name: 'three-ws-atlas',
			transformIndexHtml: {
				order: 'pre',
				handler(_html, ctx) {
					const EXCLUDED = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
						'agent-token-page.html',
						'nav.html',
						'footer.html',
					]);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (EXCLUDED.has(filename)) return [];
					return [
						{
							tag: 'script',
							attrs: { type: 'module', src: '/atlas.js' },
							injectTo: 'body',
						},
					];
				},
			},
		},
		{
			// public/inline-behaviors.js turns data-fallback*, data-action and
			// data-stop-propagation attributes into behaviour, replacing the inline
			// handler attributes the CSP blocks. It has to be everywhere: a page
			// that renders a card grid from a template literal carries no hint that
			// it needs it, and the failure only shows in front of a visitor.
			// scripts/inject-inline-behaviors.mjs re-walks dist/ after the build and
			// asserts coverage, for the same plugin-ordering reason documented above.
			name: 'three-ws-inline-behaviors',
			transformIndexHtml: {
				order: 'pre',
				handler(_html, ctx) {
					const FRAGMENTS = new Set(['nav.html', 'footer.html']);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (FRAGMENTS.has(filename)) return [];
					return [
						{
							tag: 'script',
							attrs: { src: '/inline-behaviors.js', defer: true },
							injectTo: 'head',
						},
					];
				},
			},
		},
		{
			// Mobile ergonomics: /mobile.css on every page, and viewport-fit=cover.
			//
			// /mobile.css carries the site-wide tap-target floor, canvas scroll
			// posture and safe-area rules that `npm run audit:mobile-touch` checks.
			// It used to be hand-linked, which meant only 65 of the 346 pages
			// actually got it: /forge, /markets, /launches, /play and the docs shell
			// (four of the five worst pages in that audit) were all missing it, so
			// the fixes written there simply never applied. Injecting it here is the
			// same "one gate for every page" pattern the tour boot below uses.
			//
			// Injected last in <head> so it wins on equal specificity against the
			// page's own stylesheets, exactly as its header comment promises.
			//
			// viewport-fit=cover is the other half: without it every
			// env(safe-area-inset-*) resolves to 0, so the safe-area padding in
			// mobile.css would be dead code on an iPhone. The rewrite is additive
			// and idempotent; pages that already opt in are left alone.
			name: 'mobile-ergonomics',
			transformIndexHtml: {
				order: 'post',
				handler(html, ctx) {
					// Embeds render inside someone else's page and must not inherit our
					// viewport or tap-target rules.
					const EMBED_FILES = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
						'nav.html',
						'footer.html',
					]);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (EMBED_FILES.has(filename)) return html;

					let out = html.replace(
						/(<meta[^>]*name=["']viewport["'][^>]*content=["'])([^"']*)(["'])/i,
						(match, head, content, tail) =>
							/viewport-fit\s*=/i.test(content)
								? match
								: `${head}${content.trim().replace(/,\s*$/, '')}, viewport-fit=cover${tail}`,
					);
					const tags = /["']\/mobile\.css["']/.test(out)
						? []
						: [
								{
									tag: 'link',
									attrs: { rel: 'stylesheet', href: '/mobile.css' },
									injectTo: 'head',
								},
							];
					return { html: out, tags };
				},
			},
		},
		{
			// Feature Tour boot gate — injected on every Vite-processed page so the
			// guided tour can re-hydrate after it navigates (location.assign) to ANY
			// route, not just the ~79 pages that load public/nav.js. The bespoke
			// full-screen pages the tour visits (/create/selfie, /scan, /club, …)
			// deliberately skip nav.js; without this they had no way to re-inject the
			// engine, so the tour died the moment it stepped onto one of them.
			//
			// This is the SINGLE source of the gate (nav.js no longer carries its own
			// copy). It's a tiny synchronous check — read the live tour state / ?tour=
			// param and only pull in the heavy /feature-tour.js module when a tour is
			// actually starting or in progress, so a page that never tours pays
			// nothing. Idempotent: the script-tag guard stops a double mount if
			// anything else races to load the engine. Embeds (iframes) are skipped to
			// match the other injectors, and the gate also self-guards on window.top
			// so an embed can never spawn the tour.
			name: 'feature-tour-boot',
			transformIndexHtml: {
				order: 'pre',
				handler(_html, ctx) {
					const EMBED_FILES = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
					]);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (EMBED_FILES.has(filename)) return [];
					const GATE =
						"(function(){if(window.top!==window.self)return;var a=false;try{var r=sessionStorage.getItem('tws:tour:state');a=!!r&&JSON.parse(r).active===true}catch(e){}var p=new URLSearchParams(location.search).get('tour');if(!(p==='start'||p==='1'||(p!=='0'&&a)))return;if(document.querySelector('script[src=\"/feature-tour.js\"]'))return;var s=document.createElement('script');s.type='module';s.src='/feature-tour.js';document.head.appendChild(s)})();";
					return [{ tag: 'script', children: GATE, injectTo: 'head' }];
				},
			},
		},
		{
			// Vercel Speed Insights — real-user Core Web Vitals (LCP/INP/CLS/TTFB)
			// for every page, collected from actual visitors and surfaced in the
			// Vercel dashboard. This is the "measure, don't guess" complement to the
			// first-party error reporter above: it tells us which pages are slow for
			// real users under load instead of inferring it from synthetic audits.
			//
			// Injected ONLY on Vercel builds (process.env.VERCEL is set there). The
			// script is served by the platform at /_vercel/speed-insights/script.js
			// once Speed Insights is enabled for the project; off-Vercel (the
			// push-only mirror, local dev) it would 404, so we never emit it there.
			// Zero ingestion code by design — the platform owns collection + storage.
			name: 'vercel-speed-insights',
			transformIndexHtml: {
				order: 'pre',
				handler() {
					if (!process.env.VERCEL) return [];
					return [
						{
							tag: 'script',
							attrs: { defer: true, src: '/_vercel/speed-insights/script.js' },
							injectTo: 'head',
						},
					];
				},
			},
		},
		{
			// Native View Transitions for internal nav. Chrome/Safari ship it,
			// Firefox falls back to a normal location change (no UX regression).
			// Skip on embed pages — they're iframes and shouldn't intercept clicks.
			name: 'view-transitions',
			transformIndexHtml: {
				order: 'pre',
				handler(_html, ctx) {
					const EMBED_FILES = new Set([
						'widget.html',
						'embed.html',
						'avatar-embed.html',
						'agent-embed.html',
						'a-embed.html',
						// Runtime-fetched FRAGMENTS, not documents: nav.js / footer.js
						// fetch these and assign them via innerHTML. In dev, Vite's
						// transformIndexHtml runs on them too, and injecting a script
						// here gets it interleaved with Vite's own /@vite/client tag —
						// the fragment parser then closes the script early and renders
						// the remainder of its source as DOM text/elements inside the
						// nav/footer containers. The page document already carries the
						// inline script; fragments must never get it.
						'nav.html',
						'footer.html',
					]);
					const filename = (ctx.filename || ctx.path || '')
						.replace(/\\/g, '/')
						.split('/')
						.pop();
					if (EMBED_FILES.has(filename)) return [];
					// Inline the dependency-free source directly as a classic
					// (non-module) script. Two failure modes this avoids:
					//   1. A `type=module` inline script gets externalized by Vite
					//      into a `?html-proxy` request that 404s to the SPA HTML
					//      fallback for repo-root dir-index pages (e.g. /docs).
					//   2. A dynamic `import('/src/view-transitions.js')` is rewritten
					//      by the prod build into `import('data:text/javascript;…')`,
					//      which the site CSP (no `data:` in script-src) blocks — the
					//      transition wiring then silently never runs.
					// Inlining the actual source sidesteps both: it runs under the
					// existing `'unsafe-inline'` allowance with no extra fetch. The
					// file stays the single source of truth (dev imports it directly).
					const vtSource = readFileSync(
						resolve(__dirname, 'src/view-transitions.js'),
						'utf8',
					).replace(/^export\s+function/m, 'function');
					return [
						{
							tag: 'script',
							children: `(function(){${vtSource}\ntry{enableViewTransitions();}catch(e){}})();`,
							injectTo: 'head',
						},
					];
				},
			},
		},
		{
			// Stamp every Vite-processed HTML page so footer.js can detect that
			// Three.js is already bundled and skip loading the model-viewer CDN script.
			name: 'three-bundle-meta',
			transformIndexHtml: {
				order: 'pre',
				handler() {
					return [
						{
							tag: 'meta',
							attrs: { name: 'has-three-bundle', content: 'true' },
							injectTo: 'head',
						},
					];
				},
			},
		},
		(() => {
			// Suppress the cosmetic "Multiple instances of Three.js being imported"
			// warning. Three.js does `if (window.__THREE__) warn(); else __THREE__ = REVISION;`
			// so the naive "pre-claim the global" trick actively triggers the warning
			// instead of suppressing it. Instead, install a property accessor whose
			// getter always returns undefined and whose setter is a no-op — every
			// three.js instance's check then passes silently. Runs in head-prepend
			// so it executes before model-viewer's bundled three or our app bundle.
			const GUARD =
				'try{Object.defineProperty(window,"__THREE__",{configurable:true,get:function(){return undefined},set:function(){}})}catch(_){}';
			return {
				name: 'three-multi-instance-guard',
				transformIndexHtml: {
					order: 'pre',
					handler() {
						// `injectTo: 'head'` (end of head) rather than 'head-prepend'
						// so any importmap declared by the source page stays the first
						// child of <head> — vite's html lint warns whenever ANY script
						// precedes an importmap, even a sync classic script like ours.
						// The guard is a sync <script>, so it still runs before any
						// deferred type=module script. Closing-bundle pass below
						// guarantees the marker exists in every dist HTML even if the
						// transform was skipped for that entry.
						return [{ tag: 'script', children: GUARD, injectTo: 'head' }];
					},
				},
				closeBundle: {
					sequential: true,
					order: 'post',
					async handler() {
						const { readdirSync, statSync, readFileSync, writeFileSync } =
							await import('fs');
						const { join } = await import('path');
						const distDir = resolve(__dirname, 'dist');
						if (!existsSync(distDir)) return;
						const MARKER = 'Object.defineProperty(window,"__THREE__"';
						const LEGACY =
							/<script>\s*window\.__THREE__\s*=\s*window\.__THREE__\s*\|\|\s*["'][^"']+["']\s*;?\s*<\/script>\s*/g;
						const tag = `<script>${GUARD}</script>`;
						const walk = (dir) => {
							for (const entry of readdirSync(dir)) {
								const full = join(dir, entry);
								let stat;
								try {
									stat = statSync(full);
								} catch {
									continue;
								}
								if (stat.isDirectory()) walk(full);
								else if (entry.endsWith('.html')) {
									const html = readFileSync(full, 'utf8');
									let next = html.replace(LEGACY, '');
									if (!next.includes(MARKER)) {
										next = next.replace(
											/<head(\s[^>]*)?>/i,
											(m) => `${m}\n\t\t${tag}`,
										);
									}
									if (next !== html) writeFileSync(full, next);
								}
							}
						};
						walk(distDir);
					},
				},
			};
		})(),
		{
			name: 'copy-static-docs',
			closeBundle() {
				// dist/docs is served publicly: /docs/<topic>.md is fetched by the docs
				// SPA, and every other file under it is reachable as a static asset.
				// These subtrees are written for operators, not readers — the ops
				// runbooks name the GCP project, service accounts, and which env vars
				// gate which routes; the security reviews describe attacks against
				// live code, some still open. Keep them in the repo, off the website.
				const PRIVATE_DOCS = new Set(['internal', 'ops', 'security']);
				const docsRoot = resolve(__dirname, 'docs');
				cpSync(docsRoot, resolve(__dirname, 'dist/docs'), {
					recursive: true,
					filter: (src) => {
						const rel = relative(docsRoot, src);
						return !rel || !PRIVATE_DOCS.has(rel.split(sep)[0]);
					},
				});
			},
		},
		{
			name: 'copy-blog',
			closeBundle() {
				const blogSrc = resolve(__dirname, 'blog');
				if (existsSync(blogSrc)) {
					cpSync(blogSrc, resolve(__dirname, 'dist/blog'), { recursive: true });
				}
			},
		},
		{
			// /timeline fetches its milestones from /data/timeline.json at runtime.
			// The dev server resolves that against the repo root, but production
			// serves dist/ alone, so without this copy the page shipped for weeks
			// with a working shell and a 404 behind its one fetch: every visitor
			// landed on the "Could not load the timeline" state. check:dist now
			// refuses a build that lacks the copy.
			name: 'copy-timeline-data',
			closeBundle() {
				mkdirSync(resolve(__dirname, 'dist/data'), { recursive: true });
				copyFileSync(resolve(__dirname, 'data/timeline.json'), resolve(__dirname, 'dist/data/timeline.json'));
			},
		},
		{
			// The IBM × three.ws x402 demo (pages/ibm/x402-demo.html) is a hand-
			// authored, self-contained partner artifact — inline CSS+JS, self-hosted
			// fonts under pages/ibm/fonts/, a vendored <model-viewer> under
			// pages/ibm/vendor/, absolute three.ws URLs. It ships to IBM to
			// host on a foreign origin under a strict CSP, so it must stay byte-for-byte
			// identical wherever it's served. We therefore copy it VERBATIM to dist/ibm/
			// instead of registering it as a Rollup input: a Vite input would minify the
			// HTML, hash the relative ./fonts/ URLs (so they no longer travel with the
			// file), and inject the site's analytics / error-reporter / three-guard
			// scripts via the transformIndexHtml plugins above — each of which diverges
			// the preview from the standalone file and pulls in origins the page's
			// `script-src 'self' three.ws` CSP forbids. The .md hosting guide is
			// source-only and excluded from the copy.
			//
			// The same applies to the partnership page. pages/ibm/hello.live.html is the
			// editable source; pages/ibm/hello.html is GENERATED from it (npm run
			// build:ibm-shell, also wired into build:vercel) as a SELF-CONTAINED,
			// publish-once page: it bakes in the full page (renders with zero three.ws
			// dependency) and, on load, fetches the latest from three.ws/ibm/hello.live
			// and swaps it in if reachable — so content stays editable after the file is
			// locked on the host, without ever risking a blank page. Both ship verbatim
			// (the closeBundle copies the whole pages/ibm/ dir), and the dev middleware
			// below serves /ibm/hello + /ibm/hello.live so it resolves locally too.
			name: 'copy-ibm-x402-demo',
			configureServer(server) {
				const dir = resolve(__dirname, 'pages/ibm');
				const MIME = {
					'.html': 'text/html; charset=utf-8',
					'.woff2': 'font/woff2',
					// model-viewer.min.js loads as <script type="module">; a JS MIME is
					// mandatory or the browser refuses the module ("not executable").
					'.js': 'text/javascript; charset=utf-8',
				};
				server.middlewares.use((req, res, next) => {
					const path = (req.url || '').split('?')[0];
					let rel = null;
					if (path === '/ibm/x402-demo' || path === '/ibm/x402-demo.html')
						rel = 'x402-demo.html';
					else if (path === '/ibm/hello' || path === '/ibm/hello.html')
						rel = 'hello.html';
					else if (path === '/ibm/hello.live' || path === '/ibm/hello.live.html')
						rel = 'hello.live.html';
					else if (path.startsWith('/ibm/fonts/'))
						rel = 'fonts/' + path.slice('/ibm/fonts/'.length);
					else if (path.startsWith('/ibm/vendor/'))
						rel = 'vendor/' + path.slice('/ibm/vendor/'.length);
					if (!rel) return next();
					const file = resolve(dir, rel);
					// Path-traversal guard: never serve outside pages/ibm/.
					if (
						!file.startsWith(dir + '/') ||
						!existsSync(file) ||
						!statSync(file).isFile()
					)
						return next();
					res.setHeader(
						'Content-Type',
						MIME[extname(file)] || 'application/octet-stream',
					);
					createReadStream(file).pipe(res);
				});
			},
			closeBundle() {
				const src = resolve(__dirname, 'pages/ibm');
				if (!existsSync(src)) return;
				// Ship the page, its fonts, and the vendored model-viewer (recursive
				// copy covers pages/ibm/vendor/); the hosting guide stays in source.
				cpSync(src, resolve(__dirname, 'dist/ibm'), {
					recursive: true,
					filter: (s) => !s.endsWith('.md'),
				});
			},
		},
		{
			// Several static pages (dashboard, vanity-wallet, …) import ESM
			// directly from `/src/*.js`. Vite's dev server serves these from
			// the project root, but production needs them under dist/. Mirror
			// the tree so the runtime URLs resolve.
			name: 'copy-src-to-dist',
			closeBundle() {
				cpSync(resolve(__dirname, 'src'), resolve(__dirname, 'dist/src'), {
					recursive: true,
				});
				cpSync(
					resolve(__dirname, 'pump-fun-skills'),
					resolve(__dirname, 'dist/pump-fun-skills'),
					{
						recursive: true,
					},
				);
			},
		},
		{
			// Mirror the rebranded Character Studio build (the @m3-org fork in
			// character-studio/, served as "Avatar Studio" under three.ws) into
			// dist/avatar-studio/. The avatar-sdk Creator iframe loads this URL.
			// The fork must be built (`npm run build --prefix character-studio`)
			// before the main build runs — wired into npm run build:vercel.
			name: 'copy-avatar-studio',
			closeBundle() {
				const src = resolve(__dirname, 'character-studio/build');
				if (!existsSync(src)) {
					console.warn(
						'[copy-avatar-studio] character-studio/build/ missing — run `npm run build --prefix character-studio` first',
					);
					return;
				}
				cpSync(src, resolve(__dirname, 'dist/avatar-studio'), { recursive: true });
			},
		},
		{
			// Rewrite R2 public-bucket URLs in proxied API responses so the browser
			// always receives /r2-proxy/* URLs instead of raw r2.dev URLs. The bucket
			// answers with `Access-Control-Allow-Origin: https://three.ws` only, so a
			// raw URL fails CORS from localhost / Codespaces and every model behind it
			// silently degrades (the <agent-3d> component falls back to the default
			// robot; /ar/studio cannot place a single tray model).
			//
			// The prefixes below are the API surfaces that hand a model URL to the
			// browser. Add one when a new endpoint starts returning R2 URLs; leaving
			// it off means that feature works in production and is dead in dev.
			name: 'r2-url-rewrite-api',
			configureServer(server) {
				const R2_PUBLIC_RE = /https?:\/\/pub-[a-f0-9]+\.r2\.dev\//g;
				const R2_URL_PREFIXES = [
					'/api/avatars/',
					'/api/objects/', // CC0 object library (/objects, the AR Studio "Objects" tray)
					'/api/forge-gallery', // forge creations feed (/creations, AR Studio "Yours"/"Community")
					'/api/forge', // forge job polling: the finished glb_url
				];
				server.middlewares.use(async (req, res, next) => {
					if (!R2_URL_PREFIXES.some((p) => req.url?.startsWith(p))) return next();
					// Only rewrite GET/HEAD responses — POSTs and mutations must flow
					// through the normal proxy with their original method and body intact.
					if (req.method !== 'GET' && req.method !== 'HEAD') return next();
					try {
						const upstream = new URL(req.url, DEV_API_PROXY);
						// Forward the caller's credentials: without them this refetch is
						// anonymous, so private avatars 404 in dev even when the browser
						// session is logged in (the editor's fetchAvatar sends cookies).
						const resp = await fetch(upstream.href, {
							headers: {
								accept: 'application/json',
								...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
								...(req.headers.authorization
									? { authorization: req.headers.authorization }
									: {}),
								...(req.headers.range ? { range: req.headers.range } : {}),
								// The anonymous forge identity that scopes /api/forge-gallery's
								// "Yours" tab and /api/forge job ownership. Dropping it silently
								// turns a personal feed into the public one.
								...(req.headers['x-forge-client']
									? { 'x-forge-client': req.headers['x-forge-client'] }
									: {}),
							},
						});
						const type = resp.headers.get('content-type') || 'application/json';
						res.statusCode = resp.status;
						res.setHeader('content-type', type);
						// Not every /api/avatars/* GET is JSON: `/api/avatars/:id/glb` and
						// `/thumbnail` return binary (model/gltf-binary, image/*). Reading
						// those through resp.text() decodes them as UTF-8, so every byte
						// >= 0x80 becomes U+FFFD and the "GLB" that reaches the browser is
						// ~60% larger and unparseable ("THREE.GLTFLoader: JSON content not
						// found"), which silently demoted every studio/profile avatar to the
						// fallback robot in dev. Only text payloads can carry an r2.dev URL,
						// so rewrite those and pass anything else through byte-for-byte.
						if (!/^(application\/(json|.*\+json)|text\/)/i.test(type)) {
							for (const h of [
								'content-length',
								'accept-ranges',
								'content-range',
								'etag',
								'cache-control',
							]) {
								const v = resp.headers.get(h);
								if (v) res.setHeader(h, v);
							}
							res.end(Buffer.from(await resp.arrayBuffer()));
							return;
						}
						const text = await resp.text();
						res.end(text.replace(R2_PUBLIC_RE, '/r2-proxy/'));
					} catch (err) {
						next();
					}
				});
			},
		},
		{
			// Serve `/api/widgets/wdgt_demo_*` from the local fixture file in dev.
			// Without this, those requests fall through to the `/api` proxy and hit
			// production — which may not yet have new demo IDs, so the gallery
			// renders dead iframes locally even though the fixture exists in source.
			// Production resolves the same IDs via api/widgets/[id].js → fixtures.
			name: 'widgets-demo-fixtures',
			configureServer(server) {
				server.middlewares.use(async (req, res, next) => {
					const url = req.url || '';
					const m = url.match(/^\/api\/widgets\/(wdgt_demo_[A-Za-z0-9_-]+)(?:[?#]|$)/);
					if (!m) return next();
					try {
						const mod = await server.ssrLoadModule('/api/widgets/_demo-fixtures.js');
						const widget = mod.getDemoWidget(m[1]);
						if (!widget) {
							res.statusCode = 404;
							res.setHeader('content-type', 'application/json');
							res.end(
								JSON.stringify({ error: 'not_found', message: 'widget not found' }),
							);
							return;
						}
						res.statusCode = 200;
						res.setHeader('content-type', 'application/json');
						res.setHeader('cache-control', 'public, max-age=60');
						res.end(JSON.stringify({ widget }));
					} catch (err) {
						res.statusCode = 500;
						res.setHeader('content-type', 'application/json');
						res.end(
							JSON.stringify({ error: 'fixture_load_failed', message: err.message }),
						);
					}
				});
			},
		},
		{
			// Serve /models/voice/runtime/** as raw static files in dev.
			//
			// onnxruntime-web fetches its wasm loader with a runtime dynamic import
			// of a URL it computes from env.wasm.wasmPaths. Vite's dev pipeline sees
			// that as a module import of a file under /public and refuses it with a
			// 500 ("should not be imported from source code"), which kills the whole
			// voice loop in dev while working perfectly in production, where the same
			// file is served statically from dist/. This middleware makes dev behave
			// the way production already does. The wake-word models next door
			// (/models/voice/wake-word/**) are fetched with fetch(), not import(), so
			// they never hit this path.
			name: 'voice-runtime-static',
			configureServer(server) {
				const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
				server.middlewares.use((req, res, next) => {
					const path = (req.url || '').split('?')[0];
					if (!path.startsWith('/models/voice/runtime/')) return next();
					const file = resolve(__dirname, 'public' + path);
					if (!file.startsWith(resolve(__dirname, 'public/models/voice/runtime')) || !existsSync(file)) {
						return next();
					}
					const ext = file.slice(file.lastIndexOf('.'));
					res.statusCode = 200;
					res.setHeader('content-type', TYPES[ext] || 'application/octet-stream');
					res.setHeader('cache-control', 'no-cache');
					res.end(readFileSync(file));
				});
			},
		},
		{
			// `/w/<id>` is the share URL the widgets gallery hands out (Copy → Share
			// URL). vercel.json rewrites it to api/widgets/page in production; dev
			// has no rewrite, so the copied link 404s locally and the share format
			// cannot be verified. Rewrite it to the same handler path and let the
			// existing /api proxy serve it.
			name: 'widget-share-page-rewrite',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					const m = (req.url || '').match(/^\/w\/([A-Za-z0-9_-]+)(?:[?#]|$)/);
					if (m) req.url = `/api/widgets/page?id=${encodeURIComponent(m[1])}`;
					next();
				});
			},
		},
		{
			// Serve /avatar-sdk/** in dev from the avatar-sdk/ directory at the repo
			// root (Vite's publicDir only covers public/). In production, copy
			// avatar-sdk/dist and avatar-sdk/src into dist/avatar-sdk/ so the same
			// URL paths resolve after deploy.
			name: 'avatar-sdk-static',
			configureServer(server) {
				const MIME = {
					'.js': 'application/javascript',
					'.mjs': 'application/javascript',
					'.css': 'text/css',
					'.json': 'application/json',
					'.ts': 'application/typescript',
					'.html': 'text/html',
				};
				server.middlewares.use((req, res, next) => {
					if (!req.url?.startsWith('/avatar-sdk/')) return next();
					const rel = req.url.replace(/\?.*$/, '').slice('/avatar-sdk/'.length);
					const file = resolve(__dirname, 'avatar-sdk', rel);
					if (!existsSync(file) || statSync(file).isDirectory()) return next();
					// avatar-sdk/src/* is package SOURCE: it imports bare specifiers
					// ('three', 'three/addons/*') that only a bundler can resolve. The
					// production build inlines those through Rollup, but streaming the
					// raw bytes in dev handed the browser an unresolvable specifier, so
					// <three-ws-viewer> never registered and every viewer on
					// /avatar-sdk rendered an empty box. Hand these to Vite's own
					// transform pipeline (which this middleware would otherwise shadow)
					// so dev resolves them the same way the deployed bundle does.
					// avatar-sdk/dist/* is already bundled and stays on the fast path.
					if (rel.startsWith('src/') && /\.m?js$/.test(rel)) return next();
					const mime = MIME[extname(file)] ?? 'application/octet-stream';
					res.setHeader('Content-Type', mime);
					createReadStream(file).pipe(res);
				});
			},
			closeBundle() {
				const sdkRoot = resolve(__dirname, 'avatar-sdk');
				const outRoot = resolve(__dirname, 'dist/avatar-sdk');
				for (const sub of ['dist', 'src']) {
					const src = resolve(sdkRoot, sub);
					if (existsSync(src)) {
						cpSync(src, resolve(outRoot, sub), { recursive: true });
					}
				}
			},
		},
		{
			// publicDir copies `public/agent/index.html` verbatim to
			// `dist/agent/index.html`, but we also register it as a Vite
			// input so its inline modules are bundled (Solana SDKs etc.).
			// The bundled output lands at `dist/public/agent/index.html`;
			// swap it into the serving path and drop the duplicate tree
			// so Vercel doesn't ship the raw-imports version that 404s on
			// `/src/*` in production.
			name: 'promote-bundled-public-html',
			closeBundle() {
				const pairs = [
					['dist/public/agent/index.html', 'dist/agent/index.html'],
					['dist/public/login.html', 'dist/login.html'],
					['dist/public/register.html', 'dist/register.html'],
					['dist/public/characters.html', 'dist/characters.html'],
					['dist/public/character.html', 'dist/character.html'],
					['dist/public/agents/index.html', 'dist/agents/index.html'],
					['dist/public/validation/index.html', 'dist/validation/index.html'],
					[
						'dist/public/reputation/market/index.html',
						'dist/reputation/market/index.html',
					],
					['dist/public/gallery/index.html', 'dist/gallery/index.html'],
					['dist/public/demos/brain.html', 'dist/demos/brain.html'],
					['dist/public/demos/lipsync-tts.html', 'dist/demos/lipsync-tts.html'],
					['dist/public/demos/lipsync-mic.html', 'dist/demos/lipsync-mic.html'],
					['dist/public/demos/erc8004.html', 'dist/demos/erc8004.html'],
					['dist/public/demos/button-jump.html', 'dist/demos/button-jump.html'],
					['dist/public/demos/button.html', 'dist/demos/button.html'],
					['dist/public/demos/3d-home.html', 'dist/demos/3d-home.html'],
					['dist/public/eth-vanity.html', 'dist/eth-vanity.html'],
					['dist/public/evm-wallet.html', 'dist/evm-wallet.html'],
					// /vanity-wallet: its sealed-drops controller pulls bare deps
					// (bs58, @noble/*, qrcode) that only resolve through the bundler.
					// Serving the raw publicDir copy threw "Failed to resolve module
					// specifier bs58" in production; promote the bundled output.
					['dist/public/vanity-wallet.html', 'dist/vanity-wallet.html'],
					// Grind-bounty market: its controller pulls bare deps (bs58, @noble,
					// sealed-envelope) through the bundler, so the BUNDLED output must be
					// served — promote it over the raw publicDir copy before dist/public
					// is wiped.
					['dist/public/vanity/bounties/index.html', 'dist/vanity/bounties/index.html'],
				];
				for (const [from, to] of pairs) {
					const src = resolve(__dirname, from);
					const dst = resolve(__dirname, to);
					if (!existsSync(src)) continue;
					cpSync(src, dst, { force: true });
				}
				const publicMirror = resolve(__dirname, 'dist/public');
				if (existsSync(publicMirror)) {
					rmSync(publicMirror, { recursive: true, force: true });
				}
			},
		},
		{
			// Root-level HTML files now live under `pages/`. Vite bundles them
			// to `dist/pages/<name>.html`; flatten into `dist/<name>.html` so
			// vercel.json `dest` paths and existing /name URLs continue to
			// resolve without rewriting every route.
			name: 'flatten-pages-dir',
			closeBundle: {
				sequential: true,
				order: 'post',
				async handler() {
					const pagesOut = resolve(__dirname, 'dist/pages');
					if (!existsSync(pagesOut)) return;
					const { readdirSync, statSync } = await import('fs');
					for (const entry of readdirSync(pagesOut)) {
						const from = resolve(pagesOut, entry);
						const to = resolve(__dirname, 'dist', entry);
						const stat = statSync(from);
						if (stat.isFile()) {
							cpSync(from, to, { force: true });
						} else if (stat.isDirectory()) {
							// Nested page directories (e.g. pages/dashboard-next/) keep
							// their structure inside dist/ so /dashboard-next/<page> URLs
							// resolve. Recursive merge preserves any sibling assets
							// already copied from public/dashboard-next/.
							cpSync(from, to, { recursive: true, force: true });
						}
					}
					rmSync(pagesOut, { recursive: true, force: true });
				},
			},
		},
		VitePWA({
			registerType: 'autoUpdate',
			// The default ('auto') injects a plain classic <script src="/registerSW.js">
			// into <head>, which the parser must fetch and run before it paints:
			// one render-blocking round trip on EVERY built page, measured on
			// /, /create, /forge, /marketplace and /play. registerSW.js does its
			// work inside a window 'load' listener, so deferring it changes nothing
			// about when the service worker registers and removes the block.
			// The strip-sw plugin above matches on the tag's id, which both modes
			// emit, so embed entries still get the script removed.
			injectRegister: 'script-defer',
			includeAssets: ['favicon.ico', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-192x192.png', 'pwa-maskable-512x512.png', 'pwa-icon.svg'],
			manifest: {
				name: 'three.ws — Give Your AI a Body',
				short_name: 'three.ws',
				description:
					'Create 3D AI agents, give them a voice and body, trade them on-chain, and embed them anywhere. The 3D layer for the agentic web.',
				lang: 'en',
				dir: 'ltr',
				theme_color: '#000000',
				background_color: '#080814',
				display: 'standalone',
				display_override: ['window-controls-overlay', 'standalone', 'browser'],
				orientation: 'natural',
				scope: '/',
				start_url: '/?source=pwa',
				categories: ['productivity', 'entertainment', 'social', 'utilities'],
				icons: [
					{ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
					{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
					// Maskable icons keep the glyph inside the central safe zone on a
					// padded brand background; the plain icon has transparent corners
					// that Android's circle/squircle masks used to crop into.
					{ src: 'pwa-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
					{ src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
				],
				// Android share sheet target (Seeker app + installed PWA): photos
				// land in the selfie flow, GLB files in the upload flow. The POST is
				// handled by public/share-target-sw.js, imported into the SW below.
				share_target: {
					action: '/create/share',
					method: 'POST',
					enctype: 'multipart/form-data',
					params: {
						title: 'title',
						text: 'text',
						url: 'url',
						files: [
							{
								name: 'media',
								accept: ['image/jpeg', 'image/png', 'image/webp', 'model/gltf-binary', '.glb'],
							},
						],
					},
				},
				// Windows 11 widgets board. The host fetches the Adaptive Card
				// template once from /api/glance/template and then asks the service
				// worker (public/glance-sw.js) for data, which comes from
				// /api/glance/mine. `auth: false` keeps the widget installable while
				// signed out: the card itself renders a sign-in state rather than
				// letting the host block the install behind an account.
				widgets: [
					{
						name: 'Agent glance',
						short_name: 'Agent',
						description:
							'Your three.ws agent at a glance: what it did today, and one tap back into it.',
						tag: 'agent-glance',
						template: 'agent-glance',
						ms_ac_template: '/api/glance/template',
						data: '/api/glance/mine',
						type: 'application/json',
						auth: false,
						update: 900,
						icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }],
						screenshots: [
							{
								src: 'screenshots/glance-widget.png',
								sizes: '480x200',
								label: 'The Agent glance widget on the Windows 11 widgets board',
							},
						],
					},
				],
				shortcuts: [
					{
						name: 'Create Avatar',
						short_name: 'Create',
						description: 'Build a new 3D AI avatar',
						url: '/create?source=pwa-shortcut',
						icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }],
					},
					{
						name: 'Marketplace',
						short_name: 'Discover',
						description: 'Browse AI agents and avatars',
						url: '/marketplace?source=pwa-shortcut',
						icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }],
					},
					{
						name: 'My Agents',
						short_name: 'My Agents',
						description: 'Manage your AI agents',
						// /agents is the public index of every agent; the owner's own
						// agents live at /my-agents. The shortcut said "My Agents" and
						// opened the public list for months.
						url: '/my-agents?source=pwa-shortcut',
						icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }],
					},
				],
				screenshots: [
					{
						src: 'screenshots/landing.png',
						sizes: '1280x800',
						type: 'image/png',
						form_factor: 'wide',
						label: 'three.ws home — Give Your AI a Body',
					},
					{
						src: 'screenshots/create.png',
						sizes: '1280x800',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Create a 3D avatar',
					},
					{
						src: 'screenshots/discover.png',
						sizes: '1280x800',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Discover AI agents on the marketplace',
					},
					{
						src: 'screenshots/studio.png',
						sizes: '1280x800',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Agent studio and customization',
					},
					{
						src: 'screenshots/features.png',
						sizes: '1280x800',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Platform features overview',
					},
				],
			},
			workbox: {
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
				// Pull in the Web Push handlers (push + notificationclick). Kept in
				// public/push-sw.js as a classic script so the generated Workbox SW
				// importScripts it without switching to an injectManifest build.
				importScripts: ['/push-sw.js', '/share-target-sw.js', '/glance-sw.js'],
				// MPA: every route is a separate HTML file served by the server.
				// No navigation fallback — uncached navigations go to the network.
				// HTML is intentionally excluded from globPatterns so it is never
				// precached: (1) the SW install is dramatically faster (hundreds fewer
				// files), (2) old SWs can activate the new one in seconds instead of
				// minutes, (3) navigation requests fall through to the network and
				// always return the current page from Vercel's edge — no stale HTML
				// and no offline.html served to online users.
				navigateFallback: null,
				// Precache ONLY stable, rarely-renamed assets (icons + fonts).
				// JS/CSS are intentionally excluded from the precache manifest and
				// served via runtime StaleWhileRevalidate instead (see runtimeCaching
				// below). Reason: every JS/CSS chunk is content-hashed and Vercel's
				// production alias only serves the *latest* deployment's assets. When
				// a new deploy lands while a user still holds an older page/SW — or
				// while a fresh SW is mid-install — the precache manifest references
				// chunks (e.g. assets/stage-<hash>.js) that now 404. Workbox treats a
				// single 404 as fatal `bad-precaching-response` and aborts the ENTIRE
				// SW install, leaving the user with no SW at all. Runtime caching makes
				// a 404 non-fatal: it's just a missed fetch the page's own dynamic
				// import handles, and autoUpdate still rolls the new SW forward.
				globPatterns: ['**/*.{ico,woff2}', 'offline.html', 'pwa-icon.svg'],
				globIgnores: [
					'pages/**',
					'**/animations/**',
					'**/avatars/**',
					'**/screenshots/**',
					'**/docs/**',
					'**/og-image.*',
					'**/three.svg',
					'**/3d.png',
					'**/ddd.png',
					'chat/**',
					'pump-fun-skills/**',
				],
				skipWaiting: true,
				clientsClaim: true,
				cleanupOutdatedCaches: true,
				runtimeCaching: [
					// Embed surfaces (/widget, /embed, /a-embed, /agent-embed)
					// must never be served from the SW cache — embedders rely
					// on the iframe always reflecting the latest config.
					{
						urlPattern: /^https?:\/\/[^/]+\/widget(\/.*|\?.*|#.*|$)/i,
						handler: 'NetworkOnly',
					},
					{
						urlPattern:
							/^https?:\/\/[^/]+\/(embed|a-embed|agent-embed|avatar-embed)(\/.*|\?.*|#.*|$)/i,
						handler: 'NetworkOnly',
					},
					{
						urlPattern: /^https?:\/\/[^/]+\/api\/widgets\//i,
						handler: 'NetworkOnly',
					},
					// Content-hashed build chunks under /assets/ (e.g.
					// assets/marketplace-Cn45GLvE.js, assets/index-<hash>.css).
					// These are immutable: the filename changes whenever the bytes
					// change, so the cached copy can NEVER be stale for a URL that
					// still resolves. StaleWhileRevalidate is correct and fast here —
					// serve instantly, refresh in the background; a 404 during a
					// deploy rollover is a non-fatal background miss the page's own
					// dynamic import handles, never a broken SW install.
					{
						urlPattern: ({ url, request, sameOrigin }) =>
							sameOrigin &&
							url.pathname.startsWith('/assets/') &&
							(request.destination === 'script' || request.destination === 'style'),
						handler: 'StaleWhileRevalidate',
						options: {
							cacheName: 'app-assets',
							expiration: {
								maxEntries: 200,
								maxAgeSeconds: 60 * 60 * 24 * 30,
							},
							cacheableResponse: { statuses: [200] },
						},
					},
					// Stable-named same-origin scripts & styles served verbatim from
					// public/ (/style.css, /marketplace.css, /nav.css, /mobile.css,
					// /nav.js, /footer.js, ...). Unlike the hashed chunks above these
					// keep ONE URL across deploys while their BYTES change — so
					// StaleWhileRevalidate would hand a returning user last deploy's
					// CSS against this deploy's freshly-served HTML. When a redesign
					// renames classes or restructures the header/marketplace markup,
					// the stale stylesheet no longer matches: the header collapses to
					// overlapping text and the tab rail stacks vertically (the exact
					// FOUC users hit "again" after every deploy). NetworkFirst pins
					// the live deploy's CSS/JS to its HTML — always fetch fresh, fall
					// back to cache only when offline. A short network timeout keeps
					// repeat visits fast. Placed after the /assets/ rule so hashed
					// chunks keep their immutable SWR fast path.
					{
						urlPattern: ({ request, sameOrigin }) =>
							sameOrigin &&
							(request.destination === 'script' || request.destination === 'style'),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'app-shell-assets',
							networkTimeoutSeconds: 4,
							expiration: {
								maxEntries: 80,
								maxAgeSeconds: 60 * 60 * 24 * 30,
							},
							cacheableResponse: { statuses: [200] },
						},
					},
					{
						urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'google-fonts-cache',
							expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
							cacheableResponse: { statuses: [0, 200] },
						},
					},
					{
						urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'gstatic-fonts-cache',
							expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
							cacheableResponse: { statuses: [0, 200] },
						},
					},
					// Offline navigation fallback. Navigations stay network-only (no
					// stale HTML, see navigateFallback above); only when the network
					// itself fails does the precached /offline.html answer instead of
					// Chrome's dinosaur. Inside the Seeker TWA that dinosaur page is
					// the whole screen, so this is what "offline mode" means there.
					{
						urlPattern: ({ request }) => request.mode === 'navigate',
						handler: 'NetworkOnly',
						options: {
							precacheFallback: { fallbackURL: '/offline.html' },
						},
					},
					// NOTE: /api/* is intentionally NOT registered as a runtime
					// route. No route → the SW never calls respondWith for API
					// requests, so the browser fetches them natively (still
					// network-only, never cached). A NetworkOnly rule here would
					// be behaviourally identical on success but re-wraps any
					// transient fetch rejection as an uncaught `no-response`
					// WorkboxError, spamming the console. Let the page's own
					// fetch().catch own those failures instead.
				],
			},
		}),
	],
};

// Vite hard-codes `minifyWhitespace: false` for every ES library build (see
// resolveEsbuildTranspileOptions in vite/dist/node): the assumption is that a
// lib output is re-bundled by the consumer, so keeping whitespace preserves
// `/*#__PURE__*/` annotations for their tree-shaker. Our lib output is not an
// npm dependency: it is the CDN bundle browsers download from
// /agent-3d/latest/agent-3d.js, and the option is forced, so no `build.minify`
// or `esbuild` setting can turn it back on. This pass strips the whitespace
// esbuild leaves behind. Identifiers and syntax are already minified by Vite's
// own pass, so only whitespace is touched here.
//
// It has to run in generateBundle, not renderChunk. Vite's own esbuild
// transpile plugin is a renderChunk hook that runs AFTER user plugins and
// re-prints the chunk with indentation, so a renderChunk pass here was undone
// before the file was written: production shipped 3.46 MB / 69,759 lines of
// pretty-printed code as the "minified" CDN bundle (2026-09-01). generateBundle
// runs once every renderChunk hook is finished, so what it writes is what ships.
function minifyLibWhitespace() {
	return {
		name: 'threews-lib-minify-whitespace',
		apply: 'build',
		async generateBundle(_options, bundle) {
			const { transform } = await import('esbuild');
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== 'chunk') continue;
				const res = await transform(chunk.code, {
					loader: 'js',
					minifyWhitespace: true,
					minifyIdentifiers: false,
					minifySyntax: false,
					legalComments: 'none',
					sourcefile: chunk.fileName,
				});
				chunk.code = res.code;
				chunk.map = null;
			}
		},
	};
}

// Library build — the web component + public API, for CDN drop-in:
//   <script type="module" src="https://cdn.example.com/agent-3d.js"></script>
//
// Three.js and ethers stay bundled (the element must be self-contained for a
// zero-install embed). Size will be ~600-900KB gzipped; split via dynamic
// imports in a later pass.
const libConfig = {
	plugins: [minifyLibWhitespace()],
	resolve: {
		dedupe: ['three'],
	},
	// Same separate-rollup-pass caveat as the app config above.
	worker: {
		rollupOptions: { output: { banner: LEGACY_RUNTIME_POLYFILL } },
	},
	build: {
		outDir: 'dist-lib',
		emptyOutDir: true,
		chunkSizeWarningLimit: 2000,
		lib: {
			entry: resolve(__dirname, 'src/lib.js'),
			name: 'Agent3D',
			formats: process.env.LIB_FORMATS ? process.env.LIB_FORMATS.split(',') : ['es'],
			fileName: (format) => (format === 'es' ? 'agent-3d.js' : 'agent-3d.umd.cjs'),
		},
		rollupOptions: {
			// No externals — self-contained drop-in embed.
			// inlineDynamicImports keeps the output as a single file so CDN
			// consumers get one <script type="module"> with no chunk fetches.
			// The lib IS the third-party embed, so it needs the old-WebView
			// polyfill even more than the app does.
			output: { inlineDynamicImports: true, banner: LEGACY_RUNTIME_POLYFILL },
		},
	},
};

export default defineConfig(TARGET === 'lib' ? libConfig : appConfig);
