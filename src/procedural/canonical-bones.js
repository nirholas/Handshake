// Resolve canonical bone names to the actual Object3D nodes on a loaded model.
//
// `canonicalNodeMapFromObject` (src/animation-retarget.js) returns canonical →
// bone *name*, which is what the clip retargeter needs because animation tracks
// address bones by name. Procedural layers need the node itself, and the
// obvious way to get there — `model.getObjectByName(name)` — is a trap: it only
// searches descendants of the root, while the canonical map is also built from
// every `SkinnedMesh.skeleton.bones` entry, which need not be parented under
// the model at all.
//
// That is not a rare shape. A GLB whose armature sits beside the mesh rather
// than above it, and clones produced by SkeletonUtils, both hand you a model
// where the skeleton drives the mesh correctly but `getObjectByName` finds
// nothing. Resolving through name lookup made every layer silently report
// `enabled === false` on those rigs — the exact "looks fine, does nothing"
// failure the universal-rig doctrine exists to prevent.
//
// So: index nodes from the same two sources the canonical map is built from,
// and hand back nodes.

import { canonicalizeBoneName } from '../glb-canonicalize.js';

/**
 * Build canonical bone name → live node for a model.
 *
 * Mirrors `canonicalNodeMapFromObject`'s traversal exactly (scene-graph bones
 * first, then every skinned mesh's skeleton) so the two maps always agree on
 * which node a canonical name refers to. First writer wins, matching that
 * function's `if (!map.has(canonical))` rule.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string, import('three').Object3D>}
 */
export function canonicalBoneNodes(root) {
	const map = new Map();
	if (!root) return map;

	const consider = (node) => {
		if (!node?.name) return;
		const canonical = canonicalizeBoneName(node.name);
		if (canonical && !map.has(canonical)) map.set(canonical, node);
	};

	const skinned = [];
	root.traverse((node) => {
		if (node.isSkinnedMesh) skinned.push(node);
		if (node.isBone) consider(node);
	});
	for (const sm of skinned) {
		for (const bone of sm.skeleton?.bones || []) consider(bone);
	}
	return map;
}

/**
 * Resolve the first canonical name that this rig actually has.
 * @param {Map<string, import('three').Object3D>} nodes
 * @param {string[]} candidates canonical names, most preferred first
 * @returns {import('three').Object3D|null}
 */
export function firstCanonical(nodes, candidates) {
	for (const name of candidates) {
		const node = nodes.get(name);
		if (node) return node;
	}
	return null;
}
