// GET  /api/crypto/symbol?symbols=A,B,C&chain=solana
// POST /api/crypto/symbol   { symbols: string[] (max 20), chain?: 'solana' }
//
// FREE, keyless symbol-availability check. Given up to 20 candidate ticker
// symbols, returns per-symbol exact + fuzzy collisions across live token
// registries so an agent can pick a name that won't be lost among clones
// BEFORE it commits to a launch.
//
// Agent use-case: an agent about to launch a token wants to check candidate
// tickers for collisions (exact name clashes + look-alikes that dilute search)
// before minting. A free batch check is the natural top-of-funnel for the paid
// Pump Launcher (/api/x402/pump-launch) — clear the name here, launch there.
//
// Data source: DexScreener's keyless search API (every chain it indexes),
// deduped by mint and scored locally with a pg_trgm-style trigram Jaccard
// similarity — the same exact-plus-fuzzy collision model the retired paid route
// (api/x402/symbol-availability.js) ran against three.ws's own mint index, but
// broadened to the whole market and made free. No key, no account.

import { wrap, cors, method, json, error, readJson, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';

const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search';

// Cap the batch so one call can't fan out into an unbounded DexScreener sweep.
export const SYMBOL_CAP = 20;

// Fuzzy floor mirrors the paid route's SIMILARITY_THRESHOLD: a look-alike below
// this is noise, at/above it is worth warning about. Exact matches score 1.0.
const FUZZY_FLOOR = 0.4;

// Per-symbol collision lists are capped so a hot ticker (dozens of clones)
// returns the most-relevant matches, not a wall of near-duplicates.
const MAX_COLLISIONS = 10;

// Strip a leading `$` and surrounding whitespace so `$MOON`, `MOON`, and
// ` moon ` all resolve to the same candidate.
function normalizeSymbol(s) {
	return String(s ?? '').trim().replace(/^\$+/, '').trim();
}

// pg_trgm-style trigrams: lowercase, pad with two leading + one trailing space
// so word boundaries contribute to the score exactly like Postgres' show_trgm.
function trigrams(str) {
	const padded = `  ${str.toLowerCase()} `;
	const set = new Set();
	for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
	return set;
}

// Jaccard similarity over trigram sets — the same measure Postgres' pg_trgm
// `similarity()` uses (|intersection| / |union|), so the free route's fuzzy
// scoring matches what the paid route returned. 1.0 == identical, 0 == disjoint.
export function symbolSimilarity(a, b) {
	const A = String(a ?? '').toLowerCase();
	const B = String(b ?? '').toLowerCase();
	if (!A || !B) return 0;
	if (A === B) return 1;
	const ta = trigrams(A);
	const tb = trigrams(B);
	if (!ta.size || !tb.size) return 0;
	let inter = 0;
	for (const g of ta) if (tb.has(g)) inter++;
	const union = ta.size + tb.size - inter;
	return union ? inter / union : 0;
}

// Query DexScreener's keyless search for one symbol and reduce the returned
// pairs to unique base tokens (highest-liquidity pair wins per mint). Throws on
// a non-OK upstream so the caller can degrade that symbol gracefully.
async function searchTokens(symbol, chain, fetchImpl) {
	const url = `${DEXSCREENER_SEARCH}?q=${encodeURIComponent(symbol)}`;
	const r = await fetchImpl(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(6000),
	});
	if (!r.ok) throw new Error(`dexscreener search ${r.status}`);
	const data = await r.json();
	const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
	const byMint = new Map();
	for (const p of pairs) {
		const base = p?.baseToken;
		if (!base?.symbol || !base?.address) continue;
		if (chain && String(p.chainId).toLowerCase() !== chain) continue;
		const liquidityUsd = Number(p?.liquidity?.usd) || 0;
		const prev = byMint.get(base.address);
		if (!prev || liquidityUsd > prev.liquidityUsd) {
			byMint.set(base.address, {
				symbol: base.symbol,
				name: base.name ?? null,
				mint: base.address,
				chain: p.chainId ?? null,
				liquidityUsd,
			});
		}
	}
	return [...byMint.values()];
}

