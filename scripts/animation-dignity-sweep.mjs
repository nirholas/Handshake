#!/usr/bin/env node
// Animation dignity sweep. It proves the "no rig allowlist" claim in CLAUDE.md by
// driving the real idle + walk clips onto ten differently-named humanoid rigs and
// MEASURING that both arms and both legs actually move.
//
// Why this exists: `src/glb-canonicalize.js` claims to canonicalize every common
// bone-naming convention, and `src/animation-retarget.js` claims a canonical clip
// then plays on the result. Until now nothing checked the second half. A rig can
// map its Hips and still animate as a torso with four frozen sticks attached, and
// every existing test would stay green because none of them look at motion.
//
// What it measures, per rig, per clip:
//   • retarget coverage (the gate `animation-retarget.js` applies at MIN_COVERAGE),
//   • per-limb LOCAL rotation swing, in degrees, across the clip's keyframes,
//   • end-effector WORLD travel (hands, feet), in hip-heights, by applying every
//     retargeted keyframe to a real three.js bone graph and composing world
//     matrices. This is the honest test: a bone can be name-mapped and still not
//     move its limb if its parent chain broke, and world travel catches that.
//   • whether the clip's LeftArm/RightArm track landed on the upper arm rather
//     than the clavicle (the "arm swings from the shoulder blade" failure).
//
// It runs each rig down BOTH production paths:
//   ingest:  canonicalizeGLBBones() first (what every stored avatar goes through:
//             api/_lib/auto-rig.js, api/_lib/reconstruct-finalize.js,
//             api/avatars/_actions.js), then retarget on the canonical names.
//   runtime: retarget straight onto the raw rig names, the path a GLB loaded
//             directly into the viewer takes.
// Both must pass. A convention that only survives one of them is reported, not
// hidden.
//
// Usage:
//   node scripts/animation-dignity-sweep.mjs            # per-rig report, exit 0/1
//   node scripts/animation-dignity-sweep.mjs --json     # machine-readable
//   node scripts/animation-dignity-sweep.mjs --verbose  # per-limb numbers

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationClip, Quaternion, Vector3 } from 'three';

import { canonicalizeGLBBones, canonicalizeBoneName } from '../src/glb-canonicalize.js';
import {
	MIN_COVERAGE,
	canonicalNodeMapFromObject,
	retargetClipToObject,
} from '../src/animation-retarget.js';
import { parseGltfJson, buildBoneGraph } from '../tests/_helpers/glb-bone-graph.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIP_DIR = path.join(REPO, 'public/animations/clips');

// The two clips the dignity bar is written against: a standing performance and a
// locomotion cycle. Both are in the shipped library, both are baked from cz.glb.
const CLIPS = ['idle', 'walk'];

// ---------------------------------------------------------------------------
// Pass thresholds
// ---------------------------------------------------------------------------
// A limb "moves" when its local rotation swings past this across the clip. Idle
// is a breathing loop, so its arms travel a few degrees, not tens; walk swings
// the whole chain. Set per clip so idle can't be passed by a rig that only walks
// and walk can't be passed by a rig that only breathes.
const MIN_LIMB_SWING_DEG = { idle: 1.5, walk: 8 };
// End-effector world travel, in hip-heights. Catches a mapped bone whose parent
// chain is broken: the rotation track is there, the hand still doesn't go
// anywhere. Idle's hands drift; walk's hands and feet sweep.
const MIN_EFFECTOR_TRAVEL = { idle: 0.01, walk: 0.08 };

// The four limb roots whose motion is non-negotiable, with the end effector each
// one has to carry through space.
const LIMBS = [
	{ label: 'left arm', chain: ['LeftArm', 'LeftForeArm'], effector: 'LeftHand' },
	{ label: 'right arm', chain: ['RightArm', 'RightForeArm'], effector: 'RightHand' },
	{ label: 'left leg', chain: ['LeftUpLeg', 'LeftLeg'], effector: 'LeftFoot' },
	{ label: 'right leg', chain: ['RightUpLeg', 'RightLeg'], effector: 'RightFoot' },
];

