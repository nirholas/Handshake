// Dispatch and boundary contract for the self-hosted x402 facilitator endpoint
// (api/x402-facilitator/[action].js).
//
// The handler is one file serving five public actions behind a single
// [action].js route, and the split between them is pure string dispatch on a
// query param that vercel.json fills from the URL path. Everything downstream
// of that dispatch already has tests (self-facilitator.js, settle-credit.js,
// discovery-resources.js, wallet-fee-meter.js) and the audit-log write has its
// own regression file (x402-facilitator-log-durable.test.js), but the dispatch
// itself and the four rejection boundaries in front of the money path had none.
//
// Those boundaries are what an unauthenticated caller reaches first, and each
// one is load-bearing:
//   - the disabled-503 is the only thing standing between a misconfigured
//     deploy and a settle attempt with no sponsor key,
//   - the Solana-only network check keeps an EVM payload from reaching a
//     handler that would try to decode it as a Solana transaction,
//   - the 400 on a missing payload is what makes callFacilitator's error path
//     deterministic instead of a decode crash,
//   - and the GET/POST split is what keeps /verify and /settle off a method
//     that browsers and crawlers issue unprompted.
//
// The module boundaries below are mocked the same way the neighboring x402
// tests mock theirs: the DB, the settle engine, the rate limiter, the fee
// meter, and the catalog builder. The settle-credit gate is left REAL and
// driven through the mocked sql, so the credited and refused branches this
// file asserts are the actual gate's verdicts, not a stand-in's.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	enabled: true,
	verify: vi.fn(),
	settle: vi.fn(),
	list: vi.fn(),
	recordSettledFee: vi.fn(),
	// Statement text -> rows. The settle-credit gate reads any prior credit for
	// the signature (SELECT) and then claims it (INSERT ... RETURNING id).
	rows: { select: [], insert: [{ id: 1 }] },
	queries: [],
	sqlFails: false,
}));

vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings) => {
		const query = Array.isArray(strings) ? strings.join(' ') : String(strings ?? '');
		h.queries.push(query);
		if (h.sqlFails) return Promise.reject(new Error('Error connecting to database'));
		return Promise.resolve(/INSERT/i.test(query) ? h.rows.insert : h.rows.select);
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// A getter, not a plain property: the handler reads SELF_FACILITATOR_ENABLED per
// request through the live import binding, so a getter lets one module instance
// serve both the enabled and disabled cases without resetting the module graph.
vi.mock('../../api/_lib/x402/self-facilitator.js', () => ({
	get SELF_FACILITATOR_ENABLED() { return h.enabled; },
	verifyRingPayment: (...a) => h.verify(...a),
	settleRingPayment: (...a) => h.settle(...a),
}));

vi.mock('../../api/_lib/x402/wallet-fee-meter.js', () => ({
	facilitatorFeeMeter: () => null,
	recordSettledFee: (...a) => h.recordSettledFee(...a),
}));

vi.mock('../../api/_lib/x402/discovery-resources.js', () => ({
	listDiscoveryResources: (...a) => h.list(...a),
}));

// The limiter's own buckets are covered in tests/rate-limit*.test.js; here it
// only has to admit, so the boundary under test is the handler's dispatch.
vi.mock('../../api/_lib/rate-limit.js', () => ({
	clientIp: () => '203.0.113.7',
	limits: {
		x402FacilitatorIp: async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 }),
		x402FacilitatorGlobal: async () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 }),
	},
}));

const handler = (await import('../../api/x402-facilitator/[action].js')).default;

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const PAYLOAD = {
	paymentPayload: { x402Version: 2, scheme: 'exact', network: SOLANA, payload: { transaction: 'BASE64' } },
	paymentRequirements: { scheme: 'exact', network: SOLANA, payTo: 'PAYTO', asset: 'MINT', amount: '10000' },
};

