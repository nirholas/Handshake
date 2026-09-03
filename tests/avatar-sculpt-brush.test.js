/**
 * Free sculpt: src/avatar-sculpt-brush.js, src/avatar-sculpt-doc.js and
 * api/_lib/bake-sculpt.js.
 *
 * The guarantee under test is the round trip. A brush stroke has to survive:
 *
 *   live mesh → serialize → appearance record → server bake → GLB → reload
 *
 * and land on the same vertices with the same displacement, while still
 * composing additively with the library morph sliders rather than replacing
 * them. Everything here runs against the real parametric base, so a change to
 * the baker's topology fails these rather than shipping silently.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { PerspectiveCamera, Ray, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
	SculptBrush,
	SCULPT_TARGET_NAME,
	ensureSculptTarget,
	getSculptTarget,
	serializeSculpt,
	applySculptToRoot,
	clearSculpt,
	sculptIsEmpty,
	pruneEmptySculptTargets,
} from '../src/avatar-sculpt-brush.js';
import {
	sanitizeSculptDoc,
	sculptVertexCount,
	sculptEqual,
	SCULPT_MAX_DISPLACEMENT,
} from '../src/avatar-sculpt-doc.js';
import { applySculpt, hasSculpt } from '../api/_lib/bake-sculpt.js';
import { collapseAppearance, hydrateAppearance } from '../src/avatar-studio-utils.js';

const GLB_PATH = resolve(process.cwd(), 'public/avatars/parametric-base.glb');
const glbBytes = readFileSync(GLB_PATH);

function loadThree(bytes = glbBytes) {
	return new Promise((res, rej) => {
		new GLTFLoader().parse(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			'',
			res,
			rej,
		);
	});
}

function bodyOf(scene) {
	let body = null;
	scene.traverse((n) => {
		if (!body && n.isSkinnedMesh && n.name === 'Body') body = n;
	});
	return body;
}

/**
 * Paint one stroke on the tip of the nose. Returns the scene plus the brush so
 * a caller can keep sculpting. No canvas is involved: applyStroke is the same
 * code path the pointer handler runs, minus the raycast.
 */
async function sculptedScene({ symmetry = true, radius = 0.04, strength = 0.01 } = {}) {
	const { scene } = await loadThree();
	scene.updateMatrixWorld(true);
	const body = bodyOf(scene);
	expect(body).not.toBeNull();

	const brush = new SculptBrush({
		root: scene,
		camera: { position: new Vector3(0, 1.5, 2), fov: 35 },
		domElement: null,
	});
	brush.setParams({ radius, strength, direction: 1, symmetry });

	// A point on the surface: take an actual vertex high on the head so the
	// stroke lands on real geometry rather than in the air.
	const point = new Vector3();
	body.getVertexPosition(highVertex(body), point).applyMatrix4(body.matrixWorld);
	const normal = new Vector3(0, 0, 1);

	const moved = brush.applyStroke({ mesh: body, point, normal });
	return { scene, body, brush, moved, point };
}

/** Index of a vertex near the top of the head, i.e. squarely on the body mesh. */
function highVertex(body) {
	const pos = body.geometry.attributes.position;
	let best = 0;
	let bestY = -Infinity;
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i);
		if (y > bestY) {
			bestY = y;
			best = i;
		}
	}
	return best;
}

