import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyWorldServiceTokenMock = vi.fn();
vi.mock('../api/_lib/world-service-auth.js', () => ({
	verifyWorldServiceToken: (...a) => verifyWorldServiceTokenMock(...a),
}));

const insertNotificationMock = vi.fn();
vi.mock('../api/_lib/notify.js', () => ({
	insertNotification: (...a) => insertNotificationMock(...a),
}));

const { default: handler } = await import('../api/internal/quest-notify.js');

function mkReq({ method = 'POST', url = '/api/internal/quest-notify', headers = {}, body = null } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method, url, headers: hdrs,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._endCb?.(); });
			} else if (event === 'end') this._endCb = cb;
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200, headers: {}, body: undefined, writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(b) { this.body = b; this.writableEnded = true; },
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
	verifyWorldServiceTokenMock.mockReset().mockResolvedValue(null);
	insertNotificationMock.mockReset();
});

describe('POST /api/internal/quest-notify', () => {
	it('rejects a request with no valid world-service token', async () => {
		const req = mkReq({ body: { accountUid: ACCOUNT, mission: 'Heist' } });
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(401);
		expect(insertNotificationMock).not.toHaveBeenCalled();
	});

	it('inserts a quest_complete notification for a valid service-signed request', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const req = mkReq({
			headers: { authorization: 'Bearer faketoken' },
			body: { accountUid: ACCOUNT, mission: 'Vault heist', gold: 250, coop: true, coin: 'THREE' },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ ok: true });
		expect(insertNotificationMock).toHaveBeenCalledWith(ACCOUNT, 'quest_complete', {
			mission: 'Vault heist',
			gold: 250,
			coop: true,
			coin: 'THREE',
			link: '/play',
		});
	});

	it('rejects a malformed accountUid even with a valid service token', async () => {
		verifyWorldServiceTokenMock.mockResolvedValue({ svc: 'world' });
		const req = mkReq({
			headers: { authorization: 'Bearer faketoken' },
			body: { accountUid: 'not-a-uuid', mission: 'Heist' },
		});
		const res = mkRes();
		await handler(req, res);
		expect(res.statusCode).toBe(400);
		expect(insertNotificationMock).not.toHaveBeenCalled();
	});
});
