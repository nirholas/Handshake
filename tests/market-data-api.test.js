// Paid Market Data API (/api/x402/market-*) — wiring + contract guards.
//
// Three layers, all offline (no upstream calls, no payment):
//   1. Registry invariants — the single-source-of-truth entries every surface
//      (live 402, service catalog, discovery doc, free index) derives from.
//   2. Fetcher param validation — rejected params throw {status:422} BEFORE
//      any upstream fetch, which the paid-endpoint wrapper maps to an error
//      response pre-settle: a malformed request is never charged.
//   3. Live 402 challenge — each thin route module builds a real paidEndpoint
//      whose unpaid response advertises the registry's exact price.

import { describe, it, expect } from 'vitest';

// Discovery env must be set BEFORE the paid-endpoint stack loads — same stub
// set tests/service-catalog.test.js uses.
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

const { MARKET_CATEGORIES, MARKET_CATEGORY_BY_SLUG } = await import(
	'../api/_lib/market-data/registry.js'
);
const { MARKET_FETCHERS } = await import('../api/_lib/market-data/fetch.js');
const { MARKET_DATA_SERVICES } = await import(
	'../api/_lib/service-catalog/services/market-data.js'
);

const params = (obj = {}) => new URLSearchParams(obj);

async function expectRejection(promise, { status, code }) {
	let err;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	expect(err, 'expected the fetcher to throw').toBeTruthy();
	expect(err.status).toBe(status);
	expect(err.code).toBe(code);
}

// ── Registry invariants ─────────────────────────────────────────────────────
describe('market-data registry', () => {
	it('covers every category with exactly one fetcher (no orphans either way)', () => {
		const registrySlugs = [...MARKET_CATEGORY_BY_SLUG.keys()].sort();
		const fetcherSlugs = Object.keys(MARKET_FETCHERS).sort();
		expect(fetcherSlugs).toEqual(registrySlugs);
	});

	it('every entry carries complete listing metadata', () => {
		expect(MARKET_CATEGORIES.length).toBeGreaterThanOrEqual(17);
		const slugs = new Set();
		for (const c of MARKET_CATEGORIES) {
			expect(c.slug, c.slug).toMatch(/^market-[a-z-]+$/);
			expect(slugs.has(c.slug), `duplicate slug ${c.slug}`).toBe(false);
			slugs.add(c.slug);
			// The catalog test requires ≥60-char descriptions and ≤5 tags; enforce
			// at the source so a new category can't regress the discovery listing.
			expect(c.description.length, `${c.slug} description`).toBeGreaterThanOrEqual(60);
			expect(c.tags.length, `${c.slug} tags`).toBeGreaterThanOrEqual(2);
			expect(c.tags.length, `${c.slug} tags`).toBeLessThanOrEqual(5);
			expect(c.priceAtomics).toMatch(/^\d+$/);
			expect(c.useCases.length).toBeGreaterThan(0);
			expect(c.inputSchema.type).toBe('object');
			expect(c.outputExample && typeof c.outputExample).toBe('object');
			// The advertised example must only use declared params (CDP validates
			// the listing's info block against its own schema — a stray key delists).
			for (const key of Object.keys(c.inputExample)) {
				expect(c.inputSchema.properties[key], `${c.slug} example key ${key}`).toBeTruthy();
			}
		}
	});

	it('projects one catalog descriptor per category on the /api/x402/<slug> path', () => {
		expect(MARKET_DATA_SERVICES.length).toBe(MARKET_CATEGORIES.length);
		for (const s of MARKET_DATA_SERVICES) {
			expect(s.path).toBe(`/api/x402/${s.slug}`);
			expect(s.status).toBe('live');
			expect(s.acceptsBuilder).toBe('standard');
			expect(s.priceAtomics).toBe(MARKET_CATEGORY_BY_SLUG.get(s.slug).priceAtomics);
		}
	});
});

