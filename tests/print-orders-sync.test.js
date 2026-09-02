// The fulfillment reconciliation sweep.
//
// Webhooks are the fast path and they are not sufficient: a delivery gets lost,
// a partner's callback queue backs up, and the manual lane has no webhook at
// all. Without this sweep the worst failure a physical product has goes
// unnoticed, which is a finished order sitting in `printing` until the buyer
// asks.
//
// Three behaviours are load-bearing and all are pinned here: an unreachable
// provider must not abort the sweep (the stall pass is exactly what catches the
// orders that provider is sitting on), a stalled order must page the operator
// once rather than on every tick, and the certificate attestation lane must
// retry what shipping could not send without ever being able to take the sweep
// down with it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listOpenProviderOrders = vi.fn(async () => []);
const listStalledOrders = vi.fn(async () => []);
const markStallAlerted = vi.fn(async (ids) => ids.length);
vi.mock('../api/_lib/print/fulfillment-queries.js', () => ({
	listOpenProviderOrders,
	listStalledOrders,
	markStallAlerted,
	printStoreEnabled: () => true,
	ADAPTER_DRIVABLE_STATUSES: ['submitted', 'printing', 'shipped'],
	OPEN_PROVIDER_STATUSES: ['submitted', 'printing', 'quality_check', 'shipped'],
}));

const reconcileOrder = vi.fn(async (order) => ({ applied: false, order, reason: '', polled: true }));
vi.mock('../api/_lib/print/fulfillment.js', () => ({
	reconcileOrder,
	submitOrder: vi.fn(),
	applyProviderEvent: vi.fn(),
	cancelWithProvider: vi.fn(),
	FulfillmentError: class FulfillmentError extends Error {},
}));

const retryPendingAttestations = vi.fn(async () => ({
	scanned: 0, attested: 0, refused: 0, failed: 0, qrBackfilled: 0,
}));
vi.mock('../api/_lib/print/certificate.js', () => ({
	retryPendingAttestations,
	certCluster: () => 'devnet',
}));

const notifyOperators = vi.fn(async () => {});
vi.mock('../api/_lib/print/ops-notify.js', () => ({
	notifyOperators,
	jobSummaryLines: (order) => [`Order ${String(order.id).slice(0, 8)}`],
	operatorChannelConfigured: () => true,
}));

const handler = (await import('../api/cron/print-orders-sync.js')).default;

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(b) { this._body = b || ''; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
		get json() { try { return JSON.parse(this._body); } catch { return null; } },
	};
}

const CRON_SECRET = 'test-cron-secret';

async function sweep({ authorized = true } = {}) {
	const res = mockRes();
	await handler(
		{
			method: 'GET',
			url: '/api/cron/print-orders-sync',
			headers: { host: 'three.ws', ...(authorized ? { authorization: `Bearer ${CRON_SECRET}` } : {}) },
		},
		res,
	);
	return res;
}

/** An order submitted `daysAgo` days back with a `leadTimeDays` promise. */
function order({ id, daysAgo, leadTimeDays = 10, status = 'printing', provider = 'manual' }) {
	return {
		id,
		status,
		provider,
		provider_order_id: id,
		lead_time_days: leadTimeDays,
		material_id: 'resin-standard',
		quantity: 1,
		price_usdc: '42.000000',
		shipping: { country: 'US' },
		submitted_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.CRON_SECRET = CRON_SECRET;
	listOpenProviderOrders.mockResolvedValue([]);
	listStalledOrders.mockResolvedValue([]);
	markStallAlerted.mockImplementation(async (ids) => ids.length);
	reconcileOrder.mockImplementation(async (o) => ({ applied: false, order: o, reason: '', polled: true }));
	retryPendingAttestations.mockResolvedValue({ scanned: 0, attested: 0, refused: 0, failed: 0, qrBackfilled: 0 });
});

describe('the sweep is scheduler-only', () => {
	it('refuses an unauthenticated caller', async () => {
		const res = await sweep({ authorized: false });
		expect(res.statusCode).toBeGreaterThanOrEqual(401);
		expect(listOpenProviderOrders).not.toHaveBeenCalled();
	});
});