// Classify one candidate symbol against the live registry.
async function checkOne(symbol, chain, fetchImpl) {
	let candidates;
	try {
		candidates = await searchTokens(symbol, chain, fetchImpl);
	} catch {
		// Registry source down for this symbol: degrade, never fail the batch.
		// `available: null` signals "could not verify" — distinct from a hard
		// available/taken — so a caller never reads an outage as a green light.
		return {
			symbol,
			available: null,
			exactCollisions: [],
			fuzzyCollisions: [],
			degraded: true,
			note: 'collision source unavailable — could not verify this symbol; retry shortly',
		};
	}

	const exact = [];
	const fuzzy = [];
	for (const c of candidates) {
		const score = symbolSimilarity(symbol, c.symbol);
		if (c.symbol.toLowerCase() === symbol.toLowerCase()) {
			exact.push({ symbol: c.symbol, name: c.name, mint: c.mint, chain: c.chain });
		} else if (score >= FUZZY_FLOOR) {
			fuzzy.push({
				symbol: c.symbol,
				name: c.name,
				mint: c.mint,
				chain: c.chain,
				similarity: Number(score.toFixed(3)),
			});
		}
	}
	fuzzy.sort((a, b) => b.similarity - a.similarity);

	return {
		symbol,
		available: exact.length === 0,
		exactCollisions: exact.slice(0, MAX_COLLISIONS),
		fuzzyCollisions: fuzzy.slice(0, MAX_COLLISIONS),
	};
}

// Core batch check — pure enough to unit-test with an injected `fetchImpl`.
// De-duplicates the input case-insensitively (checking "MOON" and "moon" twice
// wastes an upstream call and skews the counts).
export async function checkSymbols({ symbols, chain, fetchImpl = fetch }) {
	const seen = new Map();
	for (const raw of symbols) {
		const sym = normalizeSymbol(raw);
		if (!sym) continue;
		const key = sym.toLowerCase();
		if (!seen.has(key)) seen.set(key, sym);
	}
	const unique = [...seen.values()];

	const results = await Promise.all(unique.map((s) => checkOne(s, chain, fetchImpl)));

	const availableCount = results.filter((r) => r.available === true).length;
	const takenCount = results.filter((r) => r.available === false).length;
	const degraded = results.some((r) => r.degraded);

	return {
		results,
		availableCount,
		takenCount,
		...(degraded
			? { degraded: true, note: 'one or more symbols could not be verified against the collision source' }
			: {}),
		chain: chain ?? null,
		ts: new Date().toISOString(),
	};
}

// Read the requested symbol list + optional chain from either verb.
function parseInput(req, body, url) {
	if (req.method === 'POST') {
		const rawSymbols = Array.isArray(body?.symbols) ? body.symbols : [];
		const chain = body?.chain ? String(body.chain).trim().toLowerCase() : undefined;
		return { rawSymbols, chain };
	}
	const raw = url.searchParams.get('symbols') || '';
	const rawSymbols = raw.split(',');
	const c = url.searchParams.get('chain');
	const chain = c ? c.trim().toLowerCase() : undefined;
	return { rawSymbols, chain };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.marketDataIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	let body = null;
	if (req.method === 'POST') {
		try {
			body = await readJson(req);
		} catch (err) {
			setRateLimitHeaders(res, rl);
			return error(res, err.status || 400, 'invalid_json', err.message || 'request body must be valid JSON');
		}
	}

	const url = new URL(req.url, 'http://x');
	const { rawSymbols, chain } = parseInput(req, body, url);

	const cleaned = rawSymbols.map(normalizeSymbol).filter(Boolean);

	setRateLimitHeaders(res, rl);

	if (cleaned.length === 0) {
		return error(
			res,
			400,
			'missing_symbols',
			`provide 1–${SYMBOL_CAP} ticker symbols via ?symbols=A,B,C (GET) or { "symbols": [...] } (POST)`,
			{ cap: SYMBOL_CAP, example: { symbols: ['MOON', 'ROCKET', 'FROG'], chain: 'solana' } },
		);
	}
	if (cleaned.length > SYMBOL_CAP) {
		return error(
			res,
			400,
			'too_many_symbols',
			`at most ${SYMBOL_CAP} symbols per request — you sent ${cleaned.length}`,
			{ cap: SYMBOL_CAP },
		);
	}

	const payload = await checkSymbols({ symbols: cleaned, chain });

	// Short shared-edge cache: identical candidate lists (agents batch-probing the
	// same trending tickers) served from the CDN without re-hitting DexScreener,
	// while staying fresh enough that a brand-new collision surfaces within ~30s.
	return json(res, 200, payload, {
		'cache-control': 'public, s-maxage=30, stale-while-revalidate=60',
	});
});
