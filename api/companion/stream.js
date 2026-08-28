// GET /api/companion/stream - live deliveries, as Server-Sent Events.
//
// This is the socket the bodies listen on: the /companion stage, the desktop
// companion (apps/desktop), a browser extension, or anything built with
// @three-ws/companion. A delivery reaches every connected body within a poll
// tick of being triaged, so the character on your desktop turns around and
// speaks at the same moment the phone buzzes.
//
// Auth, two ways, because the clients are different animals:
//   • a session cookie, for the page and any first-party surface;
//   • the bridge token (Authorization: Bearer), for the desktop app, a CLI, a
//     Raspberry Pi in the hallway. One credential per user, rotatable from
//     /companion, and the same one the ingest endpoint accepts.
//
// Only events at or above the user's own threshold are streamed: the feed on
// the page is where quiet ones live. `?since=<iso>` replays anything delivered
// after that instant (bounded), which is how a laptop that was asleep catches
// up without repeating a week of messages.
//
// Cost shape: one poll loop per connection, but the query is a single indexed
// read of one user's own rows, and the cadence ramps from 2s to 15s while the
// user's world is quiet, so an idle desktop app costs about four reads a minute.

import { sql } from '../_lib/db.js';
import { cors, method } from '../_lib/http.js';
import { getSessionUser, extractBearer } from '../_lib/auth.js';
import { userForIngestToken, getSettings } from '../_lib/companion/store.js';

export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;
const POLL_MS_MIN = 2_000;
const POLL_MS_MAX = 15_000;
const IDLE_RAMP_AFTER = 5;
const MAX_ROWS_PER_TICK = 20;
// A client that has been away replays at most this far back, so a machine that
// slept for a week wakes to what is still relevant rather than to a monologue.
const MAX_REPLAY_MS = 6 * 60 * 60 * 1000;

const SSE_HEADERS = {
	'Content-Type': 'text/event-stream; charset=utf-8',
	'Cache-Control': 'no-cache, no-transform',
	Connection: 'keep-alive',
	// Cloud Run and the CDN in front of it buffer by default; without this the
	// frames are held until the function returns, which defeats the stream.
	'X-Accel-Buffering': 'no',
};

async function resolveViewer(req) {
	const bearer = extractBearer(req);
	if (bearer) {
		const settings = await userForIngestToken(bearer);
		if (settings) return { userId: settings.user_id, settings, via: 'bridge_token' };
		return null;
	}
	const user = await getSessionUser(req);
	if (!user) return null;
	return { userId: user.id, settings: await getSettings(user.id), via: 'session' };
}

function pollDelay(idleTicks) {
	if (idleTicks <= IDLE_RAMP_AFTER) return POLL_MS_MIN;
	return Math.min(Math.round(POLL_MS_MIN * Math.pow(1.5, idleTicks - IDLE_RAMP_AFTER)), POLL_MS_MAX);
}

export default async function handleCompanionStream(req, res) {
	const isHead = (req.method || 'GET').toUpperCase() === 'HEAD';
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	if (isHead) {
		res.writeHead(200, SSE_HEADERS);
		res.end();
		return;
	}

	const viewer = await resolveViewer(req);
	if (!viewer) {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized', message: 'sign in, or send your bridge token as a Bearer header' }));
		return;
	}

	const params = new URL(req.url, 'http://x').searchParams;
	const sinceRaw = params.get('since');
	const floor = new Date(Date.now() - MAX_REPLAY_MS);
	let cursor = sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
		? new Date(Math.max(Date.parse(sinceRaw), floor.getTime()))
		: new Date();
	let cursorId = '';

	res.writeHead(200, SSE_HEADERS);

	let closed = false;
	const send = (event, data) => {
		if (closed || res.writableEnded) return;
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	send('hello', {
		ts: Date.now(),
		via: viewer.via,
		threshold: viewer.settings.threshold,
		enabled: viewer.settings.enabled,
		default_avatar_glb_url: viewer.settings.avatar_glb_url,
		default_voice: viewer.settings.voice,
	});

	let idleTicks = 0;
	let timer = null;

	const tick = async () => {
		if (closed) return;
		try {
			const rows = await sql`
				select e.id, e.source_kind, e.sender, e.sender_id, e.title, e.body, e.url,
				       e.importance, e.reason, e.spoken_line, e.occurs_at, e.created_at,
				       c.display_name as contact_name, c.avatar_glb_url as contact_avatar_glb_url,
				       c.avatar_image_url as contact_avatar_image_url, c.voice as contact_voice
				from companion_events e
				left join companion_contacts c on c.id = e.contact_id
				where e.user_id = ${viewer.userId}
				  and e.dismissed_at is null
				  and e.importance >= ${viewer.settings.threshold}
				  and (e.created_at, e.id::text) > (${cursor.toISOString()}::timestamptz, ${cursorId})
				order by e.created_at asc, e.id::text asc
				limit ${MAX_ROWS_PER_TICK}
			`;
			if (rows.length) {
				idleTicks = 0;
				const last = rows[rows.length - 1];
				cursor = last.created_at instanceof Date ? last.created_at : new Date(last.created_at);
				cursorId = String(last.id);
				for (const row of rows) {
					send('delivery', {
						...row,
						// What to perform with, resolved server-side so every client
						// (page, desktop, extension) stages the same body and voice.
						avatar_glb_url: row.contact_avatar_glb_url || viewer.settings.avatar_glb_url || null,
						voice: row.contact_voice || viewer.settings.voice || null,
						speaker: row.contact_name || row.sender || 'Your companion',
					});
				}
			} else {
				idleTicks += 1;
			}
		} catch (err) {
			// A transient DB error must not kill a long-lived connection: report it
			// on the stream and keep polling. The client decides whether to care.
			send('warning', { message: String(err?.message || err).slice(0, 200) });
		}
		if (!closed) timer = setTimeout(tick, pollDelay(idleTicks));
	};

	timer = setTimeout(tick, 250);

	const startMs = Date.now();
	const heartbeat = setInterval(() => {
		if (closed || res.writableEnded) return;
		// Retire before the platform's hard timeout, telling the client to come
		// straight back. EventSource honours `retry:` on its own.
		if (Date.now() - startMs > 275_000) {
			res.write('retry: 1000\n\n');
			cleanup();
			return;
		}
		res.write(':hb\n\n');
	}, HEARTBEAT_MS);

	function cleanup() {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		clearInterval(heartbeat);
		if (!res.writableEnded) {
			try {
				res.end();
			} catch {
				/* socket already torn down */
			}
		}
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('close', cleanup);
	res.on('error', cleanup);
}
