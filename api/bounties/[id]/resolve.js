// POST /api/bounties/:id/resolve: the poster picks a winner and closes the
// bounty. Body: { submission_id, tx_hash? }.
//
// This is the destructive end of the board. It accepts one submission, rejects
// every other one, and closes the bounty permanently (a second call 409s). It
// records the payout tx hash the poster supplies; it never moves funds itself.

import { sql } from '../../_lib/db.js';
import { cors, json, error, readJson, wrap, method } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { isUuid } from '../../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// getSessionUser resolves to null for an anonymous caller rather than
	// throwing, so the null case needs its own guard (reading user.id off null
	// surfaced as a 500 on every signed-out request, not the intended 401).
	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const id = req.query?.id;
	// A non-uuid segment reaching a uuid-typed query throws NeonDbError and 500s;
	// treat it as a miss, matching api/bounties/[id].js.
	if (!id || !isUuid(id)) return error(res, 404, 'not_found', 'bounty not found');

	const [bounty] = await sql`
		SELECT id, user_id, status, reward_sol FROM bounties
		WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');
	if (bounty.user_id !== user.id) return error(res, 403, 'forbidden', 'only the bounty poster can resolve');
	if (bounty.status === 'closed') return error(res, 409, 'already_closed', 'bounty already resolved');

	const body = await readJson(req, 16_000);
	const submissionId = body?.submission_id;
	const txHash = typeof body?.tx_hash === 'string' ? body.tx_hash.trim() : '';
	if (!submissionId) return error(res, 400, 'bad_request', 'submission_id required');
	if (!isUuid(submissionId)) return error(res, 400, 'bad_request', 'submission_id must be a uuid');
	if (txHash.length > 128) return error(res, 400, 'bad_request', 'tx_hash too long (max 128)');

	const [submission] = await sql`
		SELECT id FROM bounty_submissions WHERE id = ${submissionId} AND bounty_id = ${id}
	`;
	if (!submission) return error(res, 404, 'not_found', 'submission not found on this bounty');

	// One transaction: a failure partway through would otherwise leave every
	// submission rejected with no accepted winner and the bounty still open, a
	// state no later call can repair since the losers are already rejected.
	const [, [winner]] = await sql.transaction([
		sql`
			UPDATE bounty_submissions SET status = 'rejected'
			WHERE bounty_id = ${id} AND id != ${submissionId}
		`,
		sql`
			UPDATE bounty_submissions
			SET status = 'accepted', reward_sol = ${bounty.reward_sol || null}, tx_hash = ${txHash || null}
			WHERE id = ${submissionId}
			RETURNING *
		`,
		sql`
			UPDATE bounties SET status = 'closed', winner_submission_id = ${submissionId}
			WHERE id = ${id}
		`,
	]);

	return json(res, 200, { winner });
});
