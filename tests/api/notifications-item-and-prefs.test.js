// Unit tests for the per-notification routes and the preference center:
//   POST   /api/notifications/:id/read    -> api/notifications/[id]/read.js
//   DELETE /api/notifications/:id         -> api/notifications/[id]/index.js
//   GET|PUT /api/notifications/preferences -> api/notifications/preferences.js
//
// Pins three defects found by probing the live handlers (api audit, work order
// api-notifications-01):
//   1. `:id` is a uuid column, so a non-uuid id failed the cast inside Postgres
//      and the caller got a 500 where the sibling DELETE already returned 400.
//   2. A PUT wrote the request body over the whole stored row, so the settings
//      panel (which saves the category matrix alone) wiped a connected Telegram
//      chat id on every save and silently stopped those alerts.
//   3. A malformed body was parsed leniently into `{ categories: {} }` and then
//      stored, so a typo in a client 200'd and reset every preference to default.
//
// Mocks: sql (content-routed so each write is observable), auth, csrf,
// rate-limit. All offline, no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = { deleted: [], marked: [], stored: null, pushDevices: 0 };
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			const text = strings.join(' ? ');
			sqlCalls.push({ text, values });
			if (/delete from user_notifications/.test(text)) return Promise.resolve(dbState.deleted);
			if (/update user_notifications/.test(text)) return Promise.resolve(dbState.marked);
			if (/from notification_preferences/.test(text)) {
				return Promise.resolve(dbState.stored ? [{ prefs: dbState.stored }] : []);
			}
			if (/from push_subscriptions/.test(text)) {
				return Promise.resolve([{ count: dbState.pushDevices }]);
			}
			return Promise.resolve([]);
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

