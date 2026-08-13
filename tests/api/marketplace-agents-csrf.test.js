// Every state-changing route on /api/marketplace/agents must carry the
// double-submit CSRF token.
//
// These four writes (create, fork, bookmark, publish) were the only cookie-authed
// mutations in the marketplace that did not ask for one, while their siblings
// (reviews, purchase, asset-price) all did. Publish is the sharp end: its body
// replaces the agent's system prompt, category, and tags, so an unguarded write
// rewrites what the agent says to everyone who talks to it.
//
// The real api/_lib/csrf.js runs here on a stubbed database, so this exercises the
// actual token check rather than a restatement of it. Bearer callers stay exempt:
// a browser never attaches an Authorization header on its own.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const authState = { session: { id: 'aaaa0000-0000-0000-0000-000000000001' }, bearer: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn((req) => {
		const h = req?.headers?.authorization || '';
		return h.startsWith('Bearer ') ? h.slice(7) : null;
	}),
}));

const sqlQueue = [];
const sqlCalls = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn(async (strings) => {
			sqlCalls.push(Array.isArray(strings) ? strings.join('?') : String(strings));
			return sqlQueue.length ? sqlQueue.shift() : [];
		}),
		{ transaction: vi.fn(async (fns) => Promise.all(fns)) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const rlState = { success: true };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		authIp: vi.fn(async () => rlState),
		widgetRead: vi.fn(async () => rlState),
		previewIp: vi.fn(async () => rlState),
		previewAgent: vi.fn(async () => rlState),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../api/_lib/redis.js', () => ({ getRedis: async () => null }));
vi.mock('../../api/_lib/skill-price-cache.js', () => ({
	getSkillPrices: async () => [],
	skillPriceMap: () => ({}),
}));
vi.mock('../../api/_lib/nft-gate.js', () => ({ viewerNftGatedSkills: async () => [] }));

// ── Helpers ──────────────────────────────────────────────────────────────────

const AGENT_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = 'aaaa0000-0000-0000-0000-000000000001';

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

async function invoke(req, res) {
	const { default: handler } = await import('../../api/marketplace/[action].js');
	await handler(req, res);
	let json = {};
	try { json = JSON.parse(res.body); } catch { /* empty body */ }
	return { res, json };
}

// A valid token: requireCsrf consumes it with DELETE ... RETURNING user_id.
const VALID_TOKEN = { 'x-csrf-token': 'a'.repeat(64) };
const tokenAccepted = () => sqlQueue.push([{ user_id: USER_ID }]);

beforeEach(() => {
	sqlQueue.length = 0;
	sqlCalls.length = 0;
	authState.session = { id: USER_ID };
	authState.bearer = null;
	rlState.success = true;
});

// Each entry is one cookie-authed mutation the browser can reach.
const WRITES = [
	{ name: 'create',        method: 'POST',   url: '/api/marketplace/agents', body: { name: 'A', description: 'B', system_prompt: 'C' } },
	{ name: 'fork',          method: 'POST',   url: `/api/marketplace/agents/${AGENT_ID}/fork` },
	{ name: 'bookmark add',  method: 'POST',   url: `/api/marketplace/agents/${AGENT_ID}/bookmark` },
	{ name: 'bookmark drop', method: 'DELETE', url: `/api/marketplace/agents/${AGENT_ID}/bookmark` },
	{ name: 'publish',       method: 'POST',   url: `/api/marketplace/agents/${AGENT_ID}/publish`, body: { category: 'general' } },
];

describe('/api/marketplace/agents writes require a CSRF token', () => {
	for (const w of WRITES) {
		it(`rejects ${w.name} with no token`, async () => {
			const { res, json } = await invoke(makeReq(w.method, w.url, { body: w.body }), makeRes());
			expect(res.statusCode).toBe(403);
			expect(json.error).toBe('csrf_missing');
			// Nothing was written, and nothing was even read.
			expect(sqlCalls).toHaveLength(0);
		});

		it(`rejects ${w.name} with a token the server does not hold`, async () => {
			sqlQueue.push([]); // the consuming DELETE matches no row
			const { res, json } = await invoke(
				makeReq(w.method, w.url, { body: w.body, headers: VALID_TOKEN }),
				makeRes(),
			);
			expect(res.statusCode).toBe(403);
			expect(json.error).toBe('csrf_invalid');
		});
	}

	it('still requires a session before it looks at the token', async () => {
		authState.session = null;
		const { res, json } = await invoke(
			makeReq('POST', `/api/marketplace/agents/${AGENT_ID}/fork`),
			makeRes(),
		);
		expect(res.statusCode).toBe(401);
		expect(json.error).toBe('unauthorized');
	});

	it('accepts a bookmark carrying a valid token', async () => {
		tokenAccepted();
		sqlQueue.push([]); // INSERT ... ON CONFLICT DO NOTHING
		const { res, json } = await invoke(
			makeReq('POST', `/api/marketplace/agents/${AGENT_ID}/bookmark`, { headers: VALID_TOKEN }),
			makeRes(),
		);
		expect(res.statusCode).toBe(200);
		expect(json.data).toEqual({ bookmarked: true });
	});

	it('exempts a bearer caller, which no browser sends by itself', async () => {
		authState.session = null;
		authState.bearer = { userId: USER_ID };
		sqlQueue.push([]); // INSERT ... ON CONFLICT DO NOTHING
		const { res, json } = await invoke(
			makeReq('POST', `/api/marketplace/agents/${AGENT_ID}/bookmark`, {
				headers: { authorization: 'Bearer machine-token' },
			}),
			makeRes(),
		);
		expect(res.statusCode).toBe(200);
		expect(json.data).toEqual({ bookmarked: true });
	});
});
