// Boundary behaviour for two marketplace endpoints that answer before any DB work.
//
//   GET /api/marketplace/check-skill-access: agent_id lands in a uuid column, so
//     a malformed one used to reach Postgres as 22P02 and surface as a 500 on what
//     is plainly bad client input.
//
//   /api/marketplace/agents/:id/reviews: the CORS preflight was answered inside
//     the per-method handlers, so a request the dispatcher rejected first (bad
//     agent id, or a preflight that names no method) came back as a bare error with
//     no CORS headers at all. The browser then reported a CORS failure instead of
//     the validation error the caller needed to read.
//
// Everything below runs offline: no DATABASE_URL, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const authState = { session: { id: 'aaaa0000-0000-0000-0000-000000000001' } };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: async () => true }));

const sqlQueue = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings) => {
			sqlCalls.push(Array.isArray(strings) ? strings.join('?') : String(strings));
			return sqlQueue.length ? sqlQueue.shift() : [];
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => rlState),
		widgetRead: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const ownershipResult = { has_access: true, paid: true, owned: true };
vi.mock('../../api/_lib/services/MonetizationService.js', () => ({
	MonetizationService: class {
		constructor(user) { this.user = user; }
		async checkSkillOwnership() { return ownershipResult; }
	},
}));

vi.mock('../../api/_lib/feed.js', () => ({ publishUserEvent: vi.fn() }));
vi.mock('../../api/_lib/review-attest.js', () => ({ attestReview: vi.fn(async () => {}) }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method, url, { body = null, headers = {} } = {}) {
	const s = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	s.method = method;
	s.url = url;
	s.headers = { host: 'localhost', 'content-type': 'application/json', ...headers };
	return s;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		end(chunk) { if (chunk != null) this.body += chunk; this.writableEnded = true; },
	};
}

async function invoke(modulePath, req, res) {
	const { default: handler } = await import(modulePath);
	await handler(req, res);
	let json = {};
	try { json = JSON.parse(res.body); } catch { /* empty body on 204 */ }
	return { res, json };
}

const AGENT_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
	sqlQueue.length = 0;
	sqlCalls.length = 0;
	authState.session = { id: 'aaaa0000-0000-0000-0000-000000000001' };
	rlState.success = true;
});

// ── check-skill-access ───────────────────────────────────────────────────────

describe('GET /api/marketplace/check-skill-access', () => {
	const path = '../../api/marketplace/check-skill-access.js';

	it('requires a signed-in caller', async () => {
		authState.session = null;
		const { res, json } = await invoke(path, makeReq('GET', `/api/marketplace/check-skill-access?agent_id=${AGENT_ID}&skill=pro`), makeRes());
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('requires both agent_id and skill', async () => {
		const { res, json } = await invoke(path, makeReq('GET', `/api/marketplace/check-skill-access?agent_id=${AGENT_ID}`), makeRes());
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
	});

	it('rejects a non-uuid agent_id with 400 instead of letting Postgres throw', async () => {
		const { res, json } = await invoke(path, makeReq('GET', '/api/marketplace/check-skill-access?agent_id=not-a-uuid&skill=pro'), makeRes());
		expect(res.statusCode).toBe(400);
		expect(json.error_description).toMatch(/uuid/);
		expect(sqlCalls).toHaveLength(0);
	});

	it('returns the ownership verdict for a well-formed request', async () => {
		const { res, json } = await invoke(path, makeReq('GET', `/api/marketplace/check-skill-access?agent_id=${AGENT_ID}&skill=pro`), makeRes());
		expect(res.statusCode).toBe(200);
		expect(json.data).toEqual({ has_access: true });
	});

	it('answers a POST with 405', async () => {
		const { res, json } = await invoke(path, makeReq('POST', '/api/marketplace/check-skill-access', { body: {} }), makeRes());
		expect(res.statusCode).toBe(405);
		expect(json.error).toBe('method_not_allowed');
	});
});

// ── reviews ──────────────────────────────────────────────────────────────────

describe('/api/marketplace/agents/:id/reviews CORS + dispatch', () => {
	const path = '../../api/marketplace/reviews.js';
	const ORIGIN = { origin: 'https://three.ws' };

	it('answers a preflight for a malformed agent id with 204 + CORS headers', async () => {
		const { res } = await invoke(
			path,
			makeReq('OPTIONS', '/api/marketplace/agents/nope/reviews', {
				headers: { ...ORIGIN, 'access-control-request-method': 'POST' },
			}),
			makeRes(),
		);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('https://three.ws');
		expect(res.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,OPTIONS');
		expect(sqlCalls).toHaveLength(0);
	});

	it('answers a preflight that names no method with 204, not 405', async () => {
		const { res } = await invoke(
			path,
			makeReq('OPTIONS', `/api/marketplace/agents/${AGENT_ID}/reviews`, { headers: ORIGIN }),
			makeRes(),
		);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-credentials']).toBe('true');
	});

	it('carries CORS headers on the validation error for a malformed agent id', async () => {
		const { res, json } = await invoke(
			path,
			makeReq('GET', '/api/marketplace/agents/nope/reviews', { headers: ORIGIN }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('validation_error');
		expect(res.headers['access-control-allow-origin']).toBe('https://three.ws');
	});

	it('rejects an unsupported method with 405', async () => {
		const { res, json } = await invoke(
			path,
			makeReq('PUT', `/api/marketplace/agents/${AGENT_ID}/reviews`, { headers: ORIGIN }),
			makeRes(),
		);
		expect(res.statusCode).toBe(405);
		expect(json.error).toBe('method_not_allowed');
	});

	it('lists reviews for a real agent', async () => {
		sqlQueue.push([{ id: AGENT_ID }]);                                    // agent exists
		sqlQueue.push([{ rating_avg: '4.50', rating_count: 2, r5: 1, r4: 1, r3: 0, r2: 0, r1: 0 }]);
		sqlQueue.push([{ id: 'r1', rating: 5, body: 'Great', created_at: null, updated_at: null, user_id: 'someone', display_name: 'Ada', avatar_url: null }]);
		sqlQueue.push([]);                                                    // caller's own review

		const { res, json } = await invoke(
			path,
			makeReq('GET', `/api/marketplace/agents/${AGENT_ID}/reviews`, { headers: ORIGIN }),
			makeRes(),
		);

		expect(res.statusCode).toBe(200);
		expect(json.data.summary.rating_avg).toBe(4.5);
		expect(json.data.reviews).toHaveLength(1);
		expect(json.data.reviews[0].author_name).toBe('Ada');
	});

	it('returns 404 when the agent does not exist', async () => {
		sqlQueue.push([]); // no agent row
		const { res, json } = await invoke(
			path,
			makeReq('GET', `/api/marketplace/agents/${AGENT_ID}/reviews`, { headers: ORIGIN }),
			makeRes(),
		);
		expect(res.statusCode).toBe(404);
		expect(json.error).toBe('not_found');
	});
});
