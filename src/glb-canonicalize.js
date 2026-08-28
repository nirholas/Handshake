// GLB bone-name canonicalizer — rewrites joint node names in an uploaded
// humanoid GLB so they match the three.ws canonical bone set, letting the
// pre-baked Mixamo animation library play on any rig variant.
//
// Handled name variants:
//   • Mixamo:          `mixamorig:LeftArm`, `mixamorig1:LeftArm`, `mixamorigLeftArm`
//   • Blender:         `Armature_LeftArm`, `Armature/LeftArm`, `upperarm.L` (.L/.R side)
//   • Rigify:          `DEF-LeftArm`, `ORG-LeftArm`, `MCH-LeftArm`
//   • CharacterStudio: `CH_Hips`, `CH_LeftUpLeg` (CH_ prefix stripped)
//   • HumanIK / Maya:   `Character1:Hips`, `Character1:LeftArm`, `subject:LeftUpLeg` (namespace strip)
//   • Unreal mannequin: `pelvis`, `clavicle_l`, `upperarm_l`, `thigh_l`, `calf_l`, … (alias map)
//   • VRM / VRoid:     `J_Bip_C_Hips`, `J_Bip_L_UpperArm`, `J_Bip_L_Little1` (alias map)
//   • VRM 1.0:         `upperChest`, `leftUpperArm`, `leftLowerLeg`, `leftToes` (camelCase)
//   • MMD (PMX/PMD):   `センター`, `上半身`, `左腕`, `左ひじ`, `左ひざ` (Japanese, 左/右 side prefix)
//   • Daz / Genesis:   `hip`, `abdomen`, `lShldr`, `lForeArm`, `lThigh`, `lShin`, `lCollar`
//   • MakeHuman:       `upperarm.L`, `shin.L`, `clavicle.L` (shared with Unreal/Blender stems)
//   • Simple rigs:     `shoulderL`, `elbowL`, `wristL`, `hipL`, `kneeL`, `ankleL`, `chest`
//   • SMPL / SMPL-X:   `left_hip`, `left_knee`, `left_ankle`, `left_elbow`, `left_wrist` (side-word joints)
//   • Roblox R15/R6:   `LowerTorso`, `UpperTorso`, `Torso`, `LeftUpperArm`, `Left Arm`
//   • Second Life:     `mPelvis`, `mTorso`, `mChest`, `mCollarLeft`, `mShoulderLeft`, `mKneeRight`
//   • Anatomical:      `lumbar`, `thoracic`, `cervical`, `cranium`, `humerus.L`,
//                      `ulna.L`, `femur.L`, `tibia.L`, `talus.L` (scan / anatomy-kit rigs)
//   • snake_case:      `left_arm`, `Left_Arm`
//   • kebab-case:      `left-arm`
//   • lowercase:       `leftarm`, `lefthand`
//
// Finger chains are mapped per convention as well, and they are load-bearing: 30
// of the 53 tracks in every clip in /public/animations/clips address a finger
// joint, so a rig whose hands don't name-map scores ~40% retarget coverage, falls
// under MIN_COVERAGE in animation-retarget.js, and gets NO action built at all.
// Covered spellings: `index_01_l` (Unreal), `leftIndexProximal` (VRM 1.0),
// `lIndex1` / `lMid1` (Daz), `f_index.01.L` + `thumb.01.L` (Rigify),
// `finger2-1.L` (MakeHuman), `Index1.L` / `IndexFinger1_R` (Blender / Advanced
// Skeleton), `J_Bip_L_Little1` (VRoid), `index_proximal.L` (anatomical).
// Measured end to end by scripts/animation-dignity-sweep.mjs.
//
// Skeletons that aren't humanoid (quadrupeds, custom prop rigs) deliberately
// fall through unchanged — there's no safe automatic mapping for those, and
// callers fall back to a known-good rig rather than render a bind-pose T-pose.
//
// Constraint-driven CONTROL RIGS also fall through on purpose. Blender rigs of
// the Auto-Rig-Pro / "cwf_ + def_ + tracker" family export a deform layer whose
// bones are LEAVES hanging off tracker nodes, not a chain: `def_arm_1.R` is not
// a child of `def_arm_0.R`, it hangs off `c_arm_1_tracker.R`. In Blender those
// trackers carry Copy-Rotation/Damped-Track constraints; glTF has no constraint
// system, so they export as inert nodes. Rotating a mapped `def_` bone would move
// its own skin while the next segment stayed put — the arm comes apart. Mapping
// that layer is strictly worse than the default-rig fallback, so we do not.
// Verified against real stored avatars; see scripts/audit-rig-coverage.mjs.
// The remedy for these uploads is re-rigging (workers/rig), not name mapping.
//
// This module is pure JS — works in Node (vitest) and in the browser. It
// rewrites the GLB JSON chunk in-place and repacks the binary container so
// the result is a valid GLB that swaps in 1:1 at the same R2 storage key.

import { Matrix4, Quaternion, Vector3 } from 'three';

const GLB_MAGIC      = 0x46546c67; // 'glTF' little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'

// Quaternion is "axis-aligned enough" / scale is "uniform enough" below this.
const ORIENT_EPS = 1e-5;
// Joint world-matrix elements must match within this before/after the fold, or
// the fold is reverted (it would have altered the mesh).
const ORIENT_WORLD_EPS = 1e-4;

// Canonical humanoid bone set. Mirrors the rig used by scripts/build-animations.mjs
// (cz.glb / Avaturn reference rig) — every animation clip in /public/animations/clips
// addresses tracks by these exact names.
export const CANONICAL_BONES = Object.freeze([
	'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
	'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
	'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
	'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
	'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
	'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
	'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
	'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
	'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
	'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
	'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
	'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
	'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
	'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
]);

// Lookup map: separator-stripped, lowercased variant → canonical name.
// Built once at module load so canonicalizeBoneName() runs in O(1).
const LOOKUP = (() => {
	const m = new Map();
	for (const canonical of CANONICAL_BONES) {
		m.set(canonical.toLowerCase(), canonical);
	}
	return m;
})();

