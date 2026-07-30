// Unit tests for the notification center's read path
// (user-value campaign, work order 04 task 4; retired, see git history):
//   GET  /api/notifications           -> api/notifications/index.js
//   POST /api/notifications/read-all  -> api/notifications/read-all.js
//
// Covers auth, the unread count the bell badge renders, the type filter and
// the `before` cursor pages/notifications.html uses for "load more", limit
// clamping, and the CSRF gate on the state-changing route.
//
// Mocks: sql (content-routed so each query branch is observable), auth, csrf,
// rate-limit. All offline, no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = { rows: [], unread: 0, marked: [] };
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			const text = strings.join(' ? ');
			sqlCalls.push({ text, values });
			if (/update user_notifications/.test(text)) return Promise.resolve(dbState.marked);
			if (/unread_count/.test(text)) return Promise.resolve([{ unread_count: dbState.unread }]);
			return Promise.resolve(dbState.rows);
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const authState = { user: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getRequestUser: vi.fn(async () => authState.user),
}));

const csrfState = { ok: true };
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfState.ok) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'forbidden' }));
		return false;
	}),
}));

const rlState = { success: true, limit: 60, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { notificationsRead: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: listHandler } = await import('../../api/notifications/index.js');
const { default: readAllHandler } = await import('../../api/notifications/read-all.js');

const USER = { id: '00000000-0000-0000-0000-0000000000b1' };

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(handler, { method = 'GET', query = {} } = {}) {
	const qs = new URLSearchParams(query).toString();
	const res = makeRes();
	const path = handler === readAllHandler ? '/api/notifications/read-all' : '/api/notifications';
	await handler({ method, headers: {}, query, url: `${path}${qs ? `?${qs}` : ''}` }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

const ROW = {
	id: 'n1', type: 'remix', payload: { actor: 'alice' },
	read_at: null, created_at: '2026-07-12T12:00:00Z',
};
const listQuery = () => sqlCalls.find((c) => /select id, type, payload/.test(c.text));

beforeEach(() => {
	sqlCalls.length = 0;
	dbState.rows = [];
	dbState.unread = 0;
	dbState.marked = [];
	authState.user = USER;
	csrfState.ok = true;
	rlState.success = true;
});

describe('GET /api/notifications', () => {
	it('401s for an anonymous caller without querying anything', async () => {
		authState.user = null;
		const { res, body } = await call(listHandler);
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlCalls).toHaveLength(0);
	});

	it('429s when the per-user read limit is exhausted', async () => {
		rlState.success = false;
		const { res } = await call(listHandler);
		expect(res.statusCode).toBe(429);
	});

	it('returns the caller rows, the unread count, and a has_more flag', async () => {
		dbState.rows = [ROW];
		dbState.unread = 3;
		const { res, body } = await call(listHandler);
		expect(res.statusCode).toBe(200);
		expect(body.notifications).toEqual([
			{ id: 'n1', type: 'remix', payload: { actor: 'alice' }, read_at: null, created_at: '2026-07-12T12:00:00Z' },
		]);
		expect(body.unread_count).toBe(3);
		expect(body.has_more).toBe(false);
	});

	it('scopes every query to the caller, so one user can never read another inbox', async () => {
		dbState.rows = [ROW];
		await call(listHandler);
		for (const c of sqlCalls) expect(c.values).toContain(USER.id);
	});

	it('flags has_more when the page came back full', async () => {
		dbState.rows = Array.from({ length: 5 }, (_, i) => ({ ...ROW, id: `n${i}` }));
		const { body } = await call(listHandler, { query: { limit: '5' } });
		expect(body.has_more).toBe(true);
	});

	it('clamps limit into 1..50 and defaults to 20', async () => {
		await call(listHandler, { query: { limit: '999' } });
		expect(listQuery().values).toContain(50);

		sqlCalls.length = 0;
		await call(listHandler, { query: { limit: '0' } });
		expect(listQuery().values).toContain(1);

		sqlCalls.length = 0;
		await call(listHandler);
		expect(listQuery().values).toContain(20);
	});

	it('applies a well-formed type filter and ignores a malformed one', async () => {
		await call(listHandler, { query: { type: 'pump_alert' } });
		expect(listQuery().text).toMatch(/type = /);
		expect(listQuery().values).toContain('pump_alert');

		sqlCalls.length = 0;
		await call(listHandler, { query: { type: 'DROP TABLE users' } });
		expect(listQuery().text).not.toMatch(/type = /);
	});

	it('pages with a valid before cursor and ignores an unparseable one', async () => {
		await call(listHandler, { query: { before: '2026-07-12T00:00:00Z' } });
		expect(listQuery().text).toMatch(/created_at < /);

		sqlCalls.length = 0;
		await call(listHandler, { query: { before: 'yesterday-ish' } });
		expect(listQuery().text).not.toMatch(/created_at < /);
	});

	it('combines the type filter and the cursor in one query', async () => {
		await call(listHandler, { query: { type: 'remix', before: '2026-07-12T00:00:00Z' } });
		expect(listQuery().text).toMatch(/type = /);
		expect(listQuery().text).toMatch(/created_at < /);
	});

	it('serves an empty inbox as a well-formed zero state', async () => {
		const { res, body } = await call(listHandler);
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ notifications: [], unread_count: 0, has_more: false });
	});
});

describe('POST /api/notifications/read-all', () => {
	it('401s for an anonymous caller', async () => {
		authState.user = null;
		const { res, body } = await call(readAllHandler, { method: 'POST' });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('rejects a GET, because the route is state-changing', async () => {
		const { res } = await call(readAllHandler);
		expect(res.statusCode).toBe(405);
	});

	it('refuses to mark anything when the CSRF check fails', async () => {
		csrfState.ok = false;
		const { res } = await call(readAllHandler, { method: 'POST' });
		expect(res.statusCode).toBe(403);
		expect(sqlCalls.filter((c) => /update user_notifications/.test(c.text))).toHaveLength(0);
	});

	it('marks the caller unread rows read and reports how many', async () => {
		dbState.marked = [{ count: 4 }, { count: 4 }, { count: 4 }, { count: 4 }];
		const { res, body } = await call(readAllHandler, { method: 'POST' });
		expect(res.statusCode).toBe(200);
		expect(body.marked_read).toBe(4);

		const [update] = sqlCalls.filter((c) => /update user_notifications/.test(c.text));
		expect(update.text).toMatch(/read_at is null/);
		expect(update.values).toContain(USER.id);
	});

	it('reports zero, not null, when there was nothing unread', async () => {
		const { body } = await call(readAllHandler, { method: 'POST' });
		expect(body.marked_read).toBe(0);
	});
});
