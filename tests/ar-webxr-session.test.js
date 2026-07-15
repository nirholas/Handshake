// WebXR floor-anchor session lifecycle (src/ar/webxr.js), driven entirely by the
// fake XR device in tests/helpers/fake-xr.js — no AR hardware, no headless
// browser (immersive-ar can't run in one).
//
// The pure policy these side effects sit on top of is already proven in
// tests/ar-anchor-lifecycle.test.js (tracking machine, visibility enum, persist
// gate) and tests/irl-floor-anchor.test.js (pose → pin math). This suite pins the
// glue webxr.js owns: that a scripted sequence of frames and session events fires
// the host callbacks with the right payloads and leaves the viewer fully restored.
//
//   1. hit → tap → anchored emits onAnchored with the captured TAP-MOMENT pose,
//      then the live anchor drives content frame-to-frame.
//   2. createAnchor rejecting (or being absent) falls back to a frozen pose and
//      still anchors — degraded, never broken (task 05).
//   3. an OS-initiated end restores the viewer exactly once, idempotently.
//   4. tracking loss and visibility changes fire once, on the transition only.
//   5. the whole write path is numerically exact: a known hit matrix → the
//      persisted pin's lat/lng/heading/height (extends task 01 end-to-end).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';

import {
	FakeXRFrame,
	FakeXRHitTestResult,
	hitMatrix,
	mountWebXR,
} from './helpers/fake-xr.js';
import { TRACKING_LOSS_FRAMES } from '../src/ar/anchor-lifecycle.js';
import { anchorPoseToPin } from '../src/irl/floor-anchor.js';
import { geoToLocal } from '../src/irl/room-anchor.js';

// Every mount installs a fake navigator.xr; restore them all so suites can't leak
// a device into one another even when an assertion throws mid-test.
const _mounts = [];
async function mount(...args) {
	const rig = await mountWebXR(...args);
	_mounts.push(rig);
	return rig;
}
afterEach(() => {
	while (_mounts.length) _mounts.pop().restore();
});

// A frame carrying a single hit at `matrix`, tracking healthy.
const hitFrame = (matrix, anchorMode) =>
	new FakeXRFrame({ hits: [new FakeXRHitTestResult(matrix, { anchor: anchorMode })] });
// A frame with no surface under the reticle (still tracking).
const noHitFrame = () => new FakeXRFrame({ hits: [] });
// A frame where the device has lost its fix on the room.
const lostFrame = () => new FakeXRFrame({ viewerPose: null, hits: [] });

describe('start() — session bring-up', () => {
	it('enables XR, requests hit-test, and installs the animation loop', async () => {
		const { renderer, xrSession } = await mount();
		expect(renderer.xr.enabled).toBe(true);
		expect(renderer.xr._session).toBe(xrSession);
		expect(typeof renderer._animationLoop).toBe('function');
		expect(xrSession.init.requiredFeatures).toContain('hit-test');
		expect(xrSession.init.optionalFeatures).toEqual(
			expect.arrayContaining(['anchors', 'local-floor']),
		);
		expect(xrSession.hitTestSources).toHaveLength(1);
	});

	it('surfaces a dom-overlay root when one is supplied', async () => {
		// A real overlay root is a DOM element; the session subscribes its pinch
		// touch listeners on it, so the fake must be a working EventTarget.
		const root = Object.assign(new EventTarget(), { nodeType: 1 });
		const { xrSession } = await mount({ domOverlayRoot: root });
		expect(xrSession.init.optionalFeatures).toContain('dom-overlay');
		expect(xrSession.init.domOverlay).toEqual({ root });
	});
});

