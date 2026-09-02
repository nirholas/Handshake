// The fulfillment adapter conformance suite.
//
// Every adapter that can move a print order runs through the same checks here,
// because the entire value of the adapter layer is that a contracted partner's
// API becomes a config change rather than a rebuild. That only holds if every
// lane is held to one shape.
//
// `partner-cn` is deliberately uncontracted (materialize-00-CONTEXT): the paths
// exercised below are the ones that run WITHOUT partner credentials plus the
// two that need only the HMAC secret, which the test supplies itself.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import manual from '../api/_lib/print/adapters/manual.js';
import partnerCn, { PARTNER_STATE_MAP, mapState } from '../api/_lib/print/adapters/partner-cn.js';
import {
	ADAPTER_DRIVABLE_STATUSES,
	AdapterContractError,
	adapterSupportsOrder,
	assertAdapterShape,
	assertCapabilities,
	derivedDeliveryId,
	mapProviderStatus,
	normalizeStatusResult,
	normalizeSubmitResult,
	normalizeWebhookEvent,
} from '../api/_lib/print/adapters/contract.js';
import { PRINT_STATUSES } from '../api/_lib/print-store.js';

const ADAPTERS = [manual, partnerCn];

describe('conformance: every adapter satisfies the contract', () => {
	for (const adapter of ADAPTERS) {
		describe(adapter.key, () => {
			it('declares a valid shape', () => {
				expect(() => assertAdapterShape(adapter)).not.toThrow();
			});

			it('declares capabilities the router can compare against', () => {
				expect(() => assertCapabilities(adapter.key, adapter.capabilities)).not.toThrow();
				expect(adapter.capabilities.leadTimeDays).toBeGreaterThan(0);
			});

			it('answers configured() without throwing', () => {
				expect(typeof adapter.configured()).toBe('boolean');
			});

			it('refuses a webhook it cannot authenticate', () => {
				const verdict = adapter.verifyWebhook('{}', {});
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toBeTruthy();
			});
		});
	}
});

describe('assertAdapterShape rejects a half-built adapter', () => {
	const base = { key: 'test-lane', label: 'Test', capabilities: manual.capabilities, ...methodStubs() };

	function methodStubs() {
		return {
			configured: () => true,
			submit: async () => ({}),
			status: async () => ({}),
			cancel: async () => ({}),
			verifyWebhook: () => ({ ok: false }),
			parseWebhook: () => ({}),
		};
	}

	it('rejects a missing method', () => {
		const broken = { ...base };
		delete broken.status;
		expect(() => assertAdapterShape(broken)).toThrow(AdapterContractError);
	});

	it('rejects a key that is not lower-kebab', () => {
		expect(() => assertAdapterShape({ ...base, key: 'Partner CN' })).toThrow(/lower-kebab/);
	});

	it('rejects capabilities without a build volume', () => {
		expect(() => assertAdapterShape({ ...base, capabilities: { materials: '*', shipsFrom: 'US', leadTimeDays: 5 } })).toThrow(/maxBboxMm/);
	});

	it('rejects a lead time nobody could honour', () => {
		expect(() => assertCapabilities('x', { ...manual.capabilities, leadTimeDays: 0 })).toThrow(/leadTimeDays/);
		expect(() => assertCapabilities('x', { ...manual.capabilities, leadTimeDays: 900 })).toThrow(/leadTimeDays/);
	});

	it('rejects a shipsFrom that is not a country code', () => {
		expect(() => assertCapabilities('x', { ...manual.capabilities, shipsFrom: 'China' })).toThrow(/alpha-2/);
	});
});

describe('capability routing is a comparison against published facts', () => {
	it('the manual lane runs any material', () => {
		expect(adapterSupportsOrder(manual, { material_id: 'anything-at-all' }).ok).toBe(true);
	});

	it('a partner declines a material it does not run', () => {
		const verdict = adapterSupportsOrder(partnerCn, { material_id: 'pla-draft' });
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/not offered/);
	});

	it('a part larger than the build volume is declined, not attempted', () => {
		const verdict = adapterSupportsOrder(manual, {
			material_id: 'resin-standard',
			analysis: { bbox_mm: { x: 50, y: 50, z: 900 } },
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/build volume/);
	});

	it('an order with no analysis is not blocked on a bbox nobody measured', () => {
		expect(adapterSupportsOrder(manual, { material_id: 'resin-standard' }).ok).toBe(true);
	});
});

