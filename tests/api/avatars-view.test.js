// POST /api/avatars/view: the gallery view tracker.
//
// Two behaviours are worth pinning because both were wrong in production. An
// avatar_id that is not a uuid used to reach Postgres as `WHERE id = $1`, raise
// 22P02, and surface to the caller as a 500 for what is a plain typo. And the
// "one view per IP per avatar" the file documented was never implemented: the
// handler drew on the shared 240/min publicIp bucket, so a single reader could
// move view_count 240 times a minute.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

let floodOk = true;
let dedupeOk = true;
const dedupeKeys = [];
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: async () => ({ success: floodOk, limit: 240, remaining: 239, reset: Date.now() + 60_000 }),
		avatarViewIp: async (key) => {
			dedupeKeys.push(key);
			return { success: dedupeOk, limit: 1, remaining: 0, reset: Date.now() + 1_800_000 };
		},
	},
	clientIp: () => '203.0.113.7',
}));

const queries = [];
vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		queries.push({ text: strings.join('?'), values });
		return Promise.resolve([]);
	},
}));

const AVATAR_ID = '6a3f1b0c-2b6e-4f1a-9d5b-8c7e2f0a1d34';

function makeReq(payload, method = 'POST') {
	const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const stream = Readable.from([Buffer.from(raw)]);
	stream.method = method;
	stream.url = '/api/avatars/view';
	stream.headers = { host: 'three.ws', 'content-type': 'application/json' };
	return stream;
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}
const body = (res) => JSON.parse(res._body);

async function call(payload, method = 'POST') {
	const mod = await import('../../api/avatars/view.js');
	const res = makeRes();
	await mod.default(makeReq(payload, method), res);
	return res;
}

beforeEach(() => {
	floodOk = true;
	dedupeOk = true;
	queries.length = 0;
	dedupeKeys.length = 0;
});

describe('counting a view', () => {
	it('increments the counter once and reports it counted', async () => {
		const res = await call({ avatar_id: AVATAR_ID });
		expect(res.statusCode).toBe(200);
		expect(body(res)).toEqual({ ok: true, counted: true });
		expect(queries).toHaveLength(1);
		expect(queries[0].text).toMatch(/UPDATE avatars/);
		expect(queries[0].values).toContain(AVATAR_ID);
	});

	it('scopes the dedupe bucket to the viewer AND the avatar', async () => {
		await call({ avatar_id: AVATAR_ID });
		expect(dedupeKeys).toEqual([`203.0.113.7:${AVATAR_ID}`]);
	});

	it('skips the write on a repeat view inside the window, without erroring', async () => {
		dedupeOk = false;
		const res = await call({ avatar_id: AVATAR_ID });
		expect(res.statusCode).toBe(200);
		expect(body(res)).toEqual({ ok: true, counted: false });
		expect(queries).toHaveLength(0);
	});
});

describe('input guards', () => {
	it.each([
		['a slug instead of an id', { avatar_id: 'not-a-uuid' }],
		['an empty body', {}],
		['a non-string id', { avatar_id: 12345 }],
	])('rejects %s with 400 and never touches the database', async (_label, payload) => {
		const res = await call(payload);
		expect(res.statusCode).toBe(400);
		expect(body(res).error).toBe('invalid_request');
		expect(queries).toHaveLength(0);
	});

	it('rejects malformed JSON with 400, not a 500', async () => {
		const res = await call('not json');
		expect(res.statusCode).toBe(400);
		expect(queries).toHaveLength(0);
	});

	it('rejects non-POST methods', async () => {
		const res = await call({ avatar_id: AVATAR_ID }, 'GET');
		expect(res.statusCode).toBe(405);
	});

	it('sheds load with a soft 200 when the per-IP flood guard trips', async () => {
		floodOk = false;
		const res = await call({ avatar_id: AVATAR_ID });
		expect(res.statusCode).toBe(200);
		expect(body(res)).toEqual({ ok: false, reason: 'rate_limited' });
		expect(queries).toHaveLength(0);
	});
});
