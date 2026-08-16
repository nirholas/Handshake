// GET /api/feed-stream — Server-Sent Events for the live activity ticker.
//
// The widget (public/feed.js) does one fast GET /api/feed for first paint, then
// opens this stream. Every event produced anywhere on the platform (see
// api/_lib/feed.js) lands in the capped Redis list `feed:events`; this handler
// tails that list and pushes only the events that appear AFTER the client
// connected, so new activity reaches an open tab within one poll tick instead
// of the 20s the bare poll path settles for.
//
// Why poll Redis instead of native pub/sub? The Upstash REST client this repo
// uses has no long-lived SUBSCRIBE; a cheap LRANGE of the list head (one
// command, deduped by event id) survives Vercel's stateless model.
//
// ── Quota discipline (this is why the poller is shared) ──────────────────────
// Vercel runs each SSE connection in its own function invocation, but multiple
// concurrent connections frequently land on the SAME warm instance. A naive
// per-connection poll loop therefore multiplies Redis reads by the open-tab
// count — and at a 1.5s tick a SINGLE always-open tab alone issues ~1.7M reads
// a month, blowing the 500k Upstash quota on its own (it did: the feed-stream
// poll storm on 2026-06-12). Two mechanisms keep the burn bounded:
//   1. One poll loop PER INSTANCE, fanned out to every client connected to it —
//      N concurrent tabs on a warm instance now cost one Redis read per tick,
//      not N. This is the fan-out the file always claimed but never had.
//   2. Adaptive cadence: poll fast right after activity, then ramp the interval
//      up while the feed is idle (which it mostly is). An idle instance settles
//      to one read every POLL_MS_MAX, cutting steady-state burn by ~7x.
// A circuit breaker (below) caps the damage if the quota is exhausted anyway:
// on the Upstash "max requests" error we stop polling instance-wide for a
// cooldown and degrade to heartbeats, so we never spam the error log or pile
// load onto a dead quota.
//
// Vercel: registered with maxDuration 300 in vercel.json so the connection can
// stay open up to the Hobby ceiling; we send a `retry` directive and close just
// before the hard timeout, and EventSource reconnects automatically.

import { cors, method } from './_lib/http.js';
import { getRedis as _getSharedRedis, isRedisAuthError } from './_lib/redis.js';

const FEED_KEY = 'feed:events';
const HEARTBEAT_MS = 15_000;
const POLL_MS_MIN = 2_000; // fast cadence right after activity
const POLL_MS_MAX = 15_000; // idle ceiling — feed is idle most of the time
const IDLE_TICKS_BEFORE_RAMP = 4; // empty polls tolerated before we slow down
const HEAD_N = 30; // how far back we scan each tick for unseen events
const BREAKER_COOLDOWN_MS = 60_000; // pause polling this long after a quota error
const MAX_DURATION_MS = 275_000; // close before Vercel's 300s hard timeout

function redis() { return _getSharedRedis(); }

function parseRow(row) {
	if (row && typeof row === 'object') return row; // Upstash auto-deserializes
	if (typeof row !== 'string') return null;
	try { return JSON.parse(row); } catch { return null; }
}

function isQuotaError(err) {
	const m = (err && (err.message || String(err))) || '';
	return /max requests limit exceeded|quota|429/i.test(m);
}

// ── Per-instance shared poller ───────────────────────────────────────────────
// All SSE connections served by one warm Lambda share this single loop. Each
// connection registers an `(event) => void` listener; the loop reads Redis once
// per tick and fans every fresh event out to all of them.
const listeners = new Set();
let sharedClient = null;
let pollTimer = null;
let seen = new Set();
let primed = false; // snapshot the backlog on the first poll, don't replay it
let polling = false;
let currentDelay = POLL_MS_MIN;
let idleTicks = 0;
let breakerUntil = 0; // epoch ms; while now < this, skip Redis entirely
let breakerLogged = false; // log the quota trip once, not every tick

function resetSharedState() {
	if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
	seen = new Set();
	primed = false;
	polling = false;
	currentDelay = POLL_MS_MIN;
	idleTicks = 0;
	breakerUntil = 0;
	breakerLogged = false;
	sharedClient = null;
}

function scheduleNextPoll() {
	if (pollTimer) clearTimeout(pollTimer);
	if (listeners.size === 0) { pollTimer = null; return; }
	pollTimer = setTimeout(runPoll, currentDelay);
}

