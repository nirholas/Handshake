// Free tier lane for the aggregator (api/v1/x/[...slug].js).
//
// An unauthenticated caller (no BYOK key, no three.ws credentials) on an
// endpoint marked `free: { perMin, perDay }` in api/v1/_providers.js gets a
// real per-IP quota BEFORE the x402 402 challenge — the tests pin the contract
// that makes "the free crypto API" true instead of marketing copy:
//   • a free endpoint (coingecko/price) serves real upstream data with zero
//     credentials, against a fetch stub shaped like the REAL CoinGecko response,
//   • RateLimit-* + X-Free-Tier headers are present on every free response,
//   • quota exhaustion falls through to the x402 lane (not a bare 429),
//   • a non-free endpoint (openai/chat) never touches the free lane at all,
//   • the catalog (GET /api/v1/x) exposes each endpoint's free quota (or false).
//
// The rate limiter is mocked (switchable per test) and the network is stubbed
// via global fetch, so the suite runs fully offline while exercising the real
// handler and the real executeUpstream/resolveUpstreamKey engine. getPaidHandler
// is stubbed to a minimal 402 responder so this suite stays scoped to the
// aggregator's OWN routing decision (free → serve, exhausted → hand off to the
// x402 lane); the x402 challenge's own correctness is covered by the existing
// x402 test suites (x402-discovery-parity, audit:x402-catalog, etc.).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// Switchable free-lane quota results — flip per test.
let freeMinOk = true;
let freeDayOk = true;
const freeMinCalls = [];
const freeDayCalls = [];

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		apiV1FreeMin: async (key, perMin) => {
			freeMinCalls.push({ key, perMin });
			return freeMinOk
				? { success: true, limit: perMin, remaining: perMin - 1, reset: Date.now() + 45_000 }
				: { success: false, limit: perMin, remaining: 0, reset: Date.now() + 45_000 };
		},
		apiV1FreeDay: async (key, perDay) => {
			freeDayCalls.push({ key, perDay });
			return freeDayOk
				? { success: true, limit: perDay, remaining: perDay - 1, reset: Date.now() + 86_400_000 }
				: { success: false, limit: perDay, remaining: 0, reset: Date.now() + 86_400_000 };
		},
	},
	clientIp: () => '203.0.113.7',
}));

vi.mock('../../api/_lib/auth.js', () => ({
	authenticateBearer: async () => null,
	extractBearer: () => null,
	getSessionUser: async () => null,
	hasScope: () => true,
}));

const recordedEvents = [];
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: (evt) => recordedEvents.push(evt),
}));

// Boundary stubs for infra this route never truly exercises in the free/402
// paths under test (mirrors tests/api/v1-text-to-3d.test.js's pattern).
vi.mock('../../api/_lib/db.js', () => ({
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: () => {} }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => null, drain: async () => {} }));

// Real executeUpstream/resolveUpstreamKey (exercised against the fetch stub
// below); getPaidHandler stubbed to a minimal, honest 402 responder so this
// suite proves the ROUTING decision (serve free vs. hand off to x402), not the
// paidEndpoint challenge internals (covered elsewhere).
const paidHandlerCalls = [];
vi.mock('../../api/_lib/aggregator.js', async () => {
	const actual = await vi.importActual('../../api/_lib/aggregator.js');
	return {
		...actual,
		getPaidHandler: (provider, endpoint) => {
			paidHandlerCalls.push({ provider: provider.id, endpoint: endpoint.id });
			return async (req, res) => {
				res.statusCode = 402;
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ x402Version: 1, accepts: [], _stub: 'paidHandler' }));
			};
		},
	};
});

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
	freeMinOk = true;
	freeDayOk = true;
	freeMinCalls.length = 0;
	freeDayCalls.length = 0;
	recordedEvents.length = 0;
	paidHandlerCalls.length = 0;
});
afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

function makeReq({ method = 'GET', url, body = null, headers = {} } = {}) {
	const raw = body == null ? '' : JSON.stringify(body);
	const stream = Readable.from(raw ? [Buffer.from(raw)] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = { host: 'three.ws', ...headers, ...(body != null ? { 'content-type': 'application/json' } : {}) };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
			this.writableEnded = true;
		},
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/v1/x/[...slug].js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// Real-shaped CoinGecko /simple/price response (no transform on coingecko/price
// — passthrough), so the fixture below IS the exact JSON the free lane returns.
const COINGECKO_PRICE_FIXTURE = { solana: { usd: 141.23 } };

function jsonFetchResponse(obj, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(obj),
	};
}

