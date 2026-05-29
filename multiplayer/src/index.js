// Entry point for the three.ws multiplayer server.
//
// This is a standalone Colyseus process — Vercel can't host long-lived
// WebSocket servers, so this runs separately (Fly.io, Railway, Render, or a
// $5 VPS — see ../README.md). The Vite app at three.ws/walk and three.ws/play
// connect to it over WebSocket and exchange state via the rooms defined below.
//
// We mount an Express app as the HTTP request handler. Colyseus 0.16 detects
// an existing Express app on the underlying http.Server and composes with it:
// matchmaking + seat-reservation routes go to Colyseus's own router, and
// everything else (/health, /colyseus monitor) falls through to Express. This
// is the supported way to expose custom HTTP routes alongside Colyseus on one
// port — a hand-rolled raw request listener double-responds and throws
// ERR_HTTP_HEADERS_SENT against the matchmaker's prepended listener.

import http from 'node:http';
import express from 'express';
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

const app = express();

// Liveness probes for the host platform (Fly/Railway/Render).
app.get(['/health', '/healthz'], (_req, res) => {
	res.json({ ok: true, name: 'three.ws-multiplayer' });
});

// Admin monitor UI. Protect this behind a reverse proxy or basic auth in prod
// (see @colyseus/monitor docs) — it exposes live room/client state.
app.use('/colyseus', monitor());

const httpServer = http.createServer(app);

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
// Each coin is its own world: filterBy(['coin']) makes joinOrCreate match only
// rooms sharing the same community coin (mint), so players of the same coin land
// together while different coins stay isolated. A missing coin resolves to the
// shared mainland world (see WalkRoom.onCreate / schemas.js).
gameServer.define('walk_world', WalkRoom).filterBy(['coin']);
gameServer.define('game_mainland', GameRoom);

gameServer
	.listen(PORT, HOST)
	.then(() => {
		console.log(`[multiplayer] listening on ws://${HOST}:${PORT}`);
		console.log(`[multiplayer] rooms: walk_world, game_mainland`);
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
