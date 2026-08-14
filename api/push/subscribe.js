// Web Push subscription registry.
//
//   POST   /api/push/subscribe   { subscription: PushSubscriptionJSON }
//          → upsert the device's push endpoint for the signed-in user.
//   DELETE /api/push/subscribe   { endpoint } | { subscription }
//          → remove an endpoint (used when the user disables push).
//
// The subscription object is exactly what `pushManager.subscribe()` returns
// (`.toJSON()`): { endpoint, keys: { p256dh, auth } }. Endpoints are unique
// globally, so a re-subscribe upserts: the latest owner wins and stale rows
// from a previous account on the same device are reclaimed.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';

const subscriptionSchema = z.object({
	endpoint: z.string().url().max(2048),
	keys: z.object({
		p256dh: z.string().min(1).max(256),
		auth: z.string().min(1).max(256),
	}),
});

const postBody = z.object({ subscription: subscriptionSchema });
const deleteBody = z.object({
	endpoint: z.string().url().max(2048).optional(),
	subscription: subscriptionSchema.optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const user = await getRequestUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.pushSubscribe(user.id);
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'DELETE') {
		const { endpoint, subscription } = parse(deleteBody, await readJson(req));
		const ep = endpoint || subscription?.endpoint;
		if (!ep) return error(res, 400, 'validation_error', 'endpoint required');
		await sql`
			delete from push_subscriptions
			where user_id = ${user.id} and endpoint = ${ep}
		`;
		return json(res, 200, { ok: true });
	}

	const { subscription } = parse(postBody, await readJson(req));
	const ua = String(req.headers['user-agent'] || '').slice(0, 400);

	await sql`
		insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
		values (${user.id}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, ${ua})
		on conflict (endpoint) do update set
			user_id      = excluded.user_id,
			p256dh       = excluded.p256dh,
			auth         = excluded.auth,
			user_agent   = excluded.user_agent,
			last_seen_at = now()
	`;

	return json(res, 201, { ok: true });
});