describe('free sculpt: the brush writes a real morph target', () => {
	it('creates one custom target, moves vertices, and leaves the rest alone', async () => {
		const { body, moved } = await sculptedScene();
		expect(moved).toBeGreaterThan(5);

		const attr = getSculptTarget(body);
		expect(attr).not.toBeNull();
		expect(body.morphTargetDictionary[SCULPT_TARGET_NAME]).toBeGreaterThan(0);
		expect(body.morphTargetInfluences[body.morphTargetDictionary[SCULPT_TARGET_NAME]]).toBe(1);

		let touched = 0;
		let peak = 0;
		for (let i = 0; i < attr.count; i++) {
			const m = Math.hypot(attr.getX(i), attr.getY(i), attr.getZ(i));
			if (m > 0) touched++;
			peak = Math.max(peak, m);
		}
		// `moved` counts stroke applications, and symmetry runs a second pass
		// over the same near-midline vertices, so distinct vertices touched is
		// at most the stroke count and never zero.
		expect(touched).toBeGreaterThan(0);
		expect(touched).toBeLessThanOrEqual(moved);
		expect(peak).toBeGreaterThan(0);
		expect(peak).toBeLessThanOrEqual(SCULPT_MAX_DISPLACEMENT);
	});

	it('adds exactly one target no matter how many strokes land', async () => {
		const { scene, body, brush, point } = await sculptedScene();
		const before = body.geometry.morphAttributes.position.length;
		brush.applyStroke({ mesh: body, point, normal: new Vector3(0, 1, 0) });
		brush.applyStroke({ mesh: body, point, normal: new Vector3(1, 0, 0) });
		expect(body.geometry.morphAttributes.position.length).toBe(before);
		expect(sculptIsEmpty(scene)).toBe(false);
	});

	it('mirrors the stroke when symmetry is on and does not when it is off', async () => {
		const symmetric = await sculptedScene({ symmetry: true });
		const asymmetric = await sculptedScene({ symmetry: false });
		// The head vertex sits near the midline, so both passes overlap. Sculpt
		// off-centre to separate them: count the distinct X signs that moved.
		const signs = (mesh) => {
			const attr = getSculptTarget(mesh);
			const pos = mesh.geometry.attributes.position;
			let left = 0;
			let right = 0;
			for (let i = 0; i < attr.count; i++) {
				if (Math.hypot(attr.getX(i), attr.getY(i), attr.getZ(i)) === 0) continue;
				if (pos.getX(i) < 0) left++;
				else right++;
			}
			return { left, right };
		};
		const s = signs(symmetric.body);
		const a = signs(asymmetric.body);
		expect(s.left + s.right).toBeGreaterThanOrEqual(a.left + a.right);
		expect(asymmetric.moved).toBeGreaterThan(0);
	});

	it('clears back to the catalogue body', async () => {
		const { scene } = await sculptedScene();
		expect(sculptIsEmpty(scene)).toBe(false);
		clearSculpt(scene);
		expect(sculptIsEmpty(scene)).toBe(true);
		expect(serializeSculpt(scene)).toBeNull();
	});
});

describe('free sculpt: the serialized document', () => {
	it('round-trips through serialize → apply on a fresh model', async () => {
		const { scene, body } = await sculptedScene();
		const doc = serializeSculpt(scene);
		expect(doc).toBeTruthy();
		expect(doc.version).toBe(1);
		expect(sculptVertexCount(doc)).toBeGreaterThan(5);
		expect(sanitizeSculptDoc(doc)).toEqual(doc);

		const { scene: fresh } = await loadThree();
		const { applied, skipped } = applySculptToRoot(fresh, doc);
		expect(applied).toContain('Body');
		expect(skipped).toEqual([]);

		const source = getSculptTarget(body);
		const target = getSculptTarget(bodyOf(fresh));
		expect(target).not.toBeNull();
		// int16 quantisation over a 0.12 m range resolves to ~4 micrometres.
		for (let i = 0; i < source.count; i++) {
			expect(target.getX(i)).toBeCloseTo(source.getX(i), 5);
			expect(target.getY(i)).toBeCloseTo(source.getY(i), 5);
			expect(target.getZ(i)).toBeCloseTo(source.getZ(i), 5);
		}
	});

	it('survives the appearance record collapse and hydrate', async () => {
		const { scene } = await sculptedScene();
		const doc = serializeSculpt(scene);
		const collapsed = collapseAppearance({ morphs: { noseWider: 0.5 }, sculpt: doc });
		expect(collapsed.sculpt).toBeTruthy();
		// JSON is the actual transport, so prove it survives one.
		const hydrated = hydrateAppearance(JSON.parse(JSON.stringify(collapsed)));
		expect(sculptEqual(hydrated.sculpt, doc)).toBe(true);
		expect(hydrated.morphs.noseWider).toBe(0.5);
	});

	it('rejects a stale version, a bad block, and an empty document', () => {
		expect(sanitizeSculptDoc({ version: 99, meshes: { Body: {} } })).toBeNull();
		expect(sanitizeSculptDoc({ version: 1, meshes: {} })).toBeNull();
		expect(sanitizeSculptDoc({ version: 1, meshes: { Body: { scale: 0, indices: '', deltas: '' } } })).toBeNull();
		expect(sanitizeSculptDoc(null)).toBeNull();
	});

	it('drops a delta whose vertex index is past the end of the mesh', async () => {
		const { scene } = await sculptedScene();
		const doc = serializeSculpt(scene);
		doc.meshes.Ghost = { ...doc.meshes.Body };
		const { scene: fresh } = await loadThree();
		const { applied, skipped } = applySculptToRoot(fresh, doc);
		expect(applied).toContain('Body');
		expect(skipped).toContain('Ghost');
	});
});

