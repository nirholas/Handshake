// High/MAX realism tier restructure: self-host PBR lanes lead, subject-aware
// ordering (Hunyuan3D-2.1 for organics, self-host TRELLIS for hard-surface), and
// a health-gated fallthrough to the free NVIDIA NIM lane so the realism path never
// dead-ends on a cold GPU worker. Every assertion drives the PURE resolvers with
// injected env + health maps - no network. The draft/standard free-default lane
// ordering must stay exactly as it was (no latency regression on the free path).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	classifyForgeSubject,
	freeLaneCandidates,
	resolveBackendId,
	resolveBackendIdWithHealth,
	isSelfHostBackend,
	coldStartSecondsFor,
	estimateEtaSeconds,
} from '../../api/_lib/forge-tiers.js';

const LANE_VARS = [
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
}

beforeEach(() => {
	for (const v of LANE_VARS) {
		saved[v] = process.env[v];
		delete process.env[v];
	}
});
afterEach(() => {
	for (const v of LANE_VARS) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

describe('classifyForgeSubject', () => {
	it('classifies people / creatures / organics as organic', () => {
		expect(classifyForgeSubject('a knight in shining armor')).toBe('organic');
		expect(classifyForgeSubject('a fluffy cat')).toBe('organic');
		expect(classifyForgeSubject('portrait of a woman')).toBe('organic');
		expect(classifyForgeSubject('a fierce dragon')).toBe('organic');
	});
	it('classifies hard-surface / mechanical subjects as hardsurface', () => {
		expect(classifyForgeSubject('a sci-fi drone')).toBe('hardsurface');
		expect(classifyForgeSubject('a red sports car')).toBe('hardsurface');
		expect(classifyForgeSubject('a chrome coffee machine')).toBe('hardsurface');
	});
	it('returns null for an ambiguous or empty prompt', () => {
		expect(classifyForgeSubject('a thing')).toBeNull();
		expect(classifyForgeSubject('')).toBeNull();
		expect(classifyForgeSubject(null)).toBeNull();
	});
	it('prefers organic when a prompt trips both signals', () => {
		// "knight" (organic) + "armor/mech" (hard-surface) → organic wins (Hunyuan first).
		expect(classifyForgeSubject('a knight in mecha armor')).toBe('organic');
	});
});

describe('High realism tier - self-host lanes lead, NIM is the last free fallthrough', () => {
	it('text prompt: Hunyuan3D first, self-host TRELLIS next, HF then free NIM last', () => {
		configureAllLanes();
		expect(freeLaneCandidates('image', 'high', false)).toEqual([
			'hunyuan3d',
			'trellis_selfhost',
			'huggingface',
			'nvidia',
		]);
	});

	it('hard-surface subject hoists self-host TRELLIS ahead of Hunyuan3D', () => {
		configureAllLanes();
		expect(freeLaneCandidates('image', 'high', false, 'hardsurface')).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
			'nvidia',
		]);
	});

	it('organic subject keeps the default Hunyuan3D-first order', () => {
		configureAllLanes();
		expect(freeLaneCandidates('image', 'high', false, 'organic')).toEqual([
			'hunyuan3d',
			'trellis_selfhost',
			'huggingface',
			'nvidia',
		]);
	});

	it('photo submission at high excludes the text-only NIM lane', () => {
		configureAllLanes();
		expect(freeLaneCandidates('image', 'high', true)).toEqual([
			'hunyuan3d',
			'trellis_selfhost',
			'huggingface',
		]);
		expect(freeLaneCandidates('image', 'high', true, 'hardsurface')).toEqual([
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
		]);
	});

	it('resolveBackendId picks a self-host lane at high tier', () => {
		configureAllLanes();
		expect(resolveBackendId({ path: 'image', tier: 'high', userImages: false })).toBe('hunyuan3d');
		expect(
			resolveBackendId({ path: 'image', tier: 'high', userImages: false, subjectClass: 'hardsurface' }),
		).toBe('trellis_selfhost');
	});
});

describe('High realism tier - health-gated fallthrough to the free NIM lane', () => {
	it('falls through to NVIDIA NIM when every GPU worker and HF are down', () => {
		configureAllLanes();
		const health = { hunyuan3d: 'down', trellis_selfhost: 'down', huggingface: 'down' };
		expect(
			resolveBackendIdWithHealth({ path: 'image', tier: 'high', userImages: false, health }),
		).toBe('nvidia');
	});

	it('skips a cold self-host lane for the next healthy self-host lane', () => {
		configureAllLanes();
		const health = { hunyuan3d: 'down' };
		expect(
			resolveBackendIdWithHealth({ path: 'image', tier: 'high', userImages: false, health }),
		).toBe('trellis_selfhost');
	});
});

describe('Self-host lane health + cold-start coverage (triposg + hunyuan3d)', () => {
	it('recognizes triposg and hunyuan3d as self-host lanes (health-probed)', () => {
		expect(isSelfHostBackend('triposg')).toBe(true);
		expect(isSelfHostBackend('hunyuan3d')).toBe(true);
		expect(isSelfHostBackend('trellis_selfhost')).toBe(true);
		// The external free lanes are not self-host probed.
		expect(isSelfHostBackend('nvidia')).toBe(false);
		expect(isSelfHostBackend('huggingface')).toBe(false);
	});

	it('carries a cold-start budget for both scale-to-zero GPU workers', () => {
		expect(coldStartSecondsFor('triposg')).toBeGreaterThan(0);
		expect(coldStartSecondsFor('hunyuan3d')).toBeGreaterThan(0);
	});

	it('widens the ETA by the cold-start budget when the worker is cold', () => {
		const warm = estimateEtaSeconds({ backendId: 'hunyuan3d', tier: 'high', cold: false });
		const cold = estimateEtaSeconds({ backendId: 'hunyuan3d', tier: 'high', cold: true });
		expect(cold).toBe(warm + coldStartSecondsFor('hunyuan3d'));
		const tWarm = estimateEtaSeconds({ backendId: 'triposg', tier: 'standard', cold: false });
		const tCold = estimateEtaSeconds({ backendId: 'triposg', tier: 'standard', cold: true });
		expect(tCold).toBe(tWarm + coldStartSecondsFor('triposg'));
	});
});

describe('Free/default tier is unchanged (no regression)', () => {
	it('draft text prompt still leads with native NVIDIA NIM', () => {
		configureAllLanes();
		expect(freeLaneCandidates('image', 'draft', false)).toEqual([
			'nvidia',
			'trellis_selfhost',
			'hunyuan3d',
			'huggingface',
		]);
	});

	it('standard tier ordering is subject-invariant (reorder is high-only)', () => {
		configureAllLanes();
		const plain = freeLaneCandidates('image', 'standard', false);
		expect(freeLaneCandidates('image', 'standard', false, 'hardsurface')).toEqual(plain);
		expect(freeLaneCandidates('image', 'standard', false, 'organic')).toEqual(plain);
		expect(plain[0]).toBe('nvidia');
	});
});
