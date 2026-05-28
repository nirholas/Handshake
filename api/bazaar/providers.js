// GET /api/bazaar/providers
// GET /api/bazaar/providers?host=<host>
//
// Aggregates the merged x402 catalog into per-provider profiles. A "provider"
// is the host of the resource URL — the actual API operator, not the
// facilitator that listed it. Each provider profile carries enough data to
// drive a Hunch-style reputation card: service count, price band, dominant
// categories, networks, facilitators discovered on, and the underlying
// listings.

import { cors, json, error, wrap } from '../_lib/http.js';
import { Bazaar } from '../_lib/x402/bazaar-client.js';

function hostOf(url) {
	try { return new URL(url).host; } catch { return ''; }
}

function median(nums) {
	if (!nums.length) return 0;
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function priceLabel(atomic) {
	const n = atomic / 1_000_000;
	if (n === 0) return '0 USDC';
	if (n < 0.01) return `${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	if (n < 1) return `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	return `${n.toFixed(2)} USDC`;
}

function minUsdcAtomic(item) {
	const accepts = (item.accepts || []).filter((a) => {
		const sym = String(a?.assetInfo?.symbol || '').toUpperCase();
		return sym === 'USDC' || sym === '';
	});
	if (accepts.length === 0) return null;
	let min = null;
	for (const a of accepts) {
		const n = Number(a.amountAtomic);
		if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n;
	}
	return min;
}

function summarize(host, items) {
	const prices = items.map(minUsdcAtomic).filter((n) => n != null);
	const tagFreq = new Map();
	const netSet = new Set();
	const facSet = new Set();
	const typeFreq = { http: 0, mcp: 0 };
	let icon = null;
	for (const it of items) {
		if (!icon && it.iconUrl) icon = it.iconUrl;
		typeFreq[it.type] = (typeFreq[it.type] || 0) + 1;
		for (const t of it.tags || []) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
		for (const n of it.networks || []) netSet.add(n);
		const fac = hostOf(it.facilitator);
		if (fac) facSet.add(fac);
	}
	const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

	const minA = prices.length ? Math.min(...prices) : null;
	const maxA = prices.length ? Math.max(...prices) : null;
	const medA = prices.length ? median(prices) : null;

	return {
		host,
		iconUrl: icon,
		serviceCount: items.length,
		httpCount: typeFreq.http || 0,
		mcpCount: typeFreq.mcp || 0,
		networks: [...netSet],
		facilitators: [...facSet],
		topTags,
		minPriceAtomic: minA,
		maxPriceAtomic: maxA,
		medianPriceAtomic: medA,
		minPriceLabel: minA != null ? priceLabel(minA) : null,
		maxPriceLabel: maxA != null ? priceLabel(maxA) : null,
		medianPriceLabel: medA != null ? priceLabel(medA) : null,
	};
}

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://x');
	const wantHost = (url.searchParams.get('host') || '').toLowerCase().trim();
	const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000);

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

	const byHost = new Map();
	for (const it of items) {
		const h = hostOf(it.resource);
		if (!h) continue;
		if (!byHost.has(h)) byHost.set(h, []);
		byHost.get(h).push(it);
	}

	if (wantHost) {
		const matched = byHost.get(wantHost);
		if (!matched || matched.length === 0) {
			return error(res, 404, 'not_found', `no listings for host ${wantHost}`);
		}
		const summary = summarize(wantHost, matched);

		// Listings sorted cheap → expensive so the profile reads like a price
		// ladder. Unknown-price items sink to the bottom.
		const listings = matched
			.map((it) => ({ it, p: minUsdcAtomic(it) }))
			.sort((a, b) => {
				if (a.p == null && b.p == null) return 0;
				if (a.p == null) return 1;
				if (b.p == null) return -1;
				return a.p - b.p;
			})
			.map(({ it, p }) => ({
				type: it.type,
				resource: it.resource,
				toolName: it.toolName || null,
				serviceName: it.serviceName || null,
				description: it.description || '',
				iconUrl: it.iconUrl || null,
				tags: it.tags || [],
				networks: it.networks || [],
				method: it.method || null,
				facilitator: hostOf(it.facilitator),
				priceAtomic: p,
				priceLabel: p != null ? priceLabel(p) : null,
				accepts: it.accepts,
				extensions: it.extensions || [],
			}));

		res.setHeader('cache-control', 'public, max-age=30, stale-while-revalidate=120');
		return json(res, 200, { ...summary, listings });
	}

	const providers = [...byHost.entries()]
		.map(([h, list]) => summarize(h, list))
		.sort((a, b) => b.serviceCount - a.serviceCount)
		.slice(0, limit);

	res.setHeader('cache-control', 'public, max-age=30, stale-while-revalidate=120');
	return json(res, 200, {
		count: providers.length,
		totalProviders: byHost.size,
		providers,
		updatedAt: new Date().toISOString(),
	});
}

function clampInt(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export default wrap(handler);
