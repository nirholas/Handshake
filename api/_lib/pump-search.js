// Shared text search over Solana pump.fun / meme tokens by name, symbol, or
// mint. Extracted from api/pump/search.js (the site-wide command palette's
// backend) so a second consumer — api/v1/pump/search.js, the free versioned
// aggregator surface — can reuse the exact same upstream logic instead of a
// copy-paste fork. Both routes call `searchPumpTokens`; neither reimplements
// the Birdeye/pump.fun fallback chain.
//
// Primary source is Birdeye token search (keeps BIRDEYE_API_KEY server-side).
// When Birdeye is unconfigured, rate-limited, or down, falls back to pump.fun's
// public frontend search (no API key) — same response shape — so callers
// degrade to live pump.fun data instead of a hard error. Only throws-free
// (returns null) on either source's failure; the caller decides what an
// all-null result means.
//
// Response item shape: { mint, symbol, name, logo, price_usd, usd_market_cap, rank }

import { normalizeGatewayURL } from '../../src/ipfs.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const PUMP_FRONTEND_BASE = 'https://frontend-api-v3.pump.fun';

/** Birdeye token search. Returns null (not throws) on any failure. */
export async function searchBirdeye(q, limit) {
	if (!BIRDEYE_API_KEY) return null;
	const url =
		`https://public-api.birdeye.so/defi/v3/search` +
		`?chain=solana&target=token&search_mode=fuzzy&sort_by=marketcap&sort_type=desc` +
		`&offset=0&limit=${limit}&keyword=${encodeURIComponent(q)}`;
	let upstream;
	try {
		upstream = await fetch(url, {
			headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana', accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		return null;
	}
	if (!upstream.ok) return null;
	const payload = await upstream.json().catch(() => null);
	// v3 search nests token matches under data.items[].result.
	const groups = payload?.data?.items;
	if (!Array.isArray(groups)) return null;
	const tokens = groups.flatMap((g) => (Array.isArray(g?.result) ? g.result : []));
	const data = tokens
		.map((t) => ({
			mint: t.address,
			symbol: t.symbol || '?',
			name: t.name || t.symbol || '',
			logo: t.logo_uri || t.logoURI || null,
			price_usd: typeof t.price === 'number' ? t.price : null,
			usd_market_cap: typeof t.marketcap === 'number' ? t.marketcap : (typeof t.market_cap === 'number' ? t.market_cap : null),
			rank: null,
		}))
		.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
	return data.length ? data : null;
}

/**
 * Fallback: pump.fun's public frontend search (no API key). Mapped into the
 * exact same shape. pump.fun doesn't expose a clean per-token USD price here,
 * so price_usd is left null rather than fabricated.
 */
export async function searchPumpFun(q, limit) {
	const url = new URL('/coins', PUMP_FRONTEND_BASE);
	url.searchParams.set('searchTerm', q);
	url.searchParams.set('offset', '0');
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('sort', 'market_cap');
	url.searchParams.set('order', 'DESC');
	url.searchParams.set('includeNsfw', 'false');
	let upstream;
	try {
		upstream = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
	} catch {
		return null;
	}
	if (!upstream.ok) return null;
	const body = await upstream.json().catch(() => null);
	const coins = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : null;
	if (!Array.isArray(coins)) return null;
	const data = coins
		.map((c, i) => ({
			mint: c.mint || c.address || '',
			symbol: c.symbol || '?',
			name: c.name || c.symbol || '',
			logo: normalizeGatewayURL(c.image_uri || c.image || '') || null,
			price_usd: null,
			usd_market_cap: typeof c.usd_market_cap === 'number' ? c.usd_market_cap : null,
			rank: i + 1,
		}))
		.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);
	return data.length ? data : null;
}

/**
 * Composed search: Birdeye first (when keyed), pump.fun frontend fallback.
 * Returns `[]` (never null/throws) when both sources have no matches or are
 * unavailable — a miss is a valid, common outcome, not an error.
 */
export async function searchPumpTokens(q, limit) {
	const data = (await searchBirdeye(q, limit)) || (await searchPumpFun(q, limit));
	return data || [];
}
