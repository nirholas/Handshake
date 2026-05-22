/**
 * Camera framing presets for avatar rendering.
 *
 * Pure math — no three.js imports — so the framing logic is unit-testable in
 * isolation. TalkScene passes the result through `camera.position.set(...)` +
 * `controls.target.set(...)` + `camera.fov = ...`.
 *
 * All inputs/outputs use plain `{ x, y, z }` triplets (not THREE.Vector3) so
 * this module is portable to any renderer that consumes a position/target
 * pair: three.js, Babylon.js, model-viewer (for `camera-orbit` calcs), etc.
 *
 * Presets:
 *
 *   full     — entire avatar in frame, current default. Good for the
 *              customizer where the user is picking outfits / shoes.
 *
 *   half     — upper torso + head, conversational. Default for Talk mode
 *              because face-to-face is the dominant interaction.
 *
 *   headshot — head + neck, intimate. Good for voice-clone QA and for
 *              "your avatar said …" share cards.
 */

export const CAMERA_PRESETS = ['full', 'half', 'headshot'];

/**
 * Compute camera framing for a loaded avatar.
 *
 * @param {object} opts
 * @param {{ min: {x,y,z}, max: {x,y,z} }} opts.box  — axis-aligned bounding box of the avatar root
 * @param {'full'|'half'|'headshot'} [opts.preset='full']
 * @param {number} [opts.aspectRatio=1]  — viewport w/h; tighter aspects pull
 *                                          the camera back to keep the subject
 *                                          in frame
 * @returns {{ target: {x,y,z}, position: {x,y,z}, fov: number }}
 */
export function computeFraming({ box, preset = 'full', aspectRatio = 1 } = {}) {
	if (!box || !box.min || !box.max) {
		throw new Error('computeFraming: box with {min,max} required');
	}
	if (!CAMERA_PRESETS.includes(preset)) {
		throw new Error(`computeFraming: unknown preset "${preset}"`);
	}

	const size = {
		x: box.max.x - box.min.x,
		y: box.max.y - box.min.y,
		z: box.max.z - box.min.z,
	};
	const center = {
		x: (box.max.x + box.min.x) / 2,
		y: (box.max.y + box.min.y) / 2,
		z: (box.max.z + box.min.z) / 2,
	};

	// Treat avatar height as the dominant dimension. Most humanoid GLBs sit
	// taller than wide; a few stylized assets (chibi, mascot) are roughly
	// equal — we fall back to max(x, y) for those.
	const height = Math.max(size.y, size.x);

	const cfg = PRESET_CONFIG[preset];

	// Vertical aim: a fraction of the way *up* from the avatar's bottom.
	// 0.5 = mid-torso, 0.65 = chest, 0.85 = head, 1.0 = top of head.
	const targetY = box.min.y + height * cfg.targetFrac;

	// Distance back from the subject — scales with avatar height, then backs
	// off further on narrow viewports so a T-pose silhouette still fits
	// horizontally. Wider-than-tall viewports never need that extra nudge.
	const aspectBackoff = Math.max(1, 1 / aspectRatio);
	const distance = Math.max(cfg.minDistance, height * cfg.distanceMul * aspectBackoff);

	// Camera height: slightly above target so the look-vector slopes very
	// gently downward. Avoids the up-the-nose angle when the avatar is short.
	const camY = targetY + height * cfg.cameraHeightOffsetMul;

	return {
		target: { x: center.x, y: targetY, z: center.z },
		position: { x: center.x, y: camY, z: center.z + distance },
		fov: cfg.fov,
	};
}

const PRESET_CONFIG = {
	full: {
		targetFrac: 0.55,
		distanceMul: 1.05,
		minDistance: 0.7,
		cameraHeightOffsetMul: 0.05,
		fov: 35,
	},
	half: {
		// Aim at sternum-height; pull in to ~70% of avatar height.
		targetFrac: 0.78,
		distanceMul: 0.75,
		minDistance: 0.55,
		cameraHeightOffsetMul: 0.02,
		// Slightly tighter FOV reads more "portrait" / "video call".
		fov: 32,
	},
	headshot: {
		// Aim near the face.
		targetFrac: 0.92,
		distanceMul: 0.45,
		minDistance: 0.35,
		cameraHeightOffsetMul: 0.0,
		fov: 28,
	},
};

/**
 * Cycle to the next preset in display order. Useful for a one-button
 * "change framing" toggle.
 */
export function nextPreset(current) {
	const idx = CAMERA_PRESETS.indexOf(current);
	if (idx < 0) return CAMERA_PRESETS[0];
	return CAMERA_PRESETS[(idx + 1) % CAMERA_PRESETS.length];
}

export const PRESET_LABELS = {
	full: 'Full body',
	half: 'Half body',
	headshot: 'Headshot',
};
