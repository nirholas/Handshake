// GET /api/club/tips/stream: Server-Sent Events
//
// Tails the club_tips table and pushes every new row as a `tip` event. The
// /club page subscribes on boot so two simultaneous visitors see each other's
// tips within one poll cadence.
//
// ── Shared-instance poll loop ────────────────────────────────────────────────
// The original implementation created one setInterval per connection. N open
// tabs → N × 800ms Neon queries. With a shared module-level poll loop, N tabs
// on the same warm Vercel instance share exactly ONE Neon round-trip per tick,
// and the tick fans the results out to every listener. Cost stays at O(1) per
// instance regardless of connection count.
//
// ── Adaptive cadence ─────────────────────────────────────────────────────────
// Tips are bursty: seconds of frenetic activity, then long silences. After
// IDLE_RAMP_AFTER consecutive empty polls the interval ramps from POLL_MS_MIN
// (800ms) up to POLL_MS_MAX (5s). Any tip row immediately resets the interval
// back to fast. This cuts steady-state Neon reads by ~6× vs fixed 800ms polling.
//
// Vercel: maxDuration: 300 in vercel.json lets the connection stay open up to
// 5 minutes; the EventSource client reconnects automatically after disconnect.

import { sql } from '../_lib/db.js';
import { cors, method } from '../_lib/http.js';

// ── Per-instance shared poll state ───────────────────────────────────────────
// Each registered listener is a function: (event, data) => void.
const clients = new Set();
let pollTimer = null;
// Compound cursor (created_at, ticket_id). A plain `created_at >` cursor drops
// tips that share an identical timestamp at the LIMIT boundary, realistic under
// the bursts this stream exists for. The unique ticket_id breaks ties so the
// cursor is strictly monotonic and lossless. Empty id sorts before any ticket.
let sharedCursor = new Date();
let sharedCursorId = '';
let idleTicks = 0;

const HEARTBEAT_MS = 15_000;
const POLL_MS_MIN = 800;
const POLL_MS_MAX = 5_000;
const IDLE_RAMP_AFTER = 4;  // consecutive empty ticks before slowing down
const MAX_ROWS_PER_TICK = 50;

function currentPollDelay() {
	if (idleTicks <= IDLE_RAMP_AFTER) return POLL_MS_MIN;
	const rampFactor = Math.pow(1.6, idleTicks - IDLE_RAMP_AFTER);
	return Math.min(Math.round(POLL_MS_MIN * rampFactor), POLL_MS_MAX);
}

async function runSharedPoll() {
	if (clients.size === 0) {
		pollTimer = null;
		return;
	}
	try {
		const rows = await sql`
			select ticket_id, dancer, dance, clip, label, payer, network,
			       amount_atomics, asset, started_at, ends_at, created_at
			from club_tips
			where (created_at, ticket_id) > (${sharedCursor.toISOString()}::timestamptz, ${sharedCursorId})
			order by created_at asc, ticket_id asc
			limit ${MAX_ROWS_PER_TICK}
		`;
		if (rows.length > 0) {
			idleTicks = 0;
			// Rows are ordered by (created_at, ticket_id); advance the cursor to the
			// last one so a same-timestamp tie split across batches isn't skipped.
			const last = rows[rows.length - 1];
			sharedCursor = last.created_at instanceof Date ? last.created_at : new Date(last.created_at);
			sharedCursorId = last.ticket_id;
			// Fan out to all connected clients.
			for (const send of clients) {
				for (const row of rows) {
					send('tip', row);
				}
			}
		} else {
			idleTicks++;
		}
	} catch (err) {
		console.error('[club-tips-stream] poll failed', err?.message || err);
	}
	pollTimer = setTimeout(runSharedPoll, currentPollDelay());
}

function ensureSharedPoll() {
	if (pollTimer) return;
	// Cold start: the loop stopped when the last listener left, so the cursor is
	// pinned to that moment. Rewind it to now before the first tick, or a room
	// that went quiet for a while replays everything banked during the gap (up to
	// MAX_ROWS_PER_TICK of it) into the first viewer back as if it were live.
	// Resetting idleTicks with it also puts that viewer on the fast cadence
	// instead of the 5s one the previous idle ramp had settled into.
	sharedCursor = new Date();
	sharedCursorId = '';
	idleTicks = 0;
	pollTimer = setTimeout(runSharedPoll, POLL_MS_MIN);
}

const SSE_HEADERS = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache, no-transform',
	'Connection': 'keep-alive',
	// Critical: Vercel's edge gateway buffers responses by default; without
	// this header SSE frames are held until the function returns, defeating the stream.
	'X-Accel-Buffering': 'no',
};

// ── Per-connection handler ────────────────────────────────────────────────────
export default async function handleTipsStream(req, res) {
	// Capture the verb before method() normalizes a HEAD probe to GET for dispatch.
	const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// A HEAD asks for the headers this GET would answer with, not the stream
	// itself, and a HEAD response can never carry a body anyway. Answer and end.
	// Opening a real stream for one (api/ops/health.js probes this endpoint that
	// way on every sweep) registered a listener that nothing would ever close, so
	// each probe parked a client slot and a heartbeat timer until the 275s
	// graceful shutdown finally reclaimed them.
	if (isHead) {
		res.writeHead(200, SSE_HEADERS);
		res.end();
		return;
	}

	res.writeHead(200, SSE_HEADERS);

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	send('hello', { ts: Date.now() });

	clients.add(send);
	ensureSharedPoll();

	const startMs = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		// Graceful shutdown before Vercel's 300s hard timeout.
		if (Date.now() - startMs > 275_000) {
			res.write('retry: 1000\n\n');
			cleanup();
			return;
		}
		res.write(':hb\n\n');
	}, HEARTBEAT_MS);

	const cleanup = () => {
		if (closed) return;
		closed = true;
		clients.delete(send);
		clearInterval(heartbeat);
		if (!res.writableEnded) {
			try { res.end(); } catch { /* socket already torn down */ }
		}
	};

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
}
