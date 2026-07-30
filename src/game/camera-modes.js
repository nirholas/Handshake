// Camera modes — a shared 4-mode chase camera (follow / cinematic / firstperson
// / topdown), extracted from `/walk` (W01: open-world foundation) so `/play`
// gets the same camera system instead of a second, divergent implementation.
// See the W-world-online program port checklist, item P1.4 (retired; see git history).
//
// `computeCameraForMode()` is the pure per-frame pose math (no allocation
// beyond a shared scratch, no side effects) — both `walk.js` and
// `coincommunities.js` can call it directly for a one-shot pose. It is a
// faithful port of the orbit math walk.js carried inline; the 'follow' orbit
// formula matches what `/play` and `/walk` already used. (The follow FOV was
// widened from 50° to 58° — see CAMERA_MODE_FOV — so the default view frames
// more of the world; the orbit geometry itself is unchanged.)
//
// `createCameraModeController()` wraps it with mode cycling, localStorage
// persistence, and a cross-fade transition so a mode swap doesn't pop.

import { Vector3 } from 'three';

export const CAMERA_MODES = ['follow', 'cinematic', 'firstperson', 'topdown'];

export const CAMERA_MODE_LABELS = {
	follow: 'Follow',
	cinematic: 'Cinematic',
	firstperson: 'First Person',
	topdown: 'Top Down',
};

// Follow sits at 58° — wide enough to frame the plaza (totem, jumbotrons, the
// avatars around you) without the fisheye a 70°+ lens gives a close chase cam.
// The old 50° read as telephoto: everything felt zoomed in and cropped at the
// edges. Cinematic stays tight (35°) for its slow hero orbit; first person is a
// natural 75°; top-down keeps 50° since it looks straight down.
export const CAMERA_MODE_FOV = { follow: 58, cinematic: 35, firstperson: 75, topdown: 50 };

const CINEMATIC_ORBIT_SPEED = 0.15; // rad/s — the auto-orbit's angular speed
const CINEMATIC_RADIUS_MULT = 1.8; // × avatar height, scaled further by zoom
const CINEMATIC_HEIGHT_MULT = 0.7; // × avatar height
const FP_EYE_HEIGHT_MULT = 0.9; // fraction of avatar height for the eye position
const TOPDOWN_HEIGHT = 18; // metres straight above the avatar

const TRANSITION_DUR = 0.5; // seconds a mode swap cross-fades over

// Hot-path scratch — computeCameraForMode runs every frame; reuse instead of
// allocating fresh Vector3s per call. The caller must read pos/look before the
// next call (or copy them out) — they're not retained across frames.
const _pos = new Vector3();
const _look = new Vector3();
const _offset = new Vector3();
const _fwd = new Vector3();
const _result = { pos: _pos, look: _look };

/**
 * Pure per-frame camera pose for one mode.
 *
 * @param {string} mode  one of CAMERA_MODES (unknown modes fall back to 'follow')
 * @param {import('three').Vector3} avatarPos  world position (feet/base)
 * @param {number} avatarHeight  metres — drives eye height / cinematic framing
 * @param {{yaw?:number, pitch?:number, dist?:number, cinematicAngle?:number, lookOffsetY?:number}} [orbit]
 *   yaw/pitch/dist are the player's mouse-drag orbit (also the cinematic
 *   distance/zoom multiplier); cinematicAngle is the slow auto-orbit angle in
 *   radians — advance it via the controller's tick(dt) or roll your own.
 * @returns {{pos:import('three').Vector3, look:import('three').Vector3}} shared scratch
 */