describe('hit → tap → anchored (the happy path)', () => {
	it('fires onHit only on the searching↔found transition', async () => {
		const onHit = vi.fn();
		const { renderer } = await mount({ onHit });

		renderer.tick(0, noHitFrame());                 // already searching → no callback
		expect(onHit).not.toHaveBeenCalled();

		renderer.tick(16, hitFrame(hitMatrix({ z: -2 }))); // surface found
		renderer.tick(32, hitFrame(hitMatrix({ z: -2 }))); // still found — no repeat
		expect(onHit.mock.calls).toEqual([[true]]);

		renderer.tick(48, noHitFrame());                 // lost the surface
		expect(onHit.mock.calls).toEqual([[true], [false]]);
	});

	it('moves the reticle and content onto the hit, then anchors on tap', async () => {
		const onAnchored = vi.fn();
		const { renderer, viewer, session, xrSession } = await mount({ onAnchored });

		const matrix = hitMatrix({ x: 1, y: -1.5, z: -2, yawDeg: 30 });
		renderer.tick(16, hitFrame(matrix));

		// Reticle (a ring+dot Group) and content track the hit pose before the tap.
		const reticle = session._reticle;
		expect(reticle.visible).toBe(true);
		expect(reticle.position.toArray()).toEqual([1, -1.5, -2]);
		expect(viewer.content.position.toArray()).toEqual([1, -1.5, -2]);

		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));

		const [pose, meta] = onAnchored.mock.calls[0];
		expect(meta).toEqual({ degraded: false });          // real anchor created
		expect(pose.position.x).toBeCloseTo(1, 6);
		expect(pose.position.y).toBeCloseTo(-1.5, 6);
		expect(pose.position.z).toBeCloseTo(-2, 6);
		// Reticle hides the instant we anchor so the user never taps a stale one.
		expect(reticle.visible).toBe(false);
	});

	it('drives content from the live anchor pose every frame once anchored', async () => {
		const onAnchored = vi.fn();
		const { renderer, viewer, xrSession } = await mount({ onAnchored });

		// Hold the hit result so we can read back the anchor it mints on tap.
		const hit = new FakeXRHitTestResult(hitMatrix({ x: 0, y: 0, z: -1 }), { anchor: 'real' });
		renderer.tick(16, new FakeXRFrame({ hits: [hit] }));
		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));

		const createdAnchor = hit.createdAnchor;
		expect(createdAnchor).toBeTruthy();

		// The anchor's live pose has drifted to a new spot; content follows it.
		renderer.tick(32, new FakeXRFrame({
			anchorPose: { anchor: createdAnchor, position: new Vector3(3, -1, -4) },
		}));
		expect(viewer.content.position.toArray()).toEqual([3, -1, -4]);
	});
});

describe('degraded anchor — createAnchor cannot honour the placement (task 05)', () => {
	it('a rejecting createAnchor still anchors, flagged degraded, frozen at the tap pose', async () => {
		const onAnchored = vi.fn();
		const { renderer, viewer, xrSession } = await mount({ onAnchored });

		const matrix = hitMatrix({ x: 2, y: -1.4, z: -1, yawDeg: 0 });
		renderer.tick(16, hitFrame(matrix, 'reject'));
		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));

		expect(onAnchored.mock.calls[0][1]).toEqual({ degraded: true });
		// No live anchor → a later frame can't move content; it stays frozen at the tap.
		renderer.tick(32, new FakeXRFrame({}));
		expect(viewer.content.position.toArray()).toEqual([2, -1.4, -1]);
	});

	it('a runtime without createAnchor degrades the same way (no throw)', async () => {
		const onAnchored = vi.fn();
		const { renderer, xrSession } = await mount({ onAnchored });

		renderer.tick(16, hitFrame(hitMatrix({ z: -1 }), 'unsupported'));
		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));
		expect(onAnchored.mock.calls[0][1]).toEqual({ degraded: true });
	});

	it('a second tap after anchoring is ignored — anchor exactly once', async () => {
		const onAnchored = vi.fn();
		const { renderer, xrSession } = await mount({ onAnchored });
		renderer.tick(16, hitFrame(hitMatrix({ z: -1 })));
		xrSession.emitSelect();
		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));
	});
});

