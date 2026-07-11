// GET /api/defi/stablecoin?id=<n>
// ---------------------------------------------------------------------------
// Rich profile for ONE stablecoin — powers the /stablecoin/:id detail page.
// Proxies the free, keyless DeFiLlama per-coin endpoint
// (https://stablecoins.llama.fi/stablecoin/{id}) and reshapes its firehose into
// a lean payload: identity + peg metadata, current per-chain circulation with
// dominance share, the full circulating-supply history (downsampled), and the
// circulating history of the top chains. Circulating is denominated in the
// asset's own peg unit (the on-chain market cap). A USD-family asset's price is
// turned into a peg-deviation figure so the page can grade peg health. Cached
// 5m in-memory keyed by id + CDN s-maxage — the source refreshes on the order of
// minutes, not seconds. Mirrors api/defi/stablecoins.js (list) and the
// api/coin/exchange.js detail-handler pattern.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const ID_RE = /^\d{1,6}$/;
const UPSTREAM = (id) => `https://stablecoins.llama.fi/stablecoin/${id}`;
const TTL_MS = 300_000; // 5 minutes — matches the CDN s-maxage below.
const MAX_SUPPLY_POINTS = 400;
const MAX_CHAIN_POINTS = 200;
const TOP_CHAIN_SERIES = 5;

