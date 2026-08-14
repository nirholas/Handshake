// GET  /api/x/schedule:              list pending + recent scheduled posts
// POST /api/x/schedule:               schedule a new post { text, scheduled_at, agent_id? }
// DELETE /api/x/schedule?id=<uuid>:   cancel a pending scheduled post

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, readJson, json } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { MAX_TWEET_LEN } from '../_lib/x-post.js';

// Ceiling on the queue one account can hold. The publish cron scans pending rows
// every minute, so an unbounded queue is both a load problem and a way to park
// far more posts than the monthly quota could ever drain.
const MAX_PENDING_POSTS = 100;
// A schedule further out than this is a mistake, not a plan.
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rows = await sql`
			select id, agent_id, text, scheduled_at, posted_at, tweet_id, error, attempts
			from x_scheduled_posts
			where user_id = ${user.id}
			order by scheduled_at desc
			limit 50
		`;
		return json(res, 200, { posts: rows });
	}

	if (req.method === 'DELETE') {
		if (!(await requireCsrf(req, res, user.id))) return;
		const url = new URL(req.url, 'http://x');
		const id = url.searchParams.get('id');
		if (!id) return error(res, 400, 'validation_error', 'id required');
		// `id` addresses a uuid primary key; a junk value would reach Postgres as a
		// cast error and turn a caller mistake into a 500.
		if (!isUuid(id)) return error(res, 400, 'validation_error', 'id must be a uuid');
		const result = await sql`
			delete from x_scheduled_posts
			where id = ${id} and user_id = ${user.id} and posted_at is null
			returning id
		`;
		if (!result.length) return error(res, 404, 'not_found', 'no pending post with that id');
		return json(res, 200, { cancelled: id });
	}

	// POST
	if (!(await requireCsrf(req, res, user.id))) return;
	const body = await readJson(req);
	const text = typeof body?.text === 'string' ? body.text.trim() : '';
	const scheduledAt = typeof body?.scheduled_at === 'string' ? body.scheduled_at : '';
	const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null;
	if (agentId && !isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id must be a uuid');
	if (!text) return error(res, 400, 'validation_error', 'text required');
	if (text.length > MAX_TWEET_LEN) return error(res, 400, 'validation_error', `text exceeds ${MAX_TWEET_LEN} chars`);

	const when = new Date(scheduledAt);
	if (!scheduledAt || isNaN(when.getTime())) return error(res, 400, 'validation_error', 'scheduled_at must be a valid ISO timestamp');
	if (when.getTime() < Date.now() - 60_000) return error(res, 400, 'validation_error', 'scheduled_at must be in the future');
	if (when.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
		return error(res, 400, 'validation_error', 'scheduled_at must be within a year from now');
	}

	// Require a connected X account before accepting a schedule.
	const conn = await sql`
		select 1 from social_connections
		where user_id = ${user.id} and provider = 'x' and disconnected_at is null
		limit 1
	`;
	if (!conn.length) return error(res, 400, 'not_connected', 'connect X account first');

	const [{ count }] = await sql`
		select count(*)::int as count from x_scheduled_posts
		where user_id = ${user.id} and posted_at is null
	`;
	if (count >= MAX_PENDING_POSTS) {
		return error(res, 409, 'limit_reached', `you already have ${MAX_PENDING_POSTS} posts queued, cancel one first`);
	}

	const rows = await sql`
		insert into x_scheduled_posts (user_id, agent_id, text, scheduled_at)
		values (${user.id}, ${agentId}, ${text}, ${when.toISOString()})
		returning id, scheduled_at
	`;
	return json(res, 201, { id: rows[0].id, scheduled_at: rows[0].scheduled_at });
});
