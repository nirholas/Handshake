import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '../_helpers/monetization.js';

// api/onboarding/[action].js fans two actions out of one handler:
//   POST /api/onboarding/avaturn-session spends the avatar provider's quota
//   POST /api/onboarding/link-avatar repoints which body an agent wears
//
// Both are cookie-session-reachable state changes, so both must sit behind the
// double-submit CSRF check every other session mutation in api/ carries. They
// did not: a cross-site form POST rode the victim's cookie straight through.
// These cases pin the guard, plus the credential rules the two share (session
// or an avatars:write bearer, 403 rather than 401 on a scope miss) and the
// upstream-failure mapping that keeps provider internals out of the caller's
// response.

const authState = { session: null, bearer: null };
const csrfState = { rows: [] };
const dbState = { avatars: [], agents: [], updates: [] };
const rlState = { upload: true, authIp: true, avatarLink: true };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn((req) => {
		const header = req?.headers?.authorization || '';
		return header.startsWith('Bearer ') ? header.slice(7) : null;
	}),
	hasScope: vi.fn((scope, want) => String(scope || '').split(/[\s,]+/).includes(want)),
}));

// One fake `sql` tag serves both the CSRF token burn and the two onboarding
// reads, keyed off the text of the template so each call answers in its own
// shape rather than every query seeing the same rows.
vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const text = strings.join(' ? ').toLowerCase();
		if (text.includes('csrf_tokens')) {
			const [token, userId] = values;
			const idx = csrfState.rows.findIndex((r) => r.token === token && r.user_id === userId);
			if (idx === -1) return [];
			return csrfState.rows.splice(idx, 1).map((r) => ({ user_id: r.user_id }));
		}
		if (text.includes('from avatars')) {
			const [avatarId, ownerId] = values;
			return dbState.avatars.filter((a) => a.id === avatarId && a.owner_id === ownerId);
		}
		if (text.includes('from agent_identities')) {
			const [userId] = values;
			return dbState.agents.filter((a) => a.user_id === userId);
		}
		if (text.includes('update agent_identities')) {
			const [avatarId, agentId] = values;
			dbState.updates.push({ agentId, avatarId });
			return [{ id: agentId, avatar_id: avatarId, updated_at: '2026-08-14T00:00:00.000Z' }];
		}
		throw new Error(`unexpected query in test: ${text}`);
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		upload: vi.fn(async () => ({ success: rlState.upload, limit: 60, remaining: 0, reset: 0 })),
		authIp: vi.fn(async () => ({ success: rlState.authIp, limit: 60, remaining: 0, reset: 0 })),
		avatarLink: vi.fn(async () => ({ success: rlState.avatarLink, limit: 30, remaining: 0, reset: 0 })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler } = await import('../../api/onboarding/[action].js');

const USER = 'user-onboarding-1';
const AVATAR_ID = '00000000-0000-4000-8000-00000000a1a1';
const AGENT_ID = '00000000-0000-4000-8000-00000000b2b2';
const PHOTO = `data:image/jpeg;base64,${'A'.repeat(64)}`;
const PHOTOS = { frontal: PHOTO, left: PHOTO, right: PHOTO };

function withCsrf(userId = USER) {
	const token = `csrf-${csrfState.rows.length + 1}`;
	csrfState.rows.push({ token, user_id: userId });
	return { 'x-csrf-token': token };
}

function sessionReq(action, { body = {}, headers = {} } = {}) {
	return {
		method: 'POST',
		url: `/api/onboarding/${action}`,
		query: { action },
		headers: { origin: 'https://three.ws', ...headers },
		body,
	};
}

beforeEach(() => {
	authState.session = { id: USER };
	authState.bearer = null;
	csrfState.rows = [];
	dbState.avatars = [{ id: AVATAR_ID, owner_id: USER }];
	dbState.agents = [{ id: AGENT_ID, user_id: USER, avatar_id: null }];
	dbState.updates = [];
	rlState.upload = true;
	rlState.authIp = true;
	rlState.avatarLink = true;
	process.env.AVATURN_API_KEY = 'test-avaturn-key';
	process.env.AVATURN_API_URL = 'https://avaturn.test';
	// The guard under test has a non-production escape hatch; an operator's stray
	// CSRF_DISABLED=1 in the shell must not quietly turn these cases green.
	delete process.env.CSRF_DISABLED;
	vi.unstubAllGlobals();
});

