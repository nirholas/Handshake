// GET /api/bazaar/arbitrage
//
// Surfaces cross-venue / cross-provider price disparities across the merged
// x402 facilitator catalog. We group listings by a derived "capability key"
// (MCP tool name, or normalized HTTP service name / URL tail), then keep
// groups that (a) have at least two listings, (b) span more than one
// provider host or facilitator, and (c) carry a non-zero USDC price spread.
// The result is the x402 analog of a cross-venue arbitrage view: same
// thing, different price.
//
// Query params:
//   minSpreadPct  — discard groups whose max/min - 1 is below this (default 0)
//   minProviders  — require at least this many distinct provider hosts (default 2)
//   limit         — cap returned opportunities (default 100, max 500)

import { cors, json, error, wrap } from '../_lib/http.js';
import { Bazaar } from '../_lib/x402/bazaar-client.js';

const STOP_WORDS = new Set([
	'api', 'apis', 'service', 'endpoint', 'endpoints', 'paid', 'free',
	'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'on', 'in', 'by',
	'tool', 'tools', 'mcp', 'http',
]);

function normalizeWord(s) {
	return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').trim();
}

function tokenize(s) {
	return String(s || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((w) => w.trim())
		.filter((w) => w && !STOP_WORDS.has(w) && w.length >= 2);
}

// Many facilitators (orbisapi, hyreagent…) ship empty serviceName and put
// the capability in the URL path with a random suffix:
//   /proxy/who-to-contact-api-97ccc0  →  "who-to-contact-api"
// Strip a single trailing hash-like segment so the same logical capability
// hosted by different providers collapses to the same key.
function tailFromUrl(url) {
	try {
		const u = new URL(url);
		const tail = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
		return tail.replace(/-[a-z0-9]{4,12}$/i, '');
	} catch {
		return '';
	}
}

function capabilityKey(it) {
	if (it.type === 'mcp' && it.toolName) {
		const k = normalizeWord(it.toolName);
		return k ? `mcp:${k}` : null;
	}
	// Prefer serviceName; single-token names are fine because the facilitator
	// chose them deliberately. URL-derived keys are noisier — a single short
	// path like /buy collides across totally unrelated services, so require
	// at least two informative tokens before treating them as a capability.
	const nameTokens = tokenize(it.serviceName).slice(0, 3);
	if (nameTokens.length && nameTokens.join('-').length >= 3) return `http:${nameTokens.join('-')}`;
	const urlTokens = tokenize(tailFromUrl(it.resource)).slice(0, 3);
	if (urlTokens.length >= 2 && urlTokens.join('-').length >= 6) return `http:${urlTokens.join('-')}`;
	return null;
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return ''; }
}

function usdcAccepts(accepts) {
	return (accepts || []).filter((a) => {
		const sym = String(a?.assetInfo?.symbol || '').toUpperCase();
		return sym === 'USDC' || sym === '';
	});
}

function minUsdcAtomic(item) {
	const ok = usdcAccepts(item.accepts);
	if (ok.length === 0) return null;
	let min = null;
	for (const a of ok) {
		const n = Number(a.amountAtomic);
		if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n;
	}
	return min;
}

