// Fulfillment webhooks: authenticity first, then idempotency, then ordering.
//
// Every serious fulfillment provider retries deliveries. A replayed webhook
// that appends a second timeline row, or drives the state machine a second
// time, turns an ordinary retry into a corrupted order. The ledger insert on
// print_webhook_deliveries is the lock that prevents it, and this file pins
// the three properties the endpoint depends on:
//
//   1. An unverified delivery is refused BEFORE the body is parsed.
//   2. The claim happens before the payload is interpreted, so even a delivery
//      we end up not applying is recorded and cannot be replayed.
//   3. A duplicate answers 200 (a 4xx makes a provider retry forever) and
//      applies nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-hmac-secret-not-a-real-credential';

// A ledger with the real unique constraint, so "claimed twice" behaves the way
// Postgres does rather than the way a stub might.
const ledger = new Set();
const claimWebhookDelivery = vi.fn(async ({ provider, deliveryId }) => {
	const key = `${provider}:${deliveryId}`;
	if (ledger.has(key)) return { fresh: false };
	ledger.add(key);
	return { fresh: true };
});
const markWebhookApplied = vi.fn(async () => {});
const getOrderByProviderId = vi.fn(async () => ORDER);

vi.mock('../api/_lib/print/fulfillment-queries.js', () => ({
	claimWebhookDelivery,
	markWebhookApplied,
	getOrderByProviderId,
	printStoreEnabled: () => true,
	ADAPTER_DRIVABLE_STATUSES: ['submitted', 'printing', 'quality_check', 'shipped', 'delivered', 'canceled', 'rejected'],
	OPEN_PROVIDER_STATUSES: ['submitted', 'printing', 'quality_check', 'shipped'],
}));

// The timeline the endpoint is not allowed to duplicate.
const timeline = [];
const applyProviderEvent = vi.fn(async ({ order, event }) => {
	timeline.push({ status: event.status, note: event.note });
	return { applied: true, order: { ...order, status: event.status }, reason: '' };
});
vi.mock('../api/_lib/print/fulfillment.js', () => ({
	applyProviderEvent,
	submitOrder: vi.fn(),
	reconcileOrder: vi.fn(),
	cancelWithProvider: vi.fn(),
	FulfillmentError: class FulfillmentError extends Error {},
}));

const ORDER = {
	id: '00000000-0000-4000-8000-000000000002',
	status: 'printing',
	provider: 'partner-cn',
	provider_order_id: 'p-42',
};

const handler = (await import('../api/print/webhook/[provider].js')).default;

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

const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

async function deliver(body, { provider = 'partner-cn', headers = {}, signed = true } = {}) {
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const res = mockRes();
	await handler(
		{
			method: 'POST',
			url: `/api/print/webhook/${provider}`,
			query: { provider },
			headers: {
				host: 'three.ws',
				'content-type': 'application/json',
				...(signed ? { 'x-print-signature': `sha256=${sign(raw)}` } : {}),
				...headers,
			},
			rawBody: Buffer.from(raw),
		},
		res,
	);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	ledger.clear();
	timeline.length = 0;
	process.env.PRINT_PARTNER_CN_URL = 'https://partner.invalid/api';
	process.env.PRINT_PARTNER_CN_KEY = SECRET;
	getOrderByProviderId.mockResolvedValue(ORDER);
});

describe('a replayed delivery is applied exactly once', () => {
	const PAYLOAD = { id: 'p-42', state: 'shipped', tracking_number: '1Z999', carrier: 'UPS' };

	it('applies the first delivery and appends one timeline entry', async () => {
		const res = await deliver(PAYLOAD);
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ ok: true, applied: true, status: 'shipped' });
		expect(timeline).toHaveLength(1);
	});

	it('answers 200 duplicate on the replay and appends nothing', async () => {
		await deliver(PAYLOAD);
		const replay = await deliver(PAYLOAD);
		expect(replay.statusCode).toBe(200);
		expect(replay.json).toMatchObject({ ok: true, duplicate: true, applied: false });
		expect(applyProviderEvent).toHaveBeenCalledTimes(1);
		expect(timeline).toHaveLength(1);
	});

	it('stays at one even after five retries', async () => {
		for (let i = 0; i < 5; i += 1) await deliver(PAYLOAD);
		expect(timeline).toHaveLength(1);
	});

	it('treats a genuinely different event as a new delivery', async () => {
		await deliver(PAYLOAD);
		await deliver({ ...PAYLOAD, state: 'delivered' });
		expect(timeline.map((e) => e.status)).toEqual(['shipped', 'delivered']);
	});

	it('honours the provider delivery id over the payload hash when they send one', async () => {
		// Same delivery id, different body: their id is authoritative, so this is
		// still one event.
		await deliver(PAYLOAD, { headers: { 'x-print-delivery': 'dlv_7' } });
		const replay = await deliver({ ...PAYLOAD, note: 'resent with a note' }, { headers: { 'x-print-delivery': 'dlv_7' } });
		expect(replay.json.duplicate).toBe(true);
		expect(timeline).toHaveLength(1);
	});
});

