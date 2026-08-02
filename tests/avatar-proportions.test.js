// Skeleton-space proportions (src/avatar-proportions.js).
//
// These pin the three contracts the editor, the animation stack, and the saved
// appearance record all depend on:
//   1. the parameter document is canonical (clamped, neutral-free, order-stable),
//   2. the maths moves the joints it claims to and NOTHING else. In particular
//      it never writes a rotation, which is what keeps the retargeter's captured
//      rest frames valid,
//   3. the feet stay on the floor: a leg-length or foot-size edit lifts the hips
//      by exactly the distance the ground bones moved.

import { describe, it, expect } from 'vitest';
import {
	PROPORTION_PARAMS,
	PROPORTION_BONES,
	computeProportionTransforms,
	normalizeProportions,
	proportionsEqual,
	formatRatio,
	availableProportionParams,
	applyProportionsToRoot,
	captureProportionRest,
} from '../src/avatar-proportions.js';

/* ── A synthetic humanoid, metre-scale, feet at y=0, identity rotations ──── */

const SKELETON = [
	['Hips', null, [0, 0.95, 0]],
	['Spine', 'Hips', [0, 0.11, 0]],
	['Spine1', 'Spine', [0, 0.11, 0]],
	['Spine2', 'Spine1', [0, 0.11, 0]],
	['Neck', 'Spine2', [0, 0.12, 0]],
	['Head', 'Neck', [0, 0.09, 0]],
	['LeftShoulder', 'Spine2', [0.05, 0.08, 0]],
	['LeftArm', 'LeftShoulder', [0.12, 0, 0]],
	['LeftForeArm', 'LeftArm', [0.28, 0, 0]],
	['LeftHand', 'LeftForeArm', [0.25, 0, 0]],
	['RightShoulder', 'Spine2', [-0.05, 0.08, 0]],
	['RightArm', 'RightShoulder', [-0.12, 0, 0]],
	['RightForeArm', 'RightArm', [-0.28, 0, 0]],
	['RightHand', 'RightForeArm', [-0.25, 0, 0]],
	['LeftUpLeg', 'Hips', [0.09, -0.05, 0]],
	['LeftLeg', 'LeftUpLeg', [0, -0.42, 0]],
	['LeftFoot', 'LeftLeg', [0, -0.4, 0]],
	['LeftToeBase', 'LeftFoot', [0, -0.08, 0.12]],
	['RightUpLeg', 'Hips', [-0.09, -0.05, 0]],
	['RightLeg', 'RightUpLeg', [0, -0.42, 0]],
	['RightFoot', 'RightLeg', [0, -0.4, 0]],
	['RightToeBase', 'RightFoot', [0, -0.08, 0.12]],
];

function restMap() {
	const map = new Map();
	for (const [name, parent, [x, y, z]] of SKELETON) {
		map.set(name, {
			position: { x, y, z },
			quaternion: { x: 0, y: 0, z: 0, w: 1 },
			scale: { x: 1, y: 1, z: 1 },
			parent,
		});
	}
	return map;
}

/** World (armature-frame) origin of a bone under a set of edited locals. */
function originOf(name, rest, edits = new Map()) {
	const chain = [];
	for (let cur = name; cur; cur = rest.get(cur)?.parent || null) chain.push(cur);
	let p = { x: 0, y: 0, z: 0 };
	let s = { x: 1, y: 1, z: 1 };
	for (let i = chain.length - 1; i >= 0; i--) {
		const bone = rest.get(chain[i]);
		const edit = edits.get(chain[i]);
		const local = edit?.position ?? bone.position;
		p = { x: p.x + local.x * s.x, y: p.y + local.y * s.y, z: p.z + local.z * s.z };
		const sc = edit?.scale ?? bone.scale;
		s = { x: s.x * sc.x, y: s.y * sc.y, z: s.z * sc.z };
	}
	return p;
}

/* ── The parameter document ──────────────────────────────────────────────── */

describe('normalizeProportions', () => {
	it('drops unknown keys, junk values, and anything neutral', () => {
		expect(normalizeProportions(null)).toEqual({});
		expect(normalizeProportions({ height: 1 })).toEqual({});
		expect(normalizeProportions({ nose: 2, height: NaN, legLength: 'tall' })).toEqual({});
		expect(normalizeProportions({ legLength: 1.0000001 })).toEqual({});
	});

	it('clamps to each parameter\'s declared range', () => {
		const legLength = PROPORTION_PARAMS.find((p) => p.id === 'legLength');
		expect(normalizeProportions({ legLength: 99 })).toEqual({ legLength: legLength.max });
		expect(normalizeProportions({ legLength: -3 })).toEqual({ legLength: legLength.min });
	});

	it('round-trips a real record and compares by meaning', () => {
		const a = { height: 1.05, hipWidth: 0.92 };
		expect(normalizeProportions(a)).toEqual(a);
		expect(proportionsEqual(a, { ...a, headSize: 1 })).toBe(true);
		expect(proportionsEqual(a, { ...a, headSize: 1.1 })).toBe(false);
		expect(proportionsEqual(null, {})).toBe(true);
	});

	it('every parameter declares a range that brackets neutral', () => {
		for (const p of PROPORTION_PARAMS) {
			expect(p.min, p.id).toBeLessThan(1);
			expect(p.max, p.id).toBeGreaterThan(1);
			expect(p.bones.every((b) => PROPORTION_BONES.includes(b)), p.id).toBe(true);
		}
	});
});

