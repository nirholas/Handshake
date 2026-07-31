/**
 * Skill bundle management for an agent.
 *
 * Routes (vercel.json rewrites map /api/agents/:id/bundles → this file):
 *   GET    /api/agents/:id/bundles            list active bundles (public)
 *   GET    /api/agents/:id/bundles?action=pricing&skills=a,b[&price=N]
 *                                             price a candidate bundle against
 *                                             this agent's real sales (public)
 *   POST   /api/agents/:id/bundles            create bundle (auth, agent owner)
 *   PATCH  /api/agents/:id/bundles/:bundleId  update bundle (auth, agent owner)
 *   DELETE /api/agents/:id/bundles/:bundleId  deactivate bundle (auth, agent owner)
 *
 * Every one of these was unreachable in production until 2026-07-31: no route
 * existed, so the /api/agents/:id catch-all answered each call with the AGENT
 * object at 200. See tests/vercel-agents-subpath-routes.test.js.
 */

import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { isUuid } from '../../_lib/validate.js';
import { MARKET_PAID_KINDS } from '../../_lib/marketplace-kinds.js';

const createSchema = z.object({
	name:          z.string().trim().min(2).max(80),
	description:   z.string().trim().max(500).optional().default(''),
	price_amount:  z.number().int().min(1),
	currency_mint: z.string().trim().min(1).max(100),
	chain:         z.string().trim().min(1).max(20).default('solana'),
	skills:        z.array(z.string().trim().min(1).max(100)).min(2).max(50),
});

const patchSchema = z.object({
	name:          z.string().trim().min(2).max(80).optional(),
	description:   z.string().trim().max(500).optional(),
	price_amount:  z.number().int().min(1).optional(),
	skills:        z.array(z.string().trim().min(1).max(100)).min(2).max(50).optional(),
	is_active:     z.boolean().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,PATCH,DELETE,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const agentId  = url.searchParams.get('id')        || parts[2] || null;
	const bundleId = url.searchParams.get('bundle_id') || parts[4] || null;

	if (!agentId || !isUuid(agentId))
		return error(res, 400, 'validation_error', 'valid agent id required');

	if (req.method === 'GET')    return handleList(req, res, agentId);
	if (req.method === 'POST' && !bundleId) return handleCreate(req, res, agentId);
	if (req.method === 'PATCH' && bundleId) return handlePatch(req, res, agentId, bundleId);
	if (req.method === 'DELETE' && bundleId) return handleDelete(req, res, agentId, bundleId);

	return error(res, 405, 'method_not_allowed', 'method not allowed');
});

async function ownerCheck(req, res, agentId) {
	const user = await getSessionUser(req);
	if (!user) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
	`;
	if (!agent) { error(res, 403, 'forbidden', 'not your agent'); return null; }
	return user;
}

// ── GET list ────────────────────────────────────────────────────────────────

async function handleList(req, res, agentId) {
	if (!method(req, res, ['GET'])) return;

	const bundles = await sql`
		SELECT sb.id, sb.name, sb.description, sb.price_amount, sb.currency_mint, sb.chain,
		       sb.is_active, sb.created_at,
		       COALESCE(json_agg(bi.skill_name ORDER BY bi.created_at) FILTER (WHERE bi.skill_name IS NOT NULL), '[]') AS skills
		FROM skill_bundles sb
		LEFT JOIN bundle_items bi ON bi.bundle_id = sb.id
		WHERE sb.agent_id = ${agentId} AND sb.is_active = true
		GROUP BY sb.id
		ORDER BY sb.created_at ASC
	`;

	return json(res, 200, { data: { bundles } });
}

// ── POST create ─────────────────────────────────────────────────────────────

async function handleCreate(req, res, agentId) {
	if (!method(req, res, ['POST'])) return;
	const user = await ownerCheck(req, res, agentId);
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	const parsed = createSchema.safeParse(body);
	if (!parsed.success)
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid input');

	const { name, description, price_amount, currency_mint, chain, skills } = parsed.data;

	const [bundle] = await sql`
		INSERT INTO skill_bundles (agent_id, name, description, price_amount, currency_mint, chain)
		VALUES (${agentId}, ${name}, ${description}, ${price_amount}, ${currency_mint}, ${chain})
		RETURNING id, name, description, price_amount, currency_mint, chain, created_at
	`;

	// Insert bundle items.
	for (const skill of [...new Set(skills)]) {
		await sql`
			INSERT INTO bundle_items (bundle_id, skill_name) VALUES (${bundle.id}, ${skill})
			ON CONFLICT DO NOTHING
		`;
	}

	return json(res, 201, { data: { bundle: { ...bundle, skills } } });
}

// ── PATCH update ────────────────────────────────────────────────────────────

async function handlePatch(req, res, agentId, bundleId) {
	if (!method(req, res, ['PATCH'])) return;
	if (!isUuid(bundleId)) return error(res, 400, 'validation_error', 'invalid bundle id');

	const user = await ownerCheck(req, res, agentId);
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	const parsed = patchSchema.safeParse(body);
	if (!parsed.success)
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid input');

	const { name, description, price_amount, skills, is_active } = parsed.data;

	const [existing] = await sql`
		SELECT id FROM skill_bundles WHERE id = ${bundleId} AND agent_id = ${agentId}
	`;
	if (!existing) return error(res, 404, 'not_found', 'bundle not found');

	await sql`
		UPDATE skill_bundles SET
			name          = COALESCE(${name ?? null}, name),
			description   = COALESCE(${description ?? null}, description),
			price_amount  = COALESCE(${price_amount ?? null}, price_amount),
			is_active     = COALESCE(${is_active ?? null}, is_active),
			updated_at    = now()
		WHERE id = ${bundleId} AND agent_id = ${agentId}
	`;

	if (skills) {
		await sql`DELETE FROM bundle_items WHERE bundle_id = ${bundleId}`;
		for (const skill of [...new Set(skills)]) {
			await sql`
				INSERT INTO bundle_items (bundle_id, skill_name) VALUES (${bundleId}, ${skill})
				ON CONFLICT DO NOTHING
			`;
		}
	}

	return json(res, 200, { data: { ok: true } });
}

// ── DELETE deactivate ────────────────────────────────────────────────────────

async function handleDelete(req, res, agentId, bundleId) {
	if (!method(req, res, ['DELETE'])) return;
	if (!isUuid(bundleId)) return error(res, 400, 'validation_error', 'invalid bundle id');

	const user = await ownerCheck(req, res, agentId);
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	await sql`
		UPDATE skill_bundles SET is_active = false, updated_at = now()
		WHERE id = ${bundleId} AND agent_id = ${agentId}
	`;

	return json(res, 200, { data: { ok: true } });
}
