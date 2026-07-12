// GET/POST /api/me — onboarding-tour state (creations aggregation +
// seen/completed flags). Covers: show_onboarding_tour is true only for a
// zero-creation account that has never been offered the tour, false once any
// creation surface has a row or the tour was already offered; POST records
// seen/completed timestamps and rejects an invalid flag.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));
vi.mock('../api/_lib/r2.js', () => ({ thumbnailUrl: (key) => (key ? `https://cdn.three.ws/${key}` : null) }));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000' } }));

const { default: meHandler } = await import('../api/me.js');

function mkReq({ method = 'GET', url = '/api/me', body = null } = {}) {
	const headers = { origin: 'http://localhost:3000' };
	if (body != null) headers['content-type'] = 'application/json';
	return {
		method,
		url,
		headers,
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
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

let sqlQueue = [];
beforeEach(() => {
	sqlQueue = [];
	sqlMock.mockReset().mockImplementation(() => Promise.resolve(sqlQueue.length ? sqlQueue.shift() : []));
	getSessionUserMock.mockReset().mockResolvedValue({ id: 'user-1' });
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
});

describe('GET /api/me', () => {
	it('requires auth', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const req = mkReq();
		const res = mkRes();
		await meHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('offers the onboarding tour for a brand-new account with zero creations and no seen flag', async () => {
		sqlQueue.push([
			{
				id: 'user-1',
				username: 'newbie',
				display_name: 'Newbie',
				created_at: '2026-07-12T00:00:00Z',
				onboarding_tour_seen_at: null,
				onboarding_tour_completed_at: null,
				thumbnail_key: null,
				avatars_count: 0,
				agents_count: 0,
				forge_count: 0,
				diorama_count: 0,
			},
		]);
		const req = mkReq();
		const res = mkRes();
		await meHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.user.creations_count).toBe(0);
		expect(body.user.show_onboarding_tour).toBe(true);
	});

	it('does not offer the tour once the account has any creation', async () => {
		sqlQueue.push([
			{
				id: 'user-1',
				username: 'maker',
				display_name: 'Maker',
				created_at: '2026-07-12T00:00:00Z',
				onboarding_tour_seen_at: null,
				onboarding_tour_completed_at: null,
				thumbnail_key: null,
				avatars_count: 1,
				agents_count: 0,
				forge_count: 0,
				diorama_count: 0,
			},
		]);
		const req = mkReq();
		const res = mkRes();
		await meHandler(req, res);
		const body = parse(res);
		expect(body.user.creations_count).toBe(1);
		expect(body.user.show_onboarding_tour).toBe(false);
	});

	it('does not re-offer the tour once already seen, even with zero creations', async () => {
		sqlQueue.push([
			{
				id: 'user-1',
				username: 'dismissed',
				display_name: 'Dismissed',
				created_at: '2026-07-12T00:00:00Z',
				onboarding_tour_seen_at: '2026-07-11T00:00:00Z',
				onboarding_tour_completed_at: null,
				thumbnail_key: null,
				avatars_count: 0,
				agents_count: 0,
				forge_count: 0,
				diorama_count: 0,
			},
		]);
		const req = mkReq();
		const res = mkRes();
		await meHandler(req, res);
		const body = parse(res);
		expect(body.user.show_onboarding_tour).toBe(false);
	});
});

describe('POST /api/me', () => {
	it('rejects an invalid onboarding_tour flag', async () => {
		const req = mkReq({ method: 'POST', body: { onboarding_tour: 'nope' } });
		const res = mkRes();
		await meHandler(req, res);
		expect(res.statusCode).toBe(400);
	});

	it('records the seen timestamp', async () => {
		sqlQueue.push([{ onboarding_tour_seen_at: '2026-07-12T00:00:00Z', onboarding_tour_completed_at: null }]);
		const req = mkReq({ method: 'POST', body: { onboarding_tour: 'seen' } });
		const res = mkRes();
		await meHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.onboarding_tour_seen_at).toBeTruthy();
		expect(body.onboarding_tour_completed_at).toBeNull();
	});

	it('records the completed timestamp', async () => {
		sqlQueue.push([{ onboarding_tour_seen_at: '2026-07-12T00:00:00Z', onboarding_tour_completed_at: '2026-07-12T00:10:00Z' }]);
		const req = mkReq({ method: 'POST', body: { onboarding_tour: 'completed' } });
		const res = mkRes();
		await meHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.onboarding_tour_completed_at).toBeTruthy();
	});
});
