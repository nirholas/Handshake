import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));

const getRequestUserMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({ getRequestUser: (...a) => getRequestUserMock(...a) }));

const requireCsrfMock = vi.fn();
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

const pushSubscribeLimitMock = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { pushSubscribe: (...a) => pushSubscribeLimitMock(...a) },
}));

const { default: handler } = await import('../api/push/subscribe.js');

const USER = '28e98fb2-2a98-4500-b45a-5a9ad7b3f7a8';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-token-1';
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: 'BPXePublicKey', auth: 'authSecret' } };

function mkReq({ method = 'POST', headers = {}, body = null } = {}) {
	const hdrs = { 'content-type': 'application/json', ...headers };
	return {
		method,
		url: '/api/push/subscribe',
		headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	sqlMock.mockReset().mockResolvedValue([]);
	getRequestUserMock.mockReset().mockResolvedValue({ id: USER });
	requireCsrfMock.mockReset().mockResolvedValue(true);
	pushSubscribeLimitMock.mockReset().mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: 0 });
});

describe('POST /api/push/subscribe', () => {
	it('upserts the device endpoint for the signed-in user and returns 201', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { subscription: SUBSCRIPTION } }), res);

		expect(res.statusCode).toBe(201);
		expect(parse(res)).toEqual({ ok: true });
		expect(sqlMock).toHaveBeenCalledTimes(1);

		const [strings, ...values] = sqlMock.mock.calls[0];
		const query = strings.join(' ');
		expect(query).toContain('insert into push_subscriptions');
		// Endpoints are globally unique: a re-subscribe reclaims the row so the
		// latest owner wins instead of the insert failing on the constraint.
		expect(query).toContain('on conflict (endpoint) do update');
		expect(values.slice(0, 4)).toEqual([USER, ENDPOINT, 'BPXePublicKey', 'authSecret']);
	});

	it('rejects a subscription missing its key material with a 400 and no write', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { subscription: { endpoint: ENDPOINT } } }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses an anonymous caller before touching CSRF, the limiter, or the database', async () => {
		getRequestUserMock.mockResolvedValue(null);
		const res = mkRes();
		await handler(mkReq({ body: { subscription: SUBSCRIPTION } }), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
		expect(requireCsrfMock).not.toHaveBeenCalled();
		expect(pushSubscribeLimitMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('stops at the rate limiter once a device re-subscribes too often', async () => {
		pushSubscribeLimitMock.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await handler(mkReq({ body: { subscription: SUBSCRIPTION } }), res);

		expect(res.statusCode).toBe(429);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/push/subscribe', () => {
	it('deletes the endpoint scoped to the signed-in user', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE', body: { endpoint: ENDPOINT } }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: true });

		const [strings, ...values] = sqlMock.mock.calls[0];
		expect(strings.join(' ')).toContain('delete from push_subscriptions');
		expect(values).toEqual([USER, ENDPOINT]);
	});

	it('accepts the full subscription object in place of a bare endpoint', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE', body: { subscription: SUBSCRIPTION } }), res);

		expect(res.statusCode).toBe(200);
		expect(sqlMock.mock.calls[0].slice(1)).toEqual([USER, ENDPOINT]);
	});

	it('rejects a body that names no endpoint at all', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'DELETE', body: {} }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('/api/push/subscribe transport', () => {
	it('answers a preflight with the POST/DELETE credentialed CORS contract', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'OPTIONS', headers: { origin: 'https://three.ws' } }), res);

		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-methods']).toBe('POST,DELETE,OPTIONS');
		expect(res.headers['access-control-allow-credentials']).toBe('true');
	});

	it('rejects any other verb with a 405', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET' }), res);

		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
	});
});
