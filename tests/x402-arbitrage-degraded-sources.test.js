// A partial facilitator outage shrinks the opportunity list without failing the
// request, which reads on the page as "the market is quiet today" rather than
// "this scan only saw half the catalog". The handler therefore has to hand the
// page both the per-source ok flags and the reasons behind them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const catalog = { http: null, mcp: null };

vi.mock('../api/_lib/x402/bazaar-client.js', () => ({
	Bazaar: class {
		async listCached({ type }) { return catalog[type]; }
	},
	allSourcesFailed: (...results) => {
		const sources = results.flatMap((r) => r?.sources || []);
		return sources.length > 0 && sources.every((s) => !s.ok);
	},
	sourceErrorText: (...results) =>
		results.flatMap((r) => r?.errors || []).map((e) => `${e.facilitator}: ${e.error}`).join('; ') || 'no facilitator answered',
}));

const { default: handler } = await import('../api/bazaar/arbitrage.js');

const PAYAI = 'https://facilitator.payai.network';
const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';

const listing = (host, facilitator, atomic) => ({
	type: 'http',
	resource: `https://${host}/api/weather-forecast`,
	facilitator,
	serviceName: 'Weather Forecast',
	accepts: [{ amountAtomic: String(atomic), assetInfo: { symbol: 'USDC' } }],
});

function mockRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); return this; },
		end(b) { this.body = b; return this; },
	};
	return res;
}

const run = async (query = '') => {
	const res = mockRes();
	await handler({ method: 'GET', url: `/api/bazaar/arbitrage${query}`, headers: { host: 'localhost' } }, res);
	return { status: res.statusCode, data: JSON.parse(res.body) };
};

beforeEach(() => {
	catalog.http = {
		items: [listing('cheap.example.com', PAYAI, 20000), listing('pricey.example.com', PAYAI, 500000)],
		sources: [{ facilitator: PAYAI, count: 2, ok: true }, { facilitator: CDP, count: 0, ok: false }],
		errors: [{ facilitator: CDP, error: 'fetch failed: ETIMEDOUT' }],
	};
	catalog.mcp = { items: [], sources: [{ facilitator: PAYAI, count: 0, ok: true }], errors: [] };
});

describe('arbitrage response under a partial facilitator outage', () => {
	it('still serves the opportunities the reachable facilitators support', async () => {
		const { status, data } = await run();
		expect(status).toBe(200);
		expect(data.opportunities).toHaveLength(1);
		expect(data.opportunities[0].minPriceLabel).toBe('0.02 USDC');
	});

	it('marks the unreachable facilitator so the page can say the scan was partial', async () => {
		const { data } = await run();
		const down = data.sources.filter((s) => !s.ok);
		expect(down).toHaveLength(1);
		expect(down[0].facilitator).toBe(CDP);
		expect(down[0].type).toBe('http');
	});

	it('names why each failed source dropped out', async () => {
		const { data } = await run();
		expect(data.errors).toEqual([{ facilitator: CDP, error: 'fetch failed: ETIMEDOUT', type: 'http' }]);
	});

	it('reports an empty error list when every facilitator answered', async () => {
		catalog.http.sources = [{ facilitator: PAYAI, count: 2, ok: true }];
		catalog.http.errors = [];
		const { data } = await run();
		expect(data.errors).toEqual([]);
		expect(data.sources.every((s) => s.ok)).toBe(true);
	});

	it('fails loudly instead of reporting an empty market when no facilitator answered', async () => {
		catalog.http = { items: [], sources: [{ facilitator: PAYAI, count: 0, ok: false }], errors: [{ facilitator: PAYAI, error: 'ECONNREFUSED' }] };
		catalog.mcp = { items: [], sources: [{ facilitator: PAYAI, count: 0, ok: false }], errors: [] };
		const { status, data } = await run();
		expect(status).toBe(502);
		expect(data.error).toBe('facilitator_error');
	});
});
