/**
 * Procedural animation layer (src/procedural/): unit tests.
 *
 * Everything runs on synthetic in-memory Bone chains, no fixtures. The solver
 * tests assert millimetre-level placement; the controller tests assert the
 * observable contracts (clamps, fade-out, terrain adaptation, animated-pose
 * preservation) rather than exact quaternion values, since the controllers
 * damp toward their goals over simulated frames.
 */

import { describe, it, expect } from 'vitest';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { solveTwoBoneIK } from '../src/procedural/two-bone-ik.js';
import { LookAtController } from '../src/procedural/look-at.js';
import { FootPlantController } from '../src/procedural/foot-plant.js';

// A hip->knee->ankle chain hanging straight down from a root group at hip
// height, knee pre-bent slightly forward (+Z) like every real locomotion pose,
// so the solver has a bend plane to work with.
function makeLeg({ hipY = 1, thigh = 0.5, shin = 0.5, preBend = 0.05 } = {}) {
	const root = new Group();
	const hip = new Bone();
	hip.name = 'RightUpLeg';
	hip.position.set(0, hipY, 0);
	const knee = new Bone();
	knee.name = 'RightLeg';
	knee.position.set(0, -thigh, preBend);
	const ankle = new Bone();
	ankle.name = 'RightFoot';
	ankle.position.set(0, -shin, preBend);
	root.add(hip);
	hip.add(knee);
	knee.add(ankle);
	root.updateWorldMatrix(true, true);
	return { root, hip, knee, ankle };
}

// A minimal humanoid torso + legs, canonical bone names, one metre tall-ish.
function makeHumanoid() {
	const model = new Group();
	const hips = new Bone();
	hips.name = 'Hips';
	hips.position.set(0, 0.95, 0);
	const spine = new Bone();
	spine.name = 'Spine';
	spine.position.set(0, 0.1, 0);
	const spine2 = new Bone();
	spine2.name = 'Spine2';
	spine2.position.set(0, 0.2, 0);
	const neck = new Bone();
	neck.name = 'Neck';
	neck.position.set(0, 0.15, 0);
	const head = new Bone();
	head.name = 'Head';
	head.position.set(0, 0.1, 0);
	model.add(hips);
	hips.add(spine);
	spine.add(spine2);
	spine2.add(neck);
	neck.add(head);

	for (const side of ['Left', 'Right']) {
		const x = side === 'Left' ? 0.1 : -0.1;
		const up = new Bone();
		up.name = `${side}UpLeg`;
		up.position.set(x, -0.05, 0);
		const leg = new Bone();
		leg.name = `${side}Leg`;
		leg.position.set(0, -0.45, 0.02);
		const foot = new Bone();
		foot.name = `${side}Foot`;
		foot.position.set(0, -0.45, 0.02);
		hips.add(up);
		up.add(leg);
		leg.add(foot);
	}
	model.updateWorldMatrix(true, true);
	return model;
}

function headForwardModelSpace(model) {
	const head = model.getObjectByName('Head');
	const q = new Quaternion();
	head.getWorldQuaternion(q);
	const modelQ = new Quaternion();
	model.getWorldQuaternion(modelQ);
	return new Vector3(0, 0, 1).applyQuaternion(q).applyQuaternion(modelQ.invert());
}

// Run a controller for enough simulated 60fps frames that damping converges.
function settle(controller, frames = 120) {
	for (let i = 0; i < frames; i++) controller.update(1 / 60);
}

