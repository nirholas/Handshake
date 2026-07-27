/**
 * recenter-hips.mjs: remove a constant Hips translation offset from a baked clip.
 *
 * Companion to `upright-hips.mjs`, which removes a constant *orientation* bias.
 * This module removes the constant *translation* bias that shows up in the same
 * class of source: a rig round-tripped through Blender or glTF-Transform, where
 * the armature's own transform is baked down onto the Hips track instead of
 * staying on a parent node.
 *
 * The retarget pipeline copies the Hips position track verbatim onto a canonical
 * (identity-rest) rig, so a baked armature offset is no longer cancelled by a
 * parent and the character stands permanently displaced from the origin. The
 * `Offabean Dance` source lands ~1.5 m behind it and ~0.16 m above the rig's
 * standing hip height, which reads as an avatar floating off its mark and out of
 * frame. Every healthy clip in the library instead begins within a few
 * centimetres of the reference rig's rest Hips and travels away from there.
 *
 * The fix anchors the clip's FIRST frame to the reference rig's rest Hips and
 * shifts every keyframe by that single constant. Anchoring on the first frame
 * (rather than the mean) is what preserves authored root motion: a clip that
 * walks 4 m forward still walks 4 m forward, it just starts on its mark. Only a
 * constant is subtracted, so the internal pose and all relative motion are
 * untouched.
 *
 * Opt-in per source via `recenterHips` in animations.config.json, for the same
 * reason `uprightFix` is opt-in: a clip authored to start off-origin (walking
 * into frame) must never be silently dragged onto the mark. The function is
 * self-gating regardless: an offset already within tolerance returns unchanged,
 * so applying it twice, or to a healthy clip, is a no-op.
 *
 * Operates on the three.js `AnimationClip.toJSON()` shape (`{ tracks: [{ name,
 * type, times, values }] }`) so the same routine corrects the build output and
 * repairs already-committed clip JSON.
 */

// Distance (metres) between the clip's first-frame Hips and the rig's rest Hips
// below which the clip is treated as already on its mark. The library's healthy
// clips sit well under this; a baked armature offset lands at ~1.5 m.
const OFFSET_THRESHOLD_M = 0.15;

function findTrack(clipJson, suffix) {
	return (clipJson.tracks || []).find(
		(t) => typeof t.name === 'string' && t.name.endsWith(suffix),
	);
}

/**
 * Shift a clip's Hips position track so its first frame sits at the reference
 * rig's rest Hips. Mutates the Hips position track values in place.
 *
 * @param {{ tracks: Array<{ name: string, type?: string, times: number[], values: number[] }> }} clipJson
 * @param {[number, number, number]} restHips Reference rig's rest Hips position.
 * @returns {{ changed: boolean, offset: [number, number, number], distance: number, reason?: string }}
 */
export function recenterHips(clipJson, restHips) {
	const pos = findTrack(clipJson, 'Hips.position');
	if (!pos || !pos.values || pos.values.length < 3) {
		return { changed: false, offset: [0, 0, 0], distance: 0, reason: 'no-hips-position' };
	}
	if (!Array.isArray(restHips) || restHips.length < 3) {
		return { changed: false, offset: [0, 0, 0], distance: 0, reason: 'no-rest-pose' };
	}

	const p = pos.values;
	const offset = [p[0] - restHips[0], p[1] - restHips[1], p[2] - restHips[2]];
	const distance = Math.hypot(offset[0], offset[1], offset[2]);

	// Self-gate: a clip already starting on its mark carries no offset to remove.
	if (distance <= OFFSET_THRESHOLD_M) {
		return { changed: false, offset, distance, reason: 'already-centered' };
	}

	for (let i = 0; i + 2 < p.length; i += 3) {
		p[i] -= offset[0];
		p[i + 1] -= offset[1];
		p[i + 2] -= offset[2];
	}

	return { changed: true, offset, distance };
}

export { OFFSET_THRESHOLD_M };
