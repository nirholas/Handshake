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

// Admin monitor UI — exposes live room/client state, so it must NOT be open to
// the world in production. Mount it only when protected by basic-auth creds
// (MONITOR_USER + MONITOR_PASS), or, outside production, openly for local dev.
const MONITOR_USER = process.env.MONITOR_USER;
const MONITOR_PASS = process.env.MONITOR_PASS;
const IS_PROD = process.env.NODE_ENV === 'production';
function monitorBasicAuth(req, res, next) {
	const hdr = req.headers.authorization || '';
	const [scheme, encoded] = hdr.split(' ');
	if (scheme === 'Basic' && encoded) {
		const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
		if (user === MONITOR_USER && pass === MONITOR_PASS) return next();
	}
	res.set('WWW-Authenticate', 'Basic realm="colyseus-monitor"').status(401).send('auth required');
}
if (MONITOR_USER && MONITOR_PASS) {
	app.use('/colyseus', monitorBasicAuth, monitor());
	console.log('[multiplayer] monitor mounted at /colyseus (basic auth)');
} else if (!IS_PROD) {
	app.use('/colyseus', monitor());
	console.log('[multiplayer] monitor mounted at /colyseus (open — dev only)');
} else {
	console.log('[multiplayer] monitor disabled (set MONITOR_USER/MONITOR_PASS to enable in prod)');
}

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

// Horizontal scaling across Cloud Run instances. Colyseus rooms live in one
// process, so to run more than one instance the room registry (driver) and
// pub/sub (presence) must be shared — otherwise matchmaking on instance A can't
// see a room hosted on instance B and players for the same coin split apart.
// Setting REDIS_URI (e.g. a Memorystore instance) wires both; without it the
// server runs single-instance exactly as before (zero new behaviour, the deps
// are only imported when REDIS_URI is present).
const REDIS_URI = process.env.REDIS_URI || process.env.REDIS_URL;
let driver, presence;
if (REDIS_URI) {
	try {
		const [{ RedisDriver }, { RedisPresence }] = await Promise.all([
			import('@colyseus/redis-driver'),
			import('@colyseus/redis-presence'),
		]);
		driver = new RedisDriver(REDIS_URI);
		presence = new RedisPresence(REDIS_URI);
		console.log('[multiplayer] horizontal scaling ENABLED (Redis driver + presence)');
	} catch (err) {
		console.error('[multiplayer] REDIS_URI set but Redis deps unavailable — staying single-instance:', err?.message);
	}
} else {
	console.log('[multiplayer] single-instance mode (set REDIS_URI to scale horizontally)');
}

const gameServer = new Server({ transport, ...(driver && { driver }), ...(presence && { presence }) });
// Each coin is its own world, split by access tier: filterBy(['coin','tier'])
// makes joinOrCreate match only rooms sharing the same community coin (mint) AND
// the same tier, so a coin's open General world and its gated Holders world are
// separate instances, and different coins stay isolated. A missing coin resolves
// to the shared mainland world; a missing tier is the open General world (see
// WalkRoom.onCreate / onAuth / schemas.js).
gameServer.define('walk_world', WalkRoom).filterBy(['coin', 'tier']);
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
