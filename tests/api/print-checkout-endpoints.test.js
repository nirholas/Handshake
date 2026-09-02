/**
 * Materialize checkout over HTTP: the human lane (api/print/orders.js and its
 * detail route) and the agent lane (api/x402/print-order.js).
 *
 * What these pin, in the order a buyer meets them:
 *
 *   • nobody orders anonymously, and nobody orders without CSRF;
 *   • the price is the SIGNED price. A forged token, a token whose payload was
 *     edited by one byte, and an expired token all fail identically and none of
 *     them reaches the database;
 *   • the address a parcel goes to must be the country the shipping was priced
 *     for, or we quietly eat the difference on every order;
 *   • an order is only ever visible to the account that placed it;
 *   • on the agent lane, EVERY refusal happens before the 402 is issued, so a
 *     malformed order can never charge. That is the property the whole x402
 *     print rail rests on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

process.env.JWT_SECRET = 'print-checkout-test-secret-0123456789';
process.env.APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_FEE_PAYER_SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const USER = { id: '00000000-0000-4000-8000-0000000000aa' };
const OTHER_USER = { id: '00000000-0000-4000-8000-0000000000bb' };

let sessionUser = USER;
let csrfOk = true;
const store = { orders: new Map(), created: [], transitions: [] };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (_req, res) => {
		if (csrfOk) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf' }));
		return false;
	}),
}));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		printOrderIp: vi.fn(async () => ({ success: true })),
		authedReadIp: vi.fn(async () => ({ success: true })),
		// The shared paid-endpoint rail caps anonymous discovery probes before it
		// builds a challenge, so the x402 lane needs this bucket too.
		x402ProbeIp: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

// The store is exercised for real in tests/print-checkout-store.test.js; here it
// is a double so a handler test asserts HTTP behaviour rather than SQL.
vi.mock('../../api/_lib/print-store.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		createOrder: vi.fn(async (input) => {
			store.created.push(input);
			const row = {
				id: '11111111-2222-4333-8444-555555555555',
				status: 'created',
				user_id: input.userId ?? null,
				payer_wallet: input.payerWallet ?? null,
				material_id: input.quote.materialId,
				target_height_mm: input.quote.targetHeightMm,
				quantity: input.quote.quantity,
				price_usdc: input.quote.total,
				quote: input.itemization,
				shipping: input.shipping,
				payment_reference: input.paymentReference ?? null,
				payment_chain: input.paymentChain ?? null,
				quote_expires_at: new Date(input.quote.expiresAt).toISOString(),
				events: [],
			};
			store.orders.set(row.id, row);
			return row;
		}),
		transition: vi.fn(async ({ orderId, to }) => {
			store.transitions.push({ orderId, to });
			const row = store.orders.get(orderId);
			if (row) row.status = to;
			return { order: row, event: {}, certificate: null };
		}),
		getOrderWithEvents: vi.fn(async (id) => store.orders.get(id) ?? null),
		listOrdersForUser: vi.fn(async () => []),
	};
});

const { signQuote } = await import('../../api/_lib/print/quote.js');
const ordersHandler = (await import('../../api/print/orders.js')).default;
const orderDetailHandler = (await import('../../api/print/orders/[id].js')).default;
const printOrderX402 = (await import('../../api/x402/print-order.js')).default;
const { floorPriceAtomics } = await import('../../api/x402/print-order.js');

const SHIPPING = {
	name: 'Ada Lovelace',
	line1: '12 Analytical Way',
	city: 'London',
	postal_code: 'EC1A 1AA',
	country: 'GB',
};

/** A quotePrint-shaped result, the only input signQuote accepts. */
function quoteShape(overrides = {}) {
	return {
		material: { id: 'resin-standard', name: 'Standard resin', class: 'resin' },
		finish: { id: 'as-printed', name: 'As printed' },
		targetHeightMm: 140,
		quantity: 1,
		hollow: false,
		country: 'GB',
		total: 48.2,
		geometry: { volumeCm3: 38.4 },
		leadTimeDays: 14,
		...overrides,
	};
}

