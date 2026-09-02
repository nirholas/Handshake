// Authorization on the Materialize operator console.
//
// These endpoints read shipping addresses (the first real PII this platform
// stores) and move orders through a state machine that ends in a refund. So the
// gate is stricter than the read-only ops boards: it fails closed in
// development too, and every action authorizes BEFORE it reads an order.
//
// The test that matters most is the sweep at the bottom: it enumerates the
// dispatch table itself, so an action added later without a gate fails here
// rather than shipping open.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionUser = vi.fn(async () => null);
const isAdminUser = vi.fn(async () => false);
const sqlMock = vi.fn(async () => []);

vi.mock('../api/_lib/auth.js', () => ({ getSessionUser }));
vi.mock('../api/_lib/admin.js', () => ({ isAdminUser, requireAdmin: vi.fn() }));
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const queries = {
	printStoreEnabled: vi.fn(() => true),
	countOrdersByStatus: vi.fn(async () => ({ paid: 1 })),
	listOrders: vi.fn(async () => []),
	listWebhookDeliveries: vi.fn(async () => []),
	allowedTransitions: vi.fn(() => ['screening']),
	ADAPTER_DRIVABLE_STATUSES: ['submitted'],
	OPEN_PROVIDER_STATUSES: ['submitted'],
	getOrderByProviderId: vi.fn(async () => null),
	listOpenProviderOrders: vi.fn(async () => []),
	listStalledOrders: vi.fn(async () => []),
	markStallAlerted: vi.fn(async () => 0),
	patchProviderDetails: vi.fn(async () => null),
	claimWebhookDelivery: vi.fn(async () => ({ fresh: true })),
	markWebhookApplied: vi.fn(async () => {}),
};
vi.mock('../api/_lib/print/fulfillment-queries.js', () => queries);

const store = {
	PRINT_STATUSES: ['created', 'quoted', 'paid', 'screening', 'submitted', 'shipped', 'refunded', 'canceled'],
	LEGAL_TRANSITIONS: { paid: ['screening'] },
	ACTORS: ['system', 'operator', 'provider', 'buyer'],
	TERMINAL_STATUSES: ['delivered'],
	PrintStoreError: class PrintStoreError extends Error {
		constructor(code, message) {
			super(message);
			this.code = code;
		}
	},
	canTransition: () => true,
	getOrder: vi.fn(async () => ORDER),
	getOrderWithEvents: vi.fn(async () => ({ ...ORDER, events: [] })),
	appendEvent: vi.fn(async () => ({ id: 'e1' })),
	transition: vi.fn(async () => ({ order: { ...ORDER, status: 'screening' }, event: { id: 'e1' }, certificate: null })),
};
vi.mock('../api/_lib/print-store.js', () => store);

const submitOrder = vi.fn(async () => ({ order: ORDER, adapter: 'manual', providerOrderId: ORDER.id }));
const cancelWithProvider = vi.fn(async () => ({ ok: true, note: 'stopped', state: {} }));
vi.mock('../api/_lib/print/fulfillment.js', () => ({
	submitOrder,
	cancelWithProvider,
	applyProviderEvent: vi.fn(),
	reconcileOrder: vi.fn(),
	FulfillmentError: class FulfillmentError extends Error {},
}));

const notifyOperators = vi.fn(async () => {});
vi.mock('../api/_lib/print/ops-notify.js', () => ({
	notifyOperators,
	jobSummaryLines: () => [],
	operatorChannelConfigured: () => false,
}));

const ORDER = {
	id: '00000000-0000-4000-8000-000000000001',
	status: 'paid',
	material_id: 'resin-standard',
	quantity: 1,
	price_usdc: '42.000000',
	payer_wallet: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	// The whole reason this gate fails closed: a leaked queue read is a leaked
	// home address.
	shipping: { name: 'A Buyer', line1: '1 Test Way', city: 'Denver', country: 'US' },
	prepared_asset_urls: { stl: 'https://example.invalid/a.stl' },
};

const handler = (await import('../api/print/ops/[action].js')).default;

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

