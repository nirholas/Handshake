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
//
// The endpoint is a caller-supplied URL that api/_lib/web-push.js later fetches
// from our own network, so it is SSRF-guarded here at registration time, the
// same way developer-supplied webhook URLs are: https only, and the host must
// resolve to a public address. Without it, `javascript:`/`file:` schemes and
// `http://169.254.169.254/…`-style internal targets are storable.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { assertPublicHttpsUrl, SsrfError } from '../_lib/ssrf.js';

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

// Transient resolver trouble must not permanently reject a legitimate device:
// the client can retry a 503, while a blocked scheme or an internal target is a
// hard 400 no retry will ever turn into a stored row.
const RETRYABLE_SSRF_CODES = new Set(['dns_timeout', 'dns_failed']);

// Sends the response and returns false when the endpoint is not a public https
// URL; returns true when it is safe to store. Registration only: removing a row
// is safe, so an endpoint that stopped resolving can still be unsubscribed.
async function endpointIsPublic(res, endpoint) {
	try {
		await assertPublicHttpsUrl(endpoint);
		return true;
	} catch (err) {
		if (err instanceof SsrfError && RETRYABLE_SSRF_CODES.has(err.code)) {
			error(res, 503, 'endpoint_unverified', 'could not verify the push endpoint host, retry');
			return false;
		}
		error(res, 400, 'validation_error', 'endpoint must be a public https push service URL');
		return false;
	}
}

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
	if (!(await endpointIsPublic(res, subscription.endpoint))) return;
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
