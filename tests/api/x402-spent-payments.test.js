// Durable spent-payment replay guard for api/_lib/x402-paid-endpoint.js.
//
// The always-on replay key (`proof:<paymentHash>`) lives in the idempotency
// cache and dies with its TTL. Past that expiry a captured X-PAYMENT header
// used to re-enter the handler, re-run its side effects and re-deliver the paid
// good. api/_lib/x402/spent-payments.js closes that leg with a Postgres row per
// honoured proof; this suite drives the REAL paidEndpoint() + REAL
// spent-payments module against an in-memory stand-in for the Neon `sql` tag,
// so both the lookup and the atomic claim are exercised as written.
//
// Cache expiry is simulated by resetting the in-memory idempotency store
// between the two requests — exactly the state a payer's client sees once the
// TTL has lapsed.

import { Readable } from 'node:stream';

import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';

const verifyPayment = vi.fn();
const settlePayment = vi.fn();
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, verifyPayment, settlePayment };
});

const auditEvents = [];
vi.mock('../../api/_lib/x402/audit-log.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		logPaymentEvent: (event) => {
			auditEvents.push(event);
		},
	};
});

// In-memory stand-in for the Neon tagged template, scoped to the two statements
// spent-payments.js issues. `dbDown` flips it into the failure mode the module's
// fail-open policy is written for.
const spentRows = new Map();
let dbDown = false;
function fakeSql(strings, ...values) {
	const query = Array.isArray(strings) ? strings.join('?') : String(strings);
	if (dbDown) {
		return Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
	}
	if (/SELECT 1 FROM x402_spent_payments/i.test(query)) {
		const [hash] = values;
		return Promise.resolve(spentRows.has(hash) ? [{ '?column?': 1 }] : []);
	}
	if (/INSERT INTO x402_spent_payments/i.test(query)) {
		const [hash, endpoint, amount] = values;
		if (spentRows.has(hash)) return Promise.resolve([]); // ON CONFLICT DO NOTHING
		spentRows.set(hash, { endpoint, amount_atomics: amount, created_at: new Date() });
		return Promise.resolve([{ payment_hash: hash }]);
	}
	return Promise.resolve([]);
}
vi.mock('../../api/_lib/db.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, sql: fakeSql };
});

vi.mock('@coinbase/x402', () => ({ createCdpAuthHeaders: vi.fn(async () => ({})) }));

let paidEndpoint;
let cacheMod;

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';
const ASSET_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTE = '/api/x402/spent-test';

const HANDLER_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'object', properties: {}, required: [] },
		output: { type: 'object', properties: { ok: { type: 'boolean' } } },
	},
	schema: { type: 'object' },
};

function mockReqRes({ method = 'GET', headers = {}, url = ROUTE } = {}) {
	const lowerHeaders = {};
	for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
	const req = Object.assign(new Readable({ read() {} }), {
		method,
		url,
		headers: lowerHeaders,
		connection: { remoteAddress: '127.0.0.1' },
		socket: { remoteAddress: '127.0.0.1' },
	});
	req.push(null);
	const chunks = [];
	const resHeaders = {};
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) {
			resHeaders[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return resHeaders[k.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) chunks.push(body);
			res.writableEnded = true;
		},
		write(chunk) {
			chunks.push(chunk);
		},
		get body() {
			return chunks.join('');
		},
		get headers() {
			return resHeaders;
		},
	};
	return { req, res };
}

function paymentHeader({ salt = 'a' } = {}) {
	const payload = {
		x402Version: 2,
		scheme: 'exact',
		network: BASE,
		payload: { authorization: { value: '1000', to: PAY_TO_BASE, salt } },
	};
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function makeEndpoint(handler, spec = {}) {
	return paidEndpoint({
		route: ROUTE,
		method: 'GET',
		networks: ['base'],
		description: 'durable spent-payment test',
		bazaar: HANDLER_BAZAAR,
		offerReceipt: false,
		handler,
		...spec,
	});
}

// A paid request whose handler counts its own side effects.
async function callPaid(handler, { salt = 'a', spec = {} } = {}) {
	const endpoint = makeEndpoint(handler, spec);
	const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader({ salt }) } });
	await endpoint(req, res);
	return res;
}

const ORIG_ENV = { ...process.env };

beforeAll(async () => {
	process.env.X402_ALLOW_MEMORY_FALLBACK = '1';
	paidEndpoint = (await import('../../api/_lib/x402-paid-endpoint.js')).paidEndpoint;
	cacheMod = await import('../../api/_lib/x402/idempotency-cache.js');
});

