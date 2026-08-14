// POST /api/x/post
// Body: { text?, thread_parts?, agent_id?, append_link?, reply_to_tweet_id? }
// One of `text` (single tweet) or `thread_parts` (array → thread) is required.

import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, readJson, json, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { publishTweet, XPostError } from '../_lib/x-post.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// Publishing to the user's connected X account is a sensitive state change,
	// gate it behind CSRF like the rest of the write surface (marketplace, etc.),
	// and rate-limit so a leaked session can't spam the account.
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req);
	const text = typeof body?.text === 'string' ? body.text : '';
	const threadParts = Array.isArray(body?.thread_parts) ? body.thread_parts : null;
	const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null;
	const replyTo = typeof body?.reply_to_tweet_id === 'string' ? body.reply_to_tweet_id : null;
	const appendLink = body?.append_link === true;

	try {
		const result = await publishTweet({ userId: user.id, agentId, text, threadParts, replyTo, appendLink });
		return json(res, 200, result);
	} catch (err) {
		if (err instanceof XPostError) return error(res, err.status, err.code, err.message, err.extra);
		console.error('[x-post] unexpected error', err);
		return error(res, 500, 'internal_error', err.message || 'post failed');
	}
});
