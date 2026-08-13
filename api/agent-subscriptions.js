/**
 * /api/agent-subscriptions: manage recurring agent-delegation subscription records.
 *
 * Distinct from /api/subscriptions (creator plan subscriptions over
 * creator_subscriptions); this endpoint tracks delegation-backed recurring
 * charges in agent_subscriptions, created by the subscription skill.
 *
 * POST:   create a subscription (viewer has already granted a delegation)
 * GET:    list subscriptions for the authenticated user
 * DELETE: soft-cancel a subscription (?id=<uuid>); does NOT revoke the delegation
 */

import { sql } from './_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { z } from 'zod';
import { parse } from './_lib/validate.js';

const postSchema = z.object({
	agentId: z.string().uuid(),
	delegationId: z.string().uuid(),
	periodSeconds: z.number().int().positive(),
	amountPerPeriod: z
		.string()
		.regex(/^\d+$/, 'amountPerPeriod must be a base-unit integer string'),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// State-changing methods on a cookie session require a CSRF token (bearer
	// callers are exempt inside requireCsrf). Without this, a cross-origin script
	// could cancel a victim's subscriptions on their behalf.
	if (req.method !== 'GET' && !(await requireCsrf(req, res, userId))) return;

	// ── POST: create subscription ─────────────────────────────────────────────

	if (req.method === 'POST') {
		let body;
		try {
			body = parse(postSchema, await readJson(req));
		} catch (err) {
			return error(res, err.status ?? 400, err.code ?? 'validation_error', err.message);
		}
		const { agentId, delegationId, periodSeconds, amountPerPeriod } = body;

		// Verify the agent belongs to this user.
		const [agent] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 403, 'forbidden', 'agent not found or not owned by you');

		// Verify the delegation is active and belongs to this agent.
		const [delegation] = await sql`
			SELECT id FROM agent_delegations
			WHERE id = ${delegationId} AND agent_id = ${agentId} AND status = 'active'
		`;
		if (!delegation)
			return error(res, 400, 'validation_error', 'delegation not found or not active');

		// Idempotency: return existing active subscription rather than duplicating.
		const [existing] = await sql`
			SELECT id, status, next_charge_at
			FROM agent_subscriptions
			WHERE agent_id = ${agentId} AND delegation_id = ${delegationId} AND status = 'active'
		`;
		if (existing) return json(res, 200, { data: existing });

		const nextChargeAt = new Date(Date.now() + periodSeconds * 1000);
		const [row] = await sql`
			INSERT INTO agent_subscriptions
				(user_id, agent_id, delegation_id, period_seconds, amount_per_period, next_charge_at)
			VALUES
				(${userId}, ${agentId}, ${delegationId}, ${periodSeconds}, ${amountPerPeriod}, ${nextChargeAt.toISOString()})
			RETURNING id, status, next_charge_at, created_at
		`;
		return json(res, 201, { data: row });
	}

	// ── GET: list subscriptions for authenticated user ────────────────────────

	if (req.method === 'GET') {
		const agentId = req.query?.agentId ?? null;
		if (agentId && !z.string().uuid().safeParse(agentId).success) {
			return error(res, 400, 'validation_error', 'agentId must be a uuid');
		}

		const rows = agentId
			? await sql`
				SELECT id, agent_id, delegation_id, period_seconds, amount_per_period,
				       next_charge_at, last_charge_at, status, last_error, created_at, canceled_at
				FROM agent_subscriptions
				WHERE user_id = ${userId} AND agent_id = ${agentId}
				ORDER BY created_at DESC
			`
			: await sql`
				SELECT id, agent_id, delegation_id, period_seconds, amount_per_period,
				       next_charge_at, last_charge_at, status, last_error, created_at, canceled_at
				FROM agent_subscriptions
				WHERE user_id = ${userId}
				ORDER BY created_at DESC
			`;

		return json(res, 200, { data: rows });
	}

	// ── DELETE: soft-cancel ───────────────────────────────────────────────────

	if (req.method === 'DELETE') {
		const id = req.query?.id;
		if (!id) return error(res, 400, 'validation_error', 'id query param is required');
		if (!z.string().uuid().safeParse(id).success) {
			return error(res, 400, 'validation_error', 'id must be a uuid');
		}

		const [row] = await sql`
			UPDATE agent_subscriptions
			SET status = 'canceled', canceled_at = NOW()
			WHERE id = ${id} AND user_id = ${userId} AND status != 'canceled'
			RETURNING id, status, canceled_at
		`;
		if (!row) return error(res, 404, 'not_found', 'subscription not found or already canceled');
		return json(res, 200, { data: row });
	}
});