// Unreal Engine mannequin skeleton → canonical aliases. UE names the same
// joints `pelvis`, `clavicle_l`, `upperarm_l`, `thigh_l`, `calf_l`, `ball_l`,
// … which share no spelling with the canonical/Mixamo set. Keyed by the same
// separator-stripped lowercase form `_lookupBone` produces (`clavicle_l` →
// `claviclel`). The spine chain (`spine_01/02/03`) is deliberately OMITTED:
// its stripped form `spine02` collides with Mixamo's `Spine` + `_02` de-dup
// suffix, which canonicalizeBoneName already resolves to `Spine`. The torso
// then rides on `Hips` while every limb, foot, and the neck retarget cleanly —
// well above the 8-bone floor a readable performance needs.
const UNREAL_ALIASES = new Map(Object.entries({
	pelvis: 'Hips',
	neck01: 'Neck',
	claviclel: 'LeftShoulder', upperarml: 'LeftArm', lowerarml: 'LeftForeArm', handl: 'LeftHand',
	clavicler: 'RightShoulder', upperarmr: 'RightArm', lowerarmr: 'RightForeArm', handr: 'RightHand',
	thighl: 'LeftUpLeg', calfl: 'LeftLeg', footl: 'LeftFoot', balll: 'LeftToeBase',
	thighr: 'RightUpLeg', calfr: 'RightLeg', footr: 'RightFoot', ballr: 'RightToeBase',
}));

// Unreal's finger chain: `index_01_l`, `middle_02_r`, `thumb_03_l`, `pinky_01_l`,
// `ring_02_l`. The zero-padded joint index is what keeps these out of the
// side-suffix finger table below (`Index1L` normalises to `index1l`, never
// `index01l`), so an otherwise-mapped mannequin arrived with 30 of its 52 joints
// unmapped. That is not a cosmetic loss: 30 of the clip library's 53 tracks are
// finger tracks, so a fingerless mannequin scored 40% coverage and fell under the
// MIN_COVERAGE gate in animation-retarget.js: the rig built no action at all and
// stood in its bind pose. Found by scripts/animation-dignity-sweep.mjs.
for (const [uf, cf] of [
	['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Middle'],
	['ring', 'Ring'], ['pinky', 'Pinky'],
]) {
	for (let n = 1; n <= 3; n++) {
		UNREAL_ALIASES.set(`${uf}0${n}l`, `LeftHand${cf}${n}`);
		UNREAL_ALIASES.set(`${uf}0${n}r`, `RightHand${cf}${n}`);
	}
}

