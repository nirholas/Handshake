import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

// ── Bazaar client (live facilitator network) ─────────────────────────────────
const bazState = {
	search: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
};
vi.mock('../../api/_lib/x402/bazaar-client.js', async (orig) => {
	const real = await orig();
	return {
		...real,
		Bazaar: class {
			search(...a) {
				return bazState.search(...a);
			}
			list(...a) {
				return bazState.list(...a);
			}
			get(...a) {
				return bazState.get(...a);
			}
		},
	};
});

// ── Rate limits ──────────────────────────────────────────────────────────────
const rlState = { bazaar: { success: true, reset: Date.now() + 60000 } };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { mcpBazaar: vi.fn(async () => rlState.bazaar) },
	clientIp: vi.fn(() => '203.0.113.7'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { dispatch, isPublicTool, PROTOCOL_VERSION } = await import('../../api/_mcpbazaar/dispatch.js');
const { TOOL_CATALOG, TOOLS } = await import('../../api/_mcpbazaar/catalog.js');

const AUTH = { userId: null, rateKey: 'test', scope: '', source: 'x402' };
const call = (name, args) =>
	dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, AUTH);

// A normalized bazaar item (shape produced by normalizeItem).
function item(over = {}) {
	return {
		type: 'http',
		resource: 'https://api.weather.test/now',
		toolName: '',
		uniqueKey: 'https://api.weather.test/now',
		serviceName: 'Weather Now',
		description: 'Current weather by city.',
		minPriceLabel: '$0.001',
		minPriceAtomic: 1000,
		networks: ['eip155:8453'],
		tags: ['weather'],
		method: 'GET',
		accepts: [
			{
				network: 'eip155:8453',
				priceLabel: '$0.001',
				amountAtomic: 1000,
				asset: '0xUSDC',
				payTo: '0xRecipient',
				scheme: 'exact',
			},
		],
		input: { type: 'http', method: 'GET' },
		output: null,
		facilitator: 'https://facilitator.test',
		...over,
	};
}

beforeEach(() => {
	bazState.search.mockReset();
	bazState.list.mockReset();
	bazState.get.mockReset();
	rlState.bazaar = { success: true, reset: Date.now() + 60000 };
});

