/**
 * SceneController gaze — unit tests.
 *
 * `lookAt()` is part of the public `<agent-3d>` surface (element.js forwards to
 * it). It used to call `head.lookAt(target)` on the head bone directly, which
 * had three defects these tests pin against regressing:
 *
 *   1. `Object3D.lookAt` aims the object's local **+Z**, which on a skeleton is
 *      whatever direction the rigger happened to point that bone — so the head
 *      landed at an arbitrary orientation on most rigs.
 *   2. It wrote the pose exactly once. On an avatar playing any clip the mixer
 *      overwrote it on the very next frame, so the gaze did not persist.
 *   3. Nothing was clamped, so a target behind the avatar spun the head around.
 *
 * The replacement registers a per-frame hook that re-applies a clamped, damped,
 * chest/neck/head-distributed gaze after the mixer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Bone, Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';

let SceneController;

function makeHumanoidRoot() {
	const root = new Group();
	const hips = new Bone();
	hips.name = 'mixamorigHips';
	hips.position.set(0, 0.95, 0);
	const spine = new Bone();
	spine.name = 'mixamorigSpine';
	spine.position.set(0, 0.1, 0);
	const spine2 = new Bone();
	spine2.name = 'mixamorigSpine2';
	spine2.position.set(0, 0.2, 0);
	const neck = new Bone();
	neck.name = 'mixamorigNeck';
	neck.position.set(0, 0.15, 0);
	const head = new Bone();
	head.name = 'mixamorigHead';
	head.position.set(0, 0.1, 0);
	root.add(hips);
	hips.add(spine);
	spine.add(spine2);
	spine2.add(neck);
	neck.add(head);
	root.updateWorldMatrix(true, true);
	return root;
}

function makePropRoot() {
	const root = new Group();
	const pivot = new Bone();
	pivot.name = 'PropPivot';
	root.add(pivot);
	root.updateWorldMatrix(true, true);
	return root;
}

// Minimal viewer: only the fields SceneController touches for gaze.
function makeFakeViewer(content) {
	const camera = new PerspectiveCamera();
	camera.position.set(0, 1.5, 3);
	camera.updateWorldMatrix(true, false);
	return {
		content,
		activeCamera: camera,
		scene: new Group(),
		renderer: {},
		mixer: null,
		clips: [],
		invalidate() {
			this.invalidated = (this.invalidated || 0) + 1;
		},
		_afterAnimateHooks: [],
	};
}

function makeScene(content = makeHumanoidRoot()) {
	return new SceneController(makeFakeViewer(content));
}

// Drive every registered per-frame hook, the way Viewer's animate loop would.
function frames(scene, count = 150, dt = 1 / 60) {
	for (let i = 0; i < count; i++) {
		for (const hook of [...scene.viewer._afterAnimateHooks]) hook(dt);
	}
}

function headForward(root) {
	const head = root.getObjectByName('mixamorigHead');
	head.updateWorldMatrix(true, false);
	const q = new Quaternion();
	head.getWorldQuaternion(q);
	const rootQ = new Quaternion();
	root.getWorldQuaternion(rootQ);
	return new Vector3(0, 0, 1).applyQuaternion(q).applyQuaternion(rootQ.invert());
}

beforeEach(async () => {
	if (!SceneController) {
		const mod = await import('../src/runtime/scene.js');
		SceneController = mod.SceneController ?? mod.default;
	}
});

describe('SceneController.lookAt', () => {
	it('turns the head toward a world-space target', () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.lookAt(new Vector3(2, 1.5, 2));
		frames(scene);
		const fwd = headForward(root);
		expect(fwd.x).toBeGreaterThan(0.25);
		expect(fwd.z).toBeGreaterThan(0.4);
	});

	it('registers exactly one per-frame hook however often it is called', () => {
		const scene = makeScene();
		const before = scene.viewer._afterAnimateHooks.length;
		scene.lookAt(new Vector3(1, 1, 1));
		scene.lookAt(new Vector3(-1, 1, 1));
		scene.lookAt('camera');
		expect(scene.viewer._afterAnimateHooks.length).toBe(before + 1);
	});

	it('persists the gaze across frames rather than writing it once', () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.lookAt(new Vector3(2, 1.5, 2));
		frames(scene);
		const settled = headForward(root).x;

		// Simulate a mixer re-posing the skeleton every frame, as a playing clip
		// would. The gaze must survive that, which the old one-shot write did not.
		const bones = ['mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead'].map((n) =>
			root.getObjectByName(n),
		);
		for (let i = 0; i < 60; i++) {
			for (const b of bones) b.quaternion.identity();
			for (const hook of [...scene.viewer._afterAnimateHooks]) hook(1 / 60);
		}
		expect(headForward(root).x).toBeCloseTo(settled, 1);
	});

	it("'camera' tracks the camera as it moves", () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.viewer.activeCamera.position.set(3, 1.5, 2);
		scene.lookAt('camera');
		frames(scene);
		expect(headForward(root).x).toBeGreaterThan(0.2);

		// Move the camera to the other side — the standing gaze must follow.
		scene.viewer.activeCamera.position.set(-3, 1.5, 2);
		frames(scene, 300);
		expect(headForward(root).x).toBeLessThan(-0.2);
	});

	it('clamps rather than spinning the head for an extreme side target', () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.lookAt(new Vector3(60, 1.4, 0.5));
		frames(scene);
		const fwd = headForward(root);
		const yaw = Math.abs(Math.atan2(fwd.x, fwd.z));
		expect(yaw).toBeLessThan((70 * Math.PI) / 180);
	});

	it('releases the gaze on lookAt(null)', () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.lookAt(new Vector3(2, 1.5, 2));
		frames(scene);
		expect(Math.abs(headForward(root).x)).toBeGreaterThan(0.2);

		scene.lookAt(null);
		frames(scene, 300);
		expect(Math.abs(headForward(root).x)).toBeLessThan(0.02);
	});

	it('falls back to rotating the whole model when the rig has no head', () => {
		const root = makePropRoot();
		const scene = makeScene(root);
		expect(() => scene.lookAt(new Vector3(3, 0, 0))).not.toThrow();
		// No gaze hook is registered for a rig that cannot support one.
		expect(scene.viewer._afterAnimateHooks.length).toBe(0);
		// The model itself yawed toward the target instead.
		expect(Math.abs(root.rotation.y)).toBeGreaterThan(0.1);
	});

	it('warns and does nothing for an unknown named target', () => {
		const root = makeHumanoidRoot();
		const scene = makeScene(root);
		scene.lookAt('nowhere');
		frames(scene, 30);
		expect(Math.abs(headForward(root).x)).toBeLessThan(1e-6);
	});

	it('drops its hook and gaze state on dispose', () => {
		const scene = makeScene();
		scene.lookAt('camera');
		expect(scene.viewer._afterAnimateHooks.length).toBe(1);
		scene.dispose();
		expect(scene.viewer._afterAnimateHooks.length).toBe(0);
		expect(scene._gazeTarget).toBe(null);
	});
});

describe('SceneController.getCanonicalBone', () => {
	it('resolves canonical names through the shared canonicalizer, not a hardcoded list', () => {
		const root = makeHumanoidRoot(); // mixamorig-prefixed names
		const scene = makeScene(root);
		expect(scene.getCanonicalBone('Head')?.name).toBe('mixamorigHead');
		expect(scene.getCanonicalBone('Neck')?.name).toBe('mixamorigNeck');
		expect(scene.getCanonicalBone('Hips')?.name).toBe('mixamorigHips');
	});

	it('returns null for a bone the rig does not have', () => {
		const scene = makeScene();
		expect(scene.getCanonicalBone('LeftFoot')).toBe(null);
	});

	it('rebuilds its map after a model swap', () => {
		const scene = makeScene();
		expect(scene.getCanonicalBone('Head')).not.toBe(null);
		const next = makeHumanoidRoot();
		scene.viewer.content = next;
		expect(scene.getCanonicalBone('Head')).toBe(next.getObjectByName('mixamorigHead'));
	});
});
