// Unified service catalog (api/_lib/service-catalog/) — the no-drift guards.
//
// One source of truth, two storefronts: the x402 discovery doc (api/wk.js)
// and the OKX.AI listing must both render from the catalog. These tests make
// drift a red build:
//   • every catalog x402scan entry appears in the LIVE discovery doc with an
//     identical description / serviceName / tags / price (the scattered-mirror
//     drift the catalog was built to kill),
//   • the OKX projection reproduces api/_lib/okx-catalog.js's catalogIndex()
//     byte-for-byte, so the OKX stream can point at toOkxCatalog() with zero
//     behavior change,
//   • projected OKX rows respect the 200-display-width listing rule.

import { describe, it, expect } from 'vitest';

// Discovery env must be set BEFORE api/wk.js (and the env module it imports)
// loads — same stub set tests/api/x402-discovery-parity.test.js uses.
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

const {
	getCatalog,
	getByStorefront,
	toBazaarDiscovery,
	toOkxCatalog,
	priceUsdFromAtomics,
} = await import('../api/_lib/service-catalog/index.js');
const { PAID_SERVICES } = await import('../api/_lib/service-catalog/services/index.js');
const { catalogIndex, displayWidth, DESCRIPTION_MAX_WIDTH } = await import(
	'../api/_lib/okx-catalog.js'
);

async function renderDiscovery() {
	const mod = await import('../api/wk.js');
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(body) {
			this.body = body;
		},
	};
	const req = {
		method: 'GET',
		url: '/.well-known/x402-discovery?name=x402-discovery',
		query: { name: 'x402-discovery' },
		headers: {},
	};
	await mod.default(req, res);
	return JSON.parse(res.body);
}

describe('catalog assembly', () => {
	it('merges every source with unique slugs and complete canonical fields', async () => {
		const all = await getCatalog();
		const bySource = (s) => all.filter((e) => e.source === s);
		expect(bySource('x402').length).toBe(PAID_SERVICES.length);
		expect(bySource('crypto-catalog').length).toBeGreaterThanOrEqual(9);
		expect(bySource('3d-catalog').length).toBeGreaterThanOrEqual(2);
		expect(bySource('okx').length).toBeGreaterThanOrEqual(10);
		expect(new Set(all.map((e) => e.slug)).size).toBe(all.length);
		for (const e of all) {
			for (const field of ['slug', 'title', 'category', 'useCase', 'method', 'path', 'endpoint', 'description']) {
				expect(e[field], `${e.slug}.${field}`).toBeTruthy();
			}
			expect(Array.isArray(e.tags) && e.tags.length >= 2, `${e.slug}.tags`).toBe(true);
			expect(Array.isArray(e.storefronts) && e.storefronts.length > 0, `${e.slug}.storefronts`).toBe(true);
			expect(typeof e.free).toBe('boolean');
			if (e.free) expect(e.price).toBeNull();
			else {
				expect(e.price?.usd, `${e.slug}.price.usd`).toMatch(/^\d+(\.\d+)?$/);
				expect(e.price?.atomics, `${e.slug}.price.atomics`).toMatch(/^\d+$/);
				expect(e.price.networks.length).toBeGreaterThan(0);
			}
		}
	});

	it('paid descriptors carry the discovery-listing essentials', () => {
		for (const s of PAID_SERVICES) {
			expect(s.path, s.slug).toBe(`/api/x402/${s.slug}`);
			expect(s.description.length, `${s.slug} description`).toBeGreaterThanOrEqual(60);
			expect(s.serviceName.length, `${s.slug} serviceName`).toBeLessThanOrEqual(32);
			expect(s.tags.length).toBeLessThanOrEqual(5);
			expect(['standard', 'cdp-bazaar', 'permit2-only']).toContain(s.acceptsBuilder);
			expect(s.priceAtomics).toMatch(/^\d+$/);
		}
	});

	it('getByStorefront filters by storefront membership', async () => {
		const x402scan = await getByStorefront('x402scan');
		const okx = await getByStorefront('okx');
		expect(x402scan.length).toBe(PAID_SERVICES.length);
		expect(x402scan.every((e) => e.source === 'x402')).toBe(true);
		expect(okx.every((e) => e.source === 'okx')).toBe(true);
		expect(okx.length).toBeGreaterThanOrEqual(10);
	});

	it('priceUsdFromAtomics matches the discovery formatter', () => {
		expect(priceUsdFromAtomics('10000')).toBe('0.01');
		expect(priceUsdFromAtomics('1000')).toBe('0.001');
		expect(priceUsdFromAtomics('5000000')).toBe('5');
		expect(priceUsdFromAtomics('150000')).toBe('0.15');
	});
});

