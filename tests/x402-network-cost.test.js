/**
 * GET /api/x402/network-cost: the settlement-rail recommendation.
 *
 * Free operational read over the snapshots the cross-chain-cost loop writes
 * hourly. Two things make it worth pinning rather than eyeballing:
 *
 *   - It steers real money. `recommended_network` is what the app reads to pick
 *     the cheaper rail, so an empty table must return null rather than a default
 *     that looks like a measurement nobody took.
 *   - Its degraded path is deliberately not an error page. A table that does not
 *     exist yet (the loop has never run) is "no samples", answered 200, while a
 *     genuine read failure is a 503. Collapsing those two states would either
 *     alarm on a cold start or hide a real outage.
 *
 * A local DATABASE_URL is not available to this suite, so the query layer is
 * substituted and the handler runs otherwise untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Queue of results the handler's sequential queries drain, in order:
// latest snapshot, then the rolling-window aggregate.
let queue = [];
let failure = null;

vi.mock('../api/_lib/db.js', () => ({
	sql: async () => {
		if (failure) throw failure;
		return queue.shift() ?? [];
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { default: handler } = await import('../api/x402/network-cost.js');

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

const req = (url = '/api/x402/network-cost') => ({ method: 'GET', url, headers: {}, socket: {} });

const SNAPSHOT = {
	checked_at: '2026-08-14T04:00:00.000Z',
	amount_usd: '0.001',
	solana_advertised: true,
	solana_settled: true,
	solana_gas_usd: '0.0000241',
	solana_total_usd: '0.0010241',
	solana_fee_lamports: '5000',
	solana_fee_source: 'onchain',
	solana_tx: 'THREEsyntheticSignature1111111111111111111111',
	base_advertised: true,
	base_gas_usd: '0.0031',
	base_total_usd: '0.0041',
	base_gas_price_wei: '12000000',
	base_gas_units: '65000',
	gas_premium_ratio: '128.6',
	cheapest_network: 'solana',
	sol_price_usd: '182.4',
	eth_price_usd: '3120.5',
};

const ROLLUP = {
	samples: '48',
	avg_gas_premium_ratio: '121.7',
	avg_solana_gas_usd: '0.0000239',
	avg_base_gas_usd: '0.0029',
	solana_wins: '47',
	base_wins: '1',
};

beforeEach(() => {
	queue = [];
	failure = null;
});

describe('GET /api/x402/network-cost', () => {
	it('returns the latest snapshot, the rolling stats, and a recommendation', async () => {
		queue.push([SNAPSHOT], [ROLLUP]);
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		const b = res.json;
		expect(b.ok).toBe(true);
		expect(b.recommended_network).toBe('solana');
		expect(b.window_hours).toBe(168);
		// Numerics arrive from Postgres as strings; the client gets numbers.
		expect(b.latest.solana.gas_usd).toBe(0.0000241);
		expect(b.latest.solana.fee_lamports).toBe(5000);
		expect(b.latest.base.gas_price_gwei).toBe(0.012);
		expect(b.latest.base.settled).toBe(false);
		expect(b.rolling.samples).toBe(48);
		expect(b.rolling.solana_cheapest_count).toBe(47);
		expect(b.rolling.avg_gas_premium_ratio).toBe(121.7);
	});

	it('clamps the window instead of trusting the query string', async () => {
		queue.push([SNAPSHOT], [ROLLUP]);
		const res = mockRes();
		await handler(req('/api/x402/network-cost?window=99999'), res);
		expect(res.json.window_hours).toBe(720);

		queue.push([SNAPSHOT], [ROLLUP]);
		const res2 = mockRes();
		await handler(req('/api/x402/network-cost?window=abc'), res2);
		expect(res2.json.window_hours).toBe(168);
	});

	it('recommends nothing when no snapshot has ever been taken', async () => {
		queue.push([], [{ samples: '0' }]);
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.recommended_network).toBeNull();
		expect(res.json.latest).toBeNull();
		expect(res.json.rolling.samples).toBe(0);
	});

	it('falls back to the window majority when the latest row has no verdict', async () => {
		queue.push(
			[{ ...SNAPSHOT, cheapest_network: null }],
			[{ ...ROLLUP, solana_wins: '2', base_wins: '30' }],
		);
		const res = mockRes();
		await handler(req(), res);

		expect(res.json.recommended_network).toBe('base');
	});

	it('answers 200 no_samples_yet when the loop has never created the table', async () => {
		failure = new Error('relation "cross_chain_cost_comparison" does not exist');
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(200);
		expect(res.json.note).toBe('no_samples_yet');
		expect(res.json.recommended_network).toBeNull();
		expect(res.json.error).toBeUndefined();
	});

	it('answers 503 on a real read failure rather than pretending it is empty', async () => {
		failure = new Error('connection terminated unexpectedly');
		const res = mockRes();
		await handler(req(), res);

		expect(res.statusCode).toBe(503);
		expect(res.json.ok).toBe(false);
		expect(res.json.error).toBe('network_cost_read_failed');
		expect(res.json.note).toBeUndefined();
	});

	it('refuses a method other than GET', async () => {
		const res = mockRes();
		await handler({ ...req(), method: 'POST' }, res);
		expect(res.statusCode).toBe(405);
	});
});
