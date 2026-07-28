// Poll-time lane failover — api/_lib/forge-failover.js.
//
// Covers the successor-chain store (fake Redis), the terminal-failure lane
// suggestions (env-driven), and the redispatch dispatcher's guard rails. The
// live network paths (provider submits, health snapshot probes) are exercised
// end-to-end against production; these tests pin the pure contracts the poll
// handler depends on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	bindJobSuccessor,
	resolveLiveJob,
	retryBackendSuggestions,
	pickRedispatchLane,
	submitFailoverJob,
	MAX_FAILOVER_HOPS,
} from '../api/_lib/forge-failover.js';
import { decodeJobToken } from '../api/_lib/forge-job-token.js';
import { resolveTier } from '../api/_lib/forge-tiers.js';

// encodeJobToken signs handles with JWT_SECRET (lazily, at call time); give the
// suite a deterministic secret so handle-shape assertions can decode them.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Mock the lane submission boundaries: submitFailoverJob dynamic-imports the
// provider modules, so the mocks intercept exactly the network edge and the
// handle-encoding logic under test stays real. laneHealthSnapshot is mocked so
// pickRedispatchLane's telemetry-failure fallback is drivable without probes.
const { gcpSubmit, replicateSubmit, laneHealth } = vi.hoisted(() => ({
	gcpSubmit: vi.fn(),
	replicateSubmit: vi.fn(),
	laneHealth: vi.fn(),
}));
vi.mock('../api/_providers/gcp.js', () => ({
	createRegenProvider: () => ({ submit: gcpSubmit }),
}));
vi.mock('../api/_providers/replicate.js', () => ({
	createRegenProvider: () => ({ submit: replicateSubmit }),
}));
vi.mock('../api/_lib/forge-lane-health.js', () => ({
	laneHealthSnapshot: (...args) => laneHealth(...args),
}));

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
	gcpSubmit.mockReset();
	replicateSubmit.mockReset();
	laneHealth.mockReset();
	laneHealth.mockResolvedValue({ byId: {} });
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

	it('terminates on a cyclic successor chain (A -> B -> A) within the hop cap', async () => {
		// bindJobSuccessor always rebinds the ORIGINAL id, so a healthy flow never
		// writes a cycle; this pins the defensive loop bound against a corrupt or
		// hand-written record. Without it a poll would spin on redis.get forever.
		const backing = fakeRedis();
		await bindJobSuccessor('job-a', { handle: 'job-b', backend: 'trellis_selfhost', hop: 1 }, { redis: backing });
		await bindJobSuccessor('job-b', { handle: 'job-a', backend: 'hunyuan3d', hop: 2 }, { redis: backing });

		let reads = 0;
		const counting = {
			async get(key) {
				reads++;
				if (reads > 50) throw new Error('resolveLiveJob did not terminate on a cyclic chain');
				return backing.get(key);
			},
			async set(key, value) {
				return backing.set(key, value);
			},
		};
		const live = await resolveLiveJob('job-a', { redis: counting });
		// The chase is bounded at one read past the bind cap and still returns a
		// chaseable successor record rather than hanging or throwing.
		expect(reads).toBeLessThanOrEqual(MAX_FAILOVER_HOPS + 1);
		expect(live).not.toBeNull();
		expect(typeof live.handle).toBe('string');
		expect(['job-a', 'job-b']).toContain(live.handle);
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

	it('skips lanes the health snapshot marks down', async () => {
		process.env.MODEL_TRELLIS_URL = 'https://model-trellis.example';
		process.env.GCP_HUNYUAN3D_URL = 'https://hunyuan.example';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		laneHealth.mockResolvedValue({ byId: { trellis_selfhost: { status: 'down' } } });
		expect(await pickRedispatchLane({ attempted: [] })).toBe('hunyuan3d');

		laneHealth.mockResolvedValue({
			byId: { trellis_selfhost: { status: 'down' }, hunyuan3d: { status: 'down' } },
		});
		expect(await pickRedispatchLane({ attempted: [] })).toBeNull();
	});

	it('falls back to the first configured candidate when the health snapshot throws', async () => {
		// No telemetry must never mean no failover: a bad pick just fails over
		// again, but a null pick strands the job on a dead lane.
		process.env.MODEL_TRELLIS_URL = 'https://model-trellis.example';
		process.env.GCP_HUNYUAN3D_URL = 'https://hunyuan.example';
		process.env.GCP_RECONSTRUCTION_KEY = 'k';
		laneHealth.mockRejectedValue(new Error('telemetry down'));
		expect(await pickRedispatchLane({ attempted: [] })).toBe('trellis_selfhost');
		// The fallback respects the attempted filter: candidates[0] is the first
		// UNATTEMPTED configured lane, not the first lane in the static order.
		expect(await pickRedispatchLane({ attempted: ['trellis_selfhost'] })).toBe('hunyuan3d');
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

describe('submitFailoverJob handle shapes', () => {
	// The handle is what the poll handler routes on. GCP lanes MUST return a
	// signed f1.* job token (provider gcp) and the Replicate lane MUST return the
	// bare prediction id: a shape regression on either side makes clients poll a
	// dead handle forever, so the exact encoding is pinned here.
	const IMG = 'https://cdn.example/ref.png';

	it('trellis_selfhost returns a gcp job token wrapping the worker task id', async () => {
		gcpSubmit.mockResolvedValue({ extJobId: 'gcp-task-1' });
		const out = await submitFailoverJob({ backend: 'trellis_selfhost', imageUrl: IMG, prompt: 'a knight' });

		expect(out.extJobId).toBe('gcp-task-1');
		expect(out.handle).toMatch(/^f1\./);
		expect(decodeJobToken(out.handle)).toEqual({ provider: 'gcp', kind: null, taskId: 'gcp-task-1' });

		// Submitted through the gcp provider in trellis mode with the stored inputs.
		expect(gcpSubmit).toHaveBeenCalledTimes(1);
		expect(gcpSubmit).toHaveBeenCalledWith({
			mode: 'trellis',
			sourceUrl: IMG,
			params: { images: [IMG], prompt: 'a knight' },
		});
		expect(replicateSubmit).not.toHaveBeenCalled();
	});

	it('hunyuan3d returns a gcp job token and carries the tier polycount target', async () => {
		gcpSubmit.mockResolvedValue({ extJobId: 'hy-task-9' });
		const out = await submitFailoverJob({ backend: 'hunyuan3d', imageUrl: IMG, tierId: 'high' });

		expect(out.extJobId).toBe('hy-task-9');
		expect(out.handle).toMatch(/^f1\./);
		expect(decodeJobToken(out.handle)).toEqual({ provider: 'gcp', kind: null, taskId: 'hy-task-9' });

		expect(gcpSubmit).toHaveBeenCalledTimes(1);
		const call = gcpSubmit.mock.calls[0][0];
		// Hunyuan3D speaks the standard /infer task shape, not /reconstruct.
		expect(call.mode).toBe('hunyuan');
		expect(call.sourceUrl).toBe(IMG);
		expect(call.params.images).toEqual([IMG]);
		expect(call.params.prompt).toBeUndefined();
		expect(call.params.target_polycount).toBe(resolveTier('high').polycount);
	});

	it('an unknown tier falls back to the default tier polycount', async () => {
		gcpSubmit.mockResolvedValue({ extJobId: 'hy-task-10' });
		await submitFailoverJob({ backend: 'hunyuan3d', imageUrl: IMG, tierId: 'no-such-tier' });
		expect(gcpSubmit.mock.calls[0][0].params.target_polycount).toBe(resolveTier(undefined).polycount);
	});

	it('trellis (Replicate) returns the bare prediction id, never an f1 token', async () => {
		replicateSubmit.mockResolvedValue({ extJobId: 'r8-pred-abc123' });
		const out = await submitFailoverJob({ backend: 'trellis', imageUrl: IMG, prompt: 'a knight' });

		expect(out).toEqual({ extJobId: 'r8-pred-abc123', handle: 'r8-pred-abc123' });
		expect(out.handle.startsWith('f1.')).toBe(false);
		expect(decodeJobToken(out.handle)).toBeNull();

		expect(replicateSubmit).toHaveBeenCalledTimes(1);
		expect(replicateSubmit).toHaveBeenCalledWith({
			mode: 'reconstruct',
			sourceUrl: IMG,
			params: { images: [IMG], prompt: 'a knight' },
		});
		expect(gcpSubmit).not.toHaveBeenCalled();
	});
});

describe('failover budget', () => {
	it('allows exactly one primary + three backup lanes', () => {
		expect(MAX_FAILOVER_HOPS).toBe(3);
	});
});