describe('formatRatio', () => {
	it('reads as a signed percentage around neutral', () => {
		expect(formatRatio(1)).toBe('default');
		expect(formatRatio(1.06)).toBe('+6%');
		expect(formatRatio(0.94)).toBe('-6%');
	});
});

/* ── The maths ───────────────────────────────────────────────────────────── */

describe('computeProportionTransforms', () => {
	it('is a no-op for a default body', () => {
		const { bones, stature, applied } = computeProportionTransforms(restMap(), {});
		expect(bones.size).toBe(0);
		expect(stature).toBe(1);
		expect(applied).toEqual([]);
	});

	it('lengthens the shin and ankle, and nothing above the hips', () => {
		const rest = restMap();
		const { bones } = computeProportionTransforms(rest, { legLength: 1.1 });
		expect(bones.get('LeftLeg').position.y).toBeCloseTo(-0.42 * 1.1, 9);
		expect(bones.get('LeftFoot').position.y).toBeCloseTo(-0.4 * 1.1, 9);
		// The thigh's offset from the hips is joint placement, not leg length.
		expect(bones.has('LeftUpLeg')).toBe(false);
		expect(bones.has('Spine')).toBe(false);
		expect(bones.has('Head')).toBe(false);
	});

	it('keeps the feet on the floor when the legs get longer', () => {
		const rest = restMap();
		const before = originOf('LeftToeBase', rest);
		const { bones } = computeProportionTransforms(rest, { legLength: 1.12 });
		const after = originOf('LeftToeBase', rest, bones);
		expect(after.y).toBeCloseTo(before.y, 9);
		// It got there by lifting the hips, not by refusing to lengthen the leg.
		expect(bones.get('Hips').position.y).toBeGreaterThan(rest.get('Hips').position.y);
		expect(originOf('Head', rest, bones).y).toBeGreaterThan(originOf('Head', rest).y);
	});

	it('keeps the soles grounded when the feet get bigger', () => {
		const rest = restMap();
		const before = originOf('RightToeBase', rest);
		const { bones } = computeProportionTransforms(rest, { footSize: 1.2 });
		expect(bones.get('RightFoot').scale).toEqual({ x: 1.2, y: 1.2, z: 1.2 });
		expect(originOf('RightToeBase', rest, bones).y).toBeCloseTo(before.y, 9);
	});

	it('spreads the hips laterally without raising or lowering the feet', () => {
		const rest = restMap();
		const beforeL = originOf('LeftToeBase', rest);
		const beforeR = originOf('RightToeBase', rest);
		const { bones } = computeProportionTransforms(rest, { hipWidth: 1.2 });
		const afterL = originOf('LeftToeBase', rest, bones);
		const afterR = originOf('RightToeBase', rest, bones);
		expect(afterL.x).toBeCloseTo(beforeL.x * 1.2, 9);
		expect(afterR.x).toBeCloseTo(beforeR.x * 1.2, 9);
		// A symmetric lateral edit must not smuggle in a vertical hip shift: the
		// two feet's deltas cancel, so the hips are never touched at all.
		expect(afterL.y).toBeCloseTo(beforeL.y, 9);
		expect(afterR.y).toBeCloseTo(beforeR.y, 9);
		expect(bones.has('Hips')).toBe(false);
	});

	it('scales only the lateral axis for a width parameter', () => {
		const rest = restMap();
		const { bones } = computeProportionTransforms(rest, { shoulderWidth: 1.15 });
		const shoulder = bones.get('LeftShoulder');
		expect(shoulder.position.x).toBeCloseTo(0.05 * 1.15, 9);
		expect(shoulder.position.y).toBeCloseTo(0.08, 9); // height above the chest is untouched
	});

	it('never writes a bone rotation', () => {
		const rest = restMap();
		const all = Object.fromEntries(PROPORTION_PARAMS.map((p) => [p.id, p.max]));
		const { bones } = computeProportionTransforms(rest, all);
		expect(bones.size).toBeGreaterThan(0);
		for (const [, local] of bones) {
			expect(Object.keys(local).sort()).toEqual(['position', 'scale']);
		}
	});

	it('reports stature separately from the bones', () => {
		const { bones, stature } = computeProportionTransforms(restMap(), { height: 1.1 });
		expect(stature).toBeCloseTo(1.1, 9);
		expect(bones.size).toBe(0); // stature scales the armature node, not a joint
	});

	it('is a pure function of the record, not of edit order', () => {
		const a = computeProportionTransforms(restMap(), { legLength: 1.1, footSize: 0.9 });
		const b = computeProportionTransforms(restMap(), { footSize: 0.9, legLength: 1.1 });
		expect([...a.bones.entries()]).toEqual([...b.bones.entries()]);
	});

	it('survives a rig missing most of the skeleton', () => {
		const partial = new Map([
			['Hips', { position: { x: 0, y: 1, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent: null }],
		]);
		const { bones, applied } = computeProportionTransforms(partial, { legLength: 1.1, headSize: 1.1 });
		expect(bones.size).toBe(0);
		expect(applied).toEqual([]);
		expect(computeProportionTransforms(new Map(), { legLength: 1.1 }).bones.size).toBe(0);
	});
});

/* ── The three.js binding ────────────────────────────────────────────────── */

// Minimal Object3D stand-ins: the module only ever reads/writes position,
// quaternion and scale and walks `.parent` / `.traverse`, so this is enough to
// exercise the real code path without pulling in a renderer.
function makeNode(name) {
	return {
		name,
		isObject3D: true,
		isBone: true,
		parent: null,
		children: [],
		position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
		quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
		scale: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
		add(child) { child.parent = this; this.children.push(child); return this; },
		traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); },
		updateMatrixWorld() {},
	};
}