describe('x402 Bazaar MCP', () => {
	it('exposes the discovery toolset behind a free getting_started tool', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, AUTH);
		expect(r.result.tools.map((t) => t.name)).toEqual([
			'getting_started',
			'search_services',
			'browse_services',
			'get_service',
			'bazaar_service_details',
		]);
	});

	it('getting_started is free and callable with no auth', async () => {
		expect(isPublicTool('getting_started')).toBe(true);
		expect(isPublicTool('search_services')).toBe(false);
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getting_started', arguments: {} } },
			{ userId: null, rateKey: null, scope: '', source: 'free' },
		);
		expect(r.result.structuredContent.server).toBe('three.ws x402 Bazaar');
		expect(r.result.structuredContent.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(['search_services', 'get_service']),
		);
	});

	it('search_services returns ranked, slimmed services', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [{ ok: true }], errors: [] });
		const r = await call('search_services', { query: 'weather' });
		expect(bazState.search).toHaveBeenCalledWith({ query: 'weather', type: 'http' });
		const svc = r.result.structuredContent.services[0];
		expect(svc).toMatchObject({ name: 'Weather Now', price: '$0.001', resource: 'https://api.weather.test/now' });
		expect(svc.raw).toBeUndefined();
	});

	it('search_services filters by max_price_usdc', async () => {
		bazState.search.mockResolvedValue({
			resources: [item(), item({ resource: 'https://pricey.test', uniqueKey: 'https://pricey.test', minPriceAtomic: 5_000_000, minPriceLabel: '$5', accepts: [{ network: 'eip155:8453', priceLabel: '$5', amountAtomic: 5_000_000, asset: '0xUSDC' }] })],
			sources: [],
			errors: [],
		});
		const r = await call('search_services', { query: 'x', max_price_usdc: 1 });
		expect(r.result.structuredContent.services).toHaveLength(1);
		expect(r.result.structuredContent.services[0].resource).toBe('https://api.weather.test/now');
	});

	// A cap large enough that Number to String flips to exponential ("1e+21")
	// used to reach parseAtomicAmount as a non-integer string and throw a
	// TypeError out of filterByMaxPrice, failing the whole tool call.
	it('search_services treats an oversized max_price_usdc as no cap', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const r = await call('search_services', { query: 'x', max_price_usdc: 1e21 });
		expect(r.error).toBeUndefined();
		expect(r.result.isError).toBeUndefined();
		expect(r.result.structuredContent.services).toHaveLength(1);
	});

	it('search_services caps at a large but representable price without erroring', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const r = await call('search_services', { query: 'x', max_price_usdc: 1e15 });
		expect(r.result.structuredContent.services).toHaveLength(1);
	});

	// `network` is a user-supplied wildcard pattern compiled to a RegExp. A bare
	// "?" used to compile to /^?$/ and throw "Nothing to repeat"; a pattern that
	// matches no network must return no services, not an error.
	it('search_services returns no matches for a regex-metacharacter network', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const r = await call('search_services', { query: 'x', network: '?' });
		expect(r.error).toBeUndefined();
		expect(r.result.isError).toBeUndefined();
		expect(r.result.structuredContent.count).toBe(0);
	});

	it('search_services still honors the * wildcard in a network filter', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const hit = await call('search_services', { query: 'x', network: 'eip155:*' });
		expect(hit.result.structuredContent.count).toBe(1);
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const miss = await call('search_services', { query: 'x', network: 'solana:*' });
		expect(miss.result.structuredContent.count).toBe(0);
	});

	it('browse_services lists without a query', async () => {
		bazState.list.mockResolvedValue({ items: [item()], sources: [], errors: [] });
		const r = await call('browse_services', {});
		expect(bazState.list).toHaveBeenCalledWith({ type: 'http' });
		expect(r.result.structuredContent.count).toBe(1);
	});

	it('get_service returns payment options and a pay link', async () => {
		bazState.get.mockResolvedValue(item());
		const r = await call('get_service', { resource_url: 'https://api.weather.test/now' });
		const sc = r.result.structuredContent;
		expect(sc.accepts[0]).toMatchObject({ network: 'eip155:8453', price: '$0.001', pay_to: '0xRecipient' });
		expect(sc.pay_link).toBe('https://three.ws/pay?resource=https%3A%2F%2Fapi.weather.test%2Fnow');
		expect(sc.input_schema).toEqual({ type: 'http', method: 'GET' });
	});

	it('get_service reports a miss as a tool error', async () => {
		bazState.get.mockResolvedValue(null);
		const r = await call('get_service', { resource_url: 'https://nope.test' });
		expect(r.result.isError).toBe(true);
	});

	it('bazaar_service_details returns the live cheapest price across networks', async () => {
		bazState.get.mockResolvedValue(
			item({
				accepts: [
					{ network: 'eip155:8453', priceLabel: '$0.002', amountAtomic: 2000, asset: '0xUSDC', payTo: '0xR', scheme: 'exact' },
					{ network: 'solana:mainnet', priceLabel: '$0.001', amountAtomic: 1000, asset: 'SolUSDC', payTo: 'SoR', scheme: 'exact' },
				],
			}),
		);
		const r = await call('bazaar_service_details', { resource_url: 'https://api.weather.test/now' });
		const sc = r.result.structuredContent;
		expect(sc.available).toBe(true);
		expect(sc.service_key).toBe('https://api.weather.test/now');
		expect(sc.min_price_atomic).toBe(1000);
		expect(sc.prices).toHaveLength(2);
		expect(sc.prices[1]).toMatchObject({ network: 'solana:mainnet', amount_atomic: 1000, price: '$0.001' });
	});

	it('bazaar_service_details reports an unlisted service as available:false (not an error)', async () => {
		bazState.get.mockResolvedValue(null);
		const r = await call('bazaar_service_details', { resource_url: 'https://gone.test', tool_name: 'x' });
		const sc = r.result.structuredContent;
		expect(r.result.isError).toBeUndefined();
		expect(sc.available).toBe(false);
		expect(sc.service_key).toBe('https://gone.test#x');
		expect(sc.min_price_atomic).toBeNull();
		expect(sc.prices).toEqual([]);
	});

	it('honors the rate limit', async () => {
		rlState.bazaar = { success: false, reset: Date.now() + 30000 };
		const r = await call('search_services', { query: 'weather' });
		expect(r.error.code).toBe(-32000);
		expect(bazState.search).not.toHaveBeenCalled();
	});

	// The list line is quoted verbatim as the advertised output example in the
	// server's x402 challenge (api/_mcpbazaar/discovery.js), so the separator
	// between name and price has to match what clients were promised.
	it('renders a list line with a plain hyphen between name and price', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const r = await call('search_services', { query: 'weather' });
		expect(r.result.content[0].text.split('\n')[0]).toBe('1. Weather Now - $0.001');
	});

	it('treats max_price_usdc: 0 as an exact zero cap, not as unbounded', async () => {
		bazState.search.mockResolvedValue({ resources: [item()], sources: [], errors: [] });
		const r = await call('search_services', { query: 'x', max_price_usdc: 0 });
		expect(r.result.structuredContent.count).toBe(0);
	});

	// A blanket empty-string filter over the rendered lines also removed the
	// deliberate spacer, leaving the pay link flush against the last option.
	it('get_service separates the pay link from the payment options with a blank line', async () => {
		bazState.get.mockResolvedValue(item({ type: 'mcp', toolName: 'forecast' }));
		const r = await call('get_service', {
			resource_url: 'https://api.weather.test/now',
			tool_name: 'forecast',
		});
		const lines = r.result.content[0].text.split('\n');
		const payIdx = lines.findIndex((l) => l.startsWith('Pay & call via three.ws:'));
		expect(payIdx).toBeGreaterThan(0);
		expect(lines[payIdx - 1]).toBe('');
		expect(r.result.structuredContent.pay_link).toBe(
			'https://three.ws/pay?resource=https%3A%2F%2Fapi.weather.test%2Fnow&tool=forecast',
		);
	});

	it('get_service names the 402 challenge when a service advertises no accepts', async () => {
		bazState.get.mockResolvedValue(item({ accepts: [], minPriceLabel: '' }));
		const r = await call('get_service', { resource_url: 'https://api.weather.test/now' });
		const lines = r.result.content[0].text.split('\n');
		const optIdx = lines.indexOf('Payment options:');
		// Never leave "Payment options:" as a dangling header with nothing under it.
		expect(lines[optIdx + 1]).toContain('402 challenge on call');
		expect(r.result.structuredContent.accepts).toEqual([]);
	});

	it('get_service falls back to the challenge recipient when an accept has no payTo', async () => {
		bazState.get.mockResolvedValue(
			item({ accepts: [{ network: 'solana:mainnet', priceLabel: '$0.01', amountAtomic: 10000, asset: 'SolUSDC', scheme: 'exact' }] }),
		);
		const r = await call('get_service', { resource_url: 'https://api.weather.test/now' });
		expect(r.result.content[0].text).toContain('(recipient in challenge)');
		expect(r.result.structuredContent.accepts[0].pay_to).toBeUndefined();
	});

	// available:true and available:false are diffed field by field by a price
	// tracker, so an absent label has to serialize as null in both branches.
	it('bazaar_service_details reports a missing price label as null, not an absent key', async () => {
		bazState.get.mockResolvedValue(item({ minPriceLabel: '', accepts: [] }));
		const r = await call('bazaar_service_details', { resource_url: 'https://api.weather.test/now' });
		const sc = r.result.structuredContent;
		expect(sc.available).toBe(true);
		expect(sc.min_price_label).toBeNull();
		expect(JSON.parse(JSON.stringify(sc))).toHaveProperty('min_price_label', null);
	});

	it('turns a facilitator outage into a tool error, not a thrown request', async () => {
		bazState.list.mockRejectedValue(new Error('facilitator unreachable'));
		const r = await call('browse_services', {});
		expect(r.error).toBeUndefined();
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain('Error:');
	});

	it('rejects invalid arguments at the schema boundary', async () => {
		const missing = await call('search_services', {});
		expect(missing.error.code).toBe(-32602);
		const badEnum = await call('search_services', { query: 'x', type: 'ftp' });
		expect(badEnum.error.code).toBe(-32602);
		const extra = await call('search_services', { query: 'x', bogus: 1 });
		expect(extra.error.code).toBe(-32602);
		const badUri = await call('get_service', { resource_url: 'not a url' });
		expect(badUri.error.code).toBe(-32602);
		expect(bazState.search).not.toHaveBeenCalled();
		expect(bazState.get).not.toHaveBeenCalled();
	});

	it('does not resolve an inherited Object member as a tool', async () => {
		for (const name of ['__proto__', 'constructor', 'toString']) {
			const r = await dispatch(
				{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
				AUTH,
			);
			expect(r.error.code).toBe(-32602);
			expect(r.error.message).toBe(`unknown tool: ${name}`);
		}
	});

	it('initialize advertises the bazaar server and the pinned protocol version', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, AUTH);
		expect(PROTOCOL_VERSION).toBe('2025-06-18');
		expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(r.result.serverInfo).toEqual({ name: 'three-ws-x402-bazaar', version: '1.0.0' });
		expect(r.result.instructions).toContain('search_services(query)');
	});

	it('keeps handlers and scopes out of the wire catalog', async () => {
		expect(TOOL_CATALOG.map((t) => t.name)).toEqual(Object.keys(TOOLS));
		for (const t of TOOL_CATALOG) {
			expect(t).not.toHaveProperty('handler');
			expect(t).not.toHaveProperty('scope');
			expect(t.inputSchema.type).toBe('object');
			// Omitting destructiveHint makes the MCP spec default it to true, which
			// would mark every read-only discovery tool as destructive.
			expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		}
		for (const [name, t] of Object.entries(TOOLS)) {
			expect(typeof t.handler).toBe('function');
			expect(typeof t.validate).toBe('function');
			// getting_started is the free public entry point: no scope, or the HTTP
			// no-auth bypass would hand back an insufficient-scope error.
			if (name === 'getting_started') expect(t.scope).toBeUndefined();
		}
	});
});
