// GET /api/club/tips/stream  — Server-Sent Events
//
// Tails the club_tips table and pushes every new row as a `tip` event. The
// /club page subscribes on boot so two simultaneous visitors see each other's
// tips within one poll cadence.
//
// Why poll instead of LISTEN/NOTIFY? The Neon HTTP driver this repo uses
// (api/_lib/db.js) doesn't expose LISTEN/NOTIFY. An 800 ms poll on an
// indexed `created_at > $cursor` query is cheap (Neon: one connection,
// micro-query) and survives Vercel's stateless function model.
//
// Vercel: this route needs `maxDuration: 300` in vercel.json so the
// connection can stay open up to 5 minutes (Hobby plan ceiling); the
// EventSource client reconnects automatically after disconnect.

import { sql } from '../_lib/db.js';
import { cors, method } from '../_lib/http.js';

const HEARTBEAT_MS = 15_000;
const POLL_MS = 800;
const MAX_ROWS_PER_TICK = 50;

export default async function handleTipsStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		// Critical: Vercel's edge gateway buffers responses by default; without
		// this header SSE frames are held until the function returns, which
		// defeats the entire stream.
		'X-Accel-Buffering': 'no',
	});

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	// Initial frame so the client's `onopen` analogue fires immediately.
	send('hello', { ts: Date.now() });

	const startMs = Date.now();
	let cursor = new Date();
	let polling = false;

	const tick = async () => {
		if (closed || polling) return;
		polling = true;
		try {
			const rows = await sql`
				select ticket_id, dancer, dance, clip, label, payer, network,
				       amount_atomics, asset, started_at, ends_at, created_at
				from club_tips
				where created_at > ${cursor.toISOString()}
				order by created_at asc
				limit ${MAX_ROWS_PER_TICK}
			`;
			for (const row of rows) {
				const ts = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
				if (ts > cursor) cursor = ts;
				send('tip', row);
			}
		} catch (err) {
			console.error('[club-tips-stream] poll failed', err?.message || err);
		} finally {
			polling = false;
		}
	};

	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		// Graceful shutdown before Vercel's 300s hard timeout.
		// Send retry directive so the client auto-reconnects within 1s.
		if (Date.now() - startMs > 275_000) {
			res.write('retry: 1000\n\n');
			cleanup();
			return;
		}
		res.write(':hb\n\n');
	}, HEARTBEAT_MS);

	const poll = setInterval(tick, POLL_MS);

	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		clearInterval(poll);
		if (!res.writableEnded) {
			try { res.end(); } catch { /* socket already torn down */ }
		}
	};

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
}