function makeRig() {
	const root = makeNode('Scene');
	root.isBone = false;
	const armature = makeNode('Armature');
	armature.isBone = false;
	root.add(armature);
	const nodes = new Map();
	for (const [name, parent, [x, y, z]] of SKELETON) {
		const node = makeNode(`mixamorig:${name}`);
		node.position.set(x, y, z);
		nodes.set(name, node);
		(parent ? nodes.get(parent) : armature).add(node);
	}
	return { root, armature, nodes };
}

describe('applyProportionsToRoot', () => {
	it('offers every parameter on a full humanoid with an armature node', () => {
		const { root } = makeRig();
		const ids = availableProportionParams(root);
		expect(ids.sort()).toEqual(PROPORTION_PARAMS.map((p) => p.id).sort());
	});

	it('writes the skeleton and scales the armature for stature', () => {
		const { root, armature, nodes } = makeRig();
		const result = applyProportionsToRoot(root, { legLength: 1.1, height: 1.05 });
		expect(result.stature).toBeCloseTo(1.05, 9);
		expect(nodes.get('LeftLeg').position.y).toBeCloseTo(-0.42 * 1.1, 9);
		expect(armature.scale.y).toBeCloseTo(1.05, 9);
		expect(nodes.get('Hips').position.y).toBeGreaterThan(0.95);
	});

	it('applies from rest, so repeated edits never compound', () => {
		const { root, nodes } = makeRig();
		applyProportionsToRoot(root, { legLength: 1.1 });
		applyProportionsToRoot(root, { legLength: 1.1 });
		expect(nodes.get('LeftLeg').position.y).toBeCloseTo(-0.42 * 1.1, 9);
		applyProportionsToRoot(root, {});
		expect(nodes.get('LeftLeg').position.y).toBeCloseTo(-0.42, 9);
		expect(nodes.get('Hips').position.y).toBeCloseTo(0.95, 9);
	});

	it('restores the bind pose, so a mid-animation rig is measured at rest', () => {
		const { root, nodes } = makeRig();
		captureProportionRest(root);
		// A running mixer leaves the bones posed; the next apply must not treat
		// that pose as rest.
		nodes.get('LeftLeg').quaternion.set(0.3, 0, 0, 0.954);
		applyProportionsToRoot(root, { legLength: 1.1 });
		expect(nodes.get('LeftLeg').quaternion.x).toBe(0);
		expect(nodes.get('LeftLeg').quaternion.w).toBe(1);
	});

	it('hides the Height slider when the hips are parented straight to the root', () => {
		const root = makeNode('Scene');
		root.isBone = false;
		const nodes = new Map();
		for (const [name, parent, [x, y, z]] of SKELETON) {
			const node = makeNode(name);
			node.position.set(x, y, z);
			nodes.set(name, node);
			(parent ? nodes.get(parent) : root).add(node);
		}
		const ids = availableProportionParams(root);
		expect(ids).not.toContain('height');
		expect(ids).toContain('legLength');
	});

	it('returns null for a rig with no hips rather than throwing', () => {
		const root = makeNode('Scene');
		root.isBone = false;
		root.add(makeNode('Wheel'));
		expect(applyProportionsToRoot(root, { legLength: 1.1 })).toBeNull();
		expect(availableProportionParams(root)).toEqual([]);
	});
});
