import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, readdirSync, cpSync, createReadStream, existsSync, statSync, rmSync } from 'fs';
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
// Local-only override for /api/x402-pay (the demo's paid-call backend).
// Spin up the helper with `node scripts/dev-x402-pay-server.mjs`; if set, the
// main Vite dev server will route /api/x402-pay → here while other /api/* still
// proxy to prod. Default is empty so /api/x402-pay falls through to the prod
// proxy when the helper isn't running — otherwise the first hit to /pay would
// crash the dev server with an unhandled ECONNREFUSED proxy error.
const X402_PAY_DEV_URL = process.env.X402_PAY_DEV_URL ?? '';

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

const appConfig = {
	server: {
		proxy: {
			'/chat': {
				target: 'http://localhost:5174',
				changeOrigin: true,
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
								res.end(JSON.stringify({
									error: 'bad_gateway',
									message: `x402-pay dev helper unreachable at ${X402_PAY_DEV_URL}: ${err.message}`,
								}));
							});
						},
					},
				}
				: {}),
			'/api': {
				target: DEV_API_PROXY,
				changeOrigin: true,
				secure: true,
				ws: true,
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
						res.statusCode = 502;
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({
							error: 'bad_gateway',
							message: `api proxy → ${DEV_API_PROXY} failed: ${err.message}`,
						}));
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
	},
	build: {
		chunkSizeWarningLimit: 1000,
		// Skip computing gzip/brotli sizes during build — saves several seconds on
		// large bundles (Three.js, ethers) without affecting the output.
		reportCompressedSize: false,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes('node_modules/three/')) return 'three';
					if (id.includes('node_modules/ethers/')) return 'ethers';
				},
				// footer-bot.js needs a stable, unhashed filename so footer.js can
				// load it by a predictable URL without knowing the build hash.
				entryFileNames: (chunk) =>
					chunk.name === 'footer-bot'
						? 'footer-bot.js'
						: 'assets/[name]-[hash].js',
			},
			input: {
				'footer-bot': resolve(__dirname, 'src/footer-bot.js'),
				app: resolve(__dirname, 'pages/app.html'),
				'app-demo': resolve(__dirname, 'pages/app-demo.html'),
				'app-next': resolve(__dirname, 'pages/app-next.html'),
				home: resolve(__dirname, 'pages/home.html'),
				'home-v2': resolve(__dirname, 'pages/home-v2.html'),
				features: resolve(__dirname, 'pages/features.html'),
				tutorials: resolve(__dirname, 'pages/tutorials.html'),
				tutorial: resolve(__dirname, 'pages/tutorial.html'),
				playground: resolve(__dirname, 'pages/playground.html'),
				embed: resolve(__dirname, 'pages/embed.html'),
				'embed-demo': resolve(__dirname, 'pages/embed-demo.html'),
				widget: resolve(__dirname, 'pages/widget.html'),
				launchpad: resolve(__dirname, 'pages/launchpad.html'),
				create: resolve(__dirname, 'pages/create.html'),
				'create-selfie': resolve(__dirname, 'pages/create-selfie.html'),
				'create-review': resolve(__dirname, 'pages/create-review.html'),
				'import-rpm': resolve(__dirname, 'pages/import-rpm.html'),
				'agent-home': resolve(__dirname, 'pages/agent-home.html'),
				marketplace: resolve(__dirname, 'pages/marketplace.html'),
				'agent-edit': resolve(__dirname, 'pages/agent-edit.html'),
				'agent-embed': resolve(__dirname, 'pages/agent-embed.html'),
				'agent-detail': resolve(__dirname, 'pages/agent-detail.html'),
				'avatar-embed': resolve(__dirname, 'pages/avatar-embed.html'),
				'overlay-control': resolve(__dirname, 'pages/overlay-control.html'),
				'mocap-studio': resolve(__dirname, 'pages/mocap-studio.html'),
				handle: resolve(__dirname, 'pages/handle.html'),
				'a-embed': resolve(__dirname, 'pages/a-embed.html'),
				'a-edit': resolve(__dirname, 'pages/a-edit.html'),
				'pump-live': resolve(__dirname, 'pages/pump-live.html'),
				'pump-dashboard': resolve(__dirname, 'pages/pump-dashboard.html'),
				'pump-visualizer': resolve(__dirname, 'pages/pump-visualizer.html'),
				'avatar-artifact': resolve(__dirname, 'pages/avatar-artifact.html'),
				'launch-week': resolve(__dirname, 'pages/three-ws-launch-week.html'),
				community: resolve(__dirname, 'pages/community.html'),
				profile: resolve(__dirname, 'pages/profile.html'),
				'threews-claim': resolve(__dirname, 'pages/threews-claim.html'),
				'avatar-page': resolve(__dirname, 'pages/avatar-page.html'),
creating: resolve(__dirname, 'pages/creating.html'),
				pricing: resolve(__dirname, 'pages/pricing.html'),
				'x-pricing': resolve(__dirname, 'pages/x-pricing.html'),
				'home-next': resolve(__dirname, 'pages/home-next.html'),
				'home-v3': resolve(__dirname, 'pages/home-v3.html'),
				'agent-next': resolve(__dirname, 'pages/agent-next.html'),
				'discover-next': resolve(__dirname, 'pages/discover-next.html'),
				walk: resolve(__dirname, 'pages/walk.html'),
				'walk-embed': resolve(__dirname, 'pages/walk-embed.html'),
				pose: resolve(__dirname, 'pages/pose.html'),
				club: resolve(__dirname, 'pages/club.html'),
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
				// BEGIN:DISCOVER_ROUTE
				'my-agents': resolve(__dirname, 'public/my-agents/index.html'),
				discover: resolve(__dirname, 'public/discover/index.html'),
				gallery: resolve(__dirname, 'public/gallery/index.html'),
				// END:DISCOVER_ROUTE
				'vanity-wallet': resolve(__dirname, 'public/vanity-wallet.html'),
				'eth-vanity': resolve(__dirname, 'public/eth-vanity.html'),
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
				'demos-erc8004': resolve(__dirname, 'public/demos/erc8004.html'),
				'demos-button-jump': resolve(__dirname, 'public/demos/button-jump.html'),
				'demos-button': resolve(__dirname, 'public/demos/button.html'),
				'demos-3d-home': resolve(__dirname, 'public/demos/3d-home.html'),
				'demos-halfbody-xr': resolve(__dirname, 'public/demos/halfbody-xr.html'),
				// /demos/agents/* — agent interaction lab.
				'agents-index':            resolve(__dirname, 'public/demos/agents/index.html'),
				'agents-cursor-follower':  resolve(__dirname, 'public/demos/agents/cursor-follower.html'),
				'agents-high-five':        resolve(__dirname, 'public/demos/agents/high-five.html'),
				'agents-pickup-drop':      resolve(__dirname, 'public/demos/agents/pickup-drop.html'),
				'agents-fall-from-top':    resolve(__dirname, 'public/demos/agents/fall-from-top.html'),
				'agents-trampoline':       resolve(__dirname, 'public/demos/agents/trampoline.html'),
				'agents-wrecking-ball':    resolve(__dirname, 'public/demos/agents/wrecking-ball.html'),
				'agents-climb-title':      resolve(__dirname, 'public/demos/agents/climb-title.html'),
				'agents-skateboard':       resolve(__dirname, 'public/demos/agents/skateboard.html'),
				'agents-sit-in-body':      resolve(__dirname, 'public/demos/agents/sit-in-body.html'),
				'agents-scroll-inertia':   resolve(__dirname, 'public/demos/agents/scroll-inertia.html'),
				'agents-walks-gutter':     resolve(__dirname, 'public/demos/agents/walks-gutter.html'),
				'agents-holds-cta':        resolve(__dirname, 'public/demos/agents/holds-cta.html'),
				'agents-falls-asleep':     resolve(__dirname, 'public/demos/agents/falls-asleep.html'),
				'agents-builds-button':    resolve(__dirname, 'public/demos/agents/builds-button.html'),
				'agents-face-mocap':       resolve(__dirname, 'public/demos/agents/face-mocap.html'),
				'agents-gemini-live':      resolve(__dirname, 'public/demos/agents/gemini-live.html'),
				'agents-auto-rig':         resolve(__dirname, 'public/demos/agents/auto-rig.html'),
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
					const RE = /<script[^>]*id=["']vite-plugin-pwa:register-sw["'][^>]*><\/script>\s*/g;
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
		// Polyfill the Node `buffer` and `process` globals so @solana/web3.js
		// (and any other dep that does `import { Buffer } from 'buffer'`) works
		// in the browser without the "Module 'buffer' has been externalized"
		// console warning. Scoped to these two — we don't blanket-polyfill all
		// Node builtins because most pages don't need them.
		nodePolyfills({
			include: ['buffer', 'process'],
			globals: { Buffer: true, process: true, global: true },
			protocolImports: true,
		}),
		{
			name: 'vercel-rewrites',
			configureServer(server) {
				const root = resolve(__dirname);
				const fileMap = {
					'/app': resolve(root, 'pages/app.html'),
					'/app-demo': resolve(root, 'pages/app-demo.html'),
					'/widget': resolve(root, 'pages/widget.html'),
					'/widget/': resolve(root, 'pages/widget.html'),
					'/login': resolve(root, 'public/login.html'),
					'/deploy': resolve(root, 'pages/app.html'),
					'/agents': resolve(root, 'public/agents/index.html'),
					'/agents/': resolve(root, 'public/agents/index.html'),
					'/create': resolve(root, 'pages/create.html'),
					'/create/selfie': resolve(root, 'pages/create-selfie.html'),
					'/create/selfie/': resolve(root, 'pages/create-selfie.html'),
					'/create-review': resolve(root, 'pages/create-review.html'),
					'/create-review/': resolve(root, 'pages/create-review.html'),
					'/import/rpm': resolve(root, 'pages/import-rpm.html'),
					'/import/rpm/': resolve(root, 'pages/import-rpm.html'),
					'/dashboard': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard/': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard-classic': resolve(root, 'public/dashboard-classic/index.html'),
					'/dashboard-classic/': resolve(root, 'public/dashboard-classic/index.html'),
					'/dashboard-next': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard-next/': resolve(root, 'pages/dashboard-next/index.html'),
					'/dashboard/avatars': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard/avatars/': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard-next/avatars': resolve(root, 'pages/dashboard-next/avatars.html'),
					'/dashboard-next/avatars/': resolve(root, 'pages/dashboard-next/avatars.html'),
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
					'/marketplace': resolve(root, 'pages/marketplace.html'),
					'/marketplace/': resolve(root, 'pages/marketplace.html'),
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
					'/pump-live': resolve(root, 'pages/pump-live.html'),
					'/pump-live/': resolve(root, 'pages/pump-live.html'),
					'/pump-dashboard': resolve(root, 'pages/pump-dashboard.html'),
					'/pump-dashboard/': resolve(root, 'pages/pump-dashboard.html'),
					'/pump-visualizer': resolve(root, 'pages/pump-visualizer.html'),
					'/pump-visualizer/': resolve(root, 'pages/pump-visualizer.html'),
					'/avatar-artifact': resolve(root, 'pages/avatar-artifact.html'),
					'/avatar-artifact/': resolve(root, 'pages/avatar-artifact.html'),
					'/walk': resolve(root, 'pages/walk.html'),
					'/walk/': resolve(root, 'pages/walk.html'),
					'/walk-embed': resolve(root, 'pages/walk-embed.html'),
					'/walk-embed/': resolve(root, 'pages/walk-embed.html'),
					'/pose': resolve(root, 'pages/pose.html'),
					'/pose/': resolve(root, 'pages/pose.html'),
					'/club': resolve(root, 'pages/club.html'),
					'/club/': resolve(root, 'pages/club.html'),
					'/agenc/embodied': resolve(root, 'pages/agenc/embodied.html'),
					'/agenc/embodied/': resolve(root, 'pages/agenc/embodied.html'),
					'/agenc/room': resolve(root, 'pages/agenc/room.html'),
					'/agenc/room/': resolve(root, 'pages/agenc/room.html'),
					'/brain': resolve(root, 'public/demos/brain.html'),
					'/brain/': resolve(root, 'public/demos/brain.html'),
					'/lipsync': resolve(root, 'public/demos/lipsync-tts.html'),
					'/lipsync/': resolve(root, 'public/demos/lipsync-tts.html'),
					'/lipsync/mic': resolve(root, 'public/demos/lipsync-mic.html'),
					'/lipsync/mic/': resolve(root, 'public/demos/lipsync-mic.html'),
'/launch-week': resolve(root, 'pages/three-ws-launch-week.html'),
					'/launch-week/': resolve(root, 'pages/three-ws-launch-week.html'),
					'/launchpad': resolve(root, 'pages/launchpad.html'),
					'/launchpad/': resolve(root, 'pages/launchpad.html'),
					'/p': resolve(root, 'public/p/index.html'),
					'/p/': resolve(root, 'public/p/index.html'),
					'/eth-vanity': resolve(root, 'public/eth-vanity.html'),
					'/eth-vanity/': resolve(root, 'public/eth-vanity.html'),
					'/strategy-lab': resolve(root, 'public/strategy-lab.html'),
					'/strategy-lab/': resolve(root, 'public/strategy-lab.html'),
					'/sitemap': resolve(root, 'public/sitemap/index.html'),
					'/sitemap/': resolve(root, 'public/sitemap/index.html'),
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
					'/home-v2': resolve(root, 'pages/home-v2.html'),
					'/home-v2/': resolve(root, 'pages/home-v2.html'),
					'/home-classic': resolve(root, 'pages/home.html'),
					'/home-classic/': resolve(root, 'pages/home.html'),
					'/home-v3': resolve(root, 'pages/home-v3.html'),
					'/home-v3/': resolve(root, 'pages/home-v3.html'),
					'/features': resolve(root, 'pages/features.html'),
					'/features/': resolve(root, 'pages/features.html'),
					'/agent': resolve(root, 'pages/agent-home.html'),
					'/agent/new': resolve(root, 'pages/agent-edit.html'),
					'/docs': resolve(root, 'docs/index.html'),
					'/docs/': resolve(root, 'docs/index.html'),
					'/bazaar': resolve(root, 'public/bazaar.html'),
					'/bazaar/': resolve(root, 'public/bazaar.html'),
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
					if (url.includes('html-proxy') || url.includes('@id/') || url.includes('@vite/'))
						return next();
					const path = url.split('?')[0];
					// /api/* is handled by the http proxy in server.proxy above —
					// the middleware must not intercept those requests.
					if (dirRoutes.has(path)) {
						res.statusCode = 301;
						res.setHeader('Location', path + '/' + (req.url.slice(path.length) || ''));
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
					let filePath = fileMap[path];
					// /blog/<slug>  → resolves to blog/<slug>.html on disk
					if (!filePath && /^\/blog\/[a-z0-9-]+\/?$/.test(path)) {
						const slug = path.replace(/^\/blog\//, '').replace(/\/$/, '');
						filePath = resolve(root, `blog/${slug}.html`);
					}
					// /demos/<slug> or /demos/<slug>.html → resolves to public/demos/<slug>.html on disk
					else if (!filePath && /^\/demos\/[a-z0-9-]+(\.html)?\/?$/.test(path)) {
						const slug = path.replace(/^\/demos\//, '').replace(/\.html$/, '').replace(/\/$/, '');
						filePath = resolve(root, `public/demos/${slug}.html`);
					}
					// /demos/agents/<slug>(.html)? → public/demos/agents/<slug>.html.
					// Goes through transformIndexHtml so the inline `'three'` imports
					// inside each demo's <script type="module"> get bundled.
					else if (!filePath && /^\/demos\/agents\/[a-z0-9-]+(\.html)?\/?$/.test(path)) {
						const slug = path.replace(/^\/demos\/agents\//, '').replace(/\.html$/, '').replace(/\/$/, '');
						filePath = resolve(root, `public/demos/agents/${slug}.html`);
					}
					// /demo/coin/<base58 mint> → demo/coin index hydrates from the
					// mint address in the URL path. Mirrors vercel.json.
					else if (!filePath && /^\/demo\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/.test(path)) {
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
					// /agents/:id  → rich detail page (UUID expected, validated client-side)
					else if (!filePath && /^\/agents\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'pages/agent-detail.html');
					else if (!filePath && /^\/agent\/[^/]+\/edit$/.test(path))
						filePath = resolve(root, 'pages/agent-edit.html');
					else if (!filePath && /^\/agent\/[^/]+\/embed$/.test(path))
						filePath = resolve(root, 'pages/agent-embed.html');
					else if (!filePath && /^\/agent\/[^/]+$/.test(path))
						filePath = resolve(root, 'pages/agent-home.html');
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
					// /avatars/:id  → avatar studio page (mirrors vercel.json rewrite)
					else if (!filePath && /^\/avatars\/[^/.]+\/?$/.test(path))
						filePath = resolve(root, 'pages/avatar-page.html');
					// /@<handle>  → public live profile page
					else if (!filePath && /^\/@[a-z0-9_-]{3,30}\/?$/i.test(path))
						filePath = resolve(root, 'pages/handle.html');
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
					// /dashboard-classic/<tab> → public/dashboard-classic/index.html (classic SPA)
					else if (
						!filePath &&
						/^\/dashboard-classic\/(?:agents|avatars|create|upload|animations|widgets|embed|keys|mcp|monetization|payments|subscriptions|billing|revenue|withdrawals|earnings|account|portfolio|wallets|sessions|actions|embed-policy|agent-pumpfun|usage|storage|memory|strategy|voice|sns|delegation|tokens)\/?$/.test(
							path,
						)
					)
						filePath = resolve(root, 'public/dashboard-classic/index.html');
					else if (!filePath && /^\/dashboard-classic\/edit\/[^/]+\/?$/.test(path))
						filePath = resolve(root, 'public/dashboard-classic/index.html');
					else if (!filePath && /^\/dashboard-classic\/portfolio\/asset\/?$/.test(path))
						filePath = resolve(root, 'public/dashboard-classic/portfolio-asset.html');
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
					// /dashboard-classic/<page> → corresponding static HTML page (classic pages)
					else if (!filePath && /^\/dashboard-classic\/portfolio\/asset\/?$/.test(path))
						filePath = resolve(root, 'public/dashboard-classic/portfolio-asset.html');
					else if (!filePath && /^\/dashboard-classic\/(?:portfolio|wallets|sessions|actions|embed-policy|agent-pumpfun|usage|storage|memory|strategy|voice|sns|delegation|tokens)\/?$/.test(path)) {
						const slug = path.replace(/^\/dashboard-classic\//, '').replace(/\/$/, '');
						filePath = resolve(root, `public/dashboard-classic/${slug}.html`);
					}
					// Generic fallback: /<slug> or /<slug>.html → pages/<slug>.html
					// Catches the long tail of bundled root-level pages (community,
					// playground, embed, profile, …) without bloating fileMap.
					else if (!filePath && /^\/[a-z0-9][a-z0-9-]*(\.html)?\/?$/.test(path)) {
						const slug = path.replace(/^\//, '').replace(/\.html$/, '').replace(/\/$/, '');
						const candidate = resolve(root, `pages/${slug}.html`);
						if (existsSync(candidate)) filePath = candidate;
					}
					// Serve the rider webpack app as static files.
					// /footer-bot.js — serve the Vite-processed src/footer-bot.js at a
				// stable URL in dev so footer.js can load it without knowing the hash.
				if (path === '/footer-bot.js') {
					req.url = '/src/footer-bot.js';
					return next();
				}
				if (path === '/rider' || path === '/rider/') {
						const html = readFileSync(resolve(root, 'rider/index.html'), 'utf8');
						res.setHeader('Content-Type', 'text/html; charset=utf-8');
						return res.end(html);
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
						return res.end('Avatar Studio build missing — run `npm run build --prefix character-studio`');
					}
					if (path.startsWith('/avatar-studio/')) {
						const ext = path.split('.').pop().toLowerCase();
						const mimes = { js: 'application/javascript', map: 'application/json', css: 'text/css', json: 'application/json', html: 'text/html', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', glb: 'model/gltf-binary', gltf: 'model/gltf+json', vrm: 'application/octet-stream', obj: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm' };
						const rel = path.slice('/avatar-studio/'.length);
						const fileDisk = resolve(root, 'character-studio/build', rel);
						if (existsSync(fileDisk) && statSync(fileDisk).isFile()) {
							res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
							return createReadStream(fileDisk).pipe(res);
						}
						return next();
					}
					if (path.startsWith('/rider/')) {
						const ext = path.split('.').pop().toLowerCase();
						const mimes = { js: 'application/javascript', map: 'application/json', css: 'text/css', json: 'application/json', html: 'text/html', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
						const fileDisk = resolve(root, path.slice(1));
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
						'widget.html', 'embed.html', 'avatar-embed.html',
						'agent-embed.html', 'a-embed.html',
					]);
					const filename = (ctx.filename || ctx.path || '').replace(/\\/g, '/').split('/').pop();
					if (EMBED_FILES.has(filename)) return [];
					const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias set_config reset opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_distinct_id get_session_id get_session_replay_url register register_once unregister on onFeatureFlags reloadFeatureFlags getFeatureFlag getFeatureFlagPayload isFeatureEnabled addExceptionStep captureException".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('phc_kvi8nrXqrNkLNy2NhaiwkbGyj77XpSJo54P5k2ZHYo9n',{api_host:'https://us.i.posthog.com',defaults:'2026-01-30',person_profiles:'identified_only'})`;
					return [{ tag: 'script', children: SNIPPET, injectTo: 'head' }];
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
						'widget.html', 'embed.html', 'avatar-embed.html',
						'agent-embed.html', 'a-embed.html',
					]);
					const filename = (ctx.filename || ctx.path || '').replace(/\\/g, '/').split('/').pop();
					if (EMBED_FILES.has(filename)) return [];
					return [{
						tag: 'script',
						attrs: { type: 'module' },
						children: `import('/src/view-transitions.js').then(m=>m.enableViewTransitions()).catch(()=>{});`,
						injectTo: 'head',
					}];
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
					return [{ tag: 'meta', attrs: { name: 'has-three-bundle', content: 'true' }, injectTo: 'head' }];
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
			const GUARD = 'try{Object.defineProperty(window,"__THREE__",{configurable:true,get:function(){return undefined},set:function(){}})}catch(_){}';
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
						const { readdirSync, statSync, readFileSync, writeFileSync } = await import('fs');
						const { join } = await import('path');
						const distDir = resolve(__dirname, 'dist');
						if (!existsSync(distDir)) return;
						const MARKER = 'Object.defineProperty(window,"__THREE__"';
						const LEGACY = /<script>\s*window\.__THREE__\s*=\s*window\.__THREE__\s*\|\|\s*["'][^"']+["']\s*;?\s*<\/script>\s*/g;
						const tag = `<script>${GUARD}</script>`;
						const walk = (dir) => {
							for (const entry of readdirSync(dir)) {
								const full = join(dir, entry);
								let stat;
								try { stat = statSync(full); } catch { continue; }
								if (stat.isDirectory()) walk(full);
								else if (entry.endsWith('.html')) {
									const html = readFileSync(full, 'utf8');
									let next = html.replace(LEGACY, '');
									if (!next.includes(MARKER)) {
										next = next.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n\t\t${tag}`);
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
			// Several static pages (dashboard, vanity-wallet, …) import ESM
			// directly from `/src/*.js`. Vite's dev server serves these from
			// the project root, but production needs them under dist/. Mirror
			// the tree so the runtime URLs resolve.
			name: 'copy-src-to-dist',
			closeBundle() {
				cpSync(resolve(__dirname, 'src'), resolve(__dirname, 'dist/src'), {
					recursive: true,
				});
				cpSync(resolve(__dirname, 'pump-fun-skills'), resolve(__dirname, 'dist/pump-fun-skills'), {
					recursive: true,
				});
			},
		},
		{
			name: 'copy-rider',
			closeBundle() {
				const src = resolve(__dirname, 'rider');
				if (existsSync(src)) {
					cpSync(src, resolve(__dirname, 'dist/rider'), { recursive: true });
				}
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
					console.warn('[copy-avatar-studio] character-studio/build/ missing — run `npm run build --prefix character-studio` first');
					return;
				}
				cpSync(src, resolve(__dirname, 'dist/avatar-studio'), { recursive: true });
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
						const mod = await server.ssrLoadModule(
							'/api/widgets/_demo-fixtures.js',
						);
						const widget = mod.getDemoWidget(m[1]);
						if (!widget) {
							res.statusCode = 404;
							res.setHeader('content-type', 'application/json');
							res.end(JSON.stringify({ error: 'not_found', message: 'widget not found' }));
							return;
						}
						res.statusCode = 200;
						res.setHeader('content-type', 'application/json');
						res.setHeader('cache-control', 'public, max-age=60');
						res.end(JSON.stringify({ widget }));
					} catch (err) {
						res.statusCode = 500;
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ error: 'fixture_load_failed', message: err.message }));
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
					['dist/public/demos/brain.html', 'dist/demos/brain.html'],
					['dist/public/demos/lipsync-tts.html', 'dist/demos/lipsync-tts.html'],
					['dist/public/demos/lipsync-mic.html', 'dist/demos/lipsync-mic.html'],
					['dist/public/demos/erc8004.html', 'dist/demos/erc8004.html'],
					['dist/public/demos/button-jump.html', 'dist/demos/button-jump.html'],
					['dist/public/demos/button.html', 'dist/demos/button.html'],
					['dist/public/demos/3d-home.html', 'dist/demos/3d-home.html'],
					['dist/public/eth-vanity.html', 'dist/eth-vanity.html'],
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
					{ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
						url: '/agent-home?source=pwa-shortcut',
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
				// MPA: every route is a separate HTML file served by the server.
				// No navigation fallback — uncached navigations go to the network.
				// HTML is intentionally excluded from globPatterns so it is never
				// precached: (1) the SW install is dramatically faster (hundreds fewer
				// files), (2) old SWs can activate the new one in seconds instead of
				// minutes, (3) navigation requests fall through to the network and
				// always return the current page from Vercel's edge — no stale HTML
				// and no offline.html served to online users.
				navigateFallback: null,
				globPatterns: ['**/*.{js,css,ico,woff2}'],
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
						urlPattern: /^https?:\/\/[^/]+\/(embed|a-embed|agent-embed|avatar-embed)(\/.*|\?.*|#.*|$)/i,
						handler: 'NetworkOnly',
					},
					{
						urlPattern: /^https?:\/\/[^/]+\/api\/widgets\//i,
						handler: 'NetworkOnly',
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
					{
						urlPattern: /^https:\/\/three\.ws\/api\/.*/i,
						handler: 'NetworkOnly',
					},
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