// ---------------------------------------------------------------------------
// Skeleton template: one plausible adult humanoid, in metres, Y up, T-pose.
// Every convention below is this same skeleton with its bones renamed, so a
// difference in the results is a difference in NAMING, never in proportions.
// ---------------------------------------------------------------------------
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/** @returns {Array<{ bone: string, parent: string|null, t: [number,number,number] }>} */
function skeletonTemplate() {
	const rows = [
		{ bone: 'Hips', parent: null, t: [0, 0.95, 0] },
		{ bone: 'Spine', parent: 'Hips', t: [0, 0.1, 0] },
		{ bone: 'Spine1', parent: 'Spine', t: [0, 0.12, 0] },
		{ bone: 'Spine2', parent: 'Spine1', t: [0, 0.12, 0] },
		{ bone: 'Neck', parent: 'Spine2', t: [0, 0.13, 0] },
		{ bone: 'Head', parent: 'Neck', t: [0, 0.1, 0] },
	];
	for (const side of ['Left', 'Right']) {
		const sx = side === 'Left' ? 1 : -1;
		rows.push({ bone: `${side}Shoulder`, parent: 'Spine2', t: [0.04 * sx, 0.1, 0] });
		rows.push({ bone: `${side}Arm`, parent: `${side}Shoulder`, t: [0.13 * sx, 0, 0] });
		rows.push({ bone: `${side}ForeArm`, parent: `${side}Arm`, t: [0.28 * sx, 0, 0] });
		rows.push({ bone: `${side}Hand`, parent: `${side}ForeArm`, t: [0.26 * sx, 0, 0] });
		// Five finger chains of three phalanges, splayed across the palm.
		FINGERS.forEach((finger, i) => {
			const spread = (i - 2) * 0.018;
			const isThumb = finger === 'Thumb';
			rows.push({
				bone: `${side}Hand${finger}1`,
				parent: `${side}Hand`,
				t: [0.04 * sx, spread, isThumb ? 0.02 * sx : 0],
			});
			rows.push({ bone: `${side}Hand${finger}2`, parent: `${side}Hand${finger}1`, t: [0.035 * sx, 0, 0] });
			rows.push({ bone: `${side}Hand${finger}3`, parent: `${side}Hand${finger}2`, t: [0.028 * sx, 0, 0] });
		});
		rows.push({ bone: `${side}UpLeg`, parent: 'Hips', t: [0.09 * sx, -0.06, 0] });
		rows.push({ bone: `${side}Leg`, parent: `${side}UpLeg`, t: [0, -0.42, 0] });
		rows.push({ bone: `${side}Foot`, parent: `${side}Leg`, t: [0, -0.4, 0] });
		rows.push({ bone: `${side}ToeBase`, parent: `${side}Foot`, t: [0, -0.07, 0.13] });
	}
	return rows;
}

const TEMPLATE = skeletonTemplate();

// ---------------------------------------------------------------------------
// The ten naming conventions. Each is a function canonical bone -> that rig's
// spelling, or null when the convention genuinely has no such bone (a simple rig
// with no upper chest, a scan rig with no toes). Omitted bones are dropped from
// the rig and their children reparent to the nearest surviving ancestor, exactly
// as a real export of that skeleton would.
// ---------------------------------------------------------------------------
const sideWord = (b) => (b.startsWith('Left') ? 'Left' : b.startsWith('Right') ? 'Right' : null);
const stem = (b) => b.replace(/^(Left|Right)/, '');
const lower = (b) => (b.startsWith('Left') ? 'l' : 'r');
const upperSide = (b) => (b.startsWith('Left') ? 'L' : 'R');
// Finger + phalanx index out of a canonical finger bone, e.g. LeftHandIndex2.
function fingerParts(bone) {
	const m = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/.exec(bone);
	return m ? { side: m[1], finger: m[2], n: Number(m[3]) } : null;
}

