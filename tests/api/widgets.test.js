/**
 * Integration-ish tests for the widgets API. The handlers talk to Postgres,
 * Upstash, auth helpers and R2, so every external dep is mocked at module
 * boundaries. Each test wires `sql`, auth, and rate-limit responses before
 * invoking the default export with a fake req/res pair.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock external deps BEFORE importing handlers ─────────────────────────────

// Queue of `sql` responses in order of calls. Each test fills this.
const sqlQueue = [];

// `sql` is both a tagged-template and positional callable in the codebase.
// Return the queued value regardless of how it's invoked.
const sqlMock = vi.fn(() => {
	if (sqlQueue.length === 0) {
		return Promise.resolve([]);
	}
	const next = sqlQueue.shift();
	if (next instanceof Error) return Promise.reject(next);
	return Promise.resolve(next);
});

vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock }));

const authState = {
	session: null,
	bearer: null,
};

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => authState.session),
	authenticateBearer: vi.fn(async () => authState.bearer),
	extractBearer: vi.fn(() => null),
	hasScope: (scope, need) => {
		if (!scope) return false;
		return String(scope).split(/\s+/).includes(need);
	},
}));

const rlState = { success: true };

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		widgetRead: vi.fn(async () => ({ success: rlState.success })),
		widgetWrite: vi.fn(async () => ({ success: rlState.success })),
		upload: vi.fn(async () => ({ success: rlState.success })),
	},
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/r2.js', () => ({
	publicUrl: (key) => `https://cdn.test/${key}`,
	presignGet: vi.fn(async () => 'https://signed.test/x'),
}));

vi.mock('../../api/_lib/avatars.js', () => ({
	getAvatar: vi.fn(async () => null),
}));

// Embeddings — keep tests offline. Configured=true so we exercise the test
// branch's validation; embed() returns a fixed vector if invoked.
vi.mock('../../api/_lib/embeddings.js', () => ({
	embeddingsConfigured: () => true,
	embed: vi.fn(async (texts) => texts.map(() => Float64Array.from([1, 0, 0, 0]))),
	cosine: (a, b) => {
		let dot = 0, na = 0, nb = 0;
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
		return na && nb ? dot / Math.sqrt(na * nb) : 0;
	},
}));

// ── Import handlers AFTER mocks are registered ───────────────────────────────

const listCreateHandler = (await import('../../api/widgets/index.js')).default;
const byIdHandler = (await import('../../api/widgets/[id].js')).default;
const duplicateHandler = (await import('../../api/widgets/[id]/duplicate.js')).default;
const statsHandler = (await import('../../api/widgets/[id]/stats.js')).default;
const viewHandler = (await import('../../api/widgets/view.js')).default;
const ogHandler = (await import('../../api/widgets/og.js')).default;
const transcriptsHandler = (await import('../../api/widgets/[id]/transcripts.js')).default;
const knowledgeHandler = (await import('../../api/widgets/[id]/knowledge.js')).default;

const { getAvatar } = await import('../../api/_lib/avatars.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
	const res = {
		statusCode: 200,
		headers: {},
		_body: '',
		writableEnded: false,
		setHeader(name, value) {
			this.headers[name.toLowerCase()] = value;
		},
		getHeader(name) {
			return this.headers[name.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) this._body = body;
			this.writableEnded = true;
		},
	};
	return res;
}

function mockReq({ method = 'GET', url = '/api/widgets', headers = {}, body = null, query } = {}) {
	const req = {
		method,
		url,
		headers: { ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		query,
	};
	// For POST JSON bodies, readJson() reads via req.on('data'/'end').
	if (body !== null && body !== undefined) {
		const buf = Buffer.from(JSON.stringify(body), 'utf8');
		req.headers['content-type'] = req.headers['content-type'] || 'application/json';
		const listeners = {};
		req.on = (ev, cb) => {
			listeners[ev] = cb;
			// Emit on next tick so handler can attach listeners.
			if (ev === 'end') {
				queueMicrotask(() => {
					listeners.data?.(buf);
					listeners.end?.();
				});
			}
			return req;
		};
		req.destroy = () => {};
	}
	return req;
}

function parseJson(res) {
	return res._body ? JSON.parse(res._body) : null;
}

function resetState() {
	sqlQueue.length = 0;
	sqlMock.mockClear();
	authState.session = null;
	authState.bearer = null;
	rlState.success = true;
}

beforeEach(() => {
	resetState();
});

// ── GET /api/widgets — list ──────────────────────────────────────────────────

describe('GET /api/widgets (list)', () => {
	it('401s without session or bearer', async () => {
		const req = mockReq({ method: 'GET' });
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(401);
		expect(parseJson(res).error).toBe('unauthorized');
	});

	it('returns current user widgets when authed via session', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([
			{
				id: 'wdgt_abc',
				user_id: 'user-1',
				avatar_id: null,
				type: 'turntable',
				name: 'Hello',
				config: { x: 1 },
				is_public: true,
				view_count: 5,
				created_at: '2024-01-01',
				updated_at: '2024-01-02',
				avatar_name: null,
				avatar_thumbnail_key: null,
				avatar_storage_key: null,
				avatar_visibility: null,
			},
		]);
		const req = mockReq({ method: 'GET' });
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.widgets).toHaveLength(1);
		expect(body.widgets[0].id).toBe('wdgt_abc');
		expect(body.widgets[0].view_count).toBe(5);
	});

	it('403s when bearer lacks avatars:read scope', async () => {
		authState.bearer = { userId: 'user-1', scope: 'profile', source: 'oauth' };
		// `resolveAuth` returns null for insufficient scope → 401 in list/create handler
		// (it doesn't distinguish 403). Assert the 401 behavior here; stats handler
		// covers 403 explicitly.
		const req = mockReq({ method: 'GET' });
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(401);
	});
});

// ── POST /api/widgets — create ───────────────────────────────────────────────

describe('POST /api/widgets (create)', () => {
	it('creates a widget and returns 201', async () => {
		authState.session = { id: 'user-1' };
		const inserted = {
			id: 'wdgt_new',
			user_id: 'user-1',
			avatar_id: null,
			type: 'turntable',
			name: 'My Widget',
			config: {},
			is_public: true,
			view_count: 0,
			created_at: '2024-01-01',
			updated_at: '2024-01-01',
		};
		sqlQueue.push([inserted]); // INSERT … returning
		const req = mockReq({
			method: 'POST',
			body: { type: 'turntable', name: 'My Widget' },
		});
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(201);
		expect(parseJson(res).widget.id).toBe('wdgt_new');
	});

	it('rejects body with unknown widget type (400)', async () => {
		authState.session = { id: 'user-1' };
		const req = mockReq({
			method: 'POST',
			body: { type: 'not-real', name: 'Bad' },
		});
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(400);
	});

	it('rejects avatar_id not owned by caller (400 invalid_avatar)', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // ownership check returns no rows
		const req = mockReq({
			method: 'POST',
			body: {
				type: 'turntable',
				name: 'Owned',
				avatar_id: '11111111-1111-1111-1111-111111111111',
			},
		});
		const res = mockRes();
		await listCreateHandler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseJson(res).error).toBe('invalid_avatar');
	});
});

// ── GET /api/widgets/:id ────────────────────────────────────────────────────

describe('GET /api/widgets/:id', () => {
	it('404s when widget does not exist', async () => {
		sqlQueue.push([]); // select returns nothing
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_missing' });
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('404s for private widget when viewer is not owner', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_priv',
				user_id: 'someone-else',
				avatar_id: null,
				type: 'turntable',
				name: 'Priv',
				config: {},
				is_public: false,
				view_count: 0,
				created_at: 't',
				updated_at: 't',
				avatar_name: null,
				avatar_thumbnail_key: null,
				avatar_storage_key: null,
				avatar_visibility: null,
			},
		]);
		// Unauthenticated request — is_public false → 404 not_found
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_priv' });
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('returns a public widget and does not require auth', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_pub',
				user_id: 'other',
				avatar_id: null,
				type: 'turntable',
				name: 'Public',
				config: {},
				is_public: true,
				view_count: 10,
				created_at: 't',
				updated_at: 't',
				avatar_name: null,
				avatar_thumbnail_key: null,
				avatar_storage_key: null,
				avatar_visibility: null,
			},
		]);
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_pub' });
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(200);
		expect(parseJson(res).widget.id).toBe('wdgt_pub');
	});

	it('PATCH 401s without auth', async () => {
		const req = mockReq({
			method: 'PATCH',
			url: '/api/widgets/wdgt_x',
			body: { name: 'new' },
		});
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('PATCH 403s when bearer lacks avatars:write scope', async () => {
		authState.bearer = {
			userId: 'user-1',
			scope: 'avatars:read',
			source: 'oauth',
		};
		const req = mockReq({
			method: 'PATCH',
			url: '/api/widgets/wdgt_x',
			body: { name: 'new' },
		});
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(403);
		expect(parseJson(res).error).toBe('insufficient_scope');
	});

	it('DELETE 404s when widget not found for user', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // soft-delete returns no rows
		const req = mockReq({ method: 'DELETE', url: '/api/widgets/wdgt_missing' });
		const res = mockRes();
		await byIdHandler(req, res);
		expect(res.statusCode).toBe(404);
	});
});

// ── POST /api/widgets/:id/duplicate ──────────────────────────────────────────

describe('POST /api/widgets/:id/duplicate', () => {
	it('401s without auth', async () => {
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/wdgt_x/duplicate',
		});
		const res = mockRes();
		await duplicateHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('404s when source widget not owned', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // source lookup: nothing
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/wdgt_x/duplicate',
		});
		const res = mockRes();
		await duplicateHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('clones the widget and returns 201', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([
			{
				id: 'wdgt_src',
				type: 'turntable',
				name: 'Original',
				config: { a: 1 },
				avatar_id: null,
				is_public: true,
			},
		]);
		sqlQueue.push([
			{
				id: 'wdgt_copy',
				user_id: 'user-1',
				avatar_id: null,
				type: 'turntable',
				name: 'Original (copy)',
				config: { a: 1 },
				is_public: true,
				view_count: 0,
				created_at: 't',
				updated_at: 't',
			},
		]);
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/wdgt_src/duplicate',
		});
		const res = mockRes();
		await duplicateHandler(req, res);
		expect(res.statusCode).toBe(201);
		expect(parseJson(res).widget.name).toBe('Original (copy)');
	});
});

// ── GET /api/widgets/:id/stats ───────────────────────────────────────────────

describe('GET /api/widgets/:id/stats', () => {
	it('401s without auth', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('403s when bearer lacks avatars:read scope', async () => {
		authState.bearer = { userId: 'user-1', scope: 'profile', source: 'oauth' };
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(403);
	});

	it('404s when the caller does not own the widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // ownership check: nothing
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('returns stats envelope for owned widget, gracefully handling missing tables', async () => {
		authState.session = { id: 'user-1' };
		// 1. ownership check returns the widget
		sqlQueue.push([{ id: 'wdgt_x', type: 'turntable', view_count: 42 }]);
		// The stats handler fires 4 parallel queries; simulate "relation does not exist"
		// for each so the dashboard gets empty/zero defaults.
		const missing = Object.assign(new Error('relation "widget_views" does not exist'), {});
		sqlQueue.push(missing); // recentViewsByDay
		sqlQueue.push(missing); // topReferers
		sqlQueue.push(missing); // topCountries
		sqlQueue.push(missing); // lastViewedAt

		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.stats.view_count).toBe(42);
		expect(body.stats.recent_views_7d).toHaveLength(8);
		expect(body.stats.top_referers).toEqual([]);
		expect(body.stats.top_countries).toEqual([]);
		expect(body.stats.last_viewed_at).toBeNull();
		expect(body.stats.chat_count).toBeNull();
		// Non-talking-agent widgets always return null for chat-only fields,
		// including the new rolling 7-day session metrics.
		expect(body.stats.sessions_7d).toBeNull();
	});

	it('returns sessions_7d aggregates for talking-agent widgets', async () => {
		authState.session = { id: 'user-1' };
		// 1. ownership check returns a talking-agent widget
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent', view_count: 12 }]);
		const missing = new Error('relation "widget_views" does not exist');
		sqlQueue.push(missing);      // recentViewsByDay
		sqlQueue.push(missing);      // topReferers
		sqlQueue.push(missing);      // topCountries
		sqlQueue.push(missing);      // lastViewedAt
		sqlQueue.push([{ n: 8 }]);   // chatCountFor (talking-agent)
		sqlQueue.push([]);           // recentChatsByDay
		sqlQueue.push([]);           // topQuestionsFor
		sqlQueue.push([{ doc_count: 0, chunk_count: 0, token_count: 0 }]); // knowledgeSummaryFor
		sqlQueue.push([{ thread_count: 3, avg_seconds: 47.7, total_messages: 14 }]); // sessionStatsFor

		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.stats.sessions_7d).toEqual({
			thread_count: 3,
			avg_seconds: 48, // rounded
			total_messages: 14,
		});
	});

	it('returns null sessions_7d when widget_chat_threads is missing', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent', view_count: 0 }]);
		const missing = new Error('relation "widget_views" does not exist');
		sqlQueue.push(missing); // recentViewsByDay
		sqlQueue.push(missing); // topReferers
		sqlQueue.push(missing); // topCountries
		sqlQueue.push(missing); // lastViewedAt
		const chatMissing = new Error('relation "widget_chat_messages" does not exist');
		sqlQueue.push(chatMissing); // chatCountFor
		sqlQueue.push(chatMissing); // recentChatsByDay
		sqlQueue.push(chatMissing); // topQuestionsFor
		sqlQueue.push(new Error('relation "widget_knowledge_docs" does not exist'));
		sqlQueue.push(new Error('relation "widget_chat_threads" does not exist'));

		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/stats' });
		const res = mockRes();
		await statsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.stats.sessions_7d).toBeNull();
	});
});

// ── POST /api/widgets/view ───────────────────────────────────────────────────

describe('POST /api/widgets/view', () => {
	it('405s on GET', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/view?id=wdgt_x' });
		const res = mockRes();
		await viewHandler(req, res);
		expect(res.statusCode).toBe(405);
	});

	it('400s when id is missing', async () => {
		const req = mockReq({ method: 'POST', url: '/api/widgets/view' });
		const res = mockRes();
		await viewHandler(req, res);
		expect(res.statusCode).toBe(400);
	});

	it('204s on successful insert + update', async () => {
		sqlQueue.push([]); // insert widget_views
		sqlQueue.push([]); // update widgets view_count
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/view?id=wdgt_x',
			headers: { referer: 'https://example.com/page' },
		});
		const res = mockRes();
		await viewHandler(req, res);
		expect(res.statusCode).toBe(204);
	});

	it('still 204s when widget_views table does not exist', async () => {
		const missing = new Error('relation "widget_views" does not exist');
		sqlQueue.push(missing);
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/view?id=wdgt_x',
		});
		const res = mockRes();
		await viewHandler(req, res);
		expect(res.statusCode).toBe(204);
	});
});

// ── GET /api/widgets/og ──────────────────────────────────────────────────────

describe('GET /api/widgets/og', () => {
	it('returns a 404 SVG card when id is missing', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/og' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(404);
		expect(res.headers['content-type']).toMatch(/svg/);
	});

	it('returns 404 SVG when widget not found', async () => {
		sqlQueue.push([]); // loadWidget → nothing
		const req = mockReq({ method: 'GET', url: '/api/widgets/og?id=wdgt_missing' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('renders a private-widget SVG for non-public widgets', async () => {
		sqlQueue.push([
			{ id: 'wdgt_p', name: 'Secret', type: 'turntable', avatar_id: null, is_public: false },
		]);
		const req = mockReq({ method: 'GET', url: '/api/widgets/og?id=wdgt_p' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('Private widget');
	});

	it('302s to avatar thumbnail when available', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_a',
				name: 'Has avatar',
				type: 'turntable',
				avatar_id: '11111111-1111-1111-1111-111111111111',
				is_public: true,
			},
		]);
		getAvatar.mockResolvedValueOnce({ thumbnail_url: 'https://cdn.test/thumb.png' });
		const req = mockReq({ method: 'GET', url: '/api/widgets/og?id=wdgt_a' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('https://cdn.test/thumb.png');
	});

	it('renders SVG card for public widget with no avatar thumbnail', async () => {
		sqlQueue.push([
			{
				id: 'wdgt_b',
				name: 'Tour',
				type: 'hotspot-tour',
				avatar_id: null,
				is_public: true,
			},
		]);
		const req = mockReq({ method: 'GET', url: '/api/widgets/og?id=wdgt_b' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res._body).toContain('Tour');
		expect(res._body).toContain('HOTSPOT TOUR');
	});
});

// ── GET /api/widgets/:id/transcripts ────────────────────────────────────────

describe('GET /api/widgets/:id/transcripts', () => {
	it('401s without auth', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x' });
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('404s when the caller does not own the widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // ownership check returns no rows
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x' });
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('returns threads + totals envelope', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x' }]); // ownership ok
		sqlQueue.push([
			{
				id: 'wct_a',
				visitor_id: 'v_abc',
				referer_host: 'example.com',
				country: 'US',
				message_count: 4,
				started_at: '2026-05-23T00:00:00Z',
				last_message_at: '2026-05-24T00:00:00Z',
				preview: 'hello there',
				user_msgs: 2,
			},
		]);
		sqlQueue.push([{ total_threads: 1, total_messages: 4, unique_visitors: 1 }]);

		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x' });
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.threads).toHaveLength(1);
		expect(body.threads[0].id).toBe('wct_a');
		expect(body.threads[0].visitor_label).toMatch(/visitor/);
		expect(body.totals.threads).toBe(1);
		expect(body.totals.messages).toBe(4);
	});

	it('returns single thread when thread_id is in the query', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x' }]); // ownership ok
		sqlQueue.push([
			{
				id: 'wct_a',
				visitor_id: 'v_abc',
				referer_host: null,
				country: null,
				message_count: 2,
				started_at: 't',
				last_message_at: 't',
			},
		]);
		sqlQueue.push([
			{ id: 1, role: 'user',      content: 'hi',         actions: null, provider: null,        model: null, redacted: false, created_at: 't' },
			{ id: 2, role: 'assistant', content: 'hello back', actions: [],   provider: 'anthropic', model: 'm',  redacted: false, created_at: 't' },
		]);

		const req = mockReq({
			method: 'GET',
			url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x&thread_id=wct_a',
		});
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.thread.id).toBe('wct_a');
		expect(body.messages).toHaveLength(2);
		expect(body.messages[1].provider).toBe('anthropic');
	});
});

// ── /api/widgets/:id/knowledge ──────────────────────────────────────────────

describe('GET /api/widgets/:id/knowledge', () => {
	it('401s without auth', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x' });
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(401);
	});

	it('404s when the caller does not own the widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([]); // ownership check empty
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x' });
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it('lists docs for an owned widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent' }]); // ownership ok
		sqlQueue.push([
			{
				id: 'wkd_a',
				title: 'Docs',
				source_type: 'url',
				source_url: 'https://example.com',
				byte_size: 1024,
				chunk_count: 4,
				token_count: 800,
				status: 'ready',
				error: null,
				created_at: 't',
				updated_at: 't',
			},
		]);
		const req = mockReq({ method: 'GET', url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x' });
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(200);
		const body = parseJson(res);
		expect(body.docs).toHaveLength(1);
		expect(body.docs[0].title).toBe('Docs');
	});
});

describe('POST /api/widgets/:id/knowledge', () => {
	it('rejects non-talking-agent widgets with 400', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'turntable' }]); // ownership ok but wrong type
		const req = mockReq({
			method: 'POST',
			url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x',
			body: { source_type: 'text', content: 'hi' },
		});
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseJson(res).error).toBe('invalid_widget_type');
	});
});

describe('GET /api/widgets/:id/knowledge?test= (retrieval debugger)', () => {
	it('400s on too-short query', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent' }]); // ownership ok
		const req = mockReq({
			method: 'GET',
			url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x&test=',
		});
		const res = mockRes();
		await knowledgeHandler(req, res);
		// `test=''` is "param present, empty string" → endpoint enters test
		// branch and the testRetrieval helper rejects with 400.
		expect(res.statusCode).toBe(400);
	});
});

describe('GET /api/widgets/:id/transcripts?format=csv', () => {
	it('returns a CSV download with the right headers', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x' }]); // ownership ok
		sqlQueue.push([
			{
				thread_id: 'wct_a',
				visitor_id: 'v_abc',
				referer_host: 'example.com',
				country: 'US',
				role: 'user',
				content: 'hi, "quoted" message',
				provider: null,
				model: null,
				redacted: false,
				created_at: new Date('2026-05-24T00:00:00Z'),
			},
		]);

		const req = mockReq({
			method: 'GET',
			url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x&format=csv',
		});
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/csv/);
		expect(res.headers['content-disposition']).toMatch(/attachment/);
		// Header row + the 1 message row.
		const lines = res._body.split('\n').filter(Boolean);
		expect(lines[0]).toBe(
			'thread_id,created_at,visitor_id,role,content,provider,model,redacted,referer_host,country',
		);
		expect(lines[1]).toContain('wct_a');
		// Quoted content must be CSV-escaped (double-quotes doubled).
		expect(lines[1]).toContain('"hi, ""quoted"" message"');
	});
});

describe('DELETE /api/widgets/:id/knowledge', () => {
	it('400s without doc_id', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent' }]); // ownership ok
		const req = mockReq({ method: 'DELETE', url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x' });
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(400);
	});

	it('404s when the doc is not on the widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x', type: 'talking-agent' }]); // ownership ok
		sqlQueue.push([]); // delete returns nothing
		const req = mockReq({
			method: 'DELETE',
			url: '/api/widgets/wdgt_x/knowledge?id=wdgt_x&doc_id=wkd_missing',
		});
		const res = mockRes();
		await knowledgeHandler(req, res);
		expect(res.statusCode).toBe(404);
	});
});
