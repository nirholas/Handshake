/**
 * Multi-view conditioning for single-photo image→3D on the self-host TRELLIS
 * fusing lane: api/forge.js.
 *
 * A single uploaded photo used to go to the fusing worker alone, so TRELLIS
 * hallucinated the subject's unseen sides (smeared textures, hollowed-out
 * backs). The handler now rotates the photo into side + back turnaround views
 * (Vertex Gemini edit lane) before submitting, exactly like the text→3D path
 * always did. These tests pin the gate: standard-tier single photos gain the
 * synthesized views; draft keeps single-view speed; caller-supplied multi-view
 * inputs are forwarded untouched; and a failed synthesis degrades to the
 * single view instead of failing the generation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		// Self-hosted TRELLIS worker wired → photos route to the fusing lane.
		MODEL_TRELLIS_URL: 'https://trellis.example.run.app',
		GCP_RECONSTRUCTION_KEY: 'test-gcp-key',
		// Satisfies the handler's global text-to-3D configured guard; photo
		// uploads still prefer the self-host TRELLIS lane over NVIDIA (text-only).
		NVIDIA_API_KEY: 'nvapi-test',
		// The lane wraps its job id in a signed forge token (encodeJobToken).
		JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
	});
});

// Self-hosted GCP worker accepts the job and returns a poll handle, echoing
// back how many views it was given: the wire contract under test.
const gcpSubmit = vi.fn(async ({ params }) => ({
	extJobId: 'gcpjob-multiview-01',
	viewsUsed: params.images.length,
	multiview: params.images.length > 1,
}));
vi.mock('../../api/_providers/gcp.js', () => ({
	createRegenProvider: () => ({ submit: gcpSubmit }),
}));

// Turnaround synthesis (Vertex Gemini edit lane) yields a side + back view of
// the uploaded photo. Individual tests override it to simulate an outage.
const synthesizeTurnaroundViews = vi.fn(async () => [
	'https://cdn.example/photo-side.png',
	'https://cdn.example/photo-back.png',
]);
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: vi.fn(async () => ({ imageUrl: 'https://cdn.example/ref.png', model: 'flux' })),
	synthesizeTurnaroundViews,
}));

// Store: no real DB. createCreation returns an id; failures are recorded.
vi.mock('../../api/_lib/forge-store.js', () => ({
	hashClient: (v) => `client:${v || 'anon'}`,
	hashIp: (v) => `ip:${v}`,
	createCreation: vi.fn(async () => 'creation-1'),
	materializeCreation: vi.fn(async ({ glbUrl }) => ({ id: 'creation-1', glbUrl })),
	markFailed: vi.fn(async () => {}),
	findByJob: vi.fn(async () => null),
}));

// Lane health: the real snapshot probes the worker URL over the network, which
// is unreachable here and would mark the lane down. Report everything unknown
// (fail-open, treated as usable), matching a deployment with no telemetry.
vi.mock('../../api/_lib/forge-lane-health.js', () => ({
	laneHealthSnapshot: vi.fn(async () => ({ statusMap: {}, byId: {} })),
	markLaneUnhealthy: vi.fn(async () => {}),
	laneCooldownKey: (id) => `forge-lane:${id}`,
}));

// Vision pre-check is a no-op pass: the routing, not the input, is under test.
vi.mock('../../api/_lib/forge-image-validate.js', () => ({
	validateForgeImage: vi.fn(async () => ({ ok: true })),
}));

// Rate limiter: deterministic success so the lane logic is what runs.
vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
			mcp3dGenerateFree: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.9',
	};
});

const { default: handler } = await import('../../api/forge.js');

function makeReq(body) {
	return {
		method: 'POST',
		url: '/api/forge',
		headers: { 'content-type': 'application/json', 'x-forge-client': 'tester' },
		on(event, cb) {
			if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
			if (event === 'end') cb();
		},
	};
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ? JSON.parse(body) : null;
		},
	};
}

const PHOTO = 'https://cdn.example/photo.png';

beforeEach(() => {
	gcpSubmit.mockClear();
	synthesizeTurnaroundViews.mockClear();
});

describe('single-photo image→3D gains synthesized turnaround views on the fusing lane', () => {
	it('submits the photo plus side + back views to the self-host TRELLIS worker', async () => {
		const req = makeReq({ image_urls: [PHOTO], tier: 'standard', path: 'image', skip_validation: true });
		const res = makeRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body.backend).toBe('trellis_selfhost');
		expect(res.body.status).toBe('queued');
		expect(synthesizeTurnaroundViews).toHaveBeenCalledWith(PHOTO);
		expect(gcpSubmit).toHaveBeenCalledTimes(1);
		expect(gcpSubmit.mock.calls[0][0].params.images).toEqual([
			PHOTO,
			'https://cdn.example/photo-side.png',
			'https://cdn.example/photo-back.png',
		]);
		// Provenance reports every view the worker fuses, primary first.
		expect(res.body.reference_image_urls).toHaveLength(3);
		expect(res.body.reference_image_urls[0]).toBe(PHOTO);
		expect(res.body.preview_image_url).toBe(PHOTO);
	});

	it('keeps draft single-view for speed (no synthesis call)', async () => {
		const req = makeReq({ image_urls: [PHOTO], tier: 'draft', path: 'image', skip_validation: true });
		const res = makeRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body.backend).toBe('trellis_selfhost');
		expect(synthesizeTurnaroundViews).not.toHaveBeenCalled();
		expect(gcpSubmit.mock.calls[0][0].params.images).toEqual([PHOTO]);
	});

	it('forwards caller-supplied multi-view inputs untouched (their views win)', async () => {
		const supplied = [PHOTO, 'https://cdn.example/photo-left.png'];
		const req = makeReq({ image_urls: supplied, tier: 'standard', path: 'image', skip_validation: true });
		const res = makeRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(synthesizeTurnaroundViews).not.toHaveBeenCalled();
		expect(gcpSubmit.mock.calls[0][0].params.images).toEqual(supplied);
	});

	it('degrades to the single photo when synthesis fails: never a failed generation', async () => {
		synthesizeTurnaroundViews.mockRejectedValueOnce(new Error('vertex edit lane down'));
		const req = makeReq({ image_urls: [PHOTO], tier: 'standard', path: 'image', skip_validation: true });
		const res = makeRes();
		await handler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body.backend).toBe('trellis_selfhost');
		expect(res.body.status).toBe('queued');
		expect(gcpSubmit.mock.calls[0][0].params.images).toEqual([PHOTO]);
	});
});
