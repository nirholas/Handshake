// ARKit-52 facial blendshape spec — canonical names + alias map.
//
// Apple's ARKit publishes a stable set of 52 facial blendshapes (53 with the
// `tongueOut` extension). Most modern avatar pipelines either ship these
// names directly (RPM, Avaturn v2, modern Mixamo exports) or use a near-cousin
// naming scheme (camelCase vs underscores, _L/_R vs Left/Right suffixes).
//
// This module exposes:
//   - ARKIT_52: the canonical name list
//   - ARKIT_VISEMES: viseme_* phoneme morphs that ship alongside the 52
//   - MORPH_ALIASES: alternate names → canonical name
//   - resolveMorphTargets(): walks a Three.js root, builds canonical → [{mesh,index}] map
//   - setCanonicalMorph(): apply weight to a canonical morph + auto-split L/R when needed
//   - conformanceReport(): how many of the 52 a given GLB implements
//
// This is the cross-runtime layer that lets emotion + lipsync code refer to
// morphs by their canonical ARKit name and have it just work across RPM,
// Avaturn, custom Blender exports, and procedural variants.

export const ARKIT_52 = Object.freeze([
	// Eyes (14)
	'eyeBlinkLeft', 'eyeBlinkRight',
	'eyeLookDownLeft', 'eyeLookDownRight',
	'eyeLookInLeft', 'eyeLookInRight',
	'eyeLookOutLeft', 'eyeLookOutRight',
	'eyeLookUpLeft', 'eyeLookUpRight',
	'eyeSquintLeft', 'eyeSquintRight',
	'eyeWideLeft', 'eyeWideRight',
	// Jaw (4)
	'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
	// Mouth (23)
	'mouthClose', 'mouthFunnel', 'mouthPucker',
	'mouthLeft', 'mouthRight',
	'mouthSmileLeft', 'mouthSmileRight',
	'mouthFrownLeft', 'mouthFrownRight',
	'mouthDimpleLeft', 'mouthDimpleRight',
	'mouthStretchLeft', 'mouthStretchRight',
	'mouthRollLower', 'mouthRollUpper',
	'mouthShrugLower', 'mouthShrugUpper',
	'mouthPressLeft', 'mouthPressRight',
	'mouthLowerDownLeft', 'mouthLowerDownRight',
	'mouthUpperUpLeft', 'mouthUpperUpRight',
	// Brows (5)
	'browDownLeft', 'browDownRight',
	'browInnerUp',
	'browOuterUpLeft', 'browOuterUpRight',
	// Cheeks (3)
	'cheekPuff',
	'cheekSquintLeft', 'cheekSquintRight',
	// Nose (2)
	'noseSneerLeft', 'noseSneerRight',
	// Tongue (1, Apple's official 53rd)
	'tongueOut',
]);

export const ARKIT_VISEMES = Object.freeze([
	'viseme_aa', 'viseme_CH', 'viseme_DD', 'viseme_E', 'viseme_FF',
	'viseme_I', 'viseme_kk', 'viseme_nn', 'viseme_O', 'viseme_PP',
	'viseme_RR', 'viseme_sil', 'viseme_SS', 'viseme_TH', 'viseme_U',
]);

