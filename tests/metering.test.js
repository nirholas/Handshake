// Money-math tests for the usage metering ledger (api/_lib/metering.js).
//
// The DB is mocked: a tagged-template `sql` that returns whatever the test
// queues. The catalog + fee modules are REAL (pure), so a silent price or
// fee-bps change fails these. The AWS SDK is mocked at the client boundary so we
// assert the MeterUsage call SHAPE without ever talking to AWS.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

import { recordUsage, rollupInvoice, getReceipt, atomicsToUsd } from '../api/_lib/metering.js';
import { sql } from '../api/_lib/db.js';

beforeEach(() => {
	queue.length = 0;
	sql.mockClear();
});

describe('recordUsage — idempotency (no double-spend)', () => {
	it('meters once for a settlement, and a retried settlement meters zero times', async () => {
		// First insert wins (RETURNING id); the retry hits ON CONFLICT DO NOTHING → [].
		queue.push([{ id: 42 }]);
		const first = await recordUsage({
			userId: 'u1',
			action: 'forge.high',
			priceUsdcAtomics: 500_000,
			settlementRef: 'pay-abc',
		});
		expect(first).toEqual({ id: 42, metered: true, duplicate: false });

		queue.push([]); // conflict on the same idempotency key
		const second = await recordUsage({
			userId: 'u1',
			action: 'forge.high',
			priceUsdcAtomics: 500_000,
			settlementRef: 'pay-abc',
		});
		expect(second).toEqual({ id: null, metered: false, duplicate: true });
	});

	it('keys idempotency on the settlement ref by default', async () => {
		queue.push([{ id: 1 }]);
		await recordUsage({ userId: 'u1', action: 'forge.high', priceUsdcAtomics: 500_000, settlementRef: 'pay-xyz', settlementKind: 'three' });
		// The bound params include the derived `three:pay-xyz` key.
		const params = sql.mock.calls[0].slice(1).map(String);
		expect(params).toContain('three:pay-xyz');
	});

	it('throws without a settlement ref — never meters an unlinked charge', async () => {
		await expect(
			recordUsage({ userId: 'u1', action: 'forge.high', priceUsdcAtomics: 1 }),
		).rejects.toThrow(/settlementRef/);
	});
});

describe('recordUsage — platform-fee derivation by policy', () => {
	it('consumption action: platform keeps the whole price (fee == price)', async () => {
		queue.push([{ id: 1 }]);
		await recordUsage({ userId: 'u1', action: 'forge.high', priceUsdcAtomics: 500_000, settlementRef: 'r1' });
		const params = sql.mock.calls[0].slice(1).map(String);
		// price and fee are both 500000 atomics.
		expect(params.filter((p) => p === '500000').length).toBeGreaterThanOrEqual(2);
	});

	it('marketplace action: platform takes the fee-bps slice, seller gets the rest', async () => {
		queue.push([{ id: 1 }]);
		// skill.call is a POLICY.MARKETPLACE action; price it per-call at $1.00.
		await recordUsage({ userId: 'u1', action: 'skill.call', priceUsdcAtomics: 1_000_000, settlementRef: 'r2', settlementKind: 'three' });
		const params = sql.mock.calls[0].slice(1).map(String);
		// Default platform fee is 250 bps → fee = 25000 atomics ($0.025) of $1.00.
		expect(params).toContain('1000000'); // gross
		expect(params).toContain('25000'); // platform fee
	});
});

describe('rollupInvoice — statement math', () => {
	it('line items sum exactly to the statement total', async () => {
		queue.push([
			{ action: 'forge.high', count: 3, units: 3, gross_atomics: '1500000', fee_atomics: '1500000', discount_bps: 0 },
			{ action: 'voice.clone', count: 1, units: 1, gross_atomics: '500000', fee_atomics: '500000', discount_bps: 1000 },
		]);
		const inv = await rollupInvoice({ userId: 'u1', from: new Date('2026-06-01'), to: new Date('2026-07-01') });

		const sumGross = inv.line_items.reduce((s, l) => s + BigInt(l.gross_atomics), 0n);
		const sumFee = inv.line_items.reduce((s, l) => s + BigInt(l.fee_atomics), 0n);
		expect(sumGross.toString()).toBe(inv.totals.gross_atomics);
		expect(sumFee.toString()).toBe(inv.totals.fee_atomics);
		expect(inv.totals.gross_usd).toBe('2.00');
		expect(inv.totals.charge_count).toBe(4);
		// net = gross - fee, per line.
		expect(inv.line_items[0].net_atomics).toBe('0');
	});

	it('empty period rolls up to a zero statement', async () => {
		queue.push([]);
		const inv = await rollupInvoice({ userId: 'u1', from: new Date('2026-06-01'), to: new Date('2026-07-01') });
		expect(inv.line_items).toEqual([]);
		expect(inv.totals.gross_atomics).toBe('0');
		expect(inv.totals.gross_usd).toBe('0.00');
	});
});

