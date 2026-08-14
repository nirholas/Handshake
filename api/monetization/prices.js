// GET  /api/monetization/prices?agent_id=X         — list active prices for an agent
// PUT  /api/monetization/prices                     — set/update price for a skill (owner only)
// DELETE /api/monetization/prices                   — remove price for a skill (owner only)
//
// Body (PUT):    { agent_id, skill_name, price_usdc, currency_mint?, chain? }
// Body (DELETE): { agent_id, skill_name, hard? }

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { parse, isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';

const SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// USDC has 6 decimals. 0.000001 USDC = 1 atomic unit.
const MIN_PRICE_ATOMIC = 1;
// Ceiling on a single skill price. Without it an absurd `price_usdc` (1e30, or
// Infinity, which z.number() accepts on its own) is multiplied to atomic units
// and overflows the bigint `amount` column, so Postgres rejects the INSERT and
// the caller gets a 500 where a 400 is the truthful answer.
const MAX_PRICE_USDC = 1_000_000;

const putBody = z
	.object({
		agent_id: z.string().uuid(),
		skill_name: z.string().trim().min(1).max(64).regex(SKILL_RE, 'skill_name must be alphanumeric with hyphens/underscores, max 64 chars'),
		// Required for a price gate; ignored for an NFT gate (access is the holding,
		// not a payment), so optional here and refined below.
		price_usdc: z.number().finite().positive().max(MAX_PRICE_USDC, `price_usdc must be at most ${MAX_PRICE_USDC}`).optional(),
		currency_mint: z.string().trim().min(1).max(100).default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
		chain: z.enum(['solana', 'base', 'evm']).default('solana'),
		// Access gate: 'price' (default) sells the skill; 'nft' restricts it to
		// holders of an NFT from `nft_collection_mint`.
		gate_type: z.enum(['price', 'nft']).default('price'),
		nft_collection_mint: z.string().trim().regex(SOLANA_ADDRESS_RE, 'nft_collection_mint must be a base58 Solana address').nullable().optional(),
	})
	.refine((b) => b.gate_type === 'nft' || typeof b.price_usdc === 'number', {
		message: 'price_usdc is required for a priced skill',
		path: ['price_usdc'],
	})
	.refine((b) => b.gate_type !== 'nft' || !!b.nft_collection_mint, {
		message: 'nft_collection_mint is required for an NFT gate',
		path: ['nft_collection_mint'],
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
		if (!rl.success) return rateLimited(res, rl);

		const params = new URL(req.url, 'http://x').searchParams;
		const agentId = params.get('agent_id');
		if (!agentId || !isUuid(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id query parameter is required and must be a UUID');
		}

		const [agent] = await sql`
			SELECT id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 404, 'not_found', 'Agent not found');

		const prices = await sql`
			SELECT id, skill, currency_mint, chain, amount, is_active,
			       gate_type, nft_collection_mint, created_at, updated_at
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

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt
	// (the token itself proves intent and isn't auto-attached by browsers).
	if (!(await requireCsrf(req, res, userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'PUT') {
		const body = parse(putBody, await readJson(req));
		// API field is `skill_name`; the DB column is `skill`. Bind to a local
		// named `skill` so the SQL reads `${skill}` against the real column.
		const { agent_id, skill_name: skill, price_usdc, currency_mint, chain, gate_type } = body;
		const isNft = gate_type === 'nft';

		// For a price gate, convert price_usdc (float like 0.001) to atomic units.
		// For an NFT gate there is no price — amount is stored as 0 so the row stays
		// a valid (premium, not free) entry while access is driven by the holding.
		const amountAtomic = isNft ? 0 : Math.round(price_usdc * 1_000_000);
		if (!isNft && amountAtomic < MIN_PRICE_ATOMIC) {
			return error(res, 400, 'validation_error', 'price_usdc must be at least 0.000001');
		}
		const nftCollectionMint = isNft ? body.nft_collection_mint : null;

		const ownership = await verifyAgentOwnership(agent_id, userId);
		if (ownership.error) {
			const status = ownership.error === 'not_found' ? 404 : 403;
			return error(res, status, ownership.error, ownership.message);
		}

		const [existing] = await sql`
			SELECT id FROM agent_skill_prices WHERE agent_id = ${agent_id} AND skill = ${skill}
		`;

		// Switching a row's gate type must also reset the columns the CHECK
		// constraint pairs with it (an 'nft' row may not carry trial/time-pass/pwyw
		// price machinery; a 'price' row may not carry a collection mint).
		await sql`
			INSERT INTO agent_skill_prices
				(agent_id, skill, amount, currency_mint, chain, is_active,
				 gate_type, nft_collection_mint, updated_at)
			VALUES
				(${agent_id}, ${skill}, ${amountAtomic}, ${currency_mint}, ${chain}, true,
				 ${isNft ? 'nft' : 'price'}, ${nftCollectionMint}, now())
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				amount              = EXCLUDED.amount,
				currency_mint       = EXCLUDED.currency_mint,
				chain               = EXCLUDED.chain,
				is_active           = true,
				gate_type           = EXCLUDED.gate_type,
				nft_collection_mint = EXCLUDED.nft_collection_mint,
				updated_at          = now()
		`;

		const [row] = await sql`
			SELECT id, skill, currency_mint, chain, amount, is_active,
			       gate_type, nft_collection_mint, created_at, updated_at
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
	const gateType = row.gate_type === 'nft' ? 'nft' : 'price';
	return {
		id: row.id,
		skill_name: row.skill,
		price_usdc: Number(row.amount) / 1_000_000,
		amount_atomic: Number(row.amount),
		currency_mint: row.currency_mint,
		chain: row.chain,
		is_active: row.is_active,
		gate_type: gateType,
		nft_collection_mint: gateType === 'nft' ? row.nft_collection_mint ?? null : null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