// Extended humanoid alias map: VRM/VRoid, VRM 1.0, Daz/Genesis, MakeHuman, and
// simple/generic rigs. Keyed by the same separator-stripped, lowercased form
// `_lookupBone` produces (e.g. `J_Bip_L_UpperArm` → `jbiplupperarm`,
// `shoulderL` → `shoulderl`). Consulted AFTER the canonical/Mixamo and Unreal
// tables, so it only ever resolves names those don't already cover — it can
// never shadow a canonical spelling. Every entry maps onto the canonical bone
// set the clip library drives, so any rig using these conventions animates
// (idle + walk with legs moving) instead of freezing in its bind-pose T-pose.
const EXTRA_ALIASES = (() => {
	const m = new Map();
	const norm = (s) => s.replace(/[-_.\s]+/g, '').toLowerCase();
	// First spelling wins, so listing-order is the priority.
	const put = (variant, canonical) => { const k = norm(variant); if (!m.has(k)) m.set(k, canonical); };

	// VRM 0.x / VRoid skeletons (`J_Bip_<C|L|R>_<bone>`). The side lives in the
	// prefix, so each is mapped explicitly rather than via the side helper below.
	const VRM = [
		['J_Bip_C_Hips', 'Hips'], ['J_Bip_C_Spine', 'Spine'], ['J_Bip_C_Chest', 'Spine1'],
		['J_Bip_C_UpperChest', 'Spine2'], ['J_Bip_C_Neck', 'Neck'], ['J_Bip_C_Head', 'Head'],
		['J_Bip_L_Shoulder', 'LeftShoulder'], ['J_Bip_L_UpperArm', 'LeftArm'], ['J_Bip_L_LowerArm', 'LeftForeArm'], ['J_Bip_L_Hand', 'LeftHand'],
		['J_Bip_R_Shoulder', 'RightShoulder'], ['J_Bip_R_UpperArm', 'RightArm'], ['J_Bip_R_LowerArm', 'RightForeArm'], ['J_Bip_R_Hand', 'RightHand'],
		['J_Bip_L_UpperLeg', 'LeftUpLeg'], ['J_Bip_L_LowerLeg', 'LeftLeg'], ['J_Bip_L_Foot', 'LeftFoot'], ['J_Bip_L_ToeBase', 'LeftToeBase'], ['J_Bip_L_Toes', 'LeftToeBase'],
		['J_Bip_R_UpperLeg', 'RightUpLeg'], ['J_Bip_R_LowerLeg', 'RightLeg'], ['J_Bip_R_Foot', 'RightFoot'], ['J_Bip_R_ToeBase', 'RightToeBase'], ['J_Bip_R_Toes', 'RightToeBase'],
	];
	for (const [v, c] of VRM) put(v, c);
	// VRoid finger chains: Thumb/Index/Middle/Ring map 1:1; "Little" is the pinky.
	for (const [vf, cf] of [['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Little', 'Pinky']]) {
		for (let n = 1; n <= 3; n++) {
			put(`J_Bip_L_${vf}${n}`, `LeftHand${cf}${n}`);
			put(`J_Bip_R_${vf}${n}`, `RightHand${cf}${n}`);
		}
	}

	// MikuMikuDance (PMX/PMD) skeletons name every bone in Japanese, with the
	// side carried by a leading 左 (left) / 右 (right) character. No spelling
	// here shares a stem with any Latin convention, so the whole rig previously
	// mapped zero joints and animated nothing. Sides are listed explicitly
	// rather than derived, because the SIDED table below swaps Latin side
	// tokens (left→right, l→r, L→R) and cannot reach a Japanese prefix.
	//
	// Deliberately NOT mapped: the IK targets (左足ＩＫ, 左つま先ＩＫ) and the
	// twist bones (左腕捩, 左手捩). Neither is a chain joint. MMD drives the leg
	// chain from the IK target, so binding a clip to it would fight the chain
	// it is supposed to solve, and the twist bones are secondary deformers that
	// tear the mesh when rotated as if they were the limb.
	for (const [v, c] of [
		['センター', 'Hips'], ['下半身', 'Hips'],
		['上半身', 'Spine'], ['上半身2', 'Spine1'],
		['首', 'Neck'], ['頭', 'Head'],
	]) put(v, c);
	for (const [jp, side] of [['左', 'Left'], ['右', 'Right']]) {
		for (const [v, c] of [
			['肩', 'Shoulder'], ['腕', 'Arm'], ['ひじ', 'ForeArm'], ['手首', 'Hand'],
			['足', 'UpLeg'], ['ひざ', 'Leg'], ['足首', 'Foot'], ['つま先', 'ToeBase'],
		]) put(`${jp}${v}`, `${side}${c}`);
		// MMD finger chains. 親指 (thumb) is numbered 0-2, every other digit 1-3.
		// 人指 is the index finger; some exporters spell it 人差指.
		for (const [jp2, cf] of [['人指', 'Index'], ['人差指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Pinky']]) {
			for (let n = 1; n <= 3; n++) put(`${jp}${jp2}${n}`, `${side}Hand${cf}${n}`);
		}
		for (let n = 0; n <= 2; n++) put(`${jp}親指${n}`, `${side}HandThumb${n + 1}`);
	}

	// Centre / torso bones with no side (VRM 1.0, Daz, generic single-chest rigs).
	for (const [v, c] of [
		['chest', 'Spine1'], ['lowerChest', 'Spine1'], ['chestLower', 'Spine1'],
		['upperChest', 'Spine2'], ['chestUpper', 'Spine2'],
		['abdomen', 'Spine'], ['abdomenLower', 'Spine'], ['abdomenUpper', 'Spine1'],
		['hip', 'Hips'],
		['lowerNeck', 'Neck'], ['upperNeck', 'Neck'], ['neckLower', 'Neck'], ['neckUpper', 'Neck'],
		// Reallusion CC3/CC4 splits the neck into twist joints; either drives the head chain.
		['neckTwist01', 'Neck'], ['neckTwist02', 'Neck'],
		// Roblox R15 (`LowerTorso`/`UpperTorso`) and R6 (`Torso`), plus the generic
		// single-torso spellings simple rigs use. The pelvis IS the lower torso in
		// R15, and the chest maps to Spine1 like VRM's `chest`.
		['torso', 'Spine'], ['waist', 'Spine'],
		['upperTorso', 'Spine1'], ['torsoUpper', 'Spine1'],
		['lowerTorso', 'Hips'], ['torsoLower', 'Hips'],
		['ribcage', 'Spine1'], ['ribs', 'Spine1'],
		// Second Life / OpenSim centre chain (`m`-prefixed body bones).
		['mPelvis', 'Hips'], ['mTorso', 'Spine'], ['mChest', 'Spine1'],
		['mNeck', 'Neck'], ['mHead', 'Head'],
		// Advanced Skeleton (Maya) tags centre bones with an `_M` side token:
		// `Root_M`, `Spine1_M`, `Spine2_M`, `Chest_M`, `Neck_M`, `Head_M`. Its LIMBS
		// use `_L`/`_R` and already resolve through the sided table, which is why
		// these rigs arrived with working arms and legs but no Hips — and no Hips
		// means the retargeter has no root to anchor to, so nothing animated at all.
		// AS numbers its spine from 1 at the base, one deeper than the canonical
		// chain, hence the shift (`Spine1_M` → Spine, `Spine2_M` → Spine1).
		['root_M', 'Hips'], ['hip_M', 'Hips'], ['pelvis_M', 'Hips'],
		['spine1_M', 'Spine'], ['spine2_M', 'Spine1'], ['spine3_M', 'Spine2'],
		['chest_M', 'Spine2'], ['neck_M', 'Neck'], ['head_M', 'Head'],
		// A zero-indexed spine base (`j_spine_0`, `spine_00`) is the first spine
		// joint; the `_1`/`_2` links already resolve as Spine1/Spine2.
		['spine0', 'Spine'],
		// UniGLTF/VRM-converter root joint.
		['hipMaster', 'Hips'],
		// Anatomical-Latin rigs. Scan pipelines, medical/anatomy kits, and the
		// ZBrush/Blender anatomy libraries name every joint for the bone itself
		// rather than for its role: `pelvis` (already mapped via the Unreal table),
		// `lumbar`, `thoracic`, `sternum`, `cervical`, `cranium`, with `humerus.L`,
		// `femur.L` and friends on the limbs below. The whole convention previously
		// mapped 3 of 52 joints and animated nothing at all.
		['lumbar', 'Spine'], ['thoracic', 'Spine1'], ['sternum', 'Spine2'],
		['cervical', 'Neck'], ['cranium', 'Head'], ['skull', 'Head'],
	]) put(v, c);

	// Side-paired limb bones, given as the LEFT spelling + its canonical; the
	// right twin is derived by swapping the side token (left→right, leading l→r,
	// trailing L→R). Covers VRM 1.0 camelCase, Daz/Genesis (`lShldr`, `lThigh`),
	// and simple rigs (`shoulderL`, `elbowL`, `hipL`).
	const SIDED = [
		['leftUpperArm', 'LeftArm'], ['lUpperArm', 'LeftArm'], ['shoulderL', 'LeftArm'], ['lShldr', 'LeftArm'], ['lShldrBend', 'LeftArm'],
		['leftLowerArm', 'LeftForeArm'], ['lLowerArm', 'LeftForeArm'], ['elbowL', 'LeftForeArm'], ['lForeArm', 'LeftForeArm'], ['lForearmBend', 'LeftForeArm'],
		// Rigify/Blender anatomical spelling (`forearm.L`, `upper_arm.L`) — the side
		// is a `.L`/`.R` SUFFIX, so it normalises to `forearml`, which none of the
		// side-PREFIX spellings above (`lForeArm`, `lLowerArm`) reach. Without this
		// the elbow bone drops and every Rigify-rigged character (Quaternius, many
		// Blender exports) animates with a rigid, unbending forearm.
		['forearmL', 'LeftForeArm'], ['upperArmL', 'LeftArm'],
		['wristL', 'LeftHand'], ['lHand', 'LeftHand'],
		['lCollar', 'LeftShoulder'], ['collarL', 'LeftShoulder'], ['lClavicle', 'LeftShoulder'],
		['leftUpperLeg', 'LeftUpLeg'], ['lUpperLeg', 'LeftUpLeg'], ['hipL', 'LeftUpLeg'], ['lThigh', 'LeftUpLeg'], ['lThighBend', 'LeftUpLeg'],
		['leftLowerLeg', 'LeftLeg'], ['lLowerLeg', 'LeftLeg'], ['kneeL', 'LeftLeg'], ['shinL', 'LeftLeg'], ['lShin', 'LeftLeg'], ['lCalf', 'LeftLeg'],
		['ankleL', 'LeftFoot'], ['lFoot', 'LeftFoot'],
		['leftToes', 'LeftToeBase'], ['toeL', 'LeftToeBase'], ['lToe', 'LeftToeBase'], ['lToeBase', 'LeftToeBase'],
		// Generic side-prefix auto-riggers (some Meshy/Tripo + simple rigs) emit the
		// canonical short bone name behind a bare `L_`/`R_` side token: `L_Arm`,
		// `L_Leg`, `L_UpLeg`, `L_Shoulder`. The right twin is derived by the l→r rule.
		['lArm', 'LeftArm'], ['lShoulder', 'LeftShoulder'], ['lLeg', 'LeftLeg'], ['lUpLeg', 'LeftUpLeg'],
		// SMPL / SMPL-X and other research-pipeline skeletons (text-to-avatar
		// generators, mocap tooling) spell every limb joint as a side word plus the
		// anatomical joint: `left_hip`, `left_knee`, `left_ankle`, `left_elbow`,
		// `left_wrist`, `left_collar`. The same spellings appear in hand-built
		// `leftKnee`-style rigs. Without these the whole lower body drops and a
		// SMPL-derived avatar glides around on frozen legs.
		['leftHip', 'LeftUpLeg'], ['leftThigh', 'LeftUpLeg'],
		['leftKnee', 'LeftLeg'], ['leftShin', 'LeftLeg'], ['leftCalf', 'LeftLeg'],
		['leftAnkle', 'LeftFoot'],
		['leftElbow', 'LeftForeArm'],
		['leftWrist', 'LeftHand'],
		['leftCollar', 'LeftShoulder'], ['leftClavicle', 'LeftShoulder'],
		['leftToe', 'LeftToeBase'],
		// Second Life / OpenSim limb chain: `m`-prefixed with a trailing side word
		// (`mCollarLeft`, `mShoulderLeft`, `mKneeLeft`). `mShoulder` is the upper
		// arm (the clavicle is `mCollar`), and the ankle is the articulating foot
		// joint; `mFoot` (the ball, between ankle and toe) drives the toe bone.
		['mCollarLeft', 'LeftShoulder'], ['mShoulderLeft', 'LeftArm'],
		['mElbowLeft', 'LeftForeArm'], ['mWristLeft', 'LeftHand'],
		['mHipLeft', 'LeftUpLeg'], ['mKneeLeft', 'LeftLeg'],
		['mAnkleLeft', 'LeftFoot'], ['mFootLeft', 'LeftToeBase'], ['mToeLeft', 'LeftToeBase'],
		// Side-SUFFIX leg spellings (`UpperLeg.L`, `LowerLeg.R`, `LowerArm.L`). The
		// arm twins were added with the Rigify forearm fix, but the LEG twins were
		// not, and the side-PREFIX entries above (`leftUpperLeg`, `lUpperLeg`) never
		// reach `upperlegl`. Found by scripts/audit-rig-coverage.mjs against real
		// stored avatars: a Blender-exported rig using this convention lost BOTH leg
		// joints on each side and animated gliding on frozen legs.
		['upperLegL', 'LeftUpLeg'], ['lowerLegL', 'LeftLeg'], ['lowerArmL', 'LeftForeArm'],
		// The scapula is the clavicle in Advanced Skeleton / Daz-derived rigs.
		['scapulaL', 'LeftShoulder'],
		// Bare side-PREFIX anatomical joints (`j_L_hip`, `L_knee`, `R_ankle`). The
		// suffix twins (`hipL`, `kneeL`, `ankleL`) exist above but never reach the
		// prefix spelling. Same audit finding as the `j_` strip: Sketchfab-exported
		// rigs using this convention mapped zero bones.
		['lHip', 'LeftUpLeg'], ['lKnee', 'LeftLeg'], ['lAnkle', 'LeftFoot'],
		['lElbow', 'LeftForeArm'], ['lWrist', 'LeftHand'], ['lToes', 'LeftToeBase'],
		// Anatomical-Latin limbs, in both the side-SUFFIX (`humerus.L`) and
		// side-PREFIX (`l_humerus`) spellings these rigs ship in. The clavicle
		// (`scapula`) is already covered above. Radius and ulna are both forearm
		// joints and fibula is a lower-leg joint: whichever the rig actually skins
		// to is the one the retargeter binds (first-bone-wins), and either drives
		// the same limb segment.
		['humerusL', 'LeftArm'], ['lHumerus', 'LeftArm'],
		['ulnaL', 'LeftForeArm'], ['lUlna', 'LeftForeArm'],
		['radiusL', 'LeftForeArm'], ['lRadius', 'LeftForeArm'],
		['carpusL', 'LeftHand'], ['lCarpus', 'LeftHand'],
		['femurL', 'LeftUpLeg'], ['lFemur', 'LeftUpLeg'],
		['tibiaL', 'LeftLeg'], ['lTibia', 'LeftLeg'],
		['fibulaL', 'LeftLeg'], ['lFibula', 'LeftLeg'],
		['talusL', 'LeftFoot'], ['lTalus', 'LeftFoot'],
		['tarsusL', 'LeftFoot'], ['lTarsus', 'LeftFoot'],
		['calcaneusL', 'LeftFoot'], ['lCalcaneus', 'LeftFoot'],
		['metatarsusL', 'LeftToeBase'], ['lMetatarsus', 'LeftToeBase'],
	];

	// Finger conventions the side-suffix `Index1L` family below does not reach.
	// Fingers are 30 of the clip library's 53 tracks, so a rig whose hands don't
	// name-map scores ~40% coverage and falls under animation-retarget.js's
	// MIN_COVERAGE gate: production then builds NO action for it and the avatar
	// stands in its bind pose. Every convention here was measured doing exactly
	// that by scripts/animation-dignity-sweep.mjs before these entries landed.
	for (const [vf, cf] of [
		['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'],
		['Ring', 'Ring'], ['Pinky', 'Pinky'], ['Little', 'Pinky'],
	]) {
		const lf = vf.toLowerCase();
		for (let n = 1; n <= 3; n++) {
			// Daz / Genesis side-PREFIX numbering: `lIndex1`, `rPinky3`. (Genesis
			// abbreviates the middle finger to `lMid1`, handled just below.)
			SIDED.push([`l${vf}${n}`, `LeftHand${cf}${n}`]);
			// Blender Rigify: `f_index.01.L`, `f_pinky.03.R`, and the thumb's own
			// `thumb.01.L` spelling (Rigify drops the `f_` there).
			SIDED.push([`f_${lf}.0${n}.L`, `LeftHand${cf}${n}`]);
			SIDED.push([`${lf}.0${n}.L`, `LeftHand${cf}${n}`]);
			// MakeHuman numbers the digits 1..5 from the thumb: `finger1-2.L` is the
			// thumb's middle phalanx, `finger5-1.R` the right pinky's first.
			const digit = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].indexOf(cf) + 1;
			if (digit > 0) SIDED.push([`finger${digit}-${n}.L`, `LeftHand${cf}${n}`]);
		}
		// VRM 1.0 and anatomical rigs name the phalanges instead of numbering them:
		// proximal / intermediate / distal, with the thumb starting at its
		// metacarpal (which is the canonical set's `Thumb1`). VRM 1.0 puts the side
		// first (`leftIndexProximal`); anatomy-kit rigs put it last
		// (`index_proximal.L`). Both spellings are listed so either resolves.
		const phalanges =
			cf === 'Thumb'
				? ['Metacarpal', 'Proximal', 'Distal']
				: ['Proximal', 'Intermediate', 'Distal'];
		phalanges.forEach((phalanx, i) => {
			SIDED.push([`left${vf}${phalanx}`, `LeftHand${cf}${i + 1}`]);
			SIDED.push([`${lf}_${phalanx.toLowerCase()}.L`, `LeftHand${cf}${i + 1}`]);
		});
	}
	// Genesis abbreviates only the middle finger.
	for (let n = 1; n <= 3; n++) SIDED.push([`lMid${n}`, `LeftHandMiddle${n}`]);
	// Side-suffix finger chains, both conventions found in real uploaded avatars by
	// scripts/audit-rig-coverage.mjs:
	//   • Blender / MakeHuman:    `Index.L`, `Index2.L`, `Middle1.L`, `Thumb.L`, `Ring2.R`
	//   • Advanced Skeleton/Maya: `IndexFinger1_R`, `MiddleFinger2_L`, `ThumbFinger3_R`
	// The un-numbered spelling (`Thumb.L`, `Index.L`) is the FIRST phalanx — those
	// rigs number only the joints after it. Metacarpals (`Palm1.L`) are deliberately
	// skipped: the canonical set has no metacarpal, so there is nothing to drive.
	for (const [vf, cf] of [
		['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'],
		['Ring', 'Ring'], ['Pinky', 'Pinky'], ['Little', 'Pinky'],
	]) {
		for (let n = 1; n <= 3; n++) {
			SIDED.push([`${vf}${n}L`, `LeftHand${cf}${n}`]);
			SIDED.push([`${vf}Finger${n}L`, `LeftHand${cf}${n}`]);
		}
		SIDED.push([`${vf}L`, `LeftHand${cf}1`]);
		SIDED.push([`${vf}FingerL`, `LeftHand${cf}1`]);
	}

	for (const [lv, lc] of SIDED) {
		put(lv, lc);
		const rc = lc.replace(/^Left/, 'Right');
		let rv;
		if (/^left/.test(lv)) rv = lv.replace(/^left/, 'right');
		else if (/^l[A-Z]/.test(lv)) rv = 'r' + lv.slice(1);
		else if (/Left$/.test(lv)) rv = lv.replace(/Left$/, 'Right');
		else if (/L$/.test(lv)) rv = lv.replace(/L$/, 'R');
		else rv = lv;
		put(rv, rc);
	}
	return m;
})();

