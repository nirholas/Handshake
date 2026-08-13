// Meshy BYOK provider (api/_providers/meshy.js): wire contract + failure paths.
//
// Meshy backs two forge paths on two different API versions:
//   text→geometry  POST /openapi/v2/text-to-3d  (mode "preview", no intermediate image)
//   image→3D       POST /openapi/v1/image-to-3d (native geometry + PBR)
// Both are async: submit returns a task id, status polls the matching GET route.
//
// global fetch is stubbed to model Meshy's real wire protocol (verified against
// their published API shapes); no network and no mocked product data.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMeshyProvider } from '../../api/_providers/meshy.js';

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

const TIER = { id: 'standard', polycount: 30_000, pbr: false, hd: false };

describe('meshy provider: construction', () => {
	it('refuses to construct without an API key', () => {
		expect(() => createMeshyProvider('')).toThrowError(/key is required/i);
		try {
			createMeshyProvider(null);
		} catch (err) {
			expect(err.code).toBe('missing_key');
		}
	});
});

describe('meshy provider: text→geometry submit', () => {
	it('posts the v2 preview body and returns the text-to-3d poll handle', async () => {
		let captured;
		globalThis.fetch = vi.fn(async (url, opts) => {
			captured = { url: String(url), body: JSON.parse(opts.body), headers: opts.headers };
			return { ok: true, status: 200, json: async () => ({ result: 'task-abc' }) };
		});

		const provider = createMeshyProvider('msy_test');
		const out = await provider.textToGeometry({ prompt: 'a brass telescope', tier: TIER });

		expect(captured.url).toBe('https://api.meshy.ai/openapi/v2/text-to-3d');
		expect(captured.headers.authorization).toBe('Bearer msy_test');
		expect(captured.body.mode).toBe('preview');
		expect(captured.body.prompt).toBe('a brass telescope');
		expect(captured.body.target_polycount).toBe(30_000);
		expect(captured.body.target_formats).toEqual(['glb']);
		expect(out).toEqual({ kind: 'text-to-3d', taskId: 'task-abc' });
	});

	it('clamps a tier poly budget into Meshy\'s accepted 100-300,000 window', async () => {
		const bodies = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			bodies.push(JSON.parse(opts.body));
			return { ok: true, status: 200, json: async () => ({ result: 't' }) };
		});

		const provider = createMeshyProvider('msy_test');
		await provider.textToGeometry({ prompt: 'x', tier: { polycount: 5_000_000 } });
		await provider.textToGeometry({ prompt: 'x', tier: { polycount: 0 } });

		expect(bodies[0].target_polycount).toBe(300_000);
		expect(bodies[1].target_polycount).toBe(100);
	});
});

describe('meshy provider: image→3D submit', () => {
	it('posts the v1 image body with the tier\'s PBR/HD knobs and an optional texture prompt', async () => {
		let captured;
		globalThis.fetch = vi.fn(async (url, opts) => {
			captured = { url: String(url), body: JSON.parse(opts.body) };
			// Some Meshy endpoints answer with { id } rather than { result }.
			return { ok: true, status: 200, json: async () => ({ id: 'img-task-1' }) };
		});

		const provider = createMeshyProvider('msy_test');
		const out = await provider.imageTo3d({
			imageUrl: 'https://cdn.example.com/reference.png',
			prompt: 'weathered bronze',
			tier: { id: 'high', polycount: 120_000, pbr: true, hd: true },
		});

		expect(captured.url).toBe('https://api.meshy.ai/openapi/v1/image-to-3d');
		expect(captured.body.image_url).toBe('https://cdn.example.com/reference.png');
		expect(captured.body.enable_pbr).toBe(true);
		expect(captured.body.hd_texture).toBe(true);
		expect(captured.body.should_texture).toBe(true);
		expect(captured.body.texture_prompt).toBe('weathered bronze');
		expect(out).toEqual({ kind: 'image-to-3d', taskId: 'img-task-1' });
	});

	it('omits texture_prompt entirely when the caller supplies no prompt', async () => {
		let body;
		globalThis.fetch = vi.fn(async (url, opts) => {
			body = JSON.parse(opts.body);
			return { ok: true, status: 200, json: async () => ({ result: 't' }) };
		});

		const provider = createMeshyProvider('msy_test');
		await provider.imageTo3d({ imageUrl: 'https://cdn.example.com/r.png', tier: TIER });
		expect('texture_prompt' in body).toBe(false);
	});
});

