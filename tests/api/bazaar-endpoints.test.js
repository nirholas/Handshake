// Contract tests for the five /api/bazaar/* handlers and the discovery client
// they share (api/_lib/x402/bazaar-client.js).
//
// The facilitators are stubbed at `fetch`, so every layer under it runs for
// real: pagination, cross-facilitator dedupe, normalization, filtering, the
// per-endpoint caps, and the failure paths. These cover the defects the
// 2026-08-10 audit found against the live catalog:
//   - `limit` on /api/bazaar/list reached only the facilitator page size, so a
//     caller asking for 20 endpoints got the entire catalog.
//   - `maxItems` bounded nothing when a facilitator ignored `limit`.
//   - A facilitator that ignores `offset` replayed page one until `maxItems`,
//     turning one small query into hundreds of identical round trips.
//   - /api/bazaar/providers?host= returned every listing (10 MB for the
//     largest provider in the live catalog).
//   - An explicit `minProviders` was ignored whenever two facilitators listed
//     the same single-host capability.
//   - A total facilitator outage surfaced as an empty 200 catalog, which reads
//     as "no such service exists".

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const FAC_A = 'https://fac-a.test';
const FAC_B = 'https://fac-b.test';

process.env.X402_FACILITATOR_URL_BASE = FAC_A;
process.env.X402_CDP_FACILITATOR_URL = FAC_B;
delete process.env.X402_FACILITATOR_URL_SOLANA;

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function httpItem({ resource, name, amount, category = 'data', description = 'A paid endpoint.' }) {
	return {
		type: 'http',
		resource,
		description,
		accepts: [
			{
				scheme: 'exact',
				network: 'base',
				maxAmountRequired: String(amount),
				asset: USDC_BASE,
				payTo: '0x00000000000000000000000000000000000000a1',
			},
		],
		extensions: { bazaar: { name, category } },
	};
}

function mcpItem({ resource, toolName, amount }) {
	return {
		type: 'mcp',
		resource,
		description: `MCP tool ${toolName}.`,
		accepts: [
			{
				scheme: 'exact',
				network: 'base',
				maxAmountRequired: String(amount),
				asset: USDC_BASE,
				payTo: '0x00000000000000000000000000000000000000a2',
			},
		],
		extensions: { bazaar: { name: toolName, info: { input: { type: 'mcp', toolName } } } },
	};
}

// alpha.example sells five endpoints; beta.example sells the same weather
// capability at 10x the price (the arbitrage case) plus one of its own.
const ALPHA_WEATHER = httpItem({
	resource: 'https://alpha.example/api/weather-forecast',
	name: 'Weather Forecast',
	amount: 5_000,
	category: 'weather',
});
const CATALOG = {
	[FAC_A]: [
		ALPHA_WEATHER,
		httpItem({ resource: 'https://alpha.example/api/notes', name: 'Notes Store', amount: 1_000 }),
		httpItem({ resource: 'https://alpha.example/api/geocode', name: 'Geocoder', amount: 2_000 }),
		httpItem({ resource: 'https://alpha.example/api/ocr', name: 'OCR Reader', amount: 3_000 }),
		httpItem({ resource: 'https://alpha.example/api/translate', name: 'Translator', amount: 4_000 }),
		httpItem({
			resource: 'https://beta.example/api/weather-forecast',
			name: 'Weather Forecast',
			amount: 50_000,
			category: 'weather',
		}),
		mcpItem({ resource: 'https://alpha.example/mcp', toolName: 'summarize', amount: 900 }),
	],
	// Same weather listing as fac-a (dedupe), plus one fac-b exclusive.
	[FAC_B]: [
		ALPHA_WEATHER,
		httpItem({ resource: 'https://gamma.example/api/quotes', name: 'Quote Feed', amount: 7_000 }),
	],
};

