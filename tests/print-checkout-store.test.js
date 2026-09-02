/**
 * Materialize checkout, at the store layer: opening an order and the address
 * we are willing to hold while doing it.
 *
 * Two things are load-bearing here and both are about trust rather than
 * mechanics. First, every priced field on the row comes out of the VERIFIED
 * quote token, never out of the request, so a caller who edits a total in
 * flight cannot make the database believe it. Second, a shipping address is the
 * first real personal data this platform stores, so the normalizer accepts the
 * minimum and drops everything else: a field that is never accepted is a field
 * that can never leak.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { sql: null };

vi.mock('../api/_lib/db.js', () => ({
	get sql() {
		return db.sql;
	},
}));
vi.mock('../api/_lib/print/certificate.js', () => ({
	issueCertificateForOrder: async () => ({ certificate: null }),
}));
vi.mock('../api/_lib/print/editions.js', () => ({
	assertEditionAvailable: async () => true,
}));
vi.mock('../api/_lib/feed.js', () => ({
	publishUserEvent: () => {},
}));

const { createOrder, normalizeShipping, PrintStoreError } = await import('../api/_lib/print-store.js');

const USER = '00000000-0000-4000-8000-0000000000aa';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const GOOD_ADDRESS = {
	name: 'Ada Lovelace',
	line1: '12 Analytical Way',
	city: 'London',
	postal_code: 'EC1A 1AA',
	country: 'gb',
};

const QUOTE = {
	materialId: 'resin-standard',
	finishId: 'as-printed',
	targetHeightMm: 140,
	quantity: 1,
	country: 'GB',
	total: 48.2,
	volumeCm3: 38.4,
	leadTimeDays: 14,
	reportHash: 'abc123',
	sourceUrl: 'https://cdn.example.test/model.glb',
	creationId: null,
	expiresAt: Date.parse('2026-09-03T12:00:00Z'),
};

/** Captures the INSERT so a test can assert what actually reached the table. */
function makeSql() {
	const inserted = { order: null, events: [] };
	const sql = async (strings, ...values) => {
		const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
		if (text.startsWith('insert into print_orders')) {
			inserted.order = {
				user_id: values[0],
				payer_wallet: values[1],
				creation_id: values[2],
				source_glb_url: values[3],
				analysis: values[4],
				material_id: values[5],
				target_height_mm: values[6],
				quantity: values[7],
				quote: values[8],
				price_usdc: values[9],
				shipping: values[10],
				payment_reference: values[11],
				payment_chain: values[12],
				quote_expires_at: values[13],
			};
			return [{ id: 'order-1', status: 'created', ...inserted.order }];
		}
		if (text.startsWith('insert into print_order_events')) {
			inserted.events.push({ order_id: values[0], status: values[1], note: values[2], actor: values[3] });
			return [{ id: 'event-1', status: values[1] }];
		}
		throw new Error(`unexpected query: ${text}`);
	};
	return { sql, inserted };
}

beforeEach(() => {
	const made = makeSql();
	db.sql = made.sql;
	db.inserted = made.inserted;
});

describe('normalizeShipping', () => {
	it('keeps the minimum fields and normalizes the country', () => {
		const out = normalizeShipping({ ...GOOD_ADDRESS, phone: '+44 20 7946 0000' });
		expect(out).toEqual({
			name: 'Ada Lovelace',
			line1: '12 Analytical Way',
			line2: null,
			city: 'London',
			region: null,
			postal_code: 'EC1A 1AA',
			country: 'GB',
			phone: '+44 20 7946 0000',
		});
	});

	it('drops every field it was not asked to hold', () => {
		const out = normalizeShipping({
			...GOOD_ADDRESS,
			email: 'ada@example.test',
			date_of_birth: '1815-12-10',
			tax_id: 'GB123456789',
			notes: 'leave with the neighbour',
		});
		for (const leaked of ['email', 'date_of_birth', 'tax_id', 'notes']) {
			expect(Object.hasOwn(out, leaked), `${leaked} must never be stored`).toBe(false);
		}
	});

	it('names the field that is missing rather than failing generically', () => {
		for (const field of ['name', 'line1', 'city', 'postal_code', 'country']) {
			const partial = { ...GOOD_ADDRESS };
			delete partial[field];
			let thrown = null;
			try {
				normalizeShipping(partial);
			} catch (err) {
				thrown = err;
			}
			expect(thrown, `${field} must be required`).toBeInstanceOf(PrintStoreError);
			expect(thrown.code).toBe('shipping_incomplete');
			expect(thrown.field).toBe(field);
		}
	});

	it('refuses a country that is not an ISO alpha-2 code', () => {
		// "United Kingdom" would have shipped at the rest-of-world rate while the
		// quote was priced for Europe, and we would have eaten the difference.
		expect(() => normalizeShipping({ ...GOOD_ADDRESS, country: 'United Kingdom' })).toThrow(PrintStoreError);
	});

	it('truncates rather than rejecting an over-long line', () => {
		const out = normalizeShipping({ ...GOOD_ADDRESS, line1: 'x'.repeat(500) });
		expect(out.line1).toHaveLength(120);
	});

	it('refuses a missing address outright', () => {
		expect(() => normalizeShipping(null)).toThrow(PrintStoreError);
	});
});