// Per-id in-memory cache. { [id]: { value, expiresAt } }.
const _cache = new Map();

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//.test(v.trim()) ? v.trim() : null);
const num = (v) => {
	if (v == null || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

// DeFiLlama nests every balance under the asset's own peg unit, e.g.
// { peggedUSD: 184_000_000 }. Some fields collapse to a bare 0 when empty
// (minted / unreleased on early rows), so accept a number too.
function pegVal(v, pegType) {
	if (v == null) return null;
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'object') return num(v[pegType]);
	return null;
}

// "peggedUSD" → "USD", "peggedEUR" → "EUR"; anything unexpected passes through.
function pegDisplay(pegType) {
	if (!pegType) return null;
	return pegType.startsWith('pegged') ? pegType.slice(6) : pegType;
}

// DeFiLlama's source data carries a persistent typo — "crytpo-backed" — for a
// slice of assets. Normalize it so the page's fiat/crypto/algorithmic grouping
// never sees two spellings of the same mechanism.
function normalizeMechanism(m) {
	const s = str(m);
	if (!s) return null;
	return s === 'crytpo-backed' ? 'crypto-backed' : s;
}

// Downsample an array to at most `max` entries, always keeping the first and
// last (a supply chart cares most about where the line starts and ends).
function downsample(arr, max) {
	if (!Array.isArray(arr) || arr.length <= max) return arr || [];
	const step = (arr.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
	return out;
}

// Current per-chain circulation → sorted rows with dominance share. Circulating
// is the asset's peg-unit balance on that chain (its on-chain market cap).
function shapeChains(currentChainBalances, pegType) {
	const rows = [];
	let total = 0;
	if (currentChainBalances && typeof currentChainBalances === 'object') {
		for (const [chain, bal] of Object.entries(currentChainBalances)) {
			const circulating = pegVal(bal, pegType);
			if (circulating == null || circulating <= 0) continue;
			total += circulating;
			rows.push({ chain, circulating_usd: circulating });
		}
	}
	rows.sort((a, b) => b.circulating_usd - a.circulating_usd);
	for (const r of rows) r.share_pct = total > 0 ? (r.circulating_usd / total) * 100 : null;
	return rows;
}

// Full circulating-supply history → { t (ms), circulating, minted, unreleased }.
// Upstream `date` is unix seconds; minted/unreleased are best-effort (absent on
// early rows). Filtered to points that carry a finite circulating figure.
function shapeSupplySeries(tokens, pegType) {
	if (!Array.isArray(tokens)) return [];
	const pts = [];
	for (const row of tokens) {
		if (!row || typeof row !== 'object') continue;
		const t = num(row.date);
		const circulating = pegVal(row.circulating, pegType);
		if (t == null || circulating == null) continue;
		pts.push({
			t: t * 1000,
			circulating,
			minted: pegVal(row.minted, pegType),
			unreleased: pegVal(row.unreleased, pegType),
		});
	}
	pts.sort((a, b) => a.t - b.t);
	return downsample(pts, MAX_SUPPLY_POINTS);
}

// Circulating history for the top N chains, ranked by their latest balance.
// chainBalances[chain] = { tokens: [ … ] } with the same row shape as the
// asset-wide `tokens` series.
function shapeChainSeries(chainBalances, pegType, topChains) {
	if (!chainBalances || typeof chainBalances !== 'object') return [];
	const order = topChains.map((c) => c.chain);
	const out = [];
	for (const chain of order.slice(0, TOP_CHAIN_SERIES)) {
		const entry = chainBalances[chain];
		const tokens = entry && Array.isArray(entry.tokens) ? entry.tokens : null;
		if (!tokens) continue;
		const pts = [];
		for (const row of tokens) {
			if (!row || typeof row !== 'object') continue;
			const t = num(row.date);
			const circulating = pegVal(row.circulating, pegType);
			if (t == null || circulating == null) continue;
			pts.push({ t: t * 1000, circulating });
		}
		pts.sort((a, b) => a.t - b.t);
		if (pts.length) out.push({ chain, series: downsample(pts, MAX_CHAIN_POINTS) });
	}
	return out;
}

function shape(raw, id) {
	const pegType = str(raw.pegType);
	const price = num(raw.price);
	// Peg deviation is only meaningful for USD-family assets, whose peg unit is
	// $1.00. A EUR/GBP/etc. price is quoted in USD (~1.08, ~1.27) — comparing it
	// to 1.0 would be nonsense — so it stays null for non-USD pegs.
	const pegDeviationPct =
		pegType === 'peggedUSD' && price != null ? (price - 1) * 100 : null;

	const auditLinks = Array.isArray(raw.auditLinks)
		? raw.auditLinks.map(httpUrl).filter(Boolean)
		: [];

	const chains = shapeChains(raw.currentChainBalances, pegType);

	return {
		id,
		name: str(raw.name) || 'Unknown',
		symbol: str(raw.symbol) || '',
		peg_type: pegDisplay(pegType),
		mechanism: normalizeMechanism(raw.pegMechanism),
		description: str(raw.description),
		mint_redeem: str(raw.mintRedeemDescription),
		url: httpUrl(raw.url),
		twitter: httpUrl(raw.twitter),
		audit_links: auditLinks,
		gecko_id: str(raw.gecko_id),
		price,
		peg_deviation_pct: pegDeviationPct,
		chains,
		supply_series: shapeSupplySeries(raw.tokens, pegType),
		chain_series: shapeChainSeries(raw.chainBalances, pegType, chains),
		updated_at: Date.now(),
	};
}

// Fetches + shapes one stablecoin, cached per id. Throws { status: 404 } when
// the id is unknown upstream so the handler can map it to a clean 404.
async function build(id) {
	const now = Date.now();
	const hit = _cache.get(id);
	if (hit && hit.expiresAt > now) return hit.value;

	const resp = await fetch(UPSTREAM(id), {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (resp.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
	if (!resp.ok) throw new Error(`llama ${resp.status}`);

	const body = await resp.json();
	if (!body || typeof body !== 'object' || body.id == null) {
		throw new Error('unexpected upstream shape');
	}

	const value = shape(body, id);
	_cache.set(id, { value, expiresAt: now + TTL_MS });
	// Bound the map — one entry per distinct id is tiny, but a scanner walking
	// ids could grow it unbounded across a long-lived warm instance.
	if (_cache.size > 512) {
		for (const key of _cache.keys()) {
			if (_cache.get(key).expiresAt <= now) _cache.delete(key);
		}
	}
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const id = (new URL(req.url, 'http://x').searchParams.get('id') || '').trim();
	if (!ID_RE.test(id)) {
		return error(res, 400, 'bad_id', 'id must be a DeFiLlama stablecoin id (1–6 digits)');
	}

	try {
		const payload = await build(id);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch (err) {
		if (err?.status === 404) {
			return error(res, 404, 'not_found', `no stablecoin found for id "${id}"`);
		}
		return error(
			res,
			502,
			'upstream_error',
			'stablecoin data is unavailable right now — retry shortly',
		);
	}
});
