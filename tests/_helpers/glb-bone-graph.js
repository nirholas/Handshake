// Test helper: reconstruct a real THREE bone graph from a GLB without GLTFLoader.
//
// The upright-invariant corpus (tests/animation-upright-invariant.test.js) needs
// to run the production retargeter against the committed real avatars (cz.glb,
// michelle.glb) in plain Node — no browser, no Draco/KTX2 decoders, no network.
// GLTFLoader can't run here, but the retargeter and the upright check only need
// the rig's *skeleton*: each bone's name, its local rest TRS, the parent/child
// hierarchy, and which nodes are skin joints. All of that lives in the glTF JSON
// chunk's `nodes[]` + `skins[].joints[]` — the BIN chunk (mesh/animation data) is
// irrelevant. So we parse the JSON chunk (same byte layout as
// api/_lib/glb-inspect.js) and build an Object3D/Bone graph by hand, binding a
// SkinnedMesh to a Skeleton of the joint bones exactly as a GLTFLoader result
// would. canonicalNodeMapFromObject / canonicalRestMapFromObject then read it
// identically to a real loaded model, so what the corpus measures is what ships.

import fs from 'node:fs';
import {
	Bone,
	Object3D,
	PropertyBinding,
	SkinnedMesh,
	Skeleton,
	BufferGeometry,
	Quaternion,
	Vector3,
} from 'three';

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON' little-endian

const _up = Object.freeze(new Vector3(0, 1, 0));

/**
 * Parse the glTF JSON document out of a GLB buffer's first chunk. Mirrors the
 * byte layout asserted in api/_lib/glb-inspect.js and tests/api/lib-glb-inspect:
 * 12-byte header (magic, version 2, length) then a JSON chunk (length, type,
 * bytes). We don't touch the BIN chunk.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {object} the parsed glTF document
 */
export function parseGltfJson(buf) {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB (bad magic)');
	if (view.getUint32(4, true) !== 2) throw new Error('unsupported glTF version (expected 2)');
	const jsonLen = view.getUint32(12, true);
	if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('first chunk is not JSON');
	const start = 20;
	const jsonBytes = buf.subarray(start, start + jsonLen);
	// The chunk is space-padded to a 4-byte boundary, which JSON.parse tolerates.
	return JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
}

/**
 * Build a THREE bone graph from a parsed glTF document. One Object3D-derived
 * Bone per glTF node, with its local rest TRS (from `node.matrix` or
 * translation/rotation/scale), wired into the real parent/child hierarchy, with
 * a SkinnedMesh bound to a Skeleton of the skin's joint bones — so production's
 * canonicalNodeMapFromObject / canonicalRestMapFromObject read it exactly as
 * they read a GLTFLoader scene.
 *
 * @param {object} gltf parsed glTF document (see {@link parseGltfJson})
 * @returns {{ root: Object3D, nodes: Bone[] }}
 */
export function buildBoneGraph(gltf) {
	const gltfNodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
	const nodes = gltfNodes.map((n) => {
		const bone = new Bone();
		// GLTFLoader sanitizes every node name for PropertyBinding compatibility
		// (e.g. Mixamo's "mixamorig:Hips" → "mixamorigHips") before anything else
		// sees it. Mirror that here, or an AnimationMixer bound to this graph
		// silently fails to resolve any colon-named track — a fixture-only failure
		// the production loader never exhibits.
		bone.name = typeof n.name === 'string' ? PropertyBinding.sanitizeNodeName(n.name) : '';
		if (Array.isArray(n.matrix) && n.matrix.length === 16) {
			bone.matrix.fromArray(n.matrix);
			bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
		} else {
			if (Array.isArray(n.translation)) bone.position.fromArray(n.translation);
			if (Array.isArray(n.rotation)) bone.quaternion.fromArray(n.rotation); // [x,y,z,w]
			if (Array.isArray(n.scale)) bone.scale.fromArray(n.scale);
		}
		return bone;
	});

	const isChild = new Set();
	gltfNodes.forEach((n, i) => {
		for (const c of n.children || []) {
			nodes[i].add(nodes[c]);
			isChild.add(c);
		}
	});

	const root = new Object3D();
	root.name = 'GLBRoot';
	gltfNodes.forEach((_, i) => {
		if (!isChild.has(i)) root.add(nodes[i]);
	});

	// Bind a SkinnedMesh to the skin's joints so the production node/rest readers
	// (which prefer SkinnedMesh skeleton bones) resolve the same bones a real
	// GLTFLoader scene would expose.
	const joints = gltf.skins?.[0]?.joints || [];
	const boneArr = joints.map((j) => nodes[j]).filter(Boolean);
	const mesh = new SkinnedMesh(new BufferGeometry());
	mesh.name = 'GLBSkinnedMesh';
	root.add(mesh);
	if (boneArr.length > 0) mesh.bind(new Skeleton(boneArr));

	root.updateMatrixWorld(true);
	return { root, nodes };
}

