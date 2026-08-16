// Three guards on the crons that keep the forge lanes honest, each locking in a
// defect found by the 2026-08-12 api/cron audit.
//
//  1. forge-smoke's generation leg was passing on a REPLAY. /api/forge keeps a
//     content-addressed result cache keyed on (path, tier, backend, prompt,
//     options) for 7 days, and a read never refreshes the TTL. The smoke test
//     submits a constant prompt with no seed, so the key never changes: the
//     daily run took a cache hit, verified a GLB an earlier generation had
//     produced, and reported green. A probe run measured all five legs finishing
//     in 0.55 s, which no real generation does. The whole point of this cron is
//     to catch a flow that is 100% dead while every config check reads green, so
//     a replayed mesh must never satisfy it.
//
//  2. forge-seed-cron buried a finished mesh on the FIRST gate fault. A gate
//     fault is infrastructure (an object-storage read, the renderer, a judge
//     transport), 'gate_error' is terminal, and nothing revisits it: two seed
//     jobs were lost that way in a single day to a transient storage 500. It has
//     to retry, and it has to stop retrying.
//
//  3. gpu-keepwarm silently warmed nothing when FORGE_KEEPWARM_LANES held a
//     typo. That env var exists to be edited without a deploy, so a typo is the
//     likely failure, and the tick still answered ok:true with zero lanes
//     checked: a silent outage of the exact cold start this cron prevents.

import { test, expect, afterEach, vi } from 'vitest';
import { runGeneration, GENERATION_BUDGET_MS } from '../api/cron/forge-smoke.js';
import { gateFaultOutcome } from '../api/cron/forge-seed-cron.js';
import { resolveKeepwarmLanes, KEEPWARM_LANES } from '../api/cron/gpu-keepwarm.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

// A binary glTF header is the only thing verifyGlb accepts, so the happy path
// has to hand back real magic bytes.
const GLTF_MAGIC = new TextEncoder().encode('glTF');

function stubForge(submitBody, { submitStatus = 200 } = {}) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, options = {}) => {
		calls.push({ url: String(url), options });
		if (String(url).endsWith('.glb')) {
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => GLTF_MAGIC.buffer,
				json: async () => ({}),
			};
		}
		return {
			ok: submitStatus === 200,
			status: submitStatus,
			json: async () => submitBody,
		};
	});
	return calls;
}

// ── 1. forge-smoke must actually generate ────────────────────────────────────

test('the smoke submit asks the forge to bypass its result cache', async () => {
	const calls = stubForge({
		status: 'done',
		job_id: null,
		glb_url: 'https://cdn.example/forge/probe.glb',
	});

	const result = await runGeneration('https://three.ws');

	expect(result.ok).toBe(true);
	const submit = calls.find((c) => c.url === 'https://three.ws/api/forge');
	expect(JSON.parse(submit.options.body)).toMatchObject({ tier: 'draft', force_regenerate: true });
});

// The regression itself: a cached response satisfied every later check, because
// a cache hit carries a real, fetchable, glTF-magic GLB.
test('a cached forge response fails the smoke instead of passing on a replay', async () => {
	stubForge({
		status: 'done',
		job_id: null,
		cached: true,
		cached_at: '2026-08-05T00:00:00.000Z',
		glb_url: 'https://cdn.example/forge/probe.glb',
	});

	const result = await runGeneration('https://three.ws');

	expect(result.ok).toBe(false);
	expect(result.reason).toMatch(/result cache/i);
});

test('a forge submit that errors is still reported by status, not by exception', async () => {
	stubForge({ error: 'backend_down', error_description: 'no lane available' }, { submitStatus: 503 });

	const result = await runGeneration('https://three.ws');

	expect(result.ok).toBe(false);
	expect(result.reason).toContain('503');
});

// The generation budget is the thing under test here, not a style preference.
// It was 90 s for the submit while the lane it probes averaged 84.7 s and a
// measured run took 150 s, so the smoke aborted working generations and paged
// ops daily. Cloud Scheduler gives the job a 320 s attemptDeadline, so the
// budget has to clear real latency from below and the deadline from above.
test('the generation budget clears real lane latency without blowing the scheduler deadline', () => {
	const OBSERVED_PRODUCTION_RUN_MS = 150_000;
	const SCHEDULER_ATTEMPT_DEADLINE_MS = 320_000;
	expect(GENERATION_BUDGET_MS).toBeGreaterThan(OBSERVED_PRODUCTION_RUN_MS);
	expect(GENERATION_BUDGET_MS).toBeLessThan(SCHEDULER_ATTEMPT_DEADLINE_MS);
});

// ── 2. forge-seed-cron gate faults retry, then stop ──────────────────────────

test('the first gate fault retries rather than burying the mesh', () => {
	expect(gateFaultOutcome(0)).toEqual({ attempt: 1, terminal: false });
	expect(gateFaultOutcome(null)).toEqual({ attempt: 1, terminal: false });
	expect(gateFaultOutcome(undefined)).toEqual({ attempt: 1, terminal: false });
	expect(gateFaultOutcome(1)).toEqual({ attempt: 2, terminal: false });
});

test('a mesh that keeps failing the gate reaches a terminal state', () => {
	expect(gateFaultOutcome(2)).toEqual({ attempt: 3, terminal: true });
	// Past the ceiling stays terminal: a row that somehow banked more attempts
	// must not fall back into the retry branch and occupy a gate slot forever.
	expect(gateFaultOutcome(9).terminal).toBe(true);
});

// ── 3. gpu-keepwarm lane selection ───────────────────────────────────────────

test('no override warms exactly the lanes that contend with nothing', () => {
	const { lanes, unknown, source } = resolveKeepwarmLanes(undefined);
	expect(source).toBe('default');
	expect(unknown).toEqual([]);
	expect(lanes.map((l) => l.id)).toEqual(KEEPWARM_LANES.filter((l) => l.safeByDefault).map((l) => l.id));
	expect(lanes.length).toBeGreaterThan(0);
});

test('an override selects the named lanes, quota-contended ones included', () => {
	const { lanes, unknown, source } = resolveKeepwarmLanes(' triposg , text2motion ');
	expect(source).toBe('override');
	expect(unknown).toEqual([]);
	expect(new Set(lanes.map((l) => l.id))).toEqual(new Set(['triposg', 'text2motion']));
});

test('a typo in the override is reported, not silently dropped', () => {
	const { lanes, unknown } = resolveKeepwarmLanes('text2moton,triposg');
	expect(unknown).toEqual(['text2moton']);
	expect(lanes.map((l) => l.id)).toEqual(['triposg']);
});

test('an override of nothing but typos leaves no lane warm and says so', () => {
	const { lanes, unknown } = resolveKeepwarmLanes('nope,alsonope');
	expect(lanes).toEqual([]);
	expect(unknown).toEqual(['nope', 'alsonope']);
});