const CONVENTIONS = [
	{
		id: 'mixamo',
		label: 'Mixamo',
		note: 'the reference export from mixamo.com and every Adobe/Fuse pipeline',
		name: (b) => `mixamorig:${b}`,
	},
	{
		id: 'avaturn',
		label: 'Avaturn / Ready Player Me',
		note: 'canonical spelling, no vendor prefix, the rig the clip library was baked against',
		name: (b) => b,
	},
	{
		id: 'unreal',
		label: 'Unreal mannequin',
		note: 'UE4/UE5 SK_Mannequin: pelvis, clavicle_l, upperarm_l, thigh_l, index_01_l',
		name: (b) => {
			const f = fingerParts(b);
			if (f) return `${f.finger.toLowerCase()}_0${f.n}_${f.side === 'Left' ? 'l' : 'r'}`;
			const s = sideWord(b) ? (sideWord(b) === 'Left' ? '_l' : '_r') : '';
			const map = {
				Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03',
				Neck: 'neck_01', Head: 'head',
				Shoulder: `clavicle${s}`, Arm: `upperarm${s}`, ForeArm: `lowerarm${s}`, Hand: `hand${s}`,
				UpLeg: `thigh${s}`, Leg: `calf${s}`, Foot: `foot${s}`, ToeBase: `ball${s}`,
			};
			return map[stem(b)] ?? null;
		},
	},
	{
		id: 'vrm0',
		label: 'VRM 0.x / VRoid',
		note: 'VRoid Studio export: J_Bip_C_Hips, J_Bip_L_UpperArm, J_Bip_L_Little1',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				const vf = f.finger === 'Pinky' ? 'Little' : f.finger;
				return `J_Bip_${f.side === 'Left' ? 'L' : 'R'}_${vf}${f.n}`;
			}
			const sd = sideWord(b) === 'Left' ? 'L' : 'R';
			const centre = {
				Hips: 'J_Bip_C_Hips', Spine: 'J_Bip_C_Spine', Spine1: 'J_Bip_C_Chest',
				Spine2: 'J_Bip_C_UpperChest', Neck: 'J_Bip_C_Neck', Head: 'J_Bip_C_Head',
			};
			if (centre[b]) return centre[b];
			const limb = {
				Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand',
				UpLeg: 'UpperLeg', Leg: 'LowerLeg', Foot: 'Foot', ToeBase: 'ToeBase',
			};
			return limb[stem(b)] ? `J_Bip_${sd}_${limb[stem(b)]}` : null;
		},
	},
	{
		id: 'vrm1',
		label: 'VRM 1.0',
		note: 'the 1.0 humanoid spec: leftUpperArm, leftToes, leftIndexProximal',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				const vf = f.finger === 'Pinky' ? 'Little' : f.finger;
				const phalanx =
					f.finger === 'Thumb'
						? ['Metacarpal', 'Proximal', 'Distal'][f.n - 1]
						: ['Proximal', 'Intermediate', 'Distal'][f.n - 1];
				return `${f.side.toLowerCase()}${vf}${phalanx}`;
			}
			const centre = {
				Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest',
				Neck: 'neck', Head: 'head',
			};
			if (centre[b]) return centre[b];
			const limb = {
				Shoulder: 'Shoulder', Arm: 'UpperArm', ForeArm: 'LowerArm', Hand: 'Hand',
				UpLeg: 'UpperLeg', Leg: 'LowerLeg', Foot: 'Foot', ToeBase: 'Toes',
			};
			const side = sideWord(b) === 'Left' ? 'left' : 'right';
			return limb[stem(b)] ? `${side}${limb[stem(b)]}` : null;
		},
	},
	{
		id: 'daz',
		label: 'Daz / Genesis 8',
		note: 'Genesis figure rig: hip, abdomenUpper, lShldrBend, lThighBend, lIndex1',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				const df = f.finger === 'Middle' ? 'Mid' : f.finger;
				return `${f.side === 'Left' ? 'l' : 'r'}${df}${f.n}`;
			}
			const centre = {
				Hips: 'hip', Spine: 'abdomenLower', Spine1: 'abdomenUpper', Spine2: 'chestUpper',
				Neck: 'neckLower', Head: 'head',
			};
			if (centre[b]) return centre[b];
			const limb = {
				Shoulder: 'Collar', Arm: 'ShldrBend', ForeArm: 'ForearmBend', Hand: 'Hand',
				UpLeg: 'ThighBend', Leg: 'Shin', Foot: 'Foot', ToeBase: 'Toe',
			};
			return limb[stem(b)] ? `${lower(b)}${limb[stem(b)]}` : null;
		},
	},
	{
		id: 'makehuman',
		label: 'MakeHuman',
		note: 'anatomical stems with a .L/.R side suffix: clavicle.L, upperarm.L, shin.L, finger2-1.L',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				// MakeHuman numbers the digits 1..5 from the thumb.
				const idx = FINGERS.indexOf(f.finger) + 1;
				return `finger${idx}-${f.n}.${upperSide(b)}`;
			}
			const centre = { Hips: 'pelvis', Spine: 'spine', Spine1: 'chest', Neck: 'neck', Head: 'head' };
			if (centre[b]) return centre[b];
			if (b === 'Spine2') return null; // MakeHuman's default rig has no upper chest
			const limb = {
				Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'forearm', Hand: 'hand',
				UpLeg: 'thigh', Leg: 'shin', Foot: 'foot', ToeBase: 'toe',
			};
			return limb[stem(b)] ? `${limb[stem(b)]}.${upperSide(b)}` : null;
		},
	},
	{
		id: 'blender-rigify',
		label: 'Blender / Rigify (.L suffix)',
		note: 'the Blender human meta-rig: shoulder.L (clavicle) + upper_arm.L, f_index.01.L, thumb.01.L',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				const side = upperSide(b);
				return f.finger === 'Thumb'
					? `thumb.0${f.n}.${side}`
					: `f_${f.finger.toLowerCase()}.0${f.n}.${side}`;
			}
			const centre = { Hips: 'hips', Spine: 'spine', Spine1: 'chest', Neck: 'neck', Head: 'head' };
			if (centre[b]) return centre[b];
			if (b === 'Spine2') return null;
			const limb = {
				Shoulder: 'shoulder', Arm: 'upper_arm', ForeArm: 'forearm', Hand: 'hand',
				UpLeg: 'thigh', Leg: 'shin', Foot: 'foot', ToeBase: 'toe',
			};
			return limb[stem(b)] ? `${limb[stem(b)]}.${upperSide(b)}` : null;
		},
	},
	{
		id: 'simple',
		label: 'Simple shoulderL rig',
		note: 'the hand-built / hobby rig: chest, shoulderL, elbowL, wristL, hipL, kneeL, ankleL',
		name: (b) => {
			const f = fingerParts(b);
			if (f) return `${f.finger.toLowerCase()}${f.n}${upperSide(b)}`;
			const centre = { Hips: 'hips', Spine: 'waist', Spine1: 'chest', Neck: 'neck', Head: 'head' };
			if (centre[b]) return centre[b];
			if (b === 'Spine2') return null;
			if (stem(b) === 'Shoulder') return null; // no clavicle on a simple rig
			const limb = {
				Arm: 'shoulder', ForeArm: 'elbow', Hand: 'wrist',
				UpLeg: 'hip', Leg: 'knee', Foot: 'ankle', ToeBase: 'toe',
			};
			return limb[stem(b)] ? `${limb[stem(b)]}${upperSide(b)}` : null;
		},
	},
	{
		id: 'anatomical',
		label: 'Anatomical Latin (novel)',
		note:
			'the convention the canonicalizer has never seen: scan/anatomy-kit rigs named for the ' +
			'bones themselves: humerus.L, ulna.L, femur.L, tibia.L, index_proximal.L',
		name: (b) => {
			const f = fingerParts(b);
			if (f) {
				const af = f.finger === 'Pinky' ? 'little' : f.finger.toLowerCase();
				const phalanx =
					f.finger === 'Thumb'
						? ['metacarpal', 'proximal', 'distal'][f.n - 1]
						: ['proximal', 'intermediate', 'distal'][f.n - 1];
				return `${af}_${phalanx}.${upperSide(b)}`;
			}
			const centre = {
				Hips: 'pelvis', Spine: 'lumbar', Spine1: 'thoracic', Spine2: 'sternum',
				Neck: 'cervical', Head: 'cranium',
			};
			if (centre[b]) return centre[b];
			const limb = {
				Shoulder: 'scapula', Arm: 'humerus', ForeArm: 'ulna', Hand: 'carpus',
				UpLeg: 'femur', Leg: 'tibia', Foot: 'talus', ToeBase: 'metatarsus',
			};
			return limb[stem(b)] ? `${limb[stem(b)]}.${upperSide(b)}` : null;
		},
	},
];

