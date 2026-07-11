// GET /api/defi/protocol?slug=<slug>
// ---------------------------------------------------------------------------
// Rich profile for one DeFi protocol — powers the /protocol/:slug detail page.
// Proxies DeFiLlama's keyless endpoints (no API key) and slims the multi-MB
// upstream payload to exactly what the page renders:
//   · /protocol/{slug}          (required) — TVL history, per-chain TVL, raises,
//                                             hallmarks, mcap, metadata
//   · /summary/fees/{slug}      (optional) — 24h/7d/30d/all-time fees + revenue
//                                            (dailyFees + dailyRevenue passes)
//   · /summary/dexs/{slug}      (optional) — DEX trading volume
// The fees/dexs summaries also carry richer metadata (category, audits,
// methodology, forkedFrom, parentProtocol) than the bare /protocol payload for
// aggregator ("parent") protocols, so missing metadata is enriched from them.
// The full daily TVL history (often 2k+ points) is downsampled server-side to
// ≤400 points so the SVG chart stays light. Cached 5 min in-memory per slug +
// CDN. DeFiLlama is the data source — see the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const SLUG_RE = /^[a-z0-9.-]{1,80}$/i;
const TTL_MS = 300_000;
const MAX_TVL_POINTS = 400;
const UA = 'three.ws/1.0';

const _cache = new Map(); // slug -> { value, expiresAt }