function makeRes() {
	return {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		headers: {},
		body: null,
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		end(b) { this.writableEnded = true; this.body = b == null ? null : String(b); },
	};
}

// Drive the handler the way the server does: vercel.json rewrites the path to
// ?action=<segment>, so `action` is what the route table decided, and `url` is
// what the caller actually asked for.
async function call({ action, method = 'GET', body, query = {}, headers = {}, url } = {}) {
	const req = {
		method,
		url: url ?? `/api/x402-facilitator/${action}`,
		query: { action, ...query },
		headers: { host: 'three.ws', ...headers },
		body,
	};
	const res = makeRes();
	await handler(req, res);
	let json = null;
	try { json = res.body == null ? null : JSON.parse(res.body); } catch { json = null; }
	return { res, status: res.statusCode, json };
}

beforeEach(() => {
	h.enabled = true;
	h.sqlFails = false;
	h.queries = [];
	h.rows = { select: [], insert: [{ id: 1 }] };
	h.verify.mockReset();
	h.settle.mockReset();
	h.list.mockReset();
	h.recordSettledFee.mockReset();
});

describe('preflight and CORS', () => {
	it('answers OPTIONS with 204 and the wildcard CORS grant', async () => {
		const { res, status } = await call({ action: 'verify', method: 'OPTIONS' });
		expect(status).toBe(204);
		expect(res.writableEnded).toBe(true);
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
	});

	it('sets the wildcard grant on a rejection too, so a browser can read the error', async () => {
		h.enabled = false;
		const { res, status } = await call({ action: 'verify', method: 'POST', body: {} });
		expect(status).toBe(503);
		expect(res.headers['access-control-allow-origin']).toBe('*');
	});
});

describe('GET / (index discovery document)', () => {
	it('describes the service, its four endpoints, and the exact/solana kind', async () => {
		const { status, json } = await call({ action: 'index', url: '/api/x402-facilitator' });
		expect(status).toBe(200);
		expect(json.service).toContain('facilitator');
		expect(json.x402Version).toBe(2);
		expect(json.kinds).toEqual([{ x402Version: 2, scheme: 'exact', network: SOLANA }]);
		expect(Object.keys(json.endpoints).sort()).toEqual(['discovery', 'settle', 'supported', 'verify']);
		expect(json.endpoints.verify).toEqual({ method: 'POST', path: '/api/x402-facilitator/verify' });
		expect(json.endpoints.discovery.path).toBe('/api/x402-facilitator/discovery/resources');
	});

	it('reports the live enabled flag rather than a constant', async () => {
		h.enabled = false;
		const off = await call({ action: 'index' });
		expect(off.json.enabled).toBe(false);
		h.enabled = true;
		const on = await call({ action: 'index' });
		expect(on.json.enabled).toBe(true);
	});

	it('resolves the index from the bare last path segment when no action param is set', async () => {
		const res = makeRes();
		await handler(
			{ method: 'GET', url: '/api/x402-facilitator', query: {}, headers: { host: 'three.ws' } },
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).service).toContain('facilitator');
	});

	it('is read-only: POST is rejected 405, never treated as a settle', async () => {
		const { status, json } = await call({ action: 'index', method: 'POST', body: PAYLOAD });
		expect(status).toBe(405);
		expect(json.error).toBe('method_not_allowed');
		expect(h.settle).not.toHaveBeenCalled();
	});
});

describe('GET /supported (capability probe)', () => {
	it('advertises exact/solana without a payment, a secret, or the enabled flag', async () => {
		h.enabled = false;
		const { status, json } = await call({ action: 'supported' });
		expect(status).toBe(200);
		expect(json).toEqual({ kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA }] });
	});

	it('answers POST too, since x402 clients probe with either verb', async () => {
		const { status, json } = await call({ action: 'supported', method: 'POST', body: {} });
		expect(status).toBe(200);
		expect(json.kinds).toHaveLength(1);
	});
});

