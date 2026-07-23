// Health-aware self-host routing + cold-start ETA + free/paid cost class.
//
// The self-host GPU lanes (our own Cloud Run workers) are the resilient default:
// routing prefers a HEALTHY self-host lane, then another healthy free lane, and
// only the paid Replicate default when every free lane is confirmed down. These
// tests drive the PURE resolver with an injected health map (no network), plus the
// cold-start ETA helper and the free-vs-paid cost classifier.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	freeLaneCandidates,
	resolveBackendId,
	resolveBackendIdWithHealth,
	defaultBackendForHealthAware,
	estimateEtaSeconds,
	coldStartSecondsFor,
	backendCostClass,
	isSelfHostBackend,
	isFreeBackend,
	selfHostPrimary,
	DEFAULT_BACKEND_FOR_PATH,
} from '../../api/_lib/forge-tiers.js';

const ALL_LANE_VARS = [
	'MODEL_TRELLIS_URL',
	'GCP_HUNYUAN3D_URL',
	'GCP_TRIPOSG_URL',
	'GCP_RECONSTRUCTION_KEY',
	'HF_TOKEN',
	'NVIDIA_API_KEY',
	'REPLICATE_API_TOKEN',
	'FORGE_SELFHOST_PRIMARY',
];
const saved = {};

function configureAllLanes() {
	process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
	process.env.GCP_HUNYUAN3D_URL = 'https://hunyuan.example.run.app';
	process.env.GCP_TRIPOSG_URL = 'https://triposg.example.run.app';
	process.env.GCP_RECONSTRUCTION_KEY = 'secret';
	process.env.HF_TOKEN = 'hf_test';
	process.env.NVIDIA_API_KEY = 'nvapi-test';
	process.env.REPLICATE_API_TOKEN = 'r8_test';
}

beforeEach(() => {
	for (const v of ALL_LANE_VARS) {
		saved[v] = process.env[v];
		delete process.env[v];
	}
});
afterEach(() => {
	for (const v of ALL_LANE_VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

describe('freeLaneCandidates — ordered, configured, de-duplicated', () => {
	it('orders our own GPU workers ahead of the free external lane for photos', () => {
		configureAllLanes();
		// Photo: NVIDIA's text-only preview is excluded; self-host workers lead.
		expect(freeLaneCandidates('image', 'draft', true)).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
		]);
	});

	it('leads text prompts with the self-host photoreal reference pipeline; native NVIDIA text lane trails', () => {
		configureAllLanes();
		// Text (userImages=false): the tier-named image-intermediate lane leads (the
		// reference-image pipeline), NVIDIA's native text→mesh preview is the last
		// free-lane resort since it skips the photoreal reference image entirely.
		expect(freeLaneCandidates('image', 'draft', false)).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
			'nvidia',
		]);
	});

	it('drops unconfigured lanes and never duplicates one that is both named and a fallback', () => {
		// Only the self-host TRELLIS worker is wired.
		process.env.MODEL_TRELLIS_URL = 'https://trellis.example.run.app';
		process.env.GCP_RECONSTRUCTION_KEY = 'secret';
		expect(freeLaneCandidates('image', 'standard', true)).toEqual(['trellis_selfhost']);
		expect(freeLaneCandidates('image', 'standard', false)).toEqual(['trellis_selfhost']);
	});
});

describe('FORGE_SELFHOST_PRIMARY — hoist our own GPU fleet ahead of hosted free lanes', () => {
	it('parses the flag: off unless explicitly truthy', () => {
		delete process.env.FORGE_SELFHOST_PRIMARY;
		expect(selfHostPrimary()).toBe(false);
		for (const on of ['1', 'true', 'on', 'yes', 'YES']) {
			process.env.FORGE_SELFHOST_PRIMARY = on;
			expect(selfHostPrimary()).toBe(true);
		}
		for (const off of ['0', 'false', 'off', 'no', '']) {
			process.env.FORGE_SELFHOST_PRIMARY = off;
			expect(selfHostPrimary()).toBe(false);
		}
	});

	it('off (default) already leads with self-host TRELLIS — the photoreal reference default', () => {
		configureAllLanes();
		delete process.env.FORGE_SELFHOST_PRIMARY;
		expect(freeLaneCandidates('image', 'draft', false)).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
			'nvidia',
		]);
	});

	it('on: self-host workers lead for text, hosted lanes remain as fallthrough (no-op vs. off)', () => {
		configureAllLanes();
		process.env.FORGE_SELFHOST_PRIMARY = '1';
		// The named draft/standard default is now itself a self-host lane
		// (trellis_selfhost), so hoisting self-host ahead of hosted lanes is a
		// no-op here — the order matches the flag-off case exactly.
		expect(freeLaneCandidates('image', 'draft', false)).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
			'nvidia',
		]);
	});

	it('on: photo lane already self-host-first is unchanged', () => {
		configureAllLanes();
		process.env.FORGE_SELFHOST_PRIMARY = '1';
		expect(freeLaneCandidates('image', 'draft', true)).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
		]);
	});

	it('on: is a no-op when no self-host worker is configured (lanes still filtered)', () => {
		// Only hosted lanes wired — flag has nothing to hoist, order is unchanged.
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		process.env.HF_TOKEN = 'hf_test';
		process.env.FORGE_SELFHOST_PRIMARY = '1';
		expect(freeLaneCandidates('image', 'draft', false)).toEqual(['huggingface', 'nvidia']);
	});

	it('on: routes an unnamed text prompt to self-host TRELLIS via the resolver', () => {
		configureAllLanes();
		process.env.FORGE_SELFHOST_PRIMARY = '1';
		expect(resolveBackendId({ path: 'image', tier: 'draft', userImages: false })).toBe('trellis_selfhost');
		// Health-aware twin agrees when the fleet is healthy.
		expect(
			resolveBackendIdWithHealth({
				path: 'image',
				tier: 'draft',
				userImages: false,
				health: { trellis_selfhost: 'ok' },
			}),
		).toBe('trellis_selfhost');
	});
});

