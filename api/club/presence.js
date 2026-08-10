// POST /api/club/presence  { session } -> { count, counted }
//
// Live viewer counter for the /club room. Every open tab heartbeats its own
// random session id on a 15s cadence (pages/club.html); a session that goes
// quiet for TTL_MS drops out of the count. State is per-instance and in-memory
// on purpose: the number is a room-liveliness signal, not an accounting record,
// so it is not worth a DB write or a Redis round-trip per heartbeat per viewer.
// The tradeoff is that a viewer only ever sees the tabs their own Cloud Run
// instance is serving, so a fanned-out room reads low rather than wrong.
//
// The session id is chosen by the client, so it is untrusted input: without a
// ceiling a script could post endless distinct ids to both inflate the number
// on screen and grow the process heap for TTL_MS at a time. Two bounds close
// that: one address holds at most MAX_SESSIONS_PER_IP slots, and the whole
// table is capped at MAX_SESSIONS. The per-IP cap is deliberately above a
// plausible household or small-office tab count, so a shared NAT egress still
// contributes several real viewers while an attacker buys almost nothing.

import { cors, json, error, method, readJson, rateLimited, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const TTL_MS = 30_000;
const MAX_SESSIONS = 5_000;
const MAX_SESSIONS_PER_IP = 12;

/** @type {Map<string, { ts: number, ip: string }>} session id -> last heartbeat */
const sessions = new Map();

function prune(now) {
	for (const [id, entry] of sessions) {
		if (now - entry.ts > TTL_MS) sessions.delete(id);
	}
}

function countForIp(ip) {
	let n = 0;
	for (const entry of sessions.values()) {
		if (entry.ip === ip) n++;
	}
	return n;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.clubPresenceIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many presence heartbeats');

	const body = await readJson(req);
	const session = typeof body?.session === 'string' ? body.session.slice(0, 40) : '';
	if (!session) return error(res, 400, 'validation_error', 'session required');

	const now = Date.now();
	prune(now);

	const existing = sessions.get(session);
	let counted = true;
	if (existing) {
		// A renewal is always honored: this tab already holds its slot, and the
		// address recorded with it stays put so a roaming client (mobile handoff)
		// cannot walk itself around the per-IP cap.
		existing.ts = now;
	} else if (sessions.size >= MAX_SESSIONS || countForIp(ip) >= MAX_SESSIONS_PER_IP) {
		counted = false;
	} else {
		sessions.set(session, { ts: now, ip });
	}

	// `counted` tells the caller whether their own tab is inside the number they
	// are about to render, so a capped client shows the room honestly instead of
	// silently believing it is invisible.
	return json(res, 200, { count: sessions.size, counted });
});
