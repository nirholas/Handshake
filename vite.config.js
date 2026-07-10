import { defineConfig } from 'vite';
import { resolve } from 'path';
import {
	readFileSync,
	readdirSync,
	cpSync,
	createReadStream,
	existsSync,
	statSync,
	rmSync,
} from 'fs';
import { extname, basename } from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The build emits two targets controlled by the TARGET env var:
//
//   TARGET=lib    → builds dist-lib/agent-3d.js (ES module + UMD) for CDN use
//   TARGET=app    → (default) builds the editor/app site into dist/
//
//   npm run build        → app
//   npm run build:lib    → lib
//   npm run build:all    → both
const TARGET = process.env.TARGET || 'app';

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
const CODESPACE_HMR =
	process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
		? {
				host: `${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
				protocol: 'wss',
				clientPort: 443,
			}
		: undefined;

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
				// it's down the proxy would surface a bare HTTP 500 on every /chat
				// navigation. Degrade to a clean, self-contained 200 placeholder that
				// explains how to start it — no console error, honest dev guidance.
				target: 'http://localhost:5174',
				changeOrigin: true,
				configure: (proxy) => {
					proxy.on('error', (err, _req, res) => {
						if (!res || res.headersSent || res.writableEnded) return;
						res.statusCode = 200;
						res.setHeader('content-type', 'text/html; charset=utf-8');
						res.end(
							`<!doctype html><meta charset="utf-8"><title>Chat — dev server offline</title>` +
								`<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;` +
								`background:#0a0a0f;color:#e8e8f0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}` +
								`main{max-width:34rem;padding:2rem;text-align:center}code{background:#1a1a24;padding:.15em .45em;` +
								`border-radius:6px;font-size:.92em}a{color:#8ab4ff}</style>` +
								`<main><h1 style="margin:.2em 0;font-size:1.4rem">Chat dev server isn't running</h1>` +
								`<p>The chat UI is a separate app. Start it in another terminal:</p>` +
								`<p><code>cd chat &amp;&amp; npm run dev</code></p>` +
								`<p style="opacity:.6;font-size:.9em">It serves on <code>:5174</code>; this page proxies to it. ` +
								`In production <code>/chat</code> is the deployed build — this notice is dev-only ` +
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
								proxy.on('error', (err, _req, res) => {
									if (!res || res.headersSent || res.writableEnded) return;
									res.statusCode = 502;
									res.setHeader('content-type', 'application/json');
									res.end(
										JSON.stringify({
											error: 'bad_gateway',
											message: `x402-pay dev helper unreachable at ${X402_PAY_DEV_URL}: ${err.message}`,
										}),
									);
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
		],
		exclude: ['@three-ws/agent-payments'],
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
					chunk.name === 'nav-tier-badge' ||
					chunk.name === 'agent-bus'
					|| chunk.name === 'i18n'
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
				'nav-tier-badge': resolve(__dirname, 'src/nav-tier-badge.js'),
				i18n: resolve(__dirname, 'src/i18n.js'),
				app: resolve(__dirname, 'pages/app.html'),
				proof: resolve(__dirname, 'pages/proof.html'),
				integrity: resolve(__dirname, 'pages/integrity.html'),
				'app-next': resolve(__dirname, 'pages/app-next.html'),
				home: resolve(__dirname, 'pages/home.html'),
				'what-is': resolve(__dirname, 'pages/what-is.html'),
				tour: resolve(__dirname, 'pages/tour.html'),
				'tour-builder': resolve(__dirname, 'pages/tour-builder.html'),
				'agent-identities': resolve(__dirname, 'pages/agent-identities.html'),
				pitch: resolve(__dirname, 'pages/pitch.html'),
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
				tutorial: resolve(__dirname, 'pages/tutorial.html'),
				glossary: resolve(__dirname, 'pages/glossary.html'),
				playground: resolve(__dirname, 'pages/playground.html'),
				coin3d: resolve(__dirname, 'pages/coin3d.html'),
				'hero-demo': resolve(__dirname, 'pages/hero-demo.html'),
				constellation: resolve(__dirname, 'pages/constellation.html'),
				embed: resolve(__dirname, 'pages/embed.html'),
				'embed-demo': resolve(__dirname, 'pages/embed-demo.html'),
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
				'create-prompt': resolve(__dirname, 'pages/create-prompt.html'),
				genesis: resolve(__dirname, 'pages/genesis.html'),
				scan: resolve(__dirname, 'pages/scan.html'),
				worlds: resolve(__dirname, 'pages/worlds.html'),
				'avatar-studio': resolve(__dirname, 'pages/avatar-studio.html'),
				'create-review': resolve(__dirname, 'pages/create-review.html'),
				'import-rpm': resolve(__dirname, 'pages/import-rpm.html'),
				marketplace: resolve(__dirname, 'pages/marketplace.html'),
				'marketplace-walk': resolve(__dirname, 'pages/marketplace-walk.html'),
				'marketplace-analytics': resolve(__dirname, 'pages/marketplace-analytics.html'),
				collection: resolve(__dirname, 'pages/collection.html'),
				'agent-edit': resolve(__dirname, 'pages/agent-edit.html'),
				'agent-mind': resolve(__dirname, 'pages/agent-mind.html'),
				'avatar-edit': resolve(__dirname, 'pages/avatar-edit.html'),
				'create-video': resolve(__dirname, 'pages/create/video.html'),
				'extension-privacy': resolve(__dirname, 'pages/extension-privacy.html'),
				'extension-terms': resolve(__dirname, 'pages/extension-terms.html'),
				'embed-walk': resolve(__dirname, 'pages/embed-walk.html'),
				'agent-embed': resolve(__dirname, 'pages/agent-embed.html'),
				'agent-detail': resolve(__dirname, 'pages/agent-detail.html'),
				'agent-screen': resolve(__dirname, 'pages/agent-screen.html'),
				'agents-live':  resolve(__dirname, 'pages/agents-live.html'),
				'agent-wallet': resolve(__dirname, 'pages/agent-wallet.html'),
				guardian: resolve(__dirname, 'pages/guardian.html'),
				launches: resolve(__dirname, 'pages/launches.html'),
				minted: resolve(__dirname, 'pages/minted.html'),
				creations: resolve(__dirname, 'pages/creations.html'),
				pulse: resolve(__dirname, 'pages/pulse.html'),
				diorama: resolve(__dirname, 'pages/diorama.html'),
				'x402-revenue': resolve(__dirname, 'pages/x402-revenue.html'),
				viability: resolve(__dirname, 'pages/viability.html'),
				deployments: resolve(__dirname, 'pages/deployments.html'),
				'admin-launcher': resolve(__dirname, 'pages/admin/launcher.html'),
				'admin-seeder': resolve(__dirname, 'pages/admin/seeder.html'),
				'admin-ring': resolve(__dirname, 'pages/admin/ring.html'),
				launcher: resolve(__dirname, 'pages/launcher.html'),
				'launch-detail': resolve(__dirname, 'pages/launch-detail.html'),
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
				'claim-wallet': resolve(__dirname, 'pages/claim-wallet.html'),
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
				pipeline: resolve(__dirname, 'pages/pipeline.html'),
				'coin-intel': resolve(__dirname, 'pages/coin-intel.html'),
				coins: resolve(__dirname, 'pages/coins.html'),
				coin: resolve(__dirname, 'pages/coin.html'),
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
				bnb: resolve(__dirname, 'pages/bnb.html'),
				'bnb-latency': resolve(__dirname, 'pages/bnb-latency.html'),
				vault: resolve(__dirname, 'pages/vault.html'),
				trending: resolve(__dirname, 'pages/trending.html'),
				compose: resolve(__dirname, 'pages/compose.html'),
				'create-next': resolve(__dirname, 'pages/create-next.html'),
				'mint-success': resolve(__dirname, 'pages/mint-success.html'),
				'bulk-launch': resolve(__dirname, 'pages/bulk-launch.html'),
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
				'events-build-3d-agents-live': resolve(__dirname, 'pages/events/build-3d-agents-live.html'),
				'avatar-page': resolve(__dirname, 'pages/avatar-page.html'),
				'avatar-sdk': resolve(__dirname, 'pages/avatar-sdk.html'),
				brain: resolve(__dirname, 'pages/brain.html'),
				'agent-studio': resolve(__dirname, 'pages/agent-studio.html'),
				cosmos: resolve(__dirname, 'pages/cosmos.html'),
				voice: resolve(__dirname, 'pages/voice.html'),
				galaxy: resolve(__dirname, 'pages/galaxy.html'),
				genome: resolve(__dirname, 'pages/genome.html'),
				'ar-page': resolve(__dirname, 'pages/ar.html'),
				pricing: resolve(__dirname, 'pages/pricing.html'),
				billing: resolve(__dirname, 'pages/billing.html'),
				credits: resolve(__dirname, 'pages/credits.html'),
				payments: resolve(__dirname, 'pages/payments.html'),
				'x-pricing': resolve(__dirname, 'pages/x-pricing.html'),
				'gallery-picker': resolve(__dirname, 'pages/gallery-picker.html'),
				status: resolve(__dirname, 'pages/status.html'),
				xr: resolve(__dirname, 'pages/xr.html'),
				temporary: resolve(__dirname, 'pages/temporary.html'),
				irl: resolve(__dirname, 'pages/irl.html'),
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
				'play-ufo': resolve(__dirname, 'pages/play/ufo.html'),
				agi: resolve(__dirname, 'pages/agi.html'),
				arena: resolve(__dirname, 'pages/arena.html'),
				'smart-money': resolve(__dirname, 'pages/smart-money.html'),
				pose: resolve(__dirname, 'pages/pose.html'),
				'pose-mini': resolve(__dirname, 'pages/pose-mini.html'),
				animations: resolve(__dirname, 'pages/animations.html'),
				'avatar-engines': resolve(__dirname, 'pages/avatar-engines.html'),
				splat: resolve(__dirname, 'pages/splat.html'),
				capture: resolve(__dirname, 'pages/capture.html'),
				club: resolve(__dirname, 'pages/club.html'),
				theater: resolve(__dirname, 'pages/theater.html'),
				stage: resolve(__dirname, 'pages/stage.html'),
				skills: resolve(__dirname, 'pages/skills.html'),
				'agenc-embodied': resolve(__dirname, 'pages/agenc/embodied.html'),
				'agenc-room': resolve(__dirname, 'pages/agenc/room.html'),
				studio: resolve(__dirname, 'public/studio/index.html'),
				reputation: resolve(__dirname, 'public/reputation/index.html'),
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
				return /^\/agent-3d\/[^/]+\/agent-3d\.(js|umd\.cjs)$/.test(id) ? 'export {};' : null;
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
		{
			name: 'vercel-rewrites',
			configureServer(server) {
				const root = resolve(__dirname);
				const fileMap = {
					'/tour-builder': resolve(root, 'pages/tour-builder.html'),
					'/tour-builder/': resolve(root, 'pages/tour-builder.html'),
					'/agent-identities': resolve(root, 'pages/agent-identities.html'),
					'/agent-identities/': resolve(root, 'pages/agent-identities.html'),
					'/app': resolve(root, 'pages/app.html'),
					'/widget': resolve(root, 'pages/widget.html'),
					'/widget/': resolve(root, 'pages/widget.html'),
					'/login': resolve(root, 'public/login.html'),
					'/deploy': resolve(root, 'pages/app.html'),
					'/showcase': resolve(root, 'pages/app.html'),
					'/showcase/': resolve(root, 'pages/app.html'),
					'/agents': resolve(root, 'public/agents/index.html'),
					'/agents/': resolve(root, 'public/agents/index.html'),
					'/agents-live': resolve(root, 'pages/agents-live.html'),
					'/agents-live/': resolve(root, 'pages/agents-live.html'),
					'/start': resolve(root, 'pages/start.html'),
					'/start/': resolve(root, 'pages/start.html'),
					'/create': resolve(root, 'pages/create.html'),
					'/create-agent': resolve(root, 'pages/create-agent.html'),
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
					'/scan': resolve(root, 'pages/scan.html'),
					'/scan/': resolve(root, 'pages/scan.html'),
					'/worlds': resolve(root, 'pages/worlds.html'),
					'/worlds/': resolve(root, 'pages/worlds.html'),
					'/create/studio': resolve(root, 'pages/avatar-studio.html'),
					'/create/studio/': resolve(root, 'pages/avatar-studio.html'),
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
					'/status/': resolve(root, 'pages/status.html'),
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
					'/glossary': resolve(root, 'pages/glossary.html'),
					'/glossary/': resolve(root, 'pages/glossary.html'),
					'/go': resolve(root, 'pages/go.html'),
					'/go/': resolve(root, 'pages/go.html'),
					'/bounties': resolve(root, 'pages/bounties.html'),
					'/bounties/': resolve(root, 'pages/bounties.html'),
					'/launches': resolve(root, 'pages/launches.html'),
					'/launches/': resolve(root, 'pages/launches.html'),
					'/minted': resolve(root, 'pages/minted.html'),
					'/minted/': resolve(root, 'pages/minted.html'),
					'/creations': resolve(root, 'pages/creations.html'),
					'/creations/': resolve(root, 'pages/creations.html'),
					'/pulse': resolve(root, 'pages/pulse.html'),
					'/pulse/': resolve(root, 'pages/pulse.html'),
					'/x402-revenue': resolve(root, 'pages/x402-revenue.html'),
					'/x402-revenue/': resolve(root, 'pages/x402-revenue.html'),
					'/viability': resolve(root, 'pages/viability.html'),
					'/viability/': resolve(root, 'pages/viability.html'),
					'/deployments': resolve(root, 'pages/deployments.html'),
					'/deployments/': resolve(root, 'pages/deployments.html'),
					'/admin/launcher': resolve(root, 'pages/admin/launcher.html'),
					'/admin/launcher/': resolve(root, 'pages/admin/launcher.html'),
					'/admin/seeder': resolve(root, 'pages/admin/seeder.html'),
					'/admin/seeder/': resolve(root, 'pages/admin/seeder.html'),
					'/admin/ring': resolve(root, 'pages/admin/ring.html'),
					'/admin/ring/': resolve(root, 'pages/admin/ring.html'),
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
					'/integrity': resolve(root, 'pages/integrity.html'),
					'/integrity/': resolve(root, 'pages/integrity.html'),
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
					'/pipeline': resolve(root, 'pages/pipeline.html'),
					'/pipeline/': resolve(root, 'pages/pipeline.html'),
					'/trending': resolve(root, 'pages/trending.html'),
					'/trending/': resolve(root, 'pages/trending.html'),
					'/coin-intel': resolve(root, 'pages/coin-intel.html'),
					'/coin-intel/': resolve(root, 'pages/coin-intel.html'),
					'/coins': resolve(root, 'pages/coins.html'),
					'/coins/': resolve(root, 'pages/coins.html'),
					'/markets': resolve(root, 'pages/markets.html'),
					'/markets/': resolve(root, 'pages/markets.html'),
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
					'/smart-money': resolve(root, 'pages/smart-money.html'),
					'/smart-money/': resolve(root, 'pages/smart-money.html'),
					'/guardian': resolve(root, 'pages/guardian.html'),
					'/guardian/': resolve(root, 'pages/guardian.html'),
					'/walk-embed': resolve(root, 'pages/walk-embed.html'),
					'/walk-embed/': resolve(root, 'pages/walk-embed.html'),
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
'/support': resolve(root, 'pages/support.html'),
					'/support/': resolve(root, 'pages/support.html'),
					// Top-level galaxy/constellation are routed in vercel.json (prod) and
					// linked from the global nav — mirror them here so local dev matches prod
					// instead of 404ing.
					'/galaxy': resolve(root, 'pages/galaxy.html'),
					'/galaxy/': resolve(root, 'pages/galaxy.html'),
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
					'/features': resolve(root, 'pages/features.html'),
					'/features/': resolve(root, 'pages/features.html'),
					'/agent/new': resolve(root, 'pages/agent-edit.html'),
					'/docs': resolve(root, 'docs/index.html'),
					'/docs/': resolve(root, 'docs/index.html'),
					'/bazaar': resolve(root, 'public/bazaar.html'),
					'/bazaar/': resolve(root, 'public/bazaar.html'),
					'/labs': resolve(root, 'pages/labs.html'),
					'/labs/': resolve(root, 'pages/labs.html'),
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
							usage: '/dashboard/analytics',
						};
						const slug = path.replace(/^\/dashboard-classic\/?/, '').replace(/\/$/, '');
						const dest = classicSlugMap[slug] || '/dashboard/';
						res.statusCode = 301;
						res.setHeader('Location', dest);
						return res.end();
					}
					let filePath = fileMap[path];
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
					// /p/<slug>  → public Launchpad Studio renderer (hydrates from /api/launchpad/get)
					else if (!filePath && /^\/p\/[a-z0-9-]+\/?$/.test(path))
						filePath = resolve(root, 'public/p/index.html');
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
					// `[^/.]+` (no dot) mirrors vercel.json's `/agents/([^/.]+)` so
					// static assets like /agents/boot.js fall through to public/
					// instead of being served the agent-detail HTML shell.
					// /agent/:id/wallet and /agents/:id/wallet → Agent Wallet hub
					// (must precede the /agent/:id and /agents/:id catch-alls below).
					else if (!filePath && /^\/agents?\/[^/.]+\/wallet\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-wallet.html');
					else if (!filePath && /^\/agents\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-detail.html');
					else if (!filePath && /^\/agent\/[^/]+\/mind\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-mind.html');
					else if (!filePath && /^\/agent\/[^/]+\/edit$/.test(path))
						filePath = resolve(root, 'pages/agent-edit.html');
					else if (!filePath && /^\/agent\/[^/]+\/embed$/.test(path))
						filePath = resolve(root, 'pages/agent-embed.html');
					else if (!filePath && /^\/agent\/[^/]+$/.test(path))
						filePath = resolve(root, 'pages/agent-detail.html');
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
					else if (
						!filePath &&
						/^\/launches\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/launch-detail.html');
					// /coin/:id  → global coin detail page (CoinGecko slug or Solana mint)
					else if (
						!filePath &&
						/^\/coin\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/?$/.test(path)
					)
						filePath = resolve(root, 'pages/coin.html');
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
						/^\/dashboard\/(?:agents|avatars|create|upload|animations|widgets|embed|keys|mcp|monetization|payments|subscriptions|billing|revenue|withdrawals|earnings|account)\/?$/.test(
							path,
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
					} else if (!filePath && /^\/docs\/[a-z0-9][a-z0-9-]*\/?$/.test(path))
						filePath = resolve(root, 'docs/index.html');
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
					// Avatar Studio (rebranded Character Studio fork) — serve the
					// production build out of character-studio/build/ at /avatar-studio/*
					// so the demo iframe works in dev. Run `npm run build --prefix
					// character-studio` first to populate the build dir.
					if (path === '/avatar-studio' || path === '/avatar-studio/') {
						const indexPath = resolve(root, 'character-studio/build/index.html');
						if (existsSync(indexPath)) {
							res.setHeader('Content-Type', 'text/html; charset=utf-8');
							return createReadStream(indexPath).pipe(res);
						}
						res.statusCode = 503;
						return res.end(
							'Avatar Studio build missing — run `npm run build --prefix character-studio`',
						);
					}
					if (path.startsWith('/avatar-studio/')) {
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
						res.end(transformed);
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
					const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){window.__posthog_blocked=!0},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias set_config reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_distinct_id get_session_id get_session_replay_url register register_once unregister on onFeatureFlags reloadFeatureFlags getFeatureFlag getFeatureFlagPayload isFeatureEnabled addExceptionStep captureException".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('phc_kvi8nrXqrNkLNy2NhaiwkbGyj77XpSJo54P5k2ZHYo9n',{api_host:'/ingest',ui_host:'https://us.posthog.com',defaults:'2026-01-30',person_profiles:'identified_only'})`;
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
						{ tag: 'script', attrs: { defer: true, src: '/error-reporter.js' }, injectTo: 'head' },
					];
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
				cpSync(resolve(__dirname, 'docs'), resolve(__dirname, 'dist/docs'), {
					recursive: true,
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
					if (!file.startsWith(dir + '/') || !existsSync(file) || !statSync(file).isFile())
						return next();
					res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
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
			// Rewrite R2 public-bucket URLs in proxied /api/avatars/* responses so
			// the <agent-3d> component (loaded from CDN) always receives /r2-proxy/*
			// URLs instead of raw r2.dev URLs that fail CORS in Codespaces / localhost.
			name: 'r2-url-rewrite-api',
			configureServer(server) {
				const R2_PUBLIC_RE = /https?:\/\/pub-[a-f0-9]+\.r2\.dev\//g;
				server.middlewares.use(async (req, res, next) => {
					if (!req.url?.startsWith('/api/avatars/')) return next();
					// Only rewrite GET/HEAD responses — POSTs and mutations must flow
					// through the normal proxy with their original method and body intact.
					if (req.method !== 'GET' && req.method !== 'HEAD') return next();
					try {
						const upstream = new URL(req.url, DEV_API_PROXY);
						const resp = await fetch(upstream.href, {
							headers: { accept: 'application/json' },
						});
						const text = await resp.text();
						const rewritten = text.replace(R2_PUBLIC_RE, '/r2-proxy/');
						res.statusCode = resp.status;
						res.setHeader(
							'content-type',
							resp.headers.get('content-type') || 'application/json',
						);
						res.end(rewritten);
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
					['dist/public/agents/index.html', 'dist/agents/index.html'],
					['dist/public/validation/index.html', 'dist/validation/index.html'],
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
			includeAssets: ['favicon.ico', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-icon.svg'],
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
					{
						src: 'pwa-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
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
						url: '/agents?source=pwa-shortcut',
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
				importScripts: ['/push-sw.js'],
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
				globPatterns: ['**/*.{ico,woff2}'],
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
							(request.destination === 'script' ||
								request.destination === 'style'),
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
							(request.destination === 'script' ||
								request.destination === 'style'),
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

// Library build — the web component + public API, for CDN drop-in:
//   <script type="module" src="https://cdn.example.com/agent-3d.js"></script>
//
// Three.js and ethers stay bundled (the element must be self-contained for a
// zero-install embed). Size will be ~600-900KB gzipped; split via dynamic
// imports in a later pass.
const libConfig = {
	resolve: {
		dedupe: ['three'],
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
			output: { inlineDynamicImports: true },
		},
	},
};

export default defineConfig(TARGET === 'lib' ? libConfig : appConfig);
