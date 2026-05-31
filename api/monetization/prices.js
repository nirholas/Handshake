// GET  /api/monetization/prices?agent_id=X         — list active prices for an agent
// PUT  /api/monetization/prices                     — set/update price for a skill (owner only)
// DELETE /api/monetization/prices                   — remove price for a skill (owner only)
//
// Body (PUT):    { agent_id, skill_name, price_usdc, currency_mint?, chain? }
// Body (DELETE): { agent_id, skill_name, hard? }

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// USDC has 6 decimals. 0.000001 USDC = 1 atomic unit.
const MIN_PRICE_ATOMIC = 1;

const putBody = z.object({
	agent_id: z.string().uuid(),
	skill_name: z.string().trim().min(1).max(64).regex(SKILL_RE, 'skill_name must be alphanumeric with hyphens/underscores, max 64 chars'),
	price_usdc: z.number().positive(),
	currency_mint: z.string().trim().min(1).max(100).default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
	chain: z.enum(['solana', 'base', 'evm']).default('solana'),
});

const deleteBody = z.object({
	agent_id: z.string().uuid(),
	skill_name: z.string().trim().min(1).max(64),
	hard: z.boolean().default(false),
});

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

async function verifyAgentOwnership(agentId, userId) {
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return { error: 'not_found', message: 'Agent not found' };
	if (agent.user_id !== userId) return { error: 'forbidden', message: 'You don\'t own this agent' };
	return { agent };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT', 'DELETE'])) return;

	// GET is public for listed agents
	if (req.method === 'GET') {
		const rl = await limits.pricingPerIp(clientIp(req));
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		const params = new URL(req.url, 'http://x').searchParams;
		const agentId = params.get('agent_id');
		if (!agentId || !UUID_RE.test(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id query parameter is required and must be a UUID');
		}

		const [agent] = await sql`
			SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 404, 'not_found', 'Agent not found');

		const prices = await sql`
			SELECT id, skill, currency_mint, chain, amount, is_active, created_at, updated_at
			FROM agent_skill_prices
			WHERE agent_id = ${agentId} AND is_active = true
			ORDER BY skill
		`;

		return json(res, 200, {
			prices: prices.map(formatPrice),
		});
	}

	// PUT and DELETE require auth
	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'Sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'PUT') {
		const body = parse(putBody, await readJson(req));
		// API field is `skill_name`; the DB column is `skill`. Bind to a local
		// named `skill` so the SQL reads `${skill}` against the real column.
		const { agent_id, skill_name: skill, price_usdc, currency_mint, chain } = body;

		// Convert price_usdc (float like 0.001) to atomic units (bigint-safe integer)
		const amountAtomic = Math.round(price_usdc * 1_000_000);
		if (amountAtomic < MIN_PRICE_ATOMIC) {
			return error(res, 400, 'validation_error', 'price_usdc must be at least 0.000001');
		}

		const ownership = await verifyAgentOwnership(agent_id, userId);
		if (ownership.error) {
			const status = ownership.error === 'not_found' ? 404 : 403;
			return error(res, status, ownership.error, ownership.message);
		}

		const [existing] = await sql`
			SELECT id FROM agent_skill_prices WHERE agent_id = ${agent_id} AND skill = ${skill}
		`;

		await sql`
			INSERT INTO agent_skill_prices
				(agent_id, skill, amount, currency_mint, chain, is_active, updated_at)
			VALUES
				(${agent_id}, ${skill}, ${amountAtomic}, ${currency_mint}, ${chain}, true, now())
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				amount        = EXCLUDED.amount,
				currency_mint = EXCLUDED.currency_mint,
				chain         = EXCLUDED.chain,
				is_active     = true,
				updated_at    = now()
		`;

		const [row] = await sql`
			SELECT id, skill, currency_mint, chain, amount, is_active, created_at, updated_at
			FROM agent_skill_prices
			WHERE agent_id = ${agent_id} AND skill = ${skill}
		`;

		return json(res, existing ? 200 : 201, { price: formatPrice(row) });
	}

	// DELETE
	const body = parse(deleteBody, await readJson(req));
	const { agent_id, skill_name: skill, hard } = body;

	const ownership = await verifyAgentOwnership(agent_id, userId);
	if (ownership.error) {
		const status = ownership.error === 'not_found' ? 404 : 403;
		return error(res, status, ownership.error, ownership.message);
	}

	if (hard) {
		const [deleted] = await sql`
			DELETE FROM agent_skill_prices
			WHERE agent_id = ${agent_id} AND skill = ${skill}
			RETURNING id
		`;
		if (!deleted) return error(res, 404, 'not_found', 'Price not found for this skill');
	} else {
		const [updated] = await sql`
			UPDATE agent_skill_prices
			SET is_active = false, updated_at = now()
			WHERE agent_id = ${agent_id} AND skill = ${skill}
			RETURNING id
		`;
		if (!updated) return error(res, 404, 'not_found', 'Price not found for this skill');
	}

	return json(res, 200, { deleted: true, agent_id, skill_name: skill });
});

function formatPrice(row) {
	return {
		id: row.id,
		skill_name: row.skill,
		price_usdc: Number(row.amount) / 1_000_000,
		amount_atomic: Number(row.amount),
		currency_mint: row.currency_mint,
		chain: row.chain,
		is_active: row.is_active,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
