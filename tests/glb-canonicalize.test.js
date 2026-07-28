/**
 * GLB bone-name canonicalizer — unit tests.
 *
 * Covers both the name-mapping helper and the full GLB rewrite. The GLB tests
 * build synthetic v2 GLB ArrayBuffers in-memory (no fixtures on disk), which
 * keeps the suite fast and lets us assert exact byte-level behaviour: header
 * checks, chunk-length update, BIN-chunk preservation, 4-byte padding.
 *
 * A separate section ("real-fixture tests") loads the actual cz.glb and
 * michelle.glb from disk to verify idempotency on a canonical rig and full
 * normalization on a Mixamo rig.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
	canonicalizeBoneName,
	canonicalizeJointNodes,
	canonicalizeArmatureOrientation,
	canonicalizeGLBBones,
	CANONICAL_BONES,
} from '../src/glb-canonicalize.js';

const GLB_MAGIC      = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN  = 0x004e4942;

// Build a synthetic GLB v2 from a JS object (JSON chunk) and an optional
// Uint8Array (BIN chunk).
function buildGLB(jsonObj, bin = null) {
	let jsonBytes = new TextEncoder().encode(JSON.stringify(jsonObj));
	const jPad = (4 - (jsonBytes.length % 4)) % 4;
	if (jPad) {
		const padded = new Uint8Array(jsonBytes.length + jPad);
		padded.set(jsonBytes);
		for (let i = 0; i < jPad; i++) padded[jsonBytes.length + i] = 0x20;
		jsonBytes = padded;
	}
	let binBytes = null;
	if (bin) {
		const bPad = (4 - (bin.length % 4)) % 4;
		if (bPad) {
			binBytes = new Uint8Array(bin.length + bPad);
			binBytes.set(bin);
		} else {
			binBytes = bin;
		}
	}
	const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
	const ab = new ArrayBuffer(total);
	const dv = new DataView(ab);
	const u8 = new Uint8Array(ab);
	dv.setUint32(0, GLB_MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonBytes.length, true);
	dv.setUint32(16, CHUNK_TYPE_JSON, true);
	u8.set(jsonBytes, 20);
	if (binBytes) {
		const binOff = 20 + jsonBytes.length;
		dv.setUint32(binOff, binBytes.length, true);
		dv.setUint32(binOff + 4, CHUNK_TYPE_BIN, true);
		u8.set(binBytes, binOff + 8);
	}
	return ab;
}

// Re-parse the JSON chunk out of a GLB ArrayBuffer.
function readGLBJson(ab) {
	const dv  = new DataView(ab);
	const jLen = dv.getUint32(12, true);
	const jsonBytes = new Uint8Array(ab, 20, jLen);
	return JSON.parse(new TextDecoder().decode(jsonBytes).replace(/\s+$/, ''));
}

// Mixamo-style skinned humanoid skeleton for round-trip tests.
const MIXAMO_NODES = [
	{ name: 'mixamorig:Hips',          children: [1, 30, 38] },
	{ name: 'mixamorig:Spine' },
	{ name: 'mixamorig:LeftArm' },
	{ name: 'mixamorig:LeftForeArm' },
	{ name: 'mixamorig:LeftHand' },
	{ name: 'mixamorig:RightArm' },
	// A non-joint mesh node intentionally has a bone-shaped name to confirm
	// it is NOT renamed (we only touch skins[].joints[]).
	{ name: 'mixamorig:LeftLeg_collision_mesh', mesh: 0 },
];
const MIXAMO_SKINS = [{ joints: [0, 1, 2, 3, 4, 5] }];

describe('canonicalizeBoneName', () => {
	it('returns null for non-strings, empties, and unknown names', () => {
		expect(canonicalizeBoneName(null)).toBeNull();
		expect(canonicalizeBoneName(undefined)).toBeNull();
		expect(canonicalizeBoneName('')).toBeNull();
		expect(canonicalizeBoneName(42)).toBeNull();
		expect(canonicalizeBoneName('Tail_01')).toBeNull();
		expect(canonicalizeBoneName('J_Sec_Hair1_01')).toBeNull(); // VRM secondary (hair) — not a body bone
		expect(canonicalizeBoneName('mannequin-root')).toBeNull(); // armature root, not a bone
	});

	it('returns canonical exact-match names unchanged', () => {
		for (const name of CANONICAL_BONES) {
			expect(canonicalizeBoneName(name)).toBe(name);
		}
	});

	it.each([
		['mixamorig:LeftArm',          'LeftArm'],
		['mixamorig1:LeftForeArm',     'LeftForeArm'],
		['mixamorigHead',              'Head'],
		['mixamorig_LeftHandThumb3',   'LeftHandThumb3'],
		['MIXAMORIG:LeftHand',         'LeftHand'],
	])('strips Mixamo prefix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it.each([
		['Armature_Hips',     'Hips'],
		['Armature/LeftLeg',  'LeftLeg'],
		['armature_RightArm', 'RightArm'],
	])('strips Armature prefix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it.each([
		['DEF-LeftArm',  'LeftArm'],
		['ORG-Hips',     'Hips'],
		['MCH-RightLeg', 'RightLeg'],
		['DEF_Spine1',   'Spine1'],
	])('strips Rigify prefix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it.each([
		['left_arm',         'LeftArm'],
		['Left_Arm',         'LeftArm'],
		['left-arm',         'LeftArm'],
		['LEFT_ARM',         'LeftArm'],
		['right hand',       'RightHand'],
		['lefttoebase',      'LeftToeBase'],
		['left_hand_index1', 'LeftHandIndex1'],
	])('canonicalizes separator / case variants: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it('combines vendor prefix + separator variant: mixamorig:left_arm → LeftArm', () => {
		expect(canonicalizeBoneName('mixamorig:left_arm')).toBe('LeftArm');
		expect(canonicalizeBoneName('DEF-left_fore_arm')).toBe('LeftForeArm');
	});

	// CharacterStudio prefixes every joint `CH_`; the stems are otherwise
	// canonical, so stripping the prefix makes the whole rig drivable.
	it.each([
		['CH_Hips',        'Hips'],
		['CH_LeftUpLeg',   'LeftUpLeg'],
		['CH_RightFoot',   'RightFoot'],
		['CH_Hips_01',     'Hips'],          // CH_ prefix + glTF de-dup suffix
		['CH_LeftLeg_03',  'LeftLeg'],
	])('strips the CharacterStudio CH_ prefix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Unreal Engine mannequin joint names map onto canonical bones via the
	// alias table. The `_l`/`_r` side suffix is preserved through the collapse.
	it.each([
		['pelvis',      'Hips'],
		['pelvis_09',   'Hips'],            // UE name + de-dup suffix
		['clavicle_l',  'LeftShoulder'],
		['upperarm_l',  'LeftArm'],
		['lowerarm_r',  'RightForeArm'],
		['hand_r',      'RightHand'],
		['thigh_l',     'LeftUpLeg'],
		['calf_l',      'LeftLeg'],
		['foot_r',      'RightFoot'],
		['ball_l',      'LeftToeBase'],
		['thigh_l_010', 'LeftUpLeg'],       // UE name + de-dup suffix
	])('maps Unreal mannequin bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// The Unreal spine chain is intentionally NOT aliased — `spine_02`'s
	// stripped form collides with Mixamo's `Spine` + `_02` de-dup, which must
	// keep resolving to `Spine` (asserted in the de-dup suite above). Guard it
	// here so a future alias addition can't silently break that.
	it('does not alias the Unreal spine chain (avoids Mixamo de-dup collision)', () => {
		expect(canonicalizeBoneName('mixamorig:Spine_02')).toBe('Spine');
		expect(canonicalizeBoneName('mixamorig:Spine_03')).toBe('Spine');
	});

	// glTF/FBX exporters (CharacterStudio, Blender, FBX2glTF) append a `_NN`
	// node-de-dup index to keep names unique. These are the bone names that ship
	// in real uploaded avatars — without stripping the suffix the whole animation
	// library silently fails to bind to them.
	it.each([
		['mixamorig:Hips_01',        'Hips'],
		['mixamorig:Spine_02',       'Spine'],
		['mixamorig:Spine1_03',      'Spine1'],  // base name itself ends in a digit
		['mixamorig:Spine2_04',      'Spine2'],
		['mixamorig:Neck_05',        'Neck'],
		['mixamorig:LeftForeArm_010','LeftForeArm'],
		['mixamorig:LeftToeBase_058','LeftToeBase'],
		['mixamorig:RightUpLeg_060', 'RightUpLeg'],
		['Hips_01',                  'Hips'],
		['LeftHandIndex1_016',       'LeftHandIndex1'], // digit base + dedup suffix
	])('strips the glTF node-de-dup suffix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// VRM 0.x / VRoid skeletons (`J_Bip_<C|L|R>_<bone>`). The side is in the
	// prefix; the alias table maps each explicitly, including the "Little" → pinky
	// finger rename, so a VRoid avatar drives the canonical clip library.
	it.each([
		['J_Bip_C_Hips',       'Hips'],
		['J_Bip_C_Spine',      'Spine'],
		['J_Bip_C_Chest',      'Spine1'],
		['J_Bip_C_UpperChest', 'Spine2'],
		['J_Bip_C_Neck',       'Neck'],
		['J_Bip_C_Head',       'Head'],
		['J_Bip_L_Shoulder',   'LeftShoulder'],
		['J_Bip_L_UpperArm',   'LeftArm'],
		['J_Bip_R_LowerArm',   'RightForeArm'],
		['J_Bip_L_Hand',       'LeftHand'],
		['J_Bip_L_UpperLeg',   'LeftUpLeg'],
		['J_Bip_R_LowerLeg',   'RightLeg'],
		['J_Bip_L_Foot',       'LeftFoot'],
		['J_Bip_L_ToeBase',    'LeftToeBase'],
		['J_Bip_R_Toes',       'RightToeBase'],
		['J_Bip_L_Little1',    'LeftHandPinky1'],
		['J_Bip_R_Index3',     'RightHandIndex3'],
		['J_Bip_L_Thumb2',     'LeftHandThumb2'],
	])('maps VRM/VRoid bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Reallusion Character Creator 3/4 — every joint carries a `CC_Base_` prefix
	// and the limb stems use one-word spellings (`Upperarm`, `Calf`, `ToeBase`,
	// `NeckTwist01`) behind an `L_`/`R_` side token. Without the prefix strip +
	// sided aliases an entire CC export maps zero bones and ships a T-pose.
	it.each([
		['CC_Base_Hip',         'Hips'],
		['CC_Base_Pelvis',      'Hips'],
		['CC_Base_Head',        'Head'],
		['CC_Base_NeckTwist01', 'Neck'],
		['CC_Base_L_Clavicle',  'LeftShoulder'],
		['CC_Base_L_Upperarm',  'LeftArm'],
		['CC_Base_R_Upperarm',  'RightArm'],
		['CC_Base_L_Forearm',   'LeftForeArm'],
		['CC_Base_L_Hand',      'LeftHand'],
		['CC_Base_L_Thigh',     'LeftUpLeg'],
		['CC_Base_R_Thigh',     'RightUpLeg'],
		['CC_Base_L_Calf',      'LeftLeg'],
		['CC_Base_L_Foot',      'LeftFoot'],
		['CC_Base_L_ToeBase',   'LeftToeBase'],
	])('maps Character Creator 3/4 bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// 3ds Max Biped — `Bip01 <bone>` / `Bip001 <bone>` with a space-separated side
	// token. Stripping the `Bip<NN>` prefix lets the residual canonical/sided
	// spellings resolve so the whole biped rig animates instead of T-posing.
	it.each([
		['Bip01 Pelvis',     'Hips'],
		['Bip01 Spine',      'Spine'],
		['Bip01 Spine1',     'Spine1'],
		['Bip01 Neck',       'Neck'],
		['Bip01 Head',       'Head'],
		['Bip01 L UpperArm', 'LeftArm'],
		['Bip01 L Forearm',  'LeftForeArm'],
		['Bip01 L Hand',     'LeftHand'],
		['Bip01 L Thigh',    'LeftUpLeg'],
		['Bip01 L Calf',     'LeftLeg'],
		['Bip01 L Foot',     'LeftFoot'],
		['Bip001 R UpperArm','RightArm'],
		['Bip001 R Thigh',   'RightUpLeg'],
	])('maps 3ds Max Biped bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Autodesk HumanIK / MotionBuilder / Maya — every joint sits behind a
	// character or subject namespace (`Character1:Hips`, `subject:LeftArm`),
	// optionally nested (`char:ns:Hips`). The stems are already canonical, so
	// stripping the namespace makes the whole HumanIK rig (the standard mocap
	// retarget skeleton) drive the clip library — legs included.
	it.each([
		['Character1:Hips',        'Hips'],
		['Character1:Spine',       'Spine'],
		['Character1:Spine1',      'Spine1'],
		['Character1:Spine2',      'Spine2'],
		['Character1:Neck',        'Neck'],
		['Character1:Head',        'Head'],
		['Character1:LeftShoulder','LeftShoulder'],
		['Character1:LeftArm',     'LeftArm'],
		['Character1:LeftForeArm', 'LeftForeArm'],
		['Character1:RightHand',   'RightHand'],
		['Character1:LeftUpLeg',   'LeftUpLeg'],
		['Character1:RightLeg',    'RightLeg'],
		['Character1:LeftFoot',    'LeftFoot'],
		['Character1:LeftToeBase', 'LeftToeBase'],
		['Character2:RightUpLeg',  'RightUpLeg'],   // multi-character scene
		['subject:LeftArm',        'LeftArm'],       // OptiTrack / mocap subject namespace
		['char:ns:Hips',           'Hips'],          // nested Maya namespaces
		['Character1:LeftHandThumb1', 'LeftHandThumb1'],
	])('strips the HumanIK / Maya namespace prefix: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// A namespaced node that isn't a real bone must still resolve to null (the
	// strip only ever helps a name that was already a humanoid bone).
	it('returns null for a namespaced non-bone node', () => {
		expect(canonicalizeBoneName('Character1:Reference')).toBeNull();
		expect(canonicalizeBoneName('prop:Sword')).toBeNull();
		expect(canonicalizeBoneName('Character1:IKLeftFootEffector')).toBeNull();
	});

	// Generic bare side-prefix auto-riggers (some Meshy/Tripo + simple rigs) emit
	// the canonical short bone name behind an `L_`/`R_` token.
	it.each([
		['L_Arm',      'LeftArm'],
		['R_Arm',      'RightArm'],
		['L_Shoulder', 'LeftShoulder'],
		['L_Leg',      'LeftLeg'],
		['R_Leg',      'RightLeg'],
		['L_UpLeg',    'LeftUpLeg'],
	])('maps generic L_/R_ side-prefix bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// VRM 1.0 normalized humanoid names (camelCase, no vendor prefix).
	it.each([
		['leftUpperArm',  'LeftArm'],
		['rightLowerArm', 'RightForeArm'],
		['leftUpperLeg',  'LeftUpLeg'],
		['rightLowerLeg', 'RightLeg'],
		['upperChest',    'Spine2'],
		['chest',         'Spine1'],
		['leftToes',      'LeftToeBase'],
	])('maps VRM 1.0 camelCase bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Daz3D / Genesis skeletons (`hip`, `abdomen`, `lShldr`, `lThigh`, …),
	// including the Genesis 3+ `…Bend` joints.
	it.each([
		['hip',         'Hips'],
		['abdomen',     'Spine'],
		['lCollar',     'LeftShoulder'],
		['lShldr',      'LeftArm'],
		['lShldrBend',  'LeftArm'],
		['rForeArm',    'RightForeArm'],
		['lThigh',      'LeftUpLeg'],
		['lThighBend',  'LeftUpLeg'],
		['rShin',       'RightLeg'],
	])('maps Daz/Genesis bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// MakeHuman / Blender `.L`/`.R` side suffix (the `.` is a separator), sharing
	// stems with the Unreal alias table. Blender's `.001` de-dup is stripped too.
	it.each([
		['upperarm.L',     'LeftArm'],
		['lowerarm.R',     'RightForeArm'],
		['clavicle.L',     'LeftShoulder'],
		['thigh.L',        'LeftUpLeg'],
		['shin.R',         'RightLeg'],
		['foot.L',         'LeftFoot'],
		['upperarm.L.001', 'LeftArm'],   // .L side + Blender .001 de-dup suffix
	])('maps MakeHuman/Blender .L/.R bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Simple / generic 3-joint-limb rigs that put the side as a trailing L/R and
	// name the upper arm "shoulder", forearm "elbow", hand "wrist", etc.
	it.each([
		['shoulderL', 'LeftArm'],
		['elbowR',    'RightForeArm'],
		['wristL',    'LeftHand'],
		['hipL',      'LeftUpLeg'],
		['kneeR',     'RightLeg'],
		['ankleL',    'LeftFoot'],
		['toeL',      'LeftToeBase'],
		['chest',     'Spine1'],
		['pelvis',    'Hips'],
	])('maps simple/generic side-suffix rigs: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// SMPL / SMPL-X research-pipeline skeletons (text-to-avatar generators, mocap
	// tooling) spell every limb joint as a side word + anatomical joint. The same
	// spellings show up in hand-built `leftKnee`-style rigs.
	it.each([
		['left_hip',      'LeftUpLeg'],
		['right_hip',     'RightUpLeg'],
		['left_knee',     'LeftLeg'],
		['right_knee',    'RightLeg'],
		['left_ankle',    'LeftFoot'],
		['right_ankle',   'RightFoot'],
		['left_elbow',    'LeftForeArm'],
		['right_elbow',   'RightForeArm'],
		['left_wrist',    'LeftHand'],
		['right_wrist',   'RightHand'],
		['left_collar',   'LeftShoulder'],
		['right_collar',  'RightShoulder'],
		['left_clavicle', 'LeftShoulder'],
		['left_thigh',    'LeftUpLeg'],
		['left_toe',      'LeftToeBase'],
		['leftKnee',      'LeftLeg'],
		['rightAnkle',    'RightFoot'],
	])('maps SMPL / spelled-out side-word bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Alias-table entries that predate this block but had no coverage: the
	// centre-torso chest/abdomen/neck spellings, the CC neck twist, and the
	// remaining Daz / simple-rig side variants (including derived right twins).
	it.each([
		['lowerChest',   'Spine1'],
		['chestLower',   'Spine1'],
		['chestUpper',   'Spine2'],
		['abdomenLower', 'Spine'],
		['abdomenUpper', 'Spine1'],
		['lowerNeck',    'Neck'],
		['upperNeck',    'Neck'],
		['neckLower',    'Neck'],
		['neckUpper',    'Neck'],
		['NeckTwist02',  'Neck'],
		['lHand',        'LeftHand'],
		['rHand',        'RightHand'],
		['lFoot',        'LeftFoot'],
		['rFoot',        'RightFoot'],
		['lToe',         'LeftToeBase'],
		['collarR',      'RightShoulder'],
		['lClavicle',    'LeftShoulder'],
		['rCalf',        'RightLeg'],
		['J_Bip_L_Toes',    'LeftToeBase'],
		['J_Bip_L_Middle2', 'LeftHandMiddle2'],
		['J_Bip_R_Ring1',   'RightHandRing1'],
	])('maps remaining alias-table variants: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Rigify / Blender anatomical arm chain: side is a `.L`/`.R` suffix and the
	// forearm is spelled `forearm` (not `lowerarm`/`elbow`). The suffix normalises
	// to `forearml`, which the side-prefix spellings never reach — so before the
	// alias was added the elbow dropped and Rigify characters (Quaternius, many
	// Blender exports) animated with a rigid forearm.
	it.each([
		['forearm.L',      'LeftForeArm'],
		['forearm.R',      'RightForeArm'],
		['DEF-forearm.L',  'LeftForeArm'],
		['DEF-upper_arm.L','LeftArm'],
		['upper_arm.R',    'RightArm'],
	])('maps Rigify/Blender anatomical arm bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	it('only strips the suffix when the plain form does not already resolve', () => {
		// A genuinely numbered finger bone must keep its index — the un-stripped
		// form resolves first, so we never reach the suffix strip.
		expect(canonicalizeBoneName('left_hand_index_1')).toBe('LeftHandIndex1');
		expect(canonicalizeBoneName('LeftHandIndex1')).toBe('LeftHandIndex1');
		// End-effector / non-bone nodes still fall through to null after stripping.
		expect(canonicalizeBoneName('mixamorig:HeadTop_End_07')).toBeNull();
		expect(canonicalizeBoneName('mixamorig:LeftToe_End_059')).toBeNull();
		expect(canonicalizeBoneName('Tail_01')).toBeNull();
	});

	// Daz/Genesis chains that had no direct coverage: the Genesis 3+ forearm
	// Bend joint, the lShin/lCalf lower-leg spellings, and the derived right
	// twins of the Shldr/Thigh/Bend family. A miss on any of these drops the
	// joint and a Daz export animates with a rigid elbow or frozen legs.
	it.each([
		['lForearmBend', 'LeftForeArm'],
		['rForearmBend', 'RightForeArm'],
		['lShin',        'LeftLeg'],
		['lCalf',        'LeftLeg'],
		['rShldr',       'RightArm'],
		['rShldrBend',   'RightArm'],
		['rThigh',       'RightUpLeg'],
		['rThighBend',   'RightUpLeg'],
		['lUpperArm',    'LeftArm'],
		['rUpperArm',    'RightArm'],
		['lLowerArm',    'LeftForeArm'],
		['rLowerLeg',    'RightLeg'],
	])('maps remaining Daz/Genesis chain bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Reallusion CC3/CC4 neck twists WITHOUT the CC_Base_ prefix (some export
	// paths ship the bare joint names); either twist drives the head chain.
	it.each([
		['neckTwist01',   'Neck'],
		['neckTwist02',   'Neck'],
		['neck_twist_01', 'Neck'], // separator variant collapses to the same key
	])('maps bare Reallusion neck twists: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Generic Meshy/Tripo side-prefix twins derived by the l→r rule, plus the
	// separator/case variants the normaliser must collapse onto the same keys.
	it.each([
		['R_UpLeg',    'RightUpLeg'],
		['R_Shoulder', 'RightShoulder'],
		['r_arm',      'RightArm'],
		['R_Leg',      'RightLeg'],
	])('maps derived R_ side-prefix twins: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// MakeHuman / VRM 1.0 centre-torso spellings in separator form (the
	// camelCase forms are asserted in the VRM 1.0 and alias-variant tables
	// above; these pin that snake_case reaches the same keys).
	it.each([
		['upper_chest', 'Spine2'],
		['chest_lower', 'Spine1'],
		['lower_neck',  'Neck'],
	])('maps separator variants of centre-torso bones: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// The SIDED right-twin derivation has four branches. Each is pinned with
	// spellings only that branch can produce, so a regression in one regex
	// cannot hide behind another.
	// Branch 1: a leading "left" word swaps to "right" (leftUpperArm → rightUpperArm).
	it.each([
		['rightUpperArm',  'RightArm'],
		['rightUpperLeg',  'RightUpLeg'],
		['rightToes',      'RightToeBase'],
		['rightHip',       'RightUpLeg'],
		['rightThigh',     'RightUpLeg'],
		['rightShin',      'RightLeg'],
		['rightCalf',      'RightLeg'],
		['rightWrist',     'RightHand'],
		['rightClavicle',  'RightShoulder'],
		['rightCollar',    'RightShoulder'],
	])('derives right twins from the left- word branch: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Branch 2: a leading lowercase "l" before an uppercase letter becomes "r"
	// (lShldr → rShldr, lToeBase → rToeBase).
	it.each([
		['rLowerArm', 'RightForeArm'],
		['rUpperLeg', 'RightUpLeg'],
		['rToeBase',  'RightToeBase'],
		['rClavicle', 'RightShoulder'],
		['rCollar',   'RightShoulder'],
	])('derives right twins from the l-prefix branch: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Branch 3: a trailing "L" becomes "R" (shoulderL → shoulderR).
	it.each([
		['shoulderR', 'RightArm'],
		['forearmR',  'RightForeArm'],
		['upperArmR', 'RightArm'],
		['wristR',    'RightHand'],
		['ankleR',    'RightFoot'],
		['shinR',     'RightLeg'],
		['toeR',      'RightToeBase'],
		['hipR',      'RightUpLeg'],
	])('derives right twins from the trailing-L branch: %s → %s', (input, expected) => {
		expect(canonicalizeBoneName(input)).toBe(expected);
	});

	// Branch 4 (identity fallthrough): a SIDED entry with no recognisable side
	// token derives rv === lv, and the first-spelling-wins put() means the
	// derived Right canonical can never overwrite the left entry. The observable
	// invariant: no left-side spelling ever resolves to a Right bone, and no
	// derived right-side spelling ever resolves to a Left bone.
	it('side derivation never crosses sides', () => {
		const leftSpellings = [
			'leftUpperArm', 'lUpperArm', 'shoulderL', 'lShldr', 'lShldrBend',
			'leftLowerArm', 'elbowL', 'lForeArm', 'lForearmBend', 'forearmL',
			'upperArmL', 'wristL', 'lHand', 'lCollar', 'collarL', 'lClavicle',
			'leftUpperLeg', 'hipL', 'lThigh', 'lThighBend',
			'leftLowerLeg', 'kneeL', 'shinL', 'lShin', 'lCalf',
			'ankleL', 'lFoot', 'leftToes', 'toeL', 'lToe', 'lToeBase',
			'lArm', 'lShoulder', 'lLeg', 'lUpLeg',
			'leftHip', 'leftKnee', 'leftAnkle', 'leftElbow', 'leftWrist',
			'leftCollar', 'leftClavicle', 'leftToe',
		];
		const rightSpellings = [
			'rightUpperArm', 'rUpperArm', 'shoulderR', 'rShldr', 'rShldrBend',
			'rightLowerArm', 'elbowR', 'rForeArm', 'rForearmBend', 'forearmR',
			'upperArmR', 'wristR', 'rHand', 'rCollar', 'collarR', 'rClavicle',
			'rightUpperLeg', 'hipR', 'rThigh', 'rThighBend',
			'rightLowerLeg', 'kneeR', 'shinR', 'rShin', 'rCalf',
			'ankleR', 'rFoot', 'rightToes', 'toeR', 'rToe', 'rToeBase',
			'rArm', 'rShoulder', 'rLeg', 'rUpLeg',
			'rightHip', 'rightKnee', 'rightAnkle', 'rightElbow', 'rightWrist',
			'rightCollar', 'rightClavicle', 'rightToe',
		];
		for (const name of leftSpellings) {
			const canonical = canonicalizeBoneName(name);
			expect(canonical, name).not.toBeNull();
			expect(canonical.startsWith('Right'), `${name} must not map to a Right bone`).toBe(false);
		}
		for (const name of rightSpellings) {
			const canonical = canonicalizeBoneName(name);
			expect(canonical, name).not.toBeNull();
			expect(canonical.startsWith('Left'), `${name} must not map to a Left bone`).toBe(false);
		}
	});
});

describe('canonicalizeJointNodes (in-place rewrite)', () => {
	it('only touches nodes referenced by skins[].joints', () => {
		const json = {
			nodes: [
				{ name: 'mixamorig:Hips' },
				{ name: 'mixamorig:Spine' },
				{ name: 'mixamorig:left_arm' },
				{ name: 'mixamorig:Decoration_NotABone' }, // not a joint — left alone
			],
			skins: [{ joints: [0, 1, 2] }],
		};
		const { renamed, samples } = canonicalizeJointNodes(json);
		expect(renamed).toBe(3);
		expect(json.nodes[0].name).toBe('Hips');
		expect(json.nodes[1].name).toBe('Spine');
		expect(json.nodes[2].name).toBe('LeftArm');
		expect(json.nodes[3].name).toBe('mixamorig:Decoration_NotABone');
		expect(samples).toHaveLength(3);
		expect(samples[0]).toEqual({ from: 'mixamorig:Hips', to: 'Hips' });
	});

	it('splits a Rigify shoulder/upper-arm collision (clavicle → Shoulder, upper arm → Arm)', () => {
		// Both `shoulder.L` (clavicle) and `upper_arm.L` normalise onto LeftArm.
		// Without collision resolution two joints take the name LeftArm and the arm
		// clip binds to the clavicle. The resolver demotes the clavicle to Shoulder.
		const json = {
			nodes: [
				{ name: 'DEF-hips' },
				{ name: 'DEF-shoulder.L' }, { name: 'DEF-upper_arm.L' }, { name: 'DEF-forearm.L' }, { name: 'DEF-hand.L' },
				{ name: 'DEF-shoulder.R' }, { name: 'DEF-upper_arm.R' }, { name: 'DEF-forearm.R' }, { name: 'DEF-hand.R' },
			],
			skins: [{ joints: [0, 1, 2, 3, 4, 5, 6, 7, 8] }],
		};
		canonicalizeJointNodes(json);
		const names = json.nodes.map((n) => n.name);
		expect(names.filter((n) => n === 'LeftArm')).toHaveLength(1);
		expect(names.filter((n) => n === 'LeftShoulder')).toHaveLength(1);
		expect(names.filter((n) => n === 'LeftForeArm')).toHaveLength(1);
		expect(names.filter((n) => n === 'RightArm')).toHaveLength(1);
		expect(names.filter((n) => n === 'RightShoulder')).toHaveLength(1);
	});

	it('does NOT invent a Shoulder when there is no collision (simple rig: shoulder = the arm)', () => {
		// A simple 3-joint rig names its upper arm `shoulderL` and has no separate
		// upper-arm bone — so shoulder must stay LeftArm, never demote to Shoulder.
		const json = {
			nodes: [{ name: 'Hips' }, { name: 'shoulderL' }, { name: 'elbowL' }, { name: 'wristL' }],
			skins: [{ joints: [0, 1, 2, 3] }],
		};
		canonicalizeJointNodes(json);
		const names = json.nodes.map((n) => n.name);
		expect(names).toContain('LeftArm');
		expect(names).not.toContain('LeftShoulder');
	});

	it('splits an SMPL collar/shoulder collision (collar → Shoulder, shoulder → Arm)', () => {
		// SMPL names the clavicle `left_collar` and the upper arm `left_shoulder`;
		// both normalise onto LeftShoulder, which would leave LeftArm vacant and
		// the arm clip unbound. The resolver promotes the shoulder-spelled joint
		// (the upper arm) to Arm.
		const json = {
			nodes: [
				{ name: 'pelvis' },
				{ name: 'left_collar' }, { name: 'left_shoulder' }, { name: 'left_elbow' }, { name: 'left_wrist' },
				{ name: 'right_collar' }, { name: 'right_shoulder' }, { name: 'right_elbow' }, { name: 'right_wrist' },
			],
			skins: [{ joints: [0, 1, 2, 3, 4, 5, 6, 7, 8] }],
		};
		canonicalizeJointNodes(json);
		expect(json.nodes[1].name).toBe('LeftShoulder');
		expect(json.nodes[2].name).toBe('LeftArm');
		expect(json.nodes[3].name).toBe('LeftForeArm');
		expect(json.nodes[4].name).toBe('LeftHand');
		expect(json.nodes[6].name).toBe('RightArm');
	});

	it('does NOT promote shoulder to Arm when there is no collar collision', () => {
		// A rig whose only arm-root joint is `left_shoulder` must keep it on
		// LeftShoulder — nothing contests the name.
		const json = {
			nodes: [{ name: 'pelvis' }, { name: 'left_shoulder' }, { name: 'left_elbow' }],
			skins: [{ joints: [0, 1, 2] }],
		};
		canonicalizeJointNodes(json);
		expect(json.nodes[1].name).toBe('LeftShoulder');
	});

	it('never assigns the same canonical name to two joints (SMPL ankle + foot chain)', () => {
		// `left_ankle` (the articulating joint) and `left_foot` (its child) both
		// resolve to LeftFoot. Parent-first order means the ankle takes the name;
		// the child keeps its original name instead of creating an ambiguous twin.
		const json = {
			nodes: [
				{ name: 'pelvis', children: [1] },
				{ name: 'left_hip', children: [2] },
				{ name: 'left_knee', children: [3] },
				{ name: 'left_ankle', children: [4] },
				{ name: 'left_foot' },
			],
			skins: [{ joints: [0, 1, 2, 3, 4] }],
		};
		canonicalizeJointNodes(json);
		expect(json.nodes[3].name).toBe('LeftFoot');
		expect(json.nodes[4].name).toBe('left_foot');
		const names = json.nodes.map((n) => n.name);
		expect(names.filter((n) => n === 'LeftFoot')).toHaveLength(1);
		expect(names).toContain('Hips');
		expect(names).toContain('LeftUpLeg');
		expect(names).toContain('LeftLeg');
	});

	it('skips a rename whose target already exists on a joint that is not renamed', () => {
		// A rig with a literal canonical `Neck` plus a CC neck twist that would
		// also map to Neck: the existing bone keeps the name, the twist is left
		// untouched rather than duplicated.
		const json = {
			nodes: [
				{ name: 'CC_Base_Hip' },
				{ name: 'Neck' },
				{ name: 'CC_Base_NeckTwist02' },
			],
			skins: [{ joints: [0, 1, 2] }],
		};
		const { renamed } = canonicalizeJointNodes(json);
		expect(renamed).toBe(1);
		expect(json.nodes[0].name).toBe('Hips');
		expect(json.nodes[1].name).toBe('Neck');
		expect(json.nodes[2].name).toBe('CC_Base_NeckTwist02');
	});

	it('returns 0 when the rig is already canonical', () => {
		const json = {
			nodes: [{ name: 'Hips' }, { name: 'Spine' }, { name: 'LeftArm' }],
			skins: [{ joints: [0, 1, 2] }],
		};
		const { renamed } = canonicalizeJointNodes(json);
		expect(renamed).toBe(0);
		expect(json.nodes[0].name).toBe('Hips');
	});

	it('returns 0 and never throws on a buffer-less GLB JSON (no skins / no nodes)', () => {
		expect(canonicalizeJointNodes({}).renamed).toBe(0);
		expect(canonicalizeJointNodes({ nodes: [] }).renamed).toBe(0);
		expect(canonicalizeJointNodes({ nodes: [{ name: 'mixamorig:Hips' }] }).renamed).toBe(0);
	});

	it('skips joints whose names are not recognised humanoid bones', () => {
		const json = {
			nodes: [{ name: 'mixamorig:Hips' }, { name: 'mixamorig:Tail_01' }, { name: 'J_Bip_L_UpperArm' }],
			skins: [{ joints: [0, 1, 2] }],
		};
		const { renamed } = canonicalizeJointNodes(json);
		// Hips (Mixamo) and the VRM upper-arm both canonicalize; the non-humanoid
		// Tail bone has no mapping and is left untouched.
		expect(renamed).toBe(2);
		expect(json.nodes[0].name).toBe('Hips');
		expect(json.nodes[1].name).toBe('mixamorig:Tail_01');
		expect(json.nodes[2].name).toBe('LeftArm');
	});
});

describe('canonicalizeGLBBones (full GLB rewrite)', () => {
	it('throws clearly on a non-ArrayBuffer or truncated buffer', () => {
		expect(() => canonicalizeGLBBones(null)).toThrow(/ArrayBuffer required/);
		expect(() => canonicalizeGLBBones(new ArrayBuffer(8))).toThrow(/too small/);
	});

	it('throws on a bad magic number', () => {
		const ab = new ArrayBuffer(40);
		new DataView(ab).setUint32(0, 0xdeadbeef, true);
		expect(() => canonicalizeGLBBones(ab)).toThrow(/bad magic/);
	});

	it('throws on GLB version != 2', () => {
		const ab = new ArrayBuffer(40);
		const dv = new DataView(ab);
		dv.setUint32(0, GLB_MAGIC, true);
		dv.setUint32(4, 1, true);
		expect(() => canonicalizeGLBBones(ab)).toThrow(/v2 is supported/);
	});

	it('returns the original buffer by reference when no renames were needed', () => {
		const ab = buildGLB({
			nodes: [{ name: 'Hips' }, { name: 'LeftArm' }],
			skins: [{ joints: [0, 1] }],
		});
		const out = canonicalizeGLBBones(ab);
		expect(out.renamed).toBe(0);
		expect(out.buffer).toBe(ab); // same reference — caller can skip re-upload
	});

	it('rewrites Mixamo-prefixed joint names and produces a valid GLB', () => {
		const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const ab = buildGLB({ nodes: MIXAMO_NODES, skins: MIXAMO_SKINS }, bin);
		const { buffer, renamed, samples } = canonicalizeGLBBones(ab);
		expect(renamed).toBe(6);
		expect(buffer).not.toBe(ab);

		const dv = new DataView(buffer);
		expect(dv.getUint32(0, true)).toBe(GLB_MAGIC);
		expect(dv.getUint32(4, true)).toBe(2);
		expect(dv.getUint32(8, true)).toBe(buffer.byteLength);

		const json = readGLBJson(buffer);
		expect(json.nodes[0].name).toBe('Hips');
		expect(json.nodes[1].name).toBe('Spine');
		expect(json.nodes[2].name).toBe('LeftArm');
		expect(json.nodes[3].name).toBe('LeftForeArm');
		expect(json.nodes[4].name).toBe('LeftHand');
		expect(json.nodes[5].name).toBe('RightArm');
		// Non-joint preserved verbatim.
		expect(json.nodes[6].name).toBe('mixamorig:LeftLeg_collision_mesh');

		// Samples are stable, used by the dashboard to surface "X bones retargeted".
		expect(samples.length).toBeGreaterThan(0);
		expect(samples[0].from).toMatch(/^mixamorig:/);
	});

	it('preserves the BIN chunk byte-for-byte', () => {
		const bin = new Uint8Array(64);
		for (let i = 0; i < bin.length; i++) bin[i] = (i * 7 + 13) & 0xff;
		const ab = buildGLB({ nodes: MIXAMO_NODES, skins: MIXAMO_SKINS }, bin);
		const { buffer } = canonicalizeGLBBones(ab);

		// Find BIN chunk in the rewritten buffer.
		const dv = new DataView(buffer);
		const jLen = dv.getUint32(12, true);
		const binOffset = 20 + jLen;
		expect(dv.getUint32(binOffset + 4, true)).toBe(CHUNK_TYPE_BIN);
		const binLen = dv.getUint32(binOffset, true);
		expect(binLen).toBe(bin.length);
		const recoveredBin = new Uint8Array(buffer, binOffset + 8, binLen);
		expect(Array.from(recoveredBin)).toEqual(Array.from(bin));
	});

	it('JSON chunk in the output is 4-byte aligned', () => {
		const ab = buildGLB({ nodes: MIXAMO_NODES, skins: MIXAMO_SKINS });
		const { buffer } = canonicalizeGLBBones(ab);
		const jLen = new DataView(buffer).getUint32(12, true);
		expect(jLen % 4).toBe(0);
	});

	it('round-trips a buffer-less GLB (no BIN chunk)', () => {
		const ab = buildGLB({ nodes: MIXAMO_NODES, skins: MIXAMO_SKINS });
		const { buffer, renamed } = canonicalizeGLBBones(ab);
		expect(renamed).toBe(6);
		// Header `total` matches actual byte length and there's no chunk 1.
		const dv = new DataView(buffer);
		expect(dv.getUint32(8, true)).toBe(buffer.byteLength);
		const jLen = dv.getUint32(12, true);
		expect(20 + jLen).toBe(buffer.byteLength);
	});
});

describe('canonicalizeArmatureOrientation', () => {
	const P90 = [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]; // +90°X
	const M90 = [-Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]; // −90°X

	// Mixamo-shaped rig: armature(+90°X, uniform scale) → Hips(−90°X) → Spine → Head,
	// plus a sibling mesh node under the armature. Net bind pose is upright.
	function tiltedRigJson(armRot, hipsRot) {
		return {
			asset: { version: '2.0' },
			nodes: [
				{ name: 'Armature', rotation: armRot, scale: [0.01, 0.01, 0.01], children: [1, 4] },
				{ name: 'mixamorig:Hips', rotation: hipsRot, translation: [0, 100, 0], children: [2] },
				{ name: 'mixamorig:Spine', translation: [0, 10, 0], children: [3] },
				{ name: 'mixamorig:Head', translation: [0, 20, 0] },
				{ name: 'Ch03' },
			],
			skins: [{ joints: [1, 2, 3] }],
			scenes: [{ nodes: [0] }],
			scene: 0,
		};
	}

	function jointWorld(json, idx) {
		const parentOf = new Map();
		json.nodes.forEach((n, i) => {
			if (Array.isArray(n.children)) for (const c of n.children) parentOf.set(c, i);
		});
		const local = (n) => {
			const t = new Vector3();
			const r = new Quaternion();
			const s = new Vector3(1, 1, 1);
			if (n.translation) t.fromArray(n.translation);
			if (n.rotation) r.fromArray(n.rotation);
			if (n.scale) s.fromArray(n.scale);
			return new Matrix4().compose(t, r, s);
		};
		const w = (i) => {
			const p = parentOf.get(i);
			const m = local(json.nodes[i]);
			return p == null ? m : w(p).clone().multiply(m);
		};
		return w(idx);
	}

	it('folds a Mixamo +90/−90 split to an axis-aligned rig, losslessly', () => {
		const json = tiltedRigJson(P90.slice(), M90.slice());
		const hipsBefore = jointWorld(json, 1).elements.slice();
		const headBefore = jointWorld(json, 3).elements.slice();

		const res = canonicalizeArmatureOrientation(json);
		expect(res.corrected).toBe(true);
		expect(res.hipsIdentity).toBe(true);

		// Both the armature and the (counter-rotated) Hips are now identity.
		expect(json.nodes[0].rotation).toEqual([0, 0, 0, 1]);
		json.nodes[1].rotation.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0, 1][i], 6));

		// World matrices of the bones are preserved → the skinned mesh is unchanged.
		jointWorld(json, 1).elements.forEach((v, i) => expect(v).toBeCloseTo(hipsBefore[i], 4));
		jointWorld(json, 3).elements.forEach((v, i) => expect(v).toBeCloseTo(headBefore[i], 4));
	});

	it('is a no-op when the armature is already axis-aligned', () => {
		const json = tiltedRigJson([0, 0, 0, 1], [0, 0, 0, 1]);
		const res = canonicalizeArmatureOrientation(json);
		expect(res.corrected).toBe(false);
	});

	it('refuses to fold a non-uniform-scale armature (rotation would not commute)', () => {
		const json = tiltedRigJson(P90.slice(), M90.slice());
		json.nodes[0].scale = [0.01, 0.02, 0.01];
		const res = canonicalizeArmatureOrientation(json);
		expect(res.corrected).toBe(false);
		expect(json.nodes[0].rotation).toEqual(P90); // untouched
	});

	it('canonicalizeGLBBones reports orientationCorrected and produces a valid GLB', () => {
		const glb = buildGLB(tiltedRigJson(P90.slice(), M90.slice()), new Uint8Array([1, 2, 3, 4]));
		const res = canonicalizeGLBBones(glb);
		expect(res.orientationCorrected).toBe(true);
		expect(res.renamed).toBeGreaterThan(0); // mixamorig: names also canonicalized
		const dv = new DataView(res.buffer);
		expect(dv.getUint32(0, true)).toBe(GLB_MAGIC);
		expect(dv.getUint32(8, true)).toBe(res.buffer.byteLength);
	});
});

// ── Real-fixture tests ────────────────────────────────────────────────────────
// These load the actual cz.glb (reference canonical rig) and michelle.glb
// (Mixamo rig with +90°X armature / −90°X Hips) from disk so we can verify
// idempotency and appearance-invariant normalization on real production assets.
//
// Helper: collect joint-world matrices from a parsed glTF JSON.
function jointWorldMatrices(json) {
	const parentOf = new Map();
	json.nodes.forEach((n, i) => {
		if (Array.isArray(n.children)) for (const c of n.children) parentOf.set(c, i);
	});
	const local = (n) => {
		const t = new Vector3(), r = new Quaternion(), s = new Vector3(1, 1, 1);
		if (n.translation) t.fromArray(n.translation);
		if (n.rotation)    r.fromArray(n.rotation);
		if (n.scale)       s.fromArray(n.scale);
		return new Matrix4().compose(t, r, s);
	};
	const cache = new Map();
	const world = (i) => {
		if (cache.has(i)) return cache.get(i);
		const p = parentOf.get(i);
		const m = p == null ? local(json.nodes[i]) : world(p).clone().multiply(local(json.nodes[i]));
		cache.set(i, m);
		return m;
	};
	const joints = new Set();
	for (const sk of json.skins || []) for (const j of sk.joints || []) joints.add(j);
	const out = new Map();
	for (const j of joints) out.set(j, world(j).elements.slice());
	return out;
}

function glbToAB(buf) {
	// Node Buffer may be a view into a shared pool; .slice() always returns a
	// fresh backing ArrayBuffer at offset 0.
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('real-fixture: cz.glb (reference canonical rig)', () => {
	it('is a no-op — buffer returned by reference (idempotent)', () => {
		const buf = readFileSync('public/avatars/cz.glb');
		const ab  = glbToAB(buf);
		const res = canonicalizeGLBBones(ab);
		expect(res.renamed).toBe(0);
		expect(res.orientationCorrected).toBe(false);
		// Original buffer reference returned — no unnecessary repack.
		expect(res.buffer).toBe(ab);
	});
});

describe('real-fixture: michelle.glb (Mixamo rig normalization)', () => {
	// Shared fixture computed once in beforeAll; each it() reads from these.
	let ab, res, beforeW, afterJson;

	beforeAll(() => {
		const buf = readFileSync('public/avatars/michelle.glb');
		ab = glbToAB(buf);
		beforeW = jointWorldMatrices(readGLBJson(ab));
		res = canonicalizeGLBBones(ab);
		afterJson = readGLBJson(res.buffer);
	});

	it('bones renamed and orientation corrected', () => {
		expect(res.renamed).toBeGreaterThan(0);      // mixamorig: prefix stripped
		expect(res.orientationCorrected).toBe(true);  // +90/−90 fold applied
		expect(res.buffer).not.toBe(ab);              // new buffer produced
	});

	it('Hips rest is near identity after normalization', () => {
		const hipsIdx = afterJson.nodes.findIndex((n) => n.name === 'Hips');
		expect(hipsIdx).toBeGreaterThanOrEqual(0);
		const hipsRot = afterJson.nodes[hipsIdx].rotation || [0, 0, 0, 1];
		// |w| ≈ 1 means identity quaternion (axis ≈ zero, angle ≈ 0).
		expect(Math.abs(hipsRot[3])).toBeCloseTo(1, 5);
	});

	it('joint world matrices are preserved — appearance is lossless', () => {
		const afterW = jointWorldMatrices(afterJson);
		const EPS = 1e-3; // 1 mm in typical avatar units
		for (const [idx, bEls] of beforeW) {
			const aEls = afterW.get(idx);
			if (!aEls) continue;
			for (let k = 0; k < 16; k++) {
				expect(Math.abs(bEls[k] - aEls[k])).toBeLessThan(EPS);
			}
		}
	});

	it('all joint names are canonical after normalization', () => {
		const joints = new Set();
		for (const sk of afterJson.skins || []) for (const j of sk.joints || []) joints.add(j);
		const nonCanon = [...joints].map((j) => afterJson.nodes[j].name)
			.filter((n) => canonicalizeBoneName(n) !== n && canonicalizeBoneName(n) !== null);
		expect(nonCanon).toHaveLength(0);
	});
});

describe('SMPL / SMPL-X skeleton (research text-to-avatar output)', () => {
	// The 24-joint SMPL body skeleton, in its standard parent-first order. This
	// is what research generators (TADA, HumanGaussian, mocap exporters) emit,
	// so it hits the avatar upload path with no vendor prefix to strip.
	const SMPL_JOINTS = [
		'pelvis',
		'left_hip', 'right_hip', 'spine1',
		'left_knee', 'right_knee', 'spine2',
		'left_ankle', 'right_ankle', 'spine3',
		'left_foot', 'right_foot',
		'neck', 'left_collar', 'right_collar', 'head',
		'left_shoulder', 'right_shoulder',
		'left_elbow', 'right_elbow',
		'left_wrist', 'right_wrist',
		'left_hand', 'right_hand',
	];

	it('maps the full body chain, legs and arms included, with no duplicate names', () => {
		const json = {
			nodes: SMPL_JOINTS.map((name) => ({ name })),
			skins: [{ joints: SMPL_JOINTS.map((_, i) => i) }],
		};
		canonicalizeJointNodes(json);
		const names = json.nodes.map((n) => n.name);
		for (const bone of [
			'Hips', 'Neck', 'Head',
			'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
			'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
			'LeftUpLeg', 'LeftLeg', 'LeftFoot',
			'RightUpLeg', 'RightLeg', 'RightFoot',
		]) {
			expect(names, bone).toContain(bone);
		}
		// The wrist (articulating joint) takes the Hand name; its child keeps its
		// original name — no canonical name is ever assigned twice.
		const canon = names.filter((n) => CANONICAL_BONES.includes(n));
		expect(new Set(canon).size).toBe(canon.length);
	});
});

describe('rig worker skeleton (workers/rig, Make-It-Animatable output)', () => {
	// The exact 52-bone skeleton the auto-rig worker emits (Mixamo names, see
	// workers/rig/engine_mia.py). Every bone must map onto the canonical set so
	// a freshly rigged avatar can drive the full clip library with 100%
	// coverage; a rename miss here silently breaks retargeting in production.
	const MIA_JOINTS = [
		'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
		'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
		'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
		'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
		'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
		'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
		'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
		'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
		'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
		'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
		'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
		'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
		'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
		'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
		'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
	].map((n) => `mixamorig:${n}`);

	it('every worker bone name canonicalizes', () => {
		for (const name of MIA_JOINTS) {
			expect(canonicalizeBoneName(name), name).not.toBeNull();
		}
	});

	it('the worker skeleton covers the canonical bone set completely', () => {
		const mapped = new Set(MIA_JOINTS.map((n) => canonicalizeBoneName(n)));
		for (const bone of CANONICAL_BONES) {
			expect(mapped.has(bone), bone).toBe(true);
		}
		expect(mapped.size).toBe(CANONICAL_BONES.length);
	});

	it('a worker-shaped GLB rewrites to canonical names in place', () => {
		const nodes = MIA_JOINTS.map((name, i) => ({
			name,
			translation: [0, i * 0.01, 0],
		}));
		// Chain children linearly; the canonicalizer only needs skins[].joints.
		const json = {
			asset: { version: '2.0' },
			scenes: [{ nodes: [0] }],
			scene: 0,
			nodes,
			skins: [{ joints: nodes.map((_, i) => i) }],
		};
		const out = canonicalizeGLBBones(buildGLB(json));
		expect(out.renamed).toBe(MIA_JOINTS.length);
		const after = readGLBJson(out.buffer);
		const names = after.nodes.map((n) => n.name);
		for (const bone of CANONICAL_BONES) {
			expect(names).toContain(bone);
		}
	});
});
