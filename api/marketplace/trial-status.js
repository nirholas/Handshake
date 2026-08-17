/**
 * GET /api/marketplace/trial-status?role=buyer|seller
 *
 * The marketplace's conversion surface. A metered free trial is only a funnel
 * if somebody can see it draining; until this endpoint existed the platform
 * held thousands of live trials and exposed exactly one bit about any of them
 * (`has_access: true|false`), so neither side of a trade could act on the one
 * moment that actually converts: a buyer who liked a skill enough to spend
 * every free run and wants another.
 *
 * Two perspectives, one route:
 *
 *   role=buyer  (default)  the caller's own trials, each with the runs left,
 *                          the price to keep it, and a state to render against.
 *   role=seller            trials running on skills the caller's agents sell,
 *                          aggregated per skill, with the revenue sitting in
 *                          the queue.
 *
 * Privacy: the seller view is deliberately COUNTS ONLY. A seller learns that
 * nine buyers burned through a trial of `icon-set`; they never learn who. The
 * buyer view is scoped to the caller's own rows. Neither view can be widened by
 * a query param, because `role` selects between two fixed queries rather than
 * parameterising one.
 *
 * Auth: session cookie or API-key bearer. Read-only, so no CSRF.
 */

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';

/** Trials whose remaining runs are at or below this share of the grant are "running low". */
const LOW_WATER_SHARE = 1 / 3;

/**
 * Where a trial sits in its life. `exhausted` is the highest-intent state in
 * the marketplace: the buyer used everything they were given and came back.
 */
export function trialState(remaining, granted) {
	const left = Number(remaining ?? 0);
	if (left <= 0) return 'exhausted';
	const total = Number(granted ?? 0);
	if (total > 0 && left / total <= LOW_WATER_SHARE) return 'running-low';
	if (left === 1) return 'running-low';
	return 'fresh';
}

/** A mint's decimal count, clamped to what an SPL mint can actually declare. */
function decimalsOf(decimals) {
	return Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(18, Number(decimals))) : 6;
}

/**
 * Atomic token amounts are strings out of Postgres (they overflow a JS number
 * at 2^53). Format for display without ever going through Number().
 */
