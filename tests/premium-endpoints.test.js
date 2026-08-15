/**
 * Boundary behaviour for two premium endpoints.
 *
 * POST /api/premium/subscribe
 *   premium_quotes.id is a uuid column. A quote_id that is not uuid-shaped used
 *   to reach the driver and come back as SQLSTATE 22P02, which the wrapper
 *   turned into a 500 with an opaque support ref. Malformed input has to answer
 *   4xx, so the id is shaped at the boundary before any query runs.
 *
 * POST /api/premium/keys (rotate)
 *   The old credential must be revoked only AFTER its replacement exists. The
 *   reverse order means a failed mint leaves a paying customer with a revoked
 *   key and no way back (the retry hits the key_revoked branch).
 *
 * DB, session, CSRF, key mint, and the premium lib are mocked; the HTTP
 * envelope helpers run for real so status codes and JSON bodies are genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER = { id: '28e98fb2-2a98-4500-b45a-5a9ad7b3f7a8', email: 'buyer@three.ws' };
const KEY_ID = 'sub_premiumkey01';
const QUOTE_ID = '2af3ee5e-8b10-40d5-bbf2-f375197dc39f';
const TX_SIG = '5Zx1uWnPZ8kkVYQ9mLXJx3nQ8Yb2c1D4eF5gH6jK7mN8pQ9rS1tU2vW3xY4zA5bC6dE7fG8hJ9kL1mN2pQ3r';

const db = vi.hoisted(() => ({ handlers: [], calls: [] }));
const keyLane = vi.hoisted(() => ({ order: [], mintFails: false, underLimit: true }));

vi.mock('../api/_lib/db.js', () => ({
	sql: async (strings, ...values) => {
		const text = strings.join(' $ ').replace(/\s+/g, ' ').trim();
		db.calls.push({ text, values });
		for (const h of db.handlers) {
			if (h.match.test(text)) return h.result(values, text);
		}
		return [];
	},
	// http.js's wrap() classifies thrown errors through these on the 5xx path.
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));
vi.mock('../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => USER) }));
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		premiumSubscribeIp: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
		premiumKeysUser: vi.fn(async () => ({ success: keyLane.underLimit, reset: Date.now() + 3_600_000 })),
	},
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/premium.js', () => ({
	verifyPassPayment: vi.fn(async () => ({ ok: false, pending: true, reason: 'still confirming' })),
	activatePass: vi.fn(async () => ({ pass: { id: 'pass-1' }, apiKey: null, renewed: false })),
}));
vi.mock('../api/_lib/x402/api-keys.js', () => ({
	createSubscription: vi.fn(async (opts) => {
		keyLane.order.push('mint');
		if (keyLane.mintFails) throw new Error('key mint unavailable');
		return { id: 'sub_freshkey02', name: opts.name, key_prefix: 'x402_live_FRESH', token: 'x402_live_freshplaintext' };
	}),
	revokeSubscription: vi.fn(async () => {
		keyLane.order.push('revoke');
		return { id: KEY_ID };
	}),
}));

const { default: subscribeHandler } = await import('../api/premium/subscribe.js');
const { default: keysHandler } = await import('../api/premium/keys.js');

function makeReq(url, body) {
	return {
		method: 'POST',
		url,
		headers: { origin: 'https://three.ws', 'content-type': 'application/json' },
		body,
		socket: { remoteAddress: '127.0.0.1' },
	};
}
function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(handler, url, body) {
	const res = makeRes();
	await handler(makeReq(url, body), res);
	return res;
}

beforeEach(() => {
	db.handlers = [];
	db.calls = [];
	keyLane.order = [];
	keyLane.mintFails = false;
	keyLane.underLimit = true;
	vi.clearAllMocks();
});

describe('POST /api/premium/subscribe: quote_id shape', () => {
	it('answers 400 on a non-uuid quote_id without querying the quote table', async () => {
		const r = await call(subscribeHandler, '/api/premium/subscribe', {
			quote_id: 'not-a-uuid',
			tx_signature: TX_SIG,
		});
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('bad_quote');
		expect(db.calls.some((c) => /premium_quotes/.test(c.text))).toBe(false);
	});

	it('still reaches the lookup for a well-formed quote_id it has never seen', async () => {
		const r = await call(subscribeHandler, '/api/premium/subscribe', {
			quote_id: QUOTE_ID,
			tx_signature: TX_SIG,
		});
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('quote_not_found');
		expect(db.calls.some((c) => /premium_quotes/.test(c.text))).toBe(true);
	});
});

describe('POST /api/premium/keys: rotate ordering', () => {
	const premiumKeyRow = {
		id: KEY_ID,
		name: 'three.ws Developer pass',
		rate_limit_per_minute: 120,
		expires_at: '2026-09-13T00:00:00.000Z',
		revoked_at: null,
		meta: { source: 'premium-pass', plan: 'developer', user_id: USER.id, wallet: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
	};

	beforeEach(() => {
		db.handlers = [{ match: /from x402_subscriptions/, result: () => [premiumKeyRow] }];
	});

	it('mints the replacement before revoking the old credential', async () => {
		const r = await call(keysHandler, '/api/premium/keys', { action: 'rotate', id: KEY_ID });
		expect(r._s).toBe(200);
		expect(r.json()).toMatchObject({ rotated: true, id: 'sub_freshkey02', api_key: 'x402_live_freshplaintext' });
		expect(keyLane.order).toEqual(['mint', 'revoke']);
		const repoint = db.calls.find((c) => /update premium_passes/.test(c.text));
		expect(repoint.values).toEqual(['sub_freshkey02', KEY_ID]);
	});

	it('leaves the paid key usable when the replacement cannot be minted', async () => {
		keyLane.mintFails = true;
		const r = await call(keysHandler, '/api/premium/keys', { action: 'rotate', id: KEY_ID });
		expect(r._s).toBe(500);
		expect(keyLane.order).toEqual(['mint']);
		expect(db.calls.some((c) => /update premium_passes/.test(c.text))).toBe(false);
	});

	it('meters rotations per account, so a session cannot mint keys in a loop', async () => {
		keyLane.underLimit = false;
		const r = await call(keysHandler, '/api/premium/keys', { action: 'rotate', id: KEY_ID });
		expect(r._s).toBe(429);
		expect(r.json().error).toBe('rate_limited');
		expect(keyLane.order).toEqual([]);
	});

	it('rejects a key that belongs to another account', async () => {
		db.handlers = [
			{ match: /from x402_subscriptions/, result: () => [{ ...premiumKeyRow, meta: { source: 'premium-pass', user_id: 'someone-else' } }] },
		];
		const r = await call(keysHandler, '/api/premium/keys', { action: 'rotate', id: KEY_ID });
		expect(r._s).toBe(404);
		expect(r.json().error).toBe('key_not_found');
		expect(keyLane.order).toEqual([]);
	});
});