describe('resolveBackendIdWithHealth — prefer healthy self-host → other free → paid', () => {
	beforeEach(configureAllLanes);

	it('routes a photo to the healthy self-host TRELLIS worker', () => {
		const health = { trellis_selfhost: 'ok', hunyuan3d: 'ok', huggingface: 'ok' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health })).toBe(
			'trellis_selfhost',
		);
	});

	it('skips a down self-host lane and falls to the next healthy self-host worker', () => {
		const health = { trellis_selfhost: 'down', hunyuan3d: 'ok', huggingface: 'ok' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health })).toBe(
			'hunyuan3d',
		);
	});

	it('falls to the healthy free external lane when both self-host workers are down', () => {
		const health = { trellis_selfhost: 'down', hunyuan3d: 'down', huggingface: 'ok' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health })).toBe(
			'huggingface',
		);
	});

	it('falls to the paid standing default only when every free lane is confirmed down', () => {
		const health = { trellis_selfhost: 'down', hunyuan3d: 'down', huggingface: 'down' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health })).toBe(
			DEFAULT_BACKEND_FOR_PATH.image,
		);
		expect(DEFAULT_BACKEND_FOR_PATH.image).toBe('trellis');
	});

	it('treats unknown/degraded health as usable (never blocks on missing telemetry)', () => {
		// trellis_selfhost has no entry (unknown) → still picked, ahead of an ok HF.
		const health = { huggingface: 'ok' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health })).toBe(
			'trellis_selfhost',
		);
		// A degraded self-host lane is skipped only if a later candidate is ok.
		const health2 = { trellis_selfhost: 'degraded', hunyuan3d: 'ok' };
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true, health: health2 })).toBe(
			'hunyuan3d',
		);
	});

	it('leads text with self-host TRELLIS regardless of NVIDIA health; falls to the next lane when self-host is down', () => {
		// trellis_selfhost has no health entry (unknown) — missing telemetry never
		// demotes the preferred lane, so it wins even though nvidia reports 'ok'.
		expect(
			resolveBackendIdWithHealth({ path: 'image', tier: 'draft', userImages: false, health: { nvidia: 'ok' } }),
		).toBe('trellis_selfhost');
		expect(
			resolveBackendIdWithHealth({
				path: 'image',
				tier: 'draft',
				userImages: false,
				health: { trellis_selfhost: 'down', hunyuan3d: 'ok' },
			}),
		).toBe('hunyuan3d');
	});

	it('honors an explicitly named backend regardless of health', () => {
		const health = { trellis_selfhost: 'ok' };
		expect(
			resolveBackendIdWithHealth({ path: 'image', tier: 'standard', backend: 'meshy', userImages: true, health }),
		).toBe('meshy');
	});

	it('with no health map, matches the env-only resolver exactly', () => {
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'standard', userImages: true })).toBe(
			resolveBackendId({ path: 'image', tier: 'standard', userImages: true }),
		);
		expect(resolveBackendIdWithHealth({ path: 'image', tier: 'draft', userImages: false })).toBe(
			resolveBackendId({ path: 'image', tier: 'draft', userImages: false }),
		);
	});

	it('routes sketch to the self-host TripoSG worker, paid never selected', () => {
		expect(
			defaultBackendForHealthAware('sketch', 'standard', true, { triposg: 'ok' }),
		).toBe('triposg');
		// Down → the path has no other free lane, so the standing sketch default.
		expect(defaultBackendForHealthAware('sketch', 'standard', true, { triposg: 'down' })).toBe(
			DEFAULT_BACKEND_FOR_PATH.sketch,
		);
	});
});

describe('cold-start ETA — honest widening for scale-to-zero workers', () => {
	it('adds the self-host worker cold-start budget only when cold', () => {
		const warm = estimateEtaSeconds({ backendId: 'trellis_selfhost', tier: 'standard' });
		const cold = estimateEtaSeconds({ backendId: 'trellis_selfhost', tier: 'standard', cold: true });
		expect(coldStartSecondsFor('trellis_selfhost')).toBeGreaterThan(0);
		expect(cold).toBe(warm + coldStartSecondsFor('trellis_selfhost'));
	});

	it('is a no-op for an always-warm external/paid lane', () => {
		expect(coldStartSecondsFor('huggingface')).toBe(0);
		expect(estimateEtaSeconds({ backendId: 'huggingface', tier: 'standard', cold: true })).toBe(
			estimateEtaSeconds({ backendId: 'huggingface', tier: 'standard' }),
		);
	});
});

describe('cost class — free (self-host + free external) vs paid', () => {
	it('classifies our self-host GPU workers and free previews as free', () => {
		for (const id of ['trellis_selfhost', 'hunyuan3d', 'triposg', 'nvidia', 'huggingface']) {
			expect(isFreeBackend(id)).toBe(true);
			expect(backendCostClass(id)).toBe('free');
		}
		expect(isSelfHostBackend('trellis_selfhost')).toBe(true);
		expect(isSelfHostBackend('hunyuan3d')).toBe(true);
		expect(isSelfHostBackend('triposg')).toBe(true);
	});

	it('classifies the paid platform lane and BYOK vendors as paid', () => {
		for (const id of ['trellis', 'meshy', 'tripo', 'rodin', 'stability']) {
			expect(backendCostClass(id)).toBe('paid');
		}
		expect(isSelfHostBackend('trellis')).toBe(false);
		expect(isSelfHostBackend('meshy')).toBe(false);
	});
});