/**
 * Reduce a bone name to its canonical three.ws form, or null if it doesn't
 * correspond to a recognised humanoid bone.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function canonicalizeBoneName(name) {
	if (typeof name !== 'string' || !name) return null;
	const direct = _lookupBone(name);
	if (direct) return direct;
	// glTF/FBX node de-dup suffix: exporters (CharacterStudio, Blender's glTF
	// writer, FBX2glTF) append `_NN` to keep node names unique, producing
	// `mixamorig:Hips_01`, `Spine1_03`, `LeftForeArm_010`. The plain lookup
	// can't see past the suffix, so retry once with a trailing `_<digits>`
	// removed — but only when the un-stripped form didn't already resolve, so a
	// genuinely numbered bone like `left_hand_index_1` still maps to
	// `LeftHandIndex1` before we'd ever strip its index.
	// `_NN` (glTF/FBX) and `.NNN` (Blender) are both node-de-dup suffixes.
	const deduped = name.replace(/[._]\d+$/, '');
	if (deduped !== name) return _lookupBone(deduped);
	return null;
}

// Reduce a single bone-name variant to canonical form via the lookup table.
// Strips vendor prefixes and separators; returns null on no match.
function _lookupBone(name) {
	let s = name;
	// Strip a leading Maya / FBX / MotionBuilder namespace (one or more
	// `identifier:` segments). Autodesk HumanIK exports every joint behind a
	// character namespace — `Character1:Hips`, `Character1:LeftArm`,
	// `Character1:LeftUpLeg` — whose stems are already canonical, so removing the
	// namespace makes the whole HumanIK / MotionBuilder rig drivable. Maya
	// referenced rigs and OptiTrack/mocap subjects use the same `subject:bone`
	// (and nested `char:ns:bone`) convention. Runs first so it also normalises
	// the colon form of any vendor prefix below (`mixamorig:`, `Armature:`).
	// Safe by construction: a stripped name that isn't a real bone (`prop:Sword`
	// → `Sword`) simply falls through to null and is left untouched.
	s = s.replace(/^(?:[A-Za-z][\w]*:)+/, '');
	// Strip well-known vendor prefixes (case-insensitive, in priority order).
	s = s.replace(/^mixamorig\d*[_:]?/i, '');
	s = s.replace(/^Armature[_/]?/i, '');
	s = s.replace(/^(DEF|ORG|MCH)[-_]/i, '');
	// CharacterStudio exports prefix every joint `CH_` (`CH_Hips`, `CH_LeftUpLeg`),
	// whose stems are otherwise canonical — strip it like any other vendor prefix.
	s = s.replace(/^CH[_:]/i, '');
	// Reallusion Character Creator 3/4 prefixes every joint `CC_Base_`
	// (`CC_Base_Hip`, `CC_Base_L_Upperarm`, `CC_Base_L_Calf`, `CC_Base_NeckTwist01`);
	// once the prefix is gone the stems resolve through the sided/centre alias
	// tables below. Without this an entire CC export maps zero bones and lands in
	// a bind-pose T-pose.
	s = s.replace(/^CC_Base_/i, '');
	// Reallusion CC3/CC4 numbered spine: CC_Base_Spine01/02 -> Spine01/02 after strip.
	// Unlike Unreal's spine_01 (spine02 collides with Mixamo Spine+_02 dedup), Spine01
	// has no separator before digits, so we handle it explicitly before the general
	// alias table to avoid colliding with Mixamo's `Spine_02` dedup (which normalizes
	// to spine02 but should dedup to Spine, not Spine1). CC has Hips + 2 spine joints.
	if (/^spine01$/i.test(s)) return 'Spine';
	if (/^spine02$/i.test(s)) return 'Spine1';
	// Sketchfab / Maya joint exports prefix every joint `j_` (`j_pelvis`, `j_L_hip`,
	// `j_spine_0`). Stripping it leaves stems the canonical + sided tables resolve.
	// The negative lookahead protects VRM/VRoid, whose `J_Bip_*` / `J_Sec_*` names
	// are matched WHOLE by the alias table — stripping `J_` there would corrupt the
	// key and drop an entire VRoid rig. Found by scripts/audit-rig-coverage.mjs:
	// these rigs previously mapped ZERO bones and shipped a bind-pose T-pose.
	s = s.replace(/^j_(?!bip|sec|adj)/i, '');
	// UniGLTF / VRM-converter exports number every node and may flag it with `!`:
	// `5.joint_HipMaster`, `10.!joint_LeftToe`, `95.!Root`. Strip the index, the
	// flag, and the `joint_` noun so the residual bone name resolves.
	s = s.replace(/^\d+\./, '').replace(/^!/, '').replace(/^joint[_:]/i, '');
	// 3ds Max Biped names joints `Bip01 Pelvis`, `Bip001 L UpperArm`, … with a
	// space- or underscore-separated `Bip<NN>` prefix (the digits identify the
	// character). Strip it so `Pelvis`/`Spine`/`L UpperArm`/`L Thigh`/`L Calf`
	// reach the canonical + sided tables instead of T-posing.
	s = s.replace(/^Bip\d+[\s_]?/i, '');
	// Collapse separators so `Left_Arm`, `left-arm`, `left arm`, `LeftArm`,
	// `upperarm.L` all reach the same lookup key (`.` covers Blender/MakeHuman).
	const key = s.replace(/[-_.\s]+/g, '').toLowerCase();
	// Canonical/Mixamo/Rigify spellings first, then the Unreal-mannequin aliases,
	// then the extended VRM/Daz/MakeHuman/simple-rig table (lowest priority, so it
	// only catches names the first two don't already resolve).
	return LOOKUP.get(key) ?? UNREAL_ALIASES.get(key) ?? EXTRA_ALIASES.get(key) ?? null;
}

// A joint spelled like the shoulder blade / collar bone rather than the limb.
const CLAVICLE_SPELLING = /shoulder|clavicle|collar|scapula/i;
// A joint spelled like the upper arm itself.
const UPPER_ARM_SPELLING = /upper.?arm|humerus/i;
// Clavicle-only spellings: `shoulder` is deliberately absent, because SMPL-style
// rigs use it FOR the upper arm (`left_shoulder`) and name the clavicle
// `left_collar`. Used by the mirror-image pass.
const COLLAR_ONLY_SPELLING = /clavicle|collar|scapula/i;

/**
 * Resolve the clavicle / upper-arm naming collision on a canonicalization plan.
 *
 * Anatomical rigs give the two bones names that normalize onto ONE canonical
 * name, and no name-only table can separate them, because the same spelling
 * means different bones on different rigs:
 *
 *   - Rigify names the clavicle `shoulder.L` and the upper arm `upper_arm.L`;
 *     both resolve to `LeftArm`, so the clip's arm rotation binds to the
 *     clavicle and the arm swings from the shoulder blade.
 *   - SMPL names the clavicle `left_collar` and the upper arm `left_shoulder`;
 *     both resolve to `LeftShoulder`, leaving `LeftArm` vacant and the arm clip
 *     unbound entirely.
 *   - The hand-built hobby rig spells its upper arm `shoulderL` with no clavicle
 *     at all, so re-pointing that spelling would freeze its arms.
 *
 * The collision is therefore resolved by contention, not by spelling: a target
 * is only reassigned when two joints contest it AND the sibling target is free,
 * so a rig without the collision is never touched. When more than one contender
 * is eligible and the caller supplies an `isAncestor` test, skeleton hierarchy
 * breaks the tie: the clavicle is the parent of the upper arm.
 *
 * Mutates each entry's `canonical` in place.
 *
 * @param {Array<{raw: string, canonical: string}>} plan  candidate assignments
 * @param {{ isAncestor?: (a: object, b: object) => boolean }} [opts]
 * @returns {number} entries reassigned
 */
