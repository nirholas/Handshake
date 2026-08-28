/**
 * HTTP-level tests for POST /api/herald/announce, the rail that lets a build
 * script, a cron, or an AI agent make the caller's own avatar say something.
 *
 * The pieces worth pinning are the ones that decide who can interrupt whom:
 *
 *   1. A session or a key with the `herald:announce` scope, and nothing else.
 *      A valid key WITHOUT the scope must be a 403, not a delivery: keys are
 *      minted for other purposes and must not silently gain this one.
 *   2. The record that lands on the queue is normalised, not echoed. A hostile
 *      url never reaches the recipient's page as a clickable link.
 *   3. A queue write that fails is a 503, never a 202: "queued" has to mean it.
 *
 * Only the impure edges are stubbed (auth, Redis, the rate limiter). The
 * handler, its validation, and its wire shape are the real module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser = null;
let bearerResult = null;

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => sessionUser,
	authenticateBearer: async () => bearerResult,
	extractBearer: (req) => {
		const h = req.headers.authorization || '';
		return h.toLowerCase().startsWith('bearer ') ? h.slice(7) : null;
	},
	hasScope: (granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	},
}));

const redisOps = [];
let redisAvailable = true;
let redisThrows = false;

vi.mock('../api/_lib/redis.js', () => ({
	getRedis: () =>
		redisAvailable
			? {
					async rpush(key, value) {
						if (redisThrows) throw new Error('upstash down');
						redisOps.push(['rpush', key, value]);
						return 1;
					},
					async ltrim(key, start, stop) {
						redisOps.push(['ltrim', key, start, stop]);
					},
					async expire(key, ttl) {
						redisOps.push(['expire', key, ttl]);
					},
				}
			: null,
}));

const heraldAnnounce = vi.fn(async () => ({
	success: true,
	limit: 60,
	remaining: 59,
	reset: Date.now() + 60_000,
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { heraldAnnounce: (...a) => heraldAnnounce(...a) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../api/herald/announce.js');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
		},
		get json() {
			try {
				return JSON.parse(this._body);
			} catch {
				return null;
			}
		},
	};
}

function mockReq(body, headers = {}) {
	// The platform's readBody() concatenates Buffers, so the stub must emit
	// Buffers too or every handler test 500s inside the body reader.
	const payload = Buffer.from(JSON.stringify(body));
	return {
		method: 'POST',
		url: '/api/herald/announce',
		headers: { host: 'three.ws', origin: 'https://three.ws', 'content-type': 'application/json', ...headers },
		on(event, cb) {
			if (event === 'data') cb(payload);
			if (event === 'end') cb();
			return this;
		},
	};
}

const post = async (body, headers) => {
	const res = mockRes();
	await handler(mockReq(body, headers), res);
	return res;
};

beforeEach(() => {
	sessionUser = null;
	bearerResult = null;
	redisAvailable = true;
	redisThrows = false;
	redisOps.length = 0;
	heraldAnnounce.mockClear();
});

describe('who may interrupt', () => {
	it('rejects an anonymous caller', async () => {
		const res = await post({ text: 'hello' });
		expect(res.statusCode).toBe(401);
	});

	it('accepts a signed-in session', async () => {
		sessionUser = { id: 'user-1' };
		const res = await post({ text: 'Deploy is green' });
		expect(res.statusCode).toBe(202);
		expect(res.json.queued).toBe(true);
	});

	it('accepts a key carrying the herald:announce scope', async () => {
		bearerResult = { userId: 'user-2', scope: 'profile herald:announce' };
		const res = await post({ text: 'from CI' }, { authorization: 'Bearer sk_live_x' });
		expect(res.statusCode).toBe(202);
		expect(redisOps[0][1]).toBe('herald:user-2:queue');
	});

	it('refuses a valid key that was never granted the scope', async () => {
		bearerResult = { userId: 'user-3', scope: 'avatars:read' };
		const res = await post({ text: 'sneaky' }, { authorization: 'Bearer sk_live_y' });
		expect(res.statusCode).toBe(403);
		expect(res.json.error).toBe('insufficient_scope');
		expect(redisOps).toHaveLength(0);
	});

	it('always delivers to the caller, never to an address in the body', async () => {
		sessionUser = { id: 'user-1' };
		await post({ text: 'hi', to: 'someone-else', user_id: 'someone-else' });
		expect(redisOps[0][1]).toBe('herald:user-1:queue');
	});
});

describe('the record that lands on the queue', () => {
	beforeEach(() => {
		sessionUser = { id: 'user-1' };
	});

	it('normalises the announcement rather than echoing the body', async () => {
		const res = await post({
			text: '  Deploy   is green  ',
			importance: 88,
			url: '/dashboard',
			from: 'CI',
		});
		const queued = JSON.parse(redisOps[0][2]);
		expect(queued.text).toBe('Deploy is green');
		expect(queued.importance).toBe(88);
		expect(queued.url).toBe('/dashboard');
		expect(queued.from).toBe('CI');
		expect(queued.id).toEqual(expect.any(String));
		expect(res.json.announcement.text).toBe('Deploy is green');
	});

	it('drops a url that could execute or redirect off-site', async () => {
		await post({ text: 'click me', url: 'javascript:alert(1)' });
		expect(JSON.parse(redisOps[0][2]).url).toBeUndefined();
	});

	it('accepts `message` as an alias for `text`', async () => {
		const res = await post({ message: 'alias works' });
		expect(res.statusCode).toBe(202);
		expect(JSON.parse(redisOps[0][2]).text).toBe('alias works');
	});

	it('rejects a body with no line in it', async () => {
		const res = await post({ from: 'CI' });
		expect(res.statusCode).toBe(400);
	});

	it('caps the backlog and expires the queue', async () => {
		await post({ text: 'one' });
		const ops = redisOps.map((o) => o[0]);
		expect(ops).toEqual(['rpush', 'ltrim', 'expire']);
		const [, , ttl] = redisOps[2];
		expect(ttl).toBeLessThanOrEqual(600);
	});
});

describe('when the rail is unavailable', () => {
	beforeEach(() => {
		sessionUser = { id: 'user-1' };
	});

	it('answers 503 rather than claiming a delivery', async () => {
		redisAvailable = false;
		const res = await post({ text: 'nobody will hear this' });
		expect(res.statusCode).toBe(503);
		expect(res.json.queued).toBeUndefined();
	});

	it('answers 503 when the write itself fails', async () => {
		redisThrows = true;
		const res = await post({ text: 'write fails' });
		expect(res.statusCode).toBe(503);
	});
});

describe('rate limiting', () => {
	it('is keyed by the user, so one integration cannot spend another account budget', async () => {
		sessionUser = { id: 'user-42' };
		await post({ text: 'hello' });
		expect(heraldAnnounce).toHaveBeenCalledWith('user-42');
	});

	it('returns 429 when the bucket is empty', async () => {
		sessionUser = { id: 'user-1' };
		heraldAnnounce.mockResolvedValueOnce({
			success: false,
			limit: 60,
			remaining: 0,
			reset: Date.now() + 30_000,
		});
		const res = await post({ text: 'too much' });
		expect(res.statusCode).toBe(429);
	});
});
