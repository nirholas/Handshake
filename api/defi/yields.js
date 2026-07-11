// GET /api/defi/yields — DeFi yield pools for the /yields explorer.
// ---------------------------------------------------------------------------
// Two modes over DeFiLlama's keyless yields API (yields.llama.fi):
//
//   List  — GET /api/defi/yields?chain=&project=&stablecoin=&search=&minTvl=
//                &sort=tvl|apy&limit=&offset=
//           Fetches /pools (a multi-MB payload of ~15k pools), slims each pool
//           to the fields the page renders, caches the slimmed set in-memory
//           for 10 min, then filters / sorts / pages per request. The response
//           also carries filter-agnostic facets (top chains + projects by pool
//           TVL) for the page's dropdowns and whole-dataset stats.
//
//   Chart — GET /api/defi/yields?pool=<uuid>
//           Fetches /chart/{pool} (per-pool APY + TVL history) and downsamples
//           it to ≤300 points. Unknown pools 404 rather than 502.
//
// DeFiLlama is the data source — see the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const POOLS_UPSTREAM = 'https://yields.llama.fi/pools';
const CHART_UPSTREAM = 'https://yields.llama.fi/chart/';
const POOLS_TTL_MS = 600_000;
const CHART_TTL_MS = 600_000;
const CHART_CACHE_MAX = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const CHART_MAX_POINTS = 300;
// APY sorting and the median-APY stat only consider pools above this TVL floor:
// dust pools routinely report five-digit APYs on three digits of liquidity,
// which would otherwise bury every real pool under spam.
const APY_MIN_TVL = 10_000;
const FACET_CHAINS = 30;
const FACET_PROJECTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const finite = (n) => (Number.isFinite(n) ? n : null);

// ── Pools cache ─────────────────────────────────────────────────────────────

let _pools = null; // { value: { pools, facets, stats, updated_at }, expiresAt }
let _poolsInflight = null; // dedupe concurrent multi-MB upstream fetches

function slimPool(p) {
	const tvl = Number(p?.tvlUsd);
	return {
		pool: p.pool,
		chain: typeof p.chain === 'string' ? p.chain : 'Unknown',
		project: typeof p.project === 'string' ? p.project : 'unknown',
		symbol: typeof p.symbol === 'string' ? p.symbol : '—',
		tvl_usd: tvl,
		apy: finite(Number(p.apy)),
		apy_base: finite(Number(p.apyBase)),
		apy_reward: finite(Number(p.apyReward)),
		apy_mean_30d: finite(Number(p.apyMean30d)),
		apy_change_1d: finite(Number(p.apyPct1D)),
		apy_change_7d: finite(Number(p.apyPct7D)),
		il_risk: typeof p.ilRisk === 'string' ? p.ilRisk : null,
		exposure: typeof p.exposure === 'string' ? p.exposure : null,
		stablecoin: p.stablecoin === true,
		outlook: typeof p.predictions?.predictedClass === 'string' ? p.predictions.predictedClass : null,
		outlook_confidence: finite(Number(p.predictions?.predictedProbability)),
		pool_meta: typeof p.poolMeta === 'string' && p.poolMeta ? p.poolMeta : null,
	};
}