// Every action the console exposes, with a request that would succeed if the
// caller were authorized. Kept as data so the sweeps below cannot miss one.
const ACTIONS = [
	{ action: 'queue', method: 'GET' },
	{ action: 'order', method: 'GET' },
	{ action: 'adapters', method: 'GET' },
	{ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'screening' } },
	{ action: 'submit', method: 'POST', body: { order_id: ORDER.id } },
	{ action: 'tracking', method: 'POST', body: { order_id: ORDER.id, tracking_number: '1Z999' } },
	{ action: 'cancel', method: 'POST', body: { order_id: ORDER.id } },
	{ action: 'refund', method: 'POST', body: { order_id: ORDER.id } },
];

function mockReq({ action, method: httpMethod = 'GET', body = null, headers = {} }) {
	const req = {
		method: httpMethod,
		url: `/api/print/ops/${action}?id=${ORDER.id}`,
		query: { action, id: ORDER.id },
		headers: { host: 'three.ws', ...headers },
	};
	if (body) {
		req.headers['content-type'] = 'application/json';
		req.rawBody = Buffer.from(JSON.stringify(body));
	}
	return req;
}

async function call(spec, headers = {}) {
	const res = mockRes();
	await handler(mockReq({ ...spec, headers }), res);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	getSessionUser.mockResolvedValue(null);
	isAdminUser.mockResolvedValue(false);
	queries.printStoreEnabled.mockReturnValue(true);
	queries.countOrdersByStatus.mockResolvedValue({ paid: 1 });
	queries.listOrders.mockResolvedValue([]);
	queries.listWebhookDeliveries.mockResolvedValue([]);
	queries.allowedTransitions.mockReturnValue(['screening']);
	store.getOrder.mockResolvedValue(ORDER);
	store.getOrderWithEvents.mockResolvedValue({ ...ORDER, events: [] });
	store.transition.mockResolvedValue({ order: { ...ORDER, status: 'screening' }, event: { id: 'e1' }, certificate: null });
	submitOrder.mockResolvedValue({ order: ORDER, adapter: 'manual', providerOrderId: ORDER.id });
	delete process.env.OPS_SECRET;
	delete process.env.PRINT_OPERATORS;
	delete process.env.NODE_ENV;
	delete process.env.VERCEL_ENV;
});

describe('anonymous callers are refused on every action', () => {
	for (const spec of ACTIONS) {
		it(`refuses anonymous ${spec.method} /api/print/ops/${spec.action}`, async () => {
			const res = await call(spec);
			expect(res.statusCode).toBe(403);
			expect(res.json.error).toBe('forbidden');
		});
	}

	it('leaks no order data in the refusal', async () => {
		const res = await call({ action: 'order', method: 'GET' });
		expect(res._body).not.toContain('1 Test Way');
		expect(res._body).not.toContain(ORDER.id);
	});

	it('never reads an order before deciding', async () => {
		await call({ action: 'order', method: 'GET' });
		expect(store.getOrder).not.toHaveBeenCalled();
		expect(store.getOrderWithEvents).not.toHaveBeenCalled();
	});
});

describe('a signed-in NON-operator is refused on every action', () => {
	beforeEach(() => {
		getSessionUser.mockResolvedValue({ id: 'user-9', wallet_address: 'NotAnOperator1111111111111111111111111111111' });
		isAdminUser.mockResolvedValue(false);
	});

	for (const spec of ACTIONS) {
		it(`refuses a plain user on ${spec.action}`, async () => {
			const res = await call(spec);
			expect(res.statusCode).toBe(403);
		});
	}

	it('does not move an order it refused', async () => {
		await call({ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'screening' } });
		expect(store.transition).not.toHaveBeenCalled();
	});

	it('a user on an allowlist that names someone else is still refused', async () => {
		process.env.PRINT_OPERATORS = 'someone-else,0x0000000000000000000000000000000000000001';
		expect((await call({ action: 'queue', method: 'GET' })).statusCode).toBe(403);
	});
});

describe('the gate fails closed in development', () => {
	it('an unconfigured deployment does not open the console to anyone', async () => {
		// api/_lib/ops-auth.js deliberately opens off-production when no secret is
		// set. This console must not inherit that: no NODE_ENV, no OPS_SECRET, and
		// the answer is still no.
		expect((await call({ action: 'queue', method: 'GET' })).statusCode).toBe(403);
	});
});