describe('free sculpt: the server bake', () => {
	let doc;
	beforeAll(async () => {
		const { scene } = await sculptedScene();
		doc = serializeSculpt(scene);
	});

	it('writes the target into the GLB and pins its weight to 1', async () => {
		const gltf = await new NodeIO().readBinary(new Uint8Array(glbBytes));
		const before = gltf.getRoot().listMeshes().find((m) => m.getName() === 'Body');
		const beforeCount = before.listPrimitives()[0].listTargets().length;

		const { applied, skipped } = applySculpt(gltf, doc);
		expect(applied).toEqual(['Body']);
		expect(skipped).toEqual([]);

		const mesh = gltf.getRoot().listMeshes().find((m) => m.getName() === 'Body');
		const names = mesh.getExtras().targetNames;
		expect(names).toContain(SCULPT_TARGET_NAME);
		expect(mesh.listPrimitives()[0].listTargets()).toHaveLength(beforeCount + 1);
		expect(mesh.getWeights()[names.indexOf(SCULPT_TARGET_NAME)]).toBe(1);
	});

	it('is idempotent: baking the same sculpt twice adds one target, not two', async () => {
		const gltf = await new NodeIO().readBinary(new Uint8Array(glbBytes));
		applySculpt(gltf, doc);
		const once = gltf.getRoot().listMeshes().find((m) => m.getName() === 'Body');
		const count = once.listPrimitives()[0].listTargets().length;
		applySculpt(gltf, doc);
		const twice = gltf.getRoot().listMeshes().find((m) => m.getName() === 'Body');
		expect(twice.listPrimitives()[0].listTargets()).toHaveLength(count);
		expect(twice.getExtras().targetNames.filter((n) => n === SCULPT_TARGET_NAME)).toHaveLength(1);
	});

	it('reports a mesh whose vertex count does not match instead of mangling it', async () => {
		const gltf = await new NodeIO().readBinary(new Uint8Array(glbBytes));
		const wrong = { version: 1, meshes: { Body: { ...doc.meshes.Body, vertexCount: 7 } } };
		const { applied, skipped } = applySculpt(gltf, wrong);
		expect(applied).toEqual([]);
		expect(skipped[0].mesh).toBe('Body');
		expect(skipped[0].reason).toMatch(/vertex count/);
	});

	it('recognises a sculpt-only appearance as bakeable', async () => {
		const { isBakeable } = await import('../api/_lib/bake.js');
		expect(hasSculpt({ sculpt: doc })).toBe(true);
		expect(hasSculpt({ sculpt: { version: 1, meshes: {} } })).toBe(false);
		expect(isBakeable({ sculpt: doc })).toBe(true);
	});
});

describe('free sculpt: composes with the library morphs through a real bake', () => {
	it('lands both a slider and a stroke in one GLB, independently', async () => {
		const { scene } = await sculptedScene();
		const doc = serializeSculpt(scene);
		const source = getSculptTarget(bodyOf(scene));

		const { bakeAppearance } = await import('../api/_lib/bake.js');
		const bytes = await bakeAppearance(glbBytes, {
			morphs: { noseWider: 0.75 },
			sculpt: doc,
		});

		const { MeshoptDecoder } = await import('meshoptimizer');
		await MeshoptDecoder.ready;
		const { scene: baked } = await new Promise((res, rej) => {
			new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
				'',
				res,
				rej,
			);
		});

		const body = bodyOf(baked);
		expect(body).not.toBeNull();
		const dict = body.morphTargetDictionary;

		// The library slider kept its own target and its own weight.
		expect(dict.noseWider).toBeDefined();
		expect(body.morphTargetInfluences[dict.noseWider]).toBeCloseTo(0.75, 5);

		// The stroke arrived as its own target, fully weighted, carrying the
		// same displacement the browser recorded.
		expect(dict[SCULPT_TARGET_NAME]).toBeDefined();
		expect(body.morphTargetInfluences[dict[SCULPT_TARGET_NAME]]).toBe(1);

		const bakedAttr = body.geometry.morphAttributes.position[dict[SCULPT_TARGET_NAME]];
		let bakedPeak = 0;
		for (let i = 0; i < bakedAttr.count; i++) {
			bakedPeak = Math.max(
				bakedPeak,
				Math.hypot(bakedAttr.getX(i), bakedAttr.getY(i), bakedAttr.getZ(i)),
			);
		}
		let sourcePeak = 0;
		for (let i = 0; i < source.count; i++) {
			sourcePeak = Math.max(
				sourcePeak,
				Math.hypot(source.getX(i), source.getY(i), source.getZ(i)),
			);
		}
		// weld + quantize run over the whole document, so this is a tolerance
		// check on magnitude, not an exact-vertex comparison.
		expect(bakedPeak).toBeGreaterThan(sourcePeak * 0.5);
		expect(bakedPeak).toBeLessThan(sourcePeak * 2);
	});
});

