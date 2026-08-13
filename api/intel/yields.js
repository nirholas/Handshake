// GET /api/intel/yields?chain=<name>&project=<slug>&stablecoin=<bool>&limit=<1..100>
// ---------------------------------------------------------------------------
// DeFi yield pools from DeFiLlama's keyless yields API (yields.llama.fi/pools),
// filtered server-side and sorted by TVL desc. Backs the trading copilot and
// future yield-discovery surfaces (consumers land separately: this task
// ships the data layer + endpoint only). Real upstream data, no fabrication.
//
// Response: { pools: [{ pool, project, chain, symbol, tvlUsd, apy, apyBase,
//             apyReward, stablecoin }] }

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getYieldPools } from '../_lib/market-data.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function parseBool(v) {
	if (v === null || v === undefined) return undefined;
	const s = String(v).toLowerCase();
	if (s === 'true' || s === '1') return true;
	if (s === 'false' || s === '0') return false;
	return undefined;
}

function clampLimit(v) {
	const n = parseInt(v ?? '', 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, n);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const chain = params.get('chain') || undefined;
	const project = params.get('project') || undefined;
	const stablecoin = parseBool(params.get('stablecoin'));
	const limit = clampLimit(params.get('limit'));

	try {
		const pools = await getYieldPools({ chain, project, stablecoin, limit });
		return json(
			res,
			200,
			{ pools: pools.map(({ ilRisk, ...rest }) => rest) },
			{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
		);
	} catch {
		return error(res, 502, 'upstream_error', 'DeFi yield data is temporarily unavailable, retry shortly');
	}
});
