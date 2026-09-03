// GET /api/sim-readiness: the free public physics grade.
//
// The real handler, the real grader, and a real bundled GLB run end to end; the
// only mocked seams are the two the endpoint cannot own in a test: the network
// fetch (SSRF-guarded) and the Postgres cache. Both are driven per test so the
// full status table in specs/SIM_READINESS.md is asserted rather than described,
// including the case that is deliberately NOT an error: bytes that are not glTF
// come back 200 with verdict "unreadable", because "this is not a GLB" is a
// valid grade and a client gating on `verdict` must not need a second code path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);
const REAL_GLB_PATH = ['cesium-man.glb', 'fox.glb', 'mannequin.glb'].map(avatar).find(existsSync);
const REAL_GLB = REAL_GLB_PATH ? readFileSync(REAL_GLB_PATH) : null;
const REAL_HASH = REAL_GLB ? createHash('sha256').update(REAL_GLB).digest('hex') : 'a'.repeat(64);

// What the mocked upstream serves, and what the mocked store holds. Reset per test.
let upstream;
let stored;
let puts;

class MaxBytesExceededError extends Error {
	constructor(observed, limit) {
		super(`response exceeds max bytes: ${observed} > ${limit}`);
		this.code = 'max_bytes_exceeded';
		this.status = 413;
	}
}
class SsrfBlockedError extends Error {
	constructor(reason) {
		super(reason);
		this.code = 'ssrf_blocked';
		this.status = 400;
	}
}

vi.mock('../../api/_lib/ssrf-guard.js', () => ({
	MaxBytesExceededError,
	SsrfBlockedError,
	fetchSafePublicUrlPinned: vi.fn(async () => {
		if (upstream.throws) throw upstream.throws;
		return {
			ok: upstream.status >= 200 && upstream.status < 300,
			status: upstream.status,
			headers: new Map([['content-length', String(upstream.body?.length ?? 0)]]),
			arrayBuffer: async () => upstream.body,
		};
	}),
}));

// Switchable per-IP quota, so the metered lane is asserted rather than assumed.
let rlOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiIp: async () => (rlOk
			? { success: true, limit: 30, remaining: 29, reset: Date.now() + 300_000 }
			: { success: false, limit: 30, remaining: 0, reset: Date.now() + 300_000 }),
	},
	clientIp: () => '203.0.113.9',
}));

vi.mock('../../api/_lib/sim-readiness-store.js', () => ({
	simReadinessStoreEnabled: () => true,
	getGrade: vi.fn(async (hash) => stored.get(hash) ?? null),
	putGrade: vi.fn(async (row) => {
		puts.push(row);
		const at = new Date().toISOString();
		stored.set(row.glbSha256, { report: row.report, gradedAt: at, graderVersion: row.report.grader, sourceUrl: row.sourceUrl ?? null });
		return at;
	}),
}));

beforeEach(() => {
	rlOk = true;
	upstream = { status: 200, body: REAL_GLB, throws: null };
	stored = new Map();
	puts = [];
	vi.clearAllMocks();
});

function makeReq(url, method = 'GET') {
	const stream = Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.headers = { host: 'three.ws' };
	const q = url.indexOf('?');
	stream.query = q >= 0 ? Object.fromEntries(new URLSearchParams(url.slice(q + 1))) : {};
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

async function get(url, method = 'GET') {
	const res = makeRes();
	const mod = await import('../../api/sim-readiness.js');
	await mod.default(makeReq(url, method), res);
	return { status: res.statusCode, headers: res._h, body: res._body ? JSON.parse(res._body) : null };
}

const HAS_GLB = Boolean(REAL_GLB);

describe('GET /api/sim-readiness: the request contract', () => {
	it('400s when neither src nor hash is given', async () => {
		const r = await get('/api/sim-readiness');
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/glb_url|hash/i);
		expect(r.headers['cache-control']).toBe('no-store');
	});

	it('400s on a malformed hash rather than treating it as a src', async () => {
		const r = await get('/api/sim-readiness?hash=not-a-hash');
		expect(r.status).toBe(400);
	});

	it('400s on a non-https src', async () => {
		const r = await get('/api/sim-readiness?src=http%3A%2F%2Fexample.com%2Fa.glb');
		expect(r.status).toBe(400);
		expect(r.body.error).toContain('https');
	});

	it('404s for a content hash nobody has graded, without fetching anything', async () => {
		const { fetchSafePublicUrlPinned } = await import('../../api/_lib/ssrf-guard.js');
		const r = await get(`/api/sim-readiness?hash=${'b'.repeat(64)}`);
		expect(r.status).toBe(404);
		expect(r.body).toEqual({ error: 'not graded' });
		// The whole point of the hash lane: it is a lookup, never a download.
		expect(fetchSafePublicUrlPinned).not.toHaveBeenCalled();
	});

	it('meters the expensive lane and tells the caller to use a hash instead', async () => {
		rlOk = false;
		const { fetchSafePublicUrlPinned } = await import('../../api/_lib/ssrf-guard.js');
		const r = await get('/api/sim-readiness?src=https%3A%2F%2Fthree.ws%2Fa.glb');
		expect(r.status).toBe(429);
		expect(r.body.error).toBe('rate_limited');
		expect(r.headers['retry-after']).toBeTruthy();
		// The whole point of the cap: the fetch never happened.
		expect(fetchSafePublicUrlPinned).not.toHaveBeenCalled();
	});

	it('never meters the cheap hash lookup, which is one indexed read', async () => {
		rlOk = false;
		const r = await get(`/api/sim-readiness?hash=${'b'.repeat(64)}`);
		// 404 rather than 429: the lookup ran.
		expect(r.status).toBe(404);
	});

	it('refuses a POST: grading is a read', async () => {
		const r = await get('/api/sim-readiness?src=https://three.ws/a.glb', 'POST');
		expect(r.status).toBe(405);
	});
});