export function resolveArmShoulderCollisions(plan, opts = {}) {
	const isAncestor = typeof opts.isAncestor === 'function' ? opts.isAncestor : null;
	const count = new Map();
	for (const p of plan) count.set(p.canonical, (count.get(p.canonical) || 0) + 1);

	// When spelling leaves more than one entry eligible, hierarchy decides: the
	// clavicle is an ANCESTOR of the upper arm. `related` holds the contenders on
	// the other side of that relation. Falls back to document order when the
	// caller gave us no hierarchy to read (or none of the pairs are related).
	const byHierarchy = (eligible, related, aboveRelated) => {
		if (eligible.length < 2 || !isAncestor) return eligible[0];
		const match = eligible.find((e) =>
			related.some((o) => o !== e && (aboveRelated ? isAncestor(e, o) : isAncestor(o, e))),
		);
		return match || eligible[0];
	};

	const move = (entry, from, to) => {
		entry.canonical = to;
		count.set(from, (count.get(from) || 1) - 1);
		count.set(to, (count.get(to) || 0) + 1);
	};

	let changed = 0;
	// Arm contested (Rigify): demote the clavicle-spelled contender to Shoulder.
	for (const side of ['Left', 'Right']) {
		const arm = `${side}Arm`;
		const shoulder = `${side}Shoulder`;
		if ((count.get(arm) || 0) < 2 || (count.get(shoulder) || 0) > 0) continue;
		const contenders = plan.filter((p) => p.canonical === arm);
		const upperArms = contenders.filter((p) => UPPER_ARM_SPELLING.test(p.raw));
		if (upperArms.length === 0) continue;
		const eligible = contenders.filter(
			(p) => CLAVICLE_SPELLING.test(p.raw) && !UPPER_ARM_SPELLING.test(p.raw),
		);
		const pick = byHierarchy(eligible, upperArms, true);
		if (!pick) continue;
		move(pick, arm, shoulder);
		changed++;
	}

	// Shoulder contested (SMPL): promote the shoulder-spelled contender to Arm.
	for (const side of ['Left', 'Right']) {
		const arm = `${side}Arm`;
		const shoulder = `${side}Shoulder`;
		if ((count.get(shoulder) || 0) < 2 || (count.get(arm) || 0) > 0) continue;
		const contenders = plan.filter((p) => p.canonical === shoulder);
		const collars = contenders.filter((p) => COLLAR_ONLY_SPELLING.test(p.raw));
		if (collars.length === 0) continue;
		const eligible = contenders.filter(
			(p) => /shoulder/i.test(p.raw) && !COLLAR_ONLY_SPELLING.test(p.raw),
		);
		const pick = byHierarchy(eligible, collars, false);
		if (!pick) continue;
		move(pick, shoulder, arm);
		changed++;
	}
	return changed;
}

