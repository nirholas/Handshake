/**
 * Server-side proportions baker: api/_lib/bake-proportions.js.
 *
 * The contract this file exists to protect is PARITY. Two code paths write a
 * user's build into a GLB and they must agree exactly:
 *
 *   Avatar Studio  exports the live three.js scene, so applyProportionsToRoot()
 *                  in src/avatar-proportions.js is what lands in the file.
 *   /avatars/:id/edit  PATCHes `appearance.proportions` and lets the server
 *                  render from the pristine base, so applyProportions() in
 *                  api/_lib/bake-proportions.js is what lands in the file.
 *
 * Both call the same dependency-free solver. These tests prove the two
 * adapters around it produce identical bone locals on the real parametric base,
 * that the feet stay on the floor after a leg-length edit, and that a
 * proportions-only appearance is recognised as bakeable at all (it was not, and
 * that is the bug this module closes).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Vector3 } from 'three';

import { applyProportions, hasProportions } from '../api/_lib/bake-proportions.js';
import { isBakeable } from '../api/_lib/bake.js';
import {
	applyProportionsToRoot,
	PROPORTION_BONES,
} from '../src/avatar-proportions.js';
import { canonicalBoneNodesFromObject } from '../src/animation-retarget.js';

const GLB_PATH = resolve(process.cwd(), 'public/avatars/parametric-base.glb');
const glbBytes = readFileSync(GLB_PATH);

// A build that exercises every operation class: stature, plain offset, lateral
// offset, and joint scale.
const BUILD = {
	height: 1.08,
	legLength: 1.12,
	armLength: 0.94,
	shoulderWidth: 1.1,
	headSize: 1.06,
};

function loadThree() {
	const loader = new GLTFLoader();
	return new Promise((res, rej) => {
		loader.parse(
			glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
			'',
			res,
			rej,
		);
	});
}

/** canonical bone → { position, scale } read off a baked gltf-transform doc. */
async function bakeLocals(proportions) {
	const doc = await new NodeIO().readBinary(new Uint8Array(glbBytes));
	const result = applyProportions(doc, proportions);
	const { canonicalizeBoneName } = await import('../src/glb-canonicalize.js');
	const locals = new Map();
	let armatureScale = null;
	const skin = doc.getRoot().listSkins()[0];
	for (const joint of skin.listJoints()) {
		const canonical = canonicalizeBoneName(joint.getName() || '');
		if (!canonical || !PROPORTION_BONES.includes(canonical) || locals.has(canonical)) continue;
		locals.set(canonical, { position: joint.getTranslation(), scale: joint.getScale() });
		if (canonical === 'Hips') armatureScale = joint.getParentNode()?.getScale() ?? null;
	}
	return { result, locals, armatureScale };
}

describe('bake-proportions: parity with the runtime path', () => {
	let clientLocals;
	let clientArmatureScale;

	beforeAll(async () => {
		const { scene } = await loadThree();
		const boneMap = canonicalBoneNodesFromObject(scene);
		const applied = applyProportionsToRoot(scene, BUILD, { boneMap });
		expect(applied).not.toBeNull();
		clientLocals = new Map();
		for (const canonical of PROPORTION_BONES) {
			const node = boneMap.get(canonical);
			if (!node) continue;
			clientLocals.set(canonical, {
				position: node.position.toArray(),
				scale: node.scale.toArray(),
			});
		}
		clientArmatureScale = boneMap.get('Hips').parent.scale.toArray();
	});

	it('writes the same bone locals as the browser sculpt path', async () => {
		const { locals, armatureScale } = await bakeLocals(BUILD);
		expect(locals.size).toBeGreaterThan(0);
		for (const [canonical, server] of locals) {
			const client = clientLocals.get(canonical);
			expect(client, canonical).toBeTruthy();
			for (let i = 0; i < 3; i++) {
				expect(server.position[i], `${canonical}.position[${i}]`).toBeCloseTo(client.position[i], 6);
				expect(server.scale[i], `${canonical}.scale[${i}]`).toBeCloseTo(client.scale[i], 6);
			}
		}
		for (let i = 0; i < 3; i++) {
			expect(armatureScale[i]).toBeCloseTo(clientArmatureScale[i], 6);
		}
	});

	it('reports which parameters it applied and moves the bones they name', async () => {
		const { result, locals } = await bakeLocals(BUILD);
		expect(result.missing).toEqual([]);
		expect(result.applied.sort()).toEqual(Object.keys(BUILD).sort());
		expect(result.stature).toBeCloseTo(BUILD.height, 6);
		// headSize is a scale op, legLength an offset op: both must be visible.
		expect(locals.get('Head').scale[0]).toBeCloseTo(BUILD.headSize, 6);
		expect(Math.abs(locals.get('LeftLeg').position[1])).toBeGreaterThan(0);
	});
});

