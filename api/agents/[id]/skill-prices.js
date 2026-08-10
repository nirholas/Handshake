/**
 * /api/agents/:id/skill-prices
 * Per-skill price CRUD on the agent's skill catalog.
 *   POST   { skill, amount, currency_mint, chain? }  — set/update one price
 *   PUT    { skill, amount }                          — update amount only
 *   DELETE { skill }                                  — deactivate the price
 *
 * Bulk equivalent (replace-all): PUT /api/agents/:id/skills-pricing
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { invalidateSkillPriceCache } from '../../_lib/skill-price-cache.js';
import { isUuid } from '../../_lib/validate.js';
import { z } from 'zod';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const upsertSchema = z
	.object({
		skill: z.string().trim().min(1).max(100),
		// Required for a price gate; stored as 0 for an NFT gate (access = holding).
		amount: z.number().int().min(1).optional(),
		currency_mint: z.string().trim().min(1).max(100),
		chain: z.string().trim().min(1).max(20).default('solana'),
		gate_type: z.enum(['price', 'nft']).default('price'),
		nft_collection_mint: z.string().trim().regex(SOLANA_ADDRESS_RE).nullable().optional(),
	})
	.refine((p) => p.gate_type === 'nft' || (p.amount ?? 0) >= 1, {
		message: 'amount is required for a priced skill',
		path: ['amount'],
	})
	.refine((p) => p.gate_type !== 'nft' || !!p.nft_collection_mint, {
		message: 'nft_collection_mint is required for an NFT gate',
		path: ['nft_collection_mint'],
	});

const updateSchema = z.object({
	skill: z.string().trim().min(1).max(100),
	amount: z.number().int().min(1),
});

const deleteSchema = z.object({
	skill: z.string().trim().min(1).max(100),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'PUT', 'DELETE'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const agentId = url.searchParams.get('id') || parts[2];
	if (!agentId) return error(res, 400, 'validation_error', 'agent id required');
	// This handler is reached by its own vercel.json rewrite, so the uuid gate in
	// api/agents/[id].js never runs for it. A malformed id would otherwise hit a
	// uuid column and turn Postgres 22P02 into a 500.
	if (!isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	if (req.method === 'POST') {
		const parsed = upsertSchema.safeParse(body);
		if (!parsed.success) {
			return error(
				res,
				400,
				'validation_error',
				parsed.error.issues[0]?.message || 'invalid',
			);
		}
		const { skill, currency_mint, chain, gate_type } = parsed.data;
		const isNft = gate_type === 'nft';
		const amount = isNft ? 0 : parsed.data.amount;
		const nftCollectionMint = isNft ? parsed.data.nft_collection_mint : null;
		await sql`
			INSERT INTO agent_skill_prices
				(agent_id, skill, amount, currency_mint, chain, is_active, gate_type, nft_collection_mint)
			VALUES (${agentId}, ${skill}, ${amount}, ${currency_mint}, ${chain}, true,
				${isNft ? 'nft' : 'price'}, ${nftCollectionMint})
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				amount              = EXCLUDED.amount,
				currency_mint       = EXCLUDED.currency_mint,
				chain               = EXCLUDED.chain,
				is_active           = true,
				gate_type           = EXCLUDED.gate_type,
				nft_collection_mint = EXCLUDED.nft_collection_mint,
				updated_at          = now()
		`;
		await invalidateSkillPriceCache(agentId);
		return json(res, 200, { data: { ok: true } });
	}

	if (req.method === 'PUT') {
		const parsed = updateSchema.safeParse(body);
		if (!parsed.success) {
			return error(
				res,
				400,
				'validation_error',
				parsed.error.issues[0]?.message || 'invalid',
			);
		}
		const { skill, amount } = parsed.data;
		const r = await sql`
			UPDATE agent_skill_prices
			SET amount = ${amount}, updated_at = now()
			WHERE agent_id = ${agentId} AND skill = ${skill}
			RETURNING agent_id
		`;
		if (r.length === 0) return error(res, 404, 'not_found', 'no existing price for this skill');
		await invalidateSkillPriceCache(agentId);
		return json(res, 200, { data: { ok: true } });
	}

	// DELETE — soft-deactivate
	const parsed = deleteSchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'invalid');
	}
	await sql`
		UPDATE agent_skill_prices
		SET is_active = false, updated_at = now()
		WHERE agent_id = ${agentId} AND skill = ${parsed.data.skill}
	`;
	await invalidateSkillPriceCache(agentId);
	return json(res, 200, { data: { ok: true } });
});