describe('getReceipt — per-charge receipt traces to settlement', () => {
	it('joins the metered row to its on-chain tx and links an explorer URL', async () => {
		queue.push([
			{
				id: 7,
				meter_action: 'forge.high',
				units: 1,
				price_usdc_atomics: '450000',
				fee_usdc_atomics: '450000',
				discount_bps: 1000,
				settlement_ref: 'pay-1',
				settlement_kind: 'three',
				created_at: new Date('2026-06-10T00:00:00Z'),
				tx_signature: 'SIG123',
				network: 'mainnet',
				mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				settled_atomics: '900',
				token_price_usd: 0.5,
			},
		]);
		const r = await getReceipt({ userId: 'u1', eventId: 7 });
		expect(r.action).toBe('forge.high');
		expect(r.gross_usd).toBe('0.45');
		expect(r.net_atomics).toBe('0');
		expect(r.discount_percent).toBe('10.0');
		expect(r.settlement.tx_signature).toBe('SIG123');
		expect(r.settlement.explorer_url).toBe('https://solscan.io/tx/SIG123');
	});

	it('returns null for a charge the user does not own', async () => {
		queue.push([]); // ownership-scoped query returns nothing
		const r = await getReceipt({ userId: 'u1', eventId: 999 });
		expect(r).toBeNull();
	});
});

describe('atomicsToUsd', () => {
	it('converts 6-decimal atomics to a USD string', () => {
		expect(atomicsToUsd(150000)).toBe('0.15');
		expect(atomicsToUsd('1000000')).toBe('1.00');
		expect(atomicsToUsd(0)).toBe('0.00');
	});
});

describe('AWS Marketplace metering call shape (SDK boundary mocked)', () => {
	// AWS stopped populating CustomerIdentifier for new SaaS integrations and
	// requires LicenseArn + CustomerAWSAccountId instead. The metering helper has
	// to pick the right command for whichever identity the buyer's row holds:
	// BatchMeterUsage for a licensed buyer, the legacy MeterUsage only when a
	// pre-existing row has nothing but a customer identifier.
	async function loadMetering(response) {
		vi.resetModules();
		const sent = [];
		vi.doMock('@aws-sdk/client-marketplace-metering', () => ({
			MarketplaceMeteringClient: class {
				async send(cmd) {
					sent.push(cmd);
					return response;
				}
			},
			ResolveCustomerCommand: class {},
			MeterUsageCommand: class {
				constructor(input) {
					this.input = input;
					this.commandName = 'MeterUsage';
				}
			},
			BatchMeterUsageCommand: class {
				constructor(input) {
					this.input = input;
					this.commandName = 'BatchMeterUsage';
				}
			},
		}));
		vi.doMock('@aws-sdk/client-marketplace-entitlement-service', () => ({
			MarketplaceEntitlementServiceClient: class {},
			GetEntitlementsCommand: class {},
		}));
		vi.doMock('../api/_lib/env.js', () => ({
			env: { AWS_MP_PRODUCT_CODE: 'prod123', AWS_MP_REGION: 'us-east-1', AWS_MP_ACCESS_KEY_ID: 'k', AWS_MP_SECRET_ACCESS_KEY: 's' },
		}));
		const { meterUsage } = await import('../api/_lib/aws-marketplace.js');
		return { meterUsage, sent };
	}

	function unmock() {
		vi.doUnmock('@aws-sdk/client-marketplace-metering');
		vi.doUnmock('@aws-sdk/client-marketplace-entitlement-service');
		vi.doUnmock('../api/_lib/env.js');
	}

	it('meters a licensed buyer through BatchMeterUsage with the license ARN', async () => {
		const { meterUsage, sent } = await loadMetering({
			Results: [{ Status: 'Success', MeteringRecordId: 'rec-1' }],
		});
		const recordId = await meterUsage({
			licenseArn: 'arn:aws:license-manager:us-east-1:155407237916:l-synthetic',
			customerAWSAccountId: '111122223333',
			dimension: 'api_call',
			quantity: 1,
		});
		expect(recordId).toBe('rec-1');
		expect(sent).toHaveLength(1);
		expect(sent[0].commandName).toBe('BatchMeterUsage');
		const record = sent[0].input.UsageRecords[0];
		expect(sent[0].input.ProductCode).toBe('prod123');
		expect(record.LicenseArn).toBe('arn:aws:license-manager:us-east-1:155407237916:l-synthetic');
		expect(record.CustomerAWSAccountId).toBe('111122223333');
		expect(record.Dimension).toBe('api_call');
		expect(record.Quantity).toBe(1);
		expect(record.CustomerIdentifier).toBeUndefined();
		unmock();
	});

	it('surfaces a rejected usage record instead of reporting it as metered', async () => {
		const { meterUsage } = await loadMetering({
			Results: [{ Status: 'CustomerNotSubscribed' }],
		});
		await expect(
			meterUsage({
				licenseArn: 'arn:aws:license-manager:us-east-1:155407237916:l-synthetic',
				dimension: 'api_call',
				quantity: 1,
			}),
		).rejects.toThrow(/CustomerNotSubscribed/);
		unmock();
	});

	it('falls back to the legacy MeterUsage command for a customer-identifier-only row', async () => {
		const { meterUsage, sent } = await loadMetering({ MeteringRecordId: 'rec-legacy' });
		const recordId = await meterUsage({
			customerIdentifier: 'cust-1',
			dimension: 'api_call',
			quantity: 1,
		});
		expect(recordId).toBe('rec-legacy');
		expect(sent[0].commandName).toBe('MeterUsage');
		expect(sent[0].input.CustomerIdentifier).toBe('cust-1');
		expect(sent[0].input.UsageDimension).toBe('api_call');
		unmock();
	});

	it('refuses to meter a buyer it cannot identify at all', async () => {
		const { meterUsage } = await loadMetering({});
		await expect(meterUsage({ dimension: 'api_call', quantity: 1 })).rejects.toThrow(/LicenseArn/);
		unmock();
	});
});
