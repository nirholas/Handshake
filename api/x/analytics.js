// GET /api/x/analytics: recent posts with engagement metrics
// Optional: ?agent_id=<id> to filter

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, json } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agent_id');
	// agent_id is a uuid column on the deployed schema, so a junk value reaches
	// Postgres as a cast error and 500s a caller mistake. Reject it here.
	if (agentId !== null && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');

	const rows = agentId
		? await sql`
			select id, tweet_id, text, agent_id, metrics, metrics_fetched_at, created_at
			from x_posts where user_id = ${user.id} and agent_id = ${agentId}
			order by created_at desc limit 50
		`
		: await sql`
			select id, tweet_id, text, agent_id, metrics, metrics_fetched_at, created_at
			from x_posts where user_id = ${user.id}
			order by created_at desc limit 50
		`;

	// Roll up totals. X returns counts as numbers but the column is jsonb, so a
	// value that round-tripped as a string would silently turn `+=` into string
	// concatenation and render "00012" in the dashboard. Coerce every term.
	const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
	const totals = rows.reduce((acc, r) => {
		const m = r.metrics || {};
		acc.likes      += count(m.like_count);
		acc.retweets   += count(m.retweet_count);
		acc.replies    += count(m.reply_count);
		acc.quotes     += count(m.quote_count);
		acc.impressions += count(m.impression_count);
		acc.posts++;
		return acc;
	}, { posts: 0, likes: 0, retweets: 0, replies: 0, quotes: 0, impressions: 0 });

	return json(res, 200, { totals, posts: rows });
});
