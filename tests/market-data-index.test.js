// Free Market Data front door (/api/x402/market): the index an agent reads
// before it pays for anything.
//
// Two contracts are guarded here, both of which drifted silently in the past:
//   1. Completeness. The index promises every paid /api/x402/market-* endpoint.
//      It used to list only the registry family, so the two hand-written
//      siblings (market-heatmap, market-mood) were unreachable by discovery.
//   2. Price truth. The index used the registry's declared default while the
//      live 402 resolves through priceFor(), so an X402_PRICE_MARKET_* override
//      made the free index quote a price the endpoint no longer charges.
//
// Offline: no upstream calls, no payment.

import { describe, it, expect } from 'vitest';

// Discovery env must be set BEFORE the paid-endpoint stack loads. Same stub
// set tests/market-data-api.test.js uses.
Object.assign(process.env, {
	APP_ORIGIN: 'https://three.ws',
	X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
	X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
	X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	X402_MAX_AMOUNT_REQUIRED: '1000',
	X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
});

const indexRoute = (await import('../api/x402/market.js')).default;
const { PAID_SERVICES } = await import('../api/_lib/service-catalog/services/index.js');

function fakeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
			this.writableEnded = true;
		},
	};
}

async function readIndex() {
	const res = fakeRes();
	await indexRoute(
		{ method: 'GET', url: '/api/x402/market', headers: { host: 'three.ws' } },
		res,
	);
	expect(res.statusCode).toBe(200);
	return JSON.parse(res.body);
}

// Every live paid endpoint the catalog places on the market-* path. This is the
// same set the index derives from, read independently so a filter bug in the
// route shows up as a mismatch rather than agreeing with itself.
const PAID_MARKET_PATHS = PAID_SERVICES.filter(
	(s) => s.status === 'live' && !s.free && s.path?.startsWith('/api/x402/market-'),
);

describe('the free market index', () => {
	it('lists every live paid /api/x402/market-* endpoint, siblings included', async () => {
		const body = await readIndex();
		const listed = new Set(body.endpoints.map((e) => e.slug));
		for (const s of PAID_MARKET_PATHS) {
			expect(listed.has(s.slug), `${s.slug} missing from the index`).toBe(true);
		}
		expect(body.endpoints.length).toBe(PAID_MARKET_PATHS.length);
		// The regression that motivated this file: both siblings present.
		expect(listed.has('market-heatmap')).toBe(true);
		expect(listed.has('market-mood')).toBe(true);
	});

	it('gives every row a runnable example on its own url', async () => {
		const body = await readIndex();
		for (const e of body.endpoints) {
			expect(e.url, e.slug).toBe(`https://three.ws/api/x402/${e.slug}`);
			expect(e.example.startsWith(e.url), e.slug).toBe(true);
			expect(e.price_usdc, e.slug).toMatch(/^\$\d/);
			expect(typeof e.summary, e.slug).toBe('string');
			// Advertised example params must all be declared params.
			const query = e.example.slice(e.url.length).replace(/^\?/, '');
			for (const key of new URLSearchParams(query).keys()) {
				expect(e.params[key], `${e.slug} example key ${key}`).toBeTruthy();
			}
		}
	});

	it('quotes the overridden price, not the declared default', async () => {
		const key = 'X402_PRICE_MARKET_GAS';
		const before = process.env[key];
		try {
			process.env[key] = '500'; // $0.0005, below the old formatter's floor
			const row = (await readIndex()).endpoints.find((e) => e.slug === 'market-gas');
			expect(row.price_usdc).toBe('$0.0005');
		} finally {
			if (before === undefined) delete process.env[key];
			else process.env[key] = before;
		}
	});

	it('formats whole-dollar and default prices without stray zeros', async () => {
		const key = 'X402_PRICE_MARKET_GAS';
		const before = process.env[key];
		try {
			process.env[key] = '1000000';
			let row = (await readIndex()).endpoints.find((e) => e.slug === 'market-gas');
			expect(row.price_usdc).toBe('$1');
			delete process.env[key];
			row = (await readIndex()).endpoints.find((e) => e.slug === 'market-gas');
			expect(row.price_usdc).toBe('$0.001');
		} finally {
			if (before === undefined) delete process.env[key];
			else process.env[key] = before;
		}
	});
});