let fetchCalls = [];
let failAll = false;
let replayOffsets = false;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input) => {
	const raw = typeof input === 'string' ? input : input?.url || String(input);
	const u = new URL(raw);
	const origin = `${u.protocol}//${u.host}`;
	fetchCalls.push(raw);
	if (!(origin in CATALOG)) {
		// Anything else (the LLM chain in /api/bazaar/context) must not reach the
		// network from a test: refusing it exercises the deterministic fallback.
		throw new Error(`blocked network call to ${origin}`);
	}
	if (failAll) return new Response('facilitator down', { status: 503 });
	const type = u.searchParams.get('type') || 'http';
	const limit = Number(u.searchParams.get('limit') || 200);
	const offset = replayOffsets ? 0 : Number(u.searchParams.get('offset') || 0);
	const all = CATALOG[origin].filter((i) => i.type === type);
	return new Response(
		JSON.stringify({ items: all.slice(offset, offset + limit), pagination: { total: all.length } }),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
};

afterAll(() => {
	globalThis.fetch = realFetch;
});

const { default: listHandler } = await import('../../api/bazaar/list.js');
const { default: searchHandler } = await import('../../api/bazaar/search.js');
const { default: providersHandler } = await import('../../api/bazaar/providers.js');
const { default: arbitrageHandler } = await import('../../api/bazaar/arbitrage.js');
const { default: contextHandler } = await import('../../api/bazaar/context.js');
const { Bazaar, clearCatalogCache } = await import('../../api/_lib/x402/bazaar-client.js');

let ipCounter = 0;
function makeReq({ url, method = 'GET' } = {}) {
	ipCounter++;
	return {
		method,
		url,
		headers: { 'x-forwarded-for': `198.51.100.${ipCounter % 250}` },
		socket: { remoteAddress: `198.51.100.${ipCounter % 250}` },
	};
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
			this.headersSent = true;
		},
	};
}

async function invoke(handler, url, method = 'GET') {
	const res = makeRes();
	await handler(makeReq({ url, method }), res);
	let payload = null;
	if (res.body) {
		try {
			payload = JSON.parse(res.body);
		} catch {
			payload = res.body;
		}
	}
	return { status: res.statusCode, payload, headers: res.headers };
}

beforeEach(() => {
	fetchCalls = [];
	failAll = false;
	replayOffsets = false;
	// The handlers share an in-process catalog memo; each case configures its
	// own facilitator behaviour, so start every one from a cold catalog.
	clearCatalogCache();
});

describe('GET /api/bazaar/list', () => {
	it('merges facilitators, dedupes by resource, and reports both sources', async () => {
		const { status, payload } = await invoke(listHandler, '/api/bazaar/list');
		expect(status).toBe(200);
		// 6 HTTP listings on fac-a + 1 exclusive on fac-b; the shared weather
		// listing must appear exactly once.
		expect(payload.count).toBe(7);
		const weather = payload.items.filter(
			(i) => i.resource === 'https://alpha.example/api/weather-forecast',
		);
		expect(weather).toHaveLength(1);
		expect(payload.sources.map((s) => s.ok)).toEqual([true, true]);
		expect(payload.errors).toEqual([]);
	});

	it('caps the response at `limit` and reports the pre-cut total', async () => {
		const { status, payload } = await invoke(listHandler, '/api/bazaar/list?limit=2');
		expect(status).toBe(200);
		expect(payload.items).toHaveLength(2);
		expect(payload.count).toBe(2);
		expect(payload.total).toBe(7);
	});

	it('filters by network, tag, and atomic max price', async () => {
		const byTag = await invoke(listHandler, '/api/bazaar/list?tag=weather');
		expect(byTag.payload.count).toBe(2);

		const byNetwork = await invoke(listHandler, '/api/bazaar/list?network=eip155:*');
		expect(byNetwork.payload.count).toBe(7);
		const noMatch = await invoke(listHandler, '/api/bazaar/list?network=solana:*');
		expect(noMatch.payload.count).toBe(0);

		const cheap = await invoke(listHandler, '/api/bazaar/list?maxPrice=3000&sort=price');
		expect(cheap.payload.items.map((i) => i.minPriceAtomic)).toEqual([1000, 2000, 3000]);
	});

	it('rejects a decimal maxPrice and an unknown type with a 400 JSON error', async () => {
		const decimal = await invoke(listHandler, '/api/bazaar/list?maxPrice=0.01');
		expect(decimal.status).toBe(400);
		expect(decimal.payload.error).toBe('bad_request');

		const type = await invoke(listHandler, '/api/bazaar/list?type=grpc');
		expect(type.status).toBe(400);
	});

	it('treats an empty maxPrice as no cap instead of a 400', async () => {
		const { status, payload } = await invoke(listHandler, '/api/bazaar/list?maxPrice=');
		expect(status).toBe(200);
		expect(payload.count).toBe(7);
	});

	it('answers 405 on a non-GET and sets wildcard CORS', async () => {
		const { status, payload, headers } = await invoke(listHandler, '/api/bazaar/list', 'POST');
		expect(status).toBe(405);
		expect(payload.error).toBe('method_not_allowed');
		expect(headers['access-control-allow-origin']).toBe('*');
	});

	it('answers 502 when every facilitator fails instead of an empty catalog', async () => {
		failAll = true;
		const { status, payload } = await invoke(listHandler, '/api/bazaar/list');
		expect(status).toBe(502);
		expect(payload.error).toBe('facilitator_error');
		expect(payload.error_description).toContain('fac-a.test');
	});
});

