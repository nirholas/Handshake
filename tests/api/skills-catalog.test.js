/**
 * Regression cover for the marketplace skills catalog handlers.
 *
 * Three defects found by exercising the live endpoints, all fixed here:
 *
 *  1. GET /api/skills with a cursor whose pivot row no longer resolves (the
 *     skill was deleted or flipped private between pages) silently returned
 *     page 1 again, carrying the SAME next_cursor. The marketplace grid's
 *     "load more" then re-appended the first page forever.
 *  2. POST /api/skills/:id/install takes no request body, which made it a
 *     CORS-simple request any origin could fire with the visitor's cookie.
 *     It now requires the same CSRF token every sibling mutation does.
 *  3. PUT /api/skills/:id answered with avg_rating 0 / rating_count 0
 *     regardless of the skill's real ratings, and the detail view re-renders
 *     from that response, so editing a description appeared to wipe the
 *     rating until the next reload.
 *
 * Only the DB / auth / rate-limit / CSRF boundaries are mocked; the handler
 * logic under test is the real thing.
 */

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const authState = { session: null, bearer: null };

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
}));

const sqlState = { queue: [], calls: [] };

function sqlImpl(strings, ...values) {
	sqlState.calls.push({ query: Array.isArray(strings) ? strings.join('?') : String(strings), values });
	return Promise.resolve(sqlState.queue.length ? sqlState.queue.shift() : []);
}

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(sqlImpl),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		skillsBrowse: vi.fn(async () => ({ success: true })),
		chatUser: vi.fn(async () => ({ success: true })),
		publicIp: vi.fn(async () => ({ success: true })),
		authIp: vi.fn(async () => ({ success: true })),
		widgetRead: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const csrfState = { ok: true };
vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async (req, res) => {
		if (csrfState.ok) return true;
		res.statusCode = 403;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify({ error: 'csrf_missing', error_description: 'X-CSRF-Token header required' }));
		return false;
	}),
}));

const { default: listHandler } = await import('../../api/skills/index.js');
const { default: installHandler } = await import('../../api/skills/[id]/install.js');
const { default: detailHandler } = await import('../../api/skills/[id].js');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SKILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeReq({ method = 'GET', url = '/api/skills', query = {}, body = null } = {}) {
	const req = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);
	req.method = method;
	req.url = url;
	req.query = query;
	req.headers = { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}) };
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function invoke(handler, reqOpts) {
	const res = makeRes();
	await handler(makeReq(reqOpts), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

function skillRow(over = {}) {
	return {
		id: SKILL,
		name: 'Probe',
		slug: 'probe',
		description: 'a probe',
		category: 'general',
		tags: [],
		install_count: 3,
		created_at: '2026-08-01T00:00:00.000Z',
		author_id: USER,
		author_display_name: 'probe author',
		price_per_call_usd: '0',
		content: 'probe body',
		schema_json: null,
		avg_rating: 0,
		rating_count: 0,
		installed: false,
		...over,
	};
}

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
	authState.session = null;
	authState.bearer = null;
	csrfState.ok = true;
	vi.clearAllMocks();
});

describe('GET /api/skills pagination', () => {
	it('terminates the sequence when the cursor pivot no longer resolves', async () => {
		// The pivot lookup comes back empty: the skill was deleted or made private.
		sqlState.queue = [[]];

		const cursor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const r = await invoke(listHandler, { url: `/api/skills?limit=2&cursor=${cursor}` });

		expect(r.status).toBe(200);
		expect(r.body).toEqual({ skills: [], next_cursor: null });
		// Crucially it must NOT fall through to the list query and hand back page 1.
		expect(sqlState.calls).toHaveLength(1);
	});

	it('still paginates when the cursor pivot resolves', async () => {
		sqlState.queue = [
			[{ install_count: 9, created_at: '2026-08-01T00:00:00.000Z', name: 'Pivot' }],
			[skillRow({ id: SKILL }), skillRow({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })],
		];

		const cursor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const r = await invoke(listHandler, { url: `/api/skills?limit=1&cursor=${cursor}` });

		expect(r.status).toBe(200);
		expect(r.body.skills).toHaveLength(1);
		expect(r.body.next_cursor).toBe(SKILL);
	});

	it('rejects a malformed cursor before touching the database', async () => {
		const r = await invoke(listHandler, { url: '/api/skills?cursor=not-a-uuid' });
		expect(r.status).toBe(400);
		expect(r.body.error).toBe('validation_error');
		expect(sqlState.calls).toHaveLength(0);
	});
});

