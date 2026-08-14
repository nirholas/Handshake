// GET    /api/x/status: connection + quota + tier
// DELETE /api/x/status: disconnect

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, method, wrap, error, json } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { getUserTier } from '../_lib/x-post.js';
import { revokeAllSeedConsentsForUser } from '../_lib/x-seed-consent.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'DELETE'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'DELETE') {
		if (!(await requireCsrf(req, res, user.id))) return;
		await sql`
			update social_connections
			set disconnected_at = now(), updated_at = now()
			where user_id = ${user.id} and provider = 'x' and disconnected_at is null
		`;
		// Disconnecting X revokes the memory-seeding grants it authorized and
		// deletes the memories they produced. Leaving distilled posts on an agent
		// after the account is unlinked would make the consent screen a lie.
		const purge = await revokeAllSeedConsentsForUser(user.id, 'x_disconnected');
		return json(res, 200, {
			disconnected: true,
			seed_consents_revoked: purge.consents,
			seeded_memories_deleted: purge.deleted,
			agents_affected: purge.agents,
		});
	}

	const tier = await getUserTier(user.id);

	const rows = await sql`
		select username, posts_this_month, month_resets_at, connected_at, last_posted_at
		from social_connections
		where user_id = ${user.id} and provider = 'x' and disconnected_at is null
		limit 1
	`;
	const conn = rows[0];
	if (!conn) return json(res, 200, { connected: false, tier: tier.tier, quota: tier.quota });

	let postsThisMonth = conn.posts_this_month;
	if (new Date(conn.month_resets_at) <= new Date()) {
		await sql`
			update social_connections
			set posts_this_month = 0,
			    month_resets_at = date_trunc('month', now()) + interval '1 month'
			where user_id = ${user.id} and provider = 'x'
		`;
		postsThisMonth = 0;
	}

	return json(res, 200, {
		connected: true,
		username: conn.username,
		tier: tier.tier,
		quota: tier.quota,
		posts_used: postsThisMonth,
		month_resets_at: conn.month_resets_at,
		connected_at: conn.connected_at,
		last_posted_at: conn.last_posted_at,
		min_interval_min: tier.min_interval_min,
	});
});
