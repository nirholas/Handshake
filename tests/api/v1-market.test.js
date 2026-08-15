// GET /api/v1/market/{intel,projects}: the two aixbt-backed reads under the
// versioned /api/v1 surface.
//
// Both doors take NO client credential: the deployment holds the upstream key.
// So the case that matters most here is whose fault a failure is. When aixbt
// stopped accepting our key, these two handlers relayed its raw 401 with its
// own wording, which reads to an agent as "your credentials were rejected" and
// sends it into a re-auth loop it can never win, while the older /api/aixbt/*
// doors had long since classified that as a 503 deployment fault. The
// classification now lives in one shared place (api/_lib/aixbt.js
// `mapAixbtFailure`, unit-pinned in tests/aixbt-failure-map.test.js); these
// cases pin that the v1 doors actually answer through it.
//
// The upstream client is mocked at the module boundary with the exact error
// shape api/_lib/aixbt.js throws, so no network call is made.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

let globalQuotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		aixbtGlobal: async () =>
			globalQuotaOk
				? { success: true, limit: 300, remaining: 299, reset: Date.now() + 60_000 }
				: { success: false, limit: 300, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.12',
}));

let intelImpl = async () => ({ intel: [], pagination: null });
let projectsImpl = async () => ({ projects: [], pagination: null });
vi.mock('../../api/_lib/aixbt.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		// The classifier stays REAL: it is the behavior under test.
		aixbtEnabled: () => true,
		getIntel: (...a) => intelImpl(...a),
		getProjects: (...a) => projectsImpl(...a),
	};
});

/** The shape api/_lib/aixbt.js throws for a non-2xx upstream response. */
function upstreamError(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

beforeEach(() => {
	globalQuotaOk = true;
	intelImpl = async () => ({ intel: [], pagination: null });
	projectsImpl = async () => ({ projects: [], pagination: null });
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url, host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
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

async function dispatch(modulePath, url) {
	const mod = await import(modulePath);
	const res = makeRes();
	await mod.default(makeReq({ url }), res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

const DOORS = [
	{
		label: 'intel',
		module: '../../api/v1/market/intel.js',
		url: '/api/v1/market/intel?limit=2',
		set: (fn) => { intelImpl = fn; },
		ok: () => ({
			intel: [{ category: 'narrative', description: 'real-shaped item', source: 'aixbt' }],
			pagination: { limit: 2, page: 1 },
		}),
		key: 'intel',
	},
	{
		label: 'projects',
		module: '../../api/v1/market/projects.js',
		url: '/api/v1/market/projects?limit=2',
		set: (fn) => { projectsImpl = fn; },
		ok: () => ({
			projects: [{ id: 'three-ws', name: 'three.ws', ticker: 'THREE', source: 'aixbt' }],
			pagination: { limit: 2, page: 1 },
		}),
		key: 'projects',
	},
];

describe.each(DOORS)('GET /api/v1/market/$label', (door) => {
	it('returns the upstream rows with the source named', async () => {
		door.set(async () => door.ok());
		const { res, body } = await dispatch(door.module, door.url);
		expect(res.statusCode).toBe(200);
		expect(body.data[door.key]).toHaveLength(1);
		expect(body.data.source).toBe('aixbt');
		expect(body.data.pagination).toEqual({ limit: 2, page: 1 });
	});

	for (const status of [401, 403]) {
		it(`answers a ${status} from aixbt as a 503, never as the caller's auth failure`, async () => {
			door.set(async () => {
				throw upstreamError(`aixbt /${door.key} failed: Unauthorized`, status, 'aixbt_unauthorized');
			});
			const { res, body } = await dispatch(door.module, door.url);
			// The regression: this used to be relayed verbatim as a 401 on a door
			// that takes no client credential.
			expect(res.statusCode).toBe(503);
			expect(body.error).toBe('aixbt_unauthorized');
			expect(body.error_description).toMatch(/deployment key/);
			expect(body.error_description).not.toMatch(/Unauthorized/);
		});
	}

	it('relays upstream throttling as a 429 the caller can back off from', async () => {
		door.set(async () => {
			throw upstreamError('aixbt rate limit exceeded', 429, 'aixbt_rate_limited');
		});
		const { res, body } = await dispatch(door.module, door.url);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('aixbt_rate_limited');
	});

	it('relays an upstream outage as a 504 instead of a blank internal error', async () => {
		door.set(async () => {
			throw upstreamError('aixbt unreachable: fetch failed', 504, 'aixbt_upstream_error');
		});
		const { res, body } = await dispatch(door.module, door.url);
		expect(res.statusCode).toBe(504);
		expect(body.error).toBe('aixbt_upstream_error');
	});

	it('sanitizes an internal fault instead of leaking it', async () => {
		door.set(async () => {
			throw new TypeError('cannot read properties of undefined');
		});
		const { res, body } = await dispatch(door.module, door.url);
		expect(res.statusCode).toBe(500);
		expect(body.error).toBe('internal_error');
		expect(res._body).not.toContain('cannot read properties');
	});

	it('429s when the shared per-deployment aixbt ceiling is spent', async () => {
		globalQuotaOk = false;
		door.set(async () => door.ok());
		const { res, body } = await dispatch(door.module, door.url);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('never lets an error response be cached', async () => {
		door.set(async () => {
			throw upstreamError('aixbt down', 502, 'aixbt_upstream_error');
		});
		const { res } = await dispatch(door.module, door.url);
		expect(res.getHeader('cache-control')).toBe('no-store');
	});
});
