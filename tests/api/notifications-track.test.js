// Unit tests for the re-engagement funnel beacon:
//   POST /api/notifications/track -> api/notifications/track.js
//
// The endpoint was the one notification route with no coverage at all (api
// audit, work order api-notifications-01). It is deliberately unusual in two
// ways, and both are pinned here so a later refactor cannot quietly undo them:
//
//   1. It authenticates on the SESSION only (getSessionUser), not on a bearer
//      credential. The only callers are the service worker
//      (public/push-sw.js) and the app itself (src/notifications.js,
//      src/push-notifications.js), all of which send the session cookie.
//   2. It is CSRF-exempt on purpose: an idempotent analytics insert deduped by
//      a partial unique index, with no state a forged call could corrupt. The
//      handler therefore imports no CSRF module, and the success cases below
//      pass no token.
//
// The ownership check is the security boundary that matters here: a caller may
// only attribute an event to a notification that is their own, so the funnel
// cannot be poisoned with someone else's notification ids.
//
// Mocks: sql (content-routed so the ownership read and the insert are each
// observable), auth, rate-limit. All offline, no DATABASE_URL or Redis needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = { owns: true };
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			const text = strings.join(' ? ');
			sqlCalls.push({ text, values });
			if (/from user_notifications/.test(text)) {
				return Promise.resolve(dbState.owns ? [{ '?column?': 1 }] : []);
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
	getSessionUser: vi.fn(async () => authState.user),
}));

const rlState = { success: true, limit: 120, remaining: 0, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { notifTrack: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: trackHandler } = await import('../../api/notifications/track.js');

const USER = { id: '00000000-0000-0000-0000-0000000000c4' };
const ID = 'b8a4f0d2-9c61-4f7e-8a3d-1e5c7b2f6049';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call({ method = 'POST', body } = {}) {
	const res = makeRes();
	const req = {
		method,
		query: {},
		url: '/api/notifications/track',
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
	};
	if (body !== undefined) req.body = body;
	await trackHandler(req, res);
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch {}
	return { res, body: parsed };
}

const inserts = () => sqlCalls.filter((c) => /insert into notification_events/.test(c.text));
const ownerReads = () => sqlCalls.filter((c) => /from user_notifications/.test(c.text));

beforeEach(() => {
	sqlCalls.length = 0;
	dbState.owns = true;
	authState.user = USER;
	rlState.success = true;
});

describe('POST /api/notifications/track', () => {
	it('401s for an anonymous caller without querying anything', async () => {
		authState.user = null;
		const { res, body } = await call({ body: { channel: 'push', event: 'opened' } });
		expect(res.statusCode).toBe(401);
		expect(body.error).toBe('unauthorized');
		expect(sqlCalls).toHaveLength(0);
	});

	it('rejects a GET, because the beacon writes a row', async () => {
		const { res } = await call({ method: 'GET' });
		expect(res.statusCode).toBe(405);
		expect(res.getHeader('access-control-allow-methods')).toBe('POST,OPTIONS');
		expect(inserts()).toHaveLength(0);
	});

	it('429s when the per-user beacon limit is exhausted, before any write', async () => {
		rlState.success = false;
		const { res } = await call({ body: { notification_id: ID, channel: 'push', event: 'opened' } });
		expect(res.statusCode).toBe(429);
		expect(sqlCalls).toHaveLength(0);
	});

	// The service-worker path: a push click carries the notification id, so the
	// row is attributable end to end (sent -> opened -> returned).
	it('records an attributed event and scopes both the check and the write to the caller', async () => {
		const { res, body } = await call({
			body: { notification_id: ID, channel: 'push', event: 'opened' },
		});
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ ok: true });

		const [read] = ownerReads();
		expect(read.values).toEqual([ID, USER.id]);

		const [write] = inserts();
		expect(write.values).toEqual([ID, USER.id, 'push', 'opened']);
		// Two identical clicks across tabs must not double-count; the partial
		// unique index does the work, so the statement has to opt into it.
		expect(write.text).toMatch(/on conflict do nothing/);
	});

	it('records an unattributed event without looking up a notification', async () => {
		const { res, body } = await call({ body: { channel: 'in_app', event: 'returned' } });
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(ownerReads()).toHaveLength(0);
		const [write] = inserts();
		expect(write.values).toEqual([null, USER.id, 'in_app', 'returned']);
	});

	// The security boundary: without this the funnel could be filled with events
	// for notifications belonging to other accounts.
	it('404s a notification that is not the caller own, and writes nothing', async () => {
		dbState.owns = false;
		const { res, body } = await call({
			body: { notification_id: ID, channel: 'in_app', event: 'opened' },
		});
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(inserts()).toHaveLength(0);
	});

	it('400s a malformed body at the boundary and writes nothing', async () => {
		const bodies = [
			{ channel: 'push' },
			{ event: 'opened' },
			{ channel: 'sms', event: 'opened' },
			{ channel: 'push', event: 'delivered' },
			{ notification_id: 'not-a-uuid', channel: 'push', event: 'opened' },
			{ notification_id: null, channel: 'push', event: 'opened' },
		];
		for (const body of bodies) {
			sqlCalls.length = 0;
			const { res, body: out } = await call({ body });
			expect(res.statusCode).toBe(400);
			expect(out.error).toBe('validation_error');
			expect(sqlCalls).toHaveLength(0);
		}
	});

	it('415s a body sent without a JSON content type', async () => {
		const res = makeRes();
		await trackHandler(
			{ method: 'POST', query: {}, url: '/api/notifications/track', headers: {}, body: 'channel=push' },
			res,
		);
		expect(res.statusCode).toBe(415);
		expect(inserts()).toHaveLength(0);
	});

	it('answers a CORS preflight with the credentialed beacon contract', async () => {
		const res = makeRes();
		await trackHandler(
			{
				method: 'OPTIONS',
				query: {},
				url: '/api/notifications/track',
				headers: { origin: 'https://three.ws', 'access-control-request-method': 'POST' },
			},
			res,
		);
		expect(res.statusCode).toBe(204);
		expect(res.getHeader('access-control-allow-methods')).toBe('POST,OPTIONS');
		expect(res.getHeader('access-control-allow-credentials')).toBe('true');
	});
});
