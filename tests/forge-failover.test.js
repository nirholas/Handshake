// Poll-time lane failover — api/_lib/forge-failover.js.
//
// Covers the successor-chain store (fake Redis), the terminal-failure lane
// suggestions (env-driven), and the redispatch dispatcher's guard rails. The
// live network paths (provider submits, health snapshot probes) are exercised
// end-to-end against production; these tests pin the pure contracts the poll
// handler depends on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	bindJobSuccessor,
	resolveLiveJob,
	retryBackendSuggestions,
	pickRedispatchLane,
	submitFailoverJob,
	MAX_FAILOVER_HOPS,
} from '../api/_lib/forge-failover.js';

function fakeRedis() {
	const store = new Map();
	return {
		store,
		async get(key) {
			return store.get(key) ?? null;
		},
		async set(key, value) {
			store.set(key, value);
		},
	};
}

const LANE_ENV = [
	'NVIDIA_API_KEY',
	'HF_TOKEN',
	'REPLICATE_API_TOKEN',
	'MODEL_TRELLIS_URL',
	'GCP_HUNYUAN3D_URL',
	'GCP_RECONSTRUCTION_KEY',
];
const saved = {};

beforeEach(() => {
	for (const k of LANE_ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of LANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('successor chain', () => {
	it('resolves null when no failover happened', async () => {
		const redis = fakeRedis();
		expect(await resolveLiveJob('job-a', { redis })).toBeNull();
	});

	it('binds and resolves a successor, overwriting on the next hop', async () => {
		const redis = fakeRedis();
		expect(
			await bindJobSuccessor('job-a', { handle: 'job-b', backend: 'trellis_selfhost', hop: 1, attempted: ['nvidia'] }, { redis }),
		).toBe(true);
		let live = await resolveLiveJob('job-a', { redis });
		expect(live).toMatchObject({ handle: 'job-b', backend: 'trellis_selfhost', hop: 1 });

		// Second failover rebinds the ORIGINAL id — one record per job, no chains
		// to walk or corrupt.
		await bindJobSuccessor(
			'job-a',
			{ handle: 'job-c', backend: 'hunyuan3d', hop: 2, attempted: ['nvidia', 'trellis_selfhost'] },
			{ redis },
		);
		live = await resolveLiveJob('job-a', { redis });
		expect(live).toMatchObject({ handle: 'job-c', backend: 'hunyuan3d', hop: 2 });
		expect(live.attempted).toEqual(['nvidia', 'trellis_selfhost']);
	});

	it('fails open without Redis: bind reports false, resolve reports null', async () => {
		expect(await bindJobSuccessor('job-a', { handle: 'job-b', backend: 'x', hop: 1 }, { redis: null })).toBe(false);
		expect(await resolveLiveJob('job-a', { redis: null })).toBeNull();
	});

	it('never reports running for an unbindable successor (bind returns false on write error)', async () => {
		const redis = {
			async get() {
				return null;
			},
			async set() {
				throw new Error('redis down');
			},
		};
		expect(await bindJobSuccessor('job-a', { handle: 'job-b', backend: 'x', hop: 1 }, { redis })).toBe(false);
	});
});

describe('retryBackendSuggestions', () => {
	it('returns only configured lanes, free-first, minus attempted', () => {
		process.env.MODEL_TRELLIS_URL = 'https://model-trellis.example';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		process.env.HF_TOKEN = 'hf';
		process.env.REPLICATE_API_TOKEN = 'r8';

		const all = retryBackendSuggestions({ hasImage: true });
		expect(all).toEqual(['trellis_selfhost', 'huggingface', 'trellis']);

		const minusFailed = retryBackendSuggestions({ hasImage: true, attempted: ['trellis_selfhost'] });
		expect(minusFailed).toEqual(['huggingface', 'trellis']);
	});

	it('offers the text-only NVIDIA lane for text jobs but never for photo input', () => {
		process.env.NVIDIA_API_KEY = 'nv';
		expect(retryBackendSuggestions({ hasImage: false })).toEqual(['nvidia']);
		expect(retryBackendSuggestions({ hasImage: true })).toEqual([]);
	});

	it('returns [] when nothing is configured — the caller omits the retry affordance', () => {
		expect(retryBackendSuggestions({ hasImage: true })).toEqual([]);
	});
});

describe('pickRedispatchLane', () => {
	it('returns null with no configured async lane', async () => {
		expect(await pickRedispatchLane({ attempted: [] })).toBeNull();
	});

	it('skips attempted lanes even when configured', async () => {
		process.env.MODEL_TRELLIS_URL = 'https://model-trellis.example';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		expect(await pickRedispatchLane({ attempted: ['trellis_selfhost'] })).toBeNull();
	});
});

describe('submitFailoverJob guard rails', () => {
	it('refuses a redispatch with no stored reference image', async () => {
		await expect(submitFailoverJob({ backend: 'trellis_selfhost', imageUrl: null })).rejects.toThrow(
			/reference image/,
		);
	});

	it('refuses lanes that cannot be driven from a poll (blocking or text-only)', async () => {
		await expect(
			submitFailoverJob({ backend: 'huggingface', imageUrl: 'https://x/img.png' }),
		).rejects.toThrow(/cannot be redispatched/);
		await expect(submitFailoverJob({ backend: 'nvidia', imageUrl: 'https://x/img.png' })).rejects.toThrow(
			/cannot be redispatched/,
		);
	});
});

describe('failover budget', () => {
	it('allows exactly one primary + three backup lanes', () => {
		expect(MAX_FAILOVER_HOPS).toBe(3);
	});
});
