// Self-hosted TRELLIS image→3D lane — registration, env-gated config, routing
// precedence, and the gcp provider's `trellis` mode wire contract.
//
// This lane wires our own Microsoft TRELLIS worker (workers/model-trellis) into
// /forge as a NATIVE single-hop image→3D engine: image → TRELLIS → GLB, no FLUX
// intermediate, no vendor cost. Unlike NVIDIA's hosted preview (text-only), a
// self-deployed NIM accepts real user photos, so this is the preferred free image
// lane when MODEL_TRELLIS_URL is configured. The worker speaks the standard task
// shape (POST /infer → GET /tasks/:id → result_gcs_url), distinct from the avatar
// pipeline's face-only `reconstruct` (/reconstruct + /jobs/:id).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	BACKENDS,
	resolveBackendId,
	backendIsConfigured,
	buildCatalog,
} from '../../api/_lib/forge-tiers.js';
import { createRegenProvider } from '../../api/_providers/gcp.js';

const VARS = [
	'MODEL_TRELLIS_URL',
	'GCP_RECONSTRUCTION_KEY',
	'NVIDIA_API_KEY',
	'HF_TOKEN',
];
const saved = {};
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
	for (const v of VARS) {
		saved[v] = process.env[v];
		delete process.env[v];
	}
});
afterEach(() => {
	for (const v of VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
	globalThis.fetch = ORIGINAL_FETCH;
	vi.restoreAllMocks();
});

describe('forge-tiers — self-hosted TRELLIS backend registration', () => {
	it('registers a free, platform-keyed image backend that accepts user photos', () => {
		const b = BACKENDS.trellis_selfhost;
		expect(b).toBeTruthy();
		expect(b.provider).toBe('gcp');
		expect(b.byok).toBe(false);
		expect(b.paths).toEqual(['image']);
		expect(b.requiresEnv).toEqual(['MODEL_TRELLIS_URL', 'GCP_RECONSTRUCTION_KEY']);
		expect(b.free).toBe(true);
		expect(b.userImages).toBe(true);
		expect(b.credits).toBeNull();
		expect(b.baseEta).toBeGreaterThan(0);
	});

	it('is configured only when BOTH the worker URL and the shared key are present', () => {
		expect(backendIsConfigured('trellis_selfhost')).toBe(false);
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		expect(backendIsConfigured('trellis_selfhost')).toBe(false); // key still missing
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		expect(backendIsConfigured('trellis_selfhost')).toBe(true);
	});

	it('surfaces in the catalog as a free, photo-capable, selectable engine', () => {
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		const b = buildCatalog().backends.find((x) => x.id === 'trellis_selfhost');
		expect(b).toBeTruthy();
		expect(b.free).toBe(true);
		expect(b.user_images).toBe(true);
		expect(b.byok).toBeNull();
		expect(b.configured).toBe(true);
		const est = b.estimates.image.find((e) => e.tier === 'standard');
		expect(est.eta_seconds).toBeGreaterThan(0);
		expect(est.credits).toBeNull();
	});
});

describe('forge-tiers — self-hosted TRELLIS routing precedence', () => {
	it('becomes the preferred free image lane for photo submissions when configured', () => {
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		process.env.HF_TOKEN = 'hf_test'; // HF also live — TRELLIS must still win the photo default
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		// Draft/standard photo uploads route to our self-hosted TRELLIS, ahead of HF.
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: true })).toBe('trellis_selfhost');
		expect(resolveBackendId({ path: 'image', tier: 'standard', userImages: true })).toBe('trellis_selfhost');
	});

	it('leads text prompts with the self-host photoreal reference pipeline too; high stays on self-host TRELLIS', () => {
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		process.env.HF_TOKEN = 'hf_test';
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		// Text prompts at draft/standard now default to the self-host TRELLIS
		// image-intermediate lane too — NVIDIA's native single-hop text→mesh
		// preview skips the photoreal reference image, so it is no longer a
		// named tier default anywhere (see forge-tiers.js FREE_DEFAULT_FOR_TIERS).
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: false })).toBe('trellis_selfhost');
		expect(resolveBackendId({ path: 'image', tier: 'standard', userImages: false })).toBe('trellis_selfhost');
		// High names our self-host Hunyuan3D engine; unconfigured here, so the
		// candidate walk falls to the self-host TRELLIS lane.
		expect(resolveBackendId({ path: 'image', tier: 'high' })).toBe('trellis_selfhost');
	});

	it('degrades cleanly to HuggingFace when the worker URL is absent', () => {
		// No MODEL_TRELLIS_URL → trellis_selfhost unconfigured → HF serves photos.
		process.env.HF_TOKEN = 'hf_test';
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: true })).toBe('huggingface');
	});

	it('stays explicitly selectable (the handler owns any rejection)', () => {
		// Even unconfigured, an explicit pick is honored at resolution time.
		expect(
			resolveBackendId({ path: 'image', tier: 'standard', backend: 'trellis_selfhost', userImages: true }),
		).toBe('trellis_selfhost');
	});
});

