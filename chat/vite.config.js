import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import fs from 'fs';

const ROOT_PUBLIC = path.resolve(__dirname, '../public');
const DIST_LIB = path.resolve(__dirname, '../dist-lib');

function serveDevAssets() {
	return {
		name: 'serve-dev-assets',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url) return next();
				const url = req.url.split('?')[0];
				let filePath = null;
				if (url.startsWith('/animations/')) {
					filePath = path.join(ROOT_PUBLIC, url);
				} else if (url.startsWith('/agent-3d/')) {
					const tail = url.replace(/^\/agent-3d\/(latest|\d+(\.\d+){0,2})\//, '');
					filePath = path.join(DIST_LIB, tail);
				} else if (url.startsWith('/avatars/')) {
					filePath = path.join(ROOT_PUBLIC, url);
				}
				if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
					const ext = path.extname(filePath).toLowerCase();
					const mime = {
						'.js': 'application/javascript',
						'.mjs': 'application/javascript',
						'.cjs': 'application/javascript',
						'.json': 'application/json',
						'.glb': 'model/gltf-binary',
						'.gltf': 'model/gltf+json',
						'.fbx': 'application/octet-stream',
						'.png': 'image/png',
						'.jpg': 'image/jpeg',
					}[ext] || 'application/octet-stream';
					res.setHeader('Content-Type', mime);
					res.setHeader('Access-Control-Allow-Origin', '*');
					fs.createReadStream(filePath).pipe(res);
					return;
				}
				next();
			});
		},
	};
}

export default defineConfig(function () {
	const buildTimestamp = new Date();
	return {
		base: '/chat/',
		build: {
			outDir: '../public/chat',
			emptyOutDir: true,
		},
		server: {
			// Pinned, because the root dev server proxies /chat to exactly this
			// port. On Vite's default (5173) the proxy could never reach this app,
			// and a second Vite instance would silently take the next free port.
			port: 5174,
			strictPort: true,
			fs: {
				// The chat app reuses shared wallet modules that live in the main
				// repo's src/ (one repo, one wallet truth), so allow Vite to serve them.
				allow: [path.resolve(__dirname, '..')],
			},
			proxy: {
				// Vercel serverless functions live under /api/* in production but
				// Vite's dev server doesn't run them. Forward /api/* to a real
				// upstream so paid x402 calls, model fetches, and auth all work
				// against the production backend during chat dev unless the user
				// explicitly points DEV_API_PROXY at a local vercel-dev process.
				'/api': {
					target: process.env.DEV_API_PROXY || 'https://three.ws',
					changeOrigin: true,
					secure: true,
				},
			},
		},
		plugins: [
			serveDevAssets(),
			svelte(),
		],
		resolve: {
			dedupe: ['three'],
			alias: {
				'$src': path.resolve(__dirname, './src'),
				// Shared wallet layer lives in the main app's src/shared (single source
				// of truth for the agent wallet everywhere its avatar appears).
				'$shared': path.resolve(__dirname, '../src/shared'),
			}
		},
		define: {
			'import.meta.env.BUILD_TIMESTAMP': JSON.stringify(buildTimestamp.toLocaleString()),
		},
		optimizeDeps: {
			include: ['svelte-fast-dimension/action'],
		},
	};
});
