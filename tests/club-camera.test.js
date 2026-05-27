// Tests for the ClubCamera state machine used by /club.
//
// We stub a PerspectiveCamera-shaped object (just `.position` + `.lookAt`)
// because the state machine only writes to those. This keeps the test pure
// JS — no WebGL / DOM — so vitest exercises the math directly.

import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { ClubCamera, CLUB_CAMERA_MODES } from '../src/club-camera.js';

function makeStubCamera() {
	const cam = {
		position: new Vector3(),
		quaternion: new Quaternion(),
		_lookAt: new Vector3(),
		lookAt(x, y, z) {
			if (x?.isVector3) this._lookAt.copy(x);
			else this._lookAt.set(x, y, z);
		},
	};
	return cam;
}

// Drive the machine forward with fixed-dt frames until pending lerp settles
// or we hit the iteration ceiling.
function runFrames(clubCam, frames = 240, dt = 1 / 60) {
	for (let i = 0; i < frames; i++) clubCam.tick(dt);
}

describe('ClubCamera — vocabulary', () => {
	it('exports the canonical mode list', () => {
		expect(CLUB_CAMERA_MODES).toEqual(['free', 'vip', 'house', 'auto']);
	});

	it('starts in free mode with sensible defaults', () => {
		const c = new ClubCamera(makeStubCamera());
		expect(c.getMode()).toBe('free');
	});
});

describe('ClubCamera — VIP convergence', () => {
	const pole3 = { id: '3', x: 1.8, z: -2.4, yaw: 0.65 };

	it('setVip lerps camera to the expected world coordinate', () => {
		const cam = makeStubCamera();
		const c = new ClubCamera(cam);
		c.setVip(pole3);
		expect(c.getMode()).toBe('vip');

		runFrames(c, 240);

		// Expected world position = pole target + offset (yaw + π flips behind dancer).
		// VIP shot: front-and-low with target at y=1.4, offset at y=0.85, distance 2.4.
		const expectedTarget = new Vector3(pole3.x, 1.4, pole3.z);
		const expectedOffset = new Vector3(
			Math.sin(pole3.yaw + Math.PI) * 2.4,
			0.85,
			Math.cos(pole3.yaw + Math.PI) * 2.4,
		);
		const expectedPos = expectedTarget.clone().add(expectedOffset);

		expect(cam.position.distanceTo(expectedPos)).toBeLessThan(0.05);
		// And the camera looks at the dancer, not at empty space.
		expect(cam._lookAt.distanceTo(expectedTarget)).toBeLessThan(0.05);
	});

	it('switches to house mode (overhead) and lands above the room', () => {
		const cam = makeStubCamera();
		const c = new ClubCamera(cam);
		c.setHouse();
		expect(c.getMode()).toBe('house');

		runFrames(c, 360);

		// House cam target = (0, 0.5, -1.5), offset = (0, 13, ~0) → camera high overhead.
		// With gentle yaw rotation, the x position drifts slightly but stays near zero.
		expect(cam.position.y).toBeGreaterThan(12.5);
		expect(Math.abs(cam.position.x)).toBeLessThan(1.0);
	});
});

describe('ClubCamera — free mode after VIP', () => {
	const pole1 = { id: '1', x: -1.8, z: -2.4, yaw: -0.65 };

	it('ignores drag input while in VIP mode', () => {
		const c = new ClubCamera(makeStubCamera());
		c.setVip(pole1);
		const yawBefore = c.yaw;
		c.applyDrag(120, 0);
		expect(c.yaw).toBe(yawBefore);
	});

	it('setFree restores orbit and drag rotates yaw again', () => {
		const cam = makeStubCamera();
		const c = new ClubCamera(cam);
		c.setVip(pole1);
		runFrames(c, 60);

		c.setFree();
		expect(c.getMode()).toBe('free');

		const yawBefore = c.yaw;
		c.applyDrag(120, 0);
		expect(c.yaw).toBeLessThan(yawBefore); // applyDrag: yaw -= dx * 0.004

		// After settling, free-mode camera sits in front of the dance floor
		// (positive Z relative to the focus target) — i.e. user-facing.
		runFrames(c, 240);
		expect(cam.position.z).toBeGreaterThan(0);
	});

	it('drag pitch is clamped to [-0.3, 0.5]', () => {
		const c = new ClubCamera(makeStubCamera());
		// Huge negative dy → pitch up
		c.applyDrag(0, -10000);
		expect(c.pitch).toBe(0.5);
		// Huge positive dy → pitch down
		c.applyDrag(0, 10000);
		expect(c.pitch).toBe(-0.3);
	});
});