describe('gcp provider — trellis mode wire contract', () => {
	it('submits image→3D to the worker /infer endpoint and packs a pollable job', async () => {
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';

		const fetchMock = vi.fn(async (url, opts) => {
			expect(url).toBe('https://trellis.example.run.app/infer');
			const body = JSON.parse(opts.body);
			expect(body.images).toEqual(['https://three.ws/cdn/photo.png']);
			expect(body.body_type).toBe('neutral');
			expect(opts.headers.authorization).toBe('Bearer secret');
			return new Response(JSON.stringify({ task_id: 'task-123', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});
		globalThis.fetch = fetchMock;

		const provider = createRegenProvider();
		const submitted = await provider.submit({
			mode: 'trellis',
			sourceUrl: 'https://three.ws/cdn/photo.png',
			params: { images: ['https://three.ws/cdn/photo.png'] },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(submitted.extJobId).toBeTruthy();
		expect(submitted.backend).toBe('gcp');
		expect(submitted.viewsUsed).toBe(1);
		expect(submitted.eta).toBeGreaterThan(0);
	});

	it('polls /tasks/:id and surfaces result_gcs_url as the GLB url on done', async () => {
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';

		// First call: submit (202 + task_id). Second call: poll (200 + done).
		const calls = [];
		globalThis.fetch = vi.fn(async (url) => {
			calls.push(url);
			if (url.endsWith('/infer')) {
				return new Response(JSON.stringify({ task_id: 'task-xyz', status: 'queued' }), {
					status: 202,
					headers: { 'content-type': 'application/json' },
				});
			}
			// poll
			expect(url).toBe('https://trellis.example.run.app/tasks/task-xyz');
			return new Response(
				JSON.stringify({
					task_id: 'task-xyz',
					status: 'done',
					result_gcs_url: 'https://storage.googleapis.com/bucket/raw-meshes/trellis/task-xyz.glb',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		});

		const provider = createRegenProvider();
		const submitted = await provider.submit({
			mode: 'trellis',
			sourceUrl: 'https://three.ws/cdn/photo.png',
			params: { images: ['https://three.ws/cdn/photo.png'] },
		});
		const status = await provider.status(submitted.extJobId);
		expect(status.status).toBe('done');
		expect(status.resultGlbUrl).toBe(
			'https://storage.googleapis.com/bucket/raw-meshes/trellis/task-xyz.glb',
		);
	});
});

// ── Tier-scaled quality budgets (SELFHOST_TRELLIS_QUALITY) ───────────────────
// Standard/high must buy real sampler/export budget on our own GPU, and the
// gcp provider must forward exactly that object to the worker's /infer body.
describe('forge-tiers — self-host TRELLIS per-tier quality budgets', () => {
	it('scales sampler steps, kept geometry, and texture size with the tier', async () => {
		const { SELFHOST_TRELLIS_QUALITY, selfhostQualityForTier } = await import(
			'../../api/_lib/forge-tiers.js'
		);
		const draft = selfhostQualityForTier('draft');
		const standard = selfhostQualityForTier('standard');
		const high = selfhostQualityForTier('high');

		expect(draft).toBe(SELFHOST_TRELLIS_QUALITY.draft);
		expect(standard.ss_steps).toBeGreaterThan(draft.ss_steps);
		expect(high.ss_steps).toBeGreaterThan(standard.ss_steps);
		expect(high.slat_steps).toBeGreaterThan(standard.slat_steps);
		// simplify is the fraction REMOVED — higher tiers keep more triangles.
		expect(standard.simplify).toBeLessThan(draft.simplify);
		expect(high.simplify).toBeLessThan(standard.simplify);
		expect(high.texture_size).toBeGreaterThanOrEqual(standard.texture_size);
		// Worker clamps: stay inside the envelope it accepts (texture ceiling
		// raised 2048→4096 alongside the worker's own quality-clamp bump).
		for (const q of [draft, standard, high]) {
			expect(q.ss_steps).toBeLessThanOrEqual(50);
			expect(q.slat_steps).toBeLessThanOrEqual(50);
			expect(q.texture_size).toBeLessThanOrEqual(4096);
		}
	});

	it('falls back to the standard budget for an unknown tier id', async () => {
		const { SELFHOST_TRELLIS_QUALITY, selfhostQualityForTier } = await import(
			'../../api/_lib/forge-tiers.js'
		);
		expect(selfhostQualityForTier('nope')).toBe(SELFHOST_TRELLIS_QUALITY.standard);
		expect(selfhostQualityForTier(undefined)).toBe(SELFHOST_TRELLIS_QUALITY.standard);
	});

	it('names hunyuan3d for the high tier and keeps huggingface only as fallback', async () => {
		const { FREE_DEFAULT_FOR_TIERS, FREE_FALLBACK_FOR_PATH } = await import(
			'../../api/_lib/forge-tiers.js'
		);
		expect(FREE_DEFAULT_FOR_TIERS.high.image).toBe('hunyuan3d');
		expect(FREE_FALLBACK_FOR_PATH.image).toContain('huggingface');
	});
});

describe('gcp provider — trellis quality forwarding', () => {
	beforeEach(() => {
		process.env.MODEL_TRELLIS_URL = 'https://model-trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'test-worker-key';
	});

	it('forwards the quality object and seed verbatim in the /infer body', async () => {
		const calls = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push({ url: String(url), body: JSON.parse(opts.body) });
			return new Response(JSON.stringify({ task_id: 'tsk_1', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});
		try {
			const { createRegenProvider: mk } = await import('../../api/_providers/gcp.js');
			const gcp = mk();
			const quality = { ss_steps: 45, slat_steps: 45, simplify: 0.85, texture_size: 2048 };
			await gcp.submit({
				mode: 'trellis',
				sourceUrl: 'https://three.ws/cdn/ref.png',
				params: { images: ['https://three.ws/cdn/ref.png'], seed: 7, quality },
			});
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toContain('/infer');
			expect(calls[0].body.quality).toEqual(quality);
			expect(calls[0].body.seed).toBe(7);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it('forwards matte:true only when the caller requests background pre-matting', async () => {
		const bodies = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url, opts) => {
			bodies.push(JSON.parse(opts.body));
			return new Response(JSON.stringify({ task_id: 'tsk_m', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});
		try {
			const { createRegenProvider: mk } = await import('../../api/_providers/gcp.js');
			const gcp = mk();
			await gcp.submit({
				mode: 'trellis',
				sourceUrl: 'https://three.ws/cdn/ref.png',
				params: { images: ['https://three.ws/cdn/ref.png'], matte: true },
			});
			await gcp.submit({
				mode: 'trellis',
				sourceUrl: 'https://three.ws/cdn/ref.png',
				params: { images: ['https://three.ws/cdn/ref.png'] },
			});
			expect(bodies[0].matte).toBe(true);
			expect(bodies[1]).not.toHaveProperty('matte');
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it('omits quality/seed entirely when the caller sends none (worker defaults apply)', async () => {
		const calls = [];
		const origFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (url, opts) => {
			calls.push({ body: JSON.parse(opts.body) });
			return new Response(JSON.stringify({ task_id: 'tsk_2', status: 'queued' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});
		try {
			const { createRegenProvider: mk } = await import('../../api/_providers/gcp.js');
			const gcp = mk();
			await gcp.submit({
				mode: 'trellis',
				sourceUrl: 'https://three.ws/cdn/ref.png',
				params: { images: ['https://three.ws/cdn/ref.png'] },
			});
			expect(calls[0].body).not.toHaveProperty('quality');
			expect(calls[0].body).not.toHaveProperty('seed');
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});