// Whether glTF node `a` is an ancestor of node `b`, walking up `parentOf`.
// Tolerates the cyclic parentage a malformed GLB can carry: the visited set
// stops the walk instead of looping forever.
function isAncestorNode(parentOf, aIndex, bIndex) {
	if (aIndex == null || bIndex == null || aIndex === bIndex) return false;
	const seen = new Set([bIndex]);
	for (let cur = parentOf.get(bIndex); cur != null && !seen.has(cur); cur = parentOf.get(cur)) {
		if (cur === aIndex) return true;
		seen.add(cur);
	}
	return false;
}

/**
 * Walk a parsed glTF JSON object and canonicalize joint-node names in place.
 * Only nodes referenced from `skins[].joints[]` are touched — non-bone nodes
 * (meshes, cameras, lights) keep their original names.
 *
 * @param {object} json - parsed glTF JSON
 * @returns {{ renamed: number, samples: Array<{ from: string, to: string }> }}
 */
export function canonicalizeJointNodes(json) {
	if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.skins)) {
		return { renamed: 0, samples: [] };
	}
	const jointIndices = new Set();
	for (const skin of json.skins) {
		if (Array.isArray(skin.joints)) {
			for (const idx of skin.joints) jointIndices.add(idx);
		}
	}
	// Pass 1: resolve each joint to a canonical target (or null).
	const plan = [];
	for (const idx of jointIndices) {
		const node = json.nodes[idx];
		if (!node || typeof node.name !== 'string') continue;
		const canonical = canonicalizeBoneName(node.name);
		if (!canonical || canonical === node.name) continue;
		plan.push({ node, index: idx, raw: node.name, canonical });
	}

	// Pass 1.5/1.6: the clavicle/upper-arm collision, resolved by the shared
	// resolver the runtime lane also uses.
	const parentOf = new Map();
	json.nodes.forEach((n, i) => {
		if (Array.isArray(n.children)) for (const c of n.children) parentOf.set(c, i);
	});
	resolveArmShoulderCollisions(plan, {
		isAncestor: (a, b) => isAncestorNode(parentOf, a.index, b.index),
	});

	// Pass 2: apply. A canonical name is assigned at most once — when two joints
	// still resolve to the same target after collision resolution (SMPL's
	// ankle+foot chain, CC's NeckTwist01/02), or the target spelling already
	// belongs to a joint that isn't being renamed, later renames are skipped.
	// Duplicate node names make the animation bind ambiguous (getObjectByName
	// picks an arbitrary twin), which is strictly worse than leaving the extra
	// joint unmapped. glTF joints are listed parent-first, so first-wins keeps
	// the parent joint (the one that actually articulates the limb).
	const planned = new Set(plan.map((p) => p.node));
	const taken = new Set();
	for (const idx of jointIndices) {
		const node = json.nodes[idx];
		if (node && typeof node.name === 'string' && !planned.has(node)) taken.add(node.name);
	}
	let renamed = 0;
	const samples = [];
	for (const p of plan) {
		if (taken.has(p.canonical)) continue;
		taken.add(p.canonical);
		if (samples.length < 5) samples.push({ from: p.raw, to: p.canonical });
		p.node.name = p.canonical;
		renamed++;
	}
	return { renamed, samples };
}

