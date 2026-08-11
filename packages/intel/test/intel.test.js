import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntel, ThreeWsError, PaymentRequiredError } from '../src/index.js';

// $THREE — the only coin. Used as the canonical real mint in these tests.
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// A clearly-synthetic base58 placeholder for the second-token cases.
const SYNTH = 'THREEsynthetic1111111111111111111111111111';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

test('sentiment() posts the mint and parses the pulse into camelCase', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				ok: true,
				token: THREE,
				overall: { score: 0.42, posPct: 58, negPct: 12, neuPct: 30, count: 40, examples: { pos: ['lfg'], neg: [] } },
				breakdown: {
					pumpfun: { score: 0.4, posPct: 55, negPct: 15, neuPct: 30, count: 38, examples: { pos: [], neg: [] } },
					extra: { score: 1, posPct: 100, negPct: 0, neuPct: 0, count: 2, examples: { pos: [], neg: [] } },
				},
				sources: { pumpfun: 'https://frontend-api-v3.pump.fun/replies/x', pumpfunCount: 38, extraCount: 2 },
				fetchedAt: '2026-06-23T00:00:00.000Z',
			},
		},
	]);
	const client = createIntel({ fetch, baseUrl: 'https://three.ws' });
	const pulse = await client.sentiment(THREE, { limit: 150, extraTexts: ['$THREE ripping', 'best 3D stack'] });

	assert.equal(calls[0].url.pathname, '/api/social/sentiment-pulse');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.token, THREE);
	assert.equal(sent.limit, 150);
	assert.deepEqual(sent.extraTexts, ['$THREE ripping', 'best 3D stack']);
	assert.equal(pulse.ok, true);
	assert.equal(pulse.overall.score, 0.42);
	assert.equal(pulse.overall.posPct, 58);
	assert.equal(pulse.breakdown.pumpfun.count, 38);
	assert.equal(pulse.sources.pumpfunCount, 38);
	assert.equal(pulse.fetchedAt, '2026-06-23T00:00:00.000Z');
});

test('sentiment() surfaces the degraded pumpfun breakdown when the source fails', async () => {
	const { fetch } = stubFetch([
		{
			body: {
				ok: true,
				token: SYNTH,
				overall: { score: 1, posPct: 100, negPct: 0, neuPct: 0, count: 1, examples: { pos: [], neg: [] } },
				breakdown: { pumpfun: { error: 'pump.fun returned 503', count: 0 }, extra: { score: 1, posPct: 100, negPct: 0, neuPct: 0, count: 1, examples: { pos: [], neg: [] } } },
				sources: { pumpfun: null, pumpfunCount: 0, extraCount: 1 },
				fetchedAt: '2026-06-23T00:00:00.000Z',
			},
		},
	]);
	const pulse = await createIntel({ fetch }).sentiment(SYNTH, { extraTexts: ['$THREE'] });
	assert.equal(pulse.breakdown.pumpfun.error, 'pump.fun returned 503');
	assert.equal(pulse.breakdown.pumpfun.count, 0);
	assert.equal(pulse.sources.pumpfun, null);
});

test('sentiment() rejects a non-base58 mint before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIntel({ fetch });
	await assert.rejects(() => client.sentiment('not-a-mint'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_input');
		return true;
	});
	await assert.rejects(() => client.sentiment(THREE, { limit: 999 }), /between 1 and 200/);
	assert.equal(calls.length, 0);
});

test('intel() sends the query params and normalizes items to camelCase', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				intel: [
					{
						category: 'partnership',
						description: 'a real partnership',
						detected_at: '2026-06-22T10:00:00Z',
						reinforced_at: null,
						observations: 3,
						official_source: true,
						project: 'three.ws',
						ticker: 'THREE',
						source: 'aixbt',
					},
				],
				pagination: { page: 1 },
			},
		},
	]);
	const feed = await createIntel({ fetch }).intel({ chain: 'solana', limit: 10, category: 'partnership' });

	assert.equal(calls[0].url.pathname, '/api/aixbt/intel');
	assert.equal(calls[0].url.searchParams.get('chain'), 'solana');
	assert.equal(calls[0].url.searchParams.get('limit'), '10');
	assert.equal(calls[0].url.searchParams.get('category'), 'partnership');
	assert.equal(feed.intel[0].description, 'a real partnership');
	assert.equal(feed.intel[0].detectedAt, '2026-06-22T10:00:00Z');
	assert.equal(feed.intel[0].officialSource, true);
	// snake_case mirror is preserved for callers that follow the README field names.
	assert.equal(feed.intel[0].official_source, true);
	assert.deepEqual(feed.pagination, { page: 1 });
});

