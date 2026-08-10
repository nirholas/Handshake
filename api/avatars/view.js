// POST /api/avatars/view — increment view_count for a public avatar.
// Accepts { avatar_id } in the JSON body. Auth is optional; the endpoint
// counts at most one view per IP per avatar per 30 min so a reader who reopens
// the same card cannot inflate the counter.

import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	// Coarse per-IP flood guard, applied before any parsing so a script cannot
	// spend request budget on malformed bodies.
	const ip = clientIp(req);
	const flood = await limits.publicIp(ip);
	if (!flood.success) return json(res, 200, { ok: false, reason: 'rate_limited' });

	const body = await readJson(req).catch(() => null);
	const avatarId = body?.avatar_id;
	// Guard the uuid shape here: an arbitrary string would reach Postgres as
	// `WHERE id = $1` and raise 22P02, which surfaces as a 500 to a caller who
	// only made a typo.
	if (!isUuid(avatarId)) {
		return error(res, 400, 'invalid_request', 'avatar_id must be a uuid');
	}

	// One counted view per (IP, avatar) per 30 min. A repeat inside the window is
	// a success for the caller (the view simply is not counted twice), so the
	// tracker never turns into a visible error in the gallery.
	const dedupe = await limits.avatarViewIp(`${ip}:${avatarId}`);
	if (!dedupe.success) return json(res, 200, { ok: true, counted: false });

	// Only count views for public avatars; silently ignore private/deleted.
	await sql`
		UPDATE avatars
		SET view_count = coalesce(view_count, 0) + 1
		WHERE id = ${avatarId}
		  AND visibility = 'public'
		  AND deleted_at IS NULL
	`;

	return json(res, 200, { ok: true, counted: true });
});