beforeEach(() => {
	process.env.X402_PAY_TO_BASE = PAY_TO_BASE;
	process.env.X402_ASSET_ADDRESS_BASE = ASSET_BASE;
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	process.env.X402_ADVERTISE_BASE = 'true';
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
	delete process.env.X402_BUILDER_CODE_APP;
	cacheMod._resetMemoryStore();
	spentRows.clear();
	dbDown = false;
	auditEvents.length = 0;
	verifyPayment.mockReset();
	settlePayment.mockReset();
	verifyPayment.mockImplementation(async () => ({
		paymentPayload: {},
		requirement: {
			scheme: 'exact',
			network: BASE,
			payTo: PAY_TO_BASE,
			asset: ASSET_BASE,
			amount: '1000',
		},
		payer: 'PAYER',
	}));
	settlePayment.mockImplementation(async () => ({
		success: true,
		transaction: '0xdeadbeef',
		network: BASE,
		payer: 'PAYER',
	}));
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (!(k in ORIG_ENV)) delete process.env[k];
	Object.assign(process.env, ORIG_ENV);
});

describe('paidEndpoint() durable spent-payment guard', () => {
	it('records the spent proof (route + amount) on a successful paid call', async () => {
		let ran = 0;
		const res = await callPaid(async () => ({ ok: true, n: ++ran }));

		expect(res.statusCode).toBe(200);
		expect(ran).toBe(1);
		expect(spentRows.size).toBe(1);
		const [row] = [...spentRows.values()];
		expect(row).toMatchObject({ endpoint: ROUTE, amount_atomics: '1000' });
	});

	it('refuses a replay of the same X-PAYMENT once the idempotency cache has expired, and never runs the handler', async () => {
		let ran = 0;
		const first = await callPaid(async () => ({ ok: true, n: ++ran }));
		expect(first.statusCode).toBe(200);
		expect(ran).toBe(1);

		// The cache TTL lapses — the only thing that used to stand between a
		// captured header and a second run of the handler's side effects.
		cacheMod._resetMemoryStore();
		settlePayment.mockClear();

		const replay = await callPaid(async () => ({ ok: true, n: ++ran }));

		expect(replay.statusCode).toBe(409);
		expect(JSON.parse(replay.body)).toMatchObject({ error: 'payment_replayed', route: ROUTE });
		expect(replay.getHeader('x-x402-idempotent')).toBe('replayed');
		expect(ran).toBe(1); // side effects did NOT re-run
		expect(settlePayment).not.toHaveBeenCalled(); // and no second facilitator round-trip
		expect(auditEvents.some((e) => e.eventType === 'payment_replay_rejected')).toBe(true);
	});

	it('refuses a replay on a streaming route before a single byte of the good ships', async () => {
		const streamHandler = async ({ res }) => {
			res.setHeader('content-type', 'application/octet-stream');
			res.write('BINARY');
			res.end();
		};
		const first = await callPaid(streamHandler, { spec: { streaming: true } });
		expect(first.body).toBe('BINARY');

		cacheMod._resetMemoryStore();
		const replay = await callPaid(streamHandler, { spec: { streaming: true } });

		expect(replay.statusCode).toBe(409);
		expect(replay.body).not.toContain('BINARY');
	});

	it('leaves distinct payments unaffected', async () => {
		const first = await callPaid(async () => ({ ok: true }), { salt: 'a' });
		const second = await callPaid(async () => ({ ok: true }), { salt: 'b' });

		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(spentRows.size).toBe(2);
	});

	it('writes no spent row when settlement fails, so the payer can retry the same header', async () => {
		settlePayment.mockRejectedValueOnce(
			Object.assign(new Error('facilitator down'), { status: 502, code: 'settle_failed' }),
		);
		const failed = await callPaid(async () => ({ ok: true }));
		expect(failed.statusCode).toBe(502);
		expect(spentRows.size).toBe(0);

		cacheMod._resetMemoryStore();
		const retry = await callPaid(async () => ({ ok: true }));
		expect(retry.statusCode).toBe(200);
		expect(spentRows.size).toBe(1);
	});

	it('the claim is atomic: a request that loses the insert race is refused, not delivered', async () => {
		// Simulate the race directly — another request claims the proof while this
		// one is inside the handler, so only the losing claim is left to arbitrate.
		let ran = 0;
		const res = await callPaid(async () => {
			ran++;
			// The winner's row lands mid-flight. hashPaymentProof is deterministic,
			// so seeding the map under the same hash is exactly what the winner did.
			const { hashPaymentProof } = await import('../../api/_lib/x402/idempotency-cache.js');
			spentRows.set(hashPaymentProof(paymentHeader()), { endpoint: ROUTE, amount_atomics: '1000' });
			return { ok: true };
		});

		expect(ran).toBe(1);
		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.body)).toMatchObject({ error: 'payment_replayed' });
		expect(res.body).not.toContain('"ok":true');
	});

	it('fails OPEN when the database is unreachable: the paid route keeps serving', async () => {
		dbDown = true;
		const res = await callPaid(async () => ({ ok: true }));

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true });
		expect(res.getHeader('x-payment-response')).toBeTruthy();
	});
});
