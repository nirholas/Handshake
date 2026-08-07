// Bind-pose neutralisation before a GLB export.
//
// GLTFExporter writes each bone's *current* local transform as the exported
// file's rest pose. Anything the mixer was playing at the moment of export is
// therefore frozen into the saved asset permanently, and because a Studio export
// carries no animation clips, every later viewer renders that one frame forever.
//
// Avatars saved that way came out visibly wrong: measured against the base body
// they were built from, the hands sat at 43% of their bind distance from the hips
// (arms tucked in), and left/right asymmetry was ~20x the base's. A hand-authored
// rest pose is symmetric; an animation frame is not, which is what gave it away.
//
// The fix is to reset every skeleton to the pose its own inverse bind matrices
// describe, immediately before the export reads the graph. That is the neutral
// the mesh was skinned against, so the saved asset is the one the rig author
// intended: symmetric, deterministic across saves, and a correct starting point
// for retargeting, garment binding, and any other engine that assumes a bind pose.
//
// Callers restore the live scene afterwards (Studio replays its idle), so this
// only ever affects the bytes that get written, never what the user is looking at.
//
// Pure module (three only) so it unit-tests in Node.

/**
 * Reset every skeleton under `root` to its bind pose.
 *
 * `Skeleton.pose()` rebuilds each bone's local transform from the inverse bind
 * matrices, so this is exact rather than an approximation, and it is a no-op on
 * a skeleton already at bind. World matrices are refreshed afterwards because
 * GLTFExporter reads the graph without ticking a render loop first.
 *
 * @param {import('three').Object3D} root scene graph to neutralise, mutated in place
 * @returns {number} how many distinct skeletons were reset
 */
export function poseSkeletonsToBind(root) {
	if (!root?.traverse) return 0;

	const seen = new Set();
	root.traverse((obj) => {
		const skeleton = obj?.isSkinnedMesh ? obj.skeleton : null;
		// One skeleton is typically shared by several primitives (body, eyes,
		// teeth, tongue); posing it once per mesh would be wasted work.
		if (!skeleton?.bones?.length || seen.has(skeleton)) return;
		// A skeleton whose bone count and inverse-bind count disagree is malformed;
		// pose() would read past the end of boneInverses and corrupt the rig.
		if (skeleton.boneInverses?.length !== skeleton.bones.length) return;
		seen.add(skeleton);
		skeleton.pose();
	});

	if (seen.size > 0) root.updateMatrixWorld(true);
	return seen.size;
}

/**
 * Snapshot the local transform of every bone under `root`.
 *
 * Paired with {@link restoreBoneTransforms} so a caller can neutralise for an
 * export and put the live scene back exactly as it was, without waiting for a
 * clip to re-drive the rig.
 *
 * @param {import('three').Object3D} root
 * @returns {Array<{bone: import('three').Bone, position: number[], quaternion: number[], scale: number[]}>}
 */
export function captureBoneTransforms(root) {
	const saved = [];
	if (!root?.traverse) return saved;
	root.traverse((obj) => {
		if (!obj?.isBone) return;
		saved.push({
			bone: obj,
			position: obj.position.toArray(),
			quaternion: obj.quaternion.toArray(),
			scale: obj.scale.toArray(),
		});
	});
	return saved;
}

/**
 * Restore transforms captured by {@link captureBoneTransforms}.
 *
 * @param {ReturnType<typeof captureBoneTransforms>} saved
 * @param {import('three').Object3D} [root] refreshed once at the end when given
 * @returns {number} how many bones were restored
 */
export function restoreBoneTransforms(saved, root = null) {
	if (!Array.isArray(saved)) return 0;
	for (const entry of saved) {
		const bone = entry?.bone;
		if (!bone) continue;
		bone.position.fromArray(entry.position);
		bone.quaternion.fromArray(entry.quaternion);
		bone.scale.fromArray(entry.scale);
	}
	if (root?.updateMatrixWorld && saved.length > 0) root.updateMatrixWorld(true);
	return saved.length;
}
