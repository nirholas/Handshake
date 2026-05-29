// Entry point for the three.ws multiplayer server.
//
// This is a standalone Colyseus process — Vercel can't host long-lived
// WebSocket servers, so this runs separately (Fly.io, Railway, Render, or a
// $5 VPS — see ../README.md). The Vite app at three.ws/walk connects to it
// over WebSocket and exchanges player state via the WalkRoom defined below.

import http from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { monitor } from '@colyseus/monitor';

import { WalkRoom } from './rooms/WalkRoom.js';
import { GameRoom } from './rooms/GameRoom.js';

const PORT = Number(process.env.PORT || 2567);
const HOST = process.env.HOST || '0.0.0.0';
// Origins permitted to upgrade to WebSocket — comma-separated list. Default
// covers local dev + the production three.ws origin. Anything outside this
// set gets a 403 before the WS handshake completes.
const ALLOWED_ORIGINS = (
	process.env.ALLOWED_ORIGINS ||
	'http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,https://three.ws,https://www.three.ws'
)
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// Use a plain http.Server so we can mount /health for platform health checks
// and /colyseus for the admin monitor UI on the same port. WebSocketTransport
// hooks the upgrade event and ignores anything that isn't a Colyseus WS
// upgrade, so /health and /colyseus stay reachable as normal HTTP routes.
const httpServer = http.createServer((req, res) => {
	if (req.url === '/health' || req.url === '/healthz') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, name: 'three.ws-multiplayer' }));
		return;
	}
	if (req.url === '/' || req.url === '') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('three.ws multiplayer · Colyseus\n');
		return;
	}
	if (req.url.startsWith('/colyseus')) {
		// Mount the admin monitor lazily — `monitor()` returns an Express-style
		// middleware that we adapt to the node http stack via a tiny shim.
		return monitorMiddleware(req, res);
	}
	res.writeHead(404);
	res.end();
});

// Lazy monitor adapter — `@colyseus/monitor` ships an Express router. We mount
// it through a one-shot Express instance so we don't take a hard dep on
// express here at the top level.
let _monitorHandler = null;
async function monitorMiddleware(req, res) {
	if (!_monitorHandler) {
		const { default: express } = await import('express');
		const app = express();
		app.use('/colyseus', monitor());
		_monitorHandler = app;
	}
	_monitorHandler(req, res);
}

const transport = new WebSocketTransport({
	server: httpServer,
	verifyClient(info, next) {
		const origin = info.req.headers.origin;
		if (!origin) return next(true); // native clients / curl probes
		if (ALLOWED_ORIGINS.includes(origin)) return next(true);
		// Allow any Vercel preview deploy that targets the same project — these
		// have origins like https://three-ws-<hash>-<team>.vercel.app. We match
		// by hostname suffix so we don't have to maintain an allow-list per
		// preview URL.
		try {
			const host = new URL(origin).hostname;
			if (host.endsWith('.vercel.app') || host.endsWith('.three.ws')) {
				return next(true);
			}
		} catch {}
		console.warn(`[multiplayer] rejecting origin ${origin}`);
		return next(false, 403, 'origin not allowed');
	},
});

const gameServer = new Server({ transport });
gameServer.define('walk_world', WalkRoom);
gameServer.define('game_mainland', GameRoom);

gameServer
	.listen(PORT, HOST)
	.then(() => {
		console.log(`[multiplayer] listening on ws://${HOST}:${PORT}`);
		console.log(`[multiplayer] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
	})
	.catch((err) => {
		console.error('[multiplayer] failed to start:', err);
		process.exit(1);
	});

// Clean shutdown on SIGTERM/SIGINT so deploys don't drop sessions abruptly.
const shutdown = async (signal) => {
	console.log(`[multiplayer] ${signal} received — shutting down`);
	try {
		await gameServer.gracefullyShutdown(true);
	} catch (err) {
		console.error('[multiplayer] shutdown error:', err);
	}
	process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