describe('reconciliation pass', () => {
	it('polls every live provider order', async () => {
		listOpenProviderOrders.mockResolvedValue([
			order({ id: 'o-1', daysAgo: 1 }),
			order({ id: 'o-2', daysAgo: 2 }),
		]);
		const res = await sweep();
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ ok: true, open: 2, polled: 2, applied: 0 });
	});

	it('counts the orders a provider actually moved', async () => {
		listOpenProviderOrders.mockResolvedValue([order({ id: 'o-1', daysAgo: 1 })]);
		reconcileOrder.mockResolvedValue({ applied: true, order: {}, reason: '', polled: true });
		expect((await sweep()).json.applied).toBe(1);
	});

	it('an unreachable provider is counted, not thrown, and the sweep continues', async () => {
		listOpenProviderOrders.mockResolvedValue([
			order({ id: 'o-broken', daysAgo: 1, provider: 'partner-cn' }),
			order({ id: 'o-fine', daysAgo: 1 }),
		]);
		reconcileOrder.mockImplementation(async (o) => {
			if (o.id === 'o-broken') throw new Error('partner-cn upstream failure: connect ETIMEDOUT');
			return { applied: false, order: o, reason: '', polled: true };
		});
		const res = await sweep();
		expect(res.statusCode).toBe(200);
		expect(res.json.polled).toBe(1);
		expect(res.json.failures).toHaveLength(1);
		expect(res.json.failures[0]).toMatchObject({ order_id: 'o-broken' });
	});

	it('one broken lane never hides a stall in another', async () => {
		listOpenProviderOrders.mockResolvedValue([order({ id: 'o-broken', daysAgo: 1, provider: 'partner-cn' })]);
		reconcileOrder.mockRejectedValue(new Error('upstream down'));
		listStalledOrders.mockResolvedValue([order({ id: 'o-late', daysAgo: 30 })]);
		const res = await sweep();
		expect(res.json.stalled).toBe(1);
		expect(notifyOperators).toHaveBeenCalledTimes(1);
	});
});

describe('stall detection', () => {
	it('pages the operator for an order past its lead time, with the days late in the title', async () => {
		listStalledOrders.mockResolvedValue([order({ id: 'o-late', daysAgo: 21, leadTimeDays: 10 })]);
		const res = await sweep();
		expect(res.json).toMatchObject({ stalled: 1, alerted: 1 });
		expect(notifyOperators).toHaveBeenCalledTimes(1);
		const call = notifyOperators.mock.calls[0][0];
		expect(call.title).toMatch(/11 days past its lead time/);
		expect(call.orderId).toBe('o-late');
		// A stall is the one ops-notify case that also lands in the durable
		// ops_alerts table: it is the message an operator must not miss.
		expect(call.alert).toBe(true);
	});

	it('stamps every paged order so the next sweep stays quiet', async () => {
		listStalledOrders.mockResolvedValue([
			order({ id: 'o-a', daysAgo: 20 }),
			order({ id: 'o-b', daysAgo: 40 }),
		]);
		await sweep();
		expect(markStallAlerted).toHaveBeenCalledWith(['o-a', 'o-b']);
	});

	it('asks for the grace margin and the re-alert window, not the raw lead time', async () => {
		await sweep();
		expect(listStalledOrders).toHaveBeenCalledWith(expect.objectContaining({ graceDays: 2, realertHours: 24 }));
	});

	it('says nothing when no order is late', async () => {
		listOpenProviderOrders.mockResolvedValue([order({ id: 'o-1', daysAgo: 1 })]);
		const res = await sweep();
		expect(res.json).toMatchObject({ stalled: 0, alerted: 0 });
		expect(notifyOperators).not.toHaveBeenCalled();
	});

	it('never puts a shipping address in an ops message', async () => {
		listStalledOrders.mockResolvedValue([
			{ ...order({ id: 'o-late', daysAgo: 20 }), shipping: { name: 'A Buyer', line1: '1 Test Way', country: 'US' } },
		]);
		await sweep();
		const serialized = JSON.stringify(notifyOperators.mock.calls[0][0]);
		expect(serialized).not.toContain('1 Test Way');
		expect(serialized).not.toContain('A Buyer');
	});
});

describe('the certificate attestation pass', () => {
	it('reports what it attested, alongside the cluster it attested on', async () => {
		retryPendingAttestations.mockResolvedValue({ scanned: 3, attested: 2, refused: 1, failed: 0, qrBackfilled: 1 });
		const res = await sweep({ authorized: true });
		expect(res.statusCode).toBe(200);
		expect(res.json.certificates).toEqual({ scanned: 3, attested: 2, refused: 1, failed: 0, qrBackfilled: 1 });
		expect(res.json.cluster).toBe('devnet');
	});

	it('bounds each tick so a backlog cannot become a rate-limit incident', async () => {
		await sweep({ authorized: true });
		expect(retryPendingAttestations).toHaveBeenCalledWith(
			expect.objectContaining({ limit: expect.any(Number), maxAttempts: expect.any(Number) }),
		);
		const { limit, maxAttempts } = retryPendingAttestations.mock.calls[0][0];
		expect(limit).toBeGreaterThan(0);
		expect(limit).toBeLessThanOrEqual(50);
		expect(maxAttempts).toBeGreaterThan(0);
	});

	it('counts an attestation outage as a failure rather than losing the whole sweep', async () => {
		retryPendingAttestations.mockRejectedValue(new Error('solana rpc unreachable'));
		const res = await sweep({ authorized: true });
		expect(res.statusCode).toBe(200);
		expect(res.json.ok).toBe(true);
		expect(res.json.failures).toContainEqual(
			expect.objectContaining({ order_id: 'certificates' }),
		);
		// The passes that matter more still ran.
		expect(listStalledOrders).toHaveBeenCalled();
	});
});
