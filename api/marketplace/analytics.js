/**
 * GET /api/marketplace/analytics
 * Marketplace-wide analytics: top skills, top agents, daily sales volume.
 * Publicly readable — no sensitive user data is exposed (only aggregate counts
 * and revenue totals, with no PII). Admin callers see full data; public callers
 * get a trimmed summary view suitable for the public analytics page.
 */

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Resolve optional auth — admins get the full picture
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;

	// ── Top skills ────────────────────────────────────────────────────────────
	// A `trial` row is a free grant: nothing was paid and `amount` is only the
	// list price it WOULD have cost. Counting trials as sales (and summing their
	// amount as revenue) reported 10,454 sales and 6.2M $THREE of volume on a
	// marketplace with zero completed purchases. Paid and free are now counted
	// separately here and everywhere below; only `status = 'confirmed'` is money.
	const topSkills = await sql`
		SELECT
			sp.skill,
			sp.agent_id,
			ai.name      AS agent_name,
			ai.profile_image_url AS agent_image,
			COUNT(*) FILTER (WHERE sp.status = 'confirmed')            AS total_sales,
			COUNT(*) FILTER (WHERE sp.status = 'trial')                AS total_trials,
			COALESCE(SUM(sp.amount) FILTER (WHERE sp.status = 'confirmed'), 0) AS total_revenue_atomic,
			sp.currency_mint
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id
		WHERE sp.status IN ('confirmed', 'trial')
		GROUP BY sp.skill, sp.agent_id, ai.name, ai.profile_image_url, sp.currency_mint
		ORDER BY total_sales DESC, total_trials DESC
		LIMIT 10
	`;

	// ── Top-earning agents (by net revenue in agent_revenue_events) ───────────
	const topAgents = await sql`
		SELECT
			are.agent_id,
			ai.name        AS agent_name,
			ai.profile_image_url AS agent_image,
			COUNT(DISTINCT are.id)   AS sale_count,
			SUM(are.net_amount)      AS net_revenue,
			are.currency_mint
		FROM agent_revenue_events are
		JOIN agent_identities ai ON ai.id = are.agent_id
		GROUP BY are.agent_id, ai.name, ai.profile_image_url, are.currency_mint
		ORDER BY net_revenue DESC
		LIMIT 10
	`;

	// ── Daily sales volume (last 30 days) ─────────────────────────────────────
	const salesVolume = await sql`
		SELECT
			DATE_TRUNC('day', confirmed_at)::date AS day,
			COUNT(*) AS sales,
			SUM(amount) AS volume_atomic,
			currency_mint
		FROM skill_purchases
		WHERE status = 'confirmed'
		  AND confirmed_at >= NOW() - INTERVAL '30 days'
		GROUP BY day, currency_mint
		ORDER BY day ASC
	`;

	// ── Platform-wide summary stats ───────────────────────────────────────────
	// `unique_buyers` counts people who PAID. Trial-takers are counted on their
	// own line so an empty marketplace reads as empty instead of as busy.
	const [summary] = await sql`
		SELECT
			COUNT(DISTINCT user_id) FILTER (WHERE status = 'confirmed')  AS unique_buyers,
			COUNT(DISTINCT agent_id)                                     AS unique_sellers,
			COUNT(*) FILTER (WHERE status = 'confirmed')                 AS total_sales,
			COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS total_volume_atomic
		FROM skill_purchases
		WHERE status IN ('confirmed', 'trial')
	`;

	// ── Trial funnel ──────────────────────────────────────────────────────────
	// The honest read on a marketplace that offers free trials: how many were
	// granted, how many were actually used, how many ran out (the highest-intent
	// state there is), and how many of those turned into a purchase. A large
	// `exhausted` with a zero `converted` is a broken paywall, not weak demand;
	// `granted` high with `used` at zero means nobody is metering trial runs at
	// all. See docs/marketplace.md "Trials are metered".
	const [funnel] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE sp.status = 'trial')                     AS granted,
			COUNT(*) FILTER (WHERE sp.status = 'trial'
			                   AND asp.trial_uses IS NOT NULL
			                   AND sp.trial_remaining < asp.trial_uses)     AS used,
			COUNT(*) FILTER (WHERE sp.status = 'trial'
			                   AND COALESCE(sp.trial_remaining, 0) <= 0)    AS exhausted,
			COUNT(*) FILTER (WHERE sp.status = 'confirmed')                 AS converted
		FROM skill_purchases sp
		LEFT JOIN agent_skill_prices asp
		       ON asp.agent_id = sp.agent_id AND asp.skill = sp.skill
		WHERE sp.status IN ('confirmed', 'trial')
	`;

	// ── NFT mints count ────────────────────────────────────────────────────────
	const [nftStats] = await sql`
		SELECT COUNT(*) AS total_nfts
		FROM skill_purchases
		WHERE skill_nft_mint IS NOT NULL
	`;

	// ── Recent sales feed (latest individual purchases) ──────────────────────
	// Powers the marketplace "live pulse" ticker — social proof that the market
	// is liquid. No PII: we expose the agent (the seller, already public) and the
	// skill + amount, never the buyer's identity or wallet.
	const recentSales = await sql`
		SELECT
			sp.skill,
			sp.agent_id,
			ai.name              AS agent_name,
			ai.profile_image_url AS agent_image,
			sp.amount,
			sp.currency_mint,
			sp.status,
			sp.confirmed_at
		FROM skill_purchases sp
		JOIN agent_identities ai ON ai.id = sp.agent_id
		WHERE sp.status IN ('confirmed', 'trial')
		  AND sp.confirmed_at IS NOT NULL
		ORDER BY sp.confirmed_at DESC
		LIMIT 16
	`;

	return json(res, 200, {
		data: {
			summary: {
				uniqueBuyers:    Number(summary?.unique_buyers ?? 0),
				uniqueSellers:   Number(summary?.unique_sellers ?? 0),
				totalSales:      Number(summary?.total_sales ?? 0),
				totalVolumeAtomic: String(summary?.total_volume_atomic ?? 0),
				totalNfts:       Number(nftStats?.total_nfts ?? 0),
				// Free grants, reported separately so they can never be read as revenue.
				totalTrials:     Number(funnel?.granted ?? 0),
			},
			trialFunnel: {
				granted:   Number(funnel?.granted ?? 0),
				used:      Number(funnel?.used ?? 0),
				exhausted: Number(funnel?.exhausted ?? 0),
				converted: Number(funnel?.converted ?? 0),
			},
			topSkills: topSkills.map(r => ({
				skill:          r.skill,
				agentId:        r.agent_id,
				agentName:      r.agent_name,
				agentImage:     r.agent_image,
				totalSales:     Number(r.total_sales),
				totalTrials:    Number(r.total_trials ?? 0),
				totalRevenue:   String(r.total_revenue_atomic ?? 0),
				currencyMint:   r.currency_mint,
			})),
			topAgents: topAgents.map(r => ({
				agentId:        r.agent_id,
				agentName:      r.agent_name,
				agentImage:     r.agent_image,
				saleCount:      Number(r.sale_count),
				netRevenue:     String(r.net_revenue ?? 0),
				currencyMint:   r.currency_mint,
			})),
			salesVolume: salesVolume.map(r => ({
				day:          String(r.day),
				sales:        Number(r.sales),
				volumeAtomic: String(r.volume_atomic ?? 0),
				currencyMint: r.currency_mint,
			})),
			recentSales: recentSales.map(r => ({
				skill:        r.skill,
				agentId:      r.agent_id,
				agentName:    r.agent_name,
				agentImage:   r.agent_image,
				amountAtomic: String(r.amount ?? 0),
				currencyMint: r.currency_mint,
				trial:        r.status === 'trial',
				confirmedAt:  r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
			})),
		},
	});
});
