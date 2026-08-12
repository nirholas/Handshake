/**
 * Dashboard Preferences
 * ---------------------
 * GET   /api/dashboard/prefs returns the signed-in user's prefs JSON
 * POST  /api/dashboard/prefs replaces the user's prefs, body: { prefs: {...} }
 * PATCH /api/dashboard/prefs merges a partial prefs, body: { prefs: {...} }
 *
 * Backed by the user_prefs table. localStorage remains the primary client
 * store; this endpoint provides a durable backup so prefs follow the user
 * across browsers/devices.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { z } from 'zod';

const MAX_BYTES = 16 * 1024;

const prefsBody = z.object({
	prefs: z.record(z.unknown()).refine(
		(v) => JSON.stringify(v).length <= MAX_BYTES,
		{ message: `prefs exceed ${MAX_BYTES} bytes` },
	),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'PATCH'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const [row] = await sql`
			SELECT prefs FROM user_prefs WHERE user_id = ${auth.userId}
		`;
		return json(res, 200, { prefs: row?.prefs || {} });
	}

	// Session-cookie writes need CSRF; bearer-token callers are exempt (the token
	// itself is the proof of intent and isn't auto-attached by browsers).
	if (auth.fromSession && !(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.prefsWrite(auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const { prefs: incoming } = parse(prefsBody, await readJson(req));

	if (req.method === 'PATCH') {
		// Shallow top-level merge, done inside the statement (`||` is jsonb concat)
		// rather than as a read-modify-write. The dashboard fires independent
		// patches for unrelated keys from the same page load (tour completion,
		// walk state, the settings form), so a JS-side merge between a SELECT and
		// an UPDATE silently drops whichever write lost the race.
		//
		// The size guard rides along as the DO UPDATE predicate: when the merged
		// document would blow the cap, no row is updated and RETURNING yields
		// nothing, which is the 400 below. Postgres renders jsonb text slightly
		// wider than JSON.stringify (a space after each colon and comma), so the
		// effective ceiling here is a few percent stricter than the zod check on
		// the incoming patch. Both are guard rails on the same 16 KB budget.
		const [row] = await sql`
			INSERT INTO user_prefs (user_id, prefs, updated_at)
			VALUES (${auth.userId}, ${JSON.stringify(incoming)}::jsonb, now())
			ON CONFLICT (user_id) DO UPDATE SET
				prefs = user_prefs.prefs || EXCLUDED.prefs,
				updated_at = now()
			WHERE octet_length((user_prefs.prefs || EXCLUDED.prefs)::text) <= ${MAX_BYTES}
			RETURNING 1 AS ok
		`;
		if (!row) {
			return error(res, 400, 'prefs_too_large', `prefs exceed ${MAX_BYTES} bytes`);
		}
	} else {
		// POST replaces prefs entirely.
		await sql`
			INSERT INTO user_prefs (user_id, prefs, updated_at)
			VALUES (${auth.userId}, ${JSON.stringify(incoming)}::jsonb, now())
			ON CONFLICT (user_id) DO UPDATE SET
				prefs = EXCLUDED.prefs,
				updated_at = now()
		`;
	}

	return json(res, 200, { ok: true });
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, fromSession: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, fromSession: false };
	return null;
}