const rlState = { success: true, limit: 30, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { notifPrefsWrite: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: readHandler } = await import('../../api/notifications/[id]/read.js');
const { default: deleteHandler } = await import('../../api/notifications/[id]/index.js');
const { default: prefsHandler } = await import('../../api/notifications/preferences.js');

const USER = { id: '00000000-0000-0000-0000-0000000000b1' };
const ID = '46024db6-38f1-4a4e-99a3-b5a8e2ef4b80';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(handler, { method = 'POST', query = {}, body } = {}) {
	const res = makeRes();
	const req = {
		method,
		query,
		url: '/api/notifications',
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
	};
	if (body !== undefined) req.body = body;
	await handler(req, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const writes = () => sqlCalls.filter((c) => /insert into notification_preferences/.test(c.text));
const storedWrite = () => JSON.parse(writes().at(-1).values[1]);

beforeEach(() => {
	sqlCalls.length = 0;
	dbState.deleted = [];
	dbState.marked = [];
	dbState.stored = null;
	dbState.pushDevices = 0;
	authState.user = USER;
	csrfState.ok = true;
	rlState.success = true;
});

describe('POST /api/notifications/:id/read', () => {
	it('401s for an anonymous caller without querying anything', async () => {
		authState.user = null;
		const { res, body } = await call(readHandler, { query: { id: ID } });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlCalls).toHaveLength(0);
	});

	it('rejects a GET, because the route is state-changing', async () => {
		const { res } = await call(readHandler, { method: 'GET', query: { id: ID } });
		expect(res.statusCode).toBe(405);
	});

	it('marks the caller row read and scopes the update to them', async () => {
		dbState.marked = [{ id: ID, read_at: '2026-08-14T02:08:54.547Z' }];
		const { res, body } = await call(readHandler, { query: { id: ID } });
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ id: ID, read_at: '2026-08-14T02:08:54.547Z' });
		const [update] = sqlCalls.filter((c) => /update user_notifications/.test(c.text));
		expect(update.values).toContain(USER.id);
	});

	// A non-uuid used to reach Postgres and blow up as "invalid input syntax for
	// type uuid", surfacing to the caller as an opaque 500.
	it('400s a malformed id at the boundary instead of sending it to Postgres', async () => {
		for (const id of ['not-a-uuid', '123', 'null', `${ID}x`]) {
			sqlCalls.length = 0;
			const { res, body } = await call(readHandler, { query: { id } });
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('validation_error');
			expect(sqlCalls.filter((c) => /update user_notifications/.test(c.text))).toHaveLength(0);
		}
	});

	it('404s a well-formed id that is not the caller own row', async () => {
		const { res, body } = await call(readHandler, { query: { id: ID } });
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('DELETE /api/notifications/:id', () => {
	it('401s for an anonymous caller', async () => {
		authState.user = null;
		const { res } = await call(deleteHandler, { method: 'DELETE', query: { id: ID } });
		expect(res.statusCode).toBe(401);
	});

	it('refuses to delete when the CSRF check fails', async () => {
		csrfState.ok = false;
		const { res } = await call(deleteHandler, { method: 'DELETE', query: { id: ID } });
		expect(res.statusCode).toBe(403);
		expect(sqlCalls.filter((c) => /delete from user_notifications/.test(c.text))).toHaveLength(0);
	});

	it('deletes the caller own row and reports it', async () => {
		dbState.deleted = [{ id: ID }];
		const { res, body } = await call(deleteHandler, { method: 'DELETE', query: { id: ID } });
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ ok: true, id: ID, deleted: true });
		const [del] = sqlCalls.filter((c) => /delete from user_notifications/.test(c.text));
		expect(del.values).toContain(USER.id);
	});

	it('400s a malformed id and 404s one that is not the caller own', async () => {
		const bad = await call(deleteHandler, { method: 'DELETE', query: { id: 'not-a-uuid' } });
		expect(bad.res.statusCode).toBe(400);
		const missing = await call(deleteHandler, { method: 'DELETE', query: { id: ID } });
		expect(missing.res.statusCode).toBe(404);
	});
});

describe('GET /api/notifications/preferences', () => {
	it('401s for an anonymous caller', async () => {
		authState.user = null;
		const { res } = await call(prefsHandler, { method: 'GET' });
		expect(res.statusCode).toBe(401);
	});

	it('serves the full matrix, the channel list and the push device count', async () => {
		dbState.pushDevices = 2;
		const { res, body } = await call(prefsHandler, { method: 'GET' });
		expect(res.statusCode).toBe(200);
		expect(body.channels).toEqual(['in_app', 'push', 'email', 'telegram']);
		expect(body.categories.map((c) => c.key)).toContain('social');
		expect(body.prefs.categories.social).toBeTruthy();
		expect(body.push).toEqual({ subscribed_devices: 2 });
	});
});

describe('PUT /api/notifications/preferences', () => {
	it('persists a sanitised sparse override', async () => {
		const { res } = await call(prefsHandler, {
			method: 'PUT',
			body: { categories: { social: { push: false }, nonsense: { push: true } } },
		});
		expect(res.statusCode).toBe(200);
		const written = storedWrite();
		expect(written.categories.social).toEqual({ push: false });
		expect(written.categories.nonsense).toBeUndefined();
	});

	it('429s when the per-user write limit is exhausted', async () => {
		rlState.success = false;
		const { res } = await call(prefsHandler, { method: 'PUT', body: { categories: {} } });
		expect(res.statusCode).toBe(429);
		expect(writes()).toHaveLength(0);
	});

	// The settings panel saves the category matrix and nothing else. Writing the
	// body over the stored row therefore dropped the Telegram chat id, and the
	// same panel reads that value to decide whether the telegram channel is even
	// usable, so alerts stopped with no visible cause.
	it('preserves a stored telegram chat id when the PUT sends categories only', async () => {
		dbState.stored = { categories: { alerts: { email: true } }, telegram_chat_id: '123456789' };
		await call(prefsHandler, { method: 'PUT', body: { categories: { social: { push: false } } } });
		const written = storedWrite();
		expect(written.telegram_chat_id).toBe('123456789');
		expect(written.categories.alerts).toEqual({ email: true });
		expect(written.categories.social).toEqual({ push: false });
	});

	it('merges into a category instead of replacing it', async () => {
		dbState.stored = { categories: { social: { email: true, push: true } } };
		await call(prefsHandler, { method: 'PUT', body: { categories: { social: { push: false } } } });
		expect(storedWrite().categories.social).toEqual({ email: true, push: false });
	});

	it('clears the telegram chat id when the caller sends null, and when they send an empty string', async () => {
		dbState.stored = { categories: {}, telegram_chat_id: '123456789' };
		await call(prefsHandler, { method: 'PUT', body: { telegram_chat_id: null } });
		expect(storedWrite().telegram_chat_id).toBeNull();

		await call(prefsHandler, { method: 'PUT', body: { telegram_chat_id: '' } });
		expect(storedWrite().telegram_chat_id).toBeNull();
	});

	// A lenient parse turned any malformed body into `{ categories: {} }` and
	// stored it, so one bad client field silently reset every preference.
	it('400s a malformed body and writes nothing', async () => {
		const bodies = [
			{ categories: 'garbage' },
			{ categories: { social: { push: 'yes' } } },
			{ categories: { social: 'on' } },
			{ telegram_chat_id: 'not-numeric' },
			{ telegram_chat_id: 12345 },
		];
		for (const body of bodies) {
			sqlCalls.length = 0;
			const { res, body: out } = await call(prefsHandler, { method: 'PUT', body });
			expect(res.statusCode).toBe(400);
			expect(out.error).toBe('validation_error');
			expect(writes()).toHaveLength(0);
		}
	});

	it('accepts a valid numeric telegram chat id, negative group ids included', async () => {
		for (const id of ['123456789', '-1001234567890']) {
			const { res } = await call(prefsHandler, { method: 'PUT', body: { telegram_chat_id: id } });
			expect(res.statusCode).toBe(200);
			expect(storedWrite().telegram_chat_id).toBe(id);
		}
	});
});