describe('GET /discovery/resources (crawler catalog)', () => {
	const PAGE = { x402Version: 1, items: [], pagination: { limit: 2, offset: 4, total: 0 } };

	it('serves the catalog page and lets a crawler cache it for the catalog TTL', async () => {
		h.list.mockResolvedValue(PAGE);
		const { res, status, json } = await call({ action: 'discovery-resources' });
		expect(status).toBe(200);
		expect(json).toEqual(PAGE);
		expect(res.headers['cache-control']).toBe('public, max-age=300');
	});

	it('passes the crawler pagination window through untouched', async () => {
		h.list.mockResolvedValue(PAGE);
		await call({ action: 'discovery-resources', query: { type: 'http', limit: '2', offset: '4' } });
		expect(h.list).toHaveBeenCalledWith({ type: 'http', limit: '2', offset: '4' });
	});

	it('serves the same catalog from the bare-segment alias the path fallback yields', async () => {
		h.list.mockResolvedValue(PAGE);
		const { status, json } = await call({ action: 'resources' });
		expect(status).toBe(200);
		expect(json).toEqual(PAGE);
	});

	it('rejects POST 405 instead of falling through to the money path', async () => {
		const { status } = await call({ action: 'discovery-resources', method: 'POST', body: PAYLOAD });
		expect(status).toBe(405);
		expect(h.list).not.toHaveBeenCalled();
	});
});

describe('the four boundaries in front of the money path', () => {
	it('503s every POST when the facilitator is disabled, before any settle work', async () => {
		h.enabled = false;
		for (const action of ['verify', 'settle']) {
			const { status, json } = await call({ action, method: 'POST', body: PAYLOAD });
			expect(status).toBe(503);
			expect(json.errorReason).toBe('self_facilitator_disabled');
			expect(json.invalidReason).toBe('self_facilitator_disabled');
		}
		expect(h.verify).not.toHaveBeenCalled();
		expect(h.settle).not.toHaveBeenCalled();
	});

	it('405s a GET on verify and settle', async () => {
		for (const action of ['verify', 'settle']) {
			const { status, json } = await call({ action });
			expect(status).toBe(405);
			expect(json.error).toBe('method_not_allowed');
		}
	});

	it('400s a body missing paymentPayload or paymentRequirements', async () => {
		for (const body of [{}, { paymentPayload: PAYLOAD.paymentPayload }, { paymentRequirements: PAYLOAD.paymentRequirements }]) {
			const { status, json } = await call({ action: 'verify', method: 'POST', body });
			expect(status).toBe(400);
			expect(json.isValid).toBe(false);
			expect(json.invalidReason).toBe('missing paymentPayload/paymentRequirements');
		}
		expect(h.verify).not.toHaveBeenCalled();
	});

	it('400s a non-Solana network naming the network it refused', async () => {
		const { status, json } = await call({
			action: 'settle',
			method: 'POST',
			body: { ...PAYLOAD, paymentRequirements: { ...PAYLOAD.paymentRequirements, network: 'eip155:8453' } },
		});
		expect(status).toBe(400);
		expect(json.errorReason).toBe('unsupported_network:eip155:8453');
		expect(h.settle).not.toHaveBeenCalled();
	});

	it('404s an unknown action rather than guessing verify or settle', async () => {
		const { status, json } = await call({ action: 'nonsense', method: 'POST', body: PAYLOAD });
		expect(status).toBe(404);
		expect(json.error).toBe('unknown_action:nonsense');
		expect(h.verify).not.toHaveBeenCalled();
		expect(h.settle).not.toHaveBeenCalled();
	});
});

