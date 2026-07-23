/**
 * Free-first reconstruct ordering for api/forge.js.
 *
 * Platform stance: a generation must prefer the FREE reconstruct lane over the
 * paid Replicate default — so a forge call never spends on, nor dead-ends
 * against, the paid account while a free lane can serve it. Concretely:
 *
 *   • When the native free NVIDIA NIM text→3D lane fails, the request reconstructs
 *     the FLUX-synthesized view on the FREE HuggingFace Spaces lane BEFORE ever
 *     touching the paid Replicate reconstruct (FORGE_PREFER_FREE, default on).
 *   • When every free lane is unavailable and the only one left is the platform's
 *     own paid account out of credit, the buyer NEVER sees the vendor's raw
 *     "purchase credit / replicate.com/billing" message — that internal billing
 *     state is sanitized into an honest "temporarily unavailable".
 *
 * The provider boundaries are stubbed; these assert the endpoint's routing and
 * its error hygiene, with provenance reporting the lane that actually ran.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		REPLICATE_API_TOKEN: 'test-token',
		NVIDIA_API_KEY: 'test-nvidia-key',
		JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
	});
	// No Hunyuan3D worker wired here — keep the reconstruct fallback to HF/Replicate
	// only, so the free-first ordering is the single variable under test.
	delete process.env.GCP_HUNYUAN3D_URL;
	delete process.env.GCP_RECONSTRUCTION_KEY;
	delete process.env.FORGE_PREFER_FREE; // default ON
});

// Free NVIDIA NIM text→3D lane is DOWN this whole suite (mirrors the prod failure
// that started this work: auth ok, invoke errors). Every text prompt therefore
// reaches the reconstruct step, which is what free-first governs.
const nvidiaTextTo3d = vi.fn(async () => {
	throw Object.assign(new Error('TRELLIS completed but returned no GLB artifact'), {
		code: 'provider_error',
		status: 502,
	});
});
vi.mock('../../api/_providers/nvidia.js', () => ({
	createNvidiaProvider: () => ({ textTo3d: nvidiaTextTo3d }),
}));

// FLUX text-to-image (the free reference view) succeeds — the variable under test
// is which RECONSTRUCT lane runs, not image synthesis.
vi.mock('../../api/_mcp3d/text-to-image.js', () => ({
	textToImage: vi.fn(async () => ({ imageUrl: 'https://cdn.example/ref.png', model: 'flux' })),
}));

// Paid Replicate reconstruct. A single module-level spy lets a test assert it was
// NEVER called (free chosen first). By default it is out of credit, exactly like
// the broke prod account — so if a test DOES reach it, the leak path is exercised.
const replicateSubmit = vi.fn(async () => {
	throw Object.assign(
		new Error(
			'You have insufficient credit to run this model. Go to https://replicate.com/account/billing#billing to purchase credit.',
		),
		{ code: 'provider_error', status: 502, providerStatus: 402 },
	);
});
vi.mock('../../api/_providers/replicate.js', () => ({
	createRegenProvider: () => ({ submit: replicateSubmit }),
}));

// Free HuggingFace Spaces lane. createRegenProvider throws when HF_TOKEN is unset
// (mirrors the real provider's gating), so the lane is only available where a
// token is configured. submit() blocks and packs the GLB; status() echoes it.
const hfSubmit = vi.fn(async () => ({ extJobId: 'hf-packed-job' }));
const hfStatus = vi.fn(async () => ({ status: 'done', resultGlbUrl: 'https://cdn.example/hf.glb' }));
vi.mock('../../api/_providers/huggingface.js', () => ({
	createRegenProvider: () => {
		if (!process.env.HF_TOKEN) {
			throw Object.assign(new Error('HF_TOKEN env var is required'), {
				code: 'provider_unconfigured',
				status: 501,
			});
		}
		return { submit: hfSubmit, status: hfStatus };
	},
}));

vi.mock('../../api/_lib/forge-store.js', () => ({
	hashClient: (v) => `client:${v || 'anon'}`,
	hashIp: (v) => `ip:${v}`,
	createCreation: vi.fn(async () => 'creation-1'),
	materializeCreation: vi.fn(async ({ glbUrl }) => ({ id: 'creation-1', glbUrl })),
	markFailed: vi.fn(async () => {}),
	findByJob: vi.fn(async () => null),
}));

vi.mock('../../api/_lib/forge-image-validate.js', () => ({
	validateForgeImage: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../api/_lib/rate-limit.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		limits: {
			...actual.limits,
			mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
			mcp3dGenerateFree: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
			mcp3dGenerateFreeTiered: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		},
		clientIp: () => '203.0.113.11',
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
		getHeader(name) {
			return this.headers[String(name).toLowerCase()];
		},
		end(body) {
			this.body = body ? JSON.parse(body) : null;
		},
	};
}

describe('forge free-first reconstruct ordering', () => {
	it('reconstructs a text prompt on the FREE HuggingFace lane before ever touching paid Replicate', async () => {
		process.env.HF_TOKEN = 'test-hf-token';
		nvidiaTextTo3d.mockClear();
		replicateSubmit.mockClear();
		hfSubmit.mockClear();
		try {
			const req = makeReq({ prompt: 'a red ceramic mug', tier: 'standard', path: 'image' });
			const res = makeRes();
			await handler(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.body.status).toBe('done');
			expect(res.body.backend).toBe('huggingface');
			expect(res.body.mode).toBe('text_to_3d');
			expect(res.body.glb_url).toBe('https://cdn.example/hf.glb');
			// The default resolver now leads with the image-intermediate reference
			// pipeline: with HF configured (and no self-host worker), it resolves
			// straight to the FREE HuggingFace lane — NVIDIA's native text→mesh
			// preview (which skips the photoreal reference image) is never even
			// attempted, and the paid Replicate reconstruct is NEVER invoked either.
			expect(nvidiaTextTo3d).not.toHaveBeenCalled();
			expect(hfSubmit).toHaveBeenCalled();
			expect(replicateSubmit).not.toHaveBeenCalled();
		} finally {
			delete process.env.HF_TOKEN;
		}
	});

	it('prefers the free HF lane for an image upload too (no paid Replicate call)', async () => {
		process.env.HF_TOKEN = 'test-hf-token';
		replicateSubmit.mockClear();
		hfSubmit.mockClear();
		try {
			const req = makeReq({
				image_urls: ['https://cdn.example/photo.png'],
				tier: 'standard',
				path: 'image',
				skip_validation: true,
			});
			const res = makeRes();
			await handler(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.body.status).toBe('done');
			expect(res.body.backend).toBe('huggingface');
			expect(res.body.mode).toBe('image_to_3d');
			expect(hfSubmit).toHaveBeenCalled();
			expect(replicateSubmit).not.toHaveBeenCalled();
		} finally {
			delete process.env.HF_TOKEN;
		}
	});

	it('sanitizes the paid-lane "insufficient credit" billing leak into an honest unavailable state', async () => {
		// No free reconstruct lane (HF_TOKEN unset) and the paid Replicate account is
		// out of credit — the buyer must never see the vendor billing message.
		delete process.env.HF_TOKEN;
		replicateSubmit.mockClear();
		const req = makeReq({ prompt: 'a red ceramic mug', tier: 'standard', path: 'image' });
		const res = makeRes();
		await handler(req, res);

		expect(replicateSubmit).toHaveBeenCalled(); // free lane unavailable → fell to paid
		expect(res.statusCode).toBe(503);
		expect(res.body.error).toBe('generation_unavailable');
		expect(res.body.message).not.toMatch(/credit|replicate|billing|insufficient/i);
		expect(res.headers['retry-after']).toBe('30');
	});

	it('routes an EXPLICIT huggingface pick to the free lane and never the paid one', async () => {
		// The user deliberately chose the free engine for a photo upload.
		process.env.HF_TOKEN = 'test-hf-token';
		replicateSubmit.mockClear();
		hfSubmit.mockClear();
		try {
			const req = makeReq({
				image_urls: ['https://cdn.example/photo.png'],
				backend: 'huggingface',
				tier: 'standard',
				path: 'image',
				skip_validation: true,
			});
			const res = makeRes();
			await handler(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.body.backend).toBe('huggingface');
			expect(res.body.mode).toBe('image_to_3d');
			expect(hfSubmit).toHaveBeenCalled();
			expect(replicateSubmit).not.toHaveBeenCalled();
		} finally {
			delete process.env.HF_TOKEN;
		}
	});

	it('surfaces a designed busy error (never a paid fallback) when an explicit free pick has no lane', async () => {
		// HF_TOKEN unset → the free Spaces provider is unavailable. An explicit free
		// pick must NOT silently spend on the paid Replicate account; it returns a
		// designed, retryable error instead.
		delete process.env.HF_TOKEN;
		replicateSubmit.mockClear();
		const req = makeReq({
			image_urls: ['https://cdn.example/photo.png'],
			backend: 'huggingface',
			tier: 'standard',
			path: 'image',
			skip_validation: true,
		});
		const res = makeRes();
		await handler(req, res);

		expect(res.statusCode).toBe(502);
		expect(res.body.error).toBe('provider_busy');
		expect(res.body.backend).toBe('huggingface');
		expect(replicateSubmit).not.toHaveBeenCalled();
	});

	it('restores the paid-default ORDER when FORGE_PREFER_FREE=false (Replicate tried first)', async () => {
		// The flag flips ORDER, not availability. With free-first OFF the paid
		// Replicate default is attempted FIRST; HF still serves as the post-failure
		// fallback (so the request doesn't dead-end), but only after Replicate is hit.
		// The tier-default resolver now resolves straight to 'huggingface' when it's
		// configured (the photoreal-reference-by-default fix), so this legacy
		// paid-vs-free ordering — internal to the 'trellis' backend's own reconstruct
		// fallback — is exercised via an EXPLICIT backend pick rather than the
		// implicit default.
		process.env.HF_TOKEN = 'test-hf-token';
		process.env.FORGE_PREFER_FREE = 'false';
		replicateSubmit.mockClear();
		hfSubmit.mockClear();
		try {
			const req = makeReq({ prompt: 'a red ceramic mug', tier: 'standard', path: 'image', backend: 'trellis' });
			const res = makeRes();
			await handler(req, res);

			// Replicate WAS tried first (legacy ordering) — contrast with the free-first
			// test where it is never called. HF then served it as the existing fallback.
			expect(replicateSubmit).toHaveBeenCalled();
			expect(res.body.backend).toBe('huggingface');
		} finally {
			delete process.env.HF_TOKEN;
			delete process.env.FORGE_PREFER_FREE;
		}
	});
});
