// GET/POST /api/3d/inspect — the free, keyless glTF/GLB inspection + validation
// endpoint. The rate limiter is mocked (switchable per test) so the suite runs
// fully offline; the real handler, real inspectModel core, and the real Khronos
// glTF-Validator all run against a real bundled GLB uploaded as the request body
// (no network). URL-fetch paths are covered by asserting the input-validation
// contract (bad/missing input never 500s).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectModel } from '../../src/gltf-inspect.js';
import { buildStats, buildRecommendations } from '../../api/3d/inspect.js';

// Switchable per-IP quota — flip `rlOk` per test.
let rlOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiIp: async () =>
			rlOk
				? { success: true, limit: 60, remaining: 59, reset: Date.now() + 60_000 }
				: { success: false, limit: 60, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.7',
}));

beforeEach(() => {
	rlOk = true;
});

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);
const REAL_GLB = ['cesium-man.glb', 'fox.glb', 'mannequin.glb'].map(avatar).find(existsSync);

function makeReq({ method = 'GET', url = '/api/3d/inspect', headers = {}, body = null } = {}) {
	const chunks = body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
	const stream = Readable.from(chunks);
	stream.method = method;
	stream.url = url;
	stream.headers = { host: 'three.ws', ...headers };
	// Parse ?query= like Vercel does, so the handler's req.query works.
	const qIdx = url.indexOf('?');
	stream.query = qIdx >= 0 ? Object.fromEntries(new URLSearchParams(url.slice(qIdx + 1))) : {};
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
			this.writableEnded = true;
		},
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/3d/inspect.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

describe('buildStats / buildRecommendations (pure helpers)', () => {
	it.runIf(REAL_GLB)('extracts real stats from a bundled GLB', async () => {
		const info = await inspectModel(new Uint8Array(readFileSync(REAL_GLB)));
		const stats = buildStats(info);
		expect(stats.vertices).toBeGreaterThan(0);
		expect(stats.triangles).toBeGreaterThan(0);
		expect(stats.materials).toBeGreaterThanOrEqual(0);
		expect(Array.isArray(stats.extensions)).toBe(true);
		expect(['glb', 'gltf']).toContain(stats.container);
	});

	it('orders recommendations by severity (critical → warn → info)', () => {
		// A synthetic heavy model that trips multiple severities: an oversized 8K PNG
		// texture (warn), a huge non-indexed vertex buffer (info: draco/meshopt/
		// non_indexed), and a 30 MB file size (warn).
		const info = {
			fileSize: 30 * 1024 * 1024,
			container: 'glb',
			generator: 'test',
			extensionsUsed: [],
			extensionsRequired: [],
			counts: {
				scenes: 1,
				nodes: 1,
				meshes: 1,
				materials: 1,
				textures: 1,
				animations: 0,
				skins: 0,
				totalJoints: 0,
				totalVertices: 200_000,
				totalTriangles: 66_000,
				indexedPrimitives: 0,
				nonIndexedPrimitives: 1,
			},
			primitiveModes: [4],
			textures: [{ name: 'big', mimeType: 'image/png', width: 8192, height: 8192, byteSize: 30 * 1024 * 1024 }],
			materials: [{ name: 'm', alphaMode: 'OPAQUE' }],
		};
		const recs = buildRecommendations(info);
		expect(recs.length).toBeGreaterThan(1);
		// Each carries the { severity, issue, fix } contract.
		for (const r of recs) {
			expect(r).toHaveProperty('severity');
			expect(typeof r.issue).toBe('string');
			expect(typeof r.fix).toBe('string');
			expect(r.fix.length).toBeGreaterThan(0);
		}
		// Non-decreasing severity rank => sorted most-severe-first.
		const rank = { critical: 0, warn: 1, info: 2 };
		const ranks = recs.map((r) => rank[r.severity] ?? 3);
		for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
	});

	it('always returns at least one recommendation (the "ok" fallback)', () => {
		const info = {
			fileSize: 1000,
			container: 'glb',
			generator: null,
			extensionsUsed: [],
			extensionsRequired: [],
			counts: {
				scenes: 1, nodes: 1, meshes: 1, materials: 1, textures: 0, animations: 0, skins: 0,
				totalJoints: 0, totalVertices: 100, totalTriangles: 33, indexedPrimitives: 1, nonIndexedPrimitives: 0,
			},
			primitiveModes: [4],
			textures: [],
			materials: [{ name: 'm', alphaMode: 'OPAQUE' }],
		};
		const recs = buildRecommendations(info);
		expect(recs.length).toBeGreaterThanOrEqual(1);
	});
});

describe('POST /api/3d/inspect — raw upload (real GLB, offline)', () => {
	it.runIf(REAL_GLB)('inspects an uploaded GLB and returns the full contract', async () => {
		const bytes = readFileSync(REAL_GLB);
		const { res, body } = await dispatch(
			makeReq({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes }),
			makeRes(),
		);
		expect(res.statusCode).toBe(200);
		expect(body.url).toBeNull(); // raw upload has no source URL
		expect(typeof body.valid).toBe('boolean');
		expect(body.sizeBytes).toBe(bytes.byteLength);
		expect(body.stats.vertices).toBeGreaterThan(0);
		expect(body.stats.triangles).toBeGreaterThan(0);
		expect(Array.isArray(body.stats.extensions)).toBe(true);
		expect(Array.isArray(body.recommendations)).toBe(true);
		expect(body.recommendations.length).toBeGreaterThanOrEqual(1);
		expect(typeof body.ts).toBe('string');
		expect(res.getHeader('cache-control')).toBe('no-store');
	});

	it('rejects an empty upload with 400 (never 500)', async () => {
		const { res, body } = await dispatch(
			makeReq({ method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: null }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('empty_body');
	});

	it('rejects non-model bytes with 400 invalid_model (never 500)', async () => {
		const { res, body } = await dispatch(
			makeReq({
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: Buffer.from('this is definitely not a glb file'),
			}),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_model');
	});
});

describe('input validation', () => {
	it('GET with no url → 400 missing_url', async () => {
		const { res, body } = await dispatch(makeReq({ method: 'GET', url: '/api/3d/inspect' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_url');
	});

	it('POST JSON with no url → 400 missing_url', async () => {
		const { res, body } = await dispatch(
			makeReq({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ noturl: 1 }),
			}),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('missing_url');
	});

	it('unsupported method → 405', async () => {
		const { res } = await dispatch(makeReq({ method: 'DELETE' }), makeRes());
		expect(res.statusCode).toBe(405);
	});

	it('rate-limited → 429', async () => {
		rlOk = false;
		const { res, body } = await dispatch(
			makeReq({ method: 'GET', url: '/api/3d/inspect?url=https://three.ws/x.glb' }),
			makeRes(),
		);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('a URL pointing at a private address is the caller fault → 400, not a 502', async () => {
		// The SSRF guard refuses this before any bytes are fetched. It has to reach
		// the caller as invalid_url: a 502 says "our upstream broke, retry", which
		// sends an agent into a retry loop over a URL that can never be allowed.
		const { res, body } = await dispatch(
			makeReq({ method: 'GET', url: '/api/3d/inspect?url=https://127.0.0.1/model.glb' }),
			makeRes(),
		);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_url');
		expect(body.error_description).toMatch(/private address/i);
	});
});