test('projects() normalizes scores + market into camelCase', async () => {
	const { fetch, calls } = stubFetch([
		{
			body: {
				projects: [
					{
						id: 'p1',
						name: 'three.ws',
						ticker: 'THREE',
						x_handle: 'threews',
						address: SYNTH,
						chain: 'solana',
						scores: { spiking: 0.9, climbing: 0.5, active: 0.7 },
						trajectory: 'spiking',
						market: { price_usd: 0.04, market_cap: 4000000, volume_24h: 270000, change_24h: 2.5 },
						intel: [],
						categories: ['ai', 'solana'],
					},
				],
				pagination: { page: 1 },
			},
		},
	]);
	const scan = await createIntel({ fetch }).projects({ chain: 'solana', limit: 5, page: 2 });

	assert.equal(calls[0].url.pathname, '/api/aixbt/projects');
	assert.equal(calls[0].url.searchParams.get('page'), '2');
	const p = scan.projects[0];
	assert.equal(p.xHandle, 'threews');
	assert.equal(p.scores.spiking, 0.9);
	assert.equal(p.market.priceUsd, 0.04);
	assert.equal(p.market.change24h, 2.5);
	assert.deepEqual(p.categories, ['ai', 'solana']);
});

test('intel() maps a 503 aixbt_not_configured to a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([
		{ status: 503, body: { error: 'aixbt_not_configured', message: 'aixbt is not configured', setup: 'Set AIXBT_API_KEY' } },
	]);
	await assert.rejects(() => createIntel({ fetch }).intel(), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'aixbt_not_configured');
		assert.equal(e.status, 503);
		return true;
	});
});

test('snapshot() issues a tools/call and unwraps structuredContent', async () => {
	const structured = {
		token: THREE,
		priceUsd: 0.0415,
		priceSource: 'jupiter',
		price: { usdPrice: 0.0415, priceChange24hPct: 2.5, liquidityUsd: 107732 },
		volume24h: { volume24hUsd: 270780.6, dex: 'raydium' },
		meta: { name: 'three.ws', symbol: 'THREE', imageUrl: 'https://img' },
		holders: { topHolderCount: 20, topHolders: [{ address: 'a', uiAmount: 1234, amount: '1234', decimals: 6 }] },
		helius: null,
		image: 'https://img',
		sources: { price: 'https://lite-api.jup.ag/price/v3' },
		fetchedAt: '2026-06-23T00:00:00.000Z',
	};
	const { fetch, calls } = stubFetch([
		{ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: structured } } },
	]);
	const snap = await createIntel({ fetch }).snapshot(THREE);

	assert.equal(calls[0].url.pathname, '/api/mcp');
	assert.equal(calls[0].init.method, 'POST');
	const rpc = JSON.parse(calls[0].init.body);
	assert.equal(rpc.method, 'tools/call');
	assert.equal(rpc.params.name, 'pump_snapshot');
	assert.equal(rpc.params.arguments.token, THREE);
	assert.equal(snap.priceUsd, 0.0415);
	assert.equal(snap.priceSource, 'jupiter');
	assert.equal(snap.holders.topHolderCount, 20);
	assert.equal(snap.meta.symbol, 'THREE');
});

test('snapshot() rejects a bad mint with invalid_mint before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	await assert.rejects(() => createIntel({ fetch }).snapshot('nope'), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_mint');
		return true;
	});
	assert.equal(calls.length, 0);
});

test('snapshot() surfaces a 402 as PaymentRequiredError carrying the x402 challenge', async () => {
	const accepts = [{ scheme: 'exact', asset: 'USDC', network: 'solana', maxAmountRequired: '5000' }];
	const { fetch } = stubFetch([{ status: 402, body: { error: 'payment_required', message: 'pay $0.005', accepts } }]);
	await assert.rejects(() => createIntel({ fetch }).snapshot(THREE), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('snapshot() surfaces the x402-over-401 challenge the live MCP transport issues', async () => {
	// The production /api/mcp endpoint quotes its x402 challenge over HTTP 401
	// (x402Version + accepts in the body, next to the OAuth www-authenticate
	// header), not 402. The http core must still map it to PaymentRequiredError.
	const accepts = [{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '1000', payTo: SYNTH }];
	const { fetch } = stubFetch([
		{ status: 401, body: { x402Version: 2, error: 'X-PAYMENT header is required', accepts } },
	]);
	await assert.rejects(() => createIntel({ fetch }).snapshot(THREE), (e) => {
		assert.ok(e instanceof PaymentRequiredError);
		assert.equal(e.code, 'payment_required');
		assert.equal(e.status, 401);
		assert.equal(e.message, 'X-PAYMENT header is required');
		assert.deepEqual(e.accepts, accepts);
		return true;
	});
});

test('snapshot() maps a JSON-RPC tool error to a typed ThreeWsError', async () => {
	const { fetch } = stubFetch([
		{ body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unknown tool: pump_snapshot' } } },
	]);
	await assert.rejects(() => createIntel({ fetch }).snapshot(THREE), (e) => {
		assert.ok(e instanceof ThreeWsError);
		assert.equal(e.code, 'invalid_mint');
		return true;
	});
});
