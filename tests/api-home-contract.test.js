// The /api/home/* wire contract, proved without a house.
//
// tests/api-home.test.js drives these same handlers against a real database and
// (when one is available) a real Home Assistant. That suite proves the doors are
// hung. This one proves what comes back through them: the status code, the error
// code, and the exact shape of the body a client and a language model both have
// to branch on. It runs on every `npm test` with nothing installed, because the
// properties below are the ones that must never regress quietly and a suite that
// needs Docker to notice is a suite that will not notice.
//
// Three of these are load bearing enough to have their own test rather than
// riding along inside a larger one:
//
//   1. A guarded action with no explicit yes is 409 with `pending`. Never 403,
//      which every HTTP client treats as terminal, so "ask the user" becomes
//      "give up". Never 200 with an error field, which a language model reads as
//      SUCCESS, which is how an agent talks itself into unlocking a door.
//   2. `confirmed` is a strict `=== true`. The string "true" is what a form field
//      and a lax serializer produce, it is truthy in JavaScript, and it must not
//      open a lock.
//   3. The graph is never emptied on a disconnect. The user watches their home go
//      grey; they do not watch it vanish.
//
// The store, the runtime, auth, CSRF and the limiter are the impure edges and
// are mocked. Nothing here mocks Home Assistant itself: there is no fake house,
// only a bridge stub standing in for the pool's handle, and the gate it enforces
// is the real `classifyCall` semantics reproduced in one place.

// The HTTP boundary reads JWT_SECRET lazily on its first error response, and a
// developer box has no session secret in .env. Every auth edge is mocked below,
// so this is scaffolding for the error path, not a credential.
process.env.JWT_SECRET ||= 'api-home-contract-suite-secret';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeBridgeError } from '../packages/home-bridge/src/errors.js';

// ── mocked edges ─────────────────────────────────────────────────────────────

const store = {
	getConnection: vi.fn(),
	listConnections: vi.fn(),
	revokeConnection: vi.fn(),
	listGrants: vi.fn(),
	grantEntity: vi.fn(),
	revokeGrant: vi.fn(),
	listAllowedEntities: vi.fn(),
	listHomeActions: vi.fn(),
	logHomeAction: vi.fn(),
	HOME_STATUS: { PENDING: 'pending', CONNECTED: 'connected', UNREACHABLE: 'unreachable', AUTH_FAILED: 'auth_failed', REVOKED: 'revoked' },
};
vi.mock('../api/_lib/home/store.js', () => store);

const runtime = {
	acquire: vi.fn(),
	withHome: vi.fn(),
	snapshot: vi.fn(),
	subscribe: vi.fn(),
	closeHome: vi.fn(),
	closeAll: vi.fn(),
	evictIdle: vi.fn(),
	streamCount: vi.fn(() => 0),
	stats: vi.fn(() => ({ open: 0, subscribers: 0, byStatus: {} })),
	HOME_RUNTIME_ERR: { NOT_FOUND: 'home_not_found', REVOKED: 'home_revoked', BREAKER_OPEN: 'home_breaker_open' },
};
vi.mock('../api/_lib/home/runtime.js', () => runtime);

const sessionUser = vi.fn();
const bearerUser = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => sessionUser(...a),
	authenticateBearer: (...a) => bearerUser(...a),
	extractBearer: (req) => {
		const h = req.headers?.authorization || '';
		return h.startsWith('Bearer ') ? h.slice(7) : null;
	},
}));

const csrfOk = vi.fn();
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => csrfOk(...a) }));

const allow = () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60_000 });
const deny = () => ({ success: false, limit: 40, remaining: 0, reset: Date.now() + 300_000 });
const buckets = { homeRead: vi.fn(allow), homeAct: vi.fn(allow), homeConnect: vi.fn(allow), homeStream: vi.fn(allow) };
vi.mock('../api/_lib/rate-limit.js', () => ({ limits: buckets, clientIp: () => '127.0.0.1' }));

vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn(), logAuditNow: vi.fn() }));