describe('POST /api/skills/:id/install', () => {
	it('refuses a cookie-session install without a CSRF token', async () => {
		authState.session = { id: USER, plan: 'free' };
		csrfState.ok = false;

		const r = await invoke(installHandler, {
			method: 'POST',
			url: `/api/skills/${SKILL}/install`,
			query: { id: SKILL },
		});

		expect(r.status).toBe(403);
		expect(r.body.error).toBe('csrf_missing');
		// The gate must run before any write reaches the database.
		expect(sqlState.calls).toHaveLength(0);
	});

	it('installs when the CSRF token is present', async () => {
		authState.session = { id: USER, plan: 'free' };
		sqlState.queue = [[{ id: SKILL, schema_json: null, content: 'probe body' }], []];

		const r = await invoke(installHandler, {
			method: 'POST',
			url: `/api/skills/${SKILL}/install`,
			query: { id: SKILL },
		});

		expect(r.status).toBe(200);
		expect(r.body).toEqual({ installed: true, schema_json: null, content: 'probe body' });
	});

	it('exempts bearer callers from CSRF', async () => {
		csrfState.ok = false;
		authState.bearer = { userId: USER };
		sqlState.queue = [[{ id: SKILL, schema_json: null, content: 'probe body' }], []];

		const r = await invoke(installHandler, {
			method: 'POST',
			url: `/api/skills/${SKILL}/install`,
			query: { id: SKILL },
		});

		expect(r.status).toBe(200);
		expect(r.body.installed).toBe(true);
	});

	it('rejects an anonymous install', async () => {
		const r = await invoke(installHandler, {
			method: 'POST',
			url: `/api/skills/${SKILL}/install`,
			query: { id: SKILL },
		});
		expect(r.status).toBe(401);
		expect(r.body.error).toBe('unauthorized');
	});
});

describe('PUT /api/skills/:id', () => {
	it('answers with the skill real rating aggregate, not zeros', async () => {
		authState.session = { id: USER, plan: 'free' };
		sqlState.queue = [
			[{ id: SKILL, author_id: USER }], // ownership lookup
			[skillRow({ description: 'edited' })], // UPDATE ... RETURNING *
			[{ id: USER, display_name: 'probe author' }], // author lookup
			[{ avg_rating: 4.5, rating_count: 12 }], // live rating aggregate
		];

		const r = await invoke(detailHandler, {
			method: 'PUT',
			url: `/api/skills/${SKILL}`,
			query: { id: SKILL },
			body: { description: 'edited' },
		});

		expect(r.status).toBe(200);
		expect(r.body.skill.avg_rating).toBe(4.5);
		expect(r.body.skill.rating_count).toBe(12);
		expect(r.body.skill.description).toBe('edited');
	});

	it('rejects an edit from a non-author non-admin', async () => {
		authState.session = { id: USER, plan: 'free' };
		sqlState.queue = [
			[{ id: SKILL, author_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }],
			[{ plan: 'free' }],
		];

		const r = await invoke(detailHandler, {
			method: 'PUT',
			url: `/api/skills/${SKILL}`,
			query: { id: SKILL },
			body: { description: 'nope' },
		});

		expect(r.status).toBe(403);
		expect(r.body.error).toBe('forbidden');
	});
});
