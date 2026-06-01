import { z } from 'zod';
import { sql } from '../../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../../_lib/http.js';
import { parse } from '../../../_lib/validate.js';
import { limits, clientIp } from '../../../_lib/rate-limit.js';
import { requireCsrf } from '../../../_lib/csrf.js';

// First char must be alphanumeric; rest may include hyphens; total 1–64 chars.
const SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

const pricingBody = z.object({
	currency_mint: z.string().trim().min(1),
	chain: z.enum(['solana', 'base', 'evm']),
	amount: z.number().int().gt(0),
	is_active: z.boolean().default(true),
});

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

// PUT /api/agents/:id/pricing/:skill  — create or update a skill price (owner only)
// DELETE /api/agents/:id/pricing/:skill — soft-delete; ?hard=true for permanent removal
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'PUT,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PUT', 'DELETE'])) return;

	const urlParts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
	// /api/agents/{id}/pricing/{skill}
	const id = urlParts[2];
	const skill = urlParts[4];

	if (!skill || !SKILL_RE.test(skill)) {
		return error(res, 400, 'validation_error', 'skill must be alphanumeric + hyphens, max 64 chars');
	}

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	// CSRF on state-changing session-cookie requests; bearer tokens are exempt.
	if (!(await requireCsrf(req, res, userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'not your agent');

	if (req.method === 'PUT') {
		const body = parse(pricingBody, await readJson(req));

		const [existing] = await sql`
			SELECT id FROM agent_skill_prices WHERE agent_id = ${id} AND skill = ${skill}
		`;

		await sql`
			INSERT INTO agent_skill_prices
				(agent_id, skill, currency_mint, chain, amount, is_active, updated_at)
			VALUES
				(${id}, ${skill}, ${body.currency_mint}, ${body.chain}, ${body.amount}, ${body.is_active}, now())
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				currency_mint = EXCLUDED.currency_mint,
				chain         = EXCLUDED.chain,
				amount        = EXCLUDED.amount,
				is_active     = EXCLUDED.is_active,
				updated_at    = now()
		`;

		const [row] = await sql`
			SELECT id, skill, currency_mint, chain, amount, is_active
			FROM agent_skill_prices WHERE agent_id = ${id} AND skill = ${skill}
		`;

		return json(res, existing ? 200 : 201, row);
	}

	// DELETE
	const url = new URL(req.url, 'http://x');
	const hard = url.searchParams.get('hard') === 'true';

	if (hard) {
		await sql`DELETE FROM agent_skill_prices WHERE agent_id = ${id} AND skill = ${skill}`;
	} else {
		await sql`
			UPDATE agent_skill_prices SET is_active = false, updated_at = now()
			WHERE agent_id = ${id} AND skill = ${skill}
		`;
	}

	return json(res, 200, { deleted: true });
});
