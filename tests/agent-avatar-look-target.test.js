/**
 * AgentAvatar × procedural look target — unit tests.
 *
 * `setLookTarget()` and the LOOK_AT protocol action used to store a target that
 * nothing ever read: the head transform derived its yaw purely from follow-mode
 * mouse/keystroke state, so a caller asking the avatar to look at a world point
 * got no movement at all. These tests pin the wiring that closed that gap
 * (`_applyLookTarget()` driving `src/procedural/look-at.js`), including the
 * camera-tracking branch and rebuild-on-avatar-swap.
 *
 * Built on a real Three.js bone chain (not a stub root) because the controller
 * resolves canonical bones off the live skeleton, but with a minimal fake viewer
 * in the style of tests/agent-avatar-mood-gesture.test.js — no renderer, no
 * clips, no DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Bone, Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { ACTION_TYPES } from '../src/agent-protocol.js';

let AgentAvatar;

// A humanoid torso chain with canonical bone names — enough for
// LookAtController to resolve Spine2 / Neck / Head and aim them.
function makeHumanoidRoot() {
	const root = new Group();
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
	root.add(hips);
	hips.add(spine);
	spine.add(spine2);
	spine2.add(neck);
	neck.add(head);
	root.updateWorldMatrix(true, true);
	return root;
}

// A root with no humanoid bones at all — a static prop. The controller must
// report itself unusable rather than nodding an arbitrary node.
function makePropRoot() {
	const root = new Group();
	const node = new Bone();
	node.name = 'PropPivot';
	root.add(node);
	root.updateWorldMatrix(true, true);
	return root;
}

function makeFakeViewer(content) {
	const camera = new PerspectiveCamera();
	camera.position.set(0, 1.4, 3);
	camera.updateWorldMatrix(true, false);
	return {
		content,
		activeCamera: camera,
		animationManager: {
			currentName: null,
			isLoaded: () => false,
			getAnimationDefs: () => [],
			play: () => Promise.resolve(true),
			crossfadeTo: () => {},
		},
		state: {},
	};
}

function makeAvatar(content = makeHumanoidRoot()) {
	const viewer = makeFakeViewer(content);
	return new AgentAvatar(viewer, {}, { id: 'test' });
}

// Model-space forward vector of the Head bone. The look layer is the only thing
// writing these bones in this harness, so any deviation from +Z is its work.
function headForward(root) {
	const head = root.getObjectByName('Head');
	head.updateWorldMatrix(true, false);
	const q = new Quaternion();
	head.getWorldQuaternion(q);
	const rootQ = new Quaternion();
	root.getWorldQuaternion(rootQ);
	return new Vector3(0, 0, 1).applyQuaternion(q).applyQuaternion(rootQ.invert());
}

// Run the look layer for enough simulated frames that its damping converges.
function settle(avatar, frames = 150) {
	for (let i = 0; i < frames; i++) avatar._applyLookTarget(1 / 60);
}

beforeEach(async () => {
	if (!AgentAvatar) {
		const mod = await import('../src/agent-avatar.js');
		AgentAvatar = mod.AgentAvatar;
	}
});

describe('AgentAvatar — setLookTarget drives the head', () => {
	it('turns the head toward a world-space target (the regression this closed)', () => {
		const root = makeHumanoidRoot();
		const avatar = makeAvatar(root);

		expect(headForward(root).x).toBeCloseTo(0, 5); // starts facing straight ahead
		avatar.setLookTarget(new Vector3(2, 1.5, 2)); // off to the avatar's left
		settle(avatar);

		const fwd = headForward(root);
		expect(fwd.x).toBeGreaterThan(0.25); // actually yawed toward the target
		expect(fwd.z).toBeGreaterThan(0.4); // still reads as a turn, not a spin
	});

	it('aims the opposite way for a target on the other side', () => {
		const root = makeHumanoidRoot();
		const avatar = makeAvatar(root);
		avatar.setLookTarget(new Vector3(-2, 1.5, 2));
		settle(avatar);
		expect(headForward(root).x).toBeLessThan(-0.25);
	});

	it('releases the gaze when the target is cleared', () => {
		const root = makeHumanoidRoot();
		const avatar = makeAvatar(root);
		avatar.setLookTarget(new Vector3(2, 1.5, 2));
		settle(avatar);
		expect(Math.abs(headForward(root).x)).toBeGreaterThan(0.2);

		avatar.setLookTarget(null);
		settle(avatar, 300);
		expect(Math.abs(headForward(root).x)).toBeLessThan(0.02);
	});

	it('is a no-op on a rig with no humanoid head', () => {
		const root = makePropRoot();
		const avatar = makeAvatar(root);
		avatar.setLookTarget(new Vector3(2, 1.5, 2));
		expect(() => settle(avatar, 20)).not.toThrow();
		expect(avatar._lookIk).toBe(null);
	});

	it('rebuilds its bone chain when the avatar model is swapped', () => {
		const first = makeHumanoidRoot();
		const avatar = makeAvatar(first);
		avatar.setLookTarget(new Vector3(2, 1.5, 2));
		settle(avatar, 20);
		const firstIk = avatar._lookIk;
		expect(firstIk).not.toBe(null);

		const second = makeHumanoidRoot();
		avatar.viewer.content = second;
		settle(avatar, 150);

		expect(avatar._lookIk).not.toBe(firstIk); // rebuilt for the new rig
		expect(headForward(second).x).toBeGreaterThan(0.25); // and it drives the new bones
	});
});

describe('AgentAvatar — LOOK_AT protocol action', () => {
	it('"model" aims at the loaded model and moves the head', () => {
		const root = makeHumanoidRoot();
		const avatar = makeAvatar(root);
		// Offset the rig so its own bounding-box centre is genuinely off-axis.
		root.position.set(1.5, 0, 0);
		root.updateWorldMatrix(true, true);

		avatar._onLookAt({ type: ACTION_TYPES.LOOK_AT, payload: { target: 'model' } });
		expect(avatar._lookTarget).toBeInstanceOf(Vector3);
		expect(() => settle(avatar)).not.toThrow();
	});

	it('"user" tracks the live camera rather than storing a dead null', () => {
		const root = makeHumanoidRoot();
		const avatar = makeAvatar(root);
		// Camera off to the avatar's right, so tracking it is observable.
		avatar.viewer.activeCamera.position.set(-3, 1.4, 2);
		avatar.viewer.activeCamera.updateWorldMatrix(true, false);

		avatar._onLookAt({ type: ACTION_TYPES.LOOK_AT, payload: { target: 'user' } });
		expect(avatar._lookAtCamera).toBe(true);
		settle(avatar);

		expect(headForward(root).x).toBeLessThan(-0.25);
	});

	it('an explicit world target overrides camera tracking', () => {
		const avatar = makeAvatar();
		avatar._onLookAt({ type: ACTION_TYPES.LOOK_AT, payload: { target: 'user' } });
		expect(avatar._lookAtCamera).toBe(true);
		avatar.setLookTarget(new Vector3(1, 1, 1));
		expect(avatar._lookAtCamera).toBe(false);
	});
});