describe('end() / OS-initiated end — restoration is idempotent', () => {
	it('restores the viewer and tears down exactly once, however the session ends', async () => {
		const onEnd = vi.fn();
		// Give content a non-trivial pre-AR transform, THEN start so it's captured.
		const rig = await mount({ onEnd }, { start: false });
		const { renderer, viewer, session } = rig;
		viewer.content.position.set(5, 6, 7);
		viewer.content.rotation.set(0, 0.5, 0);
		await session.start();
		const xrSession = rig.xrSession; // the device handed one out only after start()

		// A hit moves content during the session…
		renderer.tick(16, hitFrame(hitMatrix({ x: 9, z: -9 })));
		expect(viewer.content.position.x).toBe(9);

		xrSession.emitEnd();                 // OS swiped the app away

		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(renderer.xr.enabled).toBe(false);
		expect(renderer._animationLoop).toBeNull();
		expect(xrSession.hitTestSources[0].cancelled).toBe(true);
		expect(viewer.controls.enabled).toBe(true);
		expect(viewer.updateRenderLoopCount).toBe(1);
		// Content restored to the pre-AR transform captured at start.
		expect(viewer.content.position.toArray()).toEqual([5, 6, 7]);
		expect(viewer.content.rotation.y).toBeCloseTo(0.5, 6);
		// Reticle, contact shadow and pulse ring were all disposed and removed —
		// only the host's own content group is left in the scene.
		expect(session._reticle).toBeNull();
		expect(viewer.scene.children).toEqual([viewer.content]);
		// The visibilitychange listener was removed before teardown.
		expect(xrSession.listenerCount('visibilitychange')).toBe(0);

		// A redundant end (our exit button after the OS already ended) is a no-op.
		xrSession.emitEnd();
		await xrSession.end();
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	it('end() asks the session to end and lands in the same restoration path', async () => {
		const onEnd = vi.fn();
		const { session, xrSession } = await mount({ onEnd });
		await session.end();
		expect(xrSession.ended).toBe(true);
		expect(onEnd).toHaveBeenCalledTimes(1);
	});
});

describe('tracking loss — fires once, on the transition only', () => {
	it('declares lost only after a sustained run of pose-less frames, recovers on the first pose', async () => {
		const onTracking = vi.fn();
		const { renderer } = await mount({ onTracking });

		// One short blip below threshold: no loss.
		for (let i = 0; i < TRACKING_LOSS_FRAMES - 1; i++) renderer.tick(i, lostFrame());
		expect(onTracking).not.toHaveBeenCalled();

		// The frame that crosses the threshold fires "lost" once…
		renderer.tick(TRACKING_LOSS_FRAMES, lostFrame());
		expect(onTracking.mock.calls).toEqual([[false]]);

		// …and staying lost does not re-fire.
		renderer.tick(TRACKING_LOSS_FRAMES + 1, lostFrame());
		expect(onTracking.mock.calls).toEqual([[false]]);

		// The first pose back recovers, once.
		renderer.tick(TRACKING_LOSS_FRAMES + 2, noHitFrame());
		expect(onTracking.mock.calls).toEqual([[false], [true]]);
	});

	it('hides the reticle on tracking loss so the user never taps a stale one', async () => {
		const { renderer, session } = await mount({});
		renderer.tick(0, hitFrame(hitMatrix({ z: -1 })));
		const reticle = session._reticle;
		expect(reticle.visible).toBe(true);
		for (let i = 1; i <= TRACKING_LOSS_FRAMES; i++) renderer.tick(i, lostFrame());
		expect(reticle.visible).toBe(false);
	});
});

describe('visibility — backgrounding pauses, foregrounding resumes', () => {
	it('fires onVisibility on each transition and pauses per-frame work while hidden', async () => {
		const onVisibility = vi.fn();
		const { renderer, viewer, xrSession } = await mount({ onVisibility });

		const before = viewer.animationManager.updateCount;
		xrSession.emitVisibility('hidden');
		expect(onVisibility.mock.calls).toEqual([[false]]);

		// A tick while hidden submits a frame but runs no animation/hit work.
		renderer.tick(16, hitFrame(hitMatrix({ z: -1 })));
		expect(viewer.animationManager.updateCount).toBe(before);
		expect(renderer.renderCount).toBeGreaterThan(0);

		// 'visible-blurred' is still paused; 'visible' resumes.
		xrSession.emitVisibility('visible-blurred');
		xrSession.emitVisibility('visible');
		expect(onVisibility.mock.calls).toEqual([[false], [false], [true]]);

		renderer.tick(32, hitFrame(hitMatrix({ z: -1 })));
		expect(viewer.animationManager.updateCount).toBe(before + 1);
	});
});

describe('write-path pose round-trip — hit matrix → persisted pin (end-to-end)', () => {
	// Proves the whole numeric chain webxr.js + floor-anchor.js own together: a
	// known surface matrix decomposes (_readAnchorPose) into the pose handed to the
	// host, which anchorPoseToPin turns into a GPS pin that reloads where we tapped.
	const ORIGIN = { lat: 37.7749, lng: -122.4194 };

	it('a tap at +2 m E / +3 m N / 1.4 m below at 137° yaw reloads to those exact values', async () => {
		const onAnchored = vi.fn();
		const { renderer, xrSession } = await mount({ onAnchored });

		// Local frame: world north is −Z, so 3 m north is z = −3; 1.4 m below eye level.
		renderer.tick(16, hitFrame(hitMatrix({ x: 2, y: -1.4, z: -3, yawDeg: 137 })));
		xrSession.emitSelect();
		await vi.waitFor(() => expect(onAnchored).toHaveBeenCalledTimes(1));

		const { position, quaternion } = onAnchored.mock.calls[0][0];
		const pin = anchorPoseToPin({
			originLat: ORIGIN.lat,
			originLng: ORIGIN.lng,
			x: position.x,
			y: position.y,
			z: position.z,
			quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
		});

		// Horizontal offset reloads to (east 2, north 3) through the shared projection.
		const back = geoToLocal(ORIGIN.lat, ORIGIN.lng, pin.lat, pin.lng);
		expect(back.east).toBeCloseTo(2, 3);
		expect(back.north).toBeCloseTo(3, 3);
		// Height rides through untouched; heading is the tap yaw, normalised to [0,360).
		expect(pin.heightM).toBeCloseTo(-1.4, 6);
		expect(pin.heading).toBe(137);
		expect(pin.source).toBe('webxr');
	});
});
