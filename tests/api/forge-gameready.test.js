/**
 * Tests for the Game-Ready export endpoint (api/forge-gameready.js).
 *
 * The remesh worker is stubbed at the provider boundary (createRegenProvider from
 * api/_providers/gcp.js) and R2 is stubbed at the storage boundary, so this
 * exercises the endpoint's own logic: validation, the multi-format fan-out
 * (one worker task per requested format), the composite job id, the aggregated
 * poll, and the R2 mirror of finished artifacts. The retopology itself is
 * covered by the worker's own Python tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { signTierPass } from '../../api/_lib/three-tier.js';

// Stub the GCP provider — each submit returns a distinct upstream task id so the
// composite job id packs both formats; status() returns a done remesh result.
const submit = vi.fn(async (req) => ({
	extJobId: `task-${req.params.output_format}-${'x'.repeat(20)}`,
	eta: 30,
}));
const status = vi.fn(async (extJobId) => ({
	status: 'done',
	resultGlbUrl: `https://storage.googleapis.com/bucket/remesh/${extJobId}.out`,
	faceCount: 5_012,
	quadRatio: 0.92,
	textured: true,
}));
let supportsRemesh = true;

vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: () => ({
		supportsMode: (m) => m === 'remesh' && supportsRemesh,
		submit,
		status,
	}),
}));

// Stub R2 so the mirror writes to memory instead of a real bucket.
const putObject = vi.fn(async () => {});
const publicUrl = vi.fn((key) => `https://three.ws/cdn/${key}`);
vi.mock('../../api/_lib/r2.js', () => ({
	putObject,
	publicUrl,
}));

// Stub SSRF so no DNS resolution happens in tests; passthrough public https URLs.
vi.mock('../../api/_lib/ssrf.js', async (importOriginal) => {
	const mod = await importOriginal();
	return {
		...mod,
		assertPublicHttpsUrl: vi.fn(async (url) => {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:') throw new mod.SsrfError('https required');
			return url;
		}),
	};
});

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		clientIp: () => '203.0.113.9',
		limits: {
			...actual.limits,
			mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
			mcp3dStatus: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
	};
});

// fetch is used by the R2 mirror to pull the finished worker artifact.
const realFetch = globalThis.fetch;
beforeEach(() => {
	submit.mockClear();
	status.mockClear();
	putObject.mockClear();
	publicUrl.mockClear();
	supportsRemesh = true;
	globalThis.fetch = vi.fn(async () => ({
		ok: true,
		arrayBuffer: async () => new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer,
	}));
});

// The export is $THREE hold-or-pay gated (Token Utility — consumption lever). A
// signed Bronze tier pass clears the gate so the worker-logic tests below exercise
// the real fan-out, not the 402. Dev secret → sign/verify symmetry; without a pass
// the export 402s (covered in the gate describe block).
process.env.NODE_ENV = 'development';
delete process.env.HOLDER_PASS_SECRET;
const WALLET = 'THREEsynthetic1111111111111111111111111111';
const BRONZE_PASS = signTierPass({ wallet: WALLET, level: 1, tierId: 'bronze', usd: 30 });

const { default: handler } = await import('../../api/forge-gameready.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(n, v) {
			this.headers[String(n).toLowerCase()] = v;
		},
		end(b) {
			this.body = b ?? null;
		},
	};
}

// `pass` defaults to a Bronze tier pass so POSTs clear the $THREE gate; pass `null`
// to submit as a non-holder (gate tests). GET polls are ungated — the header is
// harmless there.
function makeReq({ method = 'POST', url = '/api/forge-gameready', headers = {}, body = null, pass = BRONZE_PASS } = {}) {
	const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	stream.method = method;
	stream.url = url;
	stream.headers = {
		'content-type': 'application/json',
		'x-forwarded-for': '203.0.113.9',
		...(pass ? { 'x-three-tier-pass': pass } : {}),
		...headers,
	};
	return stream;
}

const MESH = 'https://storage.googleapis.com/bucket/forge/model.glb';

describe('POST /api/forge-gameready', () => {
	it('fans out one quad-retopo task per requested format', async () => {
		const res = makeRes();
		await handler(
			makeReq({ body: { mesh_url: MESH, topology: 'quad', poly_budget: 5000, formats: ['glb', 'fbx'] } }),
			res,
		);
		expect(res.statusCode).toBe(202);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('queued');
		expect(body.topology).toBe('quad');
		expect(body.poly_budget).toBe(5000);
		expect(body.formats).toEqual(['glb', 'fbx']);
		expect(body.eta_seconds).toBeGreaterThan(0);
		expect(typeof body.job_id).toBe('string');

		// One worker task per format, both with quad mode + the requested budget.
		expect(submit).toHaveBeenCalledTimes(2);
		const calls = submit.mock.calls.map((c) => c[0]);
		const glb = calls.find((c) => c.params.output_format === 'glb');
		const fbx = calls.find((c) => c.params.output_format === 'fbx');
		expect(glb.mode).toBe('remesh');
		expect(glb.params.remesh_mode).toBe('quad');
		expect(glb.params.operation).toBe('full');
		expect(glb.params.target_faces).toBe(5000);
		expect(fbx.params.remesh_mode).toBe('quad');
		expect(fbx.params.output_format).toBe('fbx');
	});

	it('maps tri topology to the silhouette-preserving low-poly worker mode', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, topology: 'tri', poly_budget: 15000, formats: ['glb'] } }), res);
		expect(res.statusCode).toBe(202);
		const call = submit.mock.calls.at(-1)[0];
		expect(call.params.remesh_mode).toBe('lowpoly');
		expect(call.params.target_faces).toBe(15000);
	});

	it('routes a rig-preserving FBX through the geometry-preserving convert path', async () => {
		const res = makeRes();
		await handler(
			makeReq({ body: { mesh_url: MESH, topology: 'quad', formats: ['glb', 'fbx'], preserve_rig: true } }),
			res,
		);
		expect(res.statusCode).toBe(202);
		const calls = submit.mock.calls.map((c) => c[0]);
		const fbx = calls.find((c) => c.params.output_format === 'fbx');
		// Rig survives only when geometry is untouched: triangle + convert.
		expect(fbx.params.remesh_mode).toBe('triangle');
		expect(fbx.params.operation).toBe('convert');
		// The GLB still retopologizes to the chosen topology.
		const glb = calls.find((c) => c.params.output_format === 'glb');
		expect(glb.params.remesh_mode).toBe('quad');
		expect(glb.params.operation).toBe('full');
	});

	it('clamps an out-of-range poly budget', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, poly_budget: 9_000_000, formats: ['glb'] } }), res);
		const body = JSON.parse(res.body);
		expect(body.poly_budget).toBe(500_000);
	});

	it('rejects a non-https mesh url', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: 'http://insecure.example/model.glb' } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_mesh_url');
	});

	it('rejects an empty format list', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, formats: ['stp'] } }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_formats');
	});

	it('503s when the remesh worker is not configured', async () => {
		supportsRemesh = false;
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH } }), res);
		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body).error).toBe('unconfigured');
	});
});

describe('POST /api/forge-gameready — $THREE hold-or-pay gate', () => {
	it('blocks a non-holder with a 402 three_hold_required + the pay-per-export price', async () => {
		const res = makeRes();
		// No pass, no payment → anonymous caller below the Bronze threshold.
		await handler(makeReq({ body: { mesh_url: MESH }, pass: null }), res);
		expect(res.statusCode).toBe(402);
		const b = JSON.parse(res.body);
		expect(b.error).toBe('three_hold_required');
		expect(b.feature).toBe('forge.gameready');
		expect(b.required).toMatchObject({ level: 1, id: 'bronze' });
		// Pay-per-export price comes straight from the catalog ($0.10 = OUTPUTS.gameready).
		expect(b.pay_per_use).toMatchObject({ action: 'forge.gameready', usd: 0.1 });
		// The gate is hermetic — it fired before any worker/DNS call.
		expect(submit).not.toHaveBeenCalled();
	});

	it('does not dispatch to the worker when the gate blocks', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, formats: ['glb', 'fbx'] }, pass: null }), res);
		expect(res.statusCode).toBe(402);
		expect(submit).not.toHaveBeenCalled();
	});

	it('lets a verified Bronze holder export (gate falls through to the worker)', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, formats: ['glb'] } }), res); // default Bronze pass
		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body).error).toBeUndefined();
		expect(submit).toHaveBeenCalled();
	});

	it('gates a tampered / invalid pass as a non-holder', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH }, pass: 'not.a.valid.pass' }), res);
		expect(res.statusCode).toBe(402);
		expect(JSON.parse(res.body).error).toBe('three_hold_required');
		expect(submit).not.toHaveBeenCalled();
	});
});

describe('GET /api/forge-gameready?job=', () => {
	async function submitJob(body) {
		const res = makeRes();
		await handler(makeReq({ body: { mesh_url: MESH, ...body } }), res);
		return JSON.parse(res.body).job_id;
	}

	it('aggregates both formats, mirrors to R2, and returns the poly delta', async () => {
		const jobId = await submitJob({ topology: 'quad', poly_budget: 5000, formats: ['glb', 'fbx'] });
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: `/api/forge-gameready?job=${encodeURIComponent(jobId)}` }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('done');
		expect(body.face_count).toBe(5_012);
		expect(body.quad_ratio).toBe(0.92);
		expect(body.textured).toBe(true);
		// Both formats present and rehosted on our CDN.
		expect(body.outputs.glb.url).toMatch(/^https:\/\/three\.ws\/cdn\/forge\/gameready\//);
		expect(body.outputs.fbx.url).toMatch(/\.fbx$/);
		// Each finished artifact was written to R2.
		expect(putObject).toHaveBeenCalledTimes(2);
		const keys = putObject.mock.calls.map((c) => c[0].key);
		expect(keys.some((k) => k.endsWith('quad-5000.glb'))).toBe(true);
		expect(keys.some((k) => k.endsWith('quad-5000.fbx'))).toBe(true);
	});

	it('falls back to the worker URL when R2 mirroring fails', async () => {
		putObject.mockRejectedValueOnce(new Error('r2 down'));
		const jobId = await submitJob({ formats: ['glb'] });
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: `/api/forge-gameready?job=${encodeURIComponent(jobId)}` }), res);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('done');
		expect(body.outputs.glb.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
	});

	it('reports running while any sub-task is still processing', async () => {
		status.mockResolvedValueOnce({ status: 'running' });
		const jobId = await submitJob({ formats: ['glb', 'fbx'] });
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: `/api/forge-gameready?job=${encodeURIComponent(jobId)}` }), res);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('running');
		expect(body.outputs).toBeUndefined();
		expect(putObject).not.toHaveBeenCalled();
	});

	it('fails the whole export when a sub-task fails', async () => {
		status.mockResolvedValueOnce({ status: 'failed', error: 'budget impossible' });
		const jobId = await submitJob({ formats: ['glb', 'fbx'] });
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: `/api/forge-gameready?job=${encodeURIComponent(jobId)}` }), res);
		const body = JSON.parse(res.body);
		expect(body.status).toBe('failed');
		expect(body.error).toMatch(/budget impossible/);
	});

	it('400s without a job id', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: '/api/forge-gameready' }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('missing_job');
	});

	it('400s on a malformed job id', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', url: '/api/forge-gameready?job=not-base64-envelope' }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe('invalid_job');
	});
});

globalThis.fetch = realFetch;
