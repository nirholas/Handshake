/**
 * Agent Sniper — Pre-Launch Radar live SSE stream.
 *
 *   GET /api/sniper/radar-stream?network=mainnet
 *
 * The radar worker is a SEPARATE process, so this endpoint can't read its memory —
 * it DB-polls radar_events for rows newer than a cursor (~1.5s) and emits each as a
 * `precursor` event. Mirrors api/sniper/stream.js (Neon serverless HTTP can't hold
 * a LISTEN connection).
 *
 * Owner (session/bearer) sees full wallet addresses + whether their agent fired;
 * the public stream is anonymized (truncated addresses, no owner correlation).
 *
 * Events: open, precursor, ping, close.
 */

import { cors, method, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const NETWORKS = new Set(['mainnet', 'devnet']);

function trunc(addr) {
	if (!addr || typeof addr !== 'string' || addr.length < 10) return addr || null;
	return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// The poll cursor is a UTC timestamp string with SIX fractional digits, and
// every value that enters it is normalised to that width. Two independent
// reasons, both of which used to re-send the whole backlog on every 1.5s tick:
//
//   1. Neon hands timestamptz columns back as Date objects, and
//      `someDate > someIsoString` coerces both sides to numbers, turning the
//      string into NaN. The comparison was always false, so the cursor never
//      moved off its connect-time value.
//   2. Postgres keeps created_at to the microsecond, but a JS Date holds only
//      milliseconds. A cursor built by truncating one is strictly EARLIER than
//      the row it came from, so `created_at > cursor` stays true for that row
//      forever. This is why the query below asks Postgres for the cursor text
//      directly rather than deriving it from the parsed Date.
//
// Fixed width is what makes a plain lexicographic comparison exact here: every
// value is `YYYY-MM-DDTHH:MM:SS.ffffffZ`, so string order is time order.

/** A Date as the same fixed-width microsecond string Postgres emits. */
export function microIso(date) {
	return date.toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}

export function advanceCursor(cursor, value) {
	if (value == null) return cursor;
	const at = value instanceof Date ? microIso(value) : String(value);
	return at > cursor ? at : cursor;
}

async function resolveUserId(req) {
	try {
		const session = await getSessionUser(req);
		if (session) return session.id;
		const bearer = await authenticateBearer(extractBearer(req));
		if (bearer) return bearer.userId;
	} catch {}
	return null;
}

export default async function handleRadarStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const userId = await resolveUserId(req);
	const isOwner = !!userId;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Start from "now" so we stream only fresh precursors; the REST endpoint
	// supplies the backlog the page renders on load.
	let cursor = microIso(new Date());

	const poll = async () => {
		if (!active) return;
		try {
			const rows = await sql`
				select id, kind, trigger_wallet, new_wallet, mint, confidence,
				       watch_reason, watch_score, observed_ts, created_at,
				       to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
				from radar_events
				where network = ${network} and created_at > ${cursor}
				order by created_at asc
				limit 100
			`;
			if (!rows.length) return;

			// Owner correlation: did any of these mints get sniped by the owner's agents?
			let firedMints = new Set();
			if (isOwner) {
				const mints = rows.map((r) => r.mint).filter(Boolean);
				if (mints.length) {
					try {
						const pos = await sql`
							select distinct mint from agent_sniper_positions
							where user_id = ${userId} and network = ${network}
							  and entry_trigger = 'prelaunch_radar' and mint = any(${mints})
						`;
						firedMints = new Set(pos.map((p) => p.mint));
					} catch {}
				}
			}

			for (const r of rows) {
				send('precursor', {
					id: r.id,
					kind: r.kind,
					trigger_wallet: isOwner ? r.trigger_wallet : trunc(r.trigger_wallet),
					new_wallet: isOwner ? r.new_wallet : trunc(r.new_wallet),
					mint: r.mint,
					confidence: Number(r.confidence),
					watch_reason: r.watch_reason,
					watch_score: r.watch_score != null ? Number(r.watch_score) : null,
					observed_ts: r.observed_ts,
					at: r.created_at,
					fired: isOwner ? firedMints.has(r.mint) : undefined,
				});
				cursor = advanceCursor(cursor, r.cursor_at);
			}
		} catch {
			send('error', { message: 'poll_failed' });
		}
	};

	send('open', { network, source: 'prelaunch-radar', owner: isOwner });
	const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
	const ping = setInterval(() => send('ping', { t: Date.now() }), PING_INTERVAL_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(ping);
		clearTimeout(durationTimer);
		try { res.end(); } catch {}
	};
	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, MAX_DURATION_MS);

	req.on('close', teardown);
}