afterEach(() => {
	delete process.env.AVATURN_API_KEY;
	delete process.env.AVATURN_API_URL;
	vi.unstubAllGlobals();
});

function stubUpstream(response) {
	const fetchMock = vi.fn(async () => response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function upstreamOk(payload) {
	return { ok: true, status: 200, headers: new Headers(), json: async () => payload, text: async () => JSON.stringify(payload) };
}

function upstreamFail(status, body = '', headers = {}) {
	return { ok: false, status, headers: new Headers(headers), json: async () => null, text: async () => body };
}

describe('onboarding CSRF guard', () => {
	it('rejects a cookie-session avaturn-session POST that carries no CSRF token', async () => {
		const fetchMock = stubUpstream(upstreamOk({ session_url: 'https://avaturn.test/s/1' }));
		const { status, body } = await invoke(handler, sessionReq('avaturn-session', { body: { photos: PHOTOS } }));
		expect(status).toBe(403);
		expect(body.error).toBe('csrf_missing');
		// The provider must never be called on a request that failed the guard.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a cookie-session link-avatar POST that carries no CSRF token', async () => {
		const { status, body } = await invoke(handler, sessionReq('link-avatar', { body: { avatarId: AVATAR_ID } }));
		expect(status).toBe(403);
		expect(body.error).toBe('csrf_missing');
		expect(dbState.updates).toEqual([]);
	});

	it('rejects a token minted for a different user', async () => {
		csrfState.rows.push({ token: 'someone-elses', user_id: 'user-other' });
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: { 'x-csrf-token': 'someone-elses' } }),
		);
		expect(status).toBe(403);
		expect(body.error).toBe('csrf_invalid');
		expect(dbState.updates).toEqual([]);
		// The other user's token survives for its rightful owner.
		expect(csrfState.rows).toHaveLength(1);
	});

	it('exempts bearer callers, which browsers never auto-attach', async () => {
		authState.session = null;
		authState.bearer = { userId: USER, scope: 'avatars:read avatars:write' };
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: { authorization: 'Bearer key-1' } }),
		);
		expect(status).toBe(200);
		expect(body.agent.avatar_id).toBe(AVATAR_ID);
	});
});

describe('onboarding credential rules', () => {
	it('answers 401 when neither a session nor a bearer identifies the caller', async () => {
		authState.session = null;
		const { status, body } = await invoke(handler, sessionReq('avaturn-session', { body: { photos: PHOTOS } }));
		expect(status).toBe(401);
		expect(body.error).toBe('unauthorized');
	});

	it('answers 403 insufficient_scope, not 401, for a read-only bearer', async () => {
		authState.session = null;
		authState.bearer = { userId: USER, scope: 'avatars:read' };
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: { authorization: 'Bearer key-ro' } }),
		);
		expect(status).toBe(403);
		expect(body.error).toBe('insufficient_scope');
		expect(dbState.updates).toEqual([]);
	});

	it('404s an unknown action instead of throwing', async () => {
		const { status, body } = await invoke(handler, sessionReq('bogus', { body: {} }));
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});
});

