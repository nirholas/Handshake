/**
 * The shipped pump.fun pill rig, asserted against the contracts /pill and the
 * platform's animation stack depend on.
 *
 * scripts/rig-pill-mascot.py is not run in CI (it needs numpy, scipy,
 * scikit-image and trimesh, none of which are in the npm tree). What CI can do
 * is hold its OUTPUT to the promises the product makes about it: canonical bone
 * names so the clip library retargets, the six clips /pill plays by name, a
 * skinned primitive, and a static source that is still static so the pipeline
 * stays reproducible.
 *
 * Every failure here is a real regression a viewer would show as a T-pose or a
 * frozen mascot, and none of them throw at load time.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { canonicalizeBoneName, CANONICAL_BONES } from '../src/glb-canonicalize.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RIGGED = resolve(ROOT, 'public/avatars/pumpfun-pill-cupsey.glb');
const STATIC = resolve(ROOT, 'public/avatars/pumpfun-pill-cupsey-static.glb');

// The clips /pill names in its toolbar and its keyboard shortcuts.
const EXPECTED_CLIPS = ['idle', 'walk', 'run', 'wave', 'jump', 'dance'];

/** Read a GLB's JSON chunk without a full glTF parser. */
function readGlbJson(path) {
	const buf = readFileSync(path);
	expect(buf.readUInt32LE(0), `${path} is not a GLB`).toBe(0x46546c67);
	expect(buf.readUInt32LE(4), `${path} is not glTF 2.0`).toBe(2);
	let offset = 12;
	while (offset < buf.readUInt32LE(8)) {
		const length = buf.readUInt32LE(offset);
		const type = buf.readUInt32LE(offset + 4);
		if (type === 0x4e4f534a) {
			return JSON.parse(buf.subarray(offset + 8, offset + 8 + length).toString('utf8'));
		}
		offset += 8 + length;
	}
	throw new Error(`${path} has no JSON chunk`);
}

describe('pump.fun pill rig', () => {
	let gltf;
	beforeAll(() => {
		expect(existsSync(RIGGED), `${RIGGED} is missing`).toBe(true);
		gltf = readGlbJson(RIGGED);
	});

	it('ships one skinned mesh with joint and weight attributes', () => {
		expect(gltf.skins).toHaveLength(1);
		const primitives = gltf.meshes.flatMap((mesh) => mesh.primitives);
		const skinned = primitives.filter((p) => p.attributes.JOINTS_0 !== undefined);
		expect(skinned).toHaveLength(1);
		expect(skinned[0].attributes.WEIGHTS_0).toBeDefined();
		expect(gltf.skins[0].inverseBindMatrices).toBeDefined();
		const meshNodes = gltf.nodes.filter((n) => n.mesh !== undefined);
		expect(meshNodes.every((n) => n.skin !== undefined)).toBe(true);
	});

	it('names every joint so the canonical clip library retargets onto it', () => {
		const joints = gltf.skins[0].joints.map((i) => gltf.nodes[i].name);
		expect(joints).toHaveLength(CANONICAL_BONES.length);
		const unmapped = joints.filter((name) => !canonicalizeBoneName(name));
		expect(unmapped, 'joints that no clip track can address').toEqual([]);
		const covered = new Set(joints.map((name) => canonicalizeBoneName(name)));
		const missing = CANONICAL_BONES.filter((bone) => !covered.has(bone));
		// Finger chains are load-bearing, not decoration: 30 of the 53 tracks in
		// every baked clip address one, and animation-retarget.js drops a clip
		// under 50% coverage. Dropping them would cost the whole library.
		expect(missing, 'canonical bones with no joint on this rig').toEqual([]);
	});

	it('carries the six clips /pill plays by name', () => {
		const names = (gltf.animations ?? []).map((a) => a.name);
		expect(names.sort()).toEqual([...EXPECTED_CLIPS].sort());
		for (const animation of gltf.animations) {
			expect(animation.channels.length, `${animation.name} drives nothing`).toBeGreaterThan(4);
			const targets = new Set(animation.channels.map((c) => c.target.node));
			expect(targets.size, `${animation.name} moves too few joints`).toBeGreaterThan(4);
		}
	});

	it('rests in a standing pose, not the sculpted mid-stride one', () => {
		// The rigger bakes the neutral pose into the geometry and leaves every
		// bone at an identity local rotation, so bind and rest coincide and a
		// clip's first frame is a delta from standing. A joint that came back
		// with a baked rotation means that step regressed.
		const joints = gltf.skins[0].joints.map((i) => gltf.nodes[i]);
		const rotated = joints.filter((n) => n.rotation
			&& Math.abs(n.rotation[3] - 1) > 1e-4);
		expect(rotated.map((n) => n.name)).toEqual([]);
	});

	it('stays small enough to be a page hero', () => {
		// 12.6 MB of scan-density mesh was the input; anything near that again
		// means the decimation step was skipped.
		expect(statSync(RIGGED).size).toBeLessThan(5 * 1024 * 1024);
	});

	it('keeps its static source static, so the rig stays reproducible', () => {
		expect(existsSync(STATIC), `${STATIC} is missing`).toBe(true);
		const source = readGlbJson(STATIC);
		expect(source.skins ?? []).toHaveLength(0);
		expect(source.animations ?? []).toHaveLength(0);
		const primitives = source.meshes.flatMap((mesh) => mesh.primitives);
		expect(primitives.some((p) => p.attributes.JOINTS_0 !== undefined)).toBe(false);
	});
});
