// GET /api/home/:id/stream: the live home, as Server-Sent Events.
//
// Events:
//   graph      the room graph, on open and on every coalesced rebuild
//   status     { status, connected, stale, detail } on open, disconnect, reconnect
//   heartbeat  every 25 s, because idle proxies close silent streams
//
// Four properties this handler exists to guarantee, each of which was a bug
// somewhere before it was a rule:
//
//   1. The first `graph` is sent IMMEDIATELY on open, from whatever the pooled
//      socket already holds. A 3D home that paints only once somebody happens to
//      flip a light is not a live view, it is a blank screen with a promise.
//   2. The graph is never emptied. When the house drops, the last good graph
//      stays and a `status` event marks it stale. The user watches their home go
//      grey; they do not watch it vanish.
//   3. `req.on('close')` unsubscribes and releases the pooled reference. A leaked
//      reference pins a stranger's house open forever, because the idle evictor
//      only touches entries whose refcount has reached zero.
//   4. Two streams on the same home share ONE socket. The pool is keyed by home,
//      so a second subscriber is a second listener on the first connection and
//      never a second WebSocket into somebody's house.
//
// Buffering: `x-accel-buffering: no` and `cache-control: no-store` are load
// bearing in front of a CDN and a reverse proxy. Without them the edge holds
// frames until the response ends, which for a stream is never, and the page
// looks hung while the server believes it is delivering.

import { resolveHomeAccess } from '../../_lib/home/access.js';
import { toHomeFailure } from '../../_lib/home/errors.js';
import { subscribe } from '../../_lib/home/runtime.js';
import { cors, error, method, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** Under the 30 s most proxies use as an idle read timeout, with room to spare. */
const HEARTBEAT_MS = 25_000;
/** Cloud Run's request ceiling is an hour; close first and let EventSource reconnect. */
const MAX_DURATION_MS = 55 * 60_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id);
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	const rl = await limits.homeStream(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many stream connections, slow down');

	let closed = false;
	let flowing = false;
	/** The event `subscribe` delivers synchronously, before the head exists. */
	let pending = null;

	const emit = (event) => {
		if (!flowing) {
			// Held, not dropped. The runtime hands the current state to a new
			// subscriber the instant it registers, which is BEFORE this handler knows
			// the subscription succeeded and therefore before it may write a 200. The
			// only correct thing to do with that first frame is keep it and flush it
			// once the stream is open. Dropping it is what makes a page wait for a
			// light to change before it paints.
			pending = event;
			return;
		}
		deliver(event);
	};

	let unsubscribe;
	try {
		unsubscribe = await subscribe(home.id, caller.userId, emit);
	} catch (err) {
		// Still a normal HTTP response: nothing has been written yet, so a house
		// that is offline answers with a coded status the connect UI can render
		// rather than a 200 that opens a stream and then says nothing.
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;
		return error(res, shaped.status, shaped.code, shaped.message, {
			code: shaped.code,
			message: shaped.message,
			...(shaped.detailCode ? { detail_code: shaped.detailCode } : {}),
		});
	}

	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store, no-transform',
		connection: 'keep-alive',
		// Without this the CDN and Cloud Run's own proxy buffer the body until the
		// response ends, which for a stream never happens.
		'x-accel-buffering': 'no',
	});

	flowing = true;
	if (pending) {
		const first = pending;
		pending = null;
		deliver(first);
	}

	const startedAt = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		if (Date.now() - startedAt > MAX_DURATION_MS) {
			// Tell EventSource to come straight back, rather than letting the platform
			// cut the socket and leave the client guessing why.
			write('retry: 1000\n\n');
			cleanup();
			return;
		}
		send('heartbeat', { at: Date.now() });
	}, HEARTBEAT_MS);

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);

	// ── frame plumbing ───────────────────────────────────────────────────────

	/**
	 * One runtime event, split into the two events a client actually wants.
	 *
	 * The runtime reports connectivity and the room graph in one shape. A client
	 * watching for a dropped house should not have to diff a whole graph to find
	 * it, and a client redrawing a 3D scene should not redraw it because a
	 * heartbeat arrived, so the split happens here and each half is sent only when
	 * that half changed.
	 */
	let lastStatusKey = null;
	let lastGraph = null;
	function deliver(event) {
		const statusKey = `${event.status}|${event.stale}|${event.connected}`;
		if (statusKey !== lastStatusKey) {
			lastStatusKey = statusKey;
			send('status', {
				status: event.status,
				connected: Boolean(event.connected),
				stale: Boolean(event.stale),
				detail: event.stale
					? 'Lost the connection to your home. This is the last state three.ws saw.'
					: null,
			});
		}
		// Identity comparison, not deep equality: the bridge rebuilds the graph into
		// a new object on every coalesced burst, so a new reference IS the signal
		// that something in the house changed. Comparing by value here would cost a
		// full walk of every entity on every burst to learn what the reference
		// already said.
		if (event.graph && event.graph !== lastGraph) {
			lastGraph = event.graph;
			send('graph', { graph: event.graph, stale: Boolean(event.stale), at: Date.now() });
		}
	}

	function send(name, data) {
		write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	function write(frame) {
		if (closed || res.writableEnded) return;
		try {
			res.write(frame);
		} catch {
			// The client vanished between the check and the write.
			cleanup();
		}
	}

	function cleanup() {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		// Releases the pooled reference. Without this the entry never reaches a
		// refcount of zero and the idle evictor can never close it.
		try {
			unsubscribe();
		} catch {
			// Unsubscribing twice, or after the pool already dropped the entry, is
			// the normal shape of a torn-down stream and not an error.
		}
		if (!res.writableEnded) {
			try {
				res.end();
			} catch {
				// Already torn down by the transport.
			}
		}
	}
});