// ---------------------------------------------------------------------------
// GLB construction
// ---------------------------------------------------------------------------
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/**
 * Build a minimal but structurally valid skinned GLB for one convention: the
 * template skeleton renamed, parented under an `Armature` node, with a skin whose
 * joints list every surviving bone. No BIN chunk is needed: the sweep drives the
 * skeleton, and both the canonicalizer and the bone-graph reader work off the
 * JSON chunk alone (the same slice api/_lib/glb-inspect.js reads).
 *
 * @param {(bone: string) => string|null} nameFor
 * @returns {{ buffer: ArrayBuffer, present: Map<string,string> }}
 */
function buildRigGLB(nameFor) {
	const present = new Map(); // canonical -> this rig's spelling
	for (const row of TEMPLATE) {
		const n = nameFor(row.bone);
		if (n) present.set(row.bone, n);
	}
	// Nearest surviving ancestor, so dropping a clavicle reparents the upper arm
	// onto the chest instead of orphaning the whole arm.
	const parentOf = new Map(TEMPLATE.map((r) => [r.bone, r.parent]));
	const survivingParent = (bone) => {
		let p = parentOf.get(bone);
		while (p && !present.has(p)) p = parentOf.get(p);
		return p ?? null;
	};

	const nodes = [{ name: 'Armature', children: [] }];
	const indexOf = new Map();
	for (const row of TEMPLATE) {
		if (!present.has(row.bone)) continue;
		indexOf.set(row.bone, nodes.length);
		nodes.push({ name: present.get(row.bone), translation: row.t });
	}
	for (const row of TEMPLATE) {
		if (!present.has(row.bone)) continue;
		const p = survivingParent(row.bone);
		const parentIdx = p ? indexOf.get(p) : 0;
		const node = nodes[parentIdx];
		(node.children ||= []).push(indexOf.get(row.bone));
	}
	// The skinned mesh node. It carries no primitives: the sweep never rasterizes,
	// and `skins[].joints` is what every reader in this repo keys off.
	const meshNodeIdx = nodes.length;
	nodes.push({ name: 'Body', skin: 0 });
	const joints = [...indexOf.values()];

	const json = {
		asset: { version: '2.0', generator: 'three.ws animation-dignity-sweep' },
		scene: 0,
		scenes: [{ nodes: [0, meshNodeIdx] }],
		nodes,
		skins: [{ joints, skeleton: indexOf.get('Hips') }],
	};

	let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
	const pad = (4 - (jsonBytes.length % 4)) % 4;
	if (pad) {
		const padded = new Uint8Array(jsonBytes.length + pad);
		padded.set(jsonBytes);
		padded.fill(0x20, jsonBytes.length);
		jsonBytes = padded;
	}
	const total = 12 + 8 + jsonBytes.length;
	const buffer = new ArrayBuffer(total);
	const dv = new DataView(buffer);
	dv.setUint32(0, GLB_MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonBytes.length, true);
	dv.setUint32(16, CHUNK_JSON, true);
	new Uint8Array(buffer).set(jsonBytes, 20);
	return { buffer, present };
}