describe('GET /api/bazaar/search', () => {
	it('ranks matches for the query and reports the pre-cut total', async () => {
		const { status, payload } = await invoke(listHandler, '/api/bazaar/search?query=weather');
		expect(status).toBe(200);
		expect(payload.count).toBe(7);

		const search = await invoke(searchHandler, '/api/bazaar/search?query=weather');
		expect(search.status).toBe(200);
		expect(search.payload.count).toBe(2);
		expect(search.payload.resources.every((r) => /weather/i.test(JSON.stringify(r)))).toBe(true);

		const capped = await invoke(searchHandler, '/api/bazaar/search?query=weather&limit=1');
		expect(capped.payload.count).toBe(1);
		expect(capped.payload.total).toBe(2);
	});

	it('returns the whole catalog for an empty query and 400s a decimal price cap', async () => {
		const all = await invoke(searchHandler, '/api/bazaar/search');
		expect(all.payload.count).toBe(7);

		const bad = await invoke(searchHandler, '/api/bazaar/search?maxPrice=1.5');
		expect(bad.status).toBe(400);
	});

	it('answers 502 when every facilitator fails', async () => {
		failAll = true;
		const { status, payload } = await invoke(searchHandler, '/api/bazaar/search?query=weather');
		expect(status).toBe(502);
		expect(payload.error).toBe('facilitator_error');
	});
});

describe('GET /api/bazaar/providers', () => {
	it('aggregates hosts into profiles ordered by service count', async () => {
		const { status, payload } = await invoke(providersHandler, '/api/bazaar/providers');
		expect(status).toBe(200);
		expect(payload.providers[0].host).toBe('alpha.example');
		expect(payload.providers[0].serviceCount).toBe(6); // 5 HTTP + 1 MCP tool
		expect(payload.providers[0].mcpCount).toBe(1);
		expect(payload.providers[0].minPriceAtomic).toBe(900);
		expect(payload.totalProviders).toBe(3);
	});

	it('caps a host profile listing array and reports the true total', async () => {
		const { status, payload } = await invoke(
			providersHandler,
			'/api/bazaar/providers?host=alpha.example&limit=2',
		);
		expect(status).toBe(200);
		expect(payload.listings).toHaveLength(2);
		expect(payload.listingTotal).toBe(6);
		expect(payload.serviceCount).toBe(6);
		// Cheapest first, so the cap keeps the head of the price ladder.
		expect(payload.listings.map((l) => l.priceAtomic)).toEqual([900, 1000]);
	});

	it('404s an unknown host and 405s a non-GET', async () => {
		const missing = await invoke(providersHandler, '/api/bazaar/providers?host=nope.invalid');
		expect(missing.status).toBe(404);
		expect(missing.payload.error).toBe('not_found');

		const post = await invoke(providersHandler, '/api/bazaar/providers', 'POST');
		expect(post.status).toBe(405);
	});

	it('answers 502 when every facilitator fails', async () => {
		failAll = true;
		const { status } = await invoke(providersHandler, '/api/bazaar/providers');
		expect(status).toBe(502);
	});
});

describe('GET /api/bazaar/arbitrage', () => {
	it('surfaces the same capability priced differently across two hosts', async () => {
		const { status, payload } = await invoke(arbitrageHandler, '/api/bazaar/arbitrage');
		expect(status).toBe(200);
		const weather = payload.opportunities.find((o) => o.key === 'http:weather-forecast');
		expect(weather).toBeTruthy();
		expect(weather.providerCount).toBe(2);
		expect(weather.minPriceAtomic).toBe(5_000);
		expect(weather.maxPriceAtomic).toBe(50_000);
		expect(weather.spreadAtomic).toBe(45_000);
		expect(weather.spreadPct).toBe(900);
		expect(weather.cheapest.host).toBe('alpha.example');
		expect(weather.mostExpensive.host).toBe('beta.example');
		expect(weather.minPriceLabel).toBe('0.005 USDC');
	});

	it('honors an explicitly raised minProviders floor', async () => {
		const two = await invoke(arbitrageHandler, '/api/bazaar/arbitrage?minProviders=2');
		expect(two.payload.opportunities.some((o) => o.key === 'http:weather-forecast')).toBe(true);

		const three = await invoke(arbitrageHandler, '/api/bazaar/arbitrage?minProviders=3');
		expect(three.payload.opportunities.some((o) => o.key === 'http:weather-forecast')).toBe(false);
	});

	it('drops groups below minSpreadPct and caps at limit', async () => {
		const wide = await invoke(arbitrageHandler, '/api/bazaar/arbitrage?minSpreadPct=1000');
		expect(wide.payload.count).toBe(0);

		const capped = await invoke(arbitrageHandler, '/api/bazaar/arbitrage?limit=1');
		expect(capped.payload.opportunities).toHaveLength(1);
	});

	it('answers 405 on a non-GET and 502 on a total facilitator outage', async () => {
		const post = await invoke(arbitrageHandler, '/api/bazaar/arbitrage', 'POST');
		expect(post.status).toBe(405);

		failAll = true;
		const down = await invoke(arbitrageHandler, '/api/bazaar/arbitrage');
		expect(down.status).toBe(502);
	});
});

