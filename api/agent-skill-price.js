/**
 * POST /api/agent-skill-price?agentId=:id
 * Single-skill price upsert (legacy entry point).
 * Accepts { skill, amount, currency_mint, chain } — amount=0 deactivates.
 * Canonical bulk endpoint: PUT /api/agents/:id/skills-pricing
 */
import { sql } from './_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from './_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from './_lib/http.js';
import { requireCsrf } from './_lib/csrf.js';
import { clientIp, limits } from './_lib/rate-limit.js';
import { invalidateSkillPriceCache } from './_lib/skill-price-cache.js';
import { isUuid } from './_lib/validate.js';
import { z } from 'zod';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const bodySchema = z.object({
	skill: z.string().trim().min(1).max(100),
	amount: z.number().int().min(0),
	currency_mint: z.string().trim().regex(BASE58_RE, 'invalid mint address'),
	chain: z.string().trim().min(1).max(20).default('solana'),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	// Cookie-session mutation — CSRF required (bearer callers exempt inside requireCsrf).
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const agentId = url.searchParams.get('agentId');
	if (!agentId) return error(res, 400, 'validation_error', 'agentId query param required');
	// agent_identities.id is a uuid column: a non-uuid throws 22P02 in Postgres and
	// surfaces as a 500 (plus a Sentry event and an ops alert) for what is plainly a
	// client fault. Reject the shape before it reaches the query.
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agentId must be a uuid');

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return error(
			res,
			400,
			'validation_error',
			parsed.error.issues[0]?.message || 'validation error',
		);
	}

	const { skill, amount, currency_mint, chain } = parsed.data;

	if (amount === 0) {
		await sql`
			UPDATE agent_skill_prices SET is_active = false, updated_at = now()
			WHERE agent_id = ${agentId} AND skill = ${skill}
		`;
	} else {
		await sql`
			INSERT INTO agent_skill_prices (agent_id, skill, amount, currency_mint, chain, is_active)
			VALUES (${agentId}, ${skill}, ${amount}, ${currency_mint}, ${chain}, true)
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				amount        = EXCLUDED.amount,
				currency_mint = EXCLUDED.currency_mint,
				chain         = EXCLUDED.chain,
				is_active     = true,
				updated_at    = now()
		`;
	}

	await invalidateSkillPriceCache(agentId);
	return json(res, 200, { data: { ok: true } });
});