describe('the drivable status set cannot reach behind the payment gate', () => {
	it('is a subset of the store vocabulary', () => {
		for (const s of ADAPTER_DRIVABLE_STATUSES) expect(PRINT_STATUSES).toContain(s);
	});

	it('excludes everything before submission and the refund decision', () => {
		for (const s of ['created', 'quoted', 'paid', 'screening', 'refunded']) {
			expect(ADAPTER_DRIVABLE_STATUSES).not.toContain(s);
		}
	});
});

describe('result normalization refuses junk at the adapter boundary', () => {
	it('requires a provider order id from submit()', () => {
		expect(() => normalizeSubmitResult('x', { status: 'submitted' })).toThrow(/providerOrderId/);
	});

	it('refuses a submit status the provider may not drive', () => {
		expect(() => normalizeSubmitResult('x', { providerOrderId: 'a', status: 'refunded' })).toThrow(/must be one of/);
	});

	it('treats a null status from status() as no news, not an error', () => {
		const out = normalizeStatusResult('x', { status: null, trackingNumber: '  1Z999  ' });
		expect(out.status).toBeNull();
		expect(out.trackingNumber).toBe('1Z999');
	});

	it('requires a webhook event to identify the order', () => {
		expect(() => normalizeWebhookEvent('x', { status: 'shipped' })).toThrow(/identify the order/);
	});

	it('drops a provider state blob too large for the column', () => {
		const huge = { blob: 'x'.repeat(20_000) };
		const out = normalizeStatusResult('x', { status: 'printing', state: huge });
		expect(out.state.truncated).toBe(true);
	});

	it('survives a circular provider payload instead of throwing', () => {
		const circular = { a: 1 };
		circular.self = circular;
		expect(normalizeStatusResult('x', { status: 'printing', state: circular }).state).toEqual({});
	});
});

describe('provider status mapping never guesses', () => {
	it('maps a documented state', () => {
		expect(mapState('in_production')).toBe('printing');
		expect(mapState('SHIPPED')).toBe('shipped');
	});

	it('maps an unknown state to null rather than inventing a transition', () => {
		expect(mapState('doing_something_new')).toBeNull();
		expect(mapState(undefined)).toBeNull();
		expect(mapState(42)).toBeNull();
	});

	it('every declared mapping targets a real store status', () => {
		for (const target of Object.values(PARTNER_STATE_MAP)) expect(PRINT_STATUSES).toContain(target);
	});

	it('refuses a mapping table entry that is not a status', () => {
		expect(mapProviderStatus({ weird: 'not_a_status' }, 'weird')).toBeNull();
	});
});

describe('derived delivery ids make an unlabelled retry idempotent', () => {
	it('is stable for the same payload and distinct across providers', () => {
		const body = '{"id":"abc","state":"shipped"}';
		expect(derivedDeliveryId('partner-cn', body)).toBe(derivedDeliveryId('partner-cn', body));
		expect(derivedDeliveryId('partner-cn', body)).not.toBe(derivedDeliveryId('other', body));
	});

	it('changes when a single byte of the payload changes', () => {
		expect(derivedDeliveryId('p', '{"a":1}')).not.toBe(derivedDeliveryId('p', '{"a":2}'));
	});
});

describe('manual lane: the launch path, with no webhook door', () => {
	it('is always configured, because it needs a person and not a credential', () => {
		expect(manual.configured()).toBe(true);
	});

	it('refuses every webhook delivery, signed or not', () => {
		expect(manual.verifyWebhook('{"id":"x"}', { 'x-print-signature': 'anything' }).ok).toBe(false);
	});

	it('parseWebhook is unreachable and says so rather than returning a fake event', () => {
		expect(() => manual.parseWebhook({})).toThrow(/receives no webhooks/);
	});
});