/**
 * Convenience: read a GLB file from disk and return its reconstructed bone graph.
 *
 * @param {string} path absolute path to a .glb file
 * @returns {{ root: Object3D, nodes: Bone[], gltf: object }}
 */
export function loadBoneGraph(path) {
	const buf = fs.readFileSync(path);
	const gltf = parseGltfJson(buf);
	const { root, nodes } = buildBoneGraph(gltf);
	return { root, nodes, gltf };
}

/**
 * Angle (degrees) between a bone's world up-axis and world vertical (0,1,0). 0°
 * means the bone's local +Y points straight up (upright); ~90° means it's lying
 * down. Requires world matrices to be current for `bone` and its ancestors.
 *
 * @param {Object3D} bone
 * @returns {number} degrees off vertical, in [0, 180]
 */
export function tiltDegrees(bone) {
	const wq = new Quaternion();
	bone.getWorldQuaternion(wq);
	const worldUp = _up.clone().applyQuaternion(wq);
	const dot = Math.max(-1, Math.min(1, worldUp.dot(_up)));
	return (Math.acos(dot) * 180) / Math.PI;
}

// Pick the keyframe value at-or-before `time` from a flat keyframe-track array
// (stepped sampling — sufficient for an at-rest / per-keyframe tilt scan; the
// invariant must hold *at* every authored keyframe, not at interpolated points
// the retargeter never produces).
function sampleAt(track, time, stride) {
	const times = track.times;
	let k = 0;
	while (k < times.length - 1 && times[k + 1] <= time) k++;
	const off = k * stride;
	return track.values.slice(off, off + stride);
}

/**
 * Max tilt (degrees off vertical) of the Hips bone across a retargeted clip's
 * keyframes. Applies the Hips quaternion (and position) at every keyframe time
 * of the Hips tracks, composes world matrices, and measures the world up-axis
 * angle — the world-matrix reconstruction the original lying-down bug was
 * diagnosed with. Returns null when the clip didn't retarget onto this rig
 * (coverage below MIN_COVERAGE) — a rig the library can't drive, NOT a fallen
 * pose, so callers treat it as "skip", never as a failure.
 *
 * @param {Object3D} root reconstructed rig root (world matrices current)
 * @param {string} hipsNodeName the rig's actual Hips node name (from the canonical map)
 * @param {import('three').AnimationClip|null} retargetedClip
 * @returns {{ max: number, atKeyframe0: number, samples: number }|null}
 */
export function hipsTiltAcrossClip(root, hipsNodeName, retargetedClip) {
	if (!retargetedClip) return null;
	const hips = root.getObjectByName(hipsNodeName);
	if (!hips) return null;
	const qTrack = retargetedClip.tracks.find((t) => t.name === `${hipsNodeName}.quaternion`);
	const pTrack = retargetedClip.tracks.find((t) => t.name === `${hipsNodeName}.position`);
	if (!qTrack) return null;

	const times = new Set(qTrack.times);
	if (pTrack) for (const t of pTrack.times) times.add(t);
	const sorted = [...times].sort((a, b) => a - b);

	const restQ = hips.quaternion.clone();
	const restP = hips.position.clone();

	let max = 0;
	let atKeyframe0 = 0;
	let samples = 0;
	for (const time of sorted) {
		const qv = sampleAt(qTrack, time, 4);
		hips.quaternion.set(qv[0], qv[1], qv[2], qv[3]);
		if (pTrack) {
			const pv = sampleAt(pTrack, time, 3);
			hips.position.set(pv[0], pv[1], pv[2]);
		}
		root.updateMatrixWorld(true);
		const tilt = tiltDegrees(hips);
		if (samples === 0) atKeyframe0 = tilt;
		if (tilt > max) max = tilt;
		samples++;
	}

	// Restore the rig's authored bind pose so a reused root measures cleanly.
	hips.quaternion.copy(restQ);
	hips.position.copy(restP);
	root.updateMatrixWorld(true);

	return { max, atKeyframe0, samples };
}
