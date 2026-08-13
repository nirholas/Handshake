/**
 * GET /api/intel/heatmap?limit=30
 * --------------------------------
 * The live token field behind the 3D sentiment heatmap on agent screens. Returns
 * a normalized set of tokens ($THREE always pinned first and flagged featured),
 * each carrying the two signals the heatmap renders: 24h price momentum and 24h
 * volume (magnitude). The anchor ($THREE) is additionally enriched with its live
 * 24h order-flow pulse (buys vs sells).
 *
 * Data is fully live, no fabricated arrays:
 *   - Field membership  -> pump.fun frontend-api-v3 /coins (trending by market cap)
 *   - Momentum + volume -> Dexscreener batch /latest/dex/tokens/<mints> (best pair)
 *   - $THREE flow pulse -> the same Dexscreener pair's txns.h24 buys/sells
 *
 * $THREE is the only coin three.ws promotes. The rest of the field is generic,
 * coin-agnostic market plumbing rendered from the live trending feed: this
 * endpoint never names, recommends, or markets any other token. Tiles carry
 * market data only.
 *
 * Response:
 *   {
 *     ok: true,
 *     fetchedAt,
 *     anchor: "<$THREE mint>",
 *     tokens: [ { id, symbol, name, image, priceUsd, change24h, volume24h,
 *                 marketCap, featured, flow? } ],
 *     stale?: true
 *   }
 *
 * `flow` (anchor only) is { buys24h, sells24h, buyPct, score }, where score is
 * (buys - sells) / (buys + sells) in [-1, 1].
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { normalizeGatewayURL } from '../../src/ipfs.js';

// The one and only coin three.ws promotes. Always present, always featured.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';
const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const UPSTREAM_TIMEOUT_MS = 6000;
const TTL_MS = 20_000;
const STALE_MAX_MS = 5 * 60_000;
const FIELD_MAX = 48; // hard cap on field size (incl. $THREE)
const DS_BATCH = 30; // Dexscreener accepts up to 30 comma-separated mints per call

let _cache = { value: null, storedAt: 0, expiresAt: 0, limit: 0 };

// Test seam: the field cache is module state, so a suite exercising more than one
// request has to clear it between cases (mirrors _resetSmartMoneyCache()).
export function _resetHeatmapCache() {
	_cache = { value: null, storedAt: 0, expiresAt: 0, limit: 0 };
}

async function fetchJson(url, init) {
	let res;
	try {
		res = await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	return res.json().catch(() => null);
}

// Trending mints from the public pump.fun feed (no key). Returns mint pubkeys
// only; the per-token market data comes from Dexscreener below.
async function fetchTrendingMints(limit) {
	const url = new URL('/coins', PUMP_FRONTEND_BASE);
	url.searchParams.set('offset', '0');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('sort', 'market_cap');
	url.searchParams.set('order', 'DESC');
	url.searchParams.set('includeNsfw', 'false');
	const body = await fetchJson(url, { headers: { accept: 'application/json' } });
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : null;
	if (!Array.isArray(coins)) return [];
	return coins
		.map((c) => (typeof c.mint === 'string' ? c.mint : typeof c.address === 'string' ? c.address : ''))
		.filter((m) => m.length >= 32);
}

// Best (highest 24h volume) Dexscreener pair per mint, keyed by base token mint.
// One batched call per chunk of up to 30 mints.
async function fetchDexBatch(mints) {
	const byMint = new Map();
	for (let i = 0; i < mints.length; i += DS_BATCH) {
		const chunk = mints.slice(i, i + DS_BATCH);
		const url = `${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`;
		const data = await fetchJson(url, { headers: { accept: 'application/json' } });
		const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
		for (const p of pairs) {
			const mint = p?.baseToken?.address;
			if (!mint || !chunk.includes(mint)) continue;
			const vol = Number(p?.volume?.h24 || 0);
			const prev = byMint.get(mint);
			if (!prev || vol > prev._vol) {
				byMint.set(mint, {
					_vol: vol,
					buys24h: Number(p?.txns?.h24?.buys || 0),
					sells24h: Number(p?.txns?.h24?.sells || 0),
					symbol: p.baseToken?.symbol || null,
					name: p.baseToken?.name || null,
					priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
					change24h: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
					volume24h: vol,
					marketCap: p.marketCap != null ? Number(p.marketCap) : p.fdv != null ? Number(p.fdv) : null,
					image: normalizeGatewayURL(p.info?.imageUrl || '') || null,
				});
			}
		}
	}
	return byMint;
}

// pump.fun metadata for a single mint (name/symbol/image): fills gaps when a
// token has no Dexscreener pair yet, and supplies $THREE's canonical metadata.
async function fetchPumpMeta(mint) {
	const data = await fetchJson(`${PUMP_FRONTEND_BASE}/coins/${mint}`, {
		headers: { accept: 'application/json' },
	});
	if (!data || data.error) return null;
	return {
		symbol: data.symbol || null,
		name: data.name || null,
		image: normalizeGatewayURL(data.image_uri || '') || null,
		marketCap: data.usd_market_cap ?? null,
	};
}

// The anchor's live order-flow pulse, read off the Dexscreener pair we already
// fetched for the tile: how the last 24h of trades split between buyers and
// sellers. Real observed swaps, no extra upstream call.
function flowPulse(d) {
	const buys = Number.isFinite(d?.buys24h) ? d.buys24h : 0;
	const sells = Number.isFinite(d?.sells24h) ? d.sells24h : 0;
	const total = buys + sells;
	if (!total) return null;
	return {
		buys24h: buys,
		sells24h: sells,
		buyPct: Math.round((buys / total) * 100),
		score: Math.round(((buys - sells) / total) * 1000) / 1000,
	};
}

async function buildField(limit) {
	// Pull a slightly wider trending set than requested so that, after dropping
	// $THREE-duplicates and pairless tokens, we can still fill the field.
	const trending = await fetchTrendingMints(Math.min(FIELD_MAX, limit + 8));
	const mints = [THREE_MINT, ...trending.filter((m) => m !== THREE_MINT)].slice(0, limit);

	const [dex, threeMeta] = await Promise.all([
		fetchDexBatch(mints),
		fetchPumpMeta(THREE_MINT),
	]);

	const tokens = [];
	for (const mint of mints) {
		const d = dex.get(mint) || {};
		const featured = mint === THREE_MINT;
		const meta = featured ? threeMeta : null;
		const token = {
			id: mint,
			symbol: d.symbol || meta?.symbol || `${mint.slice(0, 4)}…`,
			name: d.name || meta?.name || null,
			image: d.image || meta?.image || null,
			priceUsd: d.priceUsd ?? null,
			change24h: d.change24h ?? null,
			volume24h: d.volume24h ?? 0,
			marketCap: d.marketCap ?? meta?.marketCap ?? null,
			featured,
		};
		if (featured) {
			const flow = flowPulse(d);
			if (flow) token.flow = flow;
		}
		// Drop non-anchor tokens with no usable signal at all (no price + no
		// volume) so the field never carries dead tiles. $THREE always stays.
		if (!featured && token.priceUsd == null && !token.volume24h) continue;
		tokens.push(token);
	}
	return tokens;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const raw = Number(params.get('limit') || '28');
	const limit = Math.min(FIELD_MAX, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 28));

	const now = Date.now();
	if (_cache.value && _cache.limit >= limit && _cache.expiresAt > now) {
		return json(res, 200, { ok: true, anchor: THREE_MINT, fetchedAt: new Date(_cache.storedAt).toISOString(), tokens: _cache.value.slice(0, limit) }, {
			'cache-control': 'public, max-age=10, s-maxage=20',
		});
	}

	let tokens = [];
	try {
		tokens = await buildField(limit);
	} catch {
		tokens = [];
	}

	// A field with only $THREE (or empty) means the trending/Dexscreener upstreams
	// blipped, so serve the last good field as stale rather than collapsing to the
	// anchor alone, so the heatmap keeps breathing through the outage.
	if (tokens.length <= 1 && _cache.value && now - _cache.storedAt <= STALE_MAX_MS) {
		return json(res, 200, { ok: true, anchor: THREE_MINT, fetchedAt: new Date(_cache.storedAt).toISOString(), tokens: _cache.value.slice(0, limit), stale: true }, {
			'cache-control': 'public, max-age=8, s-maxage=15',
		});
	}

	// No cache to fall back on: a field where nothing carries a live price or
	// volume is the same outage, and the anchor tile alone would render as an
	// empty void. Say so with the designed error instead of shipping a dead field.
	const usable = tokens.some((t) => t.priceUsd != null || t.volume24h > 0);
	if (!tokens.length || !usable) {
		return error(res, 502, 'upstream_error', 'Market data is temporarily unavailable');
	}

	_cache = { value: tokens, storedAt: now, expiresAt: now + TTL_MS, limit };
	return json(res, 200, { ok: true, anchor: THREE_MINT, fetchedAt: new Date(now).toISOString(), tokens }, {
		'cache-control': 'public, max-age=10, s-maxage=20',
	});
});
