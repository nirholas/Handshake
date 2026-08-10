// GET/POST /api/bounties/:id/submissions: the proof feed under one bounty.
//
// GET is public and paginated. POST is the entry point for claiming a bounty:
// it records one proof (text and/or a media URL) against an open, unexpired
// bounty and flips the bounty into 'resolving' so the poster sees there is
// something to judge.

import { sql } from '../../_lib/db.js';
import { cors, json, error, readJson, wrap, method, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { isUuid } from '../../_lib/validate.js';
import { limits } from '../../_lib/rate-limit.js';
import { enrichLikes } from '../../_lib/bounty-likes.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// parseInt returns NaN on junk ("?limit=abc"), and NaN survives Math.min /
// Math.max, so an unclamped value reached the query as `LIMIT NaN` and 500'd.
// Anything unparseable or out of range falls back to the documented default.
function intParam(raw, fallback, min, max) {
	const n = parseInt(raw ?? '', 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

export default wrap(async (req, res) => {
	if (cors(req, res)) return;

	const id = req.query?.id;
	// Non-uuid segments (scanner junk) must not reach a uuid-typed query: that
	// throws NeonDbError and 500s. Treat them as a miss, as api/bounties/[id].js does.
	if (!id || !isUuid(id)) return error(res, 404, 'not_found', 'bounty not found');

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		const limit = intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
		const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

		const rows = await sql`
			SELECT id, bounty_id, user_id, username, content, media_url, media_type,
			       status, reward_sol, tx_hash, created_at
			FROM bounty_submissions
			WHERE bounty_id = ${id} AND status != 'rejected'
			ORDER BY created_at DESC
			LIMIT ${limit} OFFSET ${offset}
		`;
		const userId = (await getSessionUser(req).catch(() => null))?.id || null;
		await enrichLikes(rows, { userId });
		return json(res, 200, { submissions: rows });
	}

	if (req.method === 'POST') {
		const user = await getSessionUser(req).catch(() => null);
		if (!user) return error(res, 401, 'unauthorized', 'sign in to submit');
		if (!(await requireCsrf(req, res, user.id))) return;

		const rl = await limits.bountySubmit(user.id);
		if (!rl.success) return rateLimited(res, rl, 'too many submissions, slow down');

		const [bounty] = await sql`
			SELECT id, status, expires_at FROM bounties
			WHERE id = ${id} AND deleted_at IS NULL
		`;
		if (!bounty) return error(res, 404, 'not_found', 'bounty not found');
		if (bounty.status === 'closed') return error(res, 409, 'bounty_closed', 'bounty is closed');
		if (bounty.expires_at && new Date(bounty.expires_at) < new Date()) {
			return error(res, 409, 'bounty_expired', 'bounty has expired');
		}

		const body = await readJson(req, 16_000);
		const content = typeof body?.content === 'string' ? body.content : null;
		const mediaUrl = typeof body?.media_url === 'string' ? body.media_url : null;
		const mediaType = typeof body?.media_type === 'string' ? body.media_type : null;
		if (!content?.trim() && !mediaUrl?.trim()) {
			return error(res, 400, 'bad_request', 'provide a description or media URL');
		}
		// Bound free-text and validate the media URL shape: it's rendered to every
		// other user, so reject oversized content and non-http(s) links.
		if (content && content.length > 4000)
			return error(res, 400, 'bad_request', 'content too long (max 4000)');
		if (mediaUrl?.trim()) {
			const u = mediaUrl.trim();
			if (u.length > 2000 || !/^https?:\/\//i.test(u))
				return error(res, 400, 'bad_request', 'media_url must be a valid http(s) URL');
		}

		const validTypes = ['image', 'video', 'link'];
		const mtype =
			mediaType && validTypes.includes(mediaType) ? mediaType : mediaUrl ? 'link' : null;
		const username = user.display_name || user.email?.split('@')[0] || 'anon';

		const [submission] = await sql`
			INSERT INTO bounty_submissions (bounty_id, user_id, username, content, media_url, media_type)
			VALUES (${id}, ${user.id}, ${username}, ${content?.trim() || null}, ${mediaUrl?.trim() || null}, ${mtype})
			RETURNING *
		`;

		await sql`
			UPDATE bounties SET submission_count = submission_count + 1, status = 'resolving'
			WHERE id = ${id}
		`;

		return json(res, 201, { submission });
	}

	if (!method(req, res, ['GET', 'POST'])) return;
});
