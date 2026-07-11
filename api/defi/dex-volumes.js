// GET /api/defi/dex-volumes
// ---------------------------------------------------------------------------
// DEX trading-volume rankings for the /dex-volumes page. Fetches DeFiLlama's
// keyless /overview/dexs dimension feed (no API key). Returns whole-market 24h
// and 7d volume, the aggregate daily volume chart (downsampled to ≤200 points),
// the 7d-over-prior-7d change, and the top 100 DEXs by 24h volume. Each DEX's
// `share_pct` is its slice of the whole-market summed 24h volume, and its `slug`
// resolves at api.llama.fi/protocol/{slug} (verified) so the page can deep-link
// to a protocol detail page. Cached 10 min in-memory + CDN. DeFiLlama is the
// data source — see the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UPSTREAM = 'https://api.llama.fi/overview/dexs?excludeTotalDataChartBreakdown=true';
const TTL_MS = 600_000;
const MAX_CHART_POINTS = 200;
const MAX_PROTOCOLS = 100;

let _cache = null; // { value, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

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
// market-dex-volumes endpoint sells the same DEX rankings this page renders.
export async function buildDexVolumes() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const resp = await fetch(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);
	const raw = await resp.json();
	if (!raw || !Array.isArray(raw.protocols)) throw new Error('unexpected upstream shape');

	const eligible = raw.protocols.filter((p) => Number.isFinite(Number(p?.total24h)));
	// Denominator for `share_pct` spans every DEX with a positive 24h volume, not
	// just the top 100 we return — so a DEX's share reflects the whole market.
	let marketTotal24h = 0;
	for (const p of eligible) {
		const v = Number(p.total24h);
		if (v > 0) marketTotal24h += v;
	}

	eligible.sort((a, b) => Number(b.total24h) - Number(a.total24h));

	const protocols = eligible.slice(0, MAX_PROTOCOLS).map((p) => {
		const chains = Array.isArray(p.chains) ? p.chains.filter((c) => typeof c === 'string') : [];
		const total24h = finite(Number(p.total24h));
		return {
			name: typeof p.displayName === 'string' && p.displayName ? p.displayName
				: typeof p.name === 'string' ? p.name : 'Unknown',
			// `slug` is DeFiLlama's canonical protocol key — it resolves at
			// /protocol/{slug} (verified against uniswap-v3 and peers).
			slug: typeof p.slug === 'string' && p.slug ? p.slug : null,
			logo: typeof p.logo === 'string' ? p.logo : null,
			chains,
			total24h,
			total7d: finite(Number(p.total7d)),
			change_7d: finite(Number(p.change_7d)),
			share_pct: marketTotal24h > 0 && total24h != null ? (total24h / marketTotal24h) * 100 : 0,
		};
	});

	const value = {
		total24h: finite(Number(raw.total24h)),
		total7d: finite(Number(raw.total7d)),
		change_7dover7d: finite(Number(raw.change_7dover7d)),
		chart: normalizeChart(raw.totalDataChart),
		protocols,
		updated_at: now,
	};
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await buildDexVolumes();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=600, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'DEX volume data is unavailable right now — retry shortly',
		);
	}
});
