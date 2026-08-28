// GET /api/herald/stream: the live end of the delivery rail (SSE).
//
// The browser subscribes; POST /api/herald/announce writes; this drains the
// caller's queue and emits each line as an `announce` event. @three-ws/herald's
// railSource() consumes it, but it is plain SSE: `new EventSource()` in any
// page, or `curl -N`, works exactly as well.
//
// Events:
//   event: open      { ts }                  once, on connect
//   event: announce  { id, text, ... }       one per queued line
//   event: ping      { ts }                  keepalive every 15s
//
// Session-cookie auth only, and it only ever reads the caller's own queue: a
// stream cannot be pointed at another account, and an API key (which can write)
// deliberately cannot read this. Writing is for machines, listening is for the
// person sitting in front of the browser.
//
// The connection is capped below the platform's request ceiling and EventSource
// reconnects on its own, so a long-lived page keeps hearing without any
// reconnect logic of its own.

import { cors, error, method, rateLimited, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { limits } from '../_lib/rate-limit.js';
import { getRedis } from '../_lib/redis.js';
import { queueKey, parseRecord } from '../_lib/herald.js';

export const maxDuration = 300;

const MAX_DURATION_MS = 280_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;
const DRAIN_BATCH = 10;

export default wrap(async function handleHeraldStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.heraldStream(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const redis = getRedis();
	if (!redis) {
		return error(res, 503, 'service_unavailable', 'the delivery rail is not available right now');
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active || res.writableEnded) return;
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} catch {
			active = false;
		}
	};

	req.on('close', () => {
		active = false;
	});

	send('open', { ts: Date.now() });

	const key = queueKey(user.id);
	const started = Date.now();
	let lastPing = started;

	// LPOP with a count drains what is waiting and leaves nothing behind for a
	// second tab to say again: a message is delivered to exactly one live
	// surface, which is the whole difference between this and a broadcast.
	while (active && Date.now() - started < MAX_DURATION_MS) {
		let batch = [];
		try {
			const popped = await redis.lpop(key, DRAIN_BATCH);
			batch = Array.isArray(popped) ? popped : popped ? [popped] : [];
		} catch (err) {
			// A transient Redis fault must not kill a stream the page depends on;
			// keep the connection and try again on the next tick.
			console.error('[herald] queue read failed:', err.message);
			batch = [];
		}

		for (const raw of batch) {
			const record = parseRecord(raw);
			if (record) send('announce', record);
		}

		if (Date.now() - lastPing >= PING_INTERVAL_MS) {
			lastPing = Date.now();
			send('ping', { ts: lastPing });
		}

		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	if (!res.writableEnded) res.end();
});