// The plan tier (order 19) caps concurrent streams and connected homes. This
// suite is about the wire contract, not about pricing: give every caller room
// and let tests/home-entitlements.test.js own the ceilings.
class FakeQuotaError extends Error {
	constructor(quota) { super('quota'); this.quota = quota; }
}
vi.mock('../api/_lib/home/entitlements.js', () => ({
	HomeQuotaError: FakeQuotaError,
	HomePausedError: class HomePausedError extends Error {},
	resolveHomeEntitlementsForUser: vi.fn(async () => ({ tier: 'test', limits: {} })),
	resolveHomeEntitlements: vi.fn(async () => ({ tier: 'test', limits: {} })),
	assertWithinLimit: vi.fn(),
	assertHomeActionAllowed: vi.fn(),
}));

// ── the routes under test ────────────────────────────────────────────────────

const { default: homeById } = await import('../api/home/[id].js');
const { default: homeCall } = await import('../api/home/[id]/call.js');
const { default: homeActivate } = await import('../api/home/[id]/activate.js');
const { default: homeGrants } = await import('../api/home/[id]/grants.js');
const { default: homeLog } = await import('../api/home/[id]/log.js');
const { default: homeMacros } = await import('../api/home/[id]/macros.js');
const { default: homeStream } = await import('../api/home/[id]/stream.js');
const { toHomeFailure } = await import('../api/_lib/home/errors.js');

// ── harness ──────────────────────────────────────────────────────────────────

const HOME_ID = '3b486106-d451-447a-8183-6b269f975877';
const USER_A = '3d56faa6-5a06-4054-a9ae-7a39276134b5';

const HOME_ROW = {
	id: HOME_ID,
	user_id: USER_A,
	label: 'Order 03 house',
	base_url: 'https://home.example.com',
	transport: 'direct',
	relay_id: null,
	status: 'connected',
	status_detail: null,
	capabilities: { websocket: true, entityCount: 124, mcp: false },
	last_ok_at: null,
	last_error_at: null,
	created_at: '2026-09-03T00:00:00.000Z',
	updated_at: '2026-09-03T00:00:00.000Z',
	revoked_at: null,
	// The store's ownership-filtered read carries the caller's household role and
	// scope on the row (api/_lib/home/members.js), and `resolveHomeAccess` gates
	// every route on it. The owner is what these tests are about; the role matrix
	// itself is proved in tests/home-roles.test.js.
	role: 'owner',
	entity_scope: null,
};

function mkReq({ method = 'GET', url = '/api/home', headers = {}, body = null, query = {} } = {}) {
	return {
		method,
		url,
		query,
		headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => { cb(buf); this._end?.(); });
			} else if (event === 'end') {
				if (body == null) queueMicrotask(() => cb());
				else this._end = cb;
			}
		},
		destroy() {},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		chunks: [],
		body: undefined,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		writeHead(code, hdrs = {}) {
			this.statusCode = code;
			for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v;
		},
		write(chunk) { this.chunks.push(String(chunk)); return true; },
		on() {},
		end(b) { if (b != null) this.body = b; this.writableEnded = true; },
	};
}

const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

/**
 * A stand-in for the pool's handle. The gate lives inside `call`, exactly where
 * the real bridge puts it, so a route cannot pass this suite by re-implementing
 * the decision itself.
 */
function mkBridge({ guarded = ['lock.front_door'], allowed = [] } = {}) {
	const allowList = new Set(allowed);
	return {
		states: { 'lock.front_door': { state: 'locked', attributes: {} } },
		graph: { floors: [], rooms: [], unassigned: [] },
		allowList: {
			has: (id) => allowList.has(id),
			add: (id) => allowList.add(id),
			remove: (id) => allowList.delete(id),
			list: () => [...allowList],
		},
		macros: () => [{ entityId: 'scene.good_night', name: 'Good Night', kind: 'scene' }],
		call: vi.fn(async (domain, service, data, options = {}) => {
			const entityId = data?.entity_id;
			if (guarded.includes(entityId) && !options.confirmed && !allowList.has(entityId)) {
				const err = new HomeBridgeError('needs_confirmation', `"${service}" on ${entityId} cannot be safely undone remotely.`);
				err.pending = { domain, service, data, risk: 'security', entityId };
				throw err;
			}
			return { context: { id: 'ctx' } };
		}),
		activate: vi.fn(async (phrase, options = {}) => {
			if (!/night/i.test(phrase)) return { ran: false, match: null };
			return { ran: !options.dryRun, match: { entityId: 'scene.good_night', name: 'Good Night', kind: 'scene', macro: 'good_night' } };
		}),
	};
}

