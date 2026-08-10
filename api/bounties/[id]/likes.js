// POST /api/bounties/:id/likes — toggle the caller's like on a submission.
//
// Body: { submission_id }. Returns { liked, like_count } reflecting the new
// state. Likes are the board's social-proof signal: they surface in the feed
// and feed into the AI judge as a weak tiebreaker. One like per (submission,
// user); posting again removes it.

import { sql } from '../../_lib/db.js';
import { cors, json, error, readJson, wrap, method } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { isUuid } from '../../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const bountyId = req.query?.id;
	if (!bountyId || !isUuid(bountyId))
		return error(res, 400, 'bad_request', 'valid bounty id required');

	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to like submissions');
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = await readJson(req);
	const submissionId = body?.submission_id;
	if (!submissionId || !isUuid(submissionId)) {
		return error(res, 400, 'bad_request', 'submission_id required');
	}

	// The submission must exist and belong to this (non-deleted) bounty.
	const [sub] = await sql`
		SELECT bs.id
		FROM bounty_submissions bs
		JOIN bounties b ON b.id = bs.bounty_id AND b.deleted_at IS NULL
		WHERE bs.id = ${submissionId} AND bs.bounty_id = ${bountyId}
	`;
	if (!sub) return error(res, 404, 'not_found', 'submission not found on this bounty');

	const [existing] = await sql`
		SELECT 1 AS x FROM bounty_submission_likes
		WHERE submission_id = ${submissionId} AND user_id = ${user.id}
	`;

	if (existing) {
		await sql`
			DELETE FROM bounty_submission_likes
			WHERE submission_id = ${submissionId} AND user_id = ${user.id}
		`;
	} else {
		await sql`
			INSERT INTO bounty_submission_likes (submission_id, user_id)
			VALUES (${submissionId}, ${user.id})
			ON CONFLICT DO NOTHING
		`;
	}

	const [{ c }] = await sql`
		SELECT COUNT(*)::int AS c FROM bounty_submission_likes WHERE submission_id = ${submissionId}
	`;

	return json(res, 200, { liked: !existing, like_count: c });
});
