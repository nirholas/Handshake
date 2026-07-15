/**
 * Pin idle animation (src/irl/pin-idle.js) — the "no more T-posed statues" lock.
 *
 * /irl pins used to mount their GLB in the authored bind pose and never move.
 * mountPinIdle() must: fetch the shared idle clip ONCE for the whole page,
 * retarget it per rig through the production AnimationManager pipeline, start
 * playback at a randomized phase, and return null (never throw) for anything
 * that can't be driven — a prop, a missing manifest, a failed clip fetch.
 *
 * Runs against the committed real rigs (cz.glb = canonical Avaturn convention,
 * michelle.glb = Mixamo convention) via the same headless bone-graph loader the
 * upright-invariant corpus uses, and the real committed idle clip JSON — what
 * this suite exercises is what ships.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Object3D, Quaternion } from 'three';
import { loadBoneGraph } from './_helpers/glb-bone-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const avatar = (name) => resolve(repoRoot, 'public/avatars', name);
const idleClipJson = JSON.parse(
	readFileSync(resolve(repoRoot, 'public/animations/clips/idle.json'), 'utf8'),
);
const manifestJson = JSON.parse(
	readFileSync(resolve(repoRoot, 'public/animations/manifest.json'), 'utf8'),
);

// The module memoizes the clip fetch across the whole page; tests need a fresh
// module instance per scenario so one test's fetch outcome can't leak into the
// next.
async function freshModule() {
	vi.resetModules();
	return await import('../src/irl/pin-idle.js');
}

const okJson = (body) => ({ ok: true, json: async () => body });

function stubFetchOk() {
	const fn = vi.fn(async (url) => {
		if (String(url).includes('manifest')) return okJson(manifestJson);
		if (String(url).includes('idle.json')) return okJson(idleClipJson);
		return { ok: false, status: 404, json: async () => ({}) };
	});
	vi.stubGlobal('fetch', fn);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('mountPinIdle on real humanoid rigs', () => {
	for (const rig of ['cz.glb', 'michelle.glb']) {
		it(`drives ${rig} out of its bind pose`, async () => {
			stubFetchOk();
			const { mountPinIdle } = await freshModule();
			const { root, nodes } = loadBoneGraph(avatar(rig));

			// Snapshot the bind pose before mounting.
			const bind = new Map(nodes.map((n) => [n.uuid, n.quaternion.clone()]));

			const mgr = await mountPinIdle(root, { avatarUrl: `/avatars/${rig}` });
			expect(mgr).not.toBeNull();
			expect(mgr.currentName).toBe('idle');
			expect(mgr.mixer).toBeTruthy();

			// Advance and confirm the skeleton actually moves — at least one bone's
			// local rotation must differ from bind (a statue would stay identical).
			mgr.update(0.25);
			const scratch = new Quaternion();
			let moved = 0;
			for (const n of nodes) {
				scratch.copy(bind.get(n.uuid));
				if (Math.abs(1 - Math.abs(scratch.dot(n.quaternion))) > 1e-6) moved++;
			}
			expect(moved).toBeGreaterThan(0);

			// Teardown must be clean and idempotent (evict/dispose paths call it).
			mgr.detach();
			mgr.detach();
			expect(mgr.mixer).toBeNull();
		});
	}

	it('randomizes the start phase so a plaza never breathes in lockstep', async () => {
		stubFetchOk();
		const { mountPinIdle } = await freshModule();
		const times = [];
		for (let i = 0; i < 4; i++) {
			const { root } = loadBoneGraph(avatar('cz.glb'));
			const mgr = await mountPinIdle(root, {});
			expect(mgr).not.toBeNull();
			times.push(mgr.currentAction.time);
			mgr.detach();
		}
		expect(new Set(times.map((t) => t.toFixed(6))).size).toBeGreaterThan(1);
	});

	it('fetches the clip once across many mounts (memoized)', async () => {
		const fetchFn = stubFetchOk();
		const { mountPinIdle } = await freshModule();
		for (let i = 0; i < 3; i++) {
			const { root } = loadBoneGraph(avatar('cz.glb'));
			(await mountPinIdle(root, {}))?.detach();
		}
		// One manifest fetch + one clip fetch, total — never per pin.
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});

describe('mountPinIdle failure modes (animation is upside, never a gate)', () => {
	it('returns null for a non-humanoid model', async () => {
		stubFetchOk();
		const { mountPinIdle } = await freshModule();
		const prop = new Object3D();
		prop.name = 'crate';
		expect(await mountPinIdle(prop, {})).toBeNull();
	});

	it('returns null when the manifest fetch fails, then retries on the next mount', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', vi.fn(async (url) => {
			calls++;
			if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
			if (String(url).includes('manifest')) return okJson(manifestJson);
			return okJson(idleClipJson);
		}));
		const { mountPinIdle } = await freshModule();

		const first = await mountPinIdle(loadBoneGraph(avatar('cz.glb')).root, {});
		expect(first).toBeNull();

		// The failed fetch must not poison the memo — the next mount retries.
		const second = await mountPinIdle(loadBoneGraph(avatar('cz.glb')).root, {});
		expect(second).not.toBeNull();
		second.detach();
	});

	it('returns null (no throw) when fetch itself rejects', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
		const { mountPinIdle } = await freshModule();
		expect(await mountPinIdle(loadBoneGraph(avatar('cz.glb')).root, {})).toBeNull();
	});
});
