/**
 * GET /api/agents/:id/skill-access
 *
 * Public, non-marketplace-gated read of an agent's paid-skill catalog plus the
 * caller's purchased state. The <agent-3d> embed calls this on boot (and after a
 * purchase) to build its skill-access gate. Unlike /api/marketplace/agents/:id,
 * this works for ANY non-deleted agent regardless of marketplace publication —
 * an owner can monetize skills without ever listing the agent publicly, and a
 * valid-but-unlisted agent should not 404 here.
 *
 * Auth is optional: anonymous viewers get an empty purchased_skills list; a
 * signed-in (session or bearer) caller gets their confirmed purchases.
 *
 * Response: { data: { skill_prices, purchased_skills } }
 *   skill_prices:    Record<skill, { amount, currency_mint, chain, mint_decimals,
 *                                    trial_uses, time_pass_hours, time_pass_amount }>
 *   purchased_skills: string[]
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const id = url.searchParams.get('id') || url.pathname.split('/').filter(Boolean)[2];
	if (!id || !UUID_RE.test(id)) return error(res, 404, 'not_found', 'agent not found');

	const [agent] = await sql`
		SELECT id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);

	const [priceRows, purchasedRows] = await Promise.all([
		sql`
			SELECT skill, currency_mint, chain, amount, mint_decimals, trial_uses, time_pass_hours, time_pass_amount
			FROM agent_skill_prices
			WHERE agent_id = ${id} AND is_active = true
		`,
		auth
			? sql`
				SELECT skill FROM skill_purchases
				WHERE user_id = ${auth.userId} AND agent_id = ${id} AND status = 'confirmed'
			`
			: Promise.resolve([]),
	]);

	const skill_prices = Object.fromEntries(
		priceRows.map((p) => [
			p.skill,
			{
				amount: p.amount,
				currency_mint: p.currency_mint,
				chain: p.chain,
				mint_decimals: p.mint_decimals ?? 6,
				trial_uses: p.trial_uses ?? 0,
				time_pass_hours: p.time_pass_hours ?? null,
				time_pass_amount: p.time_pass_amount ?? null,
			},
		]),
	);
	const purchased_skills = purchasedRows.map((r) => r.skill);

	return json(
		res,
		200,
		{ data: { skill_prices, purchased_skills } },
		{ 'cache-control': 'private, max-age=15' },
	);
});