describe('meshy provider: normalized submit errors', () => {
	const CASES = [
		{ status: 401, code: 'invalid_key', mapped: 401 },
		{ status: 403, code: 'invalid_key', mapped: 401 },
		{ status: 402, code: 'insufficient_credits', mapped: 402 },
		{ status: 429, code: 'rate_limited', mapped: 429 },
		{ status: 500, code: 'provider_error', mapped: 502 },
	];

	for (const c of CASES) {
		it(`maps HTTP ${c.status} → ${c.code}`, async () => {
			globalThis.fetch = vi.fn(async () => ({
				ok: c.status < 400,
				status: c.status,
				json: async () => ({ message: 'upstream said no' }),
			}));
			const provider = createMeshyProvider('msy_test');
			await expect(provider.textToGeometry({ prompt: 'x', tier: TIER })).rejects.toMatchObject({
				code: c.code,
				status: c.mapped,
				providerStatus: c.status,
			});
		});
	}

	it('maps a network throw to provider_unreachable', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNRESET');
		});
		const provider = createMeshyProvider('msy_test');
		await expect(provider.imageTo3d({ imageUrl: 'https://x/a.png', tier: TIER })).rejects.toMatchObject({
			code: 'provider_unreachable',
			status: 502,
		});
	});

	it('rejects an accepted task that carries no id', async () => {
		globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
		const provider = createMeshyProvider('msy_test');
		await expect(provider.textToGeometry({ prompt: 'x', tier: TIER })).rejects.toMatchObject({
			code: 'provider_error',
			status: 502,
		});
	});
});

describe('meshy provider: status polling', () => {
	it('polls the endpoint matching the task kind and resolves the GLB when SUCCEEDED', async () => {
		let polled;
		globalThis.fetch = vi.fn(async (url) => {
			polled = String(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					status: 'SUCCEEDED',
					progress: 100,
					consumed_credits: 5,
					model_urls: { glb: 'https://assets.meshy.ai/task-abc/model.glb' },
				}),
			};
		});

		const provider = createMeshyProvider('msy_test');
		const res = await provider.status({ kind: 'text-to-3d', taskId: 'task-abc' });

		expect(polled).toBe('https://api.meshy.ai/openapi/v2/text-to-3d/task-abc');
		expect(res.status).toBe('done');
		expect(res.progress).toBe(100);
		expect(res.credits).toBe(5);
		expect(res.resultGlbUrl).toBe('https://assets.meshy.ai/task-abc/model.glb');
	});

	it('maps PENDING/IN_PROGRESS onto the queued/running states', async () => {
		const provider = createMeshyProvider('msy_test');
		for (const [upstream, expected] of [['PENDING', 'queued'], ['IN_PROGRESS', 'running']]) {
			globalThis.fetch = vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ status: upstream, progress: 42 }),
			}));
			const res = await provider.status({ kind: 'image-to-3d', taskId: 't' });
			expect(res.status).toBe(expected);
			expect(res.progress).toBe(42);
		}
	});

	it('surfaces the upstream task error text when Meshy reports FAILED', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'FAILED', task_error: { message: 'mesh generation diverged' } }),
		}));
		const provider = createMeshyProvider('msy_test');
		const res = await provider.status({ kind: 'text-to-3d', taskId: 't' });
		expect(res.status).toBe('failed');
		expect(res.error).toBe('mesh generation diverged');
	});

	it('reports failed when a finished task carries no GLB', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'SUCCEEDED', model_urls: {} }),
		}));
		const provider = createMeshyProvider('msy_test');
		const res = await provider.status({ kind: 'text-to-3d', taskId: 't' });
		expect(res.status).toBe('done');
		expect(res.resultGlbUrl).toBeUndefined();
		expect(res.error).toMatch(/no GLB/i);
	});

	it('keeps the job alive on a transient poll failure, but fails on 404', async () => {
		const provider = createMeshyProvider('msy_test');

		globalThis.fetch = vi.fn(async () => {
			throw new Error('socket hang up');
		});
		const thrown = await provider.status({ kind: 'text-to-3d', taskId: 't' });
		expect(thrown.status).toBe('running');

		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
		const flaky = await provider.status({ kind: 'text-to-3d', taskId: 't' });
		expect(flaky.status).toBe('running');

		globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
		const gone = await provider.status({ kind: 'text-to-3d', taskId: 't' });
		expect(gone.status).toBe('failed');
		expect(gone.error).toMatch(/not found/i);
	});

	it('fails fast on an unknown task kind without touching the network', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('should not be called');
		});
		const provider = createMeshyProvider('msy_test');
		const res = await provider.status({ kind: 'video-to-3d', taskId: 't' });
		expect(res.status).toBe('failed');
		expect(res.error).toMatch(/unknown meshy task kind/i);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
