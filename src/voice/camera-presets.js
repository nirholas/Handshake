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

	// Distance back from the subject. The heuristic term scales with avatar
	// height and backs off further on narrow viewports so a T-pose silhouette
	// still fits horizontally; wider-than-tall viewports never need that nudge.
	const aspectBackoff = Math.max(1, 1 / aspectRatio);
	const heuristic = height * cfg.distanceMul * aspectBackoff;

	// ...but a multiplier alone cannot promise that the preset's subject is
	// actually inside the frustum: `full` at 35 deg FOV and 1.05x height showed
	// barely two thirds of a humanoid, so the head and the feet were cropped in
	// the avatar studio. Solve the projection instead. `coverFrac` is the share
	// of the avatar's height the preset must keep in frame and `coverWidthFrac`
	// the share of its width (a full-body shot has to clear the arms; a headshot
	// only the skull), both padded so the silhouette never kisses the edge.
	const halfFovY = (cfg.fov * Math.PI) / 360;
	const pad = 1 + cfg.padding;
	const fitForHeight = (height * cfg.coverFrac * pad) / 2 / Math.tan(halfFovY);
	const halfFovX = Math.atan(Math.tan(halfFovY) * aspectRatio);
	const fitForWidth = (size.x * cfg.coverWidthFrac * pad) / 2 / Math.tan(halfFovX);

	// Measured from the box centre, so half the depth is inside the body: add it
	// back or a deep subject (a cape, a backpack) eats into the clearance.
	const distance = Math.max(cfg.minDistance, heuristic, fitForHeight, fitForWidth) + size.z / 2;

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
		// Aim at the vertical middle so the whole silhouette is centred: the
		// framing below keeps head-to-toe in frame, and an off-centre target
		// would spend that headroom on one end.
		targetFrac: 0.5,
		distanceMul: 1.05,
		minDistance: 0.7,
		cameraHeightOffsetMul: 0.05,
		fov: 35,
		// Head to toe, arms included.
		coverFrac: 1,
		coverWidthFrac: 1,
		padding: 0.1,
	},
	half: {
		// Aim at sternum-height; pull in to ~70% of avatar height.
		targetFrac: 0.78,
		distanceMul: 0.75,
		minDistance: 0.55,
		cameraHeightOffsetMul: 0.02,
		// Slightly tighter FOV reads more "portrait" / "video call".
		fov: 32,
		// Upper torso + head: a little under half the body, shoulders wide.
		coverFrac: 0.44,
		coverWidthFrac: 0.9,
		padding: 0.06,
	},
	headshot: {
		// Aim near the face.
		targetFrac: 0.92,
		distanceMul: 0.45,
		minDistance: 0.35,
		cameraHeightOffsetMul: 0.0,
		fov: 28,
		// Head + neck only, so the arms are deliberately out of frame.
		coverFrac: 0.23,
		coverWidthFrac: 0.45,
		padding: 0.06,
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
