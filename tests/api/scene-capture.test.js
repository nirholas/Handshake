// Scene Capture (video → 3D point cloud) — provider routing + endpoint contract.
//
// Covers the path added for streaming video reconstruction:
//   • The GCP provider's `video2scene` mode posts the video URL + sampling
//     params to the LingBot-Map worker's /infer, forwards only set knobs, and
//     resolves the finished .ply (resultPointCloudUrl) + telemetry on poll.
//   • The /api/scene-capture endpoint validates input, degrades to a clean 503
//     when the worker isn't configured, and proxies submit/poll through the
//     provider.
//
// global fetch is stubbed to capture the worker submit body and model the
// worker's task responses; no network, no mocked product data.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['GCP_VIDEO2SCENE_URL', 'GCP_RECONSTRUCTION_KEY'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const WORKER_URL = 'https://model-video2scene-test.a.run.app';

beforeEach(() => {
	process.env.GCP_VIDEO2SCENE_URL = WORKER_URL;
	process.env.GCP_RECONSTRUCTION_KEY = 'test-shared-key';
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

async function freshProvider() {
	const mod = await import('../../api/_providers/gcp.js');
	return mod.createRegenProvider();
}

describe('gcp provider — video2scene mode routing', () => {
	it('supports video2scene only when GCP_VIDEO2SCENE_URL is set', async () => {
		let provider = await freshProvider();
		expect(provider.supportsMode('video2scene')).toBe(true);
		delete process.env.GCP_VIDEO2SCENE_URL;
		provider = await freshProvider();
		expect(provider.supportsMode('video2scene')).toBe(false);
	});

	it('posts the video_url + only-set params to /infer with the shared bearer', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers });
			return new Response(JSON.stringify({ task_id: 'task-xyz', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});

		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'video2scene',
			sourceUrl: 'https://cdn.example.com/walk.mp4',
			params: { mode: 'streaming', fps: 8, keyframe_interval: 4, mask_sky: true, max_points: 1_500_000, voxel_size: 0.02 },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${WORKER_URL}/infer`);
		expect(calls[0].headers.authorization).toBe('Bearer test-shared-key');
		expect(calls[0].body).toEqual({
			video_url: 'https://cdn.example.com/walk.mp4',
			mode: 'streaming',
			fps: 8,
			keyframe_interval: 4,
			max_points: 1_500_000,
			voxel_size: 0.02,
			mask_sky: true,
		});
		expect(job.extJobId).toBeTruthy();
		expect(job.backend).toBe('gcp');
		expect(job.eta).toBe(240);
	});

	it('sends an images[] array instead of video_url when frames are supplied', async () => {
		const calls = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push(JSON.parse(opts.body));
			return new Response(JSON.stringify({ task_id: 't', status: 'queued' }), { status: 202 });
		});
		const provider = await freshProvider();
		await provider.submit({
			mode: 'video2scene',
			sourceUrl: 'https://cdn.example.com/walk.mp4',
			params: { images: ['https://x/a.jpg', 'https://x/b.jpg'], fps: 8 },
		});
		expect(calls[0].images).toEqual(['https://x/a.jpg', 'https://x/b.jpg']);
		expect(calls[0].video_url).toBeUndefined();
	});

	it('resolves the finished point cloud + telemetry from result_gcs_url on poll', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-xyz', status: 'queued' }), { status: 202 }),
		);
		const provider = await freshProvider();
		const job = await provider.submit({
			mode: 'video2scene',
			sourceUrl: 'https://cdn.example.com/walk.mp4',
			params: {},
		});

		const ply = 'https://storage.googleapis.com/bucket/scenes/video2scene/task-xyz.ply';
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(`${WORKER_URL}/tasks/task-xyz`);
			return new Response(
				JSON.stringify({
					task_id: 'task-xyz',
					status: 'done',
					result_gcs_url: ply,
					num_points: 1_234_567,
					frames: 240,
					bytes: 9999,
					frames_truncated: true,
					sky_points_removed: 4_096,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		});

		const status = await provider.status(job.extJobId);
		expect(status.status).toBe('done');
		expect(status.resultPointCloudUrl).toBe(ply);
		expect(status.numPoints).toBe(1_234_567);
		expect(status.frames).toBe(240);
		// A clip longer than the worker's frame budget is reconstructed in part;
		// the caller has to be able to tell that from a whole-clip result.
		expect(status.framesTruncated).toBe(true);
		expect(status.skyPointsRemoved).toBe(4_096);
		// A point cloud is NOT a GLB mesh — the GLB field must stay unset.
		expect(status.resultGlbUrl).toBeUndefined();
	});

	it('reports a designed failure when the worker errors the task', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-xyz', status: 'queued' }), { status: 202 }),
		);
		const provider = await freshProvider();
		const job = await provider.submit({ mode: 'video2scene', sourceUrl: 'https://cdn.example.com/walk.mp4', params: {} });

		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-xyz', status: 'failed', error: 'no points above floor' }), { status: 200 }),
		);
		const status = await provider.status(job.extJobId);
		expect(status.status).toBe('failed');
		expect(status.error).toContain('no points');
	});
});

// ── Endpoint contract (api/scene-capture.js) ──────────────────────────────────

function mockReq({ method = 'POST', url = '/api/scene-capture', body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = {
		method,
		url,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
		on(event, cb) {
			if (event === 'data' && payload) cb(Buffer.from(payload));
			if (event === 'end') cb();
		},
	};
	return req;
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; this.writableEnded = true; },
		get headersSent() { return this.ended; },
	};
}

async function callEndpoint(req) {
	const mod = await import('../../api/scene-capture.js');
	const res = mockRes();
	await mod.default(req, res);
	let json = null;
	try { json = JSON.parse(res.body); } catch { /* non-json */ }
	return { res, json };
}

describe('/api/scene-capture endpoint', () => {
	it('rejects a missing video_url with 400', async () => {
		const { res, json } = await callEndpoint(mockReq({ body: {} }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('missing_video_url');
	});

	it('rejects a non-http(s) / private video_url before dispatch', async () => {
		const { res, json } = await callEndpoint(mockReq({ body: { video_url: 'http://169.254.169.254/latest' } }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('invalid_video_url');
	});

	it('degrades to a clean 503 when the worker is not configured', async () => {
		delete process.env.GCP_VIDEO2SCENE_URL;
		delete process.env.GCP_RECONSTRUCTION_KEY;
		const { res, json } = await callEndpoint(mockReq({ body: { video_url: 'https://93.184.216.34/walk.mp4' } }));
		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('unconfigured');
	});

	it('keeps env-var operator instructions out of the visitor-facing 503 message', async () => {
		delete process.env.GCP_VIDEO2SCENE_URL;
		delete process.env.GCP_RECONSTRUCTION_KEY;
		const { json } = await callEndpoint(mockReq({ body: { video_url: 'https://93.184.216.34/walk.mp4' } }));
		// /capture renders `message` verbatim in its error overlay, so it has to read
		// as a status a visitor can act on, not a deployment checklist.
		expect(json.message).not.toMatch(/GCP_VIDEO2SCENE_URL|GCP_RECONSTRUCTION_KEY|Cloud Run/);
		expect(json.message).toMatch(/offline/i);
		expect(json.hint).toMatch(/GCP_VIDEO2SCENE_URL/);
	});

	it('starts a job and returns a job_id when configured', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response(JSON.stringify({ task_id: 'task-xyz', status: 'queued' }), { status: 202 }),
		);
		const { res, json } = await callEndpoint(mockReq({ body: { video_url: 'https://93.184.216.34/walk.mp4', mode: 'windowed' } }));
		expect(res.statusCode).toBe(202);
		expect(json.job_id).toBeTruthy();
		expect(json.status).toBe('queued');
		expect(json.eta_seconds).toBe(240);
	});

	it('rejects a malformed job id on poll', async () => {
		const { res, json } = await callEndpoint(mockReq({ method: 'GET', url: '/api/scene-capture?job=%20%20' }));
		expect(res.statusCode).toBe(400);
		expect(json.error).toBe('missing_job');
	});
});
