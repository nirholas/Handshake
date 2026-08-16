/**
 * /api/subscriptions/plans — creator subscription plan management.
 *
 * Routes (via vercel.json):
 *   GET    /api/subscriptions/plans?creator_id=  list active plans (public)
 *   GET    /api/subscriptions/plans/:id          one plan (public if active, owner otherwise)
 *   POST   /api/subscriptions/plans              create plan (auth, max 3)
 *   PATCH  /api/subscriptions/plans/:id          update name/price/perks (auth, owner)
 *   PUT    /api/subscriptions/plans/:id          alias of PATCH (the dashboard editor sends PUT)
 *   DELETE /api/subscriptions/plans/:id          soft-delete (auth, owner)
 */

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { parse, isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';

const planSchema = z.object({
	agent_id: z.string().uuid().optional(),
	name: z.string().trim().min(2).max(80),
	price_usd: z.number().min(0.99).max(999),
	interval: z.enum(['weekly', 'monthly']).default('monthly'),
	perks: z.array(z.string().trim().max(120)).max(10).default([]),
	included_skills: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
	active: z.boolean().default(true),
});

const patchSchema = z.object({
	name: z.string().trim().min(2).max(80).optional(),
	price_usd: z.number().min(0.99).max(999).optional(),
	interval: z.enum(['weekly', 'monthly']).optional(),
	perks: z.array(z.string().trim().max(120)).max(10).optional(),
	included_skills: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
	active: z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,PUT,DELETE,OPTIONS', credentials: true })) return;

	// Extract path param: /api/subscriptions/plans/:id
	const url = req.url || '';
	const pathMatch = url.match(/\/api\/subscriptions\/plans\/([^?/]+)/);
	const planId = pathMatch ? pathMatch[1] : null;

	// HEAD must reach whatever GET reaches (RFC 9110 9.3.2); Node strips the body
	// on the way out. Without this a HEAD probe matched no branch and fell through
	// to the 405 below.
	const verb = req.method === 'HEAD' ? 'GET' : req.method;

	if (verb === 'GET' && planId) return handleGetOne(req, res, planId);
	if (verb === 'GET') return handleList(req, res);
	if (verb === 'POST' && !planId) return handleCreate(req, res);
	// PUT is accepted alongside PATCH: the dashboard plan editor
	// (src/dashboard-next/pages/monetize.js) saves an edit with PUT, and the body
	// is a partial update either way. Without this the whole "edit tier" path
	// answered 405 and the creator's change was silently lost.
	if ((verb === 'PATCH' || verb === 'PUT') && planId) return handlePatch(req, res, planId);
	if (verb === 'DELETE' && planId) return handleDelete(req, res, planId);

	return error(res, 405, 'method_not_allowed', 'method not allowed');
});

async function handleList(req, res) {
	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const creatorId = params.get('creator_id');
	const agentId = params.get('agent_id');

	if (!creatorId && !agentId) {
		return error(res, 400, 'validation_error', 'creator_id or agent_id required');
	}

	if (creatorId && !isUuid(creatorId)) {
		return error(res, 400, 'validation_error', 'creator_id must be a valid UUID');
	}
	if (agentId && !isUuid(agentId)) {
		return error(res, 400, 'validation_error', 'agent_id must be a valid UUID');
	}

	// Public callers only ever see active plans. The owner may pass
	// include_inactive=1 to also receive deactivated plans (so the edit UI can
	// surface and reactivate them). We confirm ownership before honouring it.
	const wantsInactive = ['1', 'true'].includes(params.get('include_inactive') || '');
	let includeInactive = false;
	if (wantsInactive) {
		const user = await getSessionUser(req);
		if (user) {
			if (agentId) {
				const [owned] = await sql`
					SELECT id FROM agent_identities
					WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
				`;
				includeInactive = !!owned;
			} else {
				includeInactive = creatorId === user.id;
			}
		}
	}

	let rows;
	if (agentId) {
		// Look up all plans belonging to this agent's creator (agent_id is public).
		// Active plans first, then most-recent drafts, so the owner's list reads top-down.
		rows = await sql`
			SELECT sp.id, sp.creator_id, sp.agent_id, sp.name, sp.price_usd, sp.interval, sp.perks, sp.included_skills, sp.active, sp.created_at
			FROM subscription_plans sp
			JOIN agent_identities ai ON ai.user_id = sp.creator_id
			WHERE ai.id = ${agentId} AND ai.deleted_at IS NULL
			  AND (${includeInactive} OR sp.active = true)
			ORDER BY sp.active DESC, sp.created_at ASC
		`;
	} else {
		rows = await sql`
			SELECT id, creator_id, agent_id, name, price_usd, interval, perks, included_skills, active, created_at
			FROM subscription_plans
			WHERE creator_id = ${creatorId}
			  AND (${includeInactive} OR active = true)
			ORDER BY active DESC, created_at ASC
		`;
	}
	return json(res, 200, { plans: rows });
}

// Single plan by id. Active plans are public (they are what the marketplace
// renders); a draft is visible only to its creator, matching the visibility rule
// handleList applies to include_inactive.
async function handleGetOne(req, res, planId) {
	if (!isUuid(planId)) {
		return error(res, 400, 'validation_error', 'plan id must be a valid UUID');
	}

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const [plan] = await sql`
		SELECT id, creator_id, agent_id, name, price_usd, interval, perks, included_skills, active, created_at
		FROM subscription_plans WHERE id = ${planId}
	`;
	if (!plan) return error(res, 404, 'not_found', 'plan not found');
	if (!plan.active) {
		const user = await getSessionUser(req);
		if (!user || user.id !== plan.creator_id) {
			return error(res, 404, 'not_found', 'plan not found');
		}
	}
	return json(res, 200, { plan });
}

async function handleCreate(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt
	// (the token itself proves intent and isn't auto-attached by browsers).
	if (!(await requireCsrf(req, res, user.id))) return;

	const ip = clientIp(req);
	const rl = await limits.publicIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(planSchema, await readJson(req));

	// Enforce max 3 active plans per creator — only counts toward the cap if the
	// new plan is being created active. Drafts (active=false) don't consume a slot.
	if (body.active) {
		const [{ count }] = await sql`
			SELECT count(*)::int AS count FROM subscription_plans
			WHERE creator_id = ${user.id} AND active = true
		`;
		if (count >= 3) return error(res, 409, 'conflict', 'maximum 3 active plans per creator');
	}

	// Verify agent_id belongs to creator if provided.
	if (body.agent_id) {
		const [agent] = await sql`
			SELECT id FROM agent_identities
			WHERE id = ${body.agent_id} AND user_id = ${user.id} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 403, 'forbidden', 'agent not found or not owned by you');
	}

	const [plan] = await sql`
		INSERT INTO subscription_plans (creator_id, agent_id, name, price_usd, interval, perks, included_skills, active)
		VALUES (${user.id}, ${body.agent_id ?? null}, ${body.name}, ${body.price_usd},
		        ${body.interval}, ${body.perks}, ${body.included_skills}, ${body.active})
		RETURNING id, creator_id, agent_id, name, price_usd, interval, perks, included_skills, active, created_at
	`;
	return json(res, 201, { plan });
}

async function handlePatch(req, res, planId) {
	if (!method(req, res, ['PATCH', 'PUT'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, user.id))) return;

	// The id goes straight into a uuid comparison below, and Postgres answers a
	// malformed one with 22P02, which surfaced as a 500 instead of telling the
	// caller their id was wrong. Reject it here, as handleList already does for
	// the creator_id/agent_id query params.
	if (!isUuid(planId)) {
		return error(res, 400, 'validation_error', 'plan id must be a valid UUID');
	}

	const body = parse(patchSchema, await readJson(req));

	const [existing] = await sql`
		SELECT id, active FROM subscription_plans WHERE id = ${planId} AND creator_id = ${user.id}
	`;
	if (!existing) return error(res, 404, 'not_found', 'plan not found');

	// Reactivating a plan must respect the max-3-active cap (the create path
	// enforces the same invariant). Already-active plans toggling other fields
	// don't re-check, and deactivating is always allowed.
	if (body.active === true && existing.active === false) {
		const [{ count }] = await sql`
			SELECT count(*)::int AS count FROM subscription_plans
			WHERE creator_id = ${user.id} AND active = true AND id <> ${planId}
		`;
		if (count >= 3) return error(res, 409, 'conflict', 'maximum 3 active plans per creator');
	}

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
	if (body.interval !== undefined) {
		params.push(body.interval);
		setFrags.push(`interval = $${params.length}`);
	}
	if (body.perks !== undefined) {
		params.push(body.perks);
		setFrags.push(`perks = $${params.length}`);
	}
	if (body.included_skills !== undefined) {
		params.push(body.included_skills);
		setFrags.push(`included_skills = $${params.length}`);
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
		RETURNING id, creator_id, agent_id, name, price_usd, interval, perks, included_skills, active, created_at
	`,
		params,
	);
	return json(res, 200, { plan });
}

async function handleDelete(req, res, planId) {
	if (!method(req, res, ['DELETE'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, user.id))) return;

	if (!isUuid(planId)) {
		return error(res, 400, 'validation_error', 'plan id must be a valid UUID');
	}

	const [plan] = await sql`
		UPDATE subscription_plans
		SET active = false
		WHERE id = ${planId} AND creator_id = ${user.id}
		RETURNING id
	`;
	if (!plan) return error(res, 404, 'not_found', 'plan not found');

	return json(res, 200, { ok: true });
}
