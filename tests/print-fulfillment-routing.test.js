// Fulfillment orchestration: adapters speak, the store decides.
//
// The rule this file defends is that an adapter never writes the database. Its
// output is normalized, then turned into at most one transition() call, so a
// partner changing their payload shape can never corrupt an order's state
// machine. The three cases that matter are routing (which lane takes the job),
// refusal (a provider reporting something the machine will not allow), and
// no-news (a poll that should move nothing).

import { describe, it, expect, vi, beforeEach } from 'vitest';

class PrintStoreError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

const transition = vi.fn(async ({ orderId, to }) => ({ order: { ...ORDER, id: orderId, status: to }, event: { id: 'e1' }, certificate: null }));
const appendEvent = vi.fn(async () => ({ id: 'e1' }));
const getOrder = vi.fn(async () => ORDER);
vi.mock('../api/_lib/print-store.js', () => ({
	PrintStoreError,
	transition,
	appendEvent,
	getOrder,
	PRINT_STATUSES: ['created', 'quoted', 'paid', 'screening', 'submitted', 'printing', 'quality_check', 'shipped', 'delivered', 'rejected', 'canceled', 'refunded'],
	LEGAL_TRANSITIONS: {},
	ACTORS: ['system', 'operator', 'provider', 'buyer'],
	TERMINAL_STATUSES: ['delivered'],
	canTransition: () => true,
	getOrderWithEvents: vi.fn(),
}));

const patchProviderDetails = vi.fn(async (id, patch) => ({ ...ORDER, id, ...patch }));
vi.mock('../api/_lib/print/fulfillment-queries.js', () => ({
	patchProviderDetails,
	printStoreEnabled: () => true,
	ADAPTER_DRIVABLE_STATUSES: ['submitted', 'printing', 'quality_check', 'shipped', 'delivered', 'canceled', 'rejected'],
	OPEN_PROVIDER_STATUSES: ['submitted', 'printing', 'quality_check', 'shipped'],
}));

const notifyOperators = vi.fn(async () => {});
vi.mock('../api/_lib/print/ops-notify.js', () => ({
	notifyOperators,
	jobSummaryLines: () => ['line'],
	operatorChannelConfigured: () => true,
}));

const ORDER = {
	id: '00000000-0000-4000-8000-000000000003',
	status: 'screening',
	material_id: 'resin-standard',
	quantity: 1,
	prepared_asset_urls: { stl: 'https://example.invalid/a.stl', '3mf': 'https://example.invalid/a.3mf' },
	// The fabrication gate (api/_lib/print/gate.js) records its verdict on the
	// order. Nothing reaches a printer without a cleared one, so every fixture
	// that expects to be submitted carries it.
	analysis: { screening: { verdict: 'allow' } },
	shipping: { country: 'US' },
	price_usdc: '42.000000',
};

const { FulfillmentError, applyProviderEvent, cancelWithProvider, reconcileOrder, submitOrder } = await import(
	'../api/_lib/print/fulfillment.js'
);

beforeEach(() => {
	vi.clearAllMocks();
	transition.mockImplementation(async ({ orderId, to }) => ({ order: { ...ORDER, id: orderId, status: to }, event: { id: 'e1' }, certificate: null }));
	getOrder.mockResolvedValue(ORDER);
	patchProviderDetails.mockImplementation(async (id, patch) => ({ ...ORDER, id, ...patch }));
	delete process.env.PRINT_PARTNER_CN_URL;
	delete process.env.PRINT_PARTNER_CN_KEY;
});

describe('submitOrder routes by declared capability', () => {
	it('hands the job to the manual lane when no partner is configured', async () => {
		const result = await submitOrder({ order: ORDER, actor: 'operator', actorId: 'admin-1' });
		expect(result.adapter).toBe('manual');
		expect(result.providerOrderId).toBe(ORDER.id);
		expect(transition).toHaveBeenCalledWith(expect.objectContaining({
			to: 'submitted',
			actor: 'operator',
			actorId: 'admin-1',
			patch: expect.objectContaining({ provider: 'manual', provider_order_id: ORDER.id, lead_time_days: 10 }),
		}));
	});

	it('pages the operator channel with the job, not the address', async () => {
		await submitOrder({ order: ORDER });
		expect(notifyOperators).toHaveBeenCalledTimes(1);
		expect(notifyOperators.mock.calls[0][0].title).toMatch(/New print job/);
	});

	it('records the prepared formats so the operator knows what to send the bureau', async () => {
		await submitOrder({ order: ORDER });
		expect(patchProviderDetails).toHaveBeenCalledWith(
			ORDER.id,
			expect.objectContaining({ provider_state: expect.objectContaining({ formats: ['stl', '3mf'] }) }),
		);
	});

	it('refuses a lane this deployment has not configured rather than failing later', async () => {
		await expect(submitOrder({ order: ORDER, adapterKey: 'partner-cn' })).rejects.toThrow(FulfillmentError);
		await expect(submitOrder({ order: ORDER, adapterKey: 'partner-cn' })).rejects.toThrow(/no configured adapter/);
		expect(transition).not.toHaveBeenCalled();
	});

	it('refuses a lane that cannot physically run the part, and says why', async () => {
		const oversized = { ...ORDER, analysis: { ...ORDER.analysis, bbox_mm: { x: 10, y: 10, z: 5000 } } };
		await expect(submitOrder({ order: oversized, adapterKey: 'manual' })).rejects.toThrow(/build volume/);
	});

	it('refuses an order that has not cleared the fabrication gate', async () => {
		const unscreened = { ...ORDER, analysis: {} };
		await expect(submitOrder({ order: unscreened })).rejects.toThrow(/has not cleared the fabrication gate/);
		expect(transition).not.toHaveBeenCalled();
	});

	it('refuses an order held for fabrication review, where an operator cannot click past it', async () => {
		const held = { ...ORDER, analysis: { screening: { verdict: 'review' } } };
		await expect(submitOrder({ order: held })).rejects.toThrow(/held for fabrication review/);
		expect(transition).not.toHaveBeenCalled();
	});

	it('reports every declining lane when nothing can take the order', async () => {
		const oversized = { ...ORDER, analysis: { ...ORDER.analysis, bbox_mm: { x: 10, y: 10, z: 5000 } } };
		await expect(submitOrder({ order: oversized })).rejects.toThrow(/no fulfillment lane can run this order/);
	});
});