describe('GET /api/sim-readiness: upstream failures', () => {
	it('413s when the asset is over the byte cap', async () => {
		upstream.throws = new MaxBytesExceededError(70_000_000, 67_108_864);
		const r = await get('/api/sim-readiness?src=https://three.ws/huge.glb');
		expect(r.status).toBe(413);
		expect(r.body.error).toMatch(/64 MB/);
	});

	it('400s (not 502) when the guard blocks the host', async () => {
		upstream.throws = new SsrfBlockedError('blocked address');
		const r = await get('/api/sim-readiness?src=https://169.254.169.254/a.glb');
		expect(r.status).toBe(400);
		expect(r.body.error).toContain('https');
	});

	it('502s with the upstream status when the fetch fails', async () => {
		upstream = { status: 404, body: Buffer.alloc(0), throws: null };
		const r = await get('/api/sim-readiness?src=https://three.ws/gone.glb');
		expect(r.status).toBe(502);
		expect(r.body).toEqual({ error: 'could not fetch the asset', status: 404 });
	});

	it('502s on a timeout rather than reporting a verdict it never measured', async () => {
		const timeout = new Error('The operation was aborted due to timeout');
		timeout.name = 'TimeoutError';
		upstream.throws = timeout;
		const r = await get('/api/sim-readiness?src=https://three.ws/slow.glb');
		expect(r.status).toBe(502);
		expect(r.body.error).toContain('timed out');
	});

	it('grades bytes that are not glTF as unreadable, with a 200', async () => {
		upstream.body = Buffer.from('this is definitely not a GLB');
		const r = await get('/api/sim-readiness?src=https://three.ws/notes.txt');
		expect(r.status).toBe(200);
		expect(r.body.readable).toBe(false);
		expect(r.body.verdict).toBe('unreadable');
		expect(r.body.blockers).toContain('unreadable_glb');
		expect(r.body.grader).toBe('threews.sim.readiness.v1');
	});
});

describe.runIf(HAS_GLB)('GET /api/sim-readiness: grading a real asset', () => {
	const SRC = 'https://three.ws/avatars/cesium-man.glb';

	it('grades on demand, caches by content hash, and says it was fresh', async () => {
		const r = await get(`/api/sim-readiness?src=${encodeURIComponent(SRC)}`);
		expect(r.status).toBe(200);
		expect(r.body.cached).toBe(false);
		expect(r.body.glbSha256).toBe(REAL_HASH);
		expect(['simulation_ready', 'needs_scale', 'needs_repair', 'unusable']).toContain(r.body.verdict);
		expect(r.body.grader).toBe('threews.sim.readiness.v1');
		expect(typeof r.body.mass.volumeM3).toBe('number');
		expect(r.body.topology).toBeTruthy();
		expect(r.headers['cache-control']).toContain('s-maxage=300');
		// Cached by CONTENT, with the source URL kept only for triage.
		expect(puts).toHaveLength(1);
		expect(puts[0].glbSha256).toBe(REAL_HASH);
		expect(puts[0].sourceUrl).toBe(SRC);
		expect(puts[0].gradeMs).toBeGreaterThanOrEqual(0);
	});

	it('serves the second request from the cache without re-grading', async () => {
		const first = await get(`/api/sim-readiness?src=${encodeURIComponent(SRC)}`);
		const second = await get(`/api/sim-readiness?src=${encodeURIComponent(SRC)}`);
		expect(second.body.cached).toBe(true);
		expect(second.body.gradedAt).toBe(first.body.gradedAt);
		expect(second.body.verdict).toBe(first.body.verdict);
		// One grade, two answers.
		expect(puts).toHaveLength(1);
	});

	it('answers ?hash= from the cache once those bytes have been graded', async () => {
		await get(`/api/sim-readiness?src=${encodeURIComponent(SRC)}`);
		const { fetchSafePublicUrlPinned } = await import('../../api/_lib/ssrf-guard.js');
		fetchSafePublicUrlPinned.mockClear();
		const r = await get(`/api/sim-readiness?hash=${REAL_HASH}`);
		expect(r.status).toBe(200);
		expect(r.body.cached).toBe(true);
		expect(r.body.glbSha256).toBe(REAL_HASH);
		expect(fetchSafePublicUrlPinned).not.toHaveBeenCalled();
	});

	it('carries no payment, wallet, or coin surface', async () => {
		const r = await get(`/api/sim-readiness?src=${encodeURIComponent(SRC)}`);
		const text = JSON.stringify(r.body).toLowerCase();
		for (const word of ['usdc', 'wallet', 'x402', 'payment', 'price', 'token', 'solana', 'mint']) {
			expect(text).not.toContain(word);
		}
	});
});
