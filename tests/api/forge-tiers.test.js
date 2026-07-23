// Forge backend registry — registration + default-routing contract.
//
// Focuses on the free NVIDIA NIM lane (free-first platform policy): it is the
// default for draft AND standard tiers on text prompts WHEN configured, must
// never disturb other tiers or the geometry path, and must stay fully
// selectable. The provider module / live behavior is covered separately.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	BACKENDS,
	OUTPUTS,
	resolveBackendId,
	backendIsConfigured,
	outputIsConfigured,
	buildCatalog,
} from '../../api/_lib/forge-tiers.js';

describe('forge-tiers — NVIDIA NIM backend registration', () => {
	const prevKey = process.env.NVIDIA_API_KEY;
	const prevHf = process.env.HF_TOKEN;
	// Default routing now consults free-lane config (NVIDIA + HF). Start every test
	// with HF unset so the "no free image lane → paid last resort" assertions are
	// deterministic; tests that exercise the HF default opt in explicitly.
	beforeEach(() => {
		delete process.env.HF_TOKEN;
	});
	afterEach(() => {
		if (prevKey === undefined) delete process.env.NVIDIA_API_KEY;
		else process.env.NVIDIA_API_KEY = prevKey;
		if (prevHf === undefined) delete process.env.HF_TOKEN;
		else process.env.HF_TOKEN = prevHf;
	});

	it('registers a platform-keyed, free image-path backend', () => {
		const nv = BACKENDS.nvidia;
		expect(nv).toBeTruthy();
		expect(nv.provider).toBe('nvidia');
		expect(nv.byok).toBe(false);
		expect(nv.paths).toEqual(['image']);
		expect(nv.requiresEnv).toEqual(['NVIDIA_API_KEY']);
		expect(nv.free).toBe(true);
		expect(nv.credits).toBeNull();
		expect(nv.baseEta).toBeGreaterThan(0);
	});

	it('is configured only when NVIDIA_API_KEY is present', () => {
		delete process.env.NVIDIA_API_KEY;
		expect(backendIsConfigured('nvidia')).toBe(false);
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(backendIsConfigured('nvidia')).toBe(true);
	});

	describe('free-tier default routing', () => {
		it('falls to the paid TRELLIS last resort only when no free image lane is configured', () => {
			delete process.env.NVIDIA_API_KEY;
			delete process.env.HF_TOKEN;
			expect(resolveBackendId({ path: 'image', tier: 'draft' })).toBe('trellis');
			expect(resolveBackendId({ path: 'image', tier: 'standard' })).toBe('trellis');
			expect(resolveBackendId({ path: 'image', tier: 'high' })).toBe('trellis');
		});

		it('routes draft and standard tiers to the free NIM lane when configured', () => {
			process.env.NVIDIA_API_KEY = 'nvapi-test';
			expect(resolveBackendId({ path: 'image', tier: 'draft' })).toBe('nvidia');
			expect(resolveBackendId({ path: 'image', tier: 'standard' })).toBe('nvidia');
		});

		it('routes the high tier to the free textured engine, geometry stays BYOK Meshy', () => {
			process.env.NVIDIA_API_KEY = 'nvapi-test';
			process.env.HF_TOKEN = 'hf_test';
			// High is free-for-us too — the higher-quality HuggingFace engine, not paid Replicate.
			expect(resolveBackendId({ path: 'image', tier: 'high' })).toBe('huggingface');
			expect(resolveBackendId({ path: 'geometry', tier: 'draft' })).toBe('meshy');
			expect(resolveBackendId({ path: 'geometry', tier: 'standard' })).toBe('meshy');
		});
	});

	it('stays selectable at any tier when explicitly named', () => {
		delete process.env.NVIDIA_API_KEY;
		expect(resolveBackendId({ path: 'image', tier: 'standard', backend: 'nvidia' })).toBe('nvidia');
		expect(resolveBackendId({ path: 'image', tier: 'high', backend: 'nvidia' })).toBe('nvidia');
	});

	it('keeps other backends selectable on the draft tier even when NIM is the default', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(resolveBackendId({ path: 'image', tier: 'draft', backend: 'trellis' })).toBe('trellis');
	});

	it('surfaces the backend in the public catalog with honest estimates', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.HF_TOKEN = 'hf_test';
		const cat = buildCatalog();
		const nv = cat.backends.find((b) => b.id === 'nvidia');
		expect(nv).toBeTruthy();
		expect(nv.free).toBe(true);
		expect(nv.configured).toBe(true);
		expect(nv.byok).toBeNull();
		const draftEst = nv.estimates.image.find((e) => e.tier === 'draft');
		expect(draftEst.eta_seconds).toBeGreaterThan(0);
		expect(draftEst.credits).toBeNull();
		// The tier-aware default map advertises a free engine for every tier. With
		// only NVIDIA + HuggingFace configured (no self-host worker) in this test,
		// HuggingFace — an image-intermediate, reference-capable lane — outranks
		// NVIDIA's native text-only preview at every tier, matching the
		// photoreal-reference-by-default policy.
		expect(cat.default_backend_for_tier.draft.image).toBe('huggingface');
		expect(cat.default_backend_for_tier.standard.image).toBe('huggingface');
		expect(cat.default_backend_for_tier.high.image).toBe('huggingface');
	});

	// NVIDIA's hosted TRELLIS preview is text-only (rejects every user-image
	// input — see tasks/nvidia-nim/probes/trellis.md). Photo submissions must
	// never default onto it.
	it('routes photo submissions to the standing image backend, not the text-only free lane', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		// Photo uploads at draft and standard must route to trellis (NVIDIA is text-only).
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: true })).toBe('trellis');
		expect(resolveBackendId({ path: 'image', tier: 'standard', userImages: true })).toBe('trellis');
		// Prompt-only drafts and standard requests still get the free lane.
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: false })).toBe('nvidia');
		expect(resolveBackendId({ path: 'image', tier: 'draft' })).toBe('nvidia');
		expect(resolveBackendId({ path: 'image', tier: 'standard', userImages: false })).toBe('nvidia');
		expect(resolveBackendId({ path: 'image', tier: 'standard' })).toBe('nvidia');
	});

	it('honors an explicit nvidia selection in resolution (the handler owns the rejection)', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		expect(resolveBackendId({ path: 'image', tier: 'draft', backend: 'nvidia', userImages: true })).toBe('nvidia');
	});

	it('declares the text-only capability in the public catalog', () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const cat = buildCatalog();
		expect(cat.backends.find((b) => b.id === 'nvidia').user_images).toBe(false);
		expect(cat.backends.find((b) => b.id === 'trellis').user_images).toBe(true);
		expect(cat.backends.find((b) => b.id === 'meshy').user_images).toBe(true);
	});
});