describe('partner-cn without credentials', () => {
	const saved = { url: process.env.PRINT_PARTNER_CN_URL, key: process.env.PRINT_PARTNER_CN_KEY };

	beforeEach(() => {
		delete process.env.PRINT_PARTNER_CN_URL;
		delete process.env.PRINT_PARTNER_CN_KEY;
	});

	afterEach(() => {
		if (saved.url) process.env.PRINT_PARTNER_CN_URL = saved.url;
		else delete process.env.PRINT_PARTNER_CN_URL;
		if (saved.key) process.env.PRINT_PARTNER_CN_KEY = saved.key;
		else delete process.env.PRINT_PARTNER_CN_KEY;
	});

	it('is not configured', () => {
		expect(partnerCn.configured()).toBe(false);
	});

	it('refuses a webhook rather than accepting an unverifiable one', () => {
		const verdict = partnerCn.verifyWebhook('{}', { 'x-print-signature': 'sha256=deadbeef' });
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/not configured/);
	});

	it('refuses to submit rather than calling an unconfigured base URL', async () => {
		await expect(partnerCn.submit({ id: 'o1' }, {})).rejects.toThrow(/not configured/);
	});

	it('still parses a payload into store vocabulary, which is credential-free', () => {
		const event = partnerCn.parseWebhook({ id: 'p-1', state: 'shipped', tracking_number: '1Z', carrier: 'UPS' });
		expect(event).toMatchObject({ providerOrderId: 'p-1', status: 'shipped', trackingNumber: '1Z', carrier: 'UPS' });
	});
});

describe('partner-cn webhook verification, with only the HMAC secret', () => {
	const SECRET = 'test-hmac-secret-not-a-real-credential';
	const BODY = '{"id":"p-42","state":"in_production"}';

	beforeEach(() => {
		process.env.PRINT_PARTNER_CN_URL = 'https://partner.invalid/api';
		process.env.PRINT_PARTNER_CN_KEY = SECRET;
	});

	afterEach(() => {
		delete process.env.PRINT_PARTNER_CN_URL;
		delete process.env.PRINT_PARTNER_CN_KEY;
	});

	const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

	it('accepts a correctly signed delivery and derives an id when none is supplied', () => {
		const verdict = partnerCn.verifyWebhook(BODY, { 'x-print-signature': `sha256=${sign(BODY)}` });
		expect(verdict.ok).toBe(true);
		expect(verdict.deliveryId).toBe(derivedDeliveryId('partner-cn', BODY));
	});

	it('prefers the provider delivery id when they send one', () => {
		const verdict = partnerCn.verifyWebhook(BODY, {
			'x-print-signature': sign(BODY),
			'x-print-delivery': 'dlv_991',
		});
		expect(verdict).toMatchObject({ ok: true, deliveryId: 'dlv_991' });
	});

	it('rejects a signature computed with the wrong secret', () => {
		const verdict = partnerCn.verifyWebhook(BODY, { 'x-print-signature': sign(BODY, 'wrong-secret') });
		expect(verdict).toMatchObject({ ok: false, reason: 'signature mismatch' });
	});

	it('rejects a body that was altered after signing', () => {
		const signature = sign(BODY);
		const tampered = BODY.replace('in_production', 'shipped');
		expect(partnerCn.verifyWebhook(tampered, { 'x-print-signature': signature }).ok).toBe(false);
	});

	it('rejects a truncated signature without throwing on the length mismatch', () => {
		expect(() => partnerCn.verifyWebhook(BODY, { 'x-print-signature': 'sha256=ab' })).not.toThrow();
		expect(partnerCn.verifyWebhook(BODY, { 'x-print-signature': 'sha256=ab' }).ok).toBe(false);
	});

	it('rejects a delivery with no signature at all', () => {
		expect(partnerCn.verifyWebhook(BODY, {}).reason).toMatch(/missing x-print-signature/);
	});

	it('registers in the adapter registry only once configured', async () => {
		vi.resetModules();
		const { listAdapters } = await import('../api/_lib/print/adapters/index.js');
		expect(listAdapters().map((a) => a.key)).toContain('partner-cn');
	});
});

describe('the registry hides a lane whose credentials are absent', () => {
	it('offers only the manual lane on a deployment with no partner', async () => {
		delete process.env.PRINT_PARTNER_CN_URL;
		delete process.env.PRINT_PARTNER_CN_KEY;
		vi.resetModules();
		const { listAdapters, getAdapter, routeOrder } = await import('../api/_lib/print/adapters/index.js');
		expect(listAdapters().map((a) => a.key)).toEqual(['manual']);
		expect(getAdapter('partner-cn')).toBeNull();
		expect(routeOrder({ material_id: 'resin-standard' }).adapter.key).toBe('manual');
	});
});