// Coerce numbers and DeFiLlama's occasional numeric strings (audits count, some
// summary totals) to a finite number, else null.
const num = (v) => {
	if (v == null || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\//.test(v.trim()) ? v.trim() : null);

// Synthetic per-chain suffixes DeFiLlama appends to `currentChainTvls` — these
// are not real TVL a chain holds (they double-count borrowed collateral, staked
// governance tokens, LP-side liquidity, or locked vesting), so a "TVL by chain"
// view must exclude them or every chain appears 2–3× with inflated numbers.
const SYNTH_SUFFIX = /-(borrowed|staking|pool2|vesting)$/i;
// …and the whole-protocol aggregates of those same categories.
const AGGREGATE_KEYS = new Set(['borrowed', 'staking', 'pool2', 'vesting']);

async function fetchJson(url) {
	const resp = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': UA },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) {
		const err = new Error(`llama ${resp.status}`);
		err.status = resp.status;
		throw err;
	}
	return resp.json();
}

// Optional upstream — a 4xx (many protocols have no fees/dexs feed) or any other
// failure collapses to null so the section is simply hidden, never an error.
async function fetchOptional(url) {
	try {
		return await fetchJson(url);
	} catch {
		return null;
	}
}

// Reduce the full daily TVL history to ≤MAX points by a fixed stride, always
// keeping the first and last sample so the chart's start and current value are
// exact. Input points are [{ date: unix_s, totalLiquidityUSD }].
function downsampleTvl(series) {
	const clean = [];
	for (const p of Array.isArray(series) ? series : []) {
		const t = num(p?.date);
		const tvl = num(p?.totalLiquidityUSD);
		if (t == null || tvl == null) continue;
		clean.push({ t: Math.floor(t), tvl });
	}
	if (clean.length <= MAX_TVL_POINTS) return clean;
	const stride = Math.ceil(clean.length / MAX_TVL_POINTS);
	const out = [];
	for (let i = 0; i < clean.length; i += stride) out.push(clean[i]);
	const last = clean[clean.length - 1];
	if (out[out.length - 1]?.t !== last.t) out.push(last);
	return out;
}

// Current per-chain TVL sorted desc, excluding the synthetic/aggregate keys.
// Staking + borrowed totals (if the protocol reports them) are surfaced
// separately so the page can note them without polluting the chain breakdown.
function shapeChainTvls(currentChainTvls) {
	const chains = [];
	let staking = null;
	let borrowed = null;
	for (const [key, raw] of Object.entries(currentChainTvls || {})) {
		const val = num(raw);
		if (val == null) continue;
		if (key === 'staking') { staking = val; continue; }
		if (key === 'borrowed') { borrowed = val; continue; }
		if (AGGREGATE_KEYS.has(key)) continue;
		if (SYNTH_SUFFIX.test(key)) continue;
		if (val <= 0) continue;
		chains.push({ chain: key, tvl: val });
	}
	chains.sort((a, b) => b.tvl - a.tvl);
	return { chains, staking, borrowed };
}

// Embedded funding rounds. DeFiLlama reports `amount` in millions of USD, so it
// is scaled to raw dollars here; the page never has to know the unit.
function shapeRaises(raises) {
	if (!Array.isArray(raises) || !raises.length) return null;
	const strList = (a) => (Array.isArray(a) ? a.map(str).filter(Boolean) : []);
	const out = raises
		.map((r) => {
			const amt = num(r?.amount);
			return {
				date: num(r?.date) != null ? Math.floor(num(r.date)) : null,
				round: str(r?.round),
				amount_usd: amt != null ? amt * 1e6 : null,
				leadInvestors: strList(r?.leadInvestors),
				otherInvestors: strList(r?.otherInvestors),
				valuation: num(r?.valuation),
				source: httpUrl(r?.source),
			};
		})
		.sort((a, b) => (b.date || 0) - (a.date || 0));
	return out.length ? out : null;
}

// Timeline annotations: [unix_s, label]. Deduped (upstream occasionally repeats
// an entry) and sorted ascending so chart markers land in chronological order.
function shapeHallmarks(hallmarks) {
	if (!Array.isArray(hallmarks) || !hallmarks.length) return null;
	const seen = new Set();
	const out = [];
	for (const item of hallmarks) {
		if (!Array.isArray(item) || item.length < 2) continue;
		const t = num(item[0]);
		const label = str(item[1]);
		if (t == null || !label) continue;
		const key = `${Math.floor(t)}|${label}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push([Math.floor(t), label]);
	}
	out.sort((a, b) => a[0] - b[0]);
	return out.length ? out : null;
}

function shapeAudits(protoAudits, protoLinks, metaAudits, metaLinks) {
	const count = num(protoAudits ?? metaAudits);
	const src = (Array.isArray(protoLinks) && protoLinks.length ? protoLinks : metaLinks) || [];
	const audit_links = (Array.isArray(src) ? src : []).map(httpUrl).filter(Boolean).slice(0, 6);
	if ((count == null || count === 0) && !audit_links.length) return null;
	return { count: count ?? 0, audit_links };
}

function shapeFees(fees, revenue) {
	if (!fees && !revenue) return null;
	const f = fees || {};
	const r = revenue || {};
	const out = {
		total24h: num(f.total24h),
		total7d: num(f.total7d),
		total30d: num(f.total30d),
		totalAllTime: num(f.totalAllTime),
		revenue24h: num(r.total24h),
		revenue7d: num(r.total7d),
		revenue30d: num(r.total30d),
	};
	return Object.values(out).some((v) => v != null) ? out : null;
}

function shapeDexVolume(dexs) {
	if (!dexs) return null;
	const out = {
		total24h: num(dexs.total24h),
		total7d: num(dexs.total7d),
		change_7dover7d: num(dexs.change_7dover7d),
	};
	return out.total24h != null || out.total7d != null ? out : null;
}

function build(slug, proto, fees, revenue, dexs) {
	// The fees/dexs summaries carry the richest metadata; prefer the /protocol
	// value, fall back to whichever summary is present.
	const meta = fees || dexs || {};
	const tvlSeries = downsampleTvl(proto.tvl);
	const { chains, staking, borrowed } = shapeChainTvls(proto.currentChainTvls);
	const forkedFromSrc =
		(Array.isArray(proto.forkedFrom) && proto.forkedFrom.length ? proto.forkedFrom : meta.forkedFrom) || [];

	return {
		slug,
		name: str(proto.name) || slug,
		symbol: str(proto.symbol) && proto.symbol !== '-' ? proto.symbol : null,
		logo: httpUrl(proto.logo) || httpUrl(meta.logo),
		url: httpUrl(proto.url) || httpUrl(meta.url),
		twitter: str(proto.twitter) || str(meta.twitter),
		category: str(proto.category) || str(meta.category),
		chains: Array.isArray(proto.chains) ? proto.chains.filter((c) => typeof c === 'string') : [],
		audits: shapeAudits(proto.audits, proto.audit_links, meta.audits, meta.audit_links),
		forkedFrom: (Array.isArray(forkedFromSrc) ? forkedFromSrc : []).map(str).filter(Boolean),
		parentProtocol: str(proto.parentProtocol) || str(meta.parentProtocol),
		listedAt: num(proto.listedAt),
		mcap: num(proto.mcap),
		description: (str(proto.description) || str(meta.description) || '').slice(0, 2000) || null,
		methodology: str(proto.methodology) || str(meta.methodology),
		tvl_current: tvlSeries.length ? tvlSeries[tvlSeries.length - 1].tvl : null,
		tvl_series: tvlSeries,
		chain_tvls: chains,
		staking_tvl: staking,
		borrowed_tvl: borrowed,
		hallmarks: shapeHallmarks(proto.hallmarks),
		raises: shapeRaises(proto.raises),
		fees: shapeFees(fees, revenue),
		dex_volume: shapeDexVolume(dexs),
		updated_at: Date.now(),
	};
}

async function load(slug) {
	const now = Date.now();
	const hit = _cache.get(slug);
	if (hit && hit.expiresAt > now) return hit.value;

	// Main call is required; the rest are best-effort enrichment fetched in
	// parallel. The main fetch throwing a 400/404 propagates as not-found.
	const [proto, fees, revenue, dexs] = await Promise.all([
		fetchJson(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`),
		fetchOptional(`https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyFees`),
		fetchOptional(`https://api.llama.fi/summary/fees/${encodeURIComponent(slug)}?dataType=dailyRevenue`),
		fetchOptional(`https://api.llama.fi/summary/dexs/${encodeURIComponent(slug)}`),
	]);

	const value = build(slug, proto, fees, revenue, dexs);
	// Bound the cache so a scan over many distinct slugs can't grow it unbounded.
	if (_cache.size > 500) _cache.clear();
	_cache.set(slug, { value, expiresAt: now + TTL_MS });
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const slug = (params.get('slug') || '').trim().toLowerCase();
	if (!SLUG_RE.test(slug)) {
		return error(res, 400, 'bad_slug', 'slug must be a DeFiLlama protocol slug (1–80 chars: letters, digits, . or -)');
	}

	try {
		const payload = await load(slug);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch (err) {
		// DeFiLlama answers an unknown slug with 400 "Protocol not found" (and 404
		// for some paths) — both mean "no such protocol" to the client.
		if (err?.status === 404 || err?.status === 400) {
			return error(res, 404, 'not_found', `no DeFi protocol found for "${slug}"`);
		}
		return error(res, 502, 'upstream_error', 'DeFi protocol data is unavailable right now — retry shortly');
	}
});
