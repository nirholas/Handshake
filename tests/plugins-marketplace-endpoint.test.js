/**
 * api/plugins/[action].js, the plugin marketplace endpoint behind
 * /api/plugins/{categories,list,import,publish}, /api/plugins/:id and
 * /api/plugins/:id/install.
 *
 * Postgres, the rate limiter, auth, CSRF, and the SSRF-guarded outbound fetch
 * are all mocked, so every branch runs deterministically with no Neon branch and
 * no network: the visibility rules, the cursor guard, the install dedupe, and
 * the import failure modes are each reachable from here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: async () => ({ pressured: false }),
}));

const state = {
	rateOk: true,
	installDedupeOk: true,
	session: null,
	bearer: null,
	csrfOk: true,
	fetchImpl: null,
};

const ok = () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 });
const denied = () => ({ success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 });

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		widgetRead: vi.fn(async () => (state.rateOk ? ok() : denied())),
		pluginImportIp: vi.fn(async () => (state.rateOk ? ok() : denied())),
		pluginPublishUser: vi.fn(async () => (state.rateOk ? ok() : denied())),
		pluginInstallDedupe: vi.fn(async () => (state.installDedupeOk ? ok() : denied())),
	},
	clientIp: () => '203.0.113.7',
}));

vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: async () => state.session,
	authenticateBearer: async () => state.bearer,
	extractBearer: (req) => {
		const h = req.headers?.authorization || '';
		return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
	},
}));

vi.mock('../api/_lib/csrf.js', () => ({
	requireCsrf: async (_req, res) => {
		if (state.csrfOk) return true;
		res.statusCode = 403;
		res.end(JSON.stringify({ error: 'csrf_missing' }));
		return false;
	},
}));

vi.mock('../api/_lib/ssrf-guard.js', async () => {
	const actual = await vi.importActual('../api/_lib/ssrf-guard.js');
	return {
		...actual,
		fetchSafePublicUrlPinned: (...a) => state.fetchImpl(...a),
	};
});

const { SsrfBlockedError, MaxBytesExceededError } = await import('../api/_lib/ssrf-guard.js');
const { default: handler } = await import('../api/plugins/[action].js');

const PUBLIC_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = '99999999-8888-4777-8666-555555555555';

function pluginRow(over = {}) {
	return {
		id: PUBLIC_ID,
		identifier: 'web-search',
		manifest_url: null,
		manifest_json: { identifier: 'web-search' },
		name: 'Web Search',
		description: 'Search the web.',
		category: 'web-search',
		tags: ['search'],
		install_count: 3,
		avg_rating: '4.50',
		author_id: null,
		author_display_name: null,
		created_at: '2026-05-02T07:43:09.276Z',
		...over,
	};
}

function makeReq({ method = 'GET', path, body = null, headers = {} } = {}) {
	const req = {
		method,
		url: path,
		headers: { origin: 'https://three.ws', ...headers },
		socket: { remoteAddress: '203.0.113.7' },
	};
	if (body !== null) {
		req.headers['content-type'] = req.headers['content-type'] || 'application/json';
		req.body = body;
	}
	return req;
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null, writableEnded: false, headersSent: false };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b ?? r._b; r.writableEnded = true; };
	r.json = () => (r._b ? JSON.parse(r._b) : undefined);
	return r;
}

async function call(opts) {
	const res = makeRes();
	await handler(makeReq(opts), res);
	return res;
}

// The handler builds its queries with tagged templates, so the joined static
// fragments are the only readable form of "what SQL did it actually run".
function lastQueryText() {
	const call = sqlMock.mock.calls.at(-1);
	return call ? call[0].join(' ? ') : '';
}
function allQueryText() {
	return sqlMock.mock.calls.map((c) => c[0].join(' ? ')).join('\n');
}

beforeEach(() => {
	state.rateOk = true;
	state.installDedupeOk = true;
	state.session = null;
	state.bearer = null;
	state.csrfOk = true;
	state.fetchImpl = async () => new Response('{}', { status: 200 });
	sqlMock.mockReset().mockResolvedValue([]);
});

describe('GET /api/plugins/list', () => {
	it('returns the page and a next_cursor when more rows exist', async () => {
		sqlMock.mockResolvedValue([pluginRow(), pluginRow({ id: 'b' }), pluginRow({ id: 'c' })]);
		const res = await call({ path: '/api/plugins/list?limit=2' });
		expect(res.statusCode).toBe(200);
		const { items, next_cursor } = res.json().data;
		expect(items).toHaveLength(2);
		expect(next_cursor).toBe('2');
		expect(items[0].avg_rating).toBe(4.5);
	});

	it('rejects a cursor that is not a non-negative integer instead of 500ing', async () => {
		// The cursor lands in OFFSET. Number('abc') is NaN, and NaN reaching
		// Postgres raised a query error the wrapper surfaced as an opaque 500 for
		// what is plainly a client fault.
		for (const cursor of ['abc', '-1', '1.5', '1e3abc']) {
			const res = await call({ path: `/api/plugins/list?cursor=${cursor}` });
			expect(res.statusCode, cursor).toBe(400);
			expect(res.json().error).toBe('validation_error');
		}
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('serves the bare collection path as the list', async () => {
		sqlMock.mockResolvedValue([pluginRow()]);
		const res = await call({ path: '/api/plugins' });
		expect(res.statusCode).toBe(200);
		expect(res.json().data.items).toHaveLength(1);
	});

	it('only ever lists public, undeleted rows', async () => {
		await call({ path: '/api/plugins/list' });
		expect(lastQueryText()).toContain('p.is_public = true');
		expect(lastQueryText()).toContain('p.deleted_at IS NULL');
	});

	it('breaks ORDER BY ties on the id so OFFSET paging cannot repeat or skip a row', async () => {
		// Every seeded plugin shares one created_at and install_count 0, so without a
		// unique final key Postgres ordered the ties differently per query: paging at
		// limit=2 returned one plugin twice and never showed another at all.
		await call({ path: '/api/plugins/list' });
		expect(lastQueryText()).toMatch(/p\.created_at DESC,\s*p\.id DESC/);
	});

	it('escapes LIKE wildcards so a search for "50%" is taken literally', async () => {
		await call({ path: '/api/plugins/list?q=50%25_x' });
		expect(sqlMock.mock.calls.at(-1)).toContain('%50\\%\\_x%');
	});

	it('answers 429 when the browse bucket is spent', async () => {
		state.rateOk = false;
		const res = await call({ path: '/api/plugins/list' });
		expect(res.statusCode).toBe(429);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/plugins/:id', () => {
	it('serves a public plugin', async () => {
		sqlMock.mockResolvedValue([pluginRow()]);
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}` });
		expect(res.statusCode).toBe(200);
		expect(res.json().data.plugin.identifier).toBe('web-search');
	});

	it('gates an unpublished plugin behind its author', async () => {
		// is_public:false is a real publish option; reading by id alone used to
		// hand an unpublished manifest to anyone holding the UUID.
		await call({ path: `/api/plugins/${PUBLIC_ID}` });
		expect(lastQueryText()).toContain('p.is_public = true OR p.author_id =');
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}` });
		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe('not_found');
	});

	it('passes the session user as the viewer so an author sees their own draft', async () => {
		state.session = { id: USER_ID };
		sqlMock.mockResolvedValue([pluginRow({ author_id: USER_ID, author_display_name: 'QA' })]);
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}` });
		expect(res.statusCode).toBe(200);
		expect(sqlMock.mock.calls.at(-1)).toContain(USER_ID);
		expect(res.json().data.plugin.author).toEqual({ id: USER_ID, display_name: 'QA' });
	});

	it('404s a segment that is neither an action nor a UUID', async () => {
		const res = await call({ path: '/api/plugins/not-a-uuid' });
		expect(res.statusCode).toBe(404);
		expect(res.json().error_description).toBe('unknown plugin action');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a write method with 405', async () => {
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}`, method: 'POST', body: {} });
		expect(res.statusCode).toBe(405);
	});
});

describe('POST /api/plugins/:id/install', () => {
	it('404s a plugin that does not exist instead of reporting success', async () => {
		// The counter UPDATE matched no row and the handler answered {ok:true}
		// regardless, so a typo'd id looked exactly like a real install.
		sqlMock.mockResolvedValue([]);
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}/install`, method: 'POST' });
		expect(res.statusCode).toBe(404);
		expect(allQueryText()).not.toContain('UPDATE plugins SET install_count');
	});

	it('counts the first install and reports the new total', async () => {
		sqlMock
			.mockResolvedValueOnce([{ id: PUBLIC_ID, install_count: 3 }])
			.mockResolvedValueOnce([{ install_count: 4 }]);
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}/install`, method: 'POST' });
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ ok: true, counted: true, install_count: 4 });
	});

	it('answers 200 counted:false on a repeat rather than a 429 the client must special-case', async () => {
		state.installDedupeOk = false;
		sqlMock.mockResolvedValueOnce([{ id: PUBLIC_ID, install_count: 4 }]);
		const res = await call({ path: `/api/plugins/${PUBLIC_ID}/install`, method: 'POST' });
		expect(res.statusCode).toBe(200);
		expect(res.json().data).toEqual({ ok: true, counted: false, install_count: 4 });
		expect(allQueryText()).not.toContain('UPDATE plugins SET install_count');
	});

	it('applies the same visibility rule as detail', async () => {
		await call({ path: `/api/plugins/${PUBLIC_ID}/install`, method: 'POST' });
		expect(allQueryText()).toContain('is_public = true OR author_id =');
	});
});

describe('POST /api/plugins/publish', () => {
	const manifest = {
		identifier: 'my-plugin',
		meta: { title: 'My Plugin', description: 'Does a thing.' },
		api: [{ name: 'do_thing', description: 'Does the thing' }],
	};

	it('requires authentication', async () => {
		const res = await call({
			path: '/api/plugins/publish',
			method: 'POST',
			body: { manifest_json: manifest },
		});
		expect(res.statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('requires a CSRF token on a cookie session', async () => {
		// The session cookie rides along on any cross-site POST, so the
		// double-submit token is the only thing separating a real publish from one
		// a hostile page triggered in the victim's browser.
		state.session = { id: USER_ID };
		state.csrfOk = false;
		const res = await call({
			path: '/api/plugins/publish',
			method: 'POST',
			body: { manifest_json: manifest },
		});
		expect(res.statusCode).toBe(403);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('upserts and answers with a fully populated author', async () => {
		state.session = { id: USER_ID };
		sqlMock
			.mockResolvedValueOnce([
				pluginRow({ identifier: 'my-plugin', name: 'My Plugin', author_id: USER_ID }),
			])
			.mockResolvedValueOnce([{ display_name: 'QA Audit' }]);
		const res = await call({
			path: '/api/plugins/publish',
			method: 'POST',
			body: { manifest_json: manifest },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().data.plugin.author).toEqual({ id: USER_ID, display_name: 'QA Audit' });
		expect(allQueryText()).toContain('ON CONFLICT (identifier, author_id) DO UPDATE');
	});

	it('rejects a manifest missing its required fields', async () => {
		state.session = { id: USER_ID };
		for (const [bad, expected] of [
			[{ meta: { title: 'x' }, api: [{ name: 'a', description: 'b' }] }, 'Missing identifier'],
			[{ identifier: 'ok', api: [{ name: 'a', description: 'b' }] }, 'Missing meta.title'],
			[{ identifier: 'ok', meta: { title: 'x' }, api: [] }, 'non-empty array'],
			[
				{ identifier: 'a'.repeat(200), meta: { title: 'x' }, api: [{ name: 'a', description: 'b' }] },
				'128 characters or fewer',
			],
			[
				{
					identifier: 'ok',
					meta: { title: 'x' },
					api: Array.from({ length: 101 }, (_, i) => ({ name: `t${i}`, description: 'd' })),
				},
				'at most 100 tools',
			],
			// api[] entries are handed straight to the model provider as tool
			// definitions by every installer, and both Anthropic and OpenAI reject a name
			// outside [A-Za-z0-9_-]{1,64}. A manifest that got past this broke chat for
			// everyone who installed it.
			[
				{ identifier: 'ok', meta: { title: 'x' }, api: ['not-an-object'] },
				'every api entry must be a JSON object',
			],
			[
				{ identifier: 'ok', meta: { title: 'x' }, api: [{ name: { a: 1 }, description: 'd' }] },
				'needs a name, given as a string',
			],
			[
				{ identifier: 'ok', meta: { title: 'x' }, api: [{ name: 'bad name!', description: 'd' }] },
				'letters, digits, underscores, or hyphens',
			],
			[
				{ identifier: 'ok', meta: { title: 'x' }, api: [{ name: 'ok_tool', description: '   ' }] },
				'needs a non-empty description',
			],
			[
				{
					identifier: 'ok',
					meta: { title: 'x' },
					api: [{ name: 'ok_tool', description: 'd'.repeat(1025) }],
				},
				'1024 characters or fewer',
			],
			// The manifest is stored whole and re-served on every list and detail read,
			// so publish inherits the same 64KB ceiling the import fetch caps the
			// transfer at.
			[
				{
					identifier: 'ok',
					meta: { title: 'x', description: 'y'.repeat(65_600) },
					api: [{ name: 'ok_tool', description: 'd' }],
				},
				'64KB or smaller',
			],
		]) {
			const res = await call({
				path: '/api/plugins/publish',
				method: 'POST',
				body: { manifest_json: bad },
			});
			expect(res.statusCode).toBe(422);
			expect(res.json().error_description).toContain(expected);
		}
		expect(sqlMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/plugins/import', () => {
	it('requires an http(s) manifest_url', async () => {
		for (const [body, expected] of [
			[{}, 'manifest_url is required'],
			[{ manifest_url: 'notaurl' }, 'not a valid URL'],
			[{ manifest_url: 'file:///etc/passwd' }, 'must be http or https'],
		]) {
			const res = await call({ path: '/api/plugins/import', method: 'POST', body });
			expect(res.statusCode).toBe(400);
			expect(res.json().error_description).toContain(expected);
		}
	});

	it('reports an SSRF-blocked host as a client validation error', async () => {
		state.fetchImpl = async () => {
			throw new SsrfBlockedError('host 169.254.169.254 is a blocked address');
		};
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'http://169.254.169.254/latest/meta-data/' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error_description).toContain('blocked address');
	});

	it('caps the transfer instead of buffering an oversized response', async () => {
		// The old code read the whole body and measured it afterwards, so a
		// hostile host could stream gigabytes into the instance before the check.
		let opts;
		state.fetchImpl = async (_url, _init, o) => {
			opts = o;
			throw new MaxBytesExceededError(9_000_000, 65_536);
		};
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'https://example.com/huge.json' },
		});
		expect(opts.maxBytes).toBe(65_536);
		expect(res.statusCode).toBe(422);
		expect(res.json().error_description).toContain('64KB limit');
	});

	it('surfaces a non-2xx upstream as fetch_failed', async () => {
		state.fetchImpl = async () => new Response('nope', { status: 404 });
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'https://example.com/missing.json' },
		});
		expect(res.statusCode).toBe(422);
		expect(res.json().error).toBe('fetch_failed');
	});

	it('validates the fetched manifest and echoes back its source URL', async () => {
		const manifest = {
			identifier: 'remote-plugin',
			meta: { title: 'Remote' },
			api: [{ name: 'go', description: 'go' }],
		};
		state.fetchImpl = async () => new Response(JSON.stringify(manifest), { status: 200 });
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'https://example.com/manifest.json' },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().data.manifest._manifest_url).toBe('https://example.com/manifest.json');
		// Import never writes: the client decides whether to install locally.
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('names the real problem when the URL serves a web page instead of JSON', async () => {
		// Linking a repository page rather than the raw file is the common way to land
		// here, and the bare parse message ("Unexpected token '<'") did not say so.
		state.fetchImpl = async () => new Response('<!doctype html><title>repo</title>', { status: 200 });
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'https://example.com/blob/main/manifest.json' },
		});
		expect(res.statusCode).toBe(422);
		expect(res.json().error).toBe('invalid_manifest');
		expect(res.json().error_description).toContain('did not return JSON');
	});

	it('rejects fetched JSON that is not a plugin manifest', async () => {
		state.fetchImpl = async () => new Response('{"latest":"1.0.0"}', { status: 200 });
		const res = await call({
			path: '/api/plugins/import',
			method: 'POST',
			body: { manifest_url: 'https://example.com/dist-tags.json' },
		});
		expect(res.statusCode).toBe(422);
		expect(res.json().error).toBe('invalid_manifest');
	});
});

describe('GET /api/plugins/categories', () => {
	it('counts only public, undeleted rows and lets the edge cache it', async () => {
		sqlMock.mockResolvedValue([{ category: 'tools', count: 4 }]);
		const res = await call({ path: '/api/plugins/categories' });
		expect(res.statusCode).toBe(200);
		expect(res.json().data.categories).toEqual([{ slug: 'tools', count: 4 }]);
		expect(res.getHeader('cache-control')).toBe('public, max-age=60');
		expect(lastQueryText()).toContain('is_public = true AND deleted_at IS NULL');
	});

	it('answers a preflight without touching the database', async () => {
		const res = await call({ path: '/api/plugins/categories', method: 'OPTIONS' });
		expect(res.statusCode).toBe(204);
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