export function formatAtomic(atomic, decimals = 6) {
	const raw = String(atomic ?? '0').replace(/[^0-9]/g, '') || '0';
	const d = decimalsOf(decimals);
	const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	if (d === 0) return group(raw.replace(/^0+(?=\d)/, ''));
	const padded = raw.padStart(d + 1, '0');
	const whole = padded.slice(0, -d).replace(/^0+(?=\d)/, '');
	const frac = padded.slice(-d).replace(/0+$/, '');
	const grouped = group(whole);
	return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * Total the queue's potential revenue PER MINT. Atomic amounts are only
 * comparable inside one mint: adding 10 USDC (6dp) to 10 of an 8dp token and
 * printing the result under whichever mint happened to sort first produced a
 * headline number that was wrong by orders of magnitude for any seller who
 * priced two skills in two currencies. Returns the per-mint buckets sorted by
 * size, largest first, so a caller that can only render one number renders the
 * biggest true one rather than a fabricated blend.
 */
export function potentialsByMint(entries) {
	const buckets = new Map();
	for (const e of entries) {
		if (!e?.price || !e.potential?.atomic) continue;
		const key = `${e.price.mint || ''}::${e.price.decimals}`;
		const digits = String(e.potential.atomic).replace(/[^0-9]/g, '');
		const prev = buckets.get(key);
		const total = (prev ? BigInt(prev.atomic) : 0n) + (digits ? BigInt(digits) : 0n);
		buckets.set(key, {
			mint: e.price.mint || null,
			decimals: e.price.decimals,
			atomic: total.toString(),
		});
	}
	// Ordering has to compare the same unit the display string shows, not the raw
	// atomic integer. Atomic counts are only comparable inside one mint (the whole
	// reason the buckets exist), so sorting them directly reintroduced the bug this
	// function was written to kill, one layer up: 0.9 of a 9-decimal token is
	// 900000000 atomic and outranked 5 of a 6-decimal token (5000000), so the
	// headline the seller reads named the SMALLER pile. Scale every bucket to a
	// common exponent first. Without a price oracle this ranks quantity, not fiat
	// value, which is exactly what the number on screen means.
	const list = [...buckets.values()];
	const scale = list.reduce((n, b) => Math.max(n, decimalsOf(b.decimals)), 0);
	const magnitude = (b) => BigInt(b.atomic) * 10n ** BigInt(scale - decimalsOf(b.decimals));
	return list
		.sort((a, b) => {
			const x = magnitude(a);
			const y = magnitude(b);
			return x === y ? 0 : x < y ? 1 : -1;
		})
		.map((b) => ({ ...b, display: formatAtomic(b.atomic, b.decimals) }));
}

function priceOf(row) {
	if (row.amount === null || row.amount === undefined) return null;
	const decimals = row.mint_decimals ?? 6;
	return {
		atomic: String(row.amount),
		decimals,
		display: formatAtomic(row.amount, decimals),
		mint: row.currency_mint || null,
		chain: row.chain || 'solana',
	};
}

/** How many trials one buyer view returns before it starts truncating. */
export const BUYER_LIMIT = 200;

export async function buyerView(userId) {
	const rows = await sql`
		SELECT sp.id, sp.agent_id, sp.skill, sp.trial_remaining, sp.created_at, sp.updated_at,
		       ai.name               AS agent_name,
		       ai.profile_image_url  AS agent_image,
		       asp.trial_uses, asp.amount, asp.currency_mint, asp.chain, asp.mint_decimals,
		       -- Counted over the whole match, before the LIMIT, so a buyer holding
		       -- more trials than one page can carry is told the list is partial
		       -- instead of reading a total that silently stops at the cap.
		       COUNT(*) OVER ()::int AS total_trials
		  FROM skill_purchases sp
		  JOIN agent_identities ai
		    ON ai.id = sp.agent_id AND ai.deleted_at IS NULL
		  LEFT JOIN agent_skill_prices asp
		    ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill AND asp.is_active = true
		 WHERE sp.user_id = ${userId} AND sp.status = 'trial'
		 ORDER BY COALESCE(sp.trial_remaining, 0) ASC, sp.updated_at DESC
		 LIMIT ${BUYER_LIMIT}
	`;

	const trials = rows.map((r) => ({
		purchaseId: r.id,
		agentId: r.agent_id,
		agentName: r.agent_name,
		agentImage: r.agent_image || null,
		skill: r.skill,
		trialRemaining: Number(r.trial_remaining ?? 0),
		trialUses: r.trial_uses === null || r.trial_uses === undefined ? null : Number(r.trial_uses),
		state: trialState(r.trial_remaining, r.trial_uses),
		price: priceOf(r),
		startedAt: r.created_at,
		lastUsedAt: r.updated_at,
		// Canonical, non-redirecting form. `/agent/:id` answers 301 to `/agents/:id`
		// and drops the query string on the way, which silently ate the `?skill=`
		// deep link every conversion CTA carries.
		agentUrl: `/agents/${r.agent_id}`,
	}));

	const total = Number(rows[0]?.total_trials ?? trials.length);

	return {
		role: 'buyer',
		trials,
		total,
		truncated: total > trials.length,
		summary: {
			active: trials.length,
			fresh: trials.filter((t) => t.state === 'fresh').length,
			runningLow: trials.filter((t) => t.state === 'running-low').length,
			exhausted: trials.filter((t) => t.state === 'exhausted').length,
		},
	};
}

export async function sellerView(userId) {
	const rows = await sql`
		SELECT sp.agent_id, sp.skill,
		       ai.name              AS agent_name,
		       ai.profile_image_url AS agent_image,
		       COUNT(*)::int                                                        AS active_trials,
		       COUNT(*) FILTER (WHERE COALESCE(sp.trial_remaining, 0) <= 0)::int    AS exhausted,
		       COUNT(*) FILTER (WHERE COALESCE(sp.trial_remaining, 0) = 1)::int     AS last_run,
		       MAX(sp.updated_at)                                                   AS last_activity,
		       asp.trial_uses, asp.amount, asp.currency_mint, asp.chain, asp.mint_decimals
		  FROM skill_purchases sp
		  JOIN agent_identities ai
		    ON ai.id = sp.agent_id AND ai.deleted_at IS NULL
		  LEFT JOIN agent_skill_prices asp
		    ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill AND asp.is_active = true
		 WHERE ai.user_id = ${userId} AND sp.status = 'trial'
		 GROUP BY sp.agent_id, sp.skill, ai.name, ai.profile_image_url,
		          asp.trial_uses, asp.amount, asp.currency_mint, asp.chain, asp.mint_decimals
		 ORDER BY exhausted DESC, last_run DESC, active_trials DESC
		 LIMIT 200
	`;

	// Sales already made against these same skills, so the queue can be read
	// against a real conversion rate instead of an absolute count nobody can
	// calibrate. Scoped to the caller's agents by the same ownership join.
	const soldRows = await sql`
		SELECT sp.agent_id, sp.skill, COUNT(*)::int AS sold
		  FROM skill_purchases sp
		  JOIN agent_identities ai
		    ON ai.id = sp.agent_id AND ai.deleted_at IS NULL
		 WHERE ai.user_id = ${userId} AND sp.status = 'confirmed'
		 GROUP BY sp.agent_id, sp.skill
	`;
	const sold = new Map(soldRows.map((r) => [`${r.agent_id}::${r.skill}`, r.sold]));

	const queue = rows.map((r) => {
		const price = priceOf(r);
		// What the buyers already at zero would pay if every one of them converted.
		const potential = price ? (BigInt(price.atomic) * BigInt(r.exhausted)).toString() : null;
		const soldCount = sold.get(`${r.agent_id}::${r.skill}`) || 0;
		return {
			agentId: r.agent_id,
			agentName: r.agent_name,
			agentImage: r.agent_image || null,
			skill: r.skill,
			activeTrials: r.active_trials,
			exhausted: r.exhausted,
			lastRun: r.last_run,
			sold: soldCount,
			conversionRate: soldCount + r.active_trials > 0 ? soldCount / (soldCount + r.active_trials) : 0,
			trialUses: r.trial_uses === null || r.trial_uses === undefined ? null : Number(r.trial_uses),
			lastActivity: r.last_activity,
			price,
			potential: price
				? { atomic: potential, display: formatAtomic(potential, price.decimals), mint: price.mint }
				: null,
			agentUrl: `/agents/${r.agent_id}`,
			// The agent editor's monetization panel is where skill prices and trial
			// grants are actually set. The old `/dashboard-next/agent` target was a
			// 404 on every seller row on the page.
			pricingUrl: `/agent/${r.agent_id}/edit?tab=monetization`,
		};
	});

	const potentials = potentialsByMint(queue);
	// The headline figure names its own mint, so the UI never has to guess it
	// from the first row of the queue (which need not be the mint being summed).
	const headline = potentials[0] || { atomic: '0', decimals: 6, display: '0', mint: null };

	return {
		role: 'seller',
		queue,
		summary: {
			skillsWithTrials: queue.length,
			activeTrials: queue.reduce((n, q) => n + q.activeTrials, 0),
			warmLeads: queue.reduce((n, q) => n + q.exhausted, 0),
			lastRun: queue.reduce((n, q) => n + q.lastRun, 0),
			sold: queue.reduce((n, q) => n + q.sold, 0),
			potential: headline,
			potentials,
		},
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const role = new URL(req.url, 'http://x').searchParams.get('role') || 'buyer';
	if (role !== 'buyer' && role !== 'seller') {
		return error(res, 400, 'validation_error', "role must be 'buyer' or 'seller'");
	}

	const data = role === 'seller' ? await sellerView(userId) : await buyerView(userId);
	res.setHeader('Cache-Control', 'private, no-store');
	return json(res, 200, { data });
});
