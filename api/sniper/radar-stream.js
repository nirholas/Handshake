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

/**
 * Advance the poll cursor past a row's timestamp.
 *
 * The cursor is an ISO string because that is what the query binds, but Neon
 * hands timestamptz columns back as Date objects. `someDate > someIsoString`
 * coerces BOTH sides to numbers, the string becomes NaN, and the comparison is
 * always false, so the cursor froze at connect time and every 1.5s poll
 * re-emitted the whole backlog it had already sent. Normalising to ISO text
 * makes the comparison lexicographic and correct (both sides are UTC, same
 * width), and keeps the cursor in the exact form the next query needs.
 */
export function advanceCursor(cursor, value) {
	if (value == null) return cursor;
	const at = value instanceof Date ? value.toISOString() : String(value);
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
	let cursor = new Date().toISOString();

	const poll = async () => {
		if (!active) return;
		try {
			const rows = await sql`
				select id, kind, trigger_wallet, new_wallet, mint, confidence,
				       watch_reason, watch_score, observed_ts, created_at
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
				cursor = advanceCursor(cursor, r.created_at);
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
