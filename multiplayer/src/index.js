// Entry point for the three.ws multiplayer server.
//
// This is a standalone Colyseus process, Vercel can't host long-lived
// WebSocket servers, so this runs separately (Fly.io, Railway, Render, or a
// $5 VPS, see ../README.md). The Vite app at three.ws/walk and three.ws/play
// connect to it over WebSocket and exchange state via the rooms defined below.
//
// We mount an Express app as the HTTP request handler. Colyseus 0.16 detects
// an existing Express app on the underlying http.Server and composes with it:
// matchmaking + seat-reservation routes go to Colyseus's own router, and
// everything else (/health, /colyseus monitor) falls through to Express. This
// is the supported way to expose custom HTTP routes alongside Colyseus on one
// port, a hand-rolled raw request listener double-responds and throws
// ERR_HTTP_HEADERS_SENT against the matchmaker's prepended listener.

import http from 'node:http';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { monitor } from '@colyseus/monitor';

import { WalkRoom } from './rooms/WalkRoom.js';
import { AgoraRoom } from './rooms/AgoraRoom.js';
import { IrlRoom } from './rooms/IrlRoom.js';
import { ClashRoom } from './rooms/ClashRoom.js';
import { StageRoom } from './rooms/StageRoom.js';
import { StudioRoom } from './rooms/StudioRoom.js';
import { getStageRoom } from './stage-registry.js';
import { blockStore } from './block-store.js';
import { worldPersistence } from './persistence.js';
import { flushAllPlayers } from './playerStore.js';
import { socialHub } from './social-hub.js';
import { verifyNotifySignature, verifyStageSignature, verifyAnnounceSignature } from './presence-token.js';
import { liveWalkRooms } from './walk-registry.js';

const PORT = Number(process.env.PORT || 2567);
const HOST = process.env.HOST || '0.0.0.0';
// Origins permitted to upgrade to WebSocket, comma-separated list. Default
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
		'[multiplayer] FATAL: HOLDER_PASS_SECRET is required in production, the holder gate would be forgeable. Refusing to start.',
	);
	process.exit(1);
}

// Surface the platform token gate's state at boot so a misconfigured deploy is
// obvious in the logs. The gate itself is enforced in WalkRoom.onAuth; an unset
// mint leaves walk_world open (the default until $THREE is pinned).
const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
if (PLAY_GATE_MINT) {
	const min = Number(process.env.PLAY_GATE_MIN) > 0 ? Number(process.env.PLAY_GATE_MIN) : 1;
	console.log(`[multiplayer] play gate ENABLED, require ≥ ${min} of ${PLAY_GATE_MINT} (wallet sign-in)`);
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
	const ts = req.headers['x-mp-timestamp'];
	if (typeof type !== 'string' || typeof to !== 'string' || !type || !to) {
		return res.status(400).json({ error: 'bad_request' });
	}
	// The signature is bound to the exact payload and a fresh timestamp, so a leaked
	// (to,type,sig) tuple can't be replayed with attacker-chosen content or after
	// the freshness window. Verify against the body we're about to deliver.
	if (!verifyNotifySignature(to, type, payload || {}, ts, sig)) {
		return res.status(401).json({ error: 'bad_signature' });
	}
	const delivered = socialHub.deliver(to, type, payload || {});
	res.json({ delivered });
});

// Living Stages tip/event bridge (Moonshot 04). The three.ws API calls this the
// instant a real $THREE tip settles on-chain (after it has verified the
// settlement signature + mint and deduped per signature) so the live StageRoom
// can react within ~1s, broadcast the tip ticker, update the leaderboard, and
// pre-empt the host's next beat with a shoutout. HMAC-signed with the shared
// secret bound to the exact body + a fresh timestamp, so only the API can inject
// a tip; an unsigned or stale request is rejected before it reaches a room. The
// money already settled to the host wallet on-chain, this only drives the live
// reaction, so a `not_found` (room not hosted on this instance) loses nothing but
// the in-room flourish.
app.post('/internal/stage', express.json({ limit: '16kb' }), (req, res) => {
	const { stageId, event, tip } = req.body || {};
	const sig = req.headers['x-stage-signature'];
	const ts = req.headers['x-stage-timestamp'];
	if (typeof stageId !== 'string' || !stageId) {
		return res.status(400).json({ error: 'bad_request' });
	}
	if (!verifyStageSignature(req.body || {}, ts, sig)) {
		return res.status(401).json({ error: 'bad_signature' });
	}
	const room = getStageRoom(stageId);
	if (!room) return res.json({ ok: true, delivered: false, reason: 'not_found' });
	try {
		if (event === 'tip' && tip) {
			const result = room.injectTip(tip);
			return res.json({ ok: true, delivered: !!result?.ok });
		}
		return res.status(400).json({ error: 'unknown_event' });
	} catch (err) {
		console.error('[multiplayer] /internal/stage error:', err?.message || err);
		return res.status(500).json({ error: 'inject_failed' });
	}
});

