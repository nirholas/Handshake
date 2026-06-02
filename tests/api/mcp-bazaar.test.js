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

const { dispatch } = await import('../../api/_mcpbazaar/dispatch.js');

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
	it('exposes the discovery toolset', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, AUTH);
		expect(r.result.tools.map((t) => t.name)).toEqual([
			'search_services',
			'browse_services',
			'get_service',
		]);
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

	it('honors the rate limit', async () => {
		rlState.bazaar = { success: false, reset: Date.now() + 30000 };
		const r = await call('search_services', { query: 'weather' });
		expect(r.error.code).toBe(-32000);
		expect(bazState.search).not.toHaveBeenCalled();
	});
});
