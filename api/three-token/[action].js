/**
 * $THREE Token Protocol API
 * -------------------------
 * GET /api/three-token/stats          — protocol-level metrics (public)
 * GET /api/three-token/revenue-share  — authenticated user's revenue share position
 * GET /api/three-token/burns          — deploy-to-burn ledger (per-deploy burns)
 * GET /api/three-token/activity       — protocol activity feed
 * GET /api/three-token/leaderboard    — ranked $THREE holders (public, paginated)
 *
 * Market data (price, market cap, supply, holders) comes from the shared market
 * module — Birdeye → DexScreener → GeckoTerminal failover with a stale cache —
 * so a Birdeye 429 transparently falls over to the keyless sources instead of
 * blanking the price panel. Protocol data (agents, revenue, deploy burns) is
 * derived from the application database; deploy burns = deployed agents ×
 * AGENT_DEPLOY_BURN.
 */

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
import { fetchTokenMarketData } from '../_lib/market/token-market.js';
import { threeHolderBalances, threeHolderCount } from '../_lib/coin/three-holders.js';
import { buybackStats } from '../_lib/token/buyback.js';
import { microbuyStats } from '../_lib/token/microbuy.js';

// Truncate a base58 wallet for display: "FeMb…Jpump".
function shortWallet(addr) {
	const s = String(addr || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// Protocol tokenomics (fixed parameters of the $THREE protocol).
// AGENT_DEPLOY_BURN: $THREE permanently burned each time an agent is deployed.
// REVENUE_SHARE_POOL_PCT: share of platform revenue distributed to holders.
const AGENT_DEPLOY_BURN = 1000;
const REVENUE_SHARE_POOL_PCT = 10;

// Degrade a failed panel query without hiding WHY it failed. A silent
// `.catch(() => [])` is how the deploy-burn ledger shipped permanently empty:
// the query named a column agent_identities never had, the fallback turned the
// error into a plausible zero, and nothing in the logs said otherwise.
function degrade(label, value) {
	return (err) => {
		console.error(`[three-token] ${label} query failed:`, err?.message || err);
		return value;
	};
}

async function fetchPlatformMetrics() {
	const [agentCount, revenueData, paymentCount] = await Promise.all([
		sql`SELECT count(*)::int AS total FROM agent_identities WHERE deleted_at IS NULL`.catch(
			degrade('agent_count', [{ total: 0 }]),
		),
		sql`SELECT coalesce(sum(gross_amount), 0)::bigint AS total_gross, coalesce(sum(fee_amount), 0)::bigint AS total_fee FROM agent_revenue_events`.catch(
			degrade('revenue_totals', [{ total_gross: 0, total_fee: 0 }]),
		),
		sql`SELECT count(*)::int AS total FROM agent_revenue_events`.catch(
			degrade('payment_count', [{ total: 0 }]),
		),
	]);
	return {
		total_agents: agentCount[0]?.total ?? 0,
		total_revenue_gross: Number(revenueData[0]?.total_gross ?? 0),
		total_revenue_fee: Number(revenueData[0]?.total_fee ?? 0),
		total_payments: paymentCount[0]?.total ?? 0,
	};
}

// Deploy-to-burn ledger: each agent deployment burns AGENT_DEPLOY_BURN $THREE.
// We surface the most recent deployments as burn events and the lifetime total
// so the burn figures are derived from real on-chain deployment records rather
// than hardcoded or conflated with revenue.
// `name` is the agent's label everywhere in api/ (agent-task.js,
// autopilot/activity.js); agent_identities has no display column.
async function fetchBurnEvents() {
	const [recent, totalRow] = await Promise.all([
		sql`
			SELECT id, name, created_at
			FROM agent_identities
			WHERE deleted_at IS NULL
			ORDER BY created_at DESC
			LIMIT 20
		`.catch(degrade('burn_events', [])),
		sql`SELECT count(*)::int AS total FROM agent_identities WHERE deleted_at IS NULL`.catch(
			degrade('burn_total', [{ total: 0 }]),
		),
	]);
	return { recent, totalAgents: totalRow[0]?.total ?? 0 };
}

async function fetchRecentActivity() {
	const rows = await sql`
		SELECT
			e.id,
			e.skill,
			e.gross_amount,
			e.fee_amount,
			e.created_at,
			a.name AS agent_name
		FROM agent_revenue_events e
		LEFT JOIN agent_identities a ON a.id = e.agent_id
		ORDER BY e.created_at DESC
		LIMIT 30
	`.catch(degrade('activity_events', []));
	return rows;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const action = parts[2];

	if (action === 'stats') {
		const [market, platform, buyback, microbuy, holderCount] = await Promise.all([
			fetchTokenMarketData(THREE_MINT).catch(() => null),
			fetchPlatformMetrics(),
			// Programmatic buyback summary (revenue → $THREE bought into treasury).
			// Resilient: returns zeros before the first run / migration.
			buybackStats().catch(() => null),
			// High-frequency micro-buy summary (continuous small buys → treasury).
			// Same resilience contract; null before the first buy / migration.
			microbuyStats().catch(() => null),
			// Holder count from our own snapshot — the keyless market sources
			// (DexScreener / GeckoTerminal) don't return holders, so without this the
			// panel shows "—" whenever Birdeye is rate-limited. Cheap meta read only.
			threeHolderCount().catch(() => null),
		]);

		return json(
			res,
			200,
			{
				token: {
					mint: THREE_MINT,
					symbol: '$THREE',
					price_usd: market?.price_usd ?? null,
					price_change_24h: market?.price_change_24h ?? null,
					market_cap: market?.market_cap ?? null,
					volume_24h: market?.volume_24h ?? null,
					holders: market?.holders ?? holderCount ?? null,
					liquidity: market?.liquidity ?? null,
					supply: market?.supply ?? null,
					decimals: market?.decimals ?? 6,
					source: market?.source ?? null,
				},
				protocol: {
					total_agents: platform.total_agents,
					total_revenue_usd: platform.total_revenue_gross / 1_000_000,
					total_payments: platform.total_payments,
					revenue_share_pool_pct: REVENUE_SHARE_POOL_PCT,
					agent_deploy_burn: AGENT_DEPLOY_BURN,
				},
				// Revenue converted to onchain buy pressure — programmatic, no burn.
				// Commitment fields mirror buybackStats() so the page renders the
				// published promise even on a transient stats failure.
				buyback: buyback ?? {
					enabled: false,
					commit_bps: 5000,
					commit_pct: 50,
					committed_usd: 0,
					commitment_progress_pct: 0,
					revenue_usd: 0,
					deployed_usd: 0,
					deployed_pct: 0,
					three_bought: 0,
					runs: 0,
					recent_runs: [],
					last_run: null,
				},
				// Continuous micro-buy pressure (many tiny x402-settled buys → treasury).
				// Sibling of buyback; same resilient default before the first buy.
				microbuy: microbuy ?? {
					enabled: false,
					buy_usd: 0.01,
					lifetime: { buys: 0, confirmed: 0, pending: 0, usdc_deployed: 0, three_bought: 0 },
					today: { buys: 0, usdc_deployed: 0, cap_usd: 50, cap_used_pct: 0 },
				},
			},
			// Edge-cache the public stats at the CDN so most page loads never reach
			// the lambda (or Birdeye). 20s freshness is invisible for a token price;
			// stale-while-revalidate keeps the panel populated during a refresh.
			{ 'cache-control': 'public, s-maxage=20, stale-while-revalidate=120' },
		);
	}

	if (action === 'revenue-share') {
		const user = await getSessionUser(req, res);
		if (!user) return error(res, 401, 'unauthorized', 'sign in required');

		const [platform, market] = await Promise.all([
			fetchPlatformMetrics(),
			fetchTokenMarketData(THREE_MINT).catch(() => null),
		]);

		const totalSupply = market?.supply ?? null;
		const totalRevenue = platform.total_revenue_gross / 1_000_000;
		const poolPct = REVENUE_SHARE_POOL_PCT;
		const revenuePool = totalRevenue * (poolPct / 100);

		return json(res, 200, {
			user_id: user.id,
			token_price: market?.price_usd ?? null,
			total_supply: totalSupply,
			total_holders: market?.holders ?? null,
			platform_revenue_usd: totalRevenue,
			revenue_share_pool_pct: poolPct,
			revenue_share_pool_usd: revenuePool,
			...(totalSupply > 0 ? { per_token_yield: revenuePool / totalSupply } : {}),
		});
	}

	if (action === 'burns') {
		const { recent, totalAgents } = await fetchBurnEvents();
		return json(res, 200, {
			burns: recent.map((a) => ({
				id: a.id,
				agent_name: a.name || 'Agent',
				amount: AGENT_DEPLOY_BURN,
				reason: 'agent_deploy',
				created_at: a.created_at,
			})),
			total_burned: totalAgents * AGENT_DEPLOY_BURN,
			burn_per_deploy: AGENT_DEPLOY_BURN,
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
				agent_name: e.agent_name || 'Agent',
				created_at: e.created_at,
			})),
		});
	}

	if (action === 'leaderboard') {
		// Non-finite input (?limit=abc, ?offset=1e999) falls back to the default
		// rather than propagating NaN/Infinity into the slice and the JSON body.
		const limitRaw = Number(url.searchParams.get('limit'));
		const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(100, Math.floor(limitRaw)) : 50;
		const offsetRaw = Number(url.searchParams.get('offset'));
		const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

		try {
			// Holder set from the cached snapshot (three-holders-snapshot cron) — the
			// full $THREE holder list across all token programs, without a per-request
			// Helius DAS walk. Market data gives supply → % of supply. Both are
			// independently resilient; a market-data blip just nulls the percentages.
			const [balances, market] = await Promise.all([
				threeHolderBalances(),
				fetchTokenMarketData(THREE_MINT).catch(() => null),
			]);

			const decimals = Number(market?.decimals ?? 6);
			const atomicsPerToken = 10 ** decimals;
			const supply = market?.supply != null ? Number(market.supply) : null;

			// Rank by exact atomic balance (BigInt) so huge holders order correctly
			// even past Number's 2^53 precision; only convert to a display Number
			// for the page slice we actually return.
			const ranked = [...balances.entries()]
				.filter(([, atomic]) => atomic > 0n)
				.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));

			const total = ranked.length;
			const holders = ranked.slice(offset, offset + limit).map(([wallet, atomic], i) => {
				const amount = Number(atomic) / atomicsPerToken;
				return {
					rank: offset + i + 1,
					wallet,
					wallet_short: shortWallet(wallet),
					amount,
					pct_of_supply: supply ? amount / supply : null,
				};
			});

			return json(
				res,
				200,
				{ holders, total, limit, offset, supply, mint: THREE_MINT, decimals },
				// Holder sets change slowly; cache at the edge so the Helius scan
				// (seconds, thousands of accounts) runs at most once a minute.
				{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
			);
		} catch (err) {
			// Never 500 a public board — Helius unconfigured / rate-limited returns an
			// empty board so the page renders its empty state instead of an error.
			console.error('[three-token/leaderboard]', err?.message || err);
			return json(
				res,
				200,
				{ holders: [], total: 0, limit, offset, supply: null, mint: THREE_MINT },
				{ 'cache-control': 'public, s-maxage=30' },
			);
		}
	}

	return error(res, 404, 'not_found', `unknown action: ${action}`);
});
