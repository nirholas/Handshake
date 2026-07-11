// GET /api/defi/fees?type=fees|revenue
// ---------------------------------------------------------------------------
// Protocol fees & revenue for the /fees page. Fetches DeFiLlama's keyless
// /overview/fees dimension feed (no API key). `type=fees` (default) pulls the
// dailyFees series — the total users pay to use a protocol — and `type=revenue`
// pulls dailyRevenue — the slice the protocol itself keeps. Returns whole-market
// 24h/7d/30d totals, the aggregate daily chart (downsampled to ≤200 points), and
// the top 100 protocols by 24h. Each protocol's `slug` resolves at
// api.llama.fi/protocol/{slug} (verified) so the page can deep-link to a
// protocol detail page. Cached 10 min in-memory + CDN. DeFiLlama is the data
// source — see the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const TTL_MS = 600_000;
const MAX_CHART_POINTS = 200;
const MAX_PROTOCOLS = 100;

// One cache slot per data type — the two series are independent upstream calls.
const _cache = new Map(); // type -> { value, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

function upstreamFor(type) {
	const dataType = type === 'revenue' ? 'dailyRevenue' : 'dailyFees';
	return `https://api.llama.fi/overview/fees?excludeTotalDataChartBreakdown=true&dataType=${dataType}`;
}

// Downsample [[unixSeconds, value], …] to at most `max` points as [{t: ms, value}],
// always keeping the final point so the line ends where the data does.
function normalizeChart(raw) {
	const pts = (Array.isArray(raw) ? raw : [])
		.filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
		.map((p) => ({ t: Number(p[0]) * 1000, value: Number(p[1]) }));
	if (pts.length <= MAX_CHART_POINTS) return pts;
	const step = (pts.length - 1) / (MAX_CHART_POINTS - 1);
	const out = [];
	for (let i = 0; i < MAX_CHART_POINTS; i++) out.push(pts[Math.round(i * step)]);
	return out;
}

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-fees endpoint sells the same fees/revenue rankings this page renders.
export async function buildFees(type) {
	const now = Date.now();
	const hit = _cache.get(type);
	if (hit && hit.expiresAt > now) return hit.value;

	const resp = await fetch(upstreamFor(type), {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);
	const raw = await resp.json();
	if (!raw || !Array.isArray(raw.protocols)) throw new Error('unexpected upstream shape');

	const eligible = raw.protocols.filter((p) => Number.isFinite(Number(p?.total24h)));
	eligible.sort((a, b) => Number(b.total24h) - Number(a.total24h));

	const protocols = eligible.slice(0, MAX_PROTOCOLS).map((p) => {
		const chains = Array.isArray(p.chains) ? p.chains.filter((c) => typeof c === 'string') : [];
		return {
			name: typeof p.displayName === 'string' && p.displayName ? p.displayName
				: typeof p.name === 'string' ? p.name : 'Unknown',
			// `slug` is DeFiLlama's canonical protocol key — it resolves at
			// /protocol/{slug} (verified against tether / circle-usdc / uniswap-v3).
			slug: typeof p.slug === 'string' && p.slug ? p.slug : null,
			logo: typeof p.logo === 'string' ? p.logo : null,
			category: typeof p.category === 'string' ? p.category : null,
			chains,
			total24h: finite(Number(p.total24h)),
			total7d: finite(Number(p.total7d)),
			total30d: finite(Number(p.total30d)),
			change_1d: finite(Number(p.change_1d)),
			change_7d: finite(Number(p.change_7d)),
			change_1m: finite(Number(p.change_1m)),
		};
	});

	const value = {
		type: type === 'revenue' ? 'revenue' : 'fees',
		total24h: finite(Number(raw.total24h)),
		total7d: finite(Number(raw.total7d)),
		total30d: finite(Number(raw.total30d)),
		change_1d: finite(Number(raw.change_1d)),
		chart: normalizeChart(raw.totalDataChart),
		protocols,
		updated_at: now,
	};
	_cache.set(type, { value, expiresAt: now + TTL_MS });
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const type = url.searchParams.get('type') === 'revenue' ? 'revenue' : 'fees';

	try {
		const payload = await buildFees(type);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=600, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'Protocol fee data is unavailable right now — retry shortly',
		);
	}
});