// Live-event announcement webhook. An operator (scripts/announce-play.mjs in
// the main repo, holding the same shared secret) broadcasts a message to every
// player in every live walk_world room on this instance, optionally narrowed
// to one coin's world. Delivery rides the existing 'notice' channel, which every
// deployed client already renders as a toast (and newer clients as a banner
// when a title is present), so announcements need no client version to land.
// HMAC-signed and timestamp-bound like the other internal webhooks; an unsigned
// or stale request is rejected before it reaches a room.
app.post('/internal/announce', express.json({ limit: '16kb' }), (req, res) => {
	const sig = req.headers['x-announce-signature'];
	const ts = req.headers['x-announce-timestamp'];
	const { text, title, detail, coin, durationMs } = req.body || {};
	if (typeof text !== 'string' || !text.trim()) {
		return res.status(400).json({ error: 'bad_request' });
	}
	if (!verifyAnnounceSignature(req.body || {}, ts, sig)) {
		return res.status(401).json({ error: 'bad_signature' });
	}
	const payload = {
		kind: 'event',
		text: text.trim().slice(0, 300),
		...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 80) } : {}),
		...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim().slice(0, 200) } : {}),
		...(Number(durationMs) > 0 ? { durationMs: Math.min(120_000, Number(durationMs)) } : {}),
	};
	const rooms = liveWalkRooms(typeof coin === 'string' ? coin.trim() : '');
	let players = 0;
	for (const room of rooms) {
		try {
			room.broadcast('notice', payload);
			players += room.clients?.length || 0;
		} catch (err) {
			console.warn('[multiplayer] announce broadcast failed:', err?.message || err);
		}
	}
	console.log(`[multiplayer] event announce → ${rooms.length} room(s), ${players} player(s): ${payload.text}`);
	res.json({ ok: true, rooms: rooms.length, players });
});

// Public live population. The only aggregate this process publishes without a
// signature, and deliberately so: it is a count, never an identity. No session
// ids, no names, no wallets, no positions leave here.
//
// It reads the matchmaker's room listing (driver-backed), NOT the in-process
// walk-registry, so under horizontal scaling (REDIS_URI set) the number covers
// every instance rather than only the one that served the request. `?coin=<mint>`
// narrows to one community's worlds, which is what the /event landing page asks
// for; without it the total spans every live world.
//
// The three.ws API proxies this server-side (api/play/population.js), so no CORS
// header is emitted: a browser never calls it directly.
app.get('/population', async (req, res) => {
	const coin = typeof req.query.coin === 'string' ? req.query.coin.trim().slice(0, 128) : '';
	try {
		const listings = await matchMaker.query({ name: 'walk_world' });
		let rooms = 0;
		let players = 0;
		for (const room of listings || []) {
			if (coin && room?.coin !== coin) continue;
			rooms += 1;
			players += Number(room?.clients) || 0;
		}
		// 5s of edge/CDN caching: the number moves on a human timescale and this
		// runs on the same process that serves gameplay traffic.
		res.set('cache-control', 'public, max-age=5');
		res.json({ ok: true, coin: coin || null, rooms, players });
	} catch (err) {
		console.warn('[multiplayer] /population failed:', err?.message || err);
		res.status(503).json({ ok: false, error: 'unavailable' });
	}
});

// The IRL world (irl_world) is a presence + reaction room only, it is NOT a pin
// transport. Placed agents are private by location and reach a viewer solely via
// the per-viewer /api/irl/pins proximity read when they are physically near one,
// so there is no pin-publish webhook here: nothing fans pin coordinates into a
// room to be broadcast to every client. See rooms/IrlRoom.js.

// Admin monitor UI, exposes live room/client state, so it must NOT be open to
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
	console.log('[multiplayer] monitor mounted at /colyseus (open, dev only)');
} else {
	console.log('[multiplayer] monitor disabled (set MONITOR_USER/MONITOR_PASS to enable in prod)');
}

const httpServer = http.createServer(app);

