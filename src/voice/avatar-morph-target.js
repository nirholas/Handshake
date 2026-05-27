/**
 * AvatarMouthTarget — adapter between LipsyncDriver and a loaded GLB.
 *
 * Scans the supplied THREE.Object3D for whatever mouth-shape morphs and jaw
 * bone are available, then translates an abstract { open, wide, round } shape
 * (in [0,1]) into concrete morph weights and/or bone rotation each frame.
 *
 * Supports the three morph-naming conventions we see in the wild on
 * three.ws-bound GLBs without privileging any single rigger:
 *
 *   ARKit blendshapes:  jawOpen, mouthSmileLeft+Right, mouthFunnel, mouthPucker
 *   VRM expressions:    A, I, U, E, O   (aa, ih, ou, ee, oh — case variants)
 *   Generic:            Mouth_Open, Mouth_Wide, Mouth_O, mouthOpen, etc.
 *
 * Falls back to rotating a bone named "Jaw" / "jaw" on the X axis when no
 * mouth morphs are found, so even untracked rigs get *some* mouth motion.
 *
 * Safe to call setMouthShape() before / after the GLB loads — it's a no-op
 * until the model attaches.
 */

// Morph names this adapter knows about, in priority order.
// First match wins per shape channel.
const MORPH_OPEN = [
	'jawOpen', // ARKit
	'mouthOpen', // common
	'Mouth_Open',
	'A', 'a', 'aa', // VRM (Japanese vowel notation)
	'Ah', 'AA',
	'viseme_aa', // Oculus visemes
	'open',
];
const MORPH_WIDE = [
	'mouthSmileLeft', // ARKit (we'll also try Right and pair them)
	'mouthSmile',
	'Mouth_Smile',
	'I', 'i', 'ih',
	'E', 'e', 'ee', 'Ee',
	'viseme_I', 'viseme_E',
	'smile',
	'wide',
];
const MORPH_WIDE_RIGHT = ['mouthSmileRight']; // ARKit pair to mouthSmileLeft
const MORPH_ROUND = [
	'mouthFunnel', // ARKit (oo)
	'mouthPucker', // ARKit (kissy o)
	'Mouth_O',
	'O', 'o', 'oh', 'Oh',
	'U', 'u', 'ou',
	'viseme_O', 'viseme_U',
	'round',
	'funnel',
	'pucker',
];

const JAW_BONE_NAMES = [
	'Jaw', 'jaw',
	'mixamorig:Jaw', 'mixamorigJaw',
	'CC_Base_JawRoot',
	'Bip01_Jaw',
	'J_Bip_C_Jaw',
	'lowerJaw', 'LowerJaw',
	'jaw_01',
	'FACIAL_C_Jaw',
	'JawBone', 'jaw_bone', 'Jaw_bone',
	'lowerFaceJnt',
	'DEF-jaw',
	'ORG-jaw',
];

const HEAD_BONE_NAMES = [
	'Head', 'head',
	'mixamorig:Head', 'mixamorigHead',
	'CC_Base_Head',
	'Bip01_Head',
	'J_Bip_C_Head',
	'head_01',
	'HeadBone', 'head_bone',
	'DEF-spine.006',
	'DEF-head',
	'ORG-head',
];

// Max jaw rotation in radians when there's no morph available. ~12° looks
// like talking without crossing into rictus territory.
const MAX_JAW_ROT = 0.21;

// Max head nod in radians for the head-bone fallback. ~2.5° — subtle enough
// to read as speech cadence without looking like a deliberate nod.
const MAX_HEAD_NOD = 0.044;

export class AvatarMouthTarget {
	constructor() {
		// Each entry: { mesh, idx, channel: 'open'|'wide'|'wideRight'|'round' }
		this._morphBindings = [];
		this._jawBone = null;
		this._jawBaseRotX = 0;
		this._headBone = null;
		this._headBaseRotX = 0;
		this._attached = false;
	}