describe('solveTwoBoneIK', () => {
	it('places the tip on a reachable target', () => {
		const { hip, knee, ankle } = makeLeg();
		const target = new Vector3(0.15, 0.35, 0.1);
		const ok = solveTwoBoneIK(hip, knee, ankle, target, {
			pole: new Vector3(0, 0.5, 1),
		});
		expect(ok).toBe(true);
		const tip = ankle.getWorldPosition(new Vector3());
		expect(tip.distanceTo(target)).toBeLessThan(1e-3);
	});

	it('preserves bone lengths through the solve', () => {
		const { hip, knee, ankle } = makeLeg();
		const before = {
			thigh: hip.getWorldPosition(new Vector3()).distanceTo(knee.getWorldPosition(new Vector3())),
			shin: knee.getWorldPosition(new Vector3()).distanceTo(ankle.getWorldPosition(new Vector3())),
		};
		solveTwoBoneIK(hip, knee, ankle, new Vector3(0.2, 0.5, 0.15), {
			pole: new Vector3(0, 0.5, 1),
		});
		const after = {
			thigh: hip.getWorldPosition(new Vector3()).distanceTo(knee.getWorldPosition(new Vector3())),
			shin: knee.getWorldPosition(new Vector3()).distanceTo(ankle.getWorldPosition(new Vector3())),
		};
		expect(after.thigh).toBeCloseTo(before.thigh, 6);
		expect(after.shin).toBeCloseTo(before.shin, 6);
	});

	it('extends toward an out-of-reach target without exploding', () => {
		const { hip, knee, ankle } = makeLeg();
		const target = new Vector3(0, -5, 0); // 5m below a 1m leg
		const ok = solveTwoBoneIK(hip, knee, ankle, target, {
			pole: new Vector3(0, 0.5, 1),
		});
		expect(ok).toBe(true);
		const hipPos = hip.getWorldPosition(new Vector3());
		const tip = ankle.getWorldPosition(new Vector3());
		// Chain is nearly fully extended (softness caps at 98% of 1m reach)...
		expect(hipPos.distanceTo(tip)).toBeGreaterThan(0.95);
		expect(hipPos.distanceTo(tip)).toBeLessThan(1.0);
		// ...and points at the target.
		const dir = tip.sub(hipPos).normalize();
		const want = target.clone().sub(hipPos).normalize();
		expect(dir.dot(want)).toBeGreaterThan(0.999);
	});

	it('bends the knee toward the pole target', () => {
		const { hip, knee, ankle } = makeLeg();
		// Crouch: target well above full extension forces a deep bend.
		const target = new Vector3(0, 0.4, 0);
		const pole = new Vector3(0, 0.7, 2); // knee should point forward (+Z)
		solveTwoBoneIK(hip, knee, ankle, target, { pole });
		const kneePos = knee.getWorldPosition(new Vector3());
		const hipPos = hip.getWorldPosition(new Vector3());
		const tip = ankle.getWorldPosition(new Vector3());
		// Knee sits forward of the hip-ankle line, on the pole's side.
		const mid = hipPos.clone().add(tip).multiplyScalar(0.5);
		expect(kneePos.z - mid.z).toBeGreaterThan(0.05);
		expect(tip.distanceTo(target)).toBeLessThan(1e-3);
	});

	it('rejects a degenerate zero-length chain', () => {
		const root = new Group();
		const a = new Bone();
		const b = new Bone();
		const c = new Bone();
		root.add(a);
		a.add(b); // b at a's origin: zero-length bone
		b.add(c);
		root.updateWorldMatrix(true, true);
		expect(solveTwoBoneIK(a, b, c, new Vector3(1, 1, 1))).toBe(false);
	});

	it('solves from a perfectly straight chain using the pole to pick the bend plane', () => {
		const { hip, knee, ankle } = makeLeg({ preBend: 0 });
		const target = new Vector3(0, 0.5, 0); // requires bending
		const ok = solveTwoBoneIK(hip, knee, ankle, target, {
			pole: new Vector3(0, 0.7, 2),
		});
		expect(ok).toBe(true);
		const tip = ankle.getWorldPosition(new Vector3());
		expect(tip.distanceTo(target)).toBeLessThan(1e-3);
		// Bend went toward the pole (+Z), not backwards.
		expect(knee.getWorldPosition(new Vector3()).z).toBeGreaterThan(0);
	});
});

describe('LookAtController', () => {
	it('is disabled on a rig with no head', () => {
		const model = new Group();
		const box = new Bone();
		box.name = 'RandomProp';
		model.add(box);
		const ctl = new LookAtController(model);
		expect(ctl.enabled).toBe(false);
		expect(() => ctl.update(1 / 60)).not.toThrow();
	});

	it('turns the head toward a side target within the yaw clamp', () => {
		const model = makeHumanoid();
		const ctl = new LookAtController(model);
		expect(ctl.enabled).toBe(true);
		// Target off to the avatar's left (+X), slightly above head height.
		ctl.setTarget(new Vector3(1.2, 1.6, 1.2));
		settle(ctl);
		const fwd = headForwardModelSpace(model);
		// Head yawed toward +X...
		expect(fwd.x).toBeGreaterThan(0.3);
		// ...but still mostly forward (chain shares + clamps, never a 90deg snap).
		expect(fwd.z).toBeGreaterThan(0.4);
	});

	it('clamps an extreme side target instead of spinning the neck', () => {
		const model = makeHumanoid();
		const ctl = new LookAtController(model);
		ctl.setTarget(new Vector3(50, 1.4, 1)); // nearly 90deg to the side
		settle(ctl);
		const fwd = headForwardModelSpace(model);
		const yaw = Math.atan2(fwd.x, fwd.z);
		expect(yaw).toBeLessThanOrEqual(ctl.maxYaw + 0.02);
	});

	it('fades out for a target behind the avatar', () => {
		const model = makeHumanoid();
		const ctl = new LookAtController(model);
		ctl.setTarget(new Vector3(0, 1.4, -3)); // directly behind
		settle(ctl);
		const fwd = headForwardModelSpace(model);
		// The layer refused the behind target: still facing forward.
		expect(fwd.z).toBeGreaterThan(0.98);
	});

	it('returns to the base pose after the target clears', () => {
		const model = makeHumanoid();
		const ctl = new LookAtController(model);
		ctl.setTarget(new Vector3(2, 1.4, 1));
		settle(ctl);
		expect(Math.abs(headForwardModelSpace(model).x)).toBeGreaterThan(0.2);

		// The mixer contract: bone locals are rewritten each frame. Simulate by
		// restoring rest locals before each update, then let the fade drain.
		const head = model.getObjectByName('Head');
		const neck = model.getObjectByName('Neck');
		const spine2 = model.getObjectByName('Spine2');
		ctl.setTarget(null);
		for (let i = 0; i < 240; i++) {
			head.quaternion.identity();
			neck.quaternion.identity();
			spine2.quaternion.identity();
			ctl.update(1 / 60);
		}
		const fwd = headForwardModelSpace(model);
		expect(Math.abs(fwd.x)).toBeLessThan(0.02);
		expect(fwd.z).toBeGreaterThan(0.999);
	});

	it('respects the model root rotation when aiming', () => {
		const model = makeHumanoid();
		model.rotation.y = Math.PI / 2; // model already faces +X
		model.updateWorldMatrix(true, true);
		const ctl = new LookAtController(model);
		// Target dead ahead of the ROTATED model: no head turn should remain.
		ctl.setTarget(new Vector3(3, 1.4, 0));
		settle(ctl);
		const fwd = headForwardModelSpace(model);
		expect(fwd.z).toBeGreaterThan(0.99); // model-space forward, unturned
	});
});

