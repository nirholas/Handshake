// The parametric avatar base (public/avatars/parametric-base.glb), baked from
// the CC0 MakeHuman/MPFB2 data in avatar-sources/anny by
// scripts/build-parametric-base.mjs.
//
// This is the backbone of the "change everything" avatar editor: one canonical
// body whose identity is 300+ morph-target sliders. These tests pin the four
// contracts the rest of the platform depends on:
//   1. the GLB is valid and carries the curated morph set with targetNames,
//   2. the mixamorig skeleton canonicalizes, so the whole pre-baked clip
//      library retargets onto it (walk-ready by construction),
//   3. the morphs load as real geometry deltas in three.js, localized to the
//      region their name claims (a nose slider must not move the feet),
//   4. every slider lands in a named group in the sculpt panel rather than in
//      the "Other" drawer, and the whole set stays inside the VRAM budget the
//      baker enforces (three.js allocates one dense texture layer per morph
//      target, so slider count is a shipped-product cost, not a free one).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import gltfValidator from 'gltf-validator';
import { NodeIO } from '@gltf-transform/core';
import { AnimationMixer, Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
	canonicalNodeMapFromObject,
	retargetClipToObject,
	parseClipJSON,
} from '../src/animation-retarget.js';

const GLB_PATH = resolve(process.cwd(), 'public/avatars/parametric-base.glb');
const glbBytes = readFileSync(GLB_PATH);

async function loadThree() {
	const loader = new GLTFLoader();
	return new Promise((res, rej) => {
		loader.parse(
			glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
			'',
			(gltf) => res(gltf),
			rej,
		);
	});
}

describe('parametric-base.glb: validity and inventory', () => {
	it('passes glTF validation with no errors', async () => {
		const report = await gltfValidator.validateBytes(new Uint8Array(glbBytes));
		expect(report.issues.numErrors).toBe(0);
	});

	it('carries the 4 submeshes, 52-joint skin, and the curated morph set', async () => {
		const doc = await new NodeIO().read(GLB_PATH);
		const root = doc.getRoot();
		const meshes = Object.fromEntries(root.listMeshes().map((m) => [m.getName(), m]));
		expect(Object.keys(meshes).sort()).toEqual(['Body', 'Eyes', 'Teeth', 'Tongue']);
		expect(root.listSkins()).toHaveLength(1);
		expect(root.listSkins()[0].listJoints()).toHaveLength(52);

		const bodyNames = meshes.Body.getExtras()?.targetNames;
		expect(bodyNames.length).toBeGreaterThanOrEqual(300);
		expect(new Set(bodyNames).size).toBe(bodyNames.length); // no shadowed slider
		// One representative slider per region.
		for (const name of [
			'noseWider', 'mouthUpperLipFuller', 'earPointedLeft', 'earPointedRight',
			'eyeBiggerLeft', 'browsUp', 'cheekBonesLeft', 'jawWider', 'headRound',
			'neckThicker', 'bodyFeminine', 'bodyMasculine', 'bodyMuscular', 'bodyHeavier',
			'heightTaller', 'chestVShape', 'waistNarrower', 'hipsWider', 'gluteusBigger',
			'bellyBigger', 'shouldersWider', 'armsMuscular', 'thighsThicker', 'legsLonger',
			// Curation pass 2: the regions that were thin or missing entirely.
			'noseBridgeWider', 'noseNostrilsAngleUp', 'mouthPhiltrumDeeper',
			'mouthCupidsBowWider', 'earTriangleLeft', 'earTiltForwardRight',
			'eyeEpicanthusInLeft', 'eyeUpperLidUpRight', 'browsForward',
			'cheekInnerFullerLeft', 'jawBonesStronger', 'foreheadTemplesWider',
			'headDiamond', 'neckDoubleChin', 'torsoLatsWider', 'hipsWaistUp',
			'bellyNavelUp', 'armsUpperWider', 'legsKneesIn', 'legsUpperLonger',
			'bodyAfrican', 'bodyAsian', 'bodyCaucasian',
		]) {
			expect(bodyNames, name).toContain(name);
		}
		// Targets align with targetNames on every mesh.
		for (const [name, mesh] of Object.entries(meshes)) {
			const targets = mesh.listPrimitives()[0].listTargets();
			expect(targets.length, name).toBe(mesh.getExtras().targetNames.length);
		}
		// The eye placement sliders reach the eyeball submesh, not just the
		// body's sockets. (Scale morphs are socket-only by MakeHuman design:
		// real eyeballs barely vary in size; lids do.)
		expect(meshes.Eyes.getExtras().targetNames).toContain('eyeInwardLeft');
	});
});

