// Unit tests for /api/audit-log — covers cursor pagination, CSV export,
// auth gating, and limit clamping. The sql tag is mocked so we can assert
// the SQL the endpoint constructs without touching a real database.

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET ||= 'test-audit-log-secret-at-least-32ch';

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		(...args) => sqlMock(...args),
		{ transaction: (...args) => sqlMock(...args) },
	),
}));

const getSessionUserMock = vi.fn();
vi.mock('../../api/_lib/auth.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, getSessionUser: (...a) => getSessionUserMock(...a) };
});

const rateLimitOk = { success: true };
const limitsMock = { auditLogRead: vi.fn(async () => rateLimitOk) };
vi.mock('../../api/_lib/rate-limit.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, limits: { ...actual.limits, ...limitsMock } };
});

const { default: handler } = await import('../../api/audit-log.js');

function makeReq(url, method = 'GET') {
	return { method, url, headers: { 'user-agent': 'vitest' }, query: {} };
}

function makeRes() {
	const headers = {};
	let body = '';
	const res = {
		statusCode: 200,
		setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
		getHeader: (k) => headers[k.toLowerCase()],
		end: (chunk) => { body = chunk; },
		_get: () => ({ status: res.statusCode, headers, body }),
	};
	return res;
}

beforeEach(() => {
	sqlMock.mockReset();
	getSessionUserMock.mockReset();
	limitsMock.auditLogRead.mockReset().mockResolvedValue(rateLimitOk);
});

describe('GET /api/audit-log', () => {
	it('returns 401 when unauthenticated', async () => {
		getSessionUserMock.mockResolvedValue(null);
		const res = makeRes();
		await handler(makeReq('/api/audit-log'), res);
		expect(res._get().status).toBe(401);
	});

	it('returns 429 when rate limited', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		limitsMock.auditLogRead.mockResolvedValueOnce({ success: false });
		const res = makeRes();
		await handler(makeReq('/api/audit-log'), res);
		expect(res._get().status).toBe(429);
	});

	it('returns paginated JSON with next_cursor when there are more rows', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		const now = new Date('2026-05-25T00:00:00.000Z');
		const rows = Array.from({ length: 3 }, (_, i) => ({
			id: `00000000-0000-0000-0000-00000000000${i}`,
			action: `act_${i}`,
			resource_id: `res_${i}`,
			meta: { i },
			ip: '1.2.3.4',
			user_agent: 'ua',
			created_at: new Date(now.getTime() - i * 1000),
		}));
		sqlMock.mockResolvedValueOnce(rows);
		const res = makeRes();
		await handler(makeReq('/api/audit-log?limit=2'), res);
		const out = JSON.parse(res._get().body);
		expect(out.items).toHaveLength(2);
		expect(out.has_more).toBe(true);
		expect(out.next_cursor).toBeTruthy();
		const decoded = Buffer.from(out.next_cursor, 'base64url').toString('utf8');
		expect(decoded).toContain('|');
	});

	it('returns no cursor when result fits within the limit', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlMock.mockResolvedValueOnce([
			{ id: 'a', action: 'login', resource_id: null, meta: null, ip: null, user_agent: null, created_at: new Date() },
		]);
		const res = makeRes();
		await handler(makeReq('/api/audit-log?limit=50'), res);
		const out = JSON.parse(res._get().body);
		expect(out.items).toHaveLength(1);
		expect(out.has_more).toBe(false);
		expect(out.next_cursor).toBeNull();
	});

	it('clamps limit to the 200 ceiling', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlMock.mockResolvedValueOnce([]);
		const res = makeRes();
		await handler(makeReq('/api/audit-log?limit=5000'), res);
		// Tag call shape: (stringsArray, ...interpolatedValues). The clamped
		// limit + 1 = 201 is the last interpolated value.
		const values = sqlMock.mock.calls[0]?.slice(1) ?? [];
		expect(values).toContain(201);
	});

	it('exports CSV with the right headers', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlMock.mockResolvedValueOnce([
			{
				action: 'login',
				resource_id: null,
				meta: { from: 'web' },
				ip: '1.2.3.4',
				user_agent: 'curl/8',
				created_at: new Date('2026-05-25T12:00:00.000Z'),
			},
			{
				action: 'set_primary_wallet',
				resource_id: '0xabc,with,comma',
				meta: null,
				ip: null,
				user_agent: null,
				created_at: new Date('2026-05-25T11:59:59.000Z'),
			},
		]);
		const res = makeRes();
		await handler(makeReq('/api/audit-log?format=csv'), res);
		const { status, headers, body } = res._get();
		expect(status).toBe(200);
		expect(headers['content-type']).toMatch(/text\/csv/);
		expect(headers['content-disposition']).toMatch(/audit-log-/);
		const lines = body.trim().split('\n');
		expect(lines[0]).toBe('when,action,resource_id,ip,user_agent,meta');
		// Comma in resource_id must be quoted
		expect(lines[2]).toMatch(/"0xabc,with,comma"/);
	});

	it('ignores garbage cursors', async () => {
		getSessionUserMock.mockResolvedValue({ id: 'u1' });
		sqlMock.mockResolvedValueOnce([]);
		const res = makeRes();
		await handler(makeReq('/api/audit-log?cursor=not-real'), res);
		// First (and only) sql call should be the unpaginated branch (no cursor placeholders)
		const text = sqlMock.mock.calls[0]?.[0]?.join?.('?') || '';
		expect(text).not.toContain('< (');
	});
});