describe('FootPlantController', () => {
	it('is disabled without a leg chain or ground sampler', () => {
		const model = new Group();
		const prop = new Bone();
		prop.name = 'Prop';
		model.add(prop);
		expect(new FootPlantController(model, () => 0).enabled).toBe(false);
		expect(new FootPlantController(makeHumanoid(), null).enabled).toBe(false);
	});

	it('keeps a flat-ground pose untouched', () => {
		const model = makeHumanoid();
		const ctl = new FootPlantController(model, () => 0);
		expect(ctl.enabled).toBe(true);
		const before = model.getObjectByName('Hips').position.y;
		const footBefore = model
			.getObjectByName('LeftFoot')
			.getWorldPosition(new Vector3());
		settle(ctl);
		expect(model.getObjectByName('Hips').position.y).toBeCloseTo(before, 4);
		const footAfter = model
			.getObjectByName('LeftFoot')
			.getWorldPosition(new Vector3());
		expect(footAfter.distanceTo(footBefore)).toBeLessThan(1e-3);
	});

	it('drops the pelvis and reaches the downhill foot on a slope', () => {
		const model = makeHumanoid();
		// Terrain: left side (x > 0) is 0.15m lower than under the origin.
		const ground = (x) => (x > 0.05 ? -0.15 : 0);
		const ctl = new FootPlantController(model, ground);
		const hipsBefore = model.getObjectByName('Hips').position.y;
		const leftBefore = model
			.getObjectByName('LeftFoot')
			.getWorldPosition(new Vector3());
		const rightBefore = model
			.getObjectByName('RightFoot')
			.getWorldPosition(new Vector3());

		// The mixer contract: restore animated locals each frame, then update.
		const rest = new Map();
		model.traverse((n) => {
			if (n.isBone) rest.set(n, { q: n.quaternion.clone(), p: n.position.clone() });
		});
		for (let i = 0; i < 240; i++) {
			for (const [bone, r] of rest) {
				bone.quaternion.copy(r.q);
				bone.position.copy(r.p);
			}
			ctl.update(1 / 60);
		}

		// Pelvis sank toward the downhill delta.
		expect(model.getObjectByName('Hips').position.y).toBeLessThan(hipsBefore - 0.1);
		model.updateWorldMatrix(true, true);
		// Left (downhill) foot followed the pelvis down toward its ground...
		const leftAfter = model
			.getObjectByName('LeftFoot')
			.getWorldPosition(new Vector3());
		expect(leftAfter.y).toBeLessThan(leftBefore.y - 0.1);
		// ...while the right (level-ground) foot was IK'd back up to its own
		// terrain height, not dragged down with the pelvis.
		const rightAfter = model
			.getObjectByName('RightFoot')
			.getWorldPosition(new Vector3());
		expect(Math.abs(rightAfter.y - rightBefore.y)).toBeLessThan(0.03);
	});

	it('preserves the animated foot orientation through the solve', () => {
		const model = makeHumanoid();
		const foot = model.getObjectByName('RightFoot');
		const ground = (x) => (x < -0.05 ? -0.2 : 0);
		const ctl = new FootPlantController(model, ground);
		const beforeQ = foot.getWorldQuaternion(new Quaternion());

		const rest = new Map();
		model.traverse((n) => {
			if (n.isBone) rest.set(n, { q: n.quaternion.clone(), p: n.position.clone() });
		});
		for (let i = 0; i < 240; i++) {
			for (const [bone, r] of rest) {
				bone.quaternion.copy(r.q);
				bone.position.copy(r.p);
			}
			ctl.update(1 / 60);
		}
		model.updateWorldMatrix(true, true);
		const afterQ = foot.getWorldQuaternion(new Quaternion());
		expect(Math.abs(beforeQ.angleTo(afterQ))).toBeLessThan(0.03);
	});
});
