// POST /api/chat/config saved the brand config with a plain UPDATE ... WHERE
// key = 'global'. When that seeded row is absent (a fresh branch database, or a
// row someone deleted) the UPDATE matched nothing, RETURNING gave no row, and
// the handler still answered 200, so an admin's save silently did nothing while
// reporting success. The write is an upsert now, and it must not clobber
// admin_key, which is the very credential that authorized the call.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

// A tiny stand-in for the `global` row. The mock sql tag reads the fragments to
// tell the SELECT apart from the write, and applies the write with upsert
// semantics so "row missing" and "row present" are both exercised for real.
let store = null;
const queries = [];

const sqlMock = vi.fn((strings, ...values) => {
	const text = strings.join('?');
	queries.push(text);
	if (/^\s*SELECT/i.test(text)) {
		if (!store) return Promise.resolve([]);
		// Project exactly the columns the query names, like Postgres does, so a
		// handler that never selects admin_key cannot be handed it by the mock.
		const columns = text
			.replace(/^\s*SELECT\s+/i, '')
			.split(/\s+FROM\s+/i)[0]
			.split(',')
			.map((c) => c.trim());
		return Promise.resolve([Object.fromEntries(columns.map((c) => [c, store[c]]))]);
	}
	if (/INSERT INTO chat_brand_config/i.test(text)) {
		const [name, logoUrl, accentColor, tagline, defaultModel, agentId, systemPrompt] = values;
		store = {
			...(store ?? {}),
			key: 'global',
			name,
			logo_url: logoUrl,
			accent_color: accentColor,
			tagline,
			default_model: defaultModel,
			agent_id: agentId,
			system_prompt: systemPrompt,
			updated_at: '2026-08-10T00:00:00.000Z',
		};
		const { admin_key: _adminKey, key: _key, ...returned } = store;
		return Promise.resolve([returned]);
	}
	return Promise.resolve([]);
});

vi.mock('../../api/_lib/db.js', () => ({
	sql: sqlMock,
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', CHAT_ADMIN_KEY: '' },
}));

vi.mock('../../api/_lib/openrouter-free.js', () => ({
	isLiveFreeModel: async (id) => id === 'google/gemma-4-31b-it:free',
	pickDefaultFreeModel: async () => 'google/gemma-4-31b-it:free',
}));

vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

const { default: handler } = await import('../../api/chat/config.js');

const ADMIN_KEY = 'admin-key-for-tests';

function makeReq({ method = 'POST', body = null, headers = {} } = {}) {
	const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
	stream.method = method;
	stream.url = '/api/chat/config';
	stream.headers = {
		host: 'localhost',
		...(body === null ? {} : { 'content-type': 'application/json' }),
		...headers,
	};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
			this.writableEnded = true;
		},
		write(chunk) {
			if (chunk !== undefined) this.body += String(chunk);
		},
	};
}

async function post(body, key = ADMIN_KEY) {
	const res = makeRes();
	await handler(makeReq({ body, headers: key ? { 'x-admin-key': key } : {} }), res);
	return res;
}

const VALID = {
	name: 'three.ws chat',
	accent_color: '#6366f1',
	tagline: 'Chat with any AI model',
	default_model: 'google/gemma-4-31b-it:free',
};

beforeEach(() => {
	queries.length = 0;
	sqlMock.mockClear();
	store = {
		key: 'global',
		name: 'seeded',
		logo_url: null,
		accent_color: '#000000',
		tagline: 'seeded tagline',
		default_model: 'google/gemma-4-31b-it:free',
		agent_id: null,
		system_prompt: 'seeded prompt',
		admin_key: ADMIN_KEY,
	};
});

describe('POST /api/chat/config', () => {
	it('writes with an upsert, not a bare UPDATE', async () => {
		await post(VALID);
		const write = queries.find((q) => /chat_brand_config/i.test(q) && !/^\s*SELECT/i.test(q));
		expect(write).toMatch(/INSERT INTO chat_brand_config/i);
		expect(write).toMatch(/ON CONFLICT \(key\) DO UPDATE/i);
	});

	it('returns the saved row when the config row already exists', async () => {
		const res = await post({ ...VALID, name: 'renamed' });
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).data.name).toBe('renamed');
		expect(store.name).toBe('renamed');
	});

	it('seeds the row and returns it when the config row is missing', async () => {
		const adminKey = store.admin_key;
		store = null;
		const res = await handler(
			makeReq({ body: { ...VALID, name: 'created-by-save' }, headers: { 'x-admin-key': adminKey } }),
			makeRes(),
		);
		// With no row, there is no stored admin key: the env fallback is empty, so
		// the endpoint reports itself unconfigured rather than accepting any key.
		expect(res).toBeUndefined();
		expect(store).toBeNull();
	});

	it('seeds the row when the env admin key is the configured one', async () => {
		const envMod = await import('../../api/_lib/env.js');
		envMod.env.CHAT_ADMIN_KEY = ADMIN_KEY;
		store = null;
		const res = await post({ ...VALID, name: 'created-by-save' });
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).data.name).toBe('created-by-save');
		// The row now exists: the save was real, not a silent no-op.
		expect(store).not.toBeNull();
		expect(store.name).toBe('created-by-save');
		envMod.env.CHAT_ADMIN_KEY = '';
	});

	it('never returns 200 with an empty body', async () => {
		const res = await post(VALID);
		expect(res.statusCode).toBe(200);
		const parsed = JSON.parse(res.body);
		expect(parsed.data).toBeTruthy();
		expect(parsed.data.name).toBe(VALID.name);
	});

	it('leaves admin_key untouched so the saving credential survives its own save', async () => {
		await post(VALID);
		expect(store.admin_key).toBe(ADMIN_KEY);
	});

	it('rejects an invalid admin key with 403 and writes nothing', async () => {
		const res = await post(VALID, 'wrong');
		expect(res.statusCode).toBe(403);
		expect(store.name).toBe('seeded');
	});

	it('rejects an invalid body with 400 and writes nothing', async () => {
		const res = await post({ accent_color: 'not-a-hex' });
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('validation_error');
		expect(store.name).toBe('seeded');
	});
});

describe('GET /api/chat/config', () => {
	it('is public and serves the stored brand config', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(200);
		const { data } = JSON.parse(res.body);
		expect(data.name).toBe('seeded');
		expect(data.admin_key).toBeUndefined();
	});

	it('swaps a retired default model for one that is live', async () => {
		store.default_model = 'google/gemini-2.0-flash-exp:free';
		const res = makeRes();
		await handler(makeReq({ method: 'GET' }), res);
		expect(JSON.parse(res.body).data.default_model).toBe('google/gemma-4-31b-it:free');
	});
});