function tokenFor(overrides = {}, context = {}) {
	return signQuote(quoteShape(overrides), {
		reportHash: 'abc123',
		sourceUrl: 'https://cdn.example.test/model.glb',
		creationId: null,
		...context,
	});
}

async function postOrder(body, headers = {}) {
	const req = makeReq({ method: 'POST', url: '/api/print/orders', body, headers });
	const res = makeRes();
	await ordersHandler(req, res);
	return res;
}

function parse(res) {
	return res.body ? JSON.parse(res.body) : null;
}

beforeEach(() => {
	sessionUser = USER;
	csrfOk = true;
	store.orders.clear();
	store.created.length = 0;
	store.transitions.length = 0;
	vi.clearAllMocks();
});

describe('POST /api/print/orders', () => {
	it('refuses an anonymous order', async () => {
		sessionUser = null;
		const res = await postOrder({ token: tokenFor(), shipping: SHIPPING });
		expect(res.statusCode).toBe(401);
		expect(store.created).toHaveLength(0);
	});

	it('refuses an order without CSRF', async () => {
		csrfOk = false;
		const res = await postOrder({ token: tokenFor(), shipping: SHIPPING });
		expect(res.statusCode).toBe(403);
		expect(store.created).toHaveLength(0);
	});

	it('opens the order and quotes a Solana Pay intent for the signed total', async () => {
		const res = await postOrder({ token: tokenFor(), shipping: SHIPPING });
		expect(res.statusCode).toBe(201);
		const body = parse(res);
		expect(body.order.status).toBe('quoted');
		expect(body.order.price_usdc).toBe(48.2);
		expect(body.payment.chain).toBe('solana');
		expect(body.payment.recipient).toBe(process.env.X402_PAY_TO_SOLANA);
		expect(body.payment.mint).toBe(process.env.X402_ASSET_MINT_SOLANA);
		expect(body.payment.amount).toBe('48.20');
		// 6-decimal USDC, derived from the signed total and nothing else.
		expect(body.payment.amount_atomics).toBe('48200000');
		expect(body.payment.url).toContain(`solana:${process.env.X402_PAY_TO_SOLANA}`);
		expect(body.payment.url).toContain('spl-token=');
		expect(body.payment.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
		expect(store.transitions).toEqual([
			{ orderId: '11111111-2222-4333-8444-555555555555', to: 'quoted' },
		]);
	});

	it('takes the price from the token even when the body claims another one', async () => {
		await postOrder({ token: tokenFor(), shipping: SHIPPING, total: 1, price_usdc: 1, amount: 1 });
		expect(store.created[0].quote.total).toBe(48.2);
	});

	it('refuses a token whose payload was edited', async () => {
		const token = tokenFor();
		const [prefix, payload, signature] = token.split('.');
		const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		decoded.t = 1; // one dollar instead of forty-eight
		const forged = `${prefix}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
		const res = await postOrder({ token: forged, shipping: SHIPPING });
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('quote_invalid');
		expect(store.created).toHaveLength(0);
	});

	it('refuses an expired quote the same way it refuses a forged one', async () => {
		const token = signQuote(quoteShape(), {
			reportHash: 'abc123',
			sourceUrl: 'https://cdn.example.test/model.glb',
			ttlSeconds: -10,
		});
		const res = await postOrder({ token, shipping: SHIPPING });
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('quote_invalid');
		expect(store.created).toHaveLength(0);
	});

	it('refuses a token this server never signed', async () => {
		const res = await postOrder({ token: 'pq1.eyJ2IjoxfQ.bm90LWEtc2lnbmF0dXJl', shipping: SHIPPING });
		expect(res.statusCode).toBe(422);
		expect(store.created).toHaveLength(0);
	});

	it('refuses to ship somewhere the quote was not priced for', async () => {
		const res = await postOrder({ token: tokenFor(), shipping: { ...SHIPPING, country: 'AU' } });
		expect(res.statusCode).toBe(422);
		const body = parse(res);
		expect(body.error).toBe('destination_mismatch');
		expect(body.quoted_country).toBe('GB');
		expect(body.shipping_country).toBe('AU');
		expect(store.created).toHaveLength(0);
	});

	it('names the missing shipping field rather than failing generically', async () => {
		const partial = { ...SHIPPING };
		delete partial.postal_code;
		const res = await postOrder({ token: tokenFor(), shipping: partial });
		expect(res.statusCode).toBe(422);
		expect(parse(res).field).toBe('postal_code');
		expect(store.created).toHaveLength(0);
	});
});

describe('GET /api/print/orders/:id', () => {
	async function fetchOrder(id) {
		const req = makeReq({ method: 'GET', url: `/api/print/orders/${id}`, query: { id } });
		const res = makeRes();
		await orderDetailHandler(req, res);
		return res;
	}

	it('returns the order and its timeline to its owner', async () => {
		await postOrder({ token: tokenFor(), shipping: SHIPPING });
		const id = '11111111-2222-4333-8444-555555555555';
		store.orders.get(id).events = [{ status: 'created', note: 'opened', actor: 'buyer', created_at: '2026-09-02T00:00:00Z' }];
		const res = await fetchOrder(id);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.order.id).toBe(id);
		expect(body.events[0].status).toBe('created');
	});

	it('answers 404, not 403, for an order that belongs to someone else', async () => {
		await postOrder({ token: tokenFor(), shipping: SHIPPING });
		sessionUser = OTHER_USER;
		const res = await fetchOrder('11111111-2222-4333-8444-555555555555');
		// Confirming an id exists to a stranger is itself a leak.
		expect(res.statusCode).toBe(404);
	});

	it('never returns the full shipping address', async () => {
		await postOrder({ token: tokenFor(), shipping: SHIPPING });
		const res = await fetchOrder('11111111-2222-4333-8444-555555555555');
		const body = parse(res);
		expect(body.order.ship_to).toEqual({ name: 'Ada Lovelace', city: 'London', country: 'GB' });
		expect(res.body).not.toContain('12 Analytical Way');
		expect(res.body).not.toContain('EC1A 1AA');
	});
});

describe('POST /api/x402/print-order', () => {
	async function call(body, headers = {}) {
		const req = makeReq({ method: 'POST', url: '/api/x402/print-order', body, headers });
		const res = makeRes();
		await printOrderX402(req, res);
		return res;
	}

	it('answers a bodyless probe with a well-formed challenge at the catalog floor', async () => {
		const res = await call(null);
		expect(res.statusCode).toBe(402);
		const body = parse(res);
		expect(Array.isArray(body.accepts)).toBe(true);
		expect(body.accepts.length).toBeGreaterThan(0);
		expect(body.accepts[0].amount).toBe(floorPriceAtomics());
		expect(body.error).toContain('/api/print/quote');
	});

	it('quotes the order its own signed total, not a list price', async () => {
		const res = await call({ token: tokenFor(), shipping: SHIPPING });
		expect(res.statusCode).toBe(402);
		const body = parse(res);
		// 48.20 USDC at 6 decimals. A different order is a different amount.
		expect(body.accepts.some((a) => a.amount === '48200000')).toBe(true);
		expect(body.accepts[0].amount).not.toBe(floorPriceAtomics());
		// Nothing was opened: the caller has not paid yet.
		expect(store.created).toHaveLength(0);
	});

	it('refuses a tampered token before issuing any challenge', async () => {
		const token = tokenFor();
		const [prefix, payload] = token.split('.');
		const forged = `${prefix}.${payload}.bm90LWEtc2lnbmF0dXJl`;
		const res = await call({ token: forged, shipping: SHIPPING });
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('quote_invalid');
	});

	it('refuses an incomplete address before issuing any challenge', async () => {
		const partial = { ...SHIPPING };
		delete partial.city;
		const res = await call({ token: tokenFor(), shipping: partial });
		expect(res.statusCode).toBe(422);
		expect(parse(res).field).toBe('city');
	});

	it('refuses a destination the quote was not priced for before charging', async () => {
		const res = await call({ token: tokenFor(), shipping: { ...SHIPPING, country: 'AU' } });
		expect(res.statusCode).toBe(422);
		expect(parse(res).error).toBe('destination_mismatch');
	});

	it('demands a token when a payment header arrives with no order', async () => {
		const res = await call(null, { 'x-payment': 'deadbeef' });
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('token_required');
	});
});
