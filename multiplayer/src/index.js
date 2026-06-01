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
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { monitor } from '@colyseus/monitor';

import { WalkRoom } from './rooms/WalkRoom.js';
import { GameRoom } from './rooms/GameRoom.js';
import { REALMS } from './rooms/realms.js';
import { blockStore } from './block-store.js';
import { flushAllPlayers } from './playerStore.js';
import { marketplaceStore } from './marketplaceStore.js';
import { SERVERS } from './servers.js';
import { PRESENCE_HASH } from './presence-keys.js';
import { socialHub } from './social-hub.js';
import { verifyNotifySignature } from './presence-token.js';

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

// Fail fast on an insecure production config. Without a real shared secret the
// holder gate is forgeable by anyone (both this process and the Vercel signer
// fall back to a public dev secret otherwise), so refuse to boot prod without it
// rather than silently shipping a bypassable gate.
if (process.env.NODE_ENV === 'production' && !process.env.HOLDER_PASS_SECRET) {
	console.error(
		'[multiplayer] FATAL: HOLDER_PASS_SECRET is required in production — the holder gate would be forgeable. Refusing to start.',
	);
	process.exit(1);
}

// Surface the platform token gate's state at boot so a misconfigured deploy is
// obvious in the logs. The gate itself is enforced in WalkRoom.onAuth; an unset
// mint leaves walk_world open (the default until $THREE is pinned).
const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
if (PLAY_GATE_MINT) {
	const min = Number(process.env.PLAY_GATE_MIN) > 0 ? Number(process.env.PLAY_GATE_MIN) : 1;
	console.log(`[multiplayer] play gate ENABLED — require ≥ ${min} of ${PLAY_GATE_MINT} (wallet sign-in)`);
} else {
	console.log('[multiplayer] play gate OFF (set PLAY_GATE_MINT or THREE_MINT to require wallet sign-in + token balance)');
}

const app = express();

// Liveness probes for the host platform (Fly/Railway/Render).
app.get(['/health', '/healthz'], (_req, res) => {
	res.json({ ok: true, name: 'three.ws-multiplayer' });
});