function checkout(bridge) {
	const release = vi.fn();
	runtime.acquire.mockResolvedValue({ bridge, release, entry: { subscribers: new Set() } });
	return release;
}

const callBody = (entityId, extra = {}) => ({ domain: 'lock', service: 'unlock', data: { entity_id: entityId }, ...extra });

beforeEach(() => {
	vi.clearAllMocks();
	for (const b of Object.values(buckets)) b.mockImplementation(allow);
	sessionUser.mockResolvedValue({ id: USER_A });
	bearerUser.mockResolvedValue(null);
	csrfOk.mockResolvedValue(true);
	store.getConnection.mockResolvedValue(HOME_ROW);
	store.listConnections.mockResolvedValue([HOME_ROW]);
	store.listAllowedEntities.mockResolvedValue([]);
	store.listGrants.mockResolvedValue([]);
	store.listHomeActions.mockResolvedValue([]);
	runtime.snapshot.mockResolvedValue({ graph: { rooms: [] }, stale: false, connected: true, status: 'connected' });
});

// ── the error table ──────────────────────────────────────────────────────────

describe('the error contract', () => {
	it('maps every published code to the documented status', () => {
		const table = {
			bad_url: 400,
			auth: 400,
			validation_error: 400,
			unauthorized: 401,
			not_found: 404,
			needs_confirmation: 409,
			unreachable: 502,
			call_failed: 502,
			not_connected: 503,
		};
		for (const [code, status] of Object.entries(table)) {
			expect(toHomeFailure(new HomeBridgeError(code, 'x')), code).toMatchObject({ code, status });
		}
	});

	it('collapses the runtime codes onto the published ones, keeping the precise one for a log', () => {
		expect(toHomeFailure(new HomeBridgeError('home_not_found', 'x'))).toMatchObject({ status: 404, code: 'not_found', detailCode: 'home_not_found' });
		expect(toHomeFailure(new HomeBridgeError('home_breaker_open', 'x'))).toMatchObject({ status: 503, code: 'not_connected', detailCode: 'home_breaker_open' });
		expect(toHomeFailure(new HomeBridgeError('home_revoked', 'x'))).toMatchObject({ status: 400, code: 'auth', detailCode: 'home_revoked' });
	});

	it('never echoes an unknown throwable back to the caller', () => {
		const leaky = new Error('connect ECONNREFUSED, token abc123, https://user:pw@host/');
		const shaped = toHomeFailure(leaky);
		expect(shaped.unexpected).toBe(true);
		expect(shaped.message).not.toContain('abc123');
		expect(shaped.message).not.toContain('user:pw');
	});

	it('carries the code twice, so the platform envelope and the home client both read it', async () => {
		checkout(mkBridge());
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door') }), res);
		const body = parse(res);
		expect(body.error).toBe('needs_confirmation');
		expect(body.code).toBe('needs_confirmation');
		expect(body.error_description).toBe(body.message);
	});
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('POST /api/home/:id/call, the gate', () => {
	it('runs an unguarded call and logs it', async () => {
		const release = checkout(mkBridge());
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.bed_light' } } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ok: true, action: 'light.turn_on', guarded: false });
		expect(release).toHaveBeenCalled();
		expect(store.logHomeAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'light.turn_on', outcome: 'ok', guarded: false }));
	});

	it('refuses a guarded call with 409 and a pending naming the RESOLVED entity', async () => {
		checkout(mkBridge());
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door') }), res);
		expect(res.statusCode).toBe(409);
		expect(parse(res).pending).toMatchObject({ domain: 'lock', service: 'unlock', entityId: 'lock.front_door', risk: 'security' });
	});

	it('writes the refusal to the action log, which is the row that proves the gate held', async () => {
		checkout(mkBridge());
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door') }), mkRes());
		expect(store.logHomeAction).toHaveBeenCalledWith(expect.objectContaining({
			action: 'lock.unlock', outcome: 'refused', guarded: true, risk: 'security', entityIds: ['lock.front_door'],
		}));
	});

	it('runs the same call when a person confirms it, and records who', async () => {
		checkout(mkBridge());
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door', { confirmed: true }) }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ok: true, guarded: true, confirmed: true, risk: 'security' });
		expect(store.logHomeAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', confirmedBy: USER_A }));
	});

	// The one that matters most: every value here is truthy in JavaScript.
	it.each([['true'], ['false'], ['1'], [1], [{}], [[]], ['yes']])('does NOT accept %o as a human saying yes', async (value) => {
		checkout(mkBridge());
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door', { confirmed: value }) }), res);
		expect(res.statusCode).toBe(409);
	});

	it('honours a standing grant for that entity, and only that entity', async () => {
		store.listAllowedEntities.mockResolvedValue(['lock.kitchen_door']);
		checkout(mkBridge({ guarded: ['lock.front_door', 'lock.kitchen_door'] }));

		const granted = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.kitchen_door') }), granted);
		expect(granted.statusCode).toBe(200);
		// Cleared by a standing allowance, not by a person: the log has to say so.
		expect(store.logHomeAction).toHaveBeenCalledWith(expect.objectContaining({
			outcome: 'ok', confirmedBy: null, detail: expect.objectContaining({ allowed_by_grant: true }),
		}));

		const notGranted = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.front_door') }), notGranted);
		expect(notGranted.statusCode).toBe(409);
	});

	it('applies a WITHDRAWN grant to a socket that was pooled while it was live', async () => {
		// The bridge opened with the grant in its allow list; the store no longer
		// has it. Withdrawal must propagate as fast as grant does, or a pooled
		// socket is a door that opens after the owner took the key back.
		store.listAllowedEntities.mockResolvedValue([]);
		checkout(mkBridge({ guarded: ['lock.kitchen_door'], allowed: ['lock.kitchen_door'] }));
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: callBody('lock.kitchen_door') }), res);
		expect(res.statusCode).toBe(409);
	});

	it('releases the pooled reference even when the call throws', async () => {
		const bridge = mkBridge();
		bridge.call = vi.fn(async () => { throw new HomeBridgeError('call_failed', 'no such service'); });
		const release = checkout(bridge);
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { domain: 'light', service: 'nope', data: {} } }), res);
		expect(res.statusCode).toBe(502);
		expect(release).toHaveBeenCalled();
	});

	it('rejects a domain or service that is not a Home Assistant name', async () => {
		checkout(mkBridge());
		for (const bad of [{ domain: '../../etc', service: 'turn_on' }, { domain: 'light', service: 'turn on' }, { domain: '', service: '' }]) {
			const res = mkRes();
			await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: bad }), res);
			expect(res.statusCode, JSON.stringify(bad)).toBe(400);
		}
	});

	it('answers a spent act bucket with a designed 429 and a retry-after', async () => {
		buckets.homeAct.mockImplementation(deny);
		const res = mkRes();
		await homeCall(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { domain: 'light', service: 'turn_on', data: {} } }), res);
		expect(res.statusCode).toBe(429);
		expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
		expect(parse(res).retry_after).toBeGreaterThan(0);
		// Nothing reaches the house once the bucket is spent.
		expect(runtime.acquire).not.toHaveBeenCalled();
	});

	it('meters an agent principal separately in the log', async () => {
		sessionUser.mockResolvedValue(null);
		bearerUser.mockResolvedValue({ userId: USER_A, scope: 'home' });
		checkout(mkBridge());
		await homeCall(mkReq({
			method: 'POST', query: { id: HOME_ID }, headers: { authorization: 'Bearer tok' },
			body: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.bed_light' } },
		}), mkRes());
		expect(store.logHomeAction).toHaveBeenCalledWith(expect.objectContaining({ actor: 'agent' }));
	});
});