const transport = new WebSocketTransport({
	server: httpServer,
	// Phone-tolerant liveness. Colyseus defaults to pingInterval 3000 /
	// pingMaxRetries 2, which calls `client.terminate()` after roughly SIX
	// seconds of silence. That budget is fine for a desktop tab and hostile to
	// a phone: iOS Safari suspends the whole page the instant the user switches
	// apps, locks the screen, or pulls down a notification, so the socket stops
	// answering pings and the server reaps it before they have finished reading
	// the message. Because WalkRoom.onLeave has no allowReconnection window, that
	// reap is permanent: the client rejoins with a NEW sessionId and respawns at
	// the world origin, which is exactly the reported "kicked out right after
	// joining". A terminate() is also an abrupt close with no close frame, so the
	// player gets no explanation, just a world that resets under them.
	//
	// 5s x 6 retries rides out ~30s of suspension (covering the ordinary
	// app-switch / read-a-notification round trip) while still reaping genuinely
	// dead sockets long before Cloud Run's own idle handling would.
	pingInterval: 5000,
	pingMaxRetries: 6,
	verifyClient(info, next) {
		const origin = info.req.headers.origin;
		// Origin-less upgrades (native clients / scripted probes) must NOT be a free
		// pass: a browser always sends Origin, so omitting it was a trivial way to skip
		// the allowlist entirely. The real access boundary is each room's onAuth (a
		// signed play pass / presence ticket, or a server-issued guest token), so the
		// origin allowlist is only a browser-facing CSRF-style filter. We still reject
		// origin-less handshakes in production, there is no legitimate origin-less
		// browser client, and the signed-token gate, not a spoofable header, is what
		// protects the rooms. Non-prod keeps them open for local curl/native dev probes.
		if (!origin) {
			if (!IS_PROD) return next(true);
			console.warn('[multiplayer] rejecting origin-less upgrade');
			return next(false, 403, 'origin required');
		}
		if (ALLOWED_ORIGINS.includes(origin)) return next(true);
		// Allow any Vercel preview deploy that targets the same project, these
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
// pub/sub (presence) must be shared, otherwise matchmaking on instance A can't
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
		console.error('[multiplayer] REDIS_URI set but Redis deps unavailable, staying single-instance:', err?.message);
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
// The playable Agora Commons (/agora): ONE shared city-scale square for human
// presence only, the AI-citizen NPCs and their on-chain economy are driven by
// the three.ws projection APIs, not this room. No filterBy: every visitor lands
// in the same Commons. See rooms/AgoraRoom.js for why it isn't a walk_world
// coin shard (city-scale movement clamps).
gameServer.define('agora_world', AgoraRoom);
// The IRL realtime world (D1): one room instance per precision-6 geocell, so
// every viewer standing in the same ~1 km cell shares a live mirror of the pins
// there. filterBy(['geocell']) makes joinOrCreate match only rooms for the same
// cell; the room itself mirrors a 3×3 window (centre + neighbours) so edge pins
// inside the nearby radius are never missed (see rooms/IrlRoom.js).
gameServer.define('irl_world', IrlRoom).filterBy(['geocell']);
// Coin Wars (community-vs-community battles). One arena instance per matchKey, so
// every fighter the /wars lobby hands the same matchKey lands in the same battle,
// the two coin communities, their score, and the round clock all live in that one
// room. A fighter must hold the coin they fight for (ClashRoom.onAuth verifies a
// holder pass for their declared faction). See rooms/ClashRoom.js + clash.js.
gameServer.define('clash_arena', ClashRoom).filterBy(['matchKey']);
// Living Stages (Moonshot 04). One room instance per stageId, so every audience
// member who joins a given stage lands in the same live show, the host, the
// crowd, the tip ticker, and the leaderboard all live in that one room. The room
// loads its host/title/format from /api/stage and reacts to real $THREE tips the
// API injects over /internal/stage. See rooms/StageRoom.js + src/stage.js.
gameServer.define('stage_world', StageRoom).filterBy(['stageId']);
// Shared AR Studio (/ar/studio "Shared room"). One instance per roomKey, a
// shared code or a QR-marker id, so everyone holding the same key builds one
// live scene together: placed models delta-sync and a late joiner receives the
// whole scene on join. An opted-into collaborative world (WalkRoom side of the
// privacy line), never a broadcast of private irl pins. See rooms/StudioRoom.js.
gameServer.define('studio_world', StudioRoom).filterBy(['roomKey']);

gameServer
	.listen(PORT, HOST)
	.then(() => {
		console.log(`[multiplayer] listening on ws://${HOST}:${PORT}`);
		console.log(`[multiplayer] rooms: walk_world, agora_world, irl_world, clash_arena, stage_world, studio_world`);
		console.log(`[multiplayer] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
	})
	.catch((err) => {
		console.error('[multiplayer] failed to start:', err);
		process.exit(1);
	});

// Keep the single instance alive through an isolated fault. A throw inside one
// onMessage handler, or an unawaited rejection deep in a dependency, would
// otherwise take down the whole process (min=1/max=1) and every connected
// player with it. We log loudly and keep serving, the offending message/room
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
	console.log(`[multiplayer] ${signal} received, shutting down`);
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
	// Generic per-world docs (T3): flush any room whose debounced world save hadn't
	// fired, so placed builds / gated-world state survive a redeploy.
	try {
		await worldPersistence.flushAll();
	} catch (err) {
		console.error('[multiplayer] final world flush error:', err);
	}
	// Same guarantee for player progression (Task 16): persist every account whose
	// debounced profile save hadn't landed yet, so a redeploy never resets a player.
	try {
		await flushAllPlayers();
	} catch (err) {
		console.error('[multiplayer] final player flush error:', err);
	}
	process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