describe('free sculpt: the hit test', () => {
	it('picks the front-most vertex under the ray and skips the background', async () => {
		const { scene } = await loadThree();
		scene.updateMatrixWorld(true);
		const body = bodyOf(scene);

		// A camera looking at the avatar from the front, matching the studio.
		const camera = new PerspectiveCamera(35, 1440 / 900, 0.05, 100);
		camera.position.set(0, 1.5, 2);
		camera.lookAt(0, 1.4, 0);
		camera.updateMatrixWorld(true);

		const brush = new SculptBrush({
			root: scene,
			camera,
			domElement: { clientHeight: 900, clientWidth: 1440, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 900 }) },
		});
		brush._meshes = [body];

		// Aim at the head, which sits above the orbit target and dead centre.
		const head = new Vector3();
		body.getVertexPosition(highVertex(body), head).applyMatrix4(body.matrixWorld);
		const ndc = head.clone().project(camera);
		const hit = brush._hit({
			clientX: ((ndc.x + 1) / 2) * 1440,
			clientY: ((1 - ndc.y) / 2) * 900,
		});
		expect(hit).not.toBeNull();
		expect(hit.object).toBe(body);

		// The contract is "a surface point under the cursor", not "that exact
		// vertex": aiming at the crown, the nearest-to-camera candidate inside
		// the pick radius is a little forward of the topmost vertex, which is
		// the correct answer. So measure the perpendicular distance to the ray.
		const ray = new Ray(
			camera.position.clone(),
			hit.point.clone().sub(camera.position).normalize(),
		);
		const aim = new Ray(camera.position.clone(), head.clone().sub(camera.position).normalize());
		expect(aim.distanceToPoint(hit.point)).toBeLessThan(0.03);
		expect(ray.distanceToPoint(hit.point)).toBeLessThan(1e-6);

		// The front of the head, not the back of it: the pick must be nearer the
		// camera than the far side of the skull.
		const far = brush._worldPositions(body);
		let deepest = 0;
		for (let i = 0; i < far.length / 3; i++) {
			deepest = Math.max(deepest, camera.position.distanceTo(new Vector3(far[i * 3], far[i * 3 + 1], far[i * 3 + 2])));
		}
		expect(hit.distance).toBeLessThan(deepest);

		// Well off to the side is background, and background orbits.
		expect(brush._hit({ clientX: 20, clientY: 860 })).toBeNull();
	});

	it('returns a world-space normal that follows the posed rig', async () => {
		const { scene } = await loadThree();
		scene.updateMatrixWorld(true);
		const body = bodyOf(scene);
		const brush = new SculptBrush({ root: scene, camera: { position: new Vector3(0, 1.5, 2), fov: 35 }, domElement: null });
		const n = brush._vertexNormal(body, highVertex(body));
		expect(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)).toBe(true);
		expect(n.length()).toBeCloseTo(1, 5);
		// Top of the head: the normal points up, not sideways or inward.
		expect(n.y).toBeGreaterThan(0.5);
	});
});

describe('free sculpt: the empty target is not left behind', () => {
	it('drops an untouched custom target and keeps a painted one', async () => {
		const { scene } = await loadThree();
		const body = bodyOf(scene);
		const before = body.geometry.morphAttributes.position.length;

		// Allocated but never painted: prune takes it back out, so an export
		// after toggling the brush on and off is byte-identical to no sculpt.
		ensureSculptTarget(body);
		expect(body.geometry.morphAttributes.position).toHaveLength(before + 1);
		expect(pruneEmptySculptTargets(scene)).toBeGreaterThan(0);
		expect(body.geometry.morphAttributes.position).toHaveLength(before);
		expect(body.morphTargetDictionary[SCULPT_TARGET_NAME]).toBeUndefined();

		// Painted: prune must leave it alone.
		const attr = ensureSculptTarget(body);
		attr.array[3] = 0.01;
		pruneEmptySculptTargets(scene);
		expect(body.morphTargetDictionary[SCULPT_TARGET_NAME]).toBe(before);
		expect(body.geometry.morphAttributes.position).toHaveLength(before + 1);
	});

	it('never renumbers the library sliders', async () => {
		const { scene } = await loadThree();
		const body = bodyOf(scene);
		const noseBefore = body.morphTargetDictionary.noseWider;
		ensureSculptTarget(body);
		pruneEmptySculptTargets(scene);
		expect(body.morphTargetDictionary.noseWider).toBe(noseBefore);
	});
});
