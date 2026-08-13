/**
 * POST /api/marketplace/set-skill-price
 * Single-skill price upsert via the marketplace namespace.
 * Body: { agent_id, skill, amount, currency_mint, chain? }
 * Canonical bulk endpoint: PUT /api/agents/:id/skills-pricing
 */
import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { invalidateSkillPriceCache } from '../_lib/skill-price-cache.js';
import { persistListingSplit, clearListingSplit } from '../_lib/splits.js';
import { z } from 'zod';

// Optional multi-collaborator proceeds split. Each recipient declares a payout
// address and a share (basis points OR percent); the app enforces Σ = 100%.
const splitRecipientSchema = z.object({
	address:           z.string().trim().min(1).max(120),
	share_bps:         z.number().int().positive().max(10000).optional(),
	percent:           z.number().positive().max(100).optional(),
	recipient_user_id: z.string().uuid().nullable().optional(),
	label:             z.string().trim().max(80).optional(),
});

const bodySchema = z.object({
	agent_id:      z.string().uuid(),
	skill:         z.string().trim().min(1).max(100),
	amount:        z.number().int().min(0),
	currency_mint: z.string().trim().min(1).max(100),
	chain:         z.string().trim().min(1).max(20).default('solana'),
	// Pass an array of 2+ recipients to split proceeds; null/[] clears the split.
	// The empty array is deliberately valid: it is how a caller retracts a split
	// without also delisting the skill.
	split:         z.array(splitRecipientSchema).max(50).nullable().optional(),
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, fromSession: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, fromSession: false };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	// Session-cookie writes need CSRF; bearer-token callers are exempt.
	if (auth.fromSession && !(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'request body required');

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'validation_error', parsed.error.issues[0]?.message || 'validation error');
	}

	const { agent_id, skill, amount, currency_mint, chain, split } = parsed.data;

	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agent_id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	// Resolve the proceeds split first so a malformed split (shares not summing
	// to 100%, bad address) is rejected BEFORE we mutate the price row.
	//
	// Three ways a split is retracted, and all three must actually land: the
	// skill is delisted (amount 0), `split` is null, or `split` is []. A clear
	// that silently failed used to leave the old recipient set attached to a
	// price the seller then raised, so the next sale paid collaborators who had
	// been removed. The clear is therefore allowed to fail the request.
	const clearsSplit = amount === 0 || (split !== undefined && (split === null || split.length === 0));
	let splitResult = null;
	try {
		if (clearsSplit) {
			await clearListingSplit(sql, agent_id, skill);
		} else if (split && split.length > 0) {
			splitResult = await persistListingSplit(sql, {
				agentId: agent_id,
				skill,
				chain,
				recipients: split,
				createdBy: auth.userId,
			});
		}
	} catch (e) {
		if (e.status) return error(res, e.status, e.code, e.message);
		throw e;
	}

	if (amount === 0) {
		await sql`
			UPDATE agent_skill_prices SET is_active = false, updated_at = now()
			WHERE agent_id = ${agent_id} AND skill = ${skill}
		`;
	} else {
		await sql`
			INSERT INTO agent_skill_prices (agent_id, skill, amount, currency_mint, chain, is_active)
			VALUES (${agent_id}, ${skill}, ${amount}, ${currency_mint}, ${chain}, true)
			ON CONFLICT (agent_id, skill) DO UPDATE SET
				amount        = EXCLUDED.amount,
				currency_mint = EXCLUDED.currency_mint,
				chain         = EXCLUDED.chain,
				is_active     = true,
				updated_at    = now()
		`;
	}

	await invalidateSkillPriceCache(agent_id);
	return json(res, 200, {
		data: {
			ok: true,
			...(splitResult
				? {
						split: {
							mode: splitResult.split_mode,
							address: splitResult.split_address,
							recipients: splitResult.recipients.map((r) => ({
								address: r.address,
								share_bps: r.share_bps,
								label: r.label,
							})),
						},
					}
				: {}),
		},
	});
});