describe('bake-proportions: ground contact and rig tolerance', () => {
	it('keeps the feet on the floor after a leg-length edit', async () => {
		const proportions = { legLength: 1.15 };
		const doc = await new NodeIO().readBinary(new Uint8Array(glbBytes));
		const { canonicalizeBoneName } = await import('../src/glb-canonicalize.js');

		const skin = doc.getRoot().listSkins()[0];
		const byCanonical = new Map();
		for (const joint of skin.listJoints()) {
			const canonical = canonicalizeBoneName(joint.getName() || '');
			if (canonical && !byCanonical.has(canonical)) byCanonical.set(canonical, joint);
		}
		// World Y of a joint, walking translations up the graph. Every joint in
		// this rig has identity rotation and unit scale at rest, which is what
		// makes the plain sum correct here.
		const worldY = (node) => {
			let y = 0;
			for (let n = node; n; n = n.getParentNode()) y += n.getTranslation()[1];
			return y;
		};
		const toe = byCanonical.get('LeftToeBase');
		expect(toe).toBeTruthy();
		const before = worldY(toe);

		applyProportions(doc, proportions);
		const after = worldY(toe);
		expect(after).toBeCloseTo(before, 6);
	});

	it('drops parameters a rig has no bones for instead of throwing', async () => {
		const doc = await new NodeIO().readBinary(new Uint8Array(glbBytes));
		// Strip the skin so nothing resolves: the baker must degrade, not die.
		for (const s of doc.getRoot().listSkins()) s.dispose();
		const result = applyProportions(doc, BUILD);
		expect(result.applied).toEqual([]);
		expect(result.missing.sort()).toEqual(Object.keys(BUILD).sort());
	});

	it('is a no-op for an empty or neutral record', async () => {
		const { result } = await bakeLocals({});
		expect(result.applied).toEqual([]);
		const neutral = await bakeLocals({ height: 1, legLength: 1 });
		expect(neutral.result.applied).toEqual([]);
	});
});

describe('bake-proportions: bakeability', () => {
	it('treats a proportions-only appearance as bakeable', () => {
		expect(hasProportions({ proportions: { height: 1.1 } })).toBe(true);
		expect(hasProportions({ proportions: { height: 1 } })).toBe(false);
		expect(hasProportions(null)).toBe(false);
		expect(isBakeable({ proportions: { height: 1.1 } })).toBe(true);
		expect(isBakeable({ proportions: {} })).toBe(false);
		expect(isBakeable(null)).toBe(false);
	});
});

describe('bake-proportions: end-to-end through bakeAppearance', () => {
	it('renders a taller body into the served GLB', async () => {
		const { bakeAppearance } = await import('../api/_lib/bake.js');
		const bytes = await bakeAppearance(glbBytes, { proportions: { height: 1.1 } });
		expect(bytes.byteLength).toBeGreaterThan(0);

		const { MeshoptDecoder } = await import('meshoptimizer');
		await MeshoptDecoder.ready;
		const { scene } = await new Promise((res, rej) => {
			new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
				'',
				res,
				rej,
			);
		});
		scene.updateMatrixWorld(true);
		const boneMap = canonicalBoneNodesFromObject(scene);
		const head = boneMap.get('Head');
		expect(head).toBeTruthy();
		const baked = new Vector3();
		head.getWorldPosition(baked);

		const { scene: plain } = await loadThree();
		plain.updateMatrixWorld(true);
		const plainHead = new Vector3();
		canonicalBoneNodesFromObject(plain).get('Head').getWorldPosition(plainHead);

		expect(baked.y / plainHead.y).toBeCloseTo(1.1, 2);
	});
});

describe('bake-proportions: why the server pass is not optional', () => {
	it('is the only thing that puts a build into a Studio export', async () => {
		// Avatar Studio saves by exporting the live scene, which reads like
		// "proportions come along for free". They do not. exportSceneGlb() calls
		// poseSkeletonsToBind() first, so a clip mid-frame cannot be frozen into
		// the file, and that resets every bone from the skin's inverse bind
		// matrices, which a proportion edit deliberately never touches. The
		// build is wiped out of the export, and only the server bake below puts
		// it back. Change the export neutraliser and this is the test that says
		// what else has to change with it.
		const { poseSkeletonsToBind } = await import('../src/glb-bind-pose.js');
		const { scene } = await loadThree();
		const boneMap = canonicalBoneNodesFromObject(scene);
		const hips = boneMap.get('Hips');
		const leg = boneMap.get('LeftLeg');
		const rest = { hips: hips.position.toArray(), leg: leg.position.toArray() };

		applyProportionsToRoot(scene, { legLength: 1.15 }, { boneMap });
		expect(leg.position.toArray()).not.toEqual(rest.leg);

		expect(poseSkeletonsToBind(scene)).toBeGreaterThan(0);
		for (let i = 0; i < 3; i++) {
			expect(leg.position.toArray()[i]).toBeCloseTo(rest.leg[i], 5);
			expect(hips.position.toArray()[i]).toBeCloseTo(rest.hips[i], 5);
		}
	});
});