// ── Fetcher validation (pre-settle rejections, no network) ─────────────────
describe('market-data fetcher validation', () => {
	it('market-coins rejects a malformed category and an over-long search', async () => {
		await expectRejection(MARKET_FETCHERS['market-coins'](params({ category: 'Not A Slug!' })), {
			status: 422,
			code: 'invalid_category',
		});
		await expectRejection(MARKET_FETCHERS['market-coins'](params({ q: 'x'.repeat(65) })), {
			status: 422,
			code: 'invalid_query',
		});
	});

	it('market-coin rejects a bad contract and a missing id', async () => {
		await expectRejection(MARKET_FETCHERS['market-coin'](params({ contract: 'nope' })), {
			status: 422,
			code: 'invalid_contract',
		});
		await expectRejection(MARKET_FETCHERS['market-coin'](params()), {
			status: 422,
			code: 'invalid_id',
		});
	});

	it('market-chart rejects an invalid window and a bad id', async () => {
		await expectRejection(MARKET_FETCHERS['market-chart'](params({ id: 'bitcoin', days: '13' })), {
			status: 422,
			code: 'invalid_days',
		});
		await expectRejection(MARKET_FETCHERS['market-chart'](params({ id: 'NOT VALID' })), {
			status: 422,
			code: 'invalid_id',
		});
	});

	it('market-derivatives rejects an unknown view', async () => {
		await expectRejection(MARKET_FETCHERS['market-derivatives'](params({ view: 'spot' })), {
			status: 422,
			code: 'invalid_view',
		});
	});

	it('market-yields rejects a malformed pool uuid', async () => {
		await expectRejection(MARKET_FETCHERS['market-yields'](params({ pool: 'not-a-uuid' })), {
			status: 422,
			code: 'invalid_pool',
		});
	});
});

// ── Live 402 challenge ──────────────────────────────────────────────────────
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

async function challenge(slug, search = '') {
	const mod = await import(`../api/x402/${slug}.js`);
	const res = fakeRes();
	await mod.default(
		{ method: 'GET', url: `/api/x402/${slug}${search}`, headers: { host: 'three.ws' } },
		res,
	);
	return res;
}

// The challenge may advertise additional rails (e.g. the env-gated $THREE
// accept) at converted amounts — the price contract we guard is the USDC one.
const USDC_ASSETS = new Set([
	process.env.X402_ASSET_MINT_SOLANA,
	process.env.X402_ASSET_ADDRESS_BASE,
	process.env.X402_ASSET_ADDRESS_ARBITRUM,
]);
const usdcAmounts = (body) =>
	body.accepts
		.filter((a) => USDC_ASSETS.has(a.asset))
		.map((a) => a.amount ?? a.maxAmountRequired);

describe('market-data 402 challenges', () => {
	it('an unpaid market-global call gets a 402 advertising the registry price', async () => {
		const res = await challenge('market-global');
		expect(res.statusCode).toBe(402);
		const amounts = usdcAmounts(JSON.parse(res.body));
		expect(amounts.length).toBeGreaterThan(0);
		expect(amounts.every((a) => a === MARKET_CATEGORY_BY_SLUG.get('market-global').priceAtomics)).toBe(true);
	});

	it('the pulse bundle prices at its own premium tier', async () => {
		const res = await challenge('market-pulse');
		expect(res.statusCode).toBe(402);
		const amounts = usdcAmounts(JSON.parse(res.body));
		expect(amounts.length).toBeGreaterThan(0);
		expect(amounts.every((a) => a === MARKET_CATEGORY_BY_SLUG.get('market-pulse').priceAtomics)).toBe(true);
	});

	it('every category route module builds a live handler', async () => {
		for (const c of MARKET_CATEGORIES) {
			const mod = await import(`../api/x402/${c.slug}.js`);
			expect(typeof mod.default, c.slug).toBe('function');
		}
	});
});
