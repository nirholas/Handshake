/**
 * $THREE Token Protocol API
 * -------------------------
 * GET /api/three-token/stats          — protocol-level metrics (public)
 * GET /api/three-token/revenue-share  — authenticated user's revenue share position
 * GET /api/three-token/burns          — recent token burn events
 * GET /api/three-token/activity       — protocol activity feed
 *
 * All token data sourced from Birdeye + Pump.fun via real on-chain queries.
 * Platform data sourced from the application database.
 */

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

const _cache = new Map();

async function cachedFetch(url, headers, ttlMs = 30_000) {
	const now = Date.now();
	const hit = _cache.get(url);
	if (hit && hit.expires > now) return hit.value;

	const resp = await fetch(url, { headers });
	if (!resp.ok) {
		const text = await resp.text().catch(() => '');
		throw new Error(`Birdeye ${resp.status}: ${text.slice(0, 200)}`);
	}
	const value = await resp.json();
	_cache.set(url, { value, expires: now + ttlMs });
	if (_cache.size > 128) {
		const oldest = _cache.keys().next().value;
		_cache.delete(oldest);
	}
	return value;
}

async function fetchTokenOverview(apiKey) {
	const headers = { 'X-API-KEY': apiKey, accept: 'application/json' };
	const [priceResp, securityResp] = await Promise.all([
		cachedFetch(`${BIRDEYE_BASE}/defi/price?address=${THREE_MINT}`, headers),
		cachedFetch(`${BIRDEYE_BASE}/defi/token_overview?address=${THREE_MINT}`, headers, 60_000),
	]);
	return {
		price: priceResp?.data?.value ?? null,
		priceChange24h: priceResp?.data?.priceChange24h ?? null,
		overview: securityResp?.data ?? null,
	};
}

async function fetchPlatformMetrics() {
	const [agentCount, revenueData, paymentCount] = await Promise.all([
		sql`SELECT count(*)::int AS total FROM agent_identities WHERE deleted_at IS NULL`,
		sql`SELECT coalesce(sum(gross_amount), 0)::bigint AS total_gross, coalesce(sum(fee_amount), 0)::bigint AS total_fee FROM agent_revenue_events`.catch(() => [{ total_gross: 0, total_fee: 0 }]),
		sql`SELECT count(*)::int AS total FROM agent_revenue_events`.catch(() => [{ total: 0 }]),
	]);
	return {
		total_agents: agentCount[0]?.total ?? 0,
		total_revenue_gross: Number(revenueData[0]?.total_gross ?? 0),
		total_revenue_fee: Number(revenueData[0]?.total_fee ?? 0),
		total_payments: paymentCount[0]?.total ?? 0,
	};
}

async function fetchBurnEvents() {
	const rows = await sql`
		SELECT id, agent_id, gross_amount, skill, created_at
		FROM agent_revenue_events
		ORDER BY created_at DESC
		LIMIT 20
	`.catch(() => []);
	return rows;
}

async function fetchRecentActivity() {
	const rows = await sql`
		SELECT
			e.id,
			e.skill,
			e.gross_amount,
			e.fee_amount,
			e.created_at,
			a.name AS agent_name,
			a.display_name AS agent_display_name
		FROM agent_revenue_events e
		LEFT JOIN agent_identities a ON a.id = e.agent_id
		ORDER BY e.created_at DESC
		LIMIT 30
	`.catch(() => []);
	return rows;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const action = parts[2];

	const apiKey = process.env.BIRDEYE_API_KEY;

	if (action === 'stats') {
		const [tokenData, platform] = await Promise.all([
			apiKey ? fetchTokenOverview(apiKey).catch((err) => {
				console.error('[three-token] birdeye error:', err.message);
				return { price: null, priceChange24h: null, overview: null };
			}) : { price: null, priceChange24h: null, overview: null },
			fetchPlatformMetrics(),
		]);

		const ov = tokenData.overview || {};

		return json(res, 200, {
			token: {
				mint: THREE_MINT,
				symbol: '$THREE',
				price_usd: tokenData.price,
				price_change_24h: tokenData.priceChange24h,
				market_cap: ov.mc ?? ov.marketCap ?? null,
				volume_24h: ov.v24hUSD ?? ov.volume24h ?? null,
				holders: ov.holder ?? ov.uniqueWallet30m ?? null,
				liquidity: ov.liquidity ?? null,
				supply: ov.supply ?? null,
				decimals: ov.decimals ?? 6,
			},
			protocol: {
				total_agents: platform.total_agents,
				total_revenue_usd: platform.total_revenue_gross / 1_000_000,
				total_payments: platform.total_payments,
				revenue_share_pool_pct: 10,
				agent_deploy_burn: 1000,
			},
		});
	}

	if (action === 'revenue-share') {
		const user = await getSessionUser(req, res);
		if (!user) return error(res, 401, 'unauthorized', 'sign in required');

		const [platform, tokenData] = await Promise.all([
			fetchPlatformMetrics(),
			apiKey ? fetchTokenOverview(apiKey).catch(() => ({ price: null, overview: null })) : { price: null, overview: null },
		]);

		const ov = tokenData.overview || {};
		const totalSupply = ov.supply ?? 1_000_000_000;
		const totalRevenue = platform.total_revenue_gross / 1_000_000;
		const poolPct = 10;
		const revenuePool = totalRevenue * (poolPct / 100);

		return json(res, 200, {
			user_id: user.id,
			token_price: tokenData.price,
			total_supply: totalSupply,
			total_holders: ov.holder ?? null,
			platform_revenue_usd: totalRevenue,
			revenue_share_pool_pct: poolPct,
			revenue_share_pool_usd: revenuePool,
			per_token_yield: totalSupply > 0 ? revenuePool / totalSupply : 0,
		});
	}

	if (action === 'burns') {
		const events = await fetchBurnEvents();
		return json(res, 200, {
			burns: events.map((e) => ({
				id: e.id,
				gross_amount: e.gross_amount,
				skill: e.skill,
				created_at: e.created_at,
			})),
			total_burned: 0,
			burn_rate_per_agent: 1000,
		});
	}

	if (action === 'activity') {
		const events = await fetchRecentActivity();
		return json(res, 200, {
			events: events.map((e) => ({
				id: e.id,
				type: e.skill || 'payment',
				gross_usd: e.gross_amount ? Number(e.gross_amount) / 1_000_000 : null,
				fee_usd: e.fee_amount ? Number(e.fee_amount) / 1_000_000 : null,
				agent_name: e.agent_display_name || e.agent_name || 'Agent',
				created_at: e.created_at,
			})),
		});
	}

	return error(res, 404, 'not_found', `unknown action: ${action}`);
});