describe('POST /api/home/:id/activate', () => {
	it('resolves a phrase without running it under dryRun, and logs nothing', async () => {
		checkout(mkBridge());
		const res = mkRes();
		await homeActivate(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { phrase: 'good night', dryRun: true } }), res);
		expect(parse(res)).toMatchObject({ ran: false, dry_run: true, match: { entity_id: 'scene.good_night' } });
		expect(store.logHomeAction).not.toHaveBeenCalled();
	});

	it('meters a dry run as a read and a real activation as an act', async () => {
		checkout(mkBridge());
		await homeActivate(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { phrase: 'good night', dryRun: true } }), mkRes());
		expect(buckets.homeRead).toHaveBeenCalled();
		expect(buckets.homeAct).not.toHaveBeenCalled();
	});

	it('answers 200 with match:null, plus what the house does have, when nothing matches', async () => {
		checkout(mkBridge());
		const res = mkRes();
		await homeActivate(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { phrase: 'launch the submarine' } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ ran: false, match: null });
		expect(parse(res).macros).toHaveLength(1);
	});

	it('requires a phrase', async () => {
		const res = mkRes();
		await homeActivate(mkReq({ method: 'POST', query: { id: HOME_ID }, body: {} }), res);
		expect(res.statusCode).toBe(400);
	});
});

