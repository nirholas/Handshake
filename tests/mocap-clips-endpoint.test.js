// api/mocap/clips.js + api/mocap/[id].js — the mocap clip store's HTTP surface.
//
// Covers the success path and the failure path of every method, plus the two
// boundaries that used to be wrong: the `:idOrSlug` segment (the published
// @three-ws/mocap client sends slugs, which the endpoint rejected and the route
// table never even delivered) and the per-owner ambiguity a slug carries.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A tagged-template recorder that also honours the composable-fragment pattern
// api/_lib/db.js provides: a `sql` call whose text is not a whole statement is a
// fragment spliced into a parent query, so it must return a plain value rather
// than consume a queued result set.
const calls = [];
let queue = [];
function render(strings, values) {
	let text = '';
	strings.forEach((s, i) => {
		text += s;
		if (i < values.length) text += `$${i + 1}`;
	});
	return text.replace(/\s+/g, ' ').trim();
}
const sqlMock = vi.fn((...args) => {
	if (Array.isArray(args[0]) && Array.isArray(args[0].raw)) {
		const [strings, ...values] = args;
		const text = render(strings, values);
		const fragment = !/^(select|insert|update|delete|with)\b/i.test(text);
		const rec = { text, values, fragment };
		calls.push(rec);
		if (fragment) return rec;
		return Promise.resolve(queue.length ? queue.shift() : []);
	}
	const [text, params] = args;
	calls.push({ text: String(text).replace(/\s+/g, ' ').trim(), values: params, fragment: false });
	return Promise.resolve(queue.length ? queue.shift() : []);
});
const statements = () => calls.filter((c) => !c.fragment);
const fragments = () => calls.filter((c) => c.fragment);