// Synonyms found in the wild: snake_case, underscored L/R, period dots,
// older Mixamo names, and the abbreviated combined forms the three.ws
// emotion layer historically used. Map each to its canonical ARKit name.
export const MORPH_ALIASES = Object.freeze({
	// snake_case → camelCase variants
	'eye_blink_left': 'eyeBlinkLeft', 'eye_blink_right': 'eyeBlinkRight',
	'eye_squint_left': 'eyeSquintLeft', 'eye_squint_right': 'eyeSquintRight',
	'eye_wide_left': 'eyeWideLeft', 'eye_wide_right': 'eyeWideRight',
	'jaw_open': 'jawOpen', 'jaw_forward': 'jawForward', 'jaw_left': 'jawLeft', 'jaw_right': 'jawRight',
	'mouth_close': 'mouthClose', 'mouth_funnel': 'mouthFunnel', 'mouth_pucker': 'mouthPucker',
	'mouth_smile_left': 'mouthSmileLeft', 'mouth_smile_right': 'mouthSmileRight',
	'mouth_frown_left': 'mouthFrownLeft', 'mouth_frown_right': 'mouthFrownRight',
	'mouth_press_left': 'mouthPressLeft', 'mouth_press_right': 'mouthPressRight',
	'brow_down_left': 'browDownLeft', 'brow_down_right': 'browDownRight',
	'brow_inner_up': 'browInnerUp',
	'brow_outer_up_left': 'browOuterUpLeft', 'brow_outer_up_right': 'browOuterUpRight',
	'cheek_puff': 'cheekPuff',
	'cheek_squint_left': 'cheekSquintLeft', 'cheek_squint_right': 'cheekSquintRight',
	'nose_sneer_left': 'noseSneerLeft', 'nose_sneer_right': 'noseSneerRight',
	'tongue_out': 'tongueOut',
	// _L / _R suffix variants (common in older RPM exports)
	'eyeBlink_L': 'eyeBlinkLeft', 'eyeBlink_R': 'eyeBlinkRight',
	'eyeSquint_L': 'eyeSquintLeft', 'eyeSquint_R': 'eyeSquintRight',
	'eyeWide_L': 'eyeWideLeft', 'eyeWide_R': 'eyeWideRight',
	'mouthSmile_L': 'mouthSmileLeft', 'mouthSmile_R': 'mouthSmileRight',
	'mouthFrown_L': 'mouthFrownLeft', 'mouthFrown_R': 'mouthFrownRight',
	'mouthPress_L': 'mouthPressLeft', 'mouthPress_R': 'mouthPressRight',
	'browDown_L': 'browDownLeft', 'browDown_R': 'browDownRight',
	'browOuterUp_L': 'browOuterUpLeft', 'browOuterUp_R': 'browOuterUpRight',
	'cheekSquint_L': 'cheekSquintLeft', 'cheekSquint_R': 'cheekSquintRight',
	'noseSneer_L': 'noseSneerLeft', 'noseSneer_R': 'noseSneerRight',
	// Combined "single" shapes some pipelines export instead of L/R pairs.
	// Resolved at apply-time via SYMMETRIC_PAIRS, so we map them to the left
	// canonical name and let setCanonicalMorph fan out to the right side.
	'eyeBlink': 'eyeBlinkLeft', 'eyesBlink': 'eyeBlinkLeft',
	'eyeSquint': 'eyeSquintLeft',
	'mouthSmile': 'mouthSmileLeft',
	'mouthFrown': 'mouthFrownLeft',
	'mouthPress': 'mouthPressLeft',
	'browOuterUp': 'browOuterUpLeft',
	'cheekSquint': 'cheekSquintLeft',
	'noseSneer': 'noseSneerLeft',
	// Apple's pre-iOS-12 closed-eye blend
	'eyesClosed': 'eyeBlinkLeft',
	// three.ws-era shorthand kept for backward compatibility with existing
	// avatar code that calls _setMorphTarget('mouthOpen', …) — route to jawOpen.
	'mouthOpen': 'jawOpen',
});

// Canonical morphs that are physically symmetric. Setting one of these via
// setCanonicalMorph('mouthSmileLeft', w) when only a combined 'mouthSmile'
// exists in the mesh fans out to both sides automatically.
const SYMMETRIC_PAIRS = Object.freeze({
	eyeBlinkLeft: 'eyeBlinkRight',
	eyeLookDownLeft: 'eyeLookDownRight',
	eyeLookInLeft: 'eyeLookInRight',
	eyeLookOutLeft: 'eyeLookOutRight',
	eyeLookUpLeft: 'eyeLookUpRight',
	eyeSquintLeft: 'eyeSquintRight',
	eyeWideLeft: 'eyeWideRight',
	mouthSmileLeft: 'mouthSmileRight',
	mouthFrownLeft: 'mouthFrownRight',
	mouthDimpleLeft: 'mouthDimpleRight',
	mouthStretchLeft: 'mouthStretchRight',
	mouthPressLeft: 'mouthPressRight',
	mouthLowerDownLeft: 'mouthLowerDownRight',
	mouthUpperUpLeft: 'mouthUpperUpRight',
	browDownLeft: 'browDownRight',
	browOuterUpLeft: 'browOuterUpRight',
	cheekSquintLeft: 'cheekSquintRight',
	noseSneerLeft: 'noseSneerRight',
});

/**
 * Separator- and case-insensitive lookup: normalized spelling → canonical name.
 * Exporters disagree about case and separators far more often than they
 * disagree about the word itself (`MouthSmile_L`, `mouth-smile-left`,
 * `Mouth Smile Left` are all the same shape), so normalizing before the lookup
 * resolves rigs an exact-match table silently drops.
 */
const _normalizedMorphIndex = (() => {
	const m = new Map();
	const put = (spelling, canonical) => {
		const key = normalizeToken(spelling);
		if (key && !m.has(key)) m.set(key, canonical);
	};
	for (const name of ARKIT_52) put(name, name);
	for (const name of ARKIT_VISEMES) put(name, name);
	for (const [alias, canonical] of Object.entries(MORPH_ALIASES)) put(alias, canonical);
	return m;
})();

