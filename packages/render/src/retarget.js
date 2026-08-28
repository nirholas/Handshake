/**
 * Bone-name retargeting for animation-only GLBs.
 * ----------------------------------------------
 * A clip authored on a Mixamo rig and an avatar exported from Ready Player Me,
 * Avaturn, VRoid or Blender agree on the shape of a humanoid skeleton and
 * disagree on almost every bone name. This module normalizes both sides and
 * rebinds the clip's rotation tracks onto whatever skeleton it is handed, so
 * one walk cycle drives every body the platform can produce.
 *
 * Rotations transfer as-is. The root translation is rescaled by the hip-height
 * ratio, which is what stops a tall rig from skating and a short one from
 * sinking through the floor. Scale tracks are dropped: they are authoring
 * noise on every humanoid rig we have met.
 */

const PREFIXES = [/^mixamorig\d*[:_]?/i, /^armature[|:_]/i, /^root[|:]/i, /^bip\d*\s*/i];

const ALIASES = new Map(
	Object.entries({
		hips: 'hips',
		pelvis: 'hips',
		root: 'hips',
		spine: 'spine',
		spine1: 'spine1',
		spine2: 'spine2',
		chest: 'spine1',
		upperchest: 'spine2',
		neck: 'neck',
		head: 'head',
		headtop: 'headtop',
		leftshoulder: 'leftshoulder',
		lshoulder: 'leftshoulder',
		leftarm: 'leftarm',
		leftupperarm: 'leftarm',
		lupperarm: 'leftarm',
		leftforearm: 'leftforearm',
		leftlowerarm: 'leftforearm',
		llowerarm: 'leftforearm',
		lefthand: 'lefthand',
		lhand: 'lefthand',
		rightshoulder: 'rightshoulder',
		rshoulder: 'rightshoulder',
		rightarm: 'rightarm',
		rightupperarm: 'rightarm',
		rupperarm: 'rightarm',
		rightforearm: 'rightforearm',
		rightlowerarm: 'rightforearm',
		rlowerarm: 'rightforearm',
		righthand: 'righthand',
		rhand: 'righthand',
		leftupleg: 'leftupleg',
		leftupperleg: 'leftupleg',
		lupperleg: 'leftupleg',
		leftthigh: 'leftupleg',
		leftleg: 'leftleg',
		leftlowerleg: 'leftleg',
		llowerleg: 'leftleg',
		leftshin: 'leftleg',
		leftfoot: 'leftfoot',
		lfoot: 'leftfoot',
		lefttoebase: 'lefttoe',
		lefttoes: 'lefttoe',
		lefttoe: 'lefttoe',
		rightupleg: 'rightupleg',
		rightupperleg: 'rightupleg',
		rupperleg: 'rightupleg',
		rightthigh: 'rightupleg',
		rightleg: 'rightleg',
		rightlowerleg: 'rightleg',
		rlowerleg: 'rightleg',
		rightshin: 'rightleg',
		rightfoot: 'rightfoot',
		rfoot: 'rightfoot',
		righttoebase: 'righttoe',
		righttoes: 'righttoe',
		righttoe: 'righttoe',
	}),
);

/** Collapse a bone name to a rig-independent key. */
export function normalizeBoneName(name) {
	let out = String(name || '');
	for (const prefix of PREFIXES) out = out.replace(prefix, '');
	// camelCase side suffix, as in `shoulderL` / `handR`. Detected before the
	// lowercase pass, because after it the marker is indistinguishable from the
	// last letter of a word like `shoulder`.
	const camelSide = out.match(/^(.*[a-z0-9])(L|R)$/);
	if (camelSide) out = `${camelSide[2].toLowerCase()}_${camelSide[1]}`;
	out = out.toLowerCase();
	// VRM / VRoid encode the side in the prefix: J_Bip_L_UpperArm.
	const vrm = out.match(/^j_(?:bip|sec|adj|opt)_([clr])_(.+)$/);
	if (vrm) out = (vrm[1] === 'c' ? '' : `${vrm[1]}_`) + vrm[2];
	// Trailing or leading side markers: `Arm.L`, `arm_l`, `l_arm`, `armLeft`.
	out = out.replace(/[._-](l|left)$/i, '#left').replace(/[._-](r|right)$/i, '#right');
	out = out.replace(/^(l|left)[._-]/i, '#left').replace(/^(r|right)[._-]/i, '#right');
	out = out.replace(/[^a-z0-9#]/g, '');
	if (out.includes('#left')) out = `left${out.replace('#left', '')}`;
	else if (out.includes('#right')) out = `right${out.replace('#right', '')}`;
	return ALIASES.get(out) || out;
}

function boneMap(skeleton) {
	const map = new Map();
	for (const bone of skeleton.bones) {
		const key = normalizeBoneName(bone.name);
		if (!map.has(key)) map.set(key, bone);
	}
	return map;
}

function hipsHeight(skeleton) {
	const map = boneMap(skeleton);
	const hips = map.get('hips') || skeleton.bones[0];
	if (!hips) return 1;
	// World height above the skeleton root reads consistently across rigs that
	// disagree about where local space sits.
	const y = hips.getWorldPosition ? hips.getWorldPosition(hips.position.clone()).y : hips.position.y;
	return Math.abs(y) > 1e-4 ? Math.abs(y) : 1;
}

/**
 * Rebind one clip onto `skeleton`. Returns a new AnimationClip, or null when
 * fewer than four bones match (which means the rigs are genuinely unrelated
 * and playing the result would only produce a scramble).
 */
export function retargetClip(clip, skeleton, root) {
	const THREE = clip.constructor;
	const map = boneMap(skeleton);
	const tracks = [];
	let matched = 0;
	let sourceHipsY = 0;

	for (const track of clip.tracks) {
		const dot = track.name.lastIndexOf('.');
		if (dot < 0) continue;
		const nodeName = track.name.slice(0, dot);
		const property = track.name.slice(dot + 1);
		const key = normalizeBoneName(nodeName);
		const bone = map.get(key);
		if (!bone) continue;
		if (property === 'quaternion') {
			const next = track.clone();
			next.name = `${bone.name}.quaternion`;
			tracks.push(next);
			matched++;
		} else if (property === 'position' && key === 'hips') {
			sourceHipsY = Math.abs(track.values[1] || 0);
			const next = track.clone();
			next.name = `${bone.name}.position`;
			tracks.push(next);
		}
	}

	if (matched < 4) return null;

	const targetHipsY = hipsHeight(skeleton);
	if (sourceHipsY > 1e-4) {
		const scale = targetHipsY / sourceHipsY;
		if (Number.isFinite(scale) && scale > 0) {
			for (const track of tracks) {
				if (!track.name.endsWith('.position')) continue;
				for (let i = 0; i < track.values.length; i++) track.values[i] *= scale;
			}
		}
	}

	void root;
	void THREE;
	const Clip = clip.constructor;
	return new Clip(clip.name, clip.duration, tracks);
}
