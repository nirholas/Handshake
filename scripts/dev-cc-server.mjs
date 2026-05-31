// Local function server for verifying the CoinCommunities-configured flow.
//
// Vite dev proxies /api/* straight to production, where CC_API_KEY is unset — so
// the only way to exercise the *configured* worlds/Town experience locally is to
// run the real api/community/* handlers here with a key set, and forward every
// other /api/* path (avatars, etc.) on to production unchanged.
//
//   CC_API_KEY=cc_... node scripts/dev-cc-server.mjs            # listens on :3001
//   DEV_API_PROXY=http://localhost:3001 npm run dev             # point Vite at it
//
// This runs the EXACT production handler code (api/community/worlds.js, …) — no
// reimplementation, no mocks. It exists only for local verification.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

// Load .env (gitignored) so the real handlers see CC_API_KEY without it having
// to be exported on the command line. Minimal parser — no dependency.
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, 'utf8').split('\n')) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
	}
}

const PORT = Number(process.env.CC_DEV_PORT) || 3001;
const PROD = (process.env.DEV_API_UPSTREAM || 'https://three.ws').replace(/\/+$/, '');

if (!process.env.CC_API_KEY) {
	console.error('CC_API_KEY not set — start with CC_API_KEY=cc_... node scripts/dev-cc-server.mjs');
	process.exit(2);
}

const handlerCache = new Map();
async function loadHandler(pathname) {
	// /api/community/worlds → api/community/worlds.js (supports sub-dirs: auth/url)
	const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
	const file = resolve(process.cwd(), 'api', `${rel}.js`);
	if (!existsSync(file)) return null;
	if (!handlerCache.has(file)) {
		const mod = await import(pathToFileURL(file).href);
		handlerCache.set(file, mod.default);
	}
	return handlerCache.get(file);
}

async function proxyToProd(req, res) {
	const target = `${PROD}${req.url}`;
	const headers = { ...req.headers };
	delete headers.host;
	const init = { method: req.method, headers, redirect: 'manual' };
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		init.body = Buffer.concat(chunks);
	}
	const upstream = await fetch(target, init);
	res.statusCode = upstream.status;
	upstream.headers.forEach((v, k) => {
		if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) return;
		res.setHeader(k, v);
	});
	const buf = Buffer.from(await upstream.arrayBuffer());
	res.end(buf);
}

const server = createServer(async (req, res) => {
	try {
		const pathname = new URL(req.url, 'http://x').pathname;
		if (pathname.startsWith('/api/community/')) {
			const handler = await loadHandler(pathname);
			if (handler) {
				await handler(req, res);
				if (!res.writableEnded) res.end();
				return;
			}
		}
		await proxyToProd(req, res);
	} catch (err) {
		console.error('[dev-cc-server]', req.method, req.url, err);
		if (!res.headersSent) {
			res.statusCode = 502;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: 'dev_server_error', error_description: String(err?.message || err) }));
		}
	}
});

server.listen(PORT, () => {
	console.log(`[dev-cc-server] :${PORT} — community/* handlers run locally (CC key set), other /api/* → ${PROD}`);
});