async function runPoll() {
	pollTimer = null;
	if (listeners.size === 0) return;
	if (polling) { scheduleNextPoll(); return; }

	const now = Date.now();
	if (now < breakerUntil) { scheduleNextPoll(); return; } // cooling down

	polling = true;
	try {
		const rows = await sharedClient.lrange(FEED_KEY, 0, HEAD_N - 1);
		breakerLogged = false; // a successful read clears the trip state
		const fresh = [];
		for (const row of rows || []) {
			const obj = parseRow(row);
			if (!obj || !obj.id) continue;
			if (!seen.has(obj.id)) {
				seen.add(obj.id);
				if (primed) fresh.push(obj); // skip the initial backlog
			}
		}
		primed = true;

		if (fresh.length) {
			// List is newest-first; emit oldest→newest so the client prepends in order.
			for (let i = fresh.length - 1; i >= 0; i--) {
				const evt = fresh[i];
				for (const listener of listeners) {
					try { listener(evt); } catch { /* a dead socket — its own cleanup will unregister it */ }
				}
			}
			currentDelay = POLL_MS_MIN; // activity → speed back up
			idleTicks = 0;
		} else {
			// Idle: ramp the interval up toward the ceiling to spare the quota.
			if (++idleTicks >= IDLE_TICKS_BEFORE_RAMP) {
				currentDelay = Math.min(POLL_MS_MAX, currentDelay * 2);
			}
		}

		// Bound the seen-set so a long-lived instance can't grow it unbounded.
		if (seen.size > HEAD_N * 8) {
			const keep = (rows || []).map(parseRow).filter(Boolean).map((o) => o.id);
			seen = new Set();
			for (const id of keep) if (id) seen.add(id);
		}
	} catch (err) {
		if (isQuotaError(err)) {
			breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
			if (!breakerLogged) {
				console.error('[feed-stream] Redis quota exhausted — pausing poll for', BREAKER_COOLDOWN_MS, 'ms');
				breakerLogged = true;
			}
		} else if (err?.circuitOpen || isRedisAuthError(err)) {
			// Invalid/stale UPSTASH_REDIS_REST_TOKEN — a config failure the shared auth
			// breaker (api/_lib/redis.js) already logged once and is fast-failing. Pause
			// the poll on the same back-off as a quota trip and log once, rather than
			// emitting a poll-failed line every tick across every warm SSE Lambda.
			breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
			if (!breakerLogged) {
				console.error('[feed-stream] Redis auth failure (invalid/stale token) — pausing poll for', BREAKER_COOLDOWN_MS, 'ms');
				breakerLogged = true;
			}
		} else {
			console.error('[feed-stream] poll failed', err?.message || err);
		}
	} finally {
		polling = false;
		scheduleNextPoll();
	}
}

function addListener(client, fn) {
	if (!sharedClient) sharedClient = client; // first connection on this instance wins
	listeners.add(fn);
	if (!pollTimer && !polling) {
		currentDelay = POLL_MS_MIN; // a new subscriber wants prompt updates
		idleTicks = 0;
		scheduleNextPoll();
	}
}

function removeListener(fn) {
	listeners.delete(fn);
	// Last client gone: tear the loop down and reset so the next connection
	// re-primes (snapshots the head) instead of replaying stale backlog.
	if (listeners.size === 0) resetSharedState();
}

export default async function handleFeedStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		// Vercel's edge gateway buffers responses by default; without this it holds
		// SSE frames until the function returns, defeating the stream.
		'X-Accel-Buffering': 'no',
	});

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	const r = redis();
	send('hello', { ts: Date.now() });

	// No Redis configured (e.g. local dev): keep the socket alive with heartbeats
	// so the client's fallback poll path still runs, but emit nothing.
	if (!r) {
		const hb = setInterval(() => {
			if (closed || res.writableEnded) { clearInterval(hb); return; }
			res.write(':hb\n\n');
		}, HEARTBEAT_MS);
		const stop = () => { closed = true; clearInterval(hb); try { res.end(); } catch {} };
		req.on('close', stop); res.on('close', stop);
		return;
	}

	// Register with the shared per-instance poller; it fans fresh events to us.
	const onEvent = (obj) => send('event', obj);
	addListener(r, onEvent);

	const startMs = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		if (Date.now() - startMs > MAX_DURATION_MS) {
			res.write('retry: 1000\n\n');
			cleanup();
			return;
		}
		res.write(':hb\n\n');
	}, HEARTBEAT_MS);

	function cleanup() {
		if (closed) return;
		closed = true;
		removeListener(onEvent);
		clearInterval(heartbeat);
		if (!res.writableEnded) { try { res.end(); } catch { /* torn down */ } }
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
}
