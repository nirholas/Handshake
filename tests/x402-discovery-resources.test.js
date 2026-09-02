import { describe, it, expect } from 'vitest';
import {
	toV1Accept,
	toV1Item,
	projectDiscoveryResources,
	canServeCachedDoc,
	DISCOVERY_DEFAULT_LIMIT,
	DISCOVERY_MAX_LIMIT,
} from '../api/_lib/x402/discovery-resources.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO = 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';

const solanaAccept = (over = {}) => ({
	scheme: 'exact',
	network: SOLANA_CAIP2,
	network_label: 'solana-mainnet',
	amount: '10000',
	price: '$0.01',
	payTo: PAY_TO,
	asset: USDC_MINT,
	asset_symbol: 'USDC',
	maxTimeoutSeconds: 60,
	resource: 'https://three.ws/api/x402/three-intel',
	extra: { name: 'USDC', decimals: 6 },
	...over,
});

const item = (over = {}) => ({
	path: '/api/x402/three-intel',
	url: 'https://three.ws/api/x402/three-intel',
	method: 'GET',
	description: 'Live $THREE market intel.',
	mimeType: 'application/json',
	serviceName: '$THREE Town Oracle',
	tags: ['three', 'market'],
	accepts: [solanaAccept()],
	...over,
});

const doc = (resources) => ({ resources });

const ISO = '2026-07-25T00:00:00.000Z';

// ── toV1Accept ───────────────────────────────────────────────────────────────