// Local TRS → Matrix4 for a glTF node.
function nodeLocalMatrix(node) {
	const t = new Vector3();
	const r = new Quaternion();
	const s = new Vector3(1, 1, 1);
	if (node.translation) t.fromArray(node.translation);
	if (node.rotation) r.fromArray(node.rotation);
	if (node.scale) s.fromArray(node.scale);
	return new Matrix4().compose(t, r, s);
}

// World matrices for a set of node indices, each walked to its scene root.
function worldMatricesFor(json, indices, parentOf) {
	const local = json.nodes.map(nodeLocalMatrix);
	const cache = new Map();
	const visiting = new Set();
	const world = (idx) => {
		if (cache.has(idx)) return cache.get(idx);
		// Guard against cyclic parentage in malformed GLBs — treat the cycle root
		// as a top-level node (identity parent) rather than blowing the call stack.
		if (visiting.has(idx)) return local[idx].clone();
		visiting.add(idx);
		const p = parentOf.get(idx);
		const m = p == null ? local[idx].clone() : world(p).clone().multiply(local[idx]);
		visiting.delete(idx);
		cache.set(idx, m);
		return m;
	};
	const out = new Map();
	for (const idx of indices) out.set(idx, world(idx));
	return out;
}

/**
 * Fold a Mixamo/FBX up-axis bake out of the rig. Mixamo exports put a +90°X on
 * the armature node and a −90°X on Hips; the net is upright, but a clip authored
 * for an identity-Hips rig overwrites the −90°X and tips the body over (the
 * "lying down" bug). The runtime retargeter (animation-retarget.js) corrects for
 * this on the fly, but normalizing at ingest means stored avatars are already
 * axis-aligned and need no correction.
 *
 * The fold pushes the armature's rotation down into each child (rotating its
 * translation, pre-multiplying its rotation) and zeroes the armature's rotation.
 * Bone *world* matrices are preserved exactly — provided the armature's scale is
 * uniform, so rotation commutes with it — which means the skinned mesh and its
 * inverse-bind matrices (in the untouched BIN chunk) still resolve to the same
 * bind pose. A counter-rotated Hips collapses to identity. Verified by comparing
 * world matrices before/after; reverts on any mismatch. Mutates `json` in place.
 *
 * @param {object} json parsed glTF JSON
 * @returns {{ corrected: boolean, hipsIdentity?: boolean }}
 */
