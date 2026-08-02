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
import { simulatePrice, suggestPrice, toAtomic } from '../../_lib/bundle-pricing.js';

// An atomic price is a bigint in the database (skill_bundles.price_amount) and
// can exceed Number.MAX_SAFE_INTEGER on a 9-decimal mint, so a decimal string is
// accepted alongside the number a JSON client naturally sends. Both normalize to
// a digit string, which the driver binds to the bigint column without ever
// passing through a float.
const atomicPrice = z
	.union([z.number().int().min(1), z.string().trim().regex(/^\d+$/)])
	.transform((v) => String(v))
	.refine((v) => BigInt(v) >= 1n, { message: 'price_amount must be at least 1 atomic unit' });

const createSchema = z.object({
	name:          z.string().trim().min(2).max(80),
	description:   z.string().trim().max(500).optional().default(''),
	price_amount:  atomicPrice,
	currency_mint: z.string().trim().min(1).max(100),
	chain:         z.string().trim().min(1).max(20).default('solana'),
	skills:        z.array(z.string().trim().min(1).max(100)).min(2).max(50),
});

const patchSchema = z.object({
	name:          z.string().trim().min(2).max(80).optional(),
	description:   z.string().trim().max(500).optional(),
	price_amount:  atomicPrice.optional(),
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

	if (req.method === 'GET' && url.searchParams.get('action') === 'pricing')
		return handlePricing(req, res, agentId, url);
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

// ── GET pricing simulation ──────────────────────────────────────────────────
//
// "What should I charge for this bundle?" is the question that stops a seller
// from publishing one, and the honest answer is not a percentage off the sum of
// the parts. It is in the agent's own ledger: some buyers already bought two or
// three of these skills separately, and what they paid is the only real evidence
// of what the combination is worth.
//
// So this endpoint backtests a candidate price against actual history. It finds
// every buyer who purchased 2+ of the chosen skills, sums what each of them
// really paid, and reports what the bundle would have collected from those same
// people instead. A seller sees revenue delta and buyer count from their own
// sales rather than a guess, and a bundle priced above the historical basket is
// shown as the revenue loss it would have been.
//
// Public on purpose: it reads only aggregate counts and the agent's own list
// prices, both of which the marketplace already publishes per skill. No buyer
// identity, and no row-level history, leaves this handler.

const MAX_SIMULATED_SKILLS = 50;

async function handlePricing(req, res, agentId, url) {
	if (!method(req, res, ['GET'])) return;

	const skills = [...new Set(
		(url.searchParams.get('skills') || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	)];
	if (skills.length < 2)
		return error(res, 400, 'validation_error', 'skills must name at least 2 skills, comma separated');
	if (skills.length > MAX_SIMULATED_SKILLS)
		return error(res, 400, 'validation_error', `at most ${MAX_SIMULATED_SKILLS} skills can be simulated at once`);

	// Parsed as text, not Number: an atomic price on a 9-decimal mint can exceed
	// Number.MAX_SAFE_INTEGER, and Number() would round it before validation ever
	// saw the real value.
	const rawPrice = url.searchParams.get('price');
	const askedPrice = rawPrice == null || rawPrice.trim() === '' ? null : rawPrice.trim();
	if (askedPrice !== null && !/^\d+$/.test(askedPrice))
		return error(res, 400, 'validation_error', 'price must be a positive integer in atomic units');
	if (askedPrice !== null && BigInt(askedPrice) < 1n)
		return error(res, 400, 'validation_error', 'price must be a positive integer in atomic units');

	// Per-skill list price and real sales. Money and buyer counts filter to paid
	// kinds, matching the definition /pulse publishes, so a trial or an access row
	// from an earlier bundle can never inflate what a seller sees here.
	const paid = sql`sp.status = 'confirmed' AND sp.kind = ANY(${MARKET_PAID_KINDS})`;
	const parts = await sql`
		SELECT p.skill,
		       MAX(p.amount)                                        AS list_amount,
		       MAX(p.currency_mint)                                 AS currency_mint,
		       MAX(p.chain)                                         AS chain,
		       MAX(p.mint_decimals)                                 AS mint_decimals,
		       COUNT(*) FILTER (WHERE ${paid})::int                 AS units,
		       COALESCE(SUM(sp.amount) FILTER (WHERE ${paid}), 0)::text AS gross_atomic,
		       COUNT(DISTINCT sp.user_id) FILTER (WHERE ${paid})::int   AS buyers
		FROM agent_skill_prices p
		LEFT JOIN skill_purchases sp
		       ON sp.agent_id = p.agent_id AND sp.skill = p.skill
		WHERE p.agent_id = ${agentId} AND p.is_active = true AND p.skill = ANY(${skills})
		GROUP BY p.skill
		ORDER BY p.skill
	`;

	if (!parts.length)
		return error(res, 404, 'not_found', 'none of those skills have an active price on this agent');

	// A skill with no active price cannot be summed, so say which ones were left
	// out rather than quietly pricing a smaller bundle than the seller asked for.
	const pricedSkills = parts.map((p) => p.skill);
	const unpricedSkills = skills.filter((s) => !pricedSkills.includes(s));

	// Currency has to be uniform: adding a $THREE price to a USDC price would
	// produce a number that means nothing.
	const mints = [...new Set(parts.map((p) => p.currency_mint))];
	if (mints.length > 1)
		return error(res, 409, 'mixed_currency', `these skills are priced in ${mints.length} different currencies and cannot be bundled together`);

	const sumOfParts = parts.reduce((sum, p) => sum + toAtomic(p.list_amount), 0n);

	// The historical basket: buyers who took 2+ of these skills, and what each
	// actually paid across them. This is the population a bundle would have
	// converted, so it is the only population worth pricing against.
	const baskets = await sql`
		SELECT sp.user_id,
		       COUNT(DISTINCT sp.skill)::int AS skills_bought,
		       SUM(sp.amount)::text          AS paid_atomic
		FROM skill_purchases sp
		WHERE sp.agent_id = ${agentId}
		  AND sp.skill = ANY(${pricedSkills})
		  AND ${paid}
		GROUP BY sp.user_id
		HAVING COUNT(DISTINCT sp.skill) >= 2
	`;

	const basketTotals = baskets.map((b) => toAtomic(b.paid_atomic));
	const multiBuyers = basketTotals.length;
	const historicalRevenue = basketTotals.reduce((sum, n) => sum + n, 0n);

	// The arithmetic lives in api/_lib/bundle-pricing.js so it can be tested
	// without a database. That matters here: the marketplace has no multi-skill
	// basket at all yet, precisely because bundles were unreachable, so the
	// evidence path has no production rows to exercise it.
	const { price: suggested, basis, median_basket: medianBasket } = suggestPrice(sumOfParts, basketTotals);
	const simulate = (price) => simulatePrice(price, sumOfParts, basketTotals);

	return json(res, 200, {
		data: {
			agent_id: agentId,
			currency_mint: mints[0],
			chain: parts[0].chain,
			// The UI needs this to render a price. Without it every amount here is
			// an atomic integer that a client can only guess the scale of, and the
			// guess is wrong by 10^6 on a $THREE price.
			mint_decimals: Number(parts[0].mint_decimals ?? 6),
			skills: parts.map((p) => ({
				skill: p.skill,
				list_amount: String(p.list_amount),
				units_sold: p.units,
				gross_atomic: p.gross_atomic,
				buyers: p.buyers,
			})),
			unpriced_skills: unpricedSkills,
			sum_of_parts_atomic: sumOfParts.toString(),
			history: {
				multi_skill_buyers: multiBuyers,
				revenue_atomic: String(historicalRevenue),
				median_basket_atomic: medianBasket === null ? null : String(medianBasket),
				// Says out loud whether the suggestion is evidence or a default, so a
				// seller with no history is never misled into reading it as a finding.
				basis,
			},
			suggested: simulate(suggested),
			asked: askedPrice === null ? null : simulate(askedPrice),
		},
	});
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