function graphFromGLB(buffer) {
	const u8 = new Uint8Array(buffer);
	return buildBoneGraph(parseGltfJson(u8));
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
function loadClip(name) {
	const clip = AnimationClip.parse(JSON.parse(fs.readFileSync(path.join(CLIP_DIR, `${name}.json`), 'utf8')));
	clip.name = name;
	return clip;
}

const _qa = new Quaternion();
const _qb = new Quaternion();

/**
 * How far a bone actually swings over the clip: the angular diameter of its
 * keyframed rotations, in degrees.
 *
 * Computed with the standard two-pass diameter walk rather than all-pairs (a 15s
 * idle carries ~950 keys per bone, times 52 bones, times 10 rigs, times 2 lanes).
 * Pass 1 finds the key farthest from the first; pass 2 measures every key against
 * that one. The result is a lower bound on the true diameter and exact whenever
 * the extremes are mutually farthest, which they are for the cyclic limb motion
 * these clips carry. A lower bound is the safe direction for a floor check: it
 * can never report motion that is not there.
 */
function trackSwingDeg(track) {
	const v = track.values;
	const n = v.length / 4;
	if (n < 2) return 0;
	const at = (q, i) => q.set(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]);

	at(_qa, 0);
	let anchor = 0;
	let best = 0;
	for (let i = 1; i < n; i++) {
		const a = at(_qb, i).angleTo(_qa);
		if (a > best) {
			best = a;
			anchor = i;
		}
	}
	at(_qa, anchor);
	let max = best;
	for (let i = 0; i < n; i++) {
		const a = at(_qb, i).angleTo(_qa);
		if (a > max) max = a;
	}
	return (max * 180) / Math.PI;
}

