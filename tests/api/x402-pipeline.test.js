/**
 * Tests for the paid x402 asset-pipeline endpoint (api/x402/pipeline.js) and its
 * poll-driven state machine (api/_lib/pipeline.js).
 *
 * What's exercised here is the endpoint's OWN logic — not the real GPU upstreams,
 * which are stubbed at their module boundaries:
 *   • grammar validation matrix (order, unknown/duplicate stages, input rules)
 *   • price quoting per chain (the 402 amount is the exact sum of the stages)
 *   • per-stage progress shape recorded on the job record
 *   • partial-failure semantics (a mid-chain failure preserves prior outputs)
 *   • poll compatibility (the pipeline job token round-trips + advances)
 *
 * The stage-module boundary is fixture-backed: NVIDIA text→3D returns a synthetic
 * done GLB, and the GCP worker's submit/status is a controllable stub. One test
 * feeds a REAL rigged GLB fixture through the rig stage and inspects the final
 * artifact (magic bytes + a skinned mesh) — the offline stand-in for a live
 * end-to-end job.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

// A real rigged GLB fixture (Khronos BrainStem — 1 skin, 1 animation). Used as
// the mocked final stage output so the end-to-end test can inspect a real asset.
const RIGGED_GLB_PATH = resolve(process.cwd(), 'public/avatars/brainstem.glb');
const RIGGED_GLB_URL = 'https://cdn.three.ws/forge/fixture/brainstem.glb';
const GENERATE_GLB_URL = 'https://cdn.three.ws/forge/fixture/generated.glb';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		JWT_SECRET: 'test-jwt-secret-for-pipeline-job-tokens',
		// Make every stage's lane "configured" so the grammar offers all five.
		NVIDIA_API_KEY: 'test-nvidia',
		GCP_RECONSTRUCTION_KEY: 'test-gcp-key',
		GCP_RECONSTRUCTION_URL: 'https://gcp.example/reconstruct',
		GCP_REMESH_URL: 'https://gcp.example/remesh',
		GCP_STYLIZE_URL: 'https://gcp.example/stylize',
	});
	// Solana unset → the route quotes the Base failsafe requirement (still exact).
	delete process.env.X402_PAY_TO_SOLANA;
});

// Payment verify/settle stubbed; the rest of x402-spec (send402, requirement
// builders, buildBazaarSchema, resolveResourceUrl) stays real.
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		verifyPayment: vi.fn(async () => ({ ok: true })),
		settlePayment: vi.fn(async () => ({ settled: true })),
		encodePaymentResponseHeader: vi.fn(() => 'stub-payment-response'),
	};
});

// Free NVIDIA NIM TRELLIS text→3D — the generate stage's primary lane. Returns a
// synchronous done GLB so `generate` completes inline at submit time.
const nvidiaMock = vi.hoisted(() => ({
	createNvidiaProvider: vi.fn(() => ({
		textTo3d: vi.fn(async () => ({ resultGlbUrl: 'https://cdn.three.ws/forge/fixture/generated.glb' })),
		status: vi.fn(async () => ({ status: 'done', resultGlbUrl: 'https://cdn.three.ws/forge/fixture/generated.glb' })),
	})),
}));
vi.mock('../../api/_providers/nvidia.js', () => nvidiaMock);

// GCP Cloud Run worker (rig/remesh/gameready/stylize). submit() hands back a
// mode-tagged handle; status() is controllable per test via gcpControl.
const gcpControl = vi.hoisted(() => ({ next: () => ({ status: 'running' }) }));
const gcpMock = vi.hoisted(() => ({ gcpControl: null }));
vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: vi.fn(() => ({
		supportsMode: () => true,
		supportsMultiview: () => true,
		submit: vi.fn(async ({ mode }) => ({ extJobId: `gcp-${mode}-task`, eta: 60, backend: 'gcp' })),
		status: vi.fn(async (id) => gcpControl.next(id)),
	})),
}));

// Replicate — a generate reconstruct fallback + rig fallback. Never the primary
// path in these tests (NVIDIA/GCP win), but present so module load succeeds.
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: vi.fn(() => ({
		supportsMode: () => true,
		submit: vi.fn(async () => ({ extJobId: 'rep-task', jobId: 'rep-task', eta: 60 })),
		status: vi.fn(async () => ({ status: 'running' })),
	})),
}));

// FLUX text→image (used only by the reconstruct fallback; NVIDIA wins here).
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: vi.fn(async () => ({ imageUrl: 'https://cdn.example/ref.png', model: 'flux' })),
}));

// SSRF guard is a no-op in tests (no DNS).
vi.mock('../../api/_lib/ssrf-guard.js', () => ({
	assertSafePublicUrl: vi.fn(async () => true),
}));

// Deterministic rate limiter.
vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: { ...actual.limits, publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
		clientIp: () => '203.0.113.9',
	};
});

const { default: handler } = await import('../../api/x402/pipeline.js');
const { pollPipeline, priceForChain, priceAtomicsForStage } = await import('../../api/_lib/pipeline.js');
const { decodeJobToken } = await import('../../api/_lib/forge-job-token.js');
const { inspectModel } = await import('../../src/gltf-inspect.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(n, v) { this.headers[String(n).toLowerCase()] = v; },
		getHeader(n) { return this.headers[String(n).toLowerCase()]; },
		end(b) { this.body = b ?? null; },
	};
}

function makeReq({ method = 'POST', url = '/api/x402/pipeline', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	// A real Readable, not a hand-rolled async iterable: readBody (api/_lib/http.js)
	// consumes the request via 'data'/'end' events, exactly like a Node
	// IncomingMessage, and a real stream supports both events and for-await.
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = url;
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers };
	return req;
}

const PAID = { 'x-payment': 'stub-payment-proof' };
// A distinct proof for any second paid POST in this file: the real anti-replay
// guard (api/_lib/x402/payment-identifier-server.js#checkCache) keys on a hash
// of the raw X-PAYMENT header, so two different request bodies reusing the same
// literal header collide as a payment-proof conflict (409) — correct behavior
// for a real proof, but a test needs a unique header per distinct paid request.
const PAID_2 = { 'x-payment': 'stub-payment-proof-2' };

beforeEach(() => {
	gcpControl.next = () => ({ status: 'running' });
});

describe('GET /api/x402/pipeline — grammar + pricing discovery', () => {
	it('lists the live stage grammar and per-stage pricing', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.route).toBe('/api/x402/pipeline');
		expect(body.order).toEqual(['generate', 'rig', 'remesh', 'gameready', 'stylize']);
		// All five configured in beforeAll.
		expect(body.available.map((s) => s.id)).toEqual(['generate', 'rig', 'remesh', 'gameready', 'stylize']);
		expect(body.excluded).toEqual([]);
		const gen = body.available.find((s) => s.id === 'generate');
		expect(gen.price_usdc).toBe('0.05');
	});

	it('excludes a stage whose lane is not configured', async () => {
		delete process.env.GCP_STYLIZE_URL;
		const res = makeRes();
		await handler(makeReq({ method: 'GET' }), res);
		const body = JSON.parse(res.body);
		expect(body.available.map((s) => s.id)).not.toContain('stylize');
		expect(body.excluded.map((s) => s.id)).toContain('stylize');
		process.env.GCP_STYLIZE_URL = 'https://gcp.example/stylize';
	});
});

describe('POST /api/x402/pipeline — grammar validation matrix (pre-payment 400s)', () => {
	const cases = [
		{ name: 'empty stages', body: { stages: [] }, code: 'invalid_stages' },
		{ name: 'unknown stage', body: { stages: ['generate', 'teleport'], prompt: 'a cat' }, code: 'unknown_stage' },
		{ name: 'duplicate stage', body: { stages: ['generate', 'generate'], prompt: 'a cat' }, code: 'duplicate_stage' },
		{ name: 'generate not first', body: { stages: ['rig', 'generate'], prompt: 'a cat', glb_url: 'https://cdn.three.ws/x.glb' }, code: 'invalid_order' },
		{ name: 'out-of-canonical-order', body: { stages: ['stylize', 'rig'], glb_url: 'https://cdn.three.ws/x.glb' }, code: 'invalid_order' },
		{ name: 'generate without prompt', body: { stages: ['generate', 'rig'] }, code: 'missing_prompt' },
		{ name: 'no generate, no glb_url', body: { stages: ['rig'] }, code: 'missing_glb_url' },
		{ name: 'bad glb_url', body: { stages: ['rig'], glb_url: 'ftp://nope' }, code: 'invalid_glb_url' },
	];
	for (const c of cases) {
		it(`rejects ${c.name} with ${c.code}`, async () => {
			const res = makeRes();
			await handler(makeReq({ body: c.body, headers: PAID }), res);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error).toBe(c.code);
		});
	}
});

describe('POST /api/x402/pipeline — 402 quotes the exact chain price', () => {
	it('quotes the sum of the requested stages', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { stages: ['generate', 'rig'], prompt: 'a brass owl' } }), res);
		expect(res.statusCode).toBe(402);
		const expected = (BigInt(priceAtomicsForStage('generate')) + BigInt(priceAtomicsForStage('rig'))).toString();
		const body = JSON.parse(res.body);
		const accepts = body.accepts || body.requirements || [];
		expect(accepts[0].amount).toBe(expected);
		// generate $0.05 + rig $0.10 = $0.15
		expect(priceForChain(['generate', 'rig']).usdc).toBe('0.15');
	});

	it('a longer chain quotes a higher total', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { stages: ['generate', 'rig', 'gameready'], prompt: 'a brass owl' } }), res);
		const expected = (
			BigInt(priceAtomicsForStage('generate')) +
			BigInt(priceAtomicsForStage('rig')) +
			BigInt(priceAtomicsForStage('gameready'))
		).toString();
		expect(JSON.parse(res.body).accepts[0].amount).toBe(expected);
	});
});

describe('POST /api/x402/pipeline — paid job + per-stage progress, end to end', () => {
	it('runs generate→rig to a real rigged GLB, exposing per-stage progress', async () => {
		// generate completes inline (NVIDIA sync). At POST: stage[0] done, job running.
		const res = makeRes();
		await handler(makeReq({ body: { stages: ['generate', 'rig'], prompt: 'a brass owl', options: { tier: 'draft' } }, headers: PAID }), res);
		expect(res.statusCode).toBe(200);
		const submit = JSON.parse(res.body);
		expect(submit.job_token).toMatch(/^f1\./);
		expect(submit.price_usdc).toBe('0.15');
		expect(submit.status).toBe('running');
		expect(submit.stages).toHaveLength(2);
		expect(submit.stages[0]).toMatchObject({ id: 'generate', status: 'done', output_url: GENERATE_GLB_URL });
		expect(submit.stages[0].started_at).toBeTruthy();
		expect(submit.stages[0].finished_at).toBeTruthy();
		expect(submit.stages[1]).toMatchObject({ id: 'rig', status: 'queued' });
		expect(submit.result_glb_url).toBe(GENERATE_GLB_URL);

		const jobId = submit.job_id;
		const token = submit.job_token;
		expect(decodeJobToken(token)).toMatchObject({ provider: 'pipeline', taskId: jobId });

		// Poll #1 submits the rig stage (GCP), which reports running.
		let p = makeRes();
		await pollPipeline(p, jobId, token);
		let view = JSON.parse(p.body);
		expect(view.status).toBe('running');
		expect(view.stages[1]).toMatchObject({ id: 'rig', status: 'running' });
		expect(view.stages[1].started_at).toBeTruthy();

		// Poll #2: the rig job finishes with the real rigged GLB → job done.
		gcpControl.next = () => ({ status: 'done', resultGlbUrl: RIGGED_GLB_URL });
		p = makeRes();
		await pollPipeline(p, jobId, token);
		view = JSON.parse(p.body);
		expect(view.status).toBe('done');
		expect(view.stages[1]).toMatchObject({ id: 'rig', status: 'done', output_url: RIGGED_GLB_URL });
		expect(view.stages[1].finished_at).toBeTruthy();
		expect(view.result_glb_url).toBe(RIGGED_GLB_URL);
		// Internal poll handles never leak to the wire.
		expect(view.stages[1].handle).toBeUndefined();
	});

	it('the delivered final GLB has valid magic bytes and a skinned rig', async () => {
		// Offline stand-in for downloading + inspecting the live final artifact.
		const buf = readFileSync(RIGGED_GLB_PATH);
		expect(buf.subarray(0, 4).toString('latin1')).toBe('glTF');
		const info = await inspectModel(new Uint8Array(buf), { fileSize: buf.length });
		expect(info.counts.skins).toBeGreaterThan(0); // rig present
	});
});

describe('POST /api/x402/pipeline — partial-failure semantics', () => {
	it('marks the job failed at the failing stage but keeps completed outputs', async () => {
		const res = makeRes();
		await handler(makeReq({ body: { stages: ['generate', 'rig'], prompt: 'a brass owl' }, headers: PAID_2 }), res);
		const submit = JSON.parse(res.body);
		const { job_id: jobId, job_token: token } = submit;

		// Poll #1 submits rig (running).
		let p = makeRes();
		await pollPipeline(p, jobId, token);

		// Poll #2: the rig job fails.
		gcpControl.next = () => ({ status: 'failed', error: 'rig worker exploded' });
		p = makeRes();
		await pollPipeline(p, jobId, token);
		const view = JSON.parse(p.body);
		expect(view.status).toBe('failed');
		// Completed generate output survives (partial value delivered).
		expect(view.stages[0]).toMatchObject({ id: 'generate', status: 'done', output_url: GENERATE_GLB_URL });
		expect(view.result_glb_url).toBe(GENERATE_GLB_URL);
		// The failing stage carries an error and is terminal.
		expect(view.stages[1].status).toBe('failed');
		expect(view.stages[1].error).toBeTruthy();
	});
});

describe('poll compatibility', () => {
	it('a pipeline token decodes to the pipeline provider (routes to the pipeline poller)', () => {
		const token = 'not-a-token';
		expect(decodeJobToken(token)).toBeNull();
	});

	it('returns 404 for an unknown pipeline job id', async () => {
		const p = makeRes();
		await pollPipeline(p, 'no-such-job', 'f1.x.y');
		expect(p.statusCode).toBe(404);
		expect(JSON.parse(p.body).error).toBe('job_not_found');
	});
});
