/**
 * /api/subscriptions/plans — creator subscription plan management.
 *
 * Routes (via vercel.json):
 *   GET    /api/subscriptions/plans?creator_id=  list active plans (public)
 *   POST   /api/subscriptions/plans              create plan (auth, max 3)
 *   PATCH  /api/subscriptions/plans/:id          update name/price/perks (auth, owner)
 *   DELETE /api/subscriptions/plans/:id          soft-delete (auth, owner)
 */

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const planSchema = z.object({
	agent_id: z.string().uuid().optional(),
	name: z.string().trim().min(2).max(80),
	price_usd: z.number().min(0.99).max(999),
	interval: z.enum(['weekly', 'monthly']).default('monthly'),
	perks: z.array(z.string().trim().max(120)).max(10).default([]),
});

const patchSchema = z.object({
	name: z.string().trim().min(2).max(80).optional(),
	price_usd: z.number().min(0.99).max(999).optional(),
	perks: z.array(z.string().trim().max(120)).max(10).optional(),
	active: z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;

	// Extract path param: /api/subscriptions/plans/:id
	const url = req.url || '';
	const pathMatch = url.match(/\/api\/subscriptions\/plans\/([^?/]+)/);
	const planId = pathMatch ? pathMatch[1] : null;

	if (req.method === 'GET') return handleList(req, res);
	if (req.method === 'POST' && !planId) return handleCreate(req, res);
	if (req.method === 'PATCH' && planId) return handlePatch(req, res, planId);
	if (req.method === 'DELETE' && planId) return handleDelete(req, res, planId);

	return error(res, 405, 'method_not_allowed', 'method not allowed');
});

async function handleList(req, res) {
	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const params = new URL(req.url, 'http://x').searchParams;
	const creatorId = params.get('creator_id');
	const agentId = params.get('agent_id');

	if (!creatorId && !agentId) {
		return error(res, 400, 'validation_error', 'creator_id or agent_id required');
	}

	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (creatorId && !UUID_RE.test(creatorId)) {
		return error(res, 400, 'validation_error', 'creator_id must be a valid UUID');
	}
	if (agentId && !UUID_RE.test(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a valid UUID');
	}

	let rows;
	if (agentId) {
		// Look up all plans belonging to this agent's creator (agent_id is public).
		rows = await sql`
			SELECT sp.id, sp.creator_id, sp.agent_id, sp.name, sp.price_usd, sp.interval, sp.perks, sp.active, sp.created_at
			FROM subscription_plans sp
			JOIN agent_identities ai ON ai.user_id = sp.creator_id
			WHERE ai.id = ${agentId} AND ai.deleted_at IS NULL AND sp.active = true
			ORDER BY sp.created_at ASC
		`;
	} else {
		rows = await sql`
			SELECT id, creator_id, agent_id, name, price_usd, interval, perks, active, created_at
			FROM subscription_plans
			WHERE creator_id = ${creatorId} AND active = true
			ORDER BY created_at ASC
		`;
	}
	return json(res, 200, { plans: rows });
}

async function handleCreate(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const body = parse(planSchema, await readJson(req));

	// Enforce max 3 active plans per creator.
	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM subscription_plans
		WHERE creator_id = ${user.id} AND active = true
	`;
	if (count >= 3) return error(res, 409, 'conflict', 'maximum 3 active plans per creator');

	// Verify agent_id belongs to creator if provided.
	if (body.agent_id) {
		const [agent] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${body.agent_id} AND user_id = ${user.id} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 403, 'forbidden', 'agent not found or not owned by you');
	}

	const [plan] = await sql`
		INSERT INTO subscription_plans (creator_id, agent_id, name, price_usd, interval, perks)
		VALUES (${user.id}, ${body.agent_id ?? null}, ${body.name}, ${body.price_usd},
		        ${body.interval}, ${body.perks})
		RETURNING id, creator_id, agent_id, name, price_usd, interval, perks, active, created_at
	`;
	return json(res, 201, { plan });
}

async function handlePatch(req, res, planId) {
	if (!method(req, res, ['PATCH'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const body = parse(patchSchema, await readJson(req));

	const [existing] = await sql`
		SELECT id FROM subscription_plans WHERE id = ${planId} AND creator_id = ${user.id}
	`;
	if (!existing) return error(res, 404, 'not_found', 'plan not found');

	const setFrags = [];
	const params = [];
	if (body.name !== undefined) {
		params.push(body.name);
		setFrags.push(`name = $${params.length}`);
	}
	if (body.price_usd !== undefined) {
		params.push(body.price_usd);
		setFrags.push(`price_usd = $${params.length}`);
	}
	if (body.perks !== undefined) {
		params.push(body.perks);
		setFrags.push(`perks = $${params.length}`);
	}
	if (body.active !== undefined) {
		params.push(body.active);
		setFrags.push(`active = $${params.length}`);
	}

	if (setFrags.length === 0) return error(res, 400, 'validation_error', 'nothing to update');

	params.push(planId);
	const planIdIdx = params.length;
	params.push(user.id);
	const userIdIdx = params.length;

	const [plan] = await sql(
		`
		UPDATE subscription_plans
		SET ${setFrags.join(', ')}
		WHERE id = $${planIdIdx} AND creator_id = $${userIdIdx}
		RETURNING id, creator_id, agent_id, name, price_usd, interval, perks, active, created_at
	`,
		params,
	);
	return json(res, 200, { plan });
}

async function handleDelete(req, res, planId) {
	if (!method(req, res, ['DELETE'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const [plan] = await sql`
		UPDATE subscription_plans
		SET active = false
		WHERE id = ${planId} AND creator_id = ${user.id}
		RETURNING id
	`;
	if (!plan) return error(res, 404, 'not_found', 'plan not found');

	return json(res, 200, { ok: true });
}
