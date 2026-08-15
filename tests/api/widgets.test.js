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

vi.mock('../../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

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

vi.mock('../../api/_lib/csrf.js', () => ({
	requireCsrf: vi.fn(async () => true),
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
// branch's validation; the embed fns return a fixed vector if invoked.
vi.mock('../../api/_lib/embeddings.js', () => {
	const NIM_EMBED_TAG = 'nvidia/nv-embedqa-e5-v5@1024';
	const LEGACY_EMBED_TAG = 'text-embedding-3-small@256';
	const fixedVectors = (texts) => texts.map(() => Float64Array.from([1, 0, 0, 0]));
	const cosine = (a, b) => {
		if (!a || !b || a.length !== b.length) return 0;
		let dot = 0, na = 0, nb = 0;
		for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
		return na && nb ? dot / Math.sqrt(na * nb) : 0;
	};
	return {
		NIM_EMBED_TAG,
		OPENAI_EMBED_TAG: LEGACY_EMBED_TAG,
		LEGACY_EMBED_TAG,
		embeddingsConfigured: () => true,
		embedderConfigured: () => true,
		defaultIngestEmbedderTag: () => NIM_EMBED_TAG,
		resolveEmbedderTag: (tag) => tag || LEGACY_EMBED_TAG,
		embedderInfo: (tag) => ({ tag: tag || LEGACY_EMBED_TAG, model: 'mock-embedder', dim: 4 }),
		embedWith: vi.fn(async (_tag, texts) => fixedVectors(texts)),
		embedPassages: vi.fn(async (_tag, texts) => fixedVectors(texts)),
		embedQuery: vi.fn(async () => Float64Array.from([1, 0, 0, 0])),
		scoreRowsBySpace: vi.fn(async (rows) => ({
			scored: rows.map((r) => ({ ...r, embedder: r.embedder || LEGACY_EMBED_TAG, score: 1 })),
			needsReembed: [],
		})),
		cosine,
	};
});

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
const { requireCsrf } = await import('../../api/_lib/csrf.js');

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

// `sql` is invoked both as a tagged template (strings array + values) and
// positionally (text + params). Flatten either form back to the SQL text so a
// test can assert on the statement a handler actually issued.
function sqlText(call) {
	if (!call) return '';
	return Array.isArray(call[0]) ? call[0].join(' ') : String(call[0]);
}

function resetState() {
	sqlQueue.length = 0;
	sqlMock.mockClear();
	requireCsrf.mockClear();
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

	// Regression: the clone INSERT once omitted the `id` column. widgets.id is
	// `text not null` with no database default, so every real Duplicate click
	// died on a not-null violation and returned a bare 500 while the mocked
	// test above still passed. Assert on the statement, not just the canned row.
	it('supplies a generated wdgt_ id to the clone INSERT', async () => {
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
		sqlQueue.push([{ id: 'wdgt_copy', user_id: 'user-1', type: 'turntable', name: 'Original (copy)' }]);

		const req = mockReq({ method: 'POST', url: '/api/widgets/wdgt_src/duplicate' });
		await duplicateHandler(req, mockRes());

		const insert = sqlMock.mock.calls.find((call) => /insert into widgets/i.test(sqlText(call)));
		expect(insert, 'duplicate must issue an INSERT into widgets').toBeDefined();
		expect(sqlText(insert)).toMatch(/insert into widgets\s*\(\s*id\s*,/i);
		// First interpolated value is the freshly minted id.
		expect(insert[1]).toMatch(/^wdgt_[A-Za-z0-9_-]+$/);
	});

	it('requires a CSRF token for cookie-session callers', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([
			{ id: 'wdgt_src', type: 'turntable', name: 'Original', config: {}, avatar_id: null, is_public: true },
		]);
		sqlQueue.push([{ id: 'wdgt_copy', user_id: 'user-1', type: 'turntable', name: 'Original (copy)' }]);

		const req = mockReq({ method: 'POST', url: '/api/widgets/wdgt_src/duplicate' });
		await duplicateHandler(req, mockRes());

		expect(requireCsrf).toHaveBeenCalledWith(req, expect.anything(), 'user-1');
	});

	it('400s on a widget id the frontend never should have sent', async () => {
		authState.session = { id: 'user-1' };
		const req = mockReq({ method: 'POST', url: '/api/widgets/undefined/duplicate' });
		const res = mockRes();
		await duplicateHandler(req, res);
		expect(res.statusCode).toBe(400);
		expect(parseJson(res).error).toBe('invalid_request');
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

	// /w/:id points its og:image at this route, and the demo widgets are served
	// from baked-in fixtures rather than the DB. Resolving them here is what keeps
	// a shared demo link from previewing as the not-found card in Slack or X.
	it('renders the demo fixtures without touching the database', async () => {
		const req = mockReq({ method: 'GET', url: '/api/widgets/og?id=wdgt_demo_turntab' });
		const res = mockRes();
		await ogHandler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toMatch(/svg/);
		expect(res._body).toContain('Turntable Showcase');
		expect(sqlQueue.length).toBe(0);
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

	// getTranscript() returns null for a thread that is not on this widget, and
	// the handler has to turn that into a clean 404 rather than an empty 200 or
	// a crash on `data.thread`. This is the one cross-widget leak the transcript
	// reader could have: the thread lookup is scoped by widget_id, so a guessed
	// thread id from someone else's widget must read as not-found.
	it('404s when the thread is not on this widget', async () => {
		authState.session = { id: 'user-1' };
		sqlQueue.push([{ id: 'wdgt_x' }]); // ownership ok
		sqlQueue.push([]); // thread lookup: nothing on this widget

		const req = mockReq({
			method: 'GET',
			url: '/api/widgets/wdgt_x/transcripts?id=wdgt_x&thread_id=wct_someone_else',
		});
		const res = mockRes();
		await transcriptsHandler(req, res);
		expect(res.statusCode).toBe(404);
		expect(parseJson(res).error).toBe('not_found');
		// The message query must never run once the thread lookup came back empty.
		expect(sqlMock.mock.calls.some((c) => /from widget_chat_messages/i.test(sqlText(c)))).toBe(false);
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