describe('applyProviderEvent turns a report into at most one move', () => {
	const live = { ...ORDER, status: 'printing', provider: 'partner-cn', provider_order_id: 'p-1' };

	it('applies a legal move and carries the tracking number with it', async () => {
		const result = await applyProviderEvent({
			order: live,
			event: { status: 'shipped', trackingNumber: '1Z999', carrier: 'UPS', note: 'left the floor', state: { s: 1 } },
		});
		expect(result.applied).toBe(true);
		expect(transition).toHaveBeenCalledWith(expect.objectContaining({
			to: 'shipped',
			actor: 'provider',
			patch: { tracking_number: '1Z999', carrier: 'UPS' },
		}));
	});

	it('records a refused move on the timeline instead of throwing at the provider', async () => {
		transition.mockRejectedValue(new PrintStoreError('illegal_transition', 'a print order cannot go from printing to quoted'));
		const result = await applyProviderEvent({ order: live, event: { status: 'delivered', note: '' } });
		expect(result.applied).toBe(false);
		expect(result.reason).toMatch(/cannot go from/);
		expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
			actor: 'provider',
			note: expect.stringMatching(/Refused provider report 'delivered'/),
		}));
	});

	it('treats no-news as news: it writes the payload and moves nothing', async () => {
		const result = await applyProviderEvent({ order: live, event: { status: null, note: 'still printing', state: { pct: 40 } } });
		expect(result.applied).toBe(false);
		expect(transition).not.toHaveBeenCalled();
		expect(patchProviderDetails).toHaveBeenCalledWith(live.id, expect.objectContaining({ provider_state: { pct: 40 } }));
		expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ note: 'still printing' }));
	});

	it('treats a report of the status we already hold as no move', async () => {
		const result = await applyProviderEvent({ order: live, event: { status: 'printing', trackingNumber: '', note: '' } });
		expect(result).toMatchObject({ applied: false, reason: 'already in that status' });
		expect(transition).not.toHaveBeenCalled();
	});

	it('lets a genuine bug escape rather than swallowing it as a refusal', async () => {
		transition.mockRejectedValue(new TypeError('cannot read properties of undefined'));
		await expect(applyProviderEvent({ order: live, event: { status: 'shipped' } })).rejects.toThrow(TypeError);
	});
});

describe('reconcileOrder and cancel degrade honestly on an unconfigured lane', () => {
	it('does not poll a lane this deployment cannot reach', async () => {
		const result = await reconcileOrder({ ...ORDER, provider: 'partner-cn', provider_order_id: 'p-1' });
		expect(result).toMatchObject({ polled: false, applied: false });
		expect(result.reason).toMatch(/not configured/);
	});

	it('the manual lane polls to no-news, because the console is already its truth', async () => {
		getOrder.mockResolvedValue({ ...ORDER, status: 'printing', tracking_number: '1Z' });
		const result = await reconcileOrder({ ...ORDER, status: 'printing', provider: 'manual', provider_order_id: ORDER.id });
		expect(result.polled).toBe(true);
		expect(result.applied).toBe(false);
		expect(transition).not.toHaveBeenCalled();
	});

	it('reports a cancel it could not send rather than claiming success', async () => {
		const result = await cancelWithProvider({ ...ORDER, provider: 'partner-cn' }, 'buyer changed their mind');
		expect(result.ok).toBe(false);
	});

	it('asks the manual lane to stop by paging the operator', async () => {
		const result = await cancelWithProvider({ ...ORDER, provider: 'manual' }, 'buyer changed their mind');
		expect(result.ok).toBe(true);
		expect(notifyOperators).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/cancellation/i) }));
	});
});
