/**
 * Public snapshot of the Unstoppable Agent — the free read behind /unstoppable.
 *
 * GET /api/agents/unstoppable-public
 *
 * The paid sibling (`/api/agents/unstoppable-status`, $0.01 USDC over x402) is
 * the real-time, full-fidelity read that funds the agent. This endpoint exists
 * so the public dashboard is actually a dashboard: without it, every visitor
 * without a funded wallet saw an empty page of dashes, which is a worse advert
 * for a self-funding agent than showing the numbers one tick late.
 *
 * The split that keeps the paid endpoint worth paying for:
 *   - this response is edge-cached for one agent tick (5 minutes) and carries
 *     `live: false` plus the `as_of` it was generated at, so it can lag by up
 *     to a tick and never reflects revenue that settled since;
 *   - it carries the 8 most recent activity rows; the paid read carries 20;
 *   - a paid call also credits the treasury, so it is the only read that
 *     extends the runway it reports.
 *
 * No auth, IP rate-limited on the shared public bucket. A DB fault degrades to
 * `{ available: false }` with a short cache so the dashboard can render an
 * honest error state instead of fabricated numbers.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { priceFor } from '../_lib/x402-prices.js';
import { getTreasury } from '../../agents/unstoppable/src/treasury.js';
import { getEarnings24h, getCosts24h, getRecentActivity } from '../../agents/unstoppable/src/earnings.js';
import { getLatestReflection } from '../../agents/unstoppable/src/reflection.js';

// One agent tick. The cron in vercel.json runs tick() every 5 minutes, so a
// shorter cache would burn DB reads to re-serve bytes that cannot have changed.
const TTL_SECONDS = 300;

const PUBLIC_ACTIVITY_LIMIT = 8;

const LIVE_ROUTE = '/api/agents/unstoppable-status';
const LIVE_PRICE_ATOMICS = priceFor('unstoppable-status', '10000');

function atomicsToUsdc(atomics) {
	return (Number(atomics) / 1_000_000).toFixed(6);
}

function statusFromMode(mode) {
	if (mode === 'halted') return 'halted';
	if (mode === 'conservation') return 'conservation';
	return 'running';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Every loader below already swallows its own DB error and returns a zeroed
	// value, which would render as a healthy agent sitting at $0.00. Read the
	// treasury once without that safety net so a real outage is reported as an
	// outage: the dashboard's error state is the honest answer, not "broke".
	let treasury;
	try {
		treasury = await getTreasury({ throwOnError: true });
	} catch (err) {
		console.warn('[unstoppable-public] db_unavailable', err?.message || err);
		return json(
			res,
			200,
			{ available: false, reason: 'db_unavailable', live: false, live_endpoint: LIVE_ROUTE },
			{ 'cache-control': 'public, s-maxage=15' },
		);
	}

	const [earnings24h, costs24h, recentActivity, latestReflection] = await Promise.all([
		getEarnings24h(),
		getCosts24h(),
		getRecentActivity(PUBLIC_ACTIVITY_LIMIT),
		getLatestReflection(),
	]);

	return json(
		res,
		200,
		{
			available: true,
			live: false,
			as_of: new Date().toISOString(),
			refresh_seconds: TTL_SECONDS,
			status: statusFromMode(treasury.mode),
			treasury: {
				balance_usdc: atomicsToUsdc(treasury.balance_usdc_atomics),
				balance_usdc_atomics: treasury.balance_usdc_atomics,
				runway_days: Number(treasury.runway_days),
				lifetime_earned_usdc: atomicsToUsdc(treasury.lifetime_earned_atomics),
				lifetime_spent_usdc: atomicsToUsdc(treasury.lifetime_spent_atomics),
			},
			activity_24h: {
				earnings_usdc: atomicsToUsdc(earnings24h),
				costs_usdc: atomicsToUsdc(costs24h),
				net_usdc: atomicsToUsdc(earnings24h - costs24h),
			},
			recent_activity: recentActivity.map((a) => ({
				action_type: a.action_type,
				description: a.description,
				cost_usdc: atomicsToUsdc(a.cost_atomics),
				revenue_usdc: atomicsToUsdc(a.revenue_atomics),
				created_at: a.created_at,
			})),
			latest_reflection: latestReflection
				? {
						date: latestReflection.date,
						summary: latestReflection.summary,
						strategy_notes: latestReflection.strategy_notes,
					}
				: null,
			live_endpoint: LIVE_ROUTE,
			live_price_usdc: atomicsToUsdc(LIVE_PRICE_ATOMICS),
			live_price_atomics: LIVE_PRICE_ATOMICS,
			agent_info: {
				name: 'Unstoppable',
				purpose: 'Self-sustaining autonomous agent on three.ws',
				service: 'Paid status checks via x402',
			},
		},
		{ 'cache-control': `public, s-maxage=${TTL_SECONDS}, stale-while-revalidate=${TTL_SECONDS * 4}` },
	);
});