/** Sample a flat keyframe array at-or-before `time` (stepped). */
function sampleAt(track, time, stride) {
	const times = track.times;
	let k = 0;
	while (k < times.length - 1 && times[k + 1] <= time) k++;
	const off = k * stride;
	return track.values.slice(off, off + stride);
}

/**
 * World travel of each end effector, in hip-heights, when the retargeted clip is
 * applied keyframe by keyframe to the real bone graph. The rig is restored to its
 * bind pose afterwards, so one graph can be measured against several clips.
 *
 * @returns {Map<string, number>} canonical effector bone -> travel (hip-heights)
 */
function effectorTravel(root, nodeMap, clip) {
	const bones = new Map();
	for (const limb of LIMBS) {
		const nodeName = nodeMap.get(limb.effector);
		const node = nodeName ? root.getObjectByName(nodeName) : null;
		if (node) bones.set(limb.effector, node);
	}
	if (bones.size === 0) return new Map();

	const driven = [];
	for (const t of clip.tracks) {
		const dot = t.name.lastIndexOf('.');
		const nodeName = t.name.slice(0, dot);
		const prop = t.name.slice(dot + 1);
		if (prop !== 'quaternion' && prop !== 'position') continue;
		const node = root.getObjectByName(nodeName);
		if (!node) continue;
		driven.push({ node, prop, track: t });
	}
	if (driven.length === 0) return new Map();

	const rest = driven.map(({ node }) => ({
		node,
		q: node.quaternion.clone(),
		p: node.position.clone(),
	}));

	root.updateMatrixWorld(true);
	const hipsName = nodeMap.get('Hips');
	const hipsNode = hipsName ? root.getObjectByName(hipsName) : null;
	const hipHeight = hipsNode
		? Math.abs(new Vector3().setFromMatrixPosition(hipsNode.matrixWorld).y) || 1
		: 1;

	const times = new Set();
	for (const { track } of driven) for (const t of track.times) times.add(t);
	const sorted = [...times].sort((a, b) => a - b);
	// A 15s idle carries ~950 keys; 120 evenly-spaced samples capture the extremes
	// of any authored motion without walking every key on every rig.
	const step = Math.max(1, Math.ceil(sorted.length / 120));

	const boxes = new Map([...bones.keys()].map((k) => [k, { min: null, max: null }]));
	for (let i = 0; i < sorted.length; i += step) {
		const time = sorted[i];
		for (const { node, prop, track } of driven) {
			if (prop === 'quaternion') {
				const v = sampleAt(track, time, 4);
				node.quaternion.set(v[0], v[1], v[2], v[3]);
			} else {
				const v = sampleAt(track, time, 3);
				node.position.set(v[0], v[1], v[2]);
			}
		}
		root.updateMatrixWorld(true);
		for (const [key, node] of bones) {
			const p = new Vector3().setFromMatrixPosition(node.matrixWorld);
			const box = boxes.get(key);
			if (!box.min) {
				box.min = p.clone();
				box.max = p.clone();
			} else {
				box.min.min(p);
				box.max.max(p);
			}
		}
	}

	for (const { node, q, p } of rest) {
		node.quaternion.copy(q);
		node.position.copy(p);
	}
	root.updateMatrixWorld(true);

	const out = new Map();
	for (const [key, box] of boxes) {
		out.set(key, box.min ? box.max.clone().sub(box.min).length() / hipHeight : 0);
	}
	return out;
}

/**
 * Whether the clip's Arm track landed on the actual upper arm rather than the
 * clavicle. Two joints in an anatomical rig (`shoulder.L` + `upper_arm.L`)
 * normalize onto the SAME canonical name, `LeftArm`, and no name-only table can
 * separate them: the simple hobby rig in this sweep spells its upper arm
 * `shoulderL` too, so re-pointing that spelling at `LeftShoulder` would freeze
 * that rig's arms instead. The ingest canonicalizer resolves it structurally
 * (canonicalizeJointNodes pass 1.5 demotes the clavicle-spelled contender when an
 * upper-arm-spelled one is present), which is why this only ever fires on the
 * runtime lane. See RUNTIME_PIVOT_REMEDY.
 */