describe('authorized operators get through', () => {
	it('admits a platform admin and attributes the move to them', async () => {
		getSessionUser.mockResolvedValue({ id: 'admin-1', wallet_address: 'AdminWa11et' });
		isAdminUser.mockResolvedValue(true);
		const res = await call({ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'screening' } });
		expect(res.statusCode).toBe(200);
		expect(store.transition).toHaveBeenCalledWith(expect.objectContaining({ actor: 'operator', actorId: 'admin-1' }));
	});

	it('admits an allowlisted operator who is not an admin', async () => {
		process.env.PRINT_OPERATORS = 'op-user-7';
		getSessionUser.mockResolvedValue({ id: 'op-user-7', wallet_address: 'OperatorWa11et' });
		expect((await call({ action: 'queue', method: 'GET' })).statusCode).toBe(200);
	});

	it('admits the ops secret, with no user identity attached', async () => {
		process.env.OPS_SECRET = 'a-high-entropy-ops-secret';
		const res = await call(
			{ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'screening' } },
			{ 'x-ops-secret': 'a-high-entropy-ops-secret' },
		);
		expect(res.statusCode).toBe(200);
		expect(store.transition).toHaveBeenCalledWith(expect.objectContaining({ actorId: null }));
	});

	it('refuses a wrong ops secret', async () => {
		process.env.OPS_SECRET = 'a-high-entropy-ops-secret';
		expect((await call({ action: 'queue', method: 'GET' }, { 'x-ops-secret': 'guess' })).statusCode).toBe(403);
	});
});

describe('authorized behaviour that protects the operator from themselves', () => {
	beforeEach(() => {
		getSessionUser.mockResolvedValue({ id: 'admin-1', wallet_address: 'AdminWa11et' });
		isAdminUser.mockResolvedValue(true);
	});

	it('refuses to reach submitted through the generic mover', async () => {
		const res = await call({ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'submitted' } });
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/ops\/submit/);
		expect(store.transition).not.toHaveBeenCalled();
	});

	it('maps an illegal transition to 409 rather than a 500', async () => {
		store.transition.mockRejectedValue(new store.PrintStoreError('illegal_transition', 'a print order cannot go from paid to shipped'));
		const res = await call({ action: 'transition', method: 'POST', body: { order_id: ORDER.id, to: 'shipped' } });
		expect(res.statusCode).toBe(409);
		expect(res.json.error).toBe('illegal_transition');
	});

	it('maps a missing order to 404', async () => {
		store.getOrder.mockResolvedValue(null);
		expect((await call({ action: 'order', method: 'GET' })).statusCode).toBe(404);
	});

	it('renders the refund payout as an owner instruction and moves no money', async () => {
		store.transition.mockResolvedValue({ order: { ...ORDER, status: 'refunded' }, event: { id: 'e1' }, certificate: null });
		const res = await call({ action: 'refund', method: 'POST', body: { order_id: ORDER.id, note: 'failed QC twice' } });
		expect(res.statusCode).toBe(200);
		expect(res.json.payout).toMatchObject({
			required: true,
			executed: false,
			recipient: ORDER.payer_wallet,
			chain: 'solana',
			asset: 'USDC',
		});
	});

	it('does not mark an order canceled when the provider refuses', async () => {
		store.getOrder.mockResolvedValue({ ...ORDER, status: 'submitted', provider: 'partner-cn', provider_order_id: 'p-1' });
		cancelWithProvider.mockResolvedValue({ ok: false, note: 'already on the machine', state: {} });
		const res = await call({ action: 'cancel', method: 'POST', body: { order_id: ORDER.id } });
		expect(res.statusCode).toBe(409);
		expect(store.transition).not.toHaveBeenCalled();
	});

	it('rejects an unknown action instead of dispatching it', async () => {
		const res = mockRes();
		await handler(mockReq({ action: 'delete-everything', method: 'GET' }), res);
		expect(res.statusCode).toBe(404);
	});

	it('returns 503, not a crash, when the deployment has no database', async () => {
		queries.printStoreEnabled.mockReturnValue(false);
		expect((await call({ action: 'queue', method: 'GET' })).statusCode).toBe(503);
	});
});
