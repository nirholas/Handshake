/**
 * /api/subscriptions — subscriber-facing subscription management.
 *
 * Routes (via vercel.json):
 *   POST   /api/subscriptions           subscribe to a plan (auth)
 *   GET    /api/subscriptions/mine      list my active subscriptions (auth)
 *   DELETE /api/subscriptions/:id       cancel (auth, subscriber)
 *   GET    /api/subscriptions/:id       detail (auth, subscriber or creator)
 */

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { parse, isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { chargeSubscription } from '../_lib/subscription-billing.js';

const subscribeSchema = z.object({
	plan_id: z.string().uuid(),
	wallet_address: z.string().min(1).max(200).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const url = req.url || '';
	const pathMatch = url.match(/\/api\/subscriptions\/([^?/]+)/);
	const segment = pathMatch ? pathMatch[1] : null;

	// HEAD must reach whatever GET reaches (RFC 9110 9.3.2); Node strips the body
	// on the way out. Without this a HEAD probe matched no branch and fell through
	// to the 405 below.
	const verb = req.method === 'HEAD' ? 'GET' : req.method;

	if (segment === 'mine' && verb === 'GET') return handleMine(req, res);
	if (!segment && verb === 'POST') return handleSubscribe(req, res);
	if (segment && verb === 'DELETE') return handleCancel(req, res, segment);
	if (segment && verb === 'GET') return handleDetail(req, res, segment);

	return error(res, 405, 'method_not_allowed', 'method not allowed');
});

async function handleMine(req, res) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT
			cs.id, cs.plan_id, cs.status, cs.current_period_start, cs.current_period_end,
			cs.payment_method, cs.wallet_address, cs.created_at, cs.cancelled_at,
			sp.name AS plan_name, sp.price_usd, sp.interval,
			u.display_name AS creator_name, u.id AS creator_id, u.username AS creator_username
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		JOIN users u ON u.id = sp.creator_id
		WHERE cs.subscriber_user_id = ${user.id}
		ORDER BY cs.created_at DESC
	`;
	return json(res, 200, { subscriptions: rows });
}

async function handleSubscribe(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt
	// (the token itself proves intent and isn't auto-attached by browsers).
	if (!(await requireCsrf(req, res, user.id))) return;

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(subscribeSchema, await readJson(req));

	const [plan] = await sql`
		SELECT id, creator_id, price_usd, interval, active
		FROM subscription_plans WHERE id = ${body.plan_id}
	`;
	if (!plan) return error(res, 404, 'not_found', 'plan not found');
	if (!plan.active) return error(res, 409, 'conflict', 'plan is no longer active');
	if (plan.creator_id === user.id)
		return error(res, 409, 'conflict', 'cannot subscribe to your own plan');

	const periodMs = plan.interval === 'weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
	const periodEnd = new Date(Date.now() + periodMs).toISOString();

	// Upsert guard: reject if already subscribed and active.
	const [existing] = await sql`
		SELECT id, status FROM creator_subscriptions
		WHERE plan_id = ${plan.id} AND subscriber_user_id = ${user.id}
	`;
	if (existing && existing.status === 'active') {
		return error(res, 409, 'conflict', 'already subscribed to this plan');
	}

	let sub;
	if (existing) {
		// Re-activate a cancelled subscription.
		[sub] = await sql`
			UPDATE creator_subscriptions
			SET status = 'active',
			    current_period_start = now(),
			    current_period_end = ${periodEnd},
			    wallet_address = ${body.wallet_address ?? null},
			    cancelled_at = NULL
			WHERE id = ${existing.id}
			RETURNING *
		`;
	} else {
		[sub] = await sql`
			INSERT INTO creator_subscriptions
				(plan_id, subscriber_user_id, current_period_end, wallet_address)
			VALUES (${plan.id}, ${user.id}, ${periodEnd}, ${body.wallet_address ?? null})
			RETURNING *
		`;
	}

	// Attempt first payment immediately (non-blocking on failure).
	const billing = await chargeSubscription(sub.id);

	return json(res, 201, { subscription: sub, payment: billing });
}

async function handleCancel(req, res, subId) {
	if (!method(req, res, ['DELETE'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, user.id))) return;

	// The path segment goes straight into a uuid comparison, and Postgres answers
	// a malformed one with 22P02, which surfaced as a 500 instead of telling the
	// caller their id was wrong.
	if (!isUuid(subId)) {
		return error(res, 400, 'validation_error', 'subscription id must be a valid UUID');
	}

	const [sub] = await sql`
		UPDATE creator_subscriptions
		SET status = 'cancelled', cancelled_at = now()
		WHERE id = ${subId} AND subscriber_user_id = ${user.id}
		RETURNING id, status
	`;
	if (!sub) return error(res, 404, 'not_found', 'subscription not found');

	return json(res, 200, { ok: true, subscription: sub });
}

async function handleDetail(req, res, subId) {
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (!isUuid(subId)) {
		return error(res, 400, 'validation_error', 'subscription id must be a valid UUID');
	}

	const [sub] = await sql`
		SELECT
			cs.*, sp.name AS plan_name, sp.price_usd, sp.interval, sp.creator_id,
			u.display_name AS creator_name
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		JOIN users u ON u.id = sp.creator_id
		WHERE cs.id = ${subId}
		  AND (cs.subscriber_user_id = ${user.id} OR sp.creator_id = ${user.id})
	`;
	if (!sub) return error(res, 404, 'not_found', 'subscription not found');

	return json(res, 200, { subscription: sub });
}