describe('x402scan projection (toBazaarDiscovery)', () => {
	const stubAccepts = (service, url) =>
		service.acceptsBuilder === 'permit2-only'
			? null
			: [{ scheme: 'exact', network: 'solana:mainnet', amount: service.priceAtomics, resource: url }];
	const stubExtensions = (accepts, bazaar) => ({ bazaar });

	it('emits one resource per live non-gated service, in catalog order', () => {
		const items = toBazaarDiscovery({
			origin: 'https://three.ws',
			acceptsFor: stubAccepts,
			extensionsForAccepts: stubExtensions,
		});
		const expected = PAID_SERVICES.filter(
			(s) => s.status === 'live' && s.acceptsBuilder !== 'permit2-only',
		);
		expect(items.map((r) => r.path)).toEqual(expected.map((s) => s.path));
		for (const r of items) {
			expect(r.url).toBe(`https://three.ws${r.path}`);
			expect(r.mimeType).toBe('application/json');
			expect(r.iconUrl).toMatch(/^https:\/\//);
			expect(r.accepts[0].amount).toMatch(/^\d+$/);
			expect(r.extensions.bazaar).toBeTruthy();
		}
	});

	it('omits a service whose acceptsFor returns null (permit2 without CDP creds)', () => {
		const items = toBazaarDiscovery({
			origin: 'https://three.ws',
			acceptsFor: stubAccepts,
			extensionsForAccepts: stubExtensions,
		});
		expect(items.some((r) => r.path === '/api/x402/permit2-paid-demo')).toBe(false);
	});
});

describe('no drift: live discovery doc ⇄ catalog', () => {
	it('every catalog x402scan entry is served with identical listing metadata', async () => {
		const doc = await renderDiscovery();
		const byPath = new Map(doc.resources.filter((r) => !r.toolName).map((r) => [r.path, r]));
		for (const s of PAID_SERVICES) {
			const live = byPath.get(s.path);
			if (s.acceptsBuilder === 'permit2-only' && !live) continue; // omitted without CDP creds — matches the runtime 402
			expect(live, `${s.path} missing from discovery doc`).toBeTruthy();
			expect(live.description, `${s.path} description drift`).toBe(s.description);
			expect(live.serviceName, `${s.path} serviceName drift`).toBe(s.serviceName);
			expect(live.tags, `${s.path} tags drift`).toEqual(s.tags);
			expect(live.method, `${s.path} method drift`).toBe(s.method);
			expect(live.accepts[0].amount, `${s.path} price drift`).toBe(s.priceAtomics);
		}
	});

	it('serves no static x402 resource the catalog does not know about', async () => {
		const doc = await renderDiscovery();
		const catalogPaths = new Set(PAID_SERVICES.map((s) => s.path));
		const rogue = doc.resources
			.filter((r) => !r.toolName && r.path?.startsWith('/api/x402/'))
			.filter((r) => !catalogPaths.has(r.path))
			// agent-published listings are dynamic rows from agent_paid_services,
			// cataloged per-listing by design.
			.filter((r) => !r.path.startsWith('/api/x402/service/'))
			// datapoint-fabric entries are a runtime-derived slice of the 400k+
			// dynamic (family, id, metric) endpoints — registry-driven, not
			// service-catalog descriptors (see api/_lib/market-data/datapoints.js).
			.filter((r) => !r.path.startsWith('/api/x402/d/'));
		expect(rogue.map((r) => r.path)).toEqual([]);
	});
});

describe('OKX projection (toOkxCatalog)', () => {
	it('default mode reproduces okx-catalog.js catalogIndex() exactly', () => {
		expect(toOkxCatalog()).toEqual(catalogIndex());
	});

	it('include:"all" appends every live paid x402 service in the OKX row schema', () => {
		const full = toOkxCatalog({ include: 'all' });
		const base = catalogIndex();
		expect(full.services.slice(0, base.services.length)).toEqual(base.services);
		const projected = full.services.slice(base.services.length);
		expect(projected.length).toBe(PAID_SERVICES.filter((s) => s.status === 'live').length);
		for (const row of projected) {
			expect(row.id).toMatch(/^[a-z0-9-]+$/);
			expect(row.kind).toBe('rest');
			expect(row.name).toBeTruthy();
			expect(row.price_usd).toMatch(/^\d+(\.\d+)?$/);
			expect(row.endpoint).toMatch(/^https:\/\/three\.ws\/api\/x402\/[a-z0-9-]+$/);
			for (const part of ['capability', 'input']) {
				const text = row.description[part];
				expect(text, `${row.id} description.${part}`).toBeTruthy();
				expect(
					displayWidth(text),
					`${row.id} description.${part} exceeds ${DESCRIPTION_MAX_WIDTH}`,
				).toBeLessThanOrEqual(DESCRIPTION_MAX_WIDTH);
			}
		}
	});
});