describe('createOrder', () => {
	it('writes every priced field from the quote token, not from the caller', async () => {
		const shipping = normalizeShipping(GOOD_ADDRESS);
		await createOrder({
			userId: USER,
			quote: QUOTE,
			itemization: { total: QUOTE.total, token: 'pq1.x.y' },
			report: { report_hash: QUOTE.reportHash },
			sourceGlbUrl: QUOTE.sourceUrl,
			shipping,
			paymentReference: 'ref-1',
			paymentChain: 'solana',
		});
		const row = db.inserted.order;
		expect(row.material_id).toBe('resin-standard');
		expect(row.target_height_mm).toBe(140);
		expect(row.quantity).toBe(1);
		expect(row.price_usdc).toBe(48.2);
		expect(row.user_id).toBe(USER);
		expect(row.payer_wallet).toBeNull();
		expect(JSON.parse(row.shipping).country).toBe('GB');
		expect(row.quote_expires_at).toBe('2026-09-03T12:00:00.000Z');
	});

	it('opens the timeline with a created event naming what was ordered', async () => {
		await createOrder({
			userId: USER,
			quote: QUOTE,
			itemization: {},
			report: {},
			sourceGlbUrl: QUOTE.sourceUrl,
			shipping: normalizeShipping(GOOD_ADDRESS),
		});
		expect(db.inserted.events).toHaveLength(1);
		expect(db.inserted.events[0].status).toBe('created');
		expect(db.inserted.events[0].note).toContain('resin-standard');
		expect(db.inserted.events[0].actor).toBe('buyer');
	});

	it('records an agent order against its payer wallet and no user', async () => {
		await createOrder({
			payerWallet: WALLET,
			quote: QUOTE,
			itemization: {},
			report: {},
			sourceGlbUrl: QUOTE.sourceUrl,
			shipping: normalizeShipping(GOOD_ADDRESS),
		});
		expect(db.inserted.order.user_id).toBeNull();
		expect(db.inserted.order.payer_wallet).toBe(WALLET);
		// No signed-in human to attribute it to, so the timeline says system.
		expect(db.inserted.events[0].actor).toBe('system');
	});

	it('refuses an order that belongs to nobody', async () => {
		await expect(
			createOrder({
				quote: QUOTE,
				itemization: {},
				report: {},
				sourceGlbUrl: QUOTE.sourceUrl,
				shipping: normalizeShipping(GOOD_ADDRESS),
			}),
		).rejects.toThrow(PrintStoreError);
		expect(db.inserted.order).toBeNull();
	});

	it('refuses to open an order with no verified quote behind it', async () => {
		for (const quote of [null, {}, { materialId: 'resin-standard', total: 0 }]) {
			await expect(
				createOrder({
					userId: USER,
					quote,
					itemization: {},
					report: {},
					sourceGlbUrl: QUOTE.sourceUrl,
					shipping: normalizeShipping(GOOD_ADDRESS),
				}),
			).rejects.toThrow(PrintStoreError);
		}
		expect(db.inserted.order).toBeNull();
	});

	it('refuses an order with no model to print', async () => {
		await expect(
			createOrder({
				userId: USER,
				quote: QUOTE,
				itemization: {},
				report: {},
				sourceGlbUrl: '',
				shipping: normalizeShipping(GOOD_ADDRESS),
			}),
		).rejects.toThrow(PrintStoreError);
	});
});