describe('toV1Accept', () => {
	it('projects a v2 Solana accept to the legacy v1 shape', () => {
		const v1 = toV1Accept(solanaAccept(), item());
		expect(v1).toEqual({
			scheme: 'exact',
			network: 'solana',
			maxAmountRequired: '10000',
			resource: 'https://three.ws/api/x402/three-intel',
			description: 'Live $THREE market intel.',
			mimeType: 'application/json',
			payTo: PAY_TO,
			maxTimeoutSeconds: 60,
			asset: USDC_MINT,
			extra: { name: 'USDC', decimals: 6 },
		});
	});

	it('maps Base CAIP-2 to the v1 name', () => {
		const v1 = toV1Accept(
			solanaAccept({ network: 'eip155:8453', payTo: '0x4022de000000000000000000000000000000dEaD', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
			item(),
		);
		expect(v1.network).toBe('base');
	});

	it('drops networks the legacy schema cannot name (Arbitrum, BSC, X Layer)', () => {
		for (const network of ['eip155:42161', 'eip155:56', 'eip155:196']) {
			expect(toV1Accept(solanaAccept({ network }), item())).toBeNull();
		}
	});

	it('drops non-exact schemes', () => {
		expect(toV1Accept(solanaAccept({ scheme: 'direct' }), item())).toBeNull();
	});

	it('drops accepts with a missing or non-atomic amount', () => {
		expect(toV1Accept(solanaAccept({ amount: undefined }), item())).toBeNull();
		expect(toV1Accept(solanaAccept({ amount: '0.01' }), item())).toBeNull();
	});

	it('accepts v1-style maxAmountRequired as the amount source', () => {
		const v1 = toV1Accept(solanaAccept({ amount: undefined, maxAmountRequired: '500' }), item());
		expect(v1.maxAmountRequired).toBe('500');
	});

	it('falls back to the item url and defaults when accept fields are sparse', () => {
		const v1 = toV1Accept(
			solanaAccept({ resource: undefined, maxTimeoutSeconds: undefined, extra: undefined }),
			item({ mimeType: undefined }),
		);
		expect(v1.resource).toBe('https://three.ws/api/x402/three-intel');
		expect(v1.maxTimeoutSeconds).toBe(60);
		expect(v1.mimeType).toBe('application/json');
		expect(v1).not.toHaveProperty('extra');
	});
});

// ── toV1Item ─────────────────────────────────────────────────────────────────

describe('toV1Item', () => {
	it('builds a DiscoveredResource with metadata', () => {
		const v1 = toV1Item(item(), ISO);
		expect(v1.resource).toBe('https://three.ws/api/x402/three-intel');
		expect(v1.type).toBe('http');
		expect(v1.x402Version).toBe(1);
		expect(v1.lastUpdated).toBe(ISO);
		expect(v1.accepts).toHaveLength(1);
		expect(v1.metadata).toMatchObject({
			serviceName: '$THREE Town Oracle',
			method: 'GET',
			path: '/api/x402/three-intel',
		});
	});

	it('returns null when no accept survives the projection', () => {
		expect(toV1Item(item({ accepts: [solanaAccept({ network: 'eip155:42161' })] }), ISO)).toBeNull();
		expect(toV1Item(item({ accepts: [] }), ISO)).toBeNull();
	});

	it('returns null for a resource without a url', () => {
		expect(toV1Item(item({ url: undefined }), ISO)).toBeNull();
	});
});

// ── projectDiscoveryResources ────────────────────────────────────────────────

describe('projectDiscoveryResources', () => {
	const many = (n) =>
		doc(
			Array.from({ length: n }, (_, i) =>
				item({ url: `https://three.ws/api/x402/svc-${i}`, path: `/api/x402/svc-${i}` }),
			),
		);

	it('returns the v1 envelope with pagination', () => {
		const page = projectDiscoveryResources(many(3), { lastUpdated: ISO });
		expect(page.x402Version).toBe(1);
		expect(page.items).toHaveLength(3);
		expect(page.pagination).toEqual({ limit: DISCOVERY_DEFAULT_LIMIT, offset: 0, total: 3 });
	});

	it('pages with limit and offset the way the x402scan crawler does', () => {
		const page1 = projectDiscoveryResources(many(150), { limit: 100, offset: 0 });
		const page2 = projectDiscoveryResources(many(150), { limit: 100, offset: 100 });
		expect(page1.items).toHaveLength(100);
		expect(page2.items).toHaveLength(50);
		expect(page2.pagination).toEqual({ limit: 100, offset: 100, total: 150 });
		expect(page1.items[0].resource).not.toBe(page2.items[0].resource);
	});

	it('clamps limit and floors offset', () => {
		const page = projectDiscoveryResources(many(2), { limit: 999999, offset: -5 });
		expect(page.pagination.limit).toBe(DISCOVERY_MAX_LIMIT);
		expect(page.pagination.offset).toBe(0);
	});

	it('counts only projectable resources in total', () => {
		const mixed = doc([
			item(),
			item({ url: 'https://three.ws/api/x402/arb-only', accepts: [solanaAccept({ network: 'eip155:42161' })] }),
		]);
		const page = projectDiscoveryResources(mixed, {});
		expect(page.pagination.total).toBe(1);
	});

	it('serves an empty page for a non-http type filter', () => {
		const page = projectDiscoveryResources(many(3), { type: 'mcp' });
		expect(page.items).toEqual([]);
		expect(page.pagination.total).toBe(0);
	});

	it('handles a doc with no resources', () => {
		const page = projectDiscoveryResources({}, {});
		expect(page.items).toEqual([]);
		expect(page.pagination.total).toBe(0);
	});

	// A crawler pages this catalog by offset with no cursor. Two builds that
	// hold the same resources in a different order must still page identically,
	// or a sweep reads some resources twice and never reads others at all.
	it('orders a page by resource regardless of catalog insertion order', () => {
		const urls = ['svc-c', 'svc-a', 'svc-b'].map((s) => `https://three.ws/api/x402/${s}`);
		const page = projectDiscoveryResources(
			doc(urls.map((url) => item({ url }))),
			{},
		);
		expect(page.items.map((i) => i.resource)).toEqual([...urls].sort());
	});

	it('pages two shuffled builds of one catalog to the same items', () => {
		const urls = Array.from({ length: 40 }, (_, i) => `https://three.ws/api/x402/svc-${i}`);
		const build = (order) => doc(order.map((url) => item({ url })));
		const forward = projectDiscoveryResources(build(urls), { limit: 10, offset: 20 });
		const reversed = projectDiscoveryResources(build([...urls].reverse()), { limit: 10, offset: 20 });
		expect(forward.items.map((i) => i.resource)).toEqual(reversed.items.map((i) => i.resource));
	});

	// The MCP transports publish one entry per tool at a single resource URL,
	// so `resource` alone is not a total order.
	it('breaks resource ties on tool name so same-url entries page stably', () => {
		const tool = (toolName) =>
			item({ url: 'https://three.ws/api/mcp', path: '/api/mcp', toolName });
		const page = projectDiscoveryResources(doc([tool('render'), tool('inspect'), tool('validate')]), {});
		expect(page.items.map((i) => i.metadata.toolName)).toEqual(['inspect', 'render', 'validate']);
	});
});

// ── Sweep coherence across a catalog rebuild ─────────────────────────────────
//
// The crawler pages by offset with no cursor, so a rebuild landing between two
// pages shifts every row after the churn point: some rows come back twice and
// as many are never served. Pages after the first therefore hold the build the
// sweep started on past the freshness TTL, up to a bounded grace window.

describe('canServeCachedDoc', () => {
	const TTL = 300_000;
	const GRACE = 600_000;

	it('serves a fresh build to any page', () => {
		expect(canServeCachedDoc({ ageMs: 0, continuation: false })).toBe(true);
		expect(canServeCachedDoc({ ageMs: TTL - 1, continuation: true })).toBe(true);
	});

	it('rebuilds for the first page of a sweep once the build is stale', () => {
		expect(canServeCachedDoc({ ageMs: TTL, continuation: false })).toBe(false);
		expect(canServeCachedDoc({ ageMs: TTL + 1, continuation: false })).toBe(false);
	});

	it('keeps a sweep on the build it started on past the TTL', () => {
		expect(canServeCachedDoc({ ageMs: TTL, continuation: true })).toBe(true);
		expect(canServeCachedDoc({ ageMs: TTL + GRACE - 1, continuation: true })).toBe(true);
	});

	it('bounds how long a slow crawler can pin a stale build', () => {
		expect(canServeCachedDoc({ ageMs: TTL + GRACE, continuation: true })).toBe(false);
	});

	it('refuses an unusable age rather than serving an unknown build', () => {
		expect(canServeCachedDoc({ ageMs: Number.NaN, continuation: true })).toBe(false);
		expect(canServeCachedDoc({ ageMs: -1, continuation: true })).toBe(false);
		expect(canServeCachedDoc({ ageMs: Number.POSITIVE_INFINITY, continuation: true })).toBe(false);
	});
});