	/**
	 * Attach to a freshly loaded GLB scene. Scans for mouth morphs + jaw bone.
	 * Calling this a second time replaces the previous binding (useful after
	 * a GLB hot-swap from the customizer).
	 *
	 * @param {THREE.Object3D} root
	 */
	attach(root) {
		this._morphBindings = [];
		this._jawBone = null;
		this._headBone = null;
		this._attached = false;
		if (!root || typeof root.traverse !== 'function') return;

		const meshesWithMorphs = [];
		let headCandidate = null;
		root.traverse((node) => {
			if (node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
				meshesWithMorphs.push(node);
			}
			if (!(node.isBone || node.type === 'Bone')) return;
			const name = String(node.name).toLowerCase();
			if (!this._jawBone && JAW_BONE_NAMES.some((n) => n.toLowerCase() === name)) {
				this._jawBone = node;
				this._jawBaseRotX = node.rotation.x;
			}
			if (!headCandidate && HEAD_BONE_NAMES.some((n) => n.toLowerCase() === name)) {
				headCandidate = node;
			}
		});
		if (!this._jawBone && headCandidate) {
			this._headBone = headCandidate;
			this._headBaseRotX = headCandidate.rotation.x;
		}

		// Per channel: find the first morph name from the priority list that
		// exists on any mesh; bind every mesh that has it.
		this._bindChannel(meshesWithMorphs, 'open', MORPH_OPEN);
		this._bindChannel(meshesWithMorphs, 'wide', MORPH_WIDE);
		this._bindChannel(meshesWithMorphs, 'wideRight', MORPH_WIDE_RIGHT);
		this._bindChannel(meshesWithMorphs, 'round', MORPH_ROUND);

		this._attached = true;
	}

	hasMouthMorphs() {
		return this._morphBindings.some(
			(b) => b.channel === 'open' || b.channel === 'wide' || b.channel === 'round',
		);
	}

	hasJawBone() {
		return !!this._jawBone;
	}

	hasHeadFallback() {
		return !this._jawBone && !!this._headBone;
	}

	hasAnyMouthDriver() {
		return this.hasMouthMorphs() || this.hasJawBone() || this.hasHeadFallback();
	}

	/** Channel diagnostics for debugging which shapes are wired. */
	describe() {
		const channels = {};
		for (const b of this._morphBindings) {
			(channels[b.channel] ||= []).push({ mesh: b.mesh.name, morph: b.morphName });
		}
		return {
			morphs: channels,
			jawBone: this._jawBone ? this._jawBone.name : null,
			headFallback: this._headBone ? this._headBone.name : null,
		};
	}

	/**
	 * Push a shape update into the bound model. Safe before attach (no-op).
	 * Values are clamped to [0,1] for safety; tweens / gain belong upstream.
	 */
	setMouthShape({ open = 0, wide = 0, round = 0 } = {}) {
		if (!this._attached) return;

		open = clamp01(open);
		wide = clamp01(wide);
		round = clamp01(round);

		// Morph drive — write to every binding for the matching channel.
		for (const b of this._morphBindings) {
			let v = 0;
			if (b.channel === 'open') v = open;
			else if (b.channel === 'wide' || b.channel === 'wideRight') v = wide;
			else if (b.channel === 'round') v = round;
			b.mesh.morphTargetInfluences[b.idx] = v;
		}

		// Jaw fallback — only drive if we have no `open` morph, otherwise we'd
		// double-stack and the mouth would look broken.
		if (this._jawBone && !this._channelBound('open')) {
			this._jawBone.rotation.x = this._jawBaseRotX + open * MAX_JAW_ROT;
		}

		// Head micro-nod — last resort when neither morphs nor jaw bone exist.
		// Subtle chin dip (~2.5°) that reads as speech without looking like nodding.
		if (this._headBone && !this._jawBone && !this._channelBound('open')) {
			this._headBone.rotation.x = this._headBaseRotX + open * MAX_HEAD_NOD;
		}
	}

	dispose() {
		this._morphBindings = [];
		this._jawBone = null;
		this._headBone = null;
		this._attached = false;
	}

	// ── internals ────────────────────────────────────────────────────────

	_bindChannel(meshes, channel, names) {
		// Case-insensitive lookup per mesh: pick the first morph in `names` that
		// the mesh has, but also accept any morph whose name *contains* the
		// canonical token (so "MouthOpen_L" matches "mouthOpen").
		const tokens = names.map((n) => n.toLowerCase());
		for (const mesh of meshes) {
			const dict = mesh.morphTargetDictionary;
			const entries = Object.entries(dict);
			let bound = null;
			for (const want of tokens) {
				// Exact (case-insensitive)
				const exact = entries.find(([k]) => k.toLowerCase() === want);
				if (exact) {
					bound = { name: exact[0], idx: exact[1] };
					break;
				}
				// Contains
				const contains = entries.find(([k]) => k.toLowerCase().includes(want));
				if (contains) {
					bound = { name: contains[0], idx: contains[1] };
					break;
				}
			}
			if (bound) {
				this._morphBindings.push({
					mesh,
					idx: bound.idx,
					morphName: bound.name,
					channel,
				});
			}
		}
	}

	_channelBound(channel) {
		return this._morphBindings.some((b) => b.channel === channel);
	}
}

function clamp01(n) {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}