// Internal friends delivery webhook (Task 15). The three.ws API calls this after
// persisting a DM or friend-graph change to push it live to every socket the
// recipient account has open here. HMAC-signed with the shared secret so only
// the API can inject events; returns whether the recipient was online (the API
// uses that to decide live vs. next-login delivery). Body is small JSON; an
// unsigned or malformed request is rejected before any work.
app.post('/internal/notify', express.json({ limit: '16kb' }), (req, res) => {
	const { type, to, payload } = req.body || {};
	const sig = req.headers['x-mp-signature'];
	if (typeof type !== 'string' || typeof to !== 'string' || !type || !to) {
		return res.status(400).json({ error: 'bad_request' });
	}
	if (!verifyNotifySignature(to, type, sig)) {
		return res.status(401).json({ error: 'bad_signature' });
	}
	const delivered = socialHub.deliver(to, type, payload || {});
	res.json({ delivered });
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
				if (!IS_PROD && (host.endsWith('.app.github.dev') || host.endsWith('.githubpreview.dev') || host.endsWith('.gitpod.io'))) {
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
// One room definition per realm — each is its own instance, so players in
// different realms never see or affect each other. The realm name is baked into
// the definition's options and read by GameRoom.onCreate. Mainland/Whisperwood/
// Pond/Mine are safe; Wilderness is the danger+pvp realm that drops death-bags.
// Mine is the enclosed cave interior reached through the Mainland mine entrance.
//
// Server dimension (Task 23): filterBy(['server']) splits each realm definition
// into one room per chosen world instance, exactly as walk_world is split by
// coin/tier above. A joinOrCreate for game_mainland with {server:'s2'} matches
// only rooms created with server='s2', so the two worlds never merge — players
// on different servers can't see each other in any realm, chat, or /who. A
// missing/forged server option collapses to the default instance (see
// servers.cleanServer / GameRoom.onCreate).
// One room definition per realm, sourced from REALMS so a newly-defined realm is
// reachable the moment it's added to realms.js — no separate list to keep in sync.
for (const realm of Object.keys(REALMS)) {
	gameServer.define(`game_${realm}`, GameRoom, { realm }).filterBy(['server']);
}

// --- Multi-server discovery + presence (Task 23) ---------------------------
// Read-only JSON the /play login picker and a friends panel consume from the
// (different-origin) static site, so they carry permissive CORS. Both read live
// truth — never cached or faked numbers.

// CORS for the public read-only endpoints. The population counts and presence
// flags are not sensitive, so we allow any origin to GET them; no credentials
// are involved. OPTIONS preflights short-circuit here.
function publicJsonCors(_req, res, next) {
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.set('Access-Control-Allow-Headers', 'Content-Type');
	res.set('Cache-Control', 'no-store');
	if (_req.method === 'OPTIONS') return res.status(204).end();
	next();
}

// GET /servers — the world-instance roster with REAL live population. Population
// is the sum of connected clients across every game_* room whose metadata names
// that server, queried through the matchmaker (so it's correct across all
// horizontally-scaled instances, not just this process). The least-full server
// is recommended so the picker can nudge balancing without ever faking a count.
app.get('/servers', publicJsonCors, async (_req, res) => {
	const counts = Object.fromEntries(SERVERS.map((s) => [s.id, 0]));
	try {
		const rooms = await matchMaker.query({});
		for (const r of rooms) {
			if (typeof r.name !== 'string' || !r.name.startsWith('game_')) continue;
			const sid = r.metadata?.server;
			if (sid && sid in counts) counts[sid] += r.clients || 0;
		}
	} catch (err) {
		console.warn('[multiplayer] /servers query failed:', err?.message);
		return res.status(503).json({ error: 'population_unavailable' });
	}
	// Recommend exactly one server — the least-full — preferring the first in
	// roster order on a tie so the suggestion is stable between polls.
	let recommended = SERVERS[0]?.id || null;
	let min = Infinity;
	for (const s of SERVERS) {
		if (counts[s.id] < min) { min = counts[s.id]; recommended = s.id; }
	}
	res.json({
		servers: SERVERS.map((s) => ({
			id: s.id,
			name: s.name,
			blurb: s.blurb,
			players: counts[s.id],
			recommended: s.id === recommended,
		})),
	});
});

// GET /presence?ids=a,b,c — for a friends panel (Task 15): resolve which
// server+realm each named account is currently on, or that they're offline.
// Reads the shared presence hash GameRoom maintains on join/leave. Capped at a
// sane batch size so a single request can't sweep the whole registry.
app.get('/presence', publicJsonCors, async (req, res) => {
	const ids = String(req.query.ids || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 100);
	if (!ids.length) return res.json({ presence: {} });
	let all = {};
	try {
		all = (await gameServer.presence.hgetall(PRESENCE_HASH)) || {};
	} catch (err) {
		console.warn('[multiplayer] /presence read failed:', err?.message);
		return res.status(503).json({ error: 'presence_unavailable' });
	}
	const presence = {};
	for (const id of ids) {
		const raw = all[id];
		if (!raw) { presence[id] = { online: false }; continue; }
		try {
			const e = JSON.parse(raw);
			presence[id] = { online: true, server: e.server || '', realm: e.realm || '', name: e.name || '' };
		} catch {
			presence[id] = { online: false };
		}
	}
	res.json({ presence });
});

gameServer
	.listen(PORT, HOST)
	.then(() => {
		console.log(`[multiplayer] listening on ws://${HOST}:${PORT}`);
		console.log(`[multiplayer] rooms: walk_world, game_{${Object.keys(REALMS).join(',')}}`);
		console.log(`[multiplayer] world instances: ${SERVERS.map((s) => `${s.id} (${s.name})`).join(', ')}`);
		console.log(`[multiplayer] discovery: GET /servers, GET /presence?ids=`);
		console.log(`[multiplayer] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
	})
	.catch((err) => {
		console.error('[multiplayer] failed to start:', err);
		process.exit(1);
	});

// Keep the single instance alive through an isolated fault. A throw inside one
// onMessage handler, or an unawaited rejection deep in a dependency, would
// otherwise take down the whole process (min=1/max=1) and every connected
// player with it. We log loudly and keep serving — the offending message/room
// is lost, the server is not. (A crash-loop on a corrupt state would still be
// caught by the host's health check.)
process.on('uncaughtException', (err) => {
	console.error('[multiplayer] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
	console.error('[multiplayer] unhandledRejection (kept alive):', reason);
});

// Clean shutdown on SIGTERM/SIGINT so deploys don't drop sessions abruptly.
const shutdown = async (signal) => {
	console.log(`[multiplayer] ${signal} received — shutting down`);
	try {
		await gameServer.gracefullyShutdown(true);
	} catch (err) {
		console.error('[multiplayer] shutdown error:', err);
	}
	// Belt-and-suspenders: persist any world whose debounced save hadn't fired
	// before the room disposed, so a redeploy never drops the last few edits.
	try {
		await blockStore.flushAll();
	} catch (err) {
		console.error('[multiplayer] final block flush error:', err);
	}
	// Same guarantee for player progression (Task 16): persist every account whose
	// debounced profile save hadn't landed yet, so a redeploy never resets a player.
	try {
		await flushAllPlayers();
	} catch (err) {
		console.error('[multiplayer] final player flush error:', err);
	}
	// And the marketplace (Task 20): flush any debounced listing/payout writes so a
	// redeploy never drops an active listing or a seller's owed proceeds.
	try {
		await marketplaceStore.flushAll();
	} catch (err) {
		console.error('[multiplayer] final market flush error:', err);
	}
	process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