describe('free tier — serves a free endpoint with zero credentials', () => {
	it('coingecko/price returns real upstream data, no auth, no payment', async () => {
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toContain('api.coingecko.com/api/v3/simple/price');
			expect(String(url)).toContain('ids=solana');
			return jsonFetchResponse(COINGECKO_PRICE_FIXTURE);
		});

		const req = makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' });
		const res = makeRes();
		const { body } = await dispatch(req, res);

		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual(COINGECKO_PRICE_FIXTURE);
		expect(body._meta).toMatchObject({ provider: 'coingecko', endpoint: 'price', billing: 'free' });
		expect(body._meta.free_remaining).toEqual({ per_min: 29, per_day: 1999 });
	});

	it('sets X-Free-Tier and RateLimit-* headers on the free response', async () => {
		globalThis.fetch = vi.fn(async () => jsonFetchResponse(COINGECKO_PRICE_FIXTURE));
		const req = makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' });
		const res = makeRes();
		await dispatch(req, res);

		expect(res._h['x-free-tier']).toBe('1');
		expect(res._h['ratelimit-limit']).toBeDefined();
		expect(res._h['ratelimit-remaining']).toBeDefined();
		expect(res._h['ratelimit-reset']).toBeDefined();
	});

	it('meters the free call with billing: free (funnel adoption is measurable)', async () => {
		globalThis.fetch = vi.fn(async () => jsonFetchResponse(COINGECKO_PRICE_FIXTURE));
		const req = makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' });
		await dispatch(req, makeRes());

		expect(recordedEvents).toHaveLength(1);
		expect(recordedEvents[0]).toMatchObject({
			kind: 'api',
			tool: 'v1.x.coingecko.price',
			status: 'ok',
			meta: { billing: 'free', ip: '203.0.113.7' },
		});
	});

	it('checks both the per-minute and per-day buckets, keyed per provider/endpoint/IP', async () => {
		globalThis.fetch = vi.fn(async () => jsonFetchResponse(COINGECKO_PRICE_FIXTURE));
		await dispatch(makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' }), makeRes());

		expect(freeMinCalls).toEqual([{ key: 'coingecko:price:203.0.113.7', perMin: 30 }]);
		expect(freeDayCalls).toEqual([{ key: 'coingecko:price:203.0.113.7', perDay: 2000 }]);
	});
});

describe('free tier — quota exhaustion falls through to the x402 lane', () => {
	it('over the daily quota → hands off to getPaidHandler (real 402), never calls the upstream', async () => {
		freeDayOk = false;
		globalThis.fetch = vi.fn(async () => {
			throw new Error('must not call the upstream once the free quota is exhausted');
		});

		const req = makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' });
		const res = makeRes();
		const { body } = await dispatch(req, res);

		expect(res.statusCode).toBe(402);
		expect(body._stub).toBe('paidHandler');
		expect(paidHandlerCalls).toEqual([{ provider: 'coingecko', endpoint: 'price' }]);
		// Reset hint rides a header since the 402 body shape is spec-locked.
		expect(res._h['x-free-tier-reset']).toBeDefined();
		expect(() => new Date(res._h['x-free-tier-reset']).toISOString()).not.toThrow();
		expect(res._h['x-free-tier']).toBe('1');
	});

	it('over the per-minute burst quota also falls through, with burst-window headers', async () => {
		freeMinOk = false;
		globalThis.fetch = vi.fn(async () => {
			throw new Error('must not call the upstream once the free quota is exhausted');
		});

		const req = makeReq({ url: '/api/v1/x/coingecko/price?ids=solana' });
		const res = makeRes();
		const { body } = await dispatch(req, res);

		expect(res.statusCode).toBe(402);
		expect(body._stub).toBe('paidHandler');
		// The blocking bucket (perMin, limit 30) drives the RateLimit-* headers.
		expect(res._h['ratelimit-limit']).toBe('30');
	});
});

describe('free tier — a non-free endpoint never engages the free lane', () => {
	it('openai/chat 402s immediately without checking any free quota', async () => {
		const req = makeReq({
			method: 'POST',
			url: '/api/v1/x/openai/chat',
			body: { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] },
		});
		const res = makeRes();
		const { body } = await dispatch(req, res);

		expect(res.statusCode).toBe(402);
		expect(body._stub).toBe('paidHandler');
		expect(paidHandlerCalls).toEqual([{ provider: 'openai', endpoint: 'chat' }]);
		expect(freeMinCalls).toHaveLength(0);
		expect(freeDayCalls).toHaveLength(0);
		expect(res._h['x-free-tier']).toBeUndefined();
	});
});

describe('free tier — catalog discovery', () => {
	it('GET /api/v1/x exposes each endpoint\'s free quota, or false when not free', async () => {
		const req = makeReq({ url: '/api/v1/x' });
		const res = makeRes();
		const { body } = await dispatch(req, res);

		expect(res.statusCode).toBe(200);
		expect(body.data.billing.free).toMatch(/free/i);

		const coingecko = body.data.providers.find((p) => p.id === 'coingecko');
		const price = coingecko.endpoints.find((e) => e.id === 'price');
		expect(price.free).toEqual({ perMin: 30, perDay: 2000 });
		const markets = coingecko.endpoints.find((e) => e.id === 'markets');
		expect(markets.free).toEqual({ perMin: 30, perDay: 2000 });

		const defillama = body.data.providers.find((p) => p.id === 'defillama');
		for (const e of defillama.endpoints) {
			expect(e.free).toEqual({ perMin: 30, perDay: 2000 });
		}

		const openai = body.data.providers.find((p) => p.id === 'openai');
		const chat = openai.endpoints.find((e) => e.id === 'chat');
		expect(chat.free).toBe(false);
	});
});
