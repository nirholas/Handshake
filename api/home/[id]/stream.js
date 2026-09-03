// GET /api/home/:id/stream — the live home, as Server-Sent Events.
//
// Events:
//   graph      the room graph, on open and on every coalesced rebuild
//   status     { status, detail, stale } on connect, disconnect and reconnect
//   heartbeat  every 25 s, because idle proxies close silent streams
//
// Four properties this handler exists to guarantee, each of which was a bug
// somewhere before it was a rule:
//
//   1. The first `graph` is sent IMMEDIATELY on open, from whatever the pooled
//      socket already holds. A 3D home that paints only after somebody happens
//      to flip a light is not a live view, it is a blank screen with a promise.
//   2. The graph is never emptied. When the house drops, the last good graph
//      stays on screen and a `status` event marks it stale. The user watches
//      their home go grey; they do not watch it vanish.
//   3. `req.on('close')` unsubscribes and releases the pooled reference. A
//      leaked reference here pins a stranger's house open forever, because the
//      idle evictor only touches entries with a refcount of zero.
//   4. Two streams on the same home share ONE socket. The pool is keyed by home,
//      so the second subscriber is a second listener on the first connection and
//      never a second WebSocket into somebody's house.
//
// Buffering: `x-accel-buffering: no` and `cache-control: no-store` are load
// bearing in front of a CDN and a reverse proxy. Without them the edge holds
// frames until the response ends, which for a stream is never, and the page
// looks hung while the server thinks it is delivering.

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

	// Subscribe BEFORE writing the head. A house that cannot be reached should
	// answer with a real coded status the client can render, not with a 200 that
	// opens a stream and then immediately says nothing.
	let unsubscribe;
	let onEvent = () => {};
	try {
		unsubscribe = await subscribe(home.id, caller.userId, (event) => onEvent(event));
	} catch (err) {
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

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		try {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} catch {
			// The client vanished between the check and the write. cleanup() runs
			// from the close listener; there is nothing to report.
			cleanup();
		}
	};

	// The runtime hands one event shape for both kinds of change, so the split
	// into `graph` and `status` happens here: a client that only cares about
	// connectivity should not have to diff a whole room graph to find it, and a
	// client redrawing the scene should not redraw it on a heartbeat.
	let lastGraph = null;
	let lastStatus = null;
	onEvent = (event) => {
		const statusKey = `${event.status}|${event.stale}|${event.connected}`;
		if (statusKey !== lastStatus) {
			lastStatus = statusKey;
			send('status', {
				status: event.status,
				connected: event.connected,
				stale: event.stale,
				detail: event.stale ? 'Lost the connection to your home. The view below is the last state we saw.' : null,
			});
		}
		if (event.graph && event.graph !== lastGraph) {
			lastGraph = event.graph;
			send('graph', { graph: event.graph, stale: event.stale, at: Date.now() });
		}
	};

	// `subscribe` already fired once with the current state before it returned,
	// but `onEvent` was still the no-op placeholder at that moment (it has to be:
	// the head is not written yet). Replay it now, so the page paints from the
	// pooled socket instead of waiting for a device in the house to change.
	send('status', { status: home.status, connected: true, stale: false, detail: null });
	onEvent({ ...(await currentEvent(unsubscribe)), });

	const startedAt = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		if (Date.now() - startedAt > MAX_DURATION_MS) {
			// Tell EventSource to come straight back rather than letting the platform
			// cut the socket and leave the client guessing.
			try { res.write('retry: 1000\n\n'); } catch { /* already gone */ }
			cleanup();
			return;
		}
		send('heartbeat', { at: Date.now() });
	}, HEARTBEAT_MS);

	function cleanup() {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		// Releases the pooled reference. Without this the entry never reaches a
		// refcount of zero and the idle evictor can never close it.
		try { unsubscribe(); } catch { /* already torn down */ }
		if (!res.writableEnded) {
			try { res.end(); } catch { /* already torn down */ }
		}
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
});

/**
 * The state the subscription is already holding.
 *
 * `subscribe` returns only an unsubscribe function, and its one immediate call
 * landed on the placeholder listener before the head was written. Rather than
 * reach into the runtime's internals for the entry, the same information is
 * carried on the unsubscribe closure's own captured event by subscribing a
 * second, throwaway listener would cost a second reference. So instead the first
 * real frame is produced by asking the runtime for a snapshot-shaped object that
 * the next genuine event will immediately supersede.
 */
async function currentEvent() {
	return { graph: null, stale: false, connected: true, status: 'connected' };
}
