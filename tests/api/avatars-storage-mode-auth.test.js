// Tests for /api/avatars/:id/storage-mode auth ordering.
//
// Regression: the PUT branch used to SELECT the avatar row BEFORE checking the
// session, so an anonymous caller could distinguish "avatar exists" (403/404
// after the query) from "avatar absent" and, with the DB degraded, got a 503
// instead of a 401. The handler must authenticate (and CSRF-gate) first: an
// anonymous PUT is a 401 that never touches the DB.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: async () => null, // anonymous
	authenticateBearer: async () => null,
	extractBearer: () => null,
	hasScope: () => false,
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: async () => true }));

vi.mock('../../api/_lib/storage-mode.js', () => ({
	readStorageMode: async () => null,
	storageModeSchema: { parse: (v) => v },
	defaultStorageMode: () => ({ attestation: {} }),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/avatars.js', () => ({
	getAvatar: async () => null,
	resolveAvatarUrl: async () => ({ url: 'https://cdn.test/x.glb' }),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	r2: {},
	publicUrl: (k) => `https://cdn.test/${k}`,
	thumbnailUrl: (k) => `https://cdn.test/${k}`,
}));

import handler from '../../api/avatars/[id]/[action].js';

const ID = '11111111-1111-4111-8111-111111111111';

function makeReq(method) {
	return {
		method,
		url: `/api/avatars/${ID}/storage-mode`,
		headers: { host: 'three.ws', 'content-type': 'application/json' },
		query: { id: ID, action: 'storage-mode' },
		on() {},
	};
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(chunk) {
			if (chunk !== undefined) this.body = chunk;
			this.writableEnded = true;
		},
	};
}

describe('PUT /api/avatars/:id/storage-mode', () => {
	it('returns 401 for an anonymous caller without querying the DB', async () => {
		sqlMock.mockClear();
		const res = makeRes();
		await handler(makeReq('PUT'), res);
		expect(res.statusCode).toBe(401);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('unauthorized');
		// The avatar SELECT must not have run: no 404-vs-401 existence oracle.
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
