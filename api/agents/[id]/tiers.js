/**
 * Agent-scoped subscription tier management.
 *
 * Routes (vercel.json rewrites map /api/agents/:id/tiers → this file):
 *   GET    /api/agents/:id/tiers             list active tiers for agent (public)
 *   POST   /api/agents/:id/tiers             create tier (auth, agent owner)
 *   PUT    /api/agents/:id/tiers/:tierId     update tier (auth, agent owner)
 *   PATCH  /api/agents/:id/tiers/:tierId     update tier (alias of PUT)
 *   DELETE /api/agents/:id/tiers/:tierId     deactivate tier (auth, agent owner)
 *
 * Tiers are stored in the `subscription_plans` table scoped by agent_id.
 * The creator_id on each plan must match the authenticated user.
 */

import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { parse, isUuid } from '../../_lib/validate.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';

const createSchema = z.object({
	name:      z.string().trim().min(2).max(80),
	price_usd: z.number().min(0.99).max(999),
	interval:  z.enum(['weekly', 'monthly']).default('monthly'),
	perks:     z.array(z.string().trim().max(120)).max(10).default([]),
	included_skills: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});

const patchSchema = z.object({
	name:      z.string().trim().min(2).max(80).optional(),
	price_usd: z.number().min(0.99).max(999).optional(),
	interval:  z.enum(['weekly', 'monthly']).optional(),
	perks:     z.array(z.string().trim().max(120)).max(10).optional(),
	included_skills: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
	active:    z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, 'http://x');
	// Path: /api/agents/:agentId/tiers or /api/agents/:agentId/tiers/:tierId
	const parts = url.pathname.split('/').filter(Boolean);
	// parts: ['api', 'agents', agentId, 'tiers', tierId?]
	const agentId = url.searchParams.get('id') || parts[2] || null;
	const tierId  = url.searchParams.get('tier_id') || parts[4] || null;

	if (!agentId || !isUuid(agentId)) return error(res, 400, 'validation_error', 'valid agent id required');

	if (req.method === 'GET') return handleList(req, res, agentId);
	if (req.method === 'POST' && !tierId) return handleCreate(req, res, agentId);
	if ((req.method === 'PUT' || req.method === 'PATCH') && tierId) return handleUpdate(req, res, agentId, tierId);
	if (req.method === 'DELETE' && tierId) return handleDelete(req, res, agentId, tierId);

	return error(res, 405, 'method_not_allowed', 'method not allowed');
});

// ── Ownership check ─────────────────────────────────────────────────────────

async function requireAgentOwner(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	const [agent] = await sql`
		SELECT user_id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
	`;
	if (!agent) { error(res, 403, 'forbidden', 'agent not found or not owned by you'); return null; }
	return user;
}

// ── List ─────────────────────────────────────────────────────────────────────

async function handleList(req, res, agentId) {
	const ip = clientIp(req);
	const rl = await limits.agentProfileIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT id, name, price_usd, interval, perks, included_skills, active, created_at
		FROM subscription_plans
		WHERE agent_id = ${agentId} AND active = true
		ORDER BY price_usd ASC
	`;
	return json(res, 200, { tiers: rows });
}

// ── Create ────────────────────────────────────────────────────────────────────

async function handleCreate(req, res, agentId) {
	if (!method(req, res, ['POST'])) return;
	const user = await requireAgentOwner(req, res, agentId);
	if (!user) return;

	if (!(await requireCsrf(req, res, user.id))) return;

	const ip = clientIp(req);
	const rl = await limits.agentProfileIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(createSchema, await readJson(req));

	// Max 3 active plans per creator.
	const [{ count }] = await sql`
		SELECT count(*)::int AS count FROM subscription_plans
		WHERE creator_id = ${user.id} AND active = true
	`;
	if (count >= 3) return error(res, 409, 'conflict', 'maximum 3 active plans per creator');

	const [tier] = await sql`
		INSERT INTO subscription_plans
			(creator_id, agent_id, name, price_usd, interval, perks, included_skills)
		VALUES
			(${user.id}, ${agentId}, ${body.name}, ${body.price_usd}, ${body.interval}, ${body.perks}, ${body.included_skills})
		RETURNING id, name, price_usd, interval, perks, included_skills, active, created_at
	`;
	return json(res, 201, { tier });
}

// ── Update (PUT / PATCH) ──────────────────────────────────────────────────────

async function handleUpdate(req, res, agentId, tierId) {
	if (!method(req, res, ['PUT', 'PATCH'])) return;
	const user = await requireAgentOwner(req, res, agentId);
	if (!user) return;

	if (!(await requireCsrf(req, res, user.id))) return;

	const body = parse(patchSchema, await readJson(req));

	const [existing] = await sql`
		SELECT id FROM subscription_plans
		WHERE id = ${tierId} AND agent_id = ${agentId} AND creator_id = ${user.id}
	`;
	if (!existing) return error(res, 404, 'not_found', 'tier not found');

	const setFrags = [];
	const params = [];
	if (body.name !== undefined)      { params.push(body.name);      setFrags.push(`name = $${params.length}`); }
	if (body.price_usd !== undefined) { params.push(body.price_usd); setFrags.push(`price_usd = $${params.length}`); }
	if (body.interval !== undefined)  { params.push(body.interval);  setFrags.push(`interval = $${params.length}`); }
	if (body.perks !== undefined)     { params.push(body.perks);     setFrags.push(`perks = $${params.length}`); }
	if (body.included_skills !== undefined) { params.push(body.included_skills); setFrags.push(`included_skills = $${params.length}`); }
	if (body.active !== undefined)    { params.push(body.active);    setFrags.push(`active = $${params.length}`); }
	if (setFrags.length === 0) return error(res, 400, 'validation_error', 'nothing to update');

	params.push(tierId); const tidIdx = params.length;
	params.push(user.id); const uidIdx = params.length;

	const [tier] = await sql(
		`UPDATE subscription_plans SET ${setFrags.join(', ')}
		 WHERE id = $${tidIdx} AND creator_id = $${uidIdx}
		 RETURNING id, name, price_usd, interval, perks, included_skills, active, created_at`,
		params,
	);
	return json(res, 200, { tier });
}

// ── Delete (soft) ─────────────────────────────────────────────────────────────

async function handleDelete(req, res, agentId, tierId) {
	if (!method(req, res, ['DELETE'])) return;
	const user = await requireAgentOwner(req, res, agentId);
	if (!user) return;

	if (!(await requireCsrf(req, res, user.id))) return;

	// Check for active subscribers before deactivating.
	const [{ count: subCount }] = await sql`
		SELECT count(*)::int AS count FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		WHERE sp.id = ${tierId} AND sp.agent_id = ${agentId}
		  AND cs.status = 'active'
	`;

	// Soft-delete (mark inactive) regardless — active subscribers keep access
	// until their period ends; we just stop accepting new sign-ups.
	const [tier] = await sql`
		UPDATE subscription_plans SET active = false
		WHERE id = ${tierId} AND agent_id = ${agentId} AND creator_id = ${user.id}
		RETURNING id
	`;
	if (!tier) return error(res, 404, 'not_found', 'tier not found');

	return json(res, 200, {
		ok: true,
		active_subscribers: subCount,
		message: subCount > 0
			? `Plan deactivated — ${subCount} subscriber(s) will keep access until their period ends.`
			: 'Plan deactivated.',
	});
}