describe('avaturn-session', () => {
	it('returns the provider session url on the success path', async () => {
		const fetchMock = stubUpstream(upstreamOk({ session_url: 'https://avaturn.test/s/9', expires_at: '2026-08-14T01:00:00Z' }));
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS, body_type: 'female', avatar_type: 'v2' }, headers: withCsrf() }),
		);
		expect(status).toBe(200);
		expect(body).toEqual({ session_url: 'https://avaturn.test/s/9', expires_at: '2026-08-14T01:00:00Z' });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://avaturn.test/api/v1/sessions');
		expect(JSON.parse(init.body)).toMatchObject({ external_user_id: USER, body_type: 'female', version: 'v2' });
	});

	it('rejects a photo that is not a jpeg/png data url with a 400', async () => {
		const fetchMock = stubUpstream(upstreamOk({ session_url: 'https://avaturn.test/s/1' }));
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', {
				body: { photos: { ...PHOTOS, left: 'https://example.com/left.jpg' } },
				headers: withCsrf(),
			}),
		);
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('answers 501 without charging the caller’s upload budget when the key is unset', async () => {
		delete process.env.AVATURN_API_KEY;
		const { limits } = await import('../../api/_lib/rate-limit.js');
		limits.upload.mockClear();
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS }, headers: withCsrf() }),
		);
		expect(status).toBe(501);
		expect(body.error).toBe('not_configured');
		expect(limits.upload).not.toHaveBeenCalled();
	});

	it('maps a provider 5xx to a 502 that carries none of the provider’s text', async () => {
		stubUpstream(upstreamFail(500, 'avaturn internal: key sk-live-abc rejected by shard 3'));
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS }, headers: withCsrf() }),
		);
		expect(status).toBe(502);
		expect(body.error).toBe('upstream_error');
		expect(body.error_description).not.toContain('sk-live-abc');
	});

	it('passes a provider 400 through as a caller-fixable 400', async () => {
		stubUpstream(upstreamFail(400, 'no face detected in the frontal photo'));
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS }, headers: withCsrf() }),
		);
		expect(status).toBe(400);
		expect(body.error).toBe('upstream_rejected');
		expect(body.error_description).toContain('no face detected');
	});

	it('surfaces a provider 429 as upstream_busy with a retry-after', async () => {
		stubUpstream(upstreamFail(429, 'slow down', { 'retry-after': '45' }));
		const { res, status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS }, headers: withCsrf() }),
		);
		expect(status).toBe(429);
		expect(body.error).toBe('upstream_busy');
		expect(res.headers['retry-after']).toBe('45');
	});

	it('502s a provider response that carries no session url', async () => {
		stubUpstream(upstreamOk({ ok: true }));
		const { status, body } = await invoke(
			handler,
			sessionReq('avaturn-session', { body: { photos: PHOTOS }, headers: withCsrf() }),
		);
		expect(status).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});

describe('link-avatar', () => {
	it('links the avatar to the caller’s first agent identity', async () => {
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: withCsrf() }),
		);
		expect(status).toBe(200);
		expect(body.agent).toMatchObject({ id: AGENT_ID, avatar_id: AVATAR_ID });
		expect(dbState.updates).toEqual([{ agentId: AGENT_ID, avatarId: AVATAR_ID }]);
	});

	it('404s an avatar owned by someone else', async () => {
		dbState.avatars = [{ id: AVATAR_ID, owner_id: 'user-other' }];
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: withCsrf() }),
		);
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
		expect(dbState.updates).toEqual([]);
	});

	it('409s when the agent already wears a different avatar and force is absent', async () => {
		const other = '00000000-0000-4000-8000-00000000c3c3';
		dbState.agents = [{ id: AGENT_ID, user_id: USER, avatar_id: other }];
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: withCsrf() }),
		);
		expect(status).toBe(409);
		expect(body.error).toBe('already_linked');
		expect(body.current_avatar_id).toBe(other);
		expect(dbState.updates).toEqual([]);
	});

	it('overrides an existing link when force is set', async () => {
		dbState.agents = [{ id: AGENT_ID, user_id: USER, avatar_id: '00000000-0000-4000-8000-00000000c3c3' }];
		const { status } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID, force: true }, headers: withCsrf() }),
		);
		expect(status).toBe(200);
		expect(dbState.updates).toEqual([{ agentId: AGENT_ID, avatarId: AVATAR_ID }]);
	});

	it('400s a non-uuid avatarId before touching the database', async () => {
		const { status, body } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: 'not-a-uuid' }, headers: withCsrf() }),
		);
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(dbState.updates).toEqual([]);
	});

	it('429s when the per-user link limiter is exhausted', async () => {
		rlState.avatarLink = false;
		const { status } = await invoke(
			handler,
			sessionReq('link-avatar', { body: { avatarId: AVATAR_ID }, headers: withCsrf() }),
		);
		expect(status).toBe(429);
		expect(dbState.updates).toEqual([]);
	});
});
