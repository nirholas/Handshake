// /api/chat/models appends the server-side agent loop to the live free-model
// list as a virtual model. It used to do that with `models.push(...)` on the
// array `listFreeModels()` returns, which is that module's own cache, handed
// back by reference. So every request appended one more agent row to the shared
// cache: the picker grew a duplicate per call until the 5-minute TTL refetched,
// and a non-`:free` id leaked into a cache whose contract is "free models only"
// (isLiveFreeModel / pickDefaultFreeModel read the same array).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module-level cache the real openrouter-free.js owns. Handed out by
// reference on purpose, exactly like the real one, so a mutating handler shows
// up here as a changed array.
const cachedModels = [
	{ id: 'google/gemma-4-31b-it:free', name: 'gpt-oss-20b (free)' },
	{ id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)' },
];

vi.mock('../../api/_lib/openrouter-free.js', () => ({
	listFreeModels: vi.fn(async () => cachedModels),
}));

vi.mock('../../api/agent/run.js', () => ({ AGENT_MODEL_ID: 'three-ws/agent' }));

vi.mock('../../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000' },
}));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({
	instrument: vi.fn(() => null),
	drain: vi.fn(async () => {}),
}));

const { default: handler } = await import('../../api/chat/models.js');

function makeReq(method = 'GET') {
	return { method, url: '/api/chat/models', headers: { host: 'localhost' } };
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

async function get() {
	const res = makeRes();
	await handler(makeReq(), res);
	return { res, data: JSON.parse(res.body).data };
}

beforeEach(() => {
	cachedModels.length = 0;
	cachedModels.push(
		{ id: 'google/gemma-4-31b-it:free', name: 'gpt-oss-20b (free)' },
		{ id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)' },
	);
});

describe('GET /api/chat/models', () => {
	it('lists the live free models plus exactly one agent entry', async () => {
		const { res, data } = await get();
		expect(res.statusCode).toBe(200);
		expect(data.filter((m) => m.id === 'three-ws/agent')).toHaveLength(1);
		expect(data.map((m) => m.id)).toEqual([
			'google/gemma-4-31b-it:free',
			'google/gemma-4-31b-it:free',
			'three-ws/agent',
		]);
	});

	it('never becomes the default: the agent entry is last, never first', async () => {
		const { data } = await get();
		expect(data[0].id).toBe('google/gemma-4-31b-it:free');
		expect(data.at(-1).id).toBe('three-ws/agent');
	});

	it('does not mutate the shared free-model cache', async () => {
		await get();
		await get();
		await get();
		// The cache still holds only the two real free models it started with.
		expect(cachedModels.map((m) => m.id)).toEqual([
			'google/gemma-4-31b-it:free',
			'google/gemma-4-31b-it:free',
		]);
	});

	it('returns one agent entry on every request, not one more each time', async () => {
		const counts = [];
		for (let i = 0; i < 5; i += 1) {
			const { data } = await get();
			counts.push(data.filter((m) => m.id === 'three-ws/agent').length);
		}
		expect(counts).toEqual([1, 1, 1, 1, 1]);
	});

	it('rejects a non-GET method with 405 and an Allow header', async () => {
		const res = makeRes();
		await handler(makeReq('POST'), res);
		expect(res.statusCode).toBe(405);
		expect(res.getHeader('allow')).toContain('GET');
		expect(JSON.parse(res.body).error).toBe('method_not_allowed');
	});
});