function median(sorted) {
	if (!sorted.length) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Top-N (chain|project) facets by summed pool TVL, with pool counts, over the
// FULL dataset — the dropdowns must offer every major venue regardless of the
// caller's current filters.
function buildFacets(pools, key, topN) {
	const agg = new Map(); // name → { tvl, count }
	for (const p of pools) {
		const name = p[key];
		const cur = agg.get(name) || { tvl: 0, count: 0 };
		cur.tvl += p.tvl_usd;
		cur.count += 1;
		agg.set(name, cur);
	}
	return [...agg.entries()]
		.sort((a, b) => b[1].tvl - a[1].tvl)
		.slice(0, topN)
		.map(([name, { count }]) => ({ name, pool_count: count }));
}

async function loadPools() {
	const now = Date.now();
	if (_pools && _pools.expiresAt > now) return _pools.value;
	if (_poolsInflight) return _poolsInflight;

	_poolsInflight = (async () => {
		const resp = await fetch(POOLS_UPSTREAM, {
			headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!resp.ok) throw new Error(`llama yields ${resp.status}`);
		const raw = await resp.json();
		if (!Array.isArray(raw?.data)) throw new Error('unexpected upstream shape');

		const pools = [];
		for (const p of raw.data) {
			if (typeof p?.pool !== 'string') continue;
			const tvl = Number(p.tvlUsd);
			if (!Number.isFinite(tvl) || tvl < 0) continue;
			pools.push(slimPool(p));
		}
		// Default presentation order is TVL desc; sorting once at build time makes
		// every default-list request a pure slice.
		pools.sort((a, b) => b.tvl_usd - a.tvl_usd);

		const apys = pools
			.filter((p) => p.tvl_usd >= APY_MIN_TVL && p.apy != null)
			.map((p) => p.apy)
			.sort((a, b) => a - b);

		const value = {
			pools,
			facets: {
				chains: buildFacets(pools, 'chain', FACET_CHAINS),
				projects: buildFacets(pools, 'project', FACET_PROJECTS),
			},
			stats: {
				pool_count: pools.length,
				total_tvl: pools.reduce((sum, p) => sum + p.tvl_usd, 0),
				median_apy: median(apys),
			},
			updated_at: Date.now(),
		};
		_pools = { value, expiresAt: Date.now() + POOLS_TTL_MS };
		return value;
	})();

	try {
		return await _poolsInflight;
	} finally {
		_poolsInflight = null;
	}
}

// ── List mode ───────────────────────────────────────────────────────────────

function parseBool(v) {
	if (v == null) return undefined;
	const s = String(v).toLowerCase();
	if (s === 'true' || s === '1') return true;
	if (s === 'false' || s === '0') return false;
	return undefined;
}

function clampInt(v, { def, min, max }) {
	const n = parseInt(v ?? '', 10);
	if (!Number.isFinite(n)) return def;
	return Math.max(min, Math.min(max, n));
}

async function listMode(req, res, params) {
	const chain = (params.get('chain') || '').trim().toLowerCase();
	const project = (params.get('project') || '').trim().toLowerCase();
	const stablecoin = parseBool(params.get('stablecoin'));
	const search = (params.get('search') || '').trim().toLowerCase();
	const minTvl = Math.max(0, Number(params.get('minTvl')) || 0);
	const sort = params.get('sort') === 'apy' ? 'apy' : 'tvl';
	const limit = clampInt(params.get('limit'), { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
	const offset = clampInt(params.get('offset'), { def: 0, min: 0, max: 1_000_000 });

	const { pools, facets, stats, updated_at } = await loadPools();

	let rows = pools.filter((p) => {
		if (chain && p.chain.toLowerCase() !== chain) return false;
		if (project && p.project.toLowerCase() !== project) return false;
		if (stablecoin !== undefined && p.stablecoin !== stablecoin) return false;
		if (minTvl && p.tvl_usd < minTvl) return false;
		if (search && !`${p.symbol} ${p.project} ${p.chain}`.toLowerCase().includes(search)) return false;
		return true;
	});

	if (sort === 'apy') {
		// Dust-pool guard: never let a $200 pool advertising 80,000% APY outrank
		// real venues. Only pools above the TVL floor are eligible for APY order.
		rows = rows
			.filter((p) => p.tvl_usd >= APY_MIN_TVL && p.apy != null)
			.sort((a, b) => b.apy - a.apy);
	}
	// sort === 'tvl' needs no work — the cache is already TVL desc.

	return json(
		res,
		200,
		{
			pools: rows.slice(offset, offset + limit),
			total: rows.length,
			limit,
			offset,
			sort,
			facets,
			stats,
			updated_at,
		},
		{ 'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600' },
	);
}

// ── Chart mode ──────────────────────────────────────────────────────────────

const _charts = new Map(); // pool uuid → { value, expiresAt }

// Even stride over the series, always keeping the last point (the chart cares
// most about where the line ends).
function downsample(points, max) {
	if (points.length <= max) return points;
	const step = (points.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
	return out;
}

async function loadChart(pool) {
	const now = Date.now();
	const hit = _charts.get(pool);
	if (hit && hit.expiresAt > now) return hit.value;

	const resp = await fetch(`${CHART_UPSTREAM}${pool}`, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(15_000),
	});
	// DeFiLlama answers an unknown pool id with a non-200 or an empty data set;
	// both mean "no history for this pool", not an outage.
	if (resp.status === 404 || resp.status === 400) return null;
	if (!resp.ok) throw new Error(`llama chart ${resp.status}`);
	const raw = await resp.json();
	if (!Array.isArray(raw?.data)) throw new Error('unexpected upstream shape');

	const points = [];
	for (const d of raw.data) {
		const t = Date.parse(d?.timestamp);
		if (!Number.isFinite(t)) continue;
		points.push({ t, apy: finite(Number(d.apy)), tvl_usd: finite(Number(d.tvlUsd)) });
	}
	if (!points.length) return null;

	const value = { pool, points: downsample(points, CHART_MAX_POINTS), updated_at: now };
	if (_charts.size >= CHART_CACHE_MAX) {
		// Drop the stalest entry so a browse across many pools stays bounded.
		const oldest = [..._charts.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
		if (oldest) _charts.delete(oldest[0]);
	}
	_charts.set(pool, { value, expiresAt: now + CHART_TTL_MS });
	return value;
}

async function chartMode(req, res, pool) {
	if (!UUID_RE.test(pool)) {
		return error(res, 400, 'invalid_pool', 'pool must be a DeFiLlama pool uuid');
	}
	const value = await loadChart(pool.toLowerCase());
	if (!value) {
		return error(res, 404, 'pool_not_found', 'no APY/TVL history for this pool id');
	}
	return json(res, 200, value, {
		'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1200',
	});
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const pool = params.get('pool');

	try {
		if (pool) return await chartMode(req, res, pool);
		return await listMode(req, res, params);
	} catch (err) {
		// 4xx from the mode handlers (invalid uuid, unknown pool) already returned;
		// anything thrown here is upstream trouble.
		if (err?.status && err.status < 500) throw err;
		return error(
			res,
			502,
			'upstream_error',
			'DeFi yield data is unavailable right now — retry shortly',
		);
	}
});