function armPivotCheck(nodeMap, present) {
	const problems = [];
	for (const side of ['Left', 'Right']) {
		const armNode = nodeMap.get(`${side}Arm`);
		if (!armNode) continue;
		const claviclish = /shoulder|clavicle|collar|scapula/i.test(armNode);
		const upperArmExists = [...present.values()].some((n) => /upper.?arm|humerus|shldr.?bend/i.test(n));
		if (claviclish && upperArmExists) {
			problems.push(`${side}Arm bound to "${armNode}" (a clavicle) while an upper-arm bone exists`);
		}
	}
	return problems;
}

const RUNTIME_PIVOT_REMEDY =
	'remedy: port canonicalizeJointNodes pass 1.5/1.6 (the clavicle/upper-arm collision resolver in ' +
	'src/glb-canonicalize.js) into canonicalNodeMapFromObject in src/animation-retarget.js. Every avatar ' +
	'stored by three.ws is canonicalized at ingest (api/_lib/auto-rig.js, api/_lib/reconstruct-finalize.js, ' +
	'api/avatars/_actions.js, src/account.js), so this affects only a third-party GLB loaded straight into ' +
	'the viewer, and the arm still animates: it swings from the shoulder blade instead of the shoulder.';

/**
 * Run one rig down one lane for one clip and return the measurements.
 *
 * @param {{ lane: string }} ctx  the lane decides whether a mis-pivoted arm is a
 *   failure (ingest, where the collision resolver runs and must have worked) or a
 *   warning (runtime, where no structural resolver exists yet).
 */
function measure({ root, nodeMap, present, clip, lane }) {
	const result = retargetClipToObject(clip, root, { minCoverage: 0 });
	const out = {
		clip: clip.name,
		coverage: result.coverage,
		matched: result.matched,
		total: result.total,
		gatePassed: result.coverage >= MIN_COVERAGE,
		limbs: {},
		failures: [],
		warnings: [],
	};
	if (!result.clip) {
		out.failures.push('retarget produced no clip');
		return out;
	}

	const byName = new Map(result.clip.tracks.map((t) => [t.name, t]));
	const travel = effectorTravel(root, nodeMap, result.clip);

	for (const limb of LIMBS) {
		const swings = limb.chain.map((bone) => {
			const nodeName = nodeMap.get(bone);
			const track = nodeName ? byName.get(`${nodeName}.quaternion`) : null;
			return { bone, node: nodeName ?? null, deg: track ? trackSwingDeg(track) : null };
		});
		const best = Math.max(...swings.map((s) => s.deg ?? 0));
		const effectorNode = nodeMap.get(limb.effector);
		const moved = travel.get(limb.effector) ?? 0;
		out.limbs[limb.label] = {
			swingDeg: best,
			swings,
			effector: limb.effector,
			effectorNode: effectorNode ?? null,
			travelHipHeights: moved,
		};
		if (best < MIN_LIMB_SWING_DEG[clip.name]) {
			out.failures.push(
				`${limb.label}: rotation swing ${best.toFixed(2)}deg is below the ${MIN_LIMB_SWING_DEG[clip.name]}deg floor` +
					(swings.every((s) => s.deg === null) ? ' (no bone in the chain name-mapped)' : ''),
			);
		}
		if (moved < MIN_EFFECTOR_TRAVEL[clip.name]) {
			out.failures.push(
				`${limb.label}: ${limb.effector} travels ${moved.toFixed(4)} hip-heights, below the ${MIN_EFFECTOR_TRAVEL[clip.name]} floor`,
			);
		}
	}

	if (!out.gatePassed) {
		out.failures.push(
			`coverage ${(result.coverage * 100).toFixed(1)}% is below the MIN_COVERAGE gate (${MIN_COVERAGE * 100}%), so production builds no action at all`,
		);
	}
	for (const p of armPivotCheck(nodeMap, present)) {
		if (lane === 'ingest') out.failures.push(p);
		else out.warnings.push(`${p}. ${RUNTIME_PIVOT_REMEDY}`);
	}
	return out;
}

/** Run every clip for one convention down one lane. */
function runLane({ buffer, present, lane }) {
	const { root } = graphFromGLB(buffer);
	const nodeMap = canonicalNodeMapFromObject(root);
	const clips = CLIPS.map((name) => measure({ root, nodeMap, present, clip: loadClip(name), lane }));
	return {
		lane,
		mappedBones: nodeMap.size,
		clips,
		pass: clips.every((c) => c.failures.length === 0),
		warnings: clips.reduce((n, c) => n + c.warnings.length, 0),
	};
}