export function computeCameraForMode(mode, avatarPos, avatarHeight, orbit = {}) {
	const { yaw = 0, pitch = 0.5, dist = 9, cinematicAngle = 0, lookOffsetY = 1.4 } = orbit;
	const height = avatarHeight || 1.8;
	const pos = _pos, look = _look;
	if (mode === 'cinematic') {
		const r = height * CINEMATIC_RADIUS_MULT * (dist / 9);
		const h = height * CINEMATIC_HEIGHT_MULT;
		pos.set(
			avatarPos.x + Math.cos(cinematicAngle) * r,
			avatarPos.y + h + 0.8,
			avatarPos.z + Math.sin(cinematicAngle) * r,
		);
		look.set(avatarPos.x, avatarPos.y + lookOffsetY, avatarPos.z);
	} else if (mode === 'firstperson') {
		const eyeH = height * FP_EYE_HEIGHT_MULT;
		pos.set(avatarPos.x, avatarPos.y + eyeH, avatarPos.z);
		_fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
		look.copy(pos).addScaledVector(_fwd, 5);
		look.y -= 0.15; // slight downward gaze
	} else if (mode === 'topdown') {
		pos.set(avatarPos.x, avatarPos.y + TOPDOWN_HEIGHT, avatarPos.z + 0.01);
		look.set(avatarPos.x, avatarPos.y, avatarPos.z);
	} else {
		// 'follow' (default) — matches /play's original fixed orbit exactly.
		const cp = Math.cos(pitch), sp = Math.sin(pitch);
		_offset.set(Math.sin(yaw) * cp * dist, sp * dist + 1.4, Math.cos(yaw) * cp * dist);
		pos.set(avatarPos.x - _offset.x, avatarPos.y + _offset.y, avatarPos.z - _offset.z);
		look.set(avatarPos.x, avatarPos.y + lookOffsetY, avatarPos.z);
	}
	return _result;
}

/**
 * A small stateful wrapper: current mode (persisted), cycling, first-person
 * avatar-hide hint, and a cross-fade so switching modes glides instead of
 * popping. Callers own the Camera and the avatar visibility toggle.
 *
 * @param {{ storageKey?:string, initialMode?:string, onChange?:(mode:string)=>void }} [opts]
 */
export function createCameraModeController({ storageKey = 'camera-mode', initialMode, onChange } = {}) {
	let mode = CAMERA_MODES.includes(initialMode) ? initialMode : 'follow';
	try {
		const saved = storageKey && localStorage.getItem(storageKey);
		if (saved && CAMERA_MODES.includes(saved)) mode = saved;
	} catch { /* storage blocked (private mode / sandboxed iframe) */ }

	let cinematicAngle = 0;
	let transition = 0; // 0 = settled, >0 = mid cross-fade
	const from = { pos: new Vector3(), fov: CAMERA_MODE_FOV[mode] };
	let toFov = CAMERA_MODE_FOV[mode];

	function setMode(next, camera) {
		if (!CAMERA_MODES.includes(next) || next === mode) return;
		if (camera) { from.pos.copy(camera.position); from.fov = camera.fov; }
		mode = next;
		toFov = CAMERA_MODE_FOV[mode];
		transition = TRANSITION_DUR;
		try { if (storageKey) localStorage.setItem(storageKey, mode); } catch { /* blocked */ }
		onChange?.(mode);
	}

	return {
		get mode() { return mode; },
		isFirstPerson: () => mode === 'firstperson',
		setMode,
		cycle(camera) {
			const idx = CAMERA_MODES.indexOf(mode);
			setMode(CAMERA_MODES[(idx + 1) % CAMERA_MODES.length], camera);
		},
		/** Advance the cinematic auto-orbit and any in-flight mode transition. */
		tick(dt) {
			cinematicAngle += dt * CINEMATIC_ORBIT_SPEED;
			if (transition > 0) transition = Math.max(0, transition - dt);
		},
		/**
		 * Apply this frame's pose to `camera`. `lerpFactor` (0..1] smooths normal
		 * follow (1 = snap, matching /play's original instant-follow feel); a
		 * live mode transition always cross-fades regardless of lerpFactor.
		 */
		apply(camera, avatarPos, avatarHeight, orbit, lerpFactor = 1) {
			const desired = computeCameraForMode(mode, avatarPos, avatarHeight, { ...orbit, cinematicAngle });
			if (transition > 0) {
				const t = 1 - transition / TRANSITION_DUR;
				const ease = t * t * (3 - t * 2);
				camera.position.lerpVectors(from.pos, desired.pos, ease);
				camera.fov = from.fov + (toFov - from.fov) * ease;
			} else if (lerpFactor >= 1) {
				camera.position.copy(desired.pos);
				camera.fov = toFov;
			} else {
				camera.position.lerp(desired.pos, lerpFactor);
				camera.fov = toFov;
			}
			camera.lookAt(desired.look);
			camera.updateProjectionMatrix();
		},
	};
}
