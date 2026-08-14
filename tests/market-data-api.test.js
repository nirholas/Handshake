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

import { describe, it, expect, vi } from 'vitest';

// The sector builder is swappable so the upstream-failure suite below can drive
// a real provider error (429, 401) through the fetcher without a network call.
// Unswapped it delegates to the real module, so every other suite is untouched.
const realCategories = await vi.importActual('../api/coin/categories.js');
const categoriesImpl = { fn: realCategories.buildCategories };
vi.mock('../api/coin/categories.js', () => ({
	buildCategories: (...args) => categoriesImpl.fn(...args),
}));

function categoriesBuilder(fn) {
	categoriesImpl.fn = fn;
	return () => {
		categoriesImpl.fn = realCategories.buildCategories;
	};
}

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

	it('market-fees rejects an unknown type instead of silently serving fees', async () => {
		await expectRejection(MARKET_FETCHERS['market-fees'](params({ type: 'revenu' })), {
			status: 422,
			code: 'invalid_type',
		});
	});

	it('market-yields rejects a malformed pool uuid', async () => {
		await expectRejection(MARKET_FETCHERS['market-yields'](params({ pool: 'not-a-uuid' })), {
			status: 422,
			code: 'invalid_pool',
		});
	});
});

// ── Upstream failure translation ────────────────────────────────────────────
//
// A provider throttle is OUR downtime, not the buyer's fault. Passing the
// upstream status through told a paying agent it was rate limited (on an
// endpoint sold as having no per-IP limits) and leaked the provider name and
// internal path in the error text. Only genuine caller faults survive intact.
describe('market-data upstream failure translation', () => {
	const throwing = (status, message) => async () => {
		throw Object.assign(new Error(message), { status });
	};

	it('reports an upstream 429 as retryable downtime, leaking no provider detail', async () => {
		const restore = categoriesBuilder(throwing(429, 'CoinGecko 429 for /coins/categories?order=market_cap_desc'));
		try {
			await expectRejection(MARKET_FETCHERS['market-categories'](params()), {
				status: 503,
				code: 'data_unavailable',
			});
		} finally {
			restore();
		}
	});

	it('reports an upstream auth fault as downtime too', async () => {
		const restore = categoriesBuilder(throwing(401, 'CoinGecko 401 for /coins/categories'));
		try {
			await expectRejection(MARKET_FETCHERS['market-categories'](params()), {
				status: 503,
				code: 'data_unavailable',
			});
		} finally {
			restore();
		}
	});

	it('still passes a genuine caller fault (404) through untouched', async () => {
		const restore = categoriesBuilder(throwing(404, 'no such category'));
		try {
			await expectRejection(MARKET_FETCHERS['market-categories'](params()), {
				status: 404,
				code: undefined,
			});
		} finally {
			restore();
		}
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