function normalizeToken(name) {
	return String(name || '').replace(/[\s_\-.:]/g, '').toLowerCase();
}

/**
 * Resolve one GLB morph-target name to its canonical ARKit-52 / viseme name.
 * Pure and string-only, so the same mapping runs in the browser (over a loaded
 * Three.js mesh) and on the server (over names read straight out of a glTF
 * JSON chunk, with no scene graph and no GPU).
 *
 * @param {string} glbName — the morph target name as authored in the GLB
 * @returns {string | null} canonical name, or null when it is not an ARKit shape
 */
export function canonicalMorphName(glbName) {
	if (!glbName) return null;
	const direct = MORPH_ALIASES[glbName] || glbName;
	if (ARKIT_52.includes(direct) || ARKIT_VISEMES.includes(direct)) return direct;
	return _normalizedMorphIndex.get(normalizeToken(glbName)) || null;
}

/**
 * Report ARKit-52 coverage from morph-target NAMES alone.
 * Same contract as conformanceReport() but takes an iterable of strings, so a
 * caller that never loads the mesh (the capability API, an upload validator)
 * gets the identical answer as the runtime.
 *
 * @param {Iterable<string>} names
 * @returns {{ implemented: string[], missing: string[], coverage: number, visemes: string[], unmapped: string[] }}
 */
export function conformanceFromNames(names) {
	const resolved = new Set();
	const unmapped = [];
	for (const raw of names || []) {
		const canonical = canonicalMorphName(raw);
		if (canonical) resolved.add(canonical);
		else if (raw) unmapped.push(String(raw));
	}
	const implemented = ARKIT_52.filter((name) => resolved.has(name));
	const missing = ARKIT_52.filter((name) => !resolved.has(name));
	return {
		implemented,
		missing,
		coverage: implemented.length / ARKIT_52.length,
		visemes: ARKIT_VISEMES.filter((name) => resolved.has(name)),
		unmapped,
	};
}

/**
 * Walk a Three.js root and build a canonical-name → [{mesh, index}] resolver.
 * Each canonical ARKit-52 name maps to every mesh slot that implements it,
 * either by exact name match or via MORPH_ALIASES.
 *
 * @param {import('three').Object3D} root
 * @returns {Map<string, Array<{mesh: any, index: number}>>}
 */
export function resolveMorphTargets(root) {
	const out = new Map();
	if (!root || typeof root.traverse !== 'function') return out;

	root.traverse((node) => {
		if (!node.isMesh || !node.morphTargetDictionary || !node.morphTargetInfluences) return;
		const dict = node.morphTargetDictionary;
		for (const [glbName, idx] of Object.entries(dict)) {
			const canonical = canonicalMorphName(glbName);
			if (!canonical) continue;
			if (!out.has(canonical)) out.set(canonical, []);
			out.get(canonical).push({ mesh: node, index: idx });
		}
	});

	return out;
}

/**
 * Apply a weight to a canonical ARKit morph across all meshes that implement
 * it. If a paired side is missing (e.g. mesh has only mouthSmileLeft and we
 * set mouthSmileLeft), nothing extra happens. If the mesh has only a combined
 * shape that aliases to this name, the alias map already routes it. The
 * SYMMETRIC_PAIRS fanout applies the same weight to the right side when only
 * the left was requested — useful for emotion code that doesn't care about
 * asymmetric expression.
 *
 * @param {Map} resolved — from resolveMorphTargets()
 * @param {string} canonical — canonical ARKit name
 * @param {number} weight — 0..1
 * @param {object} [opts]
 * @param {boolean} [opts.mirror=true] — fan out to symmetric pair if it exists
 */
export function setCanonicalMorph(resolved, canonical, weight, opts = {}) {
	const mirror = opts.mirror !== false;
	const w = Math.max(0, Math.min(1, weight));

	const apply = (name) => {
		const targets = resolved.get(name);
		if (!targets) return;
		for (const { mesh, index } of targets) {
			mesh.morphTargetInfluences[index] = w;
		}
	};

	apply(canonical);
	if (mirror) {
		const right = SYMMETRIC_PAIRS[canonical];
		if (right) apply(right);
	}
}

/**
 * Report which canonical ARKit-52 morphs an avatar implements.
 * Useful for the avatar uploader to surface coverage gaps in the UI.
 *
 * @param {import('three').Object3D} root
 * @returns {{ implemented: string[], missing: string[], coverage: number }}
 */
export function conformanceReport(root) {
	const resolved = resolveMorphTargets(root);
	const implemented = ARKIT_52.filter((name) => resolved.has(name));
	const missing = ARKIT_52.filter((name) => !resolved.has(name));
	return {
		implemented,
		missing,
		coverage: implemented.length / ARKIT_52.length,
	};
}