// The free HuggingFace Spaces lane is the free option for PHOTO input — the
// counterpart to the text-only NVIDIA lane. It must surface in the catalog as a
// free, image-capable, platform-keyed engine gated on HF_TOKEN, and be an
// explicit opt-in (never the silent auto-default).
describe('forge-tiers — HuggingFace free image lane', () => {
	const prev = process.env.HF_TOKEN;
	const prevNv = process.env.NVIDIA_API_KEY;
	beforeEach(() => {
		delete process.env.NVIDIA_API_KEY;
	});
	afterEach(() => {
		if (prev === undefined) delete process.env.HF_TOKEN;
		else process.env.HF_TOKEN = prev;
		if (prevNv === undefined) delete process.env.NVIDIA_API_KEY;
		else process.env.NVIDIA_API_KEY = prevNv;
	});

	it('registers a free, platform-keyed image backend that accepts user photos', () => {
		const hf = BACKENDS.huggingface;
		expect(hf).toBeTruthy();
		expect(hf.provider).toBe('huggingface');
		expect(hf.byok).toBe(false);
		expect(hf.paths).toEqual(['image']);
		expect(hf.requiresEnv).toEqual(['HF_TOKEN']);
		expect(hf.free).toBe(true);
		expect(hf.userImages).toBe(true);
		expect(hf.credits).toBeNull();
		expect(hf.baseEta).toBeGreaterThan(0);
	});

	it('is configured only when HF_TOKEN is present', () => {
		delete process.env.HF_TOKEN;
		expect(backendIsConfigured('huggingface')).toBe(false);
		process.env.HF_TOKEN = 'hf_test';
		expect(backendIsConfigured('huggingface')).toBe(true);
	});

	it('surfaces in the catalog as a free, photo-capable, selectable engine', () => {
		process.env.HF_TOKEN = 'hf_test';
		const hf = buildCatalog().backends.find((b) => b.id === 'huggingface');
		expect(hf).toBeTruthy();
		expect(hf.free).toBe(true);
		expect(hf.user_images).toBe(true);
		expect(hf.byok).toBeNull();
		expect(hf.configured).toBe(true);
		const est = hf.estimates.image.find((e) => e.tier === 'standard');
		expect(est.eta_seconds).toBeGreaterThan(0);
		expect(est.credits).toBeNull();
	});

	it('stays selectable when explicitly named on the image path with photos', () => {
		expect(
			resolveBackendId({ path: 'image', tier: 'standard', backend: 'huggingface', userImages: true }),
		).toBe('huggingface');
	});

	// Free-for-us routing: the HF lane is the auto default for the cases NVIDIA's
	// text-only preview can't serve — photo submissions at any tier, and the
	// higher-quality High tier — so a free deployment never falls onto the paid
	// Replicate lane for them.
	it('becomes the auto default for photo submissions and the high tier when configured', () => {
		process.env.HF_TOKEN = 'hf_test';
		delete process.env.NVIDIA_API_KEY;
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: true })).toBe('huggingface');
		expect(resolveBackendId({ path: 'image', tier: 'standard', userImages: true })).toBe('huggingface');
		expect(resolveBackendId({ path: 'image', tier: 'high' })).toBe('huggingface');
		expect(resolveBackendId({ path: 'image', tier: 'high', userImages: true })).toBe('huggingface');
	});

	it('falls back to the paid lane only when no free engine is configured', () => {
		delete process.env.HF_TOKEN;
		delete process.env.NVIDIA_API_KEY;
		expect(resolveBackendId({ path: 'image', tier: 'standard' })).toBe('trellis');
		expect(resolveBackendId({ path: 'image', tier: 'high' })).toBe('trellis');
	});
});