describe('GET /api/bazaar/context', () => {
	const target = encodeURIComponent('https://alpha.example/api/weather-forecast');

	it('requires a resource and 404s one outside the catalog', async () => {
		const missing = await invoke(contextHandler, '/api/bazaar/context');
		expect(missing.status).toBe(400);
		expect(missing.payload.error).toBe('bad_request');

		const unknown = await invoke(
			contextHandler,
			'/api/bazaar/context?resource=https%3A%2F%2Fnope.invalid%2Fx',
		);
		expect(unknown.status).toBe(404);
	});

	it('falls back to a grounded deterministic summary when no LLM answers', async () => {
		const { status, payload } = await invoke(
			contextHandler,
			`/api/bazaar/context?resource=${target}`,
		);
		expect(status).toBe(200);
		expect(payload.source).toBe('deterministic');
		expect(payload.summary.length).toBeGreaterThan(0);
		expect(['up', 'down', 'neutral']).toContain(payload.sentiment);
		expect(payload.stats.peerCount).toBe(1);
		expect(payload.stats.targetPriceAtomic).toBe(5_000);
		expect(payload.stats.providerSiblingsCount).toBe(5);
		// Every [n] the summary cites must map to a real citation anchor.
		const cited = [...payload.summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
		for (const n of cited) expect(payload.citations[n - 1]).toBeTruthy();
		// No citation may link at an empty search query.
		for (const c of payload.citations) expect(c.url).not.toMatch(/\?q=$/);
	});

	it('answers 405 on a non-GET and 502 on a total facilitator outage', async () => {
		const post = await invoke(contextHandler, `/api/bazaar/context?resource=${target}`, 'POST');
		expect(post.status).toBe(405);

		failAll = true;
		const down = await invoke(contextHandler, `/api/bazaar/context?resource=${target}`);
		expect(down.status).toBe(502);
	});
});

describe('bazaar-client catalog memo', () => {
	it('serves a second read from memory instead of re-sweeping facilitators', async () => {
		const baz = new Bazaar({ facilitators: [FAC_A] });
		const first = await baz.listCached({ type: 'http', maxItems: 500 });
		const afterFirst = fetchCalls.length;
		expect(afterFirst).toBeGreaterThan(0);
		const second = await baz.listCached({ type: 'http', maxItems: 500 });
		expect(fetchCalls).toHaveLength(afterFirst);
		expect(second.items).toHaveLength(first.items.length);
		// Callers filter and sort in place, so each read gets its own array.
		expect(second.items).not.toBe(first.items);
	});

	it('does not memoize a failed sweep', async () => {
		failAll = true;
		const baz = new Bazaar({ facilitators: [FAC_A] });
		const down = await baz.listCached({ type: 'http', maxItems: 500 });
		expect(down.sources.every((s) => !s.ok)).toBe(true);

		failAll = false;
		clearCatalogCache();
		const up = await baz.listCached({ type: 'http', maxItems: 500 });
		expect(up.items.length).toBeGreaterThan(0);
	});
});

describe('bazaar-client paging bounds', () => {
	it('never returns more than maxItems from one facilitator', async () => {
		const baz = new Bazaar({ facilitators: [FAC_A] });
		const { items } = await baz.list({ type: 'http', limit: 200, maxItems: 2 });
		expect(items).toHaveLength(2);
	});

	it('stops after one duplicate page when a facilitator ignores offset', async () => {
		replayOffsets = true;
		const baz = new Bazaar({ facilitators: [FAC_A] });
		const { items } = await baz.list({ type: 'http', limit: 2, maxItems: 500 });
		// Page one (2 fresh) then page two (all duplicates) ends the walk, rather
		// than the 250 round trips the unbounded loop used to make.
		expect(fetchCalls).toHaveLength(2);
		expect(items).toHaveLength(2);
	});
});
