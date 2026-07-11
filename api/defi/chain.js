// GET /api/defi/chain?name=<chain>
// ---------------------------------------------------------------------------
// Rich profile for one blockchain — powers the /chain/:name detail page.
// Fans out across DeFiLlama's keyless feeds (no API key) and stitches them into
// a single payload the page renders:
//   · /v2/chains                       → this chain's TVL, native token, chainId,
//                                         its rank + dominance share of the
//                                         cross-chain DeFi total
//   · /v2/historicalChainTvl/{name}    → full TVL history, downsampled ≤400 pts
//   · /protocols                       → the protocols deployed on this chain,
//                                         top 50 by their TVL *on this chain*
//   · stablecoins /stablecoincharts    → stablecoin circulating supply history
//   · overview/dexs/{name}             → 24h/7d DEX volume + a volume chart
//   · overview/fees/{name}             → 24h/7d fees
// Only the /v2/chains lookup is load-bearing (it resolves the canonical name and
// the headline stats); every other feed is best-effort via Promise.allSettled,
// so a chain that has no DEX/stablecoin/fees coverage still renders. DeFiLlama
// chain names are case-sensitive ("Ethereum", not "ethereum") — the request name
// is matched case-insensitively against /v2/chains and everything downstream uses
// the canonical casing. Cached ~5 min in-memory per chain + CDN. DeFiLlama is the
// data source — see the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const NAME_RE = /^[a-z0-9 ._-]{1,40}$/i;

const CHAINS_URL = 'https://api.llama.fi/v2/chains';
const CHAINS_TTL_MS = 300_000;
const CHAIN_TTL_MS = 300_000;

const finite = (n) => (Number.isFinite(n) ? n : null);

// ── Upstream helpers ─────────────────────────────────────────────────────────

async function fetchJson(url, { timeout = 10_000 } = {}) {
	const resp = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(timeout),
	});
	if (!resp.ok) {
		const err = new Error(`llama ${resp.status}`);
		err.status = resp.status;
		throw err;
	}
	return resp.json();
}