describe('parametric-base.glb: three.js runtime behaviour', () => {
	let scene;
	beforeAll(async () => {
		scene = (await loadThree()).scene;
	});

	it('stands on the floor at human height, facing +Z', () => {
		scene.updateMatrixWorld(true);
		const box = new Box3().setFromObject(scene);
		expect(box.min.y).toBeGreaterThan(-0.05);
		expect(box.min.y).toBeLessThan(0.08);
		expect(box.max.y).toBeGreaterThan(1.5);
		expect(box.max.y).toBeLessThan(1.95);
	});

	it('canonicalizes the skeleton and retargets a library walk clip', () => {
		const map = canonicalNodeMapFromObject(scene);
		for (const bone of ['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightFoot', 'LeftHand']) {
			expect(map.has(bone), bone).toBe(true);
		}
		expect(map.size).toBeGreaterThanOrEqual(20);

		const walkJson = JSON.parse(
			readFileSync(resolve(process.cwd(), 'public/animations/clips/walk.json'), 'utf8'),
		);
		const clip = parseClipJSON(walkJson, 'walk');
		const result = retargetClipToObject(clip, scene);
		expect(result.clip).not.toBeNull();
		expect(result.coverage).toBeGreaterThanOrEqual(0.8);

		// Play half a second: the skeleton must actually move and stay finite.
		// (GLTFLoader strips ':' from node names, so resolve Hips through the
		// canonical map rather than the raw glTF name.)
		const hipsName = map.get('Hips');
		let hips = null;
		scene.traverse((n) => {
			if (!hips && n.name === hipsName) hips = n;
		});
		const restQuat = hips.quaternion.clone();
		const mixer = new AnimationMixer(scene);
		mixer.clipAction(result.clip).play();
		mixer.update(0.5);
		scene.updateMatrixWorld(true);
		expect(hips.quaternion.equals(restQuat)).toBe(false);
		const pos = new Vector3();
		scene.traverse((n) => {
			if (n.isBone) {
				n.getWorldPosition(pos);
				for (const v of [pos.x, pos.y, pos.z]) expect(Number.isFinite(v)).toBe(true);
			}
		});
	});

	it('loads morphs as localized geometry deltas', () => {
		let body = null;
		scene.traverse((n) => {
			if (n.isSkinnedMesh && n.name === 'Body') body = n;
		});
		expect(body).not.toBeNull();
		expect(Object.keys(body.morphTargetDictionary).length).toBeGreaterThanOrEqual(300);

		const positions = body.geometry.attributes.position;
		const inspect = (morphName) => {
			const idx = body.morphTargetDictionary[morphName];
			expect(idx, morphName).toBeGreaterThanOrEqual(0);
			const attr = body.geometry.morphAttributes.position[idx];
			let touched = 0;
			let maxMag = 0;
			let minY = Infinity;
			let maxY = -Infinity;
			for (let i = 0; i < attr.count; i++) {
				const dx = attr.getX(i);
				const dy = attr.getY(i);
				const dz = attr.getZ(i);
				const mag = Math.hypot(dx, dy, dz);
				if (mag < 1e-7) continue;
				touched++;
				maxMag = Math.max(maxMag, mag);
				const y = positions.getY(i);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
			return { touched, maxMag, minY, maxY };
		};

		// Nose slider: real but small and confined to the face band.
		const nose = inspect('noseWider');
		expect(nose.touched).toBeGreaterThan(20);
		expect(nose.maxMag).toBeLessThan(0.05);
		expect(nose.minY).toBeGreaterThan(1.3); // nowhere near the feet
		// Elf ears: confined to the head band.
		const ear = inspect('earPointedLeft');
		expect(ear.touched).toBeGreaterThan(10);
		expect(ear.minY).toBeGreaterThan(1.3);
		// Body macro: broad, touching thousands of vertices from legs to head.
		const fem = inspect('bodyFeminine');
		expect(fem.touched).toBeGreaterThan(2000);
		expect(fem.minY).toBeLessThan(0.3);
		expect(fem.maxY).toBeGreaterThan(1.4);
		// Height: moves nearly everything.
		const tall = inspect('heightTaller');
		expect(tall.touched).toBeGreaterThan(5000);
	});
});

describe('parametric-base.glb: panel grouping and runtime budget', () => {
	it('files every slider into a named sculpt group, none into "Other"', async () => {
		const doc = await new NodeIO().read(GLB_PATH);
		const names = doc
			.getRoot()
			.listMeshes()
			.flatMap((m) => m.getExtras()?.targetNames || []);
		const unique = [...new Set(names)].filter((n) => n !== 'tongueOut');

		const { CATEGORIES_FOR_TEST } = await import('../src/avatar-sculpt.js');
		const orphans = unique.filter((n) => !CATEGORIES_FOR_TEST.some((c) => c.match.test(n)));
		expect(orphans, `ungrouped sliders: ${orphans.join(', ')}`).toEqual([]);
	});

	it('stays inside the morph-texture VRAM budget the baker enforces', async () => {
		const doc = await new NodeIO().read(GLB_PATH);
		// three.js WebGLMorphtargets allocates an RGBA32F layer per target over
		// the full vertex count, whether the slider is at zero or not.
		let bytes = 0;
		for (const mesh of doc.getRoot().listMeshes()) {
			const prim = mesh.listPrimitives()[0];
			bytes += prim.getAttribute('POSITION').getCount() * prim.listTargets().length * 16;
		}
		expect(bytes / 1024 / 1024).toBeLessThan(96);
	});
});