describe('POST /verify', () => {
	it('returns the verdict at 200 so callFacilitator reads isValid, not a status code', async () => {
		h.verify.mockResolvedValue({ isValid: true, network: SOLANA, asset: 'MINT', payer: 'BUYER' });
		const { status, json } = await call({ action: 'verify', method: 'POST', body: PAYLOAD });
		expect(status).toBe(200);
		expect(json).toEqual({ isValid: true, network: SOLANA, asset: 'MINT', payer: 'BUYER' });
	});

	it('returns an invalid verdict at 200 as well, and trails it in the audit log', async () => {
		h.verify.mockResolvedValue({ isValid: false, invalidReason: 'payer_not_signer' });
		const { status, json } = await call({ action: 'verify', method: 'POST', body: PAYLOAD });
		expect(status).toBe(200);
		expect(json.isValid).toBe(false);
		expect(json.invalidReason).toBe('payer_not_signer');
		expect(h.queries.filter((q) => /INSERT INTO x402_self_facilitator_log/.test(q))).toHaveLength(1);
	});

	it('still answers when the audit-log write fails, since the trail is not the verdict', async () => {
		h.sqlFails = true;
		h.verify.mockResolvedValue({ isValid: true, network: SOLANA, asset: 'MINT', payer: 'BUYER' });
		const { status, json } = await call({ action: 'verify', method: 'POST', body: PAYLOAD });
		expect(status).toBe(200);
		expect(json.isValid).toBe(true);
	});
});

describe('POST /settle', () => {
	const OK = { success: true, transaction: 'SIG1', network: SOLANA, payer: 'BUYER', feeLamports: 5000, feePayer: 'SPONSOR' };

	it('credits a fresh settlement, meters its fee burn, and returns the signature', async () => {
		h.settle.mockResolvedValue(OK);
		const { status, json } = await call({
			action: 'settle', method: 'POST', body: PAYLOAD, headers: { 'idempotency-key': 'key-1' },
		});
		expect(status).toBe(200);
		expect(json).toEqual({ success: true, transaction: 'SIG1', network: SOLANA, payer: 'BUYER' });
		expect(h.recordSettledFee).toHaveBeenCalledWith('SPONSOR', 5000);
	});

	it('reports a settle failure as 200 + success:false so the caller does not retry a 5xx', async () => {
		h.settle.mockResolvedValue({ success: false, reason: 'fee_runway_exhausted' });
		const { status, json } = await call({ action: 'settle', method: 'POST', body: PAYLOAD });
		expect(status).toBe(200);
		expect(json).toEqual({ success: false, errorReason: 'fee_runway_exhausted' });
		expect(h.recordSettledFee).not.toHaveBeenCalled();
	});

	it('refuses a signature another payment already settled, and does not double-meter it', async () => {
		h.settle.mockResolvedValue(OK);
		h.rows.select = [{ id: 9, idempotency_key: 'someone-elses-key' }];
		const { status, json } = await call({
			action: 'settle', method: 'POST', body: PAYLOAD, headers: { 'idempotency-key': 'key-1' },
		});
		expect(status).toBe(200);
		expect(json).toEqual({ success: false, errorReason: 'signature_already_settled' });
		expect(h.recordSettledFee).not.toHaveBeenCalled();
	});

	it('answers an idempotent replay with the original success and meters the fee once', async () => {
		h.settle.mockResolvedValue(OK);
		h.rows.select = [{ id: 9, idempotency_key: 'key-1' }];
		const { status, json } = await call({
			action: 'settle', method: 'POST', body: PAYLOAD, headers: { 'idempotency-key': 'key-1' },
		});
		expect(status).toBe(200);
		expect(json.success).toBe(true);
		expect(json.transaction).toBe('SIG1');
		expect(h.recordSettledFee).not.toHaveBeenCalled();
	});

	it('fails the credit closed when the ledger is unreachable', async () => {
		h.settle.mockResolvedValue(OK);
		h.sqlFails = true;
		const { status, json } = await call({ action: 'settle', method: 'POST', body: PAYLOAD });
		expect(status).toBe(200);
		expect(json).toEqual({ success: false, errorReason: 'settle_credit_unavailable' });
		expect(h.recordSettledFee).not.toHaveBeenCalled();
	});
});