describe('ClubCamera — zoom', () => {
	it('applyZoom shrinks the offset on negative deltaY (zoom in)', () => {
		const c = new ClubCamera(makeStubCamera());
		const lenBefore = c.offset.length();
		c.applyZoom(-200);
		expect(c.offset.length()).toBeLessThan(lenBefore);
	});

	it('applyZoom is a no-op in house mode', () => {
		const c = new ClubCamera(makeStubCamera());
		c.setHouse();
		runFrames(c, 200); // settle
		const before = c.offset.clone();
		c.applyZoom(500);
		expect(c.offset.distanceTo(before)).toBe(0);
	});

	it('applyZoom clamps to per-mode bounds in free', () => {
		const c = new ClubCamera(makeStubCamera());
		// Zoom out hard
		for (let i = 0; i < 100; i++) c.applyZoom(500);
		expect(c.offset.length()).toBeLessThanOrEqual(14.0 + 1e-6);
		// Zoom in hard
		for (let i = 0; i < 100; i++) c.applyZoom(-500);
		expect(c.offset.length()).toBeGreaterThanOrEqual(3.5 - 1e-6);
	});
});

describe('ClubCamera — auto mode', () => {
	const pole2 = { id: '2', x: 0.5, z: -3.0, yaw: 0.3 };

	it('setAuto switches to auto mode and orbits the pole', () => {
		const cam = makeStubCamera();
		const c = new ClubCamera(cam);
		c.setAuto(pole2);
		expect(c.getMode()).toBe('auto');

		// After running frames, the camera should be near the pole's position
		// at the orbit radius.
		runFrames(c, 120);
		const distFromPole = Math.hypot(
			cam.position.x - pole2.x,
			cam.position.z - pole2.z,
		);
		// Should be roughly at the auto-orbit radius (~3.2).
		expect(distFromPole).toBeGreaterThan(2.0);
		expect(distFromPole).toBeLessThan(5.0);
		// Camera height should be at auto-orbit height (~1.6).
		expect(cam.position.y).toBeGreaterThan(1.0);
		expect(cam.position.y).toBeLessThan(3.0);
	});

	it('applyZoom works in auto mode', () => {
		const c = new ClubCamera(makeStubCamera());
		c.setAuto(pole2);
		runFrames(c, 60);
		// Zoom should not be a no-op.
		const before = c.offset.length();
		c.applyZoom(-200);
		expect(c.offset.length()).not.toBe(before);
	});
});

describe('ClubCamera — mode change callback', () => {
	it('fires onModeChange only on actual transitions', () => {
		const calls = [];
		const c = new ClubCamera(makeStubCamera(), {
			onModeChange: (m) => calls.push(m),
		});
		c.setFree(); // already free → no callback
		c.setVip({ id: '1', x: 0, z: 0, yaw: 0 });
		c.setVip({ id: '2', x: 1, z: 0, yaw: 0 }); // still vip → no callback
		c.setHouse();
		c.setAuto({ id: '3', x: 0, z: 0, yaw: 0 });
		c.setFree();
		expect(calls).toEqual(['vip', 'house', 'auto', 'free']);
	});
});