function runConvention(conv) {
	const { buffer, present } = buildRigGLB(conv.name);
	const ingest = canonicalizeGLBBones(buffer);
	return {
		id: conv.id,
		label: conv.label,
		note: conv.note,
		bones: present.size,
		renamedByIngest: ingest.renamed,
		unmappedNames: [...present.entries()]
			.filter(([, spelling]) => canonicalizeBoneName(spelling) === null)
			.map(([canonical, spelling]) => `${spelling} (should be ${canonical})`),
		lanes: [
			runLane({ buffer: ingest.buffer, present, lane: 'ingest' }),
			runLane({ buffer, present, lane: 'runtime' }),
		],
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function main() {
	const argv = process.argv.slice(2);
	const asJson = argv.includes('--json');
	const verbose = argv.includes('--verbose');

	const results = CONVENTIONS.map(runConvention);
	const failed = results.filter((r) => !r.lanes.every((l) => l.pass));

	if (asJson) {
		process.stdout.write(
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					minCoverage: MIN_COVERAGE,
					thresholds: { swingDeg: MIN_LIMB_SWING_DEG, travelHipHeights: MIN_EFFECTOR_TRAVEL },
					conventions: results,
					passed: results.length - failed.length,
					total: results.length,
				},
				null,
				2,
			) + '\n',
		);
		process.exit(failed.length === 0 ? 0 : 1);
	}

	console.log('Animation dignity sweep: idle + walk on 10 bone-naming conventions');
	console.log(`clips: ${CLIPS.join(', ')}   coverage gate: ${(MIN_COVERAGE * 100).toFixed(0)}%`);
	console.log(
		`limb floors: rotation swing idle >= ${MIN_LIMB_SWING_DEG.idle}deg / walk >= ${MIN_LIMB_SWING_DEG.walk}deg; ` +
			`effector travel idle >= ${MIN_EFFECTOR_TRAVEL.idle} / walk >= ${MIN_EFFECTOR_TRAVEL.walk} hip-heights`,
	);
	console.log('');

	for (const r of results) {
		const ok = r.lanes.every((l) => l.pass);
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label}  (${r.bones} bones, ingest renamed ${r.renamedByIngest})`);
		console.log(`      ${r.note}`);
		for (const lane of r.lanes) {
			const laneClips = lane.clips
				.map((c) => `${c.clip} ${(c.coverage * 100).toFixed(0)}%`)
				.join('  ');
			const laneMark = lane.pass ? (lane.warnings ? 'warn' : 'ok  ') : 'BAD ';
			console.log(`      ${laneMark} ${lane.lane.padEnd(7)} ${laneClips}   mapped ${lane.mappedBones} bones`);
			for (const c of lane.clips) {
				if (verbose) {
					for (const [label, m] of Object.entries(c.limbs)) {
						console.log(
							`             ${c.clip} ${label.padEnd(10)} swing ${m.swingDeg.toFixed(1).padStart(6)}deg  ` +
								`${m.effector} travel ${m.travelHipHeights.toFixed(3)}`,
						);
					}
				}
				for (const f of c.failures) console.log(`             ${c.clip}: ${f}`);
			}
			// Warnings repeat identically per clip; print the distinct set once.
			for (const w of new Set(lane.clips.flatMap((c) => c.warnings))) {
				console.log(`             warning: ${w}`);
			}
		}
		if (r.unmappedNames.length) {
			const shown = r.unmappedNames.slice(0, 6).join(', ');
			console.log(
				`      unmapped spellings (${r.unmappedNames.length}): ${shown}${r.unmappedNames.length > 6 ? ', ...' : ''}`,
			);
		}
		console.log('');
	}

	const warned = results.filter((r) => r.lanes.some((l) => l.warnings > 0));
	console.log(`${results.length - failed.length}/${results.length} conventions animate both arms and both legs on both lanes.`);
	if (failed.length) {
		console.log('Failing: ' + failed.map((f) => f.label).join(', '));
	}
	if (warned.length) {
		console.log('With warnings: ' + warned.map((w) => w.label).join(', '));
	}
	process.exit(failed.length === 0 ? 0 : 1);
}

main();