// The Hunyuan3D lane runs on its own Cloud Run worker. It must never report
// configured off the avatar pipeline's GCP_RECONSTRUCTION_URL — that service's
// face pipeline rejects every non-face image, so the lane looked live in the
// catalog while failing 100% of general prompts (prod incident 2026-06-12).
describe('forge-tiers — Hunyuan3D self-host configuration', () => {
	const saved = {};
	const VARS = ['GCP_HUNYUAN3D_URL', 'GCP_RECONSTRUCTION_URL', 'GCP_RECONSTRUCTION_KEY'];
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
	});

	it('requires the dedicated worker URL, not the avatar pipeline URL', () => {
		expect(BACKENDS.hunyuan3d.requiresEnv).toEqual(['GCP_HUNYUAN3D_URL', 'GCP_RECONSTRUCTION_KEY']);
	});

	it('stays unconfigured when only the avatar pipeline is deployed', () => {
		process.env.GCP_RECONSTRUCTION_URL = 'https://avatar-reconstruction.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		expect(backendIsConfigured('hunyuan3d')).toBe(false);
		expect(buildCatalog().backends.find((b) => b.id === 'hunyuan3d').configured).toBe(false);
	});

	it('reports configured once its own worker URL and key are set', () => {
		process.env.GCP_HUNYUAN3D_URL = 'https://hunyuan3d.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		expect(backendIsConfigured('hunyuan3d')).toBe(true);
		expect(buildCatalog().backends.find((b) => b.id === 'hunyuan3d').configured).toBe(true);
	});
});

// Game-Ready is a post-generation export option (not a generation backend). It
// must appear in the public catalog's `outputs` with honest ETA + price fields
// so the result view can advertise it, and report configured only when the
// remesh worker env is present.
describe('forge-tiers — Game-Ready export output', () => {
	const saved = {};
	const VARS = ['GCP_REMESH_URL', 'GCP_RECONSTRUCTION_KEY'];
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
	});

	it('registers a remesh-worker-backed export with quad + tri topologies and GLB/FBX formats', () => {
		const gr = OUTPUTS.gameready;
		expect(gr).toBeTruthy();
		expect(gr.topologies).toEqual(['quad', 'tri']);
		expect(gr.formats).toEqual(['glb', 'fbx']);
		expect(gr.requiresEnv).toEqual(['GCP_REMESH_URL', 'GCP_RECONSTRUCTION_KEY']);
		expect(gr.baseEta).toBeGreaterThan(0);
		expect(gr.priceUsdcAtomics).toBeGreaterThan(0);
		expect(gr.polyPresets.length).toBeGreaterThan(0);
	});

	it('reports configured only when the remesh worker URL and key are set', () => {
		expect(outputIsConfigured('gameready')).toBe(false);
		process.env.GCP_REMESH_URL = 'https://remesh.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		expect(outputIsConfigured('gameready')).toBe(true);
	});

	it('advertises the option in the public catalog with valid ETA + cost fields', () => {
		process.env.GCP_REMESH_URL = 'https://remesh.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		const cat = buildCatalog();
		expect(Array.isArray(cat.outputs)).toBe(true);
		const gr = cat.outputs.find((o) => o.id === 'gameready');
		expect(gr).toBeTruthy();
		expect(gr.label).toBe('Game-Ready');
		expect(gr.topologies).toEqual(['quad', 'tri']);
		expect(gr.formats).toEqual(['glb', 'fbx']);
		expect(gr.eta_seconds).toBeGreaterThan(0);
		expect(gr.price_usdc_atomics).toBeGreaterThan(0);
		expect(gr.price_usdc).toMatch(/^\d+\.\d{2}$/);
		expect(gr.poly_presets.length).toBeGreaterThan(0);
		expect(gr.configured).toBe(true);
	});

	it('reports the catalog output as not configured when the worker env is absent', () => {
		const gr = buildCatalog().outputs.find((o) => o.id === 'gameready');
		expect(gr.configured).toBe(false);
	});
});
