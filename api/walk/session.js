// /api/walk/session — resume-where-you-left-off persistence for the /walk runtime.
//
//   GET  → load the signed-in user's last walk snapshot, or 204 when none exists.
//   PUT  → save (upsert) the snapshot. Last-write-wins per user.
//
// This is the cross-device sync half of walk session persistence: the walk client
// (src/walk-session.js) debounce-saves the live state and restores it on load.
// Anonymous walkers persist the same shape to localStorage; only authenticated
// users reach this endpoint, which is what gives continuity across browsers
// (walk on a laptop, reopen on a phone, same state restored).
//
// Identity: a session cookie or bearer token resolves the user server-side. No
// user → 401, so an unauthenticated client cleanly falls back to localStorage.
//
// The snapshot is a single client-owned document validated with zod here before
// it is written, so the row never stores arbitrary blobs. The document shape is
// kept in lockstep with src/walk-session.js.

import { z } from 'zod';
import { cors, method, readJson, json, error, wrap, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { getSessionUser, extractBearer, authenticateBearer } from '../_lib/auth.js';

export const maxDuration = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The walk snapshot. Every field is optional so a partial save (e.g. only a
// camera-mode change) is valid; the client always sends what it currently holds.
// Bounds are deliberately tight — this is small UI state, never a payload.
const stateSchema = z
	.object({
		// Selected avatar (a real avatar UUID) or null for the default avatar.
		avatarId: z.string().regex(UUID_RE).nullable().optional(),
		avatarUrl: z.string().max(2048).nullable().optional(),
		// Environment scene name (manifest `name`, e.g. "park").
		envId: z.string().trim().max(64).nullable().optional(),
		// Camera mode — one of the walk runtime's modes.
		cameraMode: z.enum(['follow', 'cinematic', 'firstperson', 'topdown']).nullable().optional(),
		// Last known world position (metres) + facing (radians).
		position: z
			.object({
				x: z.number().finite(),
				y: z.number().finite(),
				z: z.number().finite(),
			})
			.nullable()
			.optional(),
		heading: z.number().finite().nullable().optional(),
		// Path-trail style (off | footprints | glow | line).
		trailStyle: z.string().trim().max(32).nullable().optional(),
		// Most-recent-first list of gesture names used, surfaced for quick re-use.
		recentGestures: z.array(z.string().trim().max(48)).max(5).optional(),
		// Companion preferences mirrored from the in-page companion controls.
		companion: z
			.object({
				size: z.number().finite().min(0.1).max(10).optional(),
				walkSpeed: z.number().finite().min(0).max(20).optional(),
			})
			.strict()
			.nullable()
			.optional(),
		// Multiplayer room code, when the session is in a room.
		roomCode: z.string().trim().max(64).nullable().optional(),
		// Client-stamped capture time (epoch ms) — informational; the server's
		// updated_at is authoritative for the freshness gate.
		savedAt: z.number().finite().nonnegative().optional(),
	})
	.strict();

const putSchema = z.object({ state: stateSchema }).strict();

async function resolveUserId(req) {
	try {
		const bearer = extractBearer(req);
		const user = bearer ? await authenticateBearer(bearer) : await getSessionUser(req);
		return user?.userId || user?.id || user?.sub || null;
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	// Same-origin only — this is per-user state behind a session cookie. Echo the
	// app origin and allow credentials so the cookie rides along on the fetch.
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	// Coarse per-IP flood guard on both verbs; the per-user write budget below is
	// what actually bounds snapshot churn, so a read never spends write budget and
	// walkers behind one NAT never share a ceiling.
	const ip = clientIp(req);
	const ipRl = await limits.publicIp(ip);
	if (!ipRl.success) return rateLimited(res, ipRl);

	const userId = await resolveUserId(req);
	if (!userId) {
		// No identity → the client persists to localStorage instead. A clear 401
		// (not a 200 with empty state) lets it distinguish "not signed in" from
		// "signed in, nothing saved yet".
		return error(res, 401, 'unauthenticated', 'sign in to sync your walk across devices');
	}

	if (req.method === 'GET') {
		const rows = await sql`
			select state, updated_at
			from walk_sessions
			where user_id = ${userId}
			limit 1
		`;
		if (!rows[0]) return json(res, 204, {});
		return json(res, 200, {
			state: rows[0].state || {},
			updatedAt: rows[0].updated_at,
		});
	}

	// PUT — upsert the snapshot (last-write-wins).
	const writeRl = await limits.walkSessionWrite(userId);
	if (!writeRl.success) return rateLimited(res, writeRl, 'too many walk-session writes');

	const raw = await readJson(req);
	const { state } = parse(putSchema, raw);

	const [row] = await sql`
		insert into walk_sessions (user_id, state, created_at, updated_at)
		values (${userId}, ${JSON.stringify(state)}::jsonb, now(), now())
		on conflict (user_id) do update set
			state = excluded.state,
			updated_at = now()
		returning updated_at
	`;

	return json(res, 200, { ok: true, updatedAt: row.updated_at });
});