describe('authenticity is settled before anything else happens', () => {
	it('refuses an unsigned delivery with 401', async () => {
		const res = await deliver({ id: 'p-42', state: 'shipped' }, { signed: false });
		expect(res.statusCode).toBe(401);
	});

	it('refuses a forged signature and never claims a ledger row', async () => {
		const res = await deliver({ id: 'p-42', state: 'shipped' }, { headers: { 'x-print-signature': 'sha256=deadbeef' } });
		expect(res.statusCode).toBe(401);
		expect(claimWebhookDelivery).not.toHaveBeenCalled();
		expect(applyProviderEvent).not.toHaveBeenCalled();
	});

	it('refuses a body altered in flight', async () => {
		const raw = JSON.stringify({ id: 'p-42', state: 'printing' });
		const res = mockRes();
		await handler(
			{
				method: 'POST',
				url: '/api/print/webhook/partner-cn',
				query: { provider: 'partner-cn' },
				headers: { host: 'three.ws', 'content-type': 'application/json', 'x-print-signature': sign(raw) },
				rawBody: Buffer.from(raw.replace('printing', 'shipped!')),
			},
			res,
		);
		expect(res.statusCode).toBe(401);
	});

	it('404s a provider with no configured adapter, offering nothing to probe', async () => {
		const res = await deliver({ id: 'x' }, { provider: 'not-a-lane' });
		expect(res.statusCode).toBe(404);
	});

	it('refuses a delivery to the manual lane, which has no webhook by design', async () => {
		const res = await deliver({ id: 'x' }, { provider: 'manual' });
		expect(res.statusCode).toBe(401);
		expect(res.json.error_description).toMatch(/no webhook/);
	});

	it('rejects a non-POST', async () => {
		const res = mockRes();
		await handler({ method: 'GET', url: '/api/print/webhook/partner-cn', query: { provider: 'partner-cn' }, headers: {} }, res);
		expect(res.statusCode).toBe(405);
	});
});

describe('a verified delivery we cannot apply is still recorded', () => {
	it('claims the delivery before parsing, so malformed JSON cannot be replayed', async () => {
		const res = await deliver('{not json');
		expect(res.statusCode).toBe(400);
		expect(claimWebhookDelivery).toHaveBeenCalledTimes(1);
	});

	it('answers 200 for an unknown order so the provider stops retrying', async () => {
		getOrderByProviderId.mockResolvedValue(null);
		const res = await deliver({ id: 'p-does-not-exist', state: 'shipped' });
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ applied: false, reason: 'no matching order' });
	});

	it('reports applied:false when the state machine refuses the move', async () => {
		applyProviderEvent.mockResolvedValue({ applied: false, order: ORDER, reason: 'a print order cannot go from printing to quoted' });
		const res = await deliver({ id: 'p-42', state: 'shipped' });
		expect(res.statusCode).toBe(200);
		expect(res.json).toMatchObject({ applied: false, status: 'printing' });
		expect(res.json.reason).toMatch(/cannot go from/);
	});

	it('makes a provider retry when the database is unavailable', async () => {
		vi.resetModules();
		vi.doMock('../api/_lib/print/fulfillment-queries.js', () => ({
			claimWebhookDelivery,
			markWebhookApplied,
			getOrderByProviderId,
			printStoreEnabled: () => false,
			ADAPTER_DRIVABLE_STATUSES: ['shipped'],
			OPEN_PROVIDER_STATUSES: ['shipped'],
		}));
		const fresh = (await import('../api/print/webhook/[provider].js')).default;
		const raw = JSON.stringify({ id: 'p-42', state: 'shipped' });
		const res = mockRes();
		await fresh(
			{
				method: 'POST',
				url: '/api/print/webhook/partner-cn',
				query: { provider: 'partner-cn' },
				headers: { host: 'three.ws', 'content-type': 'application/json', 'x-print-signature': sign(raw) },
				rawBody: Buffer.from(raw),
			},
			res,
		);
		expect(res.statusCode).toBe(503);
	});
});