// Evenly downsample an array to at most `max` items, always keeping the first
// and last (the endpoints anchor a chart's axis + "where it ends now").
function downsample(arr, max) {
	if (!Array.isArray(arr) || arr.length <= max) return arr || [];
	const step = (arr.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
	return out;
}

// ── /v2/chains: canonical-name resolution + market totals ────────────────────

let _chainsCache = null; // { value: { list, totalTvl }, expiresAt }

async function loadChains() {
	const now = Date.now();
	if (_chainsCache && _chainsCache.expiresAt > now) return _chainsCache.value;

	const raw = await fetchJson(CHAINS_URL);
	if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');

	let totalTvl = 0;
	const list = [];
	for (const c of raw) {
		if (typeof c?.name !== 'string') continue;
		const tvl = Number(c.tvl);
		const posTvl = Number.isFinite(tvl) && tvl > 0 ? tvl : 0;
		totalTvl += posTvl;
		list.push({
			name: c.name,
			tvl: posTvl,
			tokenSymbol: typeof c.tokenSymbol === 'string' && c.tokenSymbol ? c.tokenSymbol : null,
			chainId: c.chainId != null && Number.isFinite(Number(c.chainId)) ? Number(c.chainId) : null,
		});
	}
	// Rank is assigned over chains with a positive TVL, highest first.
	const ranked = list.filter((c) => c.tvl > 0).sort((a, b) => b.tvl - a.tvl);
	const rankByName = new Map(ranked.map((c, i) => [c.name, i + 1]));

	const value = { list, totalTvl, rankByName };
	_chainsCache = { value, expiresAt: now + CHAINS_TTL_MS };
	return value;
}

// Resolve the request name to DeFiLlama's exact casing. Exact hit first, then a
// case-insensitive match so /chain/ethereum and /chain/Ethereum both land.
function resolveCanonical(chains, requested) {
	const exact = chains.list.find((c) => c.name === requested);
	if (exact) return exact;
	const lower = requested.toLowerCase();
	return chains.list.find((c) => c.name.toLowerCase() === lower) || null;
}

// ── Optional feeds (best-effort) ─────────────────────────────────────────────

function shapeTvlSeries(raw) {
	if (!Array.isArray(raw)) return [];
	const pts = [];
	for (const p of raw) {
		const t = Number(p?.date) * 1000;
		const tvl = Number(p?.tvl);
		if (Number.isFinite(t) && Number.isFinite(tvl)) pts.push({ t, tvl });
	}
	return downsample(pts, 400);
}

// /protocols → the DeFi protocols on this chain, ranked by their TVL on it.
// CEX "reserves" are excluded for the same reason api/defi/protocols.js drops
// them: a chain's DeFi profile must not be dwarfed by Binance/OKX custody rows.
function shapeProtocols(raw, chainName) {
	if (!Array.isArray(raw)) return { protocols: [], count: 0 };
	const onChain = [];
	for (const p of raw) {
		const chains = Array.isArray(p?.chains) ? p.chains : [];
		if (!chains.includes(chainName)) continue;
		if (typeof p.category === 'string' && p.category.toUpperCase() === 'CEX') continue;
		const tvl = Number(p?.chainTvls?.[chainName]);
		if (!Number.isFinite(tvl) || tvl <= 0) continue;
		onChain.push({
			name: typeof p.name === 'string' ? p.name : 'Unknown',
			slug: typeof p.slug === 'string' ? p.slug : null,
			logo: typeof p.logo === 'string' ? p.logo : null,
			category: typeof p.category === 'string' ? p.category : null,
			tvl_on_chain: tvl,
			change_7d: finite(Number(p.change_7d)),
		});
	}
	onChain.sort((a, b) => b.tvl_on_chain - a.tvl_on_chain);
	return { protocols: onChain.slice(0, 50), count: onChain.length };
}

// stablecoins/stablecoincharts → USD circulating supply per point. Each point
// carries every peg (USD/EUR/…) in its own currency AND converted to USD under
// totalCirculatingUSD; we take the USD-pegged USD figure, the dominant stable
// supply metric. Returns { total, series } with total = the latest point.
function shapeStablecoins(raw) {
	if (!Array.isArray(raw) || !raw.length) return { total: null, series: [] };
	const pts = [];
	for (const p of raw) {
		const t = Number(p?.date) * 1000;
		const usd = Number(p?.totalCirculatingUSD?.peggedUSD);
		if (Number.isFinite(t) && Number.isFinite(usd)) pts.push({ t, total: usd });
	}
	if (!pts.length) return { total: null, series: [] };
	return { total: pts[pts.length - 1].total, series: downsample(pts, 200) };
}

function shapeDex(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const total24h = finite(Number(raw.total24h));
	const total7d = finite(Number(raw.total7d));
	// A chain listed on the DEX overview but with no activity returns total24h:
	// null — nothing to show, so collapse to null and let the page hide the card.
	if (total24h == null && total7d == null) return null;
	const chart = Array.isArray(raw.totalDataChart) ? raw.totalDataChart : [];
	const series = [];
	for (const p of chart) {
		const t = Number(p?.[0]) * 1000;
		const v = Number(p?.[1]);
		if (Number.isFinite(t) && Number.isFinite(v)) series.push({ t, v });
	}
	return {
		total24h,
		total7d,
		change_7dover7d: finite(Number(raw.change_7dover7d)),
		series: downsample(series, 200),
	};
}

function shapeFees(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const total24h = finite(Number(raw.total24h));
	const total7d = finite(Number(raw.total7d));
	if (total24h == null && total7d == null) return null;
	return { total24h, total7d };
}

// ── Per-chain payload (cached by canonical name) ─────────────────────────────

const _chainCache = new Map(); // canonicalName → { value, expiresAt }

async function buildChain(canonical, chains) {
	const now = Date.now();
	const cached = _chainCache.get(canonical.name);
	if (cached && cached.expiresAt > now) return cached.value;

	const enc = encodeURIComponent(canonical.name);
	const [tvlRes, protoRes, stableRes, dexRes, feesRes] = await Promise.allSettled([
		fetchJson(`https://api.llama.fi/v2/historicalChainTvl/${enc}`),
		fetchJson('https://api.llama.fi/protocols'),
		fetchJson(`https://stablecoins.llama.fi/stablecoincharts/${enc}`),
		fetchJson(`https://api.llama.fi/overview/dexs/${enc}?excludeTotalDataChartBreakdown=true`),
		fetchJson(
			`https://api.llama.fi/overview/fees/${enc}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
		),
	]);

	const tvlSeries = tvlRes.status === 'fulfilled' ? shapeTvlSeries(tvlRes.value) : [];
	const { protocols, count: protocolCount } =
		protoRes.status === 'fulfilled'
			? shapeProtocols(protoRes.value, canonical.name)
			: { protocols: [], count: 0 };
	const stablecoins =
		stableRes.status === 'fulfilled' ? shapeStablecoins(stableRes.value) : { total: null, series: [] };
	const dex = dexRes.status === 'fulfilled' ? shapeDex(dexRes.value) : null;
	const fees = feesRes.status === 'fulfilled' ? shapeFees(feesRes.value) : null;

	const rank = chains.rankByName.get(canonical.name) ?? null;
	const share_pct = chains.totalTvl > 0 ? (canonical.tvl / chains.totalTvl) * 100 : null;

	const value = {
		chain: {
			name: canonical.name,
			token_symbol: canonical.tokenSymbol,
			chain_id: canonical.chainId,
			tvl: canonical.tvl,
			rank,
			share_pct,
			defi_total_tvl: chains.totalTvl,
		},
		tvl_series: tvlSeries,
		protocols,
		protocol_count: protocolCount,
		stablecoins,
		dex,
		fees,
		updated_at: now,
	};

	// Bound the cache so a scan across every chain name can't grow it unbounded.
	if (_chainCache.size > 500) _chainCache.clear();
	_chainCache.set(canonical.name, { value, expiresAt: now + CHAIN_TTL_MS });
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const name = (params.get('name') || '').trim();
	if (!NAME_RE.test(name)) {
		return error(
			res,
			400,
			'bad_name',
			'name must be a blockchain name (1–40 chars: letters, digits, spaces, or . _ -)',
		);
	}

	let chains;
	try {
		chains = await loadChains();
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'Chain data is unavailable right now — retry shortly',
		);
	}

	const canonical = resolveCanonical(chains, name);
	if (!canonical) {
		return error(res, 404, 'not_found', `no blockchain found for "${name}"`);
	}

	try {
		const payload = await buildChain(canonical, chains);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'Chain data is unavailable right now — retry shortly',
		);
	}
});
