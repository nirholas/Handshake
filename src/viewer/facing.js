// Which way is the avatar looking? Pure geometry plus a scene-graph probe, kept
// out of viewer.js so both framing paths (setContent's first frame and
// frameContent's re-frame) can agree and so the math is unit-testable without a
// WebGL context.
//
// The viewer used to place the camera on +Z unconditionally and describe that as
// "front-on". That only holds for rigs authored facing +Z. glTF characters
// arrive facing every axis (Mixamo and Unreal exports commonly face -Z, VRM
// faces +Z), so a large share of avatars opened showing the viewer their back.
// Reading the facing off the rig fixes that for every avatar at once, with no
// per-model metadata and no allowlist.

import { canonicalizeBoneName } from '../glb-canonicalize.js';

/**
 * Bone pairs that span the body left-to-right, best first. Shoulders barely
 * move in an idle clip, so they give a steadier read than hands or feet.
 * Names are canonical (see CANONICAL_BONES in ../glb-canonicalize.js).
 */
const SPAN_PAIRS = [
	['LeftShoulder', 'RightShoulder'],
	['LeftArm', 'RightArm'],
	['LeftUpLeg', 'RightUpLeg'],
];

/**
 * Yaw of the direction a body faces, from the horizontal span between its left
 * and right side.
 *
 * With Y up, the character's right vector r and forward f satisfy f = up x r,
 * so f = (r.z, 0, -r.x). Yaw is measured from +Z, the axis the camera has
 * always sat on, which makes 0 the exact legacy behaviour.
 *
 * @param {number} dx  world x of (right landmark - left landmark)
 * @param {number} dz  world z of (right landmark - left landmark)
 * @param {number} [minSpan=0]  reject spans shorter than this (world units)
 * @returns {number|null} yaw in radians, or null when the span is degenerate
 */
export function yawFromRightSpan(dx, dz, minSpan = 0) {
	if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
	if (Math.hypot(dx, dz) <= Math.max(minSpan, 0)) return null;
	return Math.atan2(dz, -dx);
}

/**
 * Unit forward vector for a yaw, in the horizontal plane.
 * @param {number} yaw radians, measured from +Z
 * @returns {{x:number, z:number}}
 */
export function forwardFromYaw(yaw) {
	return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/**
 * Width of an axis-aligned bounding box as seen from a camera at `yaw`.
 *
 * Camera distance is driven partly by how wide the subject is on screen, and
 * that width is the box projected onto the camera's right vector
 * (cos(yaw), 0, -sin(yaw)). At yaw 0 this returns sizeX, so a +Z-facing avatar
 * is framed exactly as before; a side-facing one is now measured across its
 * depth instead of being framed against the wrong axis.
 *
 * @param {number} sizeX bounding-box size on x
 * @param {number} sizeZ bounding-box size on z
 * @param {number} yaw radians
 * @returns {number}
 */
export function horizontalExtentAt(sizeX, sizeZ, yaw) {
	return Math.abs(Math.cos(yaw)) * sizeX + Math.abs(Math.sin(yaw)) * sizeZ;
}

/**
 * Read the facing yaw off a loaded model's rig.
 *
 * Walks the graph once for the best available left/right bone pair and measures
 * the span between their world positions. World translation is read straight
 * out of matrixWorld, so this needs no THREE import and can be tested with
 * plain objects; call it after the world matrices are up to date (Box3's
 * setFromObject does that, and both framing paths compute a box first).
 *
 * @param {{traverse:Function}} root loaded model root
 * @param {number} [bodyHeight=0] bounding-box height, used to reject a
 *   degenerate span (a rig collapsed onto its own centre line)
 * @returns {number|null} yaw in radians, or null when the rig cannot say
 */
export function estimateFacingYaw(root, bodyHeight = 0) {
	if (!root || typeof root.traverse !== 'function') return null;

	const found = new Map();
	root.traverse((node) => {
		if (!node?.isBone || typeof node.name !== 'string') return;
		const canonical = canonicalizeBoneName(node.name);
		if (!canonical || found.has(canonical)) return;
		const e = node.matrixWorld?.elements;
		if (!e) return;
		found.set(canonical, { x: e[12], z: e[14] });
	});

	// A body collapsed to a line has no readable facing; 4% of height is well
	// under any real shoulder span and well over floating-point noise.
	const minSpan = bodyHeight * 0.04;
	for (const [left, right] of SPAN_PAIRS) {
		const l = found.get(left);
		const r = found.get(right);
		if (!l || !r) continue;
		const yaw = yawFromRightSpan(r.x - l.x, r.z - l.z, minSpan);
		if (yaw !== null) return yaw;
	}
	return null;
}