// ── grants ───────────────────────────────────────────────────────────────────

describe('/api/home/:id/grants', () => {
	it('refuses a domain-shaped grant', async () => {
		const res = mkRes();
		await homeGrants(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { entity_id: 'lock' } }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).message).toMatch(/per entity, never per domain/);
		expect(store.grantEntity).not.toHaveBeenCalled();
	});

	it('refuses an expiry in the past, one more than a year out, and a non-date', async () => {
		for (const when of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 400 * 864e5).toISOString(), 'not a date']) {
			const res = mkRes();
			await homeGrants(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { entity_id: 'lock.office_door', expires_at: when } }), res);
			expect(res.statusCode, when).toBe(400);
		}
	});

	it('accepts a bounded grant', async () => {
		const expires = new Date(Date.now() + 3600_000).toISOString();
		store.grantEntity.mockResolvedValue({ id: 'g1', entity_id: 'lock.office_door', granted_by: USER_A, expires_at: expires, created_at: expires });
		const res = mkRes();
		await homeGrants(mkReq({ method: 'POST', query: { id: HOME_ID }, body: { entity_id: 'lock.office_door', expires_at: expires } }), res);
		expect(res.statusCode).toBe(201);
		expect(store.grantEntity).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'lock.office_door', grantedBy: USER_A }));
	});

	it('withdraws by path segment, idempotently', async () => {
		store.revokeGrant.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const first = mkRes();
		await homeGrants(mkReq({ method: 'DELETE', query: { id: HOME_ID, entityId: 'lock.office_door' } }), first);
		expect(parse(first)).toMatchObject({ revoked: true, changed: true });

		const second = mkRes();
		await homeGrants(mkReq({ method: 'DELETE', query: { id: HOME_ID, entityId: 'lock.office_door' } }), second);
		expect(second.statusCode).toBe(200);
		expect(parse(second)).toMatchObject({ revoked: true, changed: false });
	});

	it('accepts entity_id as a query parameter, for ids a path segment cannot carry', async () => {
		// A script named "js" is `script.js`, and a path segment ending in .js is
		// stripped by the same rule that maps /api/foo.js onto api/foo.js.
		store.revokeGrant.mockResolvedValue(true);
		const res = mkRes();
		await homeGrants(mkReq({ method: 'DELETE', url: `/api/home/${HOME_ID}/grants?entity_id=script.js`, query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(200);
		expect(store.revokeGrant).toHaveBeenCalledWith({ homeId: HOME_ID, entityId: 'script.js' });
	});
});

// ── reads ────────────────────────────────────────────────────────────────────

describe('GET /api/home/:id', () => {
	it('returns the record and the graph when the house answers', async () => {
		runtime.snapshot.mockResolvedValue({ graph: { rooms: [{ id: 'kitchen' }] }, stale: false, connected: true, status: 'connected' });
		const res = mkRes();
		await homeById(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toMatchObject({ connected: true, stale: false, error: null });
	});

	it('still answers 200 with the record when the house is unreachable', async () => {
		// Somebody opening their home page while the router reboots must see the
		// home and the reason, not an error page.
		runtime.snapshot.mockRejectedValue(new HomeBridgeError('unreachable', 'did not answer'));
		const res = mkRes();
		await homeById(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(200);
		expect(parse(res).graph).toBeNull();
		expect(parse(res).stale).toBe(true);
		expect(parse(res).error).toMatchObject({ code: 'unreachable' });
	});

	it('never returns a credential column', async () => {
		const res = mkRes();
		await homeById(mkReq({ query: { id: HOME_ID } }), res);
		expect(JSON.stringify(parse(res))).not.toMatch(/access_token|token_fingerprint/);
	});

	it('revokes, drops the already-authenticated socket, and is idempotent', async () => {
		store.revokeConnection.mockResolvedValueOnce({ revoked: true, alreadyRevoked: false, home: { ...HOME_ROW, revoked_at: 'now' } });
		const first = mkRes();
		await homeById(mkReq({ method: 'DELETE', query: { id: HOME_ID } }), first);
		expect(parse(first)).toMatchObject({ revoked: true, changed: true });
		// The credential is gone; a socket opened a minute ago is still authenticated.
		expect(runtime.closeHome).toHaveBeenCalledWith(HOME_ID);

		store.revokeConnection.mockResolvedValueOnce({ revoked: false, alreadyRevoked: true, home: HOME_ROW });
		const second = mkRes();
		await homeById(mkReq({ method: 'DELETE', query: { id: HOME_ID } }), second);
		expect(second.statusCode).toBe(200);
		expect(parse(second)).toMatchObject({ revoked: true, changed: false });
	});
});

describe('GET /api/home/:id/log', () => {
	it('pages on created_at rather than an offset', async () => {
		const rows = Array.from({ length: 26 }, (_, i) => ({
			id: i, actor: 'user', channel: 'websocket', action: 'light.turn_on', entity_ids: [],
			guarded: false, confirmed_by: null, risk: null, outcome: 'ok', detail: null,
			created_at: new Date(Date.now() - i * 1000).toISOString(),
		}));
		store.listHomeActions.mockResolvedValue(rows);
		const res = mkRes();
		await homeLog(mkReq({ url: `/api/home/${HOME_ID}/log?limit=25`, query: { id: HOME_ID } }), res);
		expect(parse(res).actions).toHaveLength(25);
		expect(parse(res).next_before).toBeTruthy();
		// One extra row answers "is there more" without a count over a growing table.
		expect(store.listHomeActions).toHaveBeenCalledWith(HOME_ID, expect.objectContaining({ limit: 26 }));
	});

	it('rejects a malformed cursor', async () => {
		const res = mkRes();
		await homeLog(mkReq({ url: `/api/home/${HOME_ID}/log?before=nonsense`, query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(400);
	});

	it('refuses a bearer caller: acting is not the same permission as reading the history', async () => {
		sessionUser.mockResolvedValue(null);
		bearerUser.mockResolvedValue({ userId: USER_A, scope: 'home' });
		const res = mkRes();
		await homeLog(mkReq({ query: { id: HOME_ID }, headers: { authorization: 'Bearer tok' } }), res);
		expect(res.statusCode).toBe(403);
	});
});

describe('GET /api/home/:id/macros', () => {
	it('annotates the canonical macros with what this house actually has', async () => {
		runtime.withHome.mockImplementation(async (_id, _uid, fn) => fn(mkBridge()));
		const res = mkRes();
		await homeMacros(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(200);
		const body = parse(res);
		expect(body.macros).toEqual([{ entity_id: 'scene.good_night', name: 'Good Night', kind: 'scene' }]);
		expect(body.canonical.find((m) => m.id === 'good_night').match).toMatchObject({ entity_id: 'scene.good_night' });
		// A macro this house has no scene for is null, not a guess.
		expect(body.canonical.find((m) => m.id === 'movie').match).toBeNull();
	});
});

// ── the stream ───────────────────────────────────────────────────────────────

describe('GET /api/home/:id/stream', () => {
	/** The runtime's subscribe contract: fired once immediately, then on change. */
	function wireSubscribe() {
		let listener = null;
		const unsubscribe = vi.fn();
		// The handler compares graphs by IDENTITY, so a test that wants to say
		// "nothing changed" has to hand back the same object the runtime sent, not
		// the serialized copy that came out the other end.
		const graph = { floors: [], rooms: [{ id: 'kitchen', name: 'Kitchen', entities: [] }], unassigned: [] };
		runtime.subscribe.mockImplementation(async (_id, _uid, fn) => {
			listener = fn;
			fn({ graph, stale: false, connected: true, status: 'connected' });
			return unsubscribe;
		});
		return { push: (event) => listener(event), unsubscribe, graph };
	}

	const frames = (res) => res.chunks.join('').split('\n\n').filter(Boolean);
	const named = (res, name) => frames(res).filter((f) => f.startsWith(`event: ${name}`));
	const data = (frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6));

	it('paints immediately: status and graph before anything in the house changes', async () => {
		wireSubscribe();
		const res = mkRes();
		await homeStream(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(200);
		expect(named(res, 'status')).toHaveLength(1);
		expect(named(res, 'graph')).toHaveLength(1);
		expect(data(named(res, 'graph')[0]).graph.rooms).toHaveLength(1);
	});

	it('sets the headers that stop a CDN buffering the stream to death', async () => {
		wireSubscribe();
		const res = mkRes();
		await homeStream(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.headers['content-type']).toMatch(/text\/event-stream/);
		expect(res.headers['cache-control']).toMatch(/no-store/);
		expect(res.headers['x-accel-buffering']).toBe('no');
	});

	it('emits status only when connectivity changed, and graph only on a new graph', async () => {
		const { push, graph } = wireSubscribe();
		const res = mkRes();
		await homeStream(mkReq({ query: { id: HOME_ID } }), res);

		push({ graph, stale: false, connected: true, status: 'connected' });
		expect(named(res, 'graph')).toHaveLength(1);
		expect(named(res, 'status')).toHaveLength(1);

		push({ graph: { floors: [], rooms: [{ id: 'kitchen', name: 'Kitchen', entities: [] }, { id: 'office', name: 'Office', entities: [] }], unassigned: [] }, stale: false, connected: true, status: 'connected' });
		expect(named(res, 'graph')).toHaveLength(2);
		expect(named(res, 'status')).toHaveLength(1);
	});

	it('marks the graph stale on a disconnect and does NOT empty it', async () => {
		const { push, graph } = wireSubscribe();
		const res = mkRes();
		await homeStream(mkReq({ query: { id: HOME_ID } }), res);
		const lastGraph = data(named(res, 'graph')[0]).graph;

		push({ graph, stale: true, connected: false, status: 'unreachable' });

		const status = data(named(res, 'status').at(-1));
		expect(status).toMatchObject({ stale: true, connected: false });
		expect(status.detail).toBeTruthy();
		expect(data(named(res, 'graph').at(-1)).graph.rooms).toEqual(lastGraph.rooms);
		// The stream stays open. A house going offline is not the end of the view.
		expect(res.writableEnded).toBe(false);
	});

	it('unsubscribes and releases exactly once when the client goes away', async () => {
		const { unsubscribe } = wireSubscribe();
		const res = mkRes();
		const closers = [];
		const req = mkReq({ query: { id: HOME_ID } });
		req.on = (event, cb) => { if (event === 'close') closers.push(cb); };
		await homeStream(req, res);
		expect(unsubscribe).not.toHaveBeenCalled();

		closers.forEach((cb) => cb());
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(res.writableEnded).toBe(true);

		// A second close is the ordinary shape of a torn-down stream, not a second
		// release: releasing twice would drop a reference somebody else is holding.
		closers.forEach((cb) => cb());
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('answers a coded status, not an empty 200 stream, when the house cannot be reached', async () => {
		runtime.subscribe.mockRejectedValue(new HomeBridgeError('home_breaker_open', 'paused after 5 failures'));
		const res = mkRes();
		await homeStream(mkReq({ query: { id: HOME_ID } }), res);
		expect(res.statusCode).toBe(503);
		expect(parse(res)).toMatchObject({ code: 'not_connected', detail_code: 'home_breaker_open' });
		expect(res.chunks).toHaveLength(0);
	});
});