vi.mock('../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const getSessionUserMock = vi.fn();
const authenticateBearerMock = vi.fn();
const extractBearerMock = vi.fn();
vi.mock('../api/_lib/auth.js', () => ({
	getSessionUser: (...a) => getSessionUserMock(...a),
	authenticateBearer: (...a) => authenticateBearerMock(...a),
	extractBearer: (...a) => extractBearerMock(...a),
	hasScope: (granted, required) => {
		const g = new Set((granted || '').split(/\s+/).filter(Boolean));
		return required.split(/\s+/).every((s) => g.has(s));
	},
}));

const requireCsrfMock = vi.fn(async () => true);
vi.mock('../api/_lib/csrf.js', () => ({ requireCsrf: (...a) => requireCsrfMock(...a) }));

const avatarPatchMock = vi.fn(async () => ({ success: true, limit: 20, remaining: 19, reset: 0 }));
vi.mock('../api/_lib/rate-limit.js', () => ({ limits: { avatarPatch: (...a) => avatarPatchMock(...a) } }));

vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const { default: clipsHandler } = await import('../api/mocap/clips.js');
const { default: clipHandler } = await import('../api/mocap/[id].js');

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const CLIP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mkReq({ method = 'GET', url = '/api/mocap/clips', headers = {}, body = null, query } = {}) {
	const hdrs = { ...headers };
	if (body != null && !hdrs['content-type']) hdrs['content-type'] = 'application/json';
	return {
		method,
		url,
		headers: hdrs,
		query,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		// A real ServerResponse has getHeader, and http.js's secure-by-default
		// cache policy reads it to decide whether the handler already chose a
		// Cache-Control. A mock without it makes every response look uncached.
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

function clipRow(over = {}) {
	return {
		id: CLIP,
		owner_id: OWNER,
		avatar_id: null,
		slug: 'wink',
		name: 'Wink',
		description: null,
		kind: 'face',
		format: 'three.ws.face-mocap.v1',
		duration_ms: 1000,
		frame_count: 2,
		frames: [{ t: 0, shapes: { eyeBlinkLeft: 0 } }],
		tags: ['emote'],
		visibility: 'public',
		price_amount: null,
		price_currency: null,
		play_count: 7,
		created_at: new Date('2026-06-01T00:00:00Z'),
		updated_at: new Date('2026-06-01T00:00:00Z'),
		...over,
	};
}

beforeEach(() => {
	calls.length = 0;
	queue = [];
	sqlMock.mockClear();
	getSessionUserMock.mockReset().mockResolvedValue(null);
	authenticateBearerMock.mockReset().mockResolvedValue(null);
	extractBearerMock.mockReset().mockReturnValue(null);
	requireCsrfMock.mockClear().mockResolvedValue(true);
	avatarPatchMock.mockClear().mockResolvedValue({ success: true, limit: 20, remaining: 19, reset: 0 });
});

describe('GET /api/mocap/clips', () => {
	it('serves an anonymous caller public clips only, with a shareable cache header', async () => {
		queue = [[clipRow()]];
		const res = mkRes();
		await clipsHandler(mkReq({ url: '/api/mocap/clips' }), res);

		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.items).toHaveLength(1);
		expect(out.items[0]).toMatchObject({ id: CLIP, slug: 'wink', owner: 'other', play_count: 7 });
		expect(out.next_cursor).toBeNull();
		expect(statements()[0].text).toContain(`visibility = 'public'`);
		expect(res.headers['cache-control']).toContain('s-maxage=60');
	});

	it('scopes a signed-in caller to their own clips and marks them as theirs', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		queue = [[clipRow({ visibility: 'private' })]];
		const res = mkRes();
		await clipsHandler(mkReq({ url: '/api/mocap/clips' }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).items[0].owner).toBe('self');
		expect(statements()[0].text).toContain('owner_id = $1');
		expect(statements()[0].values[0]).toBe(OWNER);
		expect(res.headers['cache-control']).toBe('private, max-age=0');
	});

	it('rejects a kind no row can ever carry instead of answering an unfiltered page', async () => {
		const res = mkRes();
		await clipsHandler(mkReq({ url: '/api/mocap/clips?kind=bogus' }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_request');
		expect(statements()).toHaveLength(0);
	});

	it('rejects a malformed cursor rather than restarting at page one', async () => {
		const res = mkRes();
		await clipsHandler(mkReq({ url: '/api/mocap/clips?cursor=not-a-cursor' }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_cursor');
		expect(statements()).toHaveLength(0);
	});

	it('round-trips its own next_cursor into a bounded second page', async () => {
		queue = [[clipRow({ id: CLIP }), clipRow({ id: OTHER })]];
		const first = mkRes();
		await clipsHandler(mkReq({ url: '/api/mocap/clips?limit=1' }), first);
		const { next_cursor: cursor } = parse(first);
		expect(cursor).toBeTruthy();

		calls.length = 0;
		queue = [[]];
		const second = mkRes();
		await clipsHandler(mkReq({ url: `/api/mocap/clips?limit=1&cursor=${encodeURIComponent(cursor)}` }), second);

		expect(second.statusCode).toBe(200);
		const stmt = statements()[0];
		expect(stmt.text).toContain('created_at < $');
		expect(stmt.values.some((v) => v instanceof Date)).toBe(true);
	});

	it('refuses an unauthenticated create', async () => {
		const res = mkRes();
		await clipsHandler(mkReq({ method: 'POST', body: {} }), res);

		expect(res.statusCode).toBe(401);
		expect(parse(res).error).toBe('unauthorized');
	});
});

describe('POST /api/mocap/clips', () => {
	const recording = {
		format: 'three.ws.face-mocap.v1',
		duration: 1,
		frames: [{ t: 0, shapes: { eyeBlinkLeft: 0.2 } }],
	};

	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
	});

	it('stores a recording and answers 201 with the persisted row', async () => {
		queue = [[], [clipRow()]]; // dup-slug probe, then the insert
		const res = mkRes();
		await clipsHandler(mkReq({ method: 'POST', body: { name: 'Wink', slug: 'wink', clip: recording } }), res);

		expect(res.statusCode).toBe(201);
		expect(parse(res).clip.slug).toBe('wink');
		const insert = statements().find((c) => c.text.startsWith('insert'));
		expect(insert.values).toContain(OWNER);
		expect(insert.values).toContain('face');
	});

	it('rejects a format the replay runtime cannot drive', async () => {
		const res = mkRes();
		await clipsHandler(
			mkReq({ method: 'POST', body: { name: 'Wink', clip: { ...recording, format: 'three.ws.face-mocap.v9' } } }),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('unsupported_format');
		expect(statements()).toHaveLength(0);
	});

	it('answers the loser of a slug race 409 rather than 500ing on the unique index', async () => {
		queue = [[]]; // dup-slug probe comes back free for both tabs
		sqlMock.mockImplementationOnce((...args) => {
			calls.push({ text: 'select-dup', values: args, fragment: false });
			return Promise.resolve([]);
		});
		const res = mkRes();
		const err = Object.assign(new Error('duplicate key'), { code: '23505' });
		let seenInsert = false;
		sqlMock.mockImplementationOnce(() => {
			seenInsert = true;
			return Promise.reject(err);
		});
		await clipsHandler(mkReq({ method: 'POST', body: { name: 'Wink', slug: 'wink', clip: recording } }), res);

		expect(seenInsert).toBe(true);
		expect(res.statusCode).toBe(409);
		expect(parse(res).error).toBe('duplicate_slug');
	});

	it('rejects a body that is not a clip at all', async () => {
		const res = mkRes();
		await clipsHandler(mkReq({ method: 'POST', body: { name: '' } }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('validation_error');
	});
});

describe('GET /api/mocap/clips/:idOrSlug', () => {
	it('resolves a uuid in any hex case', async () => {
		queue = [[clipRow()]];
		const res = mkRes();
		await clipHandler(mkReq({ url: `/api/mocap/clips/${CLIP.toUpperCase()}`, query: { id: CLIP.toUpperCase() } }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).clip.id).toBe(CLIP);
		const selector = fragments().find((f) => f.text.startsWith('id ='));
		expect(selector.values[0]).toBe(CLIP.toUpperCase());
	});

	it('resolves the slug form the published SDK sends', async () => {
		queue = [[clipRow()]];
		const res = mkRes();
		await clipHandler(mkReq({ url: '/api/mocap/clips/wink', query: { id: 'wink' } }), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).clip.slug).toBe('wink');
		const selector = fragments().find((f) => f.text.startsWith('slug ='));
		expect(selector.values[0]).toBe('wink');
	});

	it('disambiguates a per-owner slug toward the caller and away from private rows', async () => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
		queue = [[clipRow()]];
		const res = mkRes();
		await clipHandler(mkReq({ url: '/api/mocap/clips/wink', query: { id: 'wink' } }), res);

		expect(res.statusCode).toBe(200);
		const stmt = statements()[0];
		expect(stmt.text).toContain(`visibility <> 'private'`);
		expect(stmt.text).toContain('order by (owner_id =');
		expect(stmt.values).toContain(OWNER);
	});

	it('rejects an identifier that is neither a uuid nor a slug, without touching Postgres', async () => {
		const res = mkRes();
		await clipHandler(mkReq({ url: '/api/mocap/clips/Not_A_Slug', query: { id: 'Not_A_Slug' } }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('invalid_request');
		expect(calls).toHaveLength(0);
	});

	it('hides a private clip from a bearer that lacks avatars:read, even its owner’s', async () => {
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: OWNER, scope: 'wallet:read', source: 'apikey' });
		queue = [[clipRow({ visibility: 'private' })]];
		const res = mkRes();
		await clipHandler(mkReq({ url: `/api/mocap/clips/${CLIP}`, query: { id: CLIP } }), res);

		expect(res.statusCode).toBe(404);
		expect(parse(res).error).toBe('not_found');
	});

	it('counts a play for a visitor and not for the owner', async () => {
		getSessionUserMock.mockResolvedValue({ id: OTHER });
		queue = [[clipRow()], []];
		const res = mkRes();
		await clipHandler(mkReq({ url: `/api/mocap/clips/${CLIP}`, query: { id: CLIP } }), res);
		await new Promise((r) => queueMicrotask(r));

		expect(res.statusCode).toBe(200);
		const bump = statements().find((c) => c.text.includes('play_count = play_count + 1'));
		expect(bump).toBeTruthy();
		expect(bump.values[0]).toBe(CLIP);
	});
});

describe('PATCH / DELETE /api/mocap/clips/:idOrSlug', () => {
	beforeEach(() => {
		getSessionUserMock.mockResolvedValue({ id: OWNER });
	});

	it('patches by slug scoped to the owner, so another account’s identical slug is untouched', async () => {
		queue = [[clipRow({ name: 'Slow wink' })]];
		const res = mkRes();
		await clipHandler(
			mkReq({ method: 'PATCH', url: '/api/mocap/clips/wink', query: { id: 'wink' }, body: { name: 'Slow wink' } }),
			res,
		);

		expect(res.statusCode).toBe(200);
		expect(parse(res).clip.name).toBe('Slow wink');
		const update = statements().find((c) => c.text.startsWith('update'));
		expect(update.text).toContain('owner_id = $');
		expect(update.values).toContain(OWNER);
		expect(fragments().some((f) => f.text.startsWith('slug ='))).toBe(true);
	});

	it('rejects an empty patch instead of issuing a no-op update', async () => {
		const res = mkRes();
		await clipHandler(mkReq({ method: 'PATCH', url: `/api/mocap/clips/${CLIP}`, query: { id: CLIP }, body: {} }), res);

		expect(res.statusCode).toBe(400);
		expect(statements()).toHaveLength(0);
	});

	it('soft-deletes by slug and reports a miss as not found', async () => {
		queue = [[]];
		const res = mkRes();
		await clipHandler(mkReq({ method: 'DELETE', url: '/api/mocap/clips/wink', query: { id: 'wink' } }), res);

		expect(res.statusCode).toBe(404);
		const del = statements().find((c) => c.text.startsWith('update'));
		expect(del.text).toContain('deleted_at = now()');
		expect(fragments().some((f) => f.text.startsWith('slug ='))).toBe(true);
	});

	it('requires avatars:delete before a bearer may soft-delete', async () => {
		getSessionUserMock.mockResolvedValue(null);
		extractBearerMock.mockReturnValue('tok');
		authenticateBearerMock.mockResolvedValue({ userId: OWNER, scope: 'avatars:read', source: 'apikey' });
		const res = mkRes();
		await clipHandler(mkReq({ method: 'DELETE', url: `/api/mocap/clips/${CLIP}`, query: { id: CLIP } }), res);

		expect(res.statusCode).toBe(403);
		expect(parse(res).error).toBe('insufficient_scope');
		expect(statements()).toHaveLength(0);
	});
});

describe('route table', () => {
	const routes = JSON.parse(
		fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'),
	).routes;
	const clipRoute = routes.find((r) => r.src?.startsWith('/api/mocap/clips/'));
	const re = new RegExp(`^${clipRoute.src}$`);

	it('delivers every identifier the handler knows how to answer', () => {
		expect(re.test(`/api/mocap/clips/${CLIP}`)).toBe(true);
		expect(re.test(`/api/mocap/clips/${CLIP.toUpperCase()}`)).toBe(true);
		expect(re.test('/api/mocap/clips/wink')).toBe(true);
		expect(re.test('/api/mocap/clips/my-slow-wink-2')).toBe(true);
	});

	it('does not swallow a nested path or an empty segment', () => {
		expect(re.test('/api/mocap/clips/')).toBe(false);
		expect(re.test('/api/mocap/clips/wink/frames')).toBe(false);
	});
});