function priceLabel(atomic) {
	const n = atomic / 1_000_000;
	if (n < 0.01) return `${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	if (n < 1) return `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	return `${n.toFixed(2)} USDC`;
}

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://x');
	const minSpreadPct = clampNum(url.searchParams.get('minSpreadPct'), 0, 0, 10000);
	const minProviders = clampInt(url.searchParams.get('minProviders'), 2, 2, 10);
	const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);

	const baz = new Bazaar();
	let httpRes, mcpRes;
	try {
		[httpRes, mcpRes] = await Promise.all([
			baz.list({ type: 'http', maxItems: 3000 }),
			baz.list({ type: 'mcp', maxItems: 3000 }),
		]);
	} catch (e) {
		return error(res, 502, 'facilitator_error', String(e?.message || e));
	}

	const items = [...(httpRes.items || []), ...(mcpRes.items || [])];

	const groups = new Map();
	for (const it of items) {
		const k = capabilityKey(it);
		if (!k) continue;
		const usdc = minUsdcAtomic(it);
		if (usdc == null) continue;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push({ it, usdc });
	}

	const opps = [];
	for (const [key, list] of groups) {
		if (list.length < 2) continue;
		const hosts = new Set(list.map(({ it }) => hostOf(it.resource)).filter(Boolean));
		const facilitators = new Set(list.map(({ it }) => hostOf(it.facilitator)).filter(Boolean));
		// Internal pricing tiers on a single host aren't arbitrage; require
		// at least two distinct hosts OR two distinct facilitators.
		if (hosts.size < minProviders && facilitators.size < 2) continue;

		const prices = list.map((x) => x.usdc);
		const minAtomic = Math.min(...prices);
		const maxAtomic = Math.max(...prices);
		if (maxAtomic === minAtomic) continue;
		const spreadAtomic = maxAtomic - minAtomic;
		const spreadPct = (spreadAtomic / minAtomic) * 100;
		if (spreadPct < minSpreadPct) continue;

		const cheapest = list.find((x) => x.usdc === minAtomic);
		const expensive = list.find((x) => x.usdc === maxAtomic);
		const ref = list.find((x) => x.it.serviceName) || list[0];
		const ref_it = ref.it;

		const providers = list
			.slice()
			.sort((a, b) => a.usdc - b.usdc)
			.map(({ it, usdc }) => ({
				host: hostOf(it.resource),
				facilitator: hostOf(it.facilitator),
				resource: it.resource,
				toolName: it.toolName || null,
				serviceName: it.serviceName || null,
				type: it.type,
				priceAtomic: usdc,
				priceLabel: priceLabel(usdc),
				networks: it.networks || [],
				iconUrl: it.iconUrl || null,
			}));

		const tagSet = new Set();
		for (const { it } of list) for (const t of it.tags || []) tagSet.add(t);

		opps.push({
			key,
			type: ref_it.type,
			capability: ref_it.toolName || ref_it.serviceName || key.split(':')[1].replace(/-/g, ' '),
			serviceName: ref_it.serviceName || null,
			description: ref_it.description || '',
			iconUrl: ref_it.iconUrl || null,
			tags: [...tagSet].slice(0, 6),
			providerCount: hosts.size,
			facilitatorCount: facilitators.size,
			listingCount: list.length,
			minPriceAtomic: minAtomic,
			maxPriceAtomic: maxAtomic,
			minPriceLabel: priceLabel(minAtomic),
			maxPriceLabel: priceLabel(maxAtomic),
			spreadAtomic,
			spreadPct,
			cheapest: {
				host: hostOf(cheapest.it.resource),
				facilitator: hostOf(cheapest.it.facilitator),
				resource: cheapest.it.resource,
				toolName: cheapest.it.toolName || null,
				priceLabel: priceLabel(cheapest.usdc),
			},
			mostExpensive: {
				host: hostOf(expensive.it.resource),
				facilitator: hostOf(expensive.it.facilitator),
				resource: expensive.it.resource,
				toolName: expensive.it.toolName || null,
				priceLabel: priceLabel(expensive.usdc),
			},
			providers,
		});
	}

	// Largest absolute spread first; spread % is the tiebreaker so
	// micro-priced groups with big ratios don't bury larger-stake ones.
	opps.sort((a, b) => {
		if (b.spreadAtomic !== a.spreadAtomic) return b.spreadAtomic - a.spreadAtomic;
		return b.spreadPct - a.spreadPct;
	});

	const trimmed = opps.slice(0, limit);

	res.setHeader('cache-control', 'public, max-age=30, stale-while-revalidate=120');
	return json(res, 200, {
		count: trimmed.length,
		totalGroups: opps.length,
		opportunities: trimmed,
		updatedAt: new Date().toISOString(),
		sources: [
			...(httpRes.sources || []).map((s) => ({ ...s, type: 'http' })),
			...(mcpRes.sources || []).map((s) => ({ ...s, type: 'mcp' })),
		],
	});
}

function clampInt(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}
function clampNum(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

export default wrap(handler);