export function canonicalizeArmatureOrientation(json) {
	if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.skins)) {
		return { corrected: false };
	}
	const parentOf = new Map();
	json.nodes.forEach((n, i) => {
		if (Array.isArray(n.children)) for (const c of n.children) parentOf.set(c, i);
	});
	const jointIdx = new Set();
	for (const skin of json.skins) {
		if (Array.isArray(skin.joints)) for (const j of skin.joints) jointIdx.add(j);
	}
	if (jointIdx.size === 0) return { corrected: false };

	let hips = -1;
	for (const idx of jointIdx) {
		const n = json.nodes[idx];
		if (n && typeof n.name === 'string' && canonicalizeBoneName(n.name) === 'Hips') {
			hips = idx;
			break;
		}
	}
	if (hips < 0) return { corrected: false };
	const pIdx = parentOf.get(hips);
	if (pIdx == null) return { corrected: false };
	const parent = json.nodes[pIdx];

	const r = new Quaternion();
	if (parent.rotation) r.fromArray(parent.rotation);
	if (1 - Math.abs(r.w) < ORIENT_EPS) return { corrected: false }; // already axis-aligned

	// Rotation only commutes with the parent's scale when that scale is uniform.
	const s = parent.scale;
	if (s && (Math.abs(s[0] - s[1]) > ORIENT_EPS || Math.abs(s[1] - s[2]) > ORIENT_EPS)) {
		return { corrected: false };
	}

	const children = Array.isArray(parent.children) ? parent.children : [];
	if (children.length === 0) return { corrected: false };

	// Snapshot the children (for revert) and all affected world matrices (to verify
	// the fold didn't move anything the mesh depends on).
	const checkSet = new Set([...jointIdx, ...children]);
	const before = worldMatricesFor(json, checkSet, parentOf);
	const snapshot = children.map((c) => ({
		idx: c,
		translation: json.nodes[c].translation ? json.nodes[c].translation.slice() : null,
		rotation: json.nodes[c].rotation ? json.nodes[c].rotation.slice() : null,
	}));
	const parentRotBefore = parent.rotation ? parent.rotation.slice() : null;

	for (const c of children) {
		const node = json.nodes[c];
		const t = new Vector3();
		if (node.translation) t.fromArray(node.translation);
		t.applyQuaternion(r);
		node.translation = [t.x, t.y, t.z];
		const cr = new Quaternion();
		if (node.rotation) cr.fromArray(node.rotation);
		cr.premultiply(r);
		node.rotation = [cr.x, cr.y, cr.z, cr.w];
	}
	parent.rotation = [0, 0, 0, 1];

	const after = worldMatricesFor(json, checkSet, parentOf);
	let ok = true;
	for (const idx of checkSet) {
		const a = before.get(idx).elements;
		const b = after.get(idx).elements;
		for (let k = 0; k < 16; k++) {
			if (Math.abs(a[k] - b[k]) > ORIENT_WORLD_EPS) {
				ok = false;
				break;
			}
		}
		if (!ok) break;
	}
	if (!ok) {
		for (const snap of snapshot) {
			const node = json.nodes[snap.idx];
			if (snap.translation) node.translation = snap.translation;
			else delete node.translation;
			if (snap.rotation) node.rotation = snap.rotation;
			else delete node.rotation;
		}
		if (parentRotBefore) parent.rotation = parentRotBefore;
		else delete parent.rotation;
		return { corrected: false };
	}

	const hipsQ = new Quaternion();
	if (json.nodes[hips].rotation) hipsQ.fromArray(json.nodes[hips].rotation);
	return { corrected: true, hipsIdentity: 1 - Math.abs(hipsQ.w) < ORIENT_EPS };
}

/**
 * Canonicalize joint bone names in a GLB ArrayBuffer. Returns a new buffer
 * with renamed nodes (and the count of bones rewritten); the original buffer
 * is left untouched. If no bones needed renaming the original buffer is
 * returned by reference so callers can skip a redundant re-upload.
 *
 * Throws on a malformed GLB header so upload code can surface a clear error.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ buffer: ArrayBuffer, renamed: number, samples: Array<{from:string,to:string}> }}
 */
export function canonicalizeGLBBones(arrayBuffer) {
	if (!(arrayBuffer instanceof ArrayBuffer)) {
		throw new TypeError('canonicalizeGLBBones: ArrayBuffer required');
	}
	if (arrayBuffer.byteLength < 20) {
		throw new Error('canonicalizeGLBBones: buffer too small to be a GLB');
	}
	const view = new DataView(arrayBuffer);
	if (view.getUint32(0, true) !== GLB_MAGIC) {
		throw new Error('canonicalizeGLBBones: not a GLB (bad magic number)');
	}
	if (view.getUint32(4, true) !== 2) {
		throw new Error('canonicalizeGLBBones: only GLB v2 is supported');
	}

	// Parse chunk 0 (JSON, required by spec).
	const c0Len  = view.getUint32(12, true);
	const c0Type = view.getUint32(16, true);
	if (c0Type !== CHUNK_TYPE_JSON) {
		throw new Error('canonicalizeGLBBones: chunk 0 must be JSON');
	}
	const jsonBytes = new Uint8Array(arrayBuffer, 20, c0Len);
	let json;
	try {
		json = JSON.parse(new TextDecoder().decode(jsonBytes));
	} catch (err) {
		throw new Error('canonicalizeGLBBones: JSON chunk parse failed: ' + err.message);
	}

	const { renamed, samples } = canonicalizeJointNodes(json);
	const orientation = canonicalizeArmatureOrientation(json);
	if (renamed === 0 && !orientation.corrected) {
		return { buffer: arrayBuffer, renamed: 0, samples: [], orientationCorrected: false };
	}

	// Repack. Chunk 1 (BIN) is optional — preserve it verbatim if present.
	const c1Offset = 20 + c0Len;
	let c1Len = 0, c1Type = 0, binBytes = null;
	if (c1Offset + 8 <= arrayBuffer.byteLength) {
		c1Len  = view.getUint32(c1Offset, true);
		c1Type = view.getUint32(c1Offset + 4, true);
		binBytes = new Uint8Array(arrayBuffer, c1Offset + 8, c1Len);
	}

	// Re-serialise JSON; GLB requires each chunk's data to be 4-byte aligned,
	// padded with 0x20 (space) for the JSON chunk per the glTF 2.0 spec.
	let newJsonBytes = new TextEncoder().encode(JSON.stringify(json));
	const jsonPad = (4 - (newJsonBytes.length % 4)) % 4;
	if (jsonPad) {
		const padded = new Uint8Array(newJsonBytes.length + jsonPad);
		padded.set(newJsonBytes);
		for (let i = 0; i < jsonPad; i++) padded[newJsonBytes.length + i] = 0x20;
		newJsonBytes = padded;
	}

	const totalLen = 12 + 8 + newJsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
	const out = new ArrayBuffer(totalLen);
	const outView = new DataView(out);
	const outU8   = new Uint8Array(out);

	outView.setUint32(0, GLB_MAGIC, true);
	outView.setUint32(4, 2, true);
	outView.setUint32(8, totalLen, true);

	outView.setUint32(12, newJsonBytes.length, true);
	outView.setUint32(16, CHUNK_TYPE_JSON, true);
	outU8.set(newJsonBytes, 20);

	if (binBytes) {
		const binOffset = 20 + newJsonBytes.length;
		outView.setUint32(binOffset,     c1Len, true);
		outView.setUint32(binOffset + 4, c1Type, true);
		outU8.set(binBytes, binOffset + 8);
	}

	return { buffer: out, renamed, samples, orientationCorrected: orientation.corrected };
}
