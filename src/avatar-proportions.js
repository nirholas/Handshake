/**
 * Skeleton-space proportions: the second axis of the parametric avatar editor.
 *
 * Morph targets can reshape a limb but they cannot lengthen one: a morph is a
 * fixed set of vertex deltas in bind space, so pulling the hand further from
 * the elbow drags the skin away from the bone that drives it. Length, width and
 * stature live in the *skeleton*: move a joint's rest offset and every vertex
 * weighted to it (and to everything below it) follows, skinning intact.
 *
 * That is what this module does. Each parameter is a ratio around 1.0 that
 * rewrites the rest `position` and/or `scale` of a handful of canonical bones:
 *
 *   offset params  scale a joint's rest offset from its parent → longer shins,
 *                  longer forearms, a longer neck, a wider set of shoulders.
 *   scale params   scale a joint's rest scale → a bigger head, hands, feet.
 *   stature        scales the armature node that parents the whole skeleton →
 *                  a uniformly taller or shorter person.
 *
 * Bone *rotations* are never touched, which is what makes this composable with
 * everything else: the pre-baked clip library keeps driving the rig (it writes
 * rotations plus the root translation, see src/animation-retarget.js), the
 * captured rest frames the retargeter relies on stay valid, and the morph
 * sliders keep working because morph deltas are applied in bind space before
 * skinning.
 *
 * Two things do need to follow a proportion edit:
 *   1. Ground contact. Longer legs push the feet through the floor, so the hips
 *      are lifted by the exact amount the feet moved (measured, not assumed, so
 *      it is correct on any rig). See `computeProportionTransforms`.
 *   2. Root motion. A walk's hip translation is authored at one hip height and
 *      rescaled onto the rig's actual height at bind time. Raise the hips and
 *      that factor is stale: the avatar foot-slides. Callers re-measure via
 *      `AnimationManager.remeasureRigProportions()` after applying.
 *
 * The module is dependency-free on purpose: the same parameter table and the
 * same math run in the browser (Avatar Studio live preview) and on the server
 * (api/_lib/bake.js, which writes the result into the baked GLB), so what the
 * user sculpts is what every downstream viewer loads.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Parameter table: the contract. `id` is the key in appearance.proportions.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} ProportionParam
 * @property {string} id       key in `appearance.proportions`
 * @property {string} label    slider label
 * @property {string} group    UI grouping
 * @property {string} hint     one-line description of what it moves
 * @property {'offset'|'scale'|'stature'} op
 * @property {string[]} bones  canonical bones the op writes to (empty for stature)
 * @property {'all'|'lateral'} [axis] offset axis: whole vector, or model-X only
 * @property {number} min
 * @property {number} max
 */

/** @type {ProportionParam[]} */
export const PROPORTION_PARAMS = Object.freeze([
	{
		id: 'height',
		label: 'Height',
		group: 'Stature',
		hint: 'Overall stature. Scales the whole figure around its feet.',
		op: 'stature',
		bones: [],
		min: 0.85,
		max: 1.15,
	},
	{
		id: 'legLength',
		label: 'Leg Length',
		group: 'Stature',
		hint: 'Shin and thigh length. The hips ride up so the feet stay on the floor.',
		op: 'offset',
		axis: 'all',
		bones: ['LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'],
		min: 0.85,
		max: 1.15,
	},
	{
		id: 'torsoLength',
		label: 'Torso Length',
		group: 'Stature',
		hint: 'Distance from hips to shoulders.',
		op: 'offset',
		axis: 'all',
		bones: ['Spine', 'Spine1', 'Spine2'],
		min: 0.85,
		max: 1.15,
	},
	{
		id: 'neckLength',
		label: 'Neck Length',
		group: 'Stature',
		hint: 'How far the head sits above the shoulders.',
		op: 'offset',
		axis: 'all',
		bones: ['Neck', 'Head'],
		min: 0.8,
		max: 1.25,
	},
	{
		id: 'armLength',
		label: 'Arm Length',
		group: 'Frame',
		hint: 'Forearm and hand reach.',
		op: 'offset',
		axis: 'all',
		bones: ['LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'],
		min: 0.85,
		max: 1.15,
	},
	{
		id: 'shoulderWidth',
		label: 'Shoulder Width',
		group: 'Frame',
		hint: 'How far apart the shoulders sit. Broad frame vs narrow.',
		op: 'offset',
		axis: 'lateral',
		bones: ['LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'],
		min: 0.85,
		max: 1.2,
	},
	{
		id: 'hipWidth',
		label: 'Hip Width',
		group: 'Frame',
		hint: 'How far apart the legs are set at the hip.',
		op: 'offset',
		axis: 'lateral',
		bones: ['LeftUpLeg', 'RightUpLeg'],
		min: 0.85,
		max: 1.2,
	},
	{
		id: 'headSize',
		label: 'Head Size',
		group: 'Extremities',
		hint: 'Scales the head and everything parented to it.',
		op: 'scale',
		bones: ['Head'],
		min: 0.85,
		max: 1.15,
	},
	{
		id: 'handSize',
		label: 'Hand Size',
		group: 'Extremities',
		hint: 'Scales both hands, fingers included.',
		op: 'scale',
		bones: ['LeftHand', 'RightHand'],
		min: 0.85,
		max: 1.2,
	},
	{
		id: 'footSize',
		label: 'Foot Size',
		group: 'Extremities',
		hint: 'Scales both feet. The hips compensate so the soles stay grounded.',
		op: 'scale',
		bones: ['LeftFoot', 'RightFoot'],
		min: 0.85,
		max: 1.2,
	},
]);

export const PROPORTION_PARAM_BY_ID = new Map(PROPORTION_PARAMS.map((p) => [p.id, p]));

/** Ordered UI groups, derived from the table so adding a param needs no UI edit. */
export const PROPORTION_GROUPS = [...new Set(PROPORTION_PARAMS.map((p) => p.group))];

/** Every canonical bone any parameter reads or writes, plus the chain to the floor. */
export const PROPORTION_BONES = Object.freeze([
	...new Set([
		'Hips',
		...PROPORTION_PARAMS.flatMap((p) => p.bones),
		'LeftUpLeg', 'RightUpLeg', 'LeftToeBase', 'RightToeBase',
	]),
]);

/**
 * Bones used to measure ground contact, left/right paired and best-first. The
 * toe is preferred over the ankle because it is the part that actually touches
 * the floor on a standing rig; a rig without toes falls back to the foot.
 */
const GROUND_CHAINS = [
	['LeftToeBase', 'LeftFoot'],
	['RightToeBase', 'RightFoot'],
];

/** A parameter within this of 1.0 is neutral and is dropped on serialization. */
const NEUTRAL_EPSILON = 1e-4;

/* ────────────────────────────────────────────────────────────────────────── *
 * Parameter document
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Clamp an incoming `{ id: ratio }` record to the declared ranges and drop
 * unknown keys, non-finite values, and anything that is neutral anyway. The
 * result is the canonical serialized form: an empty object means "default
 * body", which is why `collapseAppearance` can omit the field entirely.
 *
 * @param {Record<string, number>|null|undefined} raw
 * @returns {Record<string, number>}
 */
export function normalizeProportions(raw) {
	if (!raw || typeof raw !== 'object') return {};
	const out = {};
	for (const param of PROPORTION_PARAMS) {
		const v = Number(raw[param.id]);
		if (!Number.isFinite(v)) continue;
		const clamped = Math.min(param.max, Math.max(param.min, v));
		if (Math.abs(clamped - 1) < NEUTRAL_EPSILON) continue;
		out[param.id] = clamped;
	}
	return out;
}

/** True when two proportion records mean the same body. */
export function proportionsEqual(a, b) {
	const na = normalizeProportions(a);
	const nb = normalizeProportions(b);
	const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
	for (const k of keys) {
		if (Math.abs((na[k] ?? 1) - (nb[k] ?? 1)) > NEUTRAL_EPSILON) return false;
	}
	return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Quaternion / vector helpers: plain objects, no three.js dependency, so the
 * same math runs in the browser, in Node during a bake, and in vitest.
 * ────────────────────────────────────────────────────────────────────────── */

function qMul(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

function qConj(q) {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function qRotate(q, v) {
	// t = 2 · (q.xyz × v);  v' = v + q.w · t + q.xyz × t
	const tx = 2 * (q.y * v.z - q.z * v.y);
	const ty = 2 * (q.z * v.x - q.x * v.z);
	const tz = 2 * (q.x * v.y - q.y * v.x);
	return {
		x: v.x + q.w * tx + q.y * tz - q.z * ty,
		y: v.y + q.w * ty + q.z * tx - q.x * tz,
		z: v.z + q.w * tz + q.x * ty - q.y * tx,
	};
}

const IDENTITY_Q = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function vec3(v, fallback = 0) {
	return {
		x: Number.isFinite(v?.x) ? v.x : fallback,
		y: Number.isFinite(v?.y) ? v.y : fallback,
		z: Number.isFinite(v?.z) ? v.z : fallback,
	};
}

function quat(q) {
	if (!Number.isFinite(q?.x) || !Number.isFinite(q?.w)) return { ...IDENTITY_Q };
	return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The math: pure, rig-agnostic, unit-testable against a synthetic skeleton.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} RestBone
 * @property {{x:number,y:number,z:number}} position   local rest offset from the parent
 * @property {{x:number,y:number,z:number,w:number}} quaternion local rest rotation
 * @property {{x:number,y:number,z:number}} scale      local rest scale
 * @property {string|null} parent  nearest canonical ancestor bone, null for the root
 */

/**
 * Accumulated rest rotation of each bone, expressed in the frame that parents
 * the Hips (the armature frame). Used to project a lateral edit onto the body's
 * true left/right axis on rigs whose bone frames are rotated (Mixamo, VRM),
 * rather than assuming local X is lateral.
 *
 * @param {Map<string, RestBone>} rest
 * @returns {Map<string, {x:number,y:number,z:number,w:number}>}
 */
function accumulatedRestRotations(rest) {
	const out = new Map();
	const resolve = (name, guard) => {
		if (out.has(name)) return out.get(name);
		if (guard.has(name)) return { ...IDENTITY_Q }; // cyclic parent link: treat as root
		guard.add(name);
		const bone = rest.get(name);
		if (!bone) return { ...IDENTITY_Q };
		const parentQ = bone.parent ? resolve(bone.parent, guard) : { ...IDENTITY_Q };
		const q = qMul(parentQ, quat(bone.quaternion));
		out.set(name, q);
		return q;
	};
	for (const name of rest.keys()) resolve(name, new Set());
	return out;
}

/**
 * Position of `bone`'s origin in the armature frame (the Hips' parent), walking
 * the canonical chain with the supplied local transforms. Returns null when the
 * chain is broken.
 *
 * @param {string} name
 * @param {Map<string, RestBone>} rest
 * @param {Map<string, {position?:object, scale?:object}>} overrides edited locals
 * @returns {{x:number,y:number,z:number}|null}
 */
function boneOrigin(name, rest, overrides) {
	const chain = [];
	const seen = new Set();
	for (let cur = name; cur; cur = rest.get(cur)?.parent || null) {
		if (seen.has(cur) || !rest.has(cur)) break;
		seen.add(cur);
		chain.push(cur);
	}
	if (!chain.length || !seen.has(name)) return null;

	let p = { x: 0, y: 0, z: 0 };
	let q = { ...IDENTITY_Q };
	let s = { x: 1, y: 1, z: 1 };
	for (let i = chain.length - 1; i >= 0; i--) {
		const bone = rest.get(chain[i]);
		const edit = overrides.get(chain[i]);
		const local = vec3(edit?.position ?? bone.position);
		const scaled = { x: local.x * s.x, y: local.y * s.y, z: local.z * s.z };
		const rotated = qRotate(q, scaled);
		p = { x: p.x + rotated.x, y: p.y + rotated.y, z: p.z + rotated.z };
		q = qMul(q, quat(bone.quaternion));
		const localScale = vec3(edit?.scale ?? bone.scale, 1);
		s = { x: s.x * localScale.x, y: s.y * localScale.y, z: s.z * localScale.z };
	}
	return p;
}

/**
 * Resolve a proportion record into the new local `position` / `scale` each
 * canonical bone should rest at, plus the uniform stature factor for the
 * armature node.
 *
 * The Hips offset that keeps the feet grounded is measured, not derived from
 * the parameter values: both ground chains are located in the armature frame
 * before and after the edit and the hips move by the average of the two deltas.
 * Averaging cancels the symmetric left/right spread a hip-width edit produces
 * while keeping the vertical (and any forward) correction a length edit needs,
 * and measuring rather than assuming keeps it exact on a rig whose bone frames
 * are rotated.
 *
 * @param {Map<string, RestBone>} rest  bind-pose locals, keyed by canonical bone
 * @param {Record<string, number>} proportions
 * @returns {{ bones: Map<string, {position:{x:number,y:number,z:number}, scale:{x:number,y:number,z:number}}>, stature: number, applied: string[] }}
 */
export function computeProportionTransforms(rest, proportions) {
	const values = normalizeProportions(proportions);
	const applied = [];
	/** @type {Map<string, {position:{x,y,z}, scale:{x,y,z}}>} */
	const bones = new Map();
	let stature = 1;

	if (!(rest instanceof Map) || rest.size === 0) {
		return { bones, stature, applied };
	}

	const accumulated = accumulatedRestRotations(rest);

	const edit = (name) => {
		if (!bones.has(name)) {
			const bone = rest.get(name);
			bones.set(name, {
				position: vec3(bone.position),
				scale: vec3(bone.scale, 1),
			});
		}
		return bones.get(name);
	};

	for (const param of PROPORTION_PARAMS) {
		const k = values[param.id];
		if (k === undefined) continue;

		if (param.op === 'stature') {
			stature = k;
			applied.push(param.id);
			continue;
		}

		let touched = false;
		for (const name of param.bones) {
			const bone = rest.get(name);
			if (!bone) continue;
			const target = edit(name);
			touched = true;

			if (param.op === 'scale') {
				target.scale = { x: target.scale.x * k, y: target.scale.y * k, z: target.scale.z * k };
				continue;
			}

			if (param.axis === 'lateral') {
				// Scale only the body's left/right component. The offset is authored
				// in the parent's frame, so rotate it into the armature frame, scale
				// X there, and rotate it back, correct whatever the bone frame is.
				const parentQ = bone.parent ? accumulated.get(bone.parent) || IDENTITY_Q : IDENTITY_Q;
				const inArmature = qRotate(parentQ, target.position);
				inArmature.x *= k;
				target.position = qRotate(qConj(parentQ), inArmature);
			} else {
				target.position = {
					x: target.position.x * k,
					y: target.position.y * k,
					z: target.position.z * k,
				};
			}
		}
		if (touched) applied.push(param.id);
	}

	// Ground compensation. Nothing to do when no bone offset or scale moved.
	if (bones.size > 0 && rest.has('Hips')) {
		const deltas = [];
		for (const chain of GROUND_CHAINS) {
			const name = chain.find((n) => rest.has(n));
			if (!name) continue;
			const before = boneOrigin(name, rest, new Map());
			const after = boneOrigin(name, rest, bones);
			if (!before || !after) continue;
			deltas.push({ x: before.x - after.x, y: before.y - after.y, z: before.z - after.z });
		}
		if (deltas.length) {
			const lift = deltas.reduce(
				(acc, d) => ({ x: acc.x + d.x / deltas.length, y: acc.y + d.y / deltas.length, z: acc.z + d.z / deltas.length }),
				{ x: 0, y: 0, z: 0 },
			);
			if (Math.abs(lift.x) > 1e-9 || Math.abs(lift.y) > 1e-9 || Math.abs(lift.z) > 1e-9) {
				const hips = edit('Hips');
				hips.position = {
					x: hips.position.x + lift.x,
					y: hips.position.y + lift.y,
					z: hips.position.z + lift.z,
				};
			}
		}
	}

	return { bones, stature, applied };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * three.js binding: rest capture and live application
 * ────────────────────────────────────────────────────────────────────────── */

/** Rest state per loaded model root. Dropped with the model. */
const REST_BY_ROOT = new WeakMap();

/**
 * Fallback canonical-bone resolver used when the caller supplies no bone map.
 * Strips the rigger prefixes and separators we see most often. Callers that
 * need the full variant coverage (VRM, Unreal, Daz, …) pass an explicit map
 * built from `canonicalizeBoneName` in src/glb-canonicalize.js.
 */
function simpleCanonicalKey(name) {
	return String(name || '')
		.replace(/^mixamorig\d*[_:]?/i, '')
		.replace(/^CC_Base_/i, '')
		.replace(/^(rig_|DEF-|ORG-|Armature[_:|/])/i, '')
		.replace(/[^a-z0-9]/gi, '')
		.toLowerCase();
}

const SIMPLE_KEY_TO_CANONICAL = new Map(
	PROPORTION_BONES.map((b) => [simpleCanonicalKey(b), b]),
);

/**
 * Locate the canonical bones this module edits on a loaded model.
 *
 * @param {object} root three.js Object3D
 * @param {Map<string, object>|null} [boneMap] canonical → node, when the caller
 *   has already resolved the rig (preferred: it covers every naming convention)
 * @returns {Map<string, object>}
 */
function resolveBones(root, boneMap) {
	const out = new Map();
	if (boneMap instanceof Map) {
		for (const name of PROPORTION_BONES) {
			const node = boneMap.get(name);
			if (node?.isObject3D) out.set(name, node);
		}
		// Only trust the supplied map when it resolved the root of the chain, 
		// without Hips there is nothing to measure ground contact against, and a
		// full traversal may still find it.
		if (out.has('Hips')) return out;
		out.clear();
	}
	root?.traverse?.((node) => {
		if (!node?.name) return;
		const canonical = SIMPLE_KEY_TO_CANONICAL.get(simpleCanonicalKey(node.name));
		if (canonical && !out.has(canonical)) out.set(canonical, node);
	});
	return out;
}

/**
 * Capture the model's bind-pose skeleton so proportion edits are always applied
 * from rest rather than compounding on the last edit.
 *
 * MUST be called while the model is in its authored bind pose, i.e. right
 * after the GLB loads and before any clip plays. A capture taken mid-animation
 * bakes that frame's pose in as "rest" and the avatar drifts on every slider.
 * Idempotent: a second call on the same root returns the existing capture
 * unless `{ force: true }`.
 *
 * @param {object} root three.js Object3D
 * @param {{ boneMap?: Map<string, object>, force?: boolean }} [opts]
 * @returns {{ bones: Map<string, object>, rest: Map<string, RestBone>, armature: object|null } | null}
 */
export function captureProportionRest(root, opts = {}) {
	if (!root) return null;
	const existing = REST_BY_ROOT.get(root);
	if (existing && !opts.force) return existing;

	const bones = resolveBones(root, opts.boneMap);
	if (!bones.has('Hips')) return null;

	// Nearest canonical ancestor of each bone, so the pure math can walk chains
	// without knowing anything about the graph.
	const nodeToCanonical = new Map();
	for (const [canonical, node] of bones) nodeToCanonical.set(node, canonical);
	const parentOf = (node) => {
		for (let n = node.parent; n; n = n.parent) {
			const canonical = nodeToCanonical.get(n);
			if (canonical) return canonical;
		}
		return null;
	};

	/** @type {Map<string, RestBone>} */
	const rest = new Map();
	for (const [canonical, node] of bones) {
		rest.set(canonical, {
			position: vec3(node.position),
			quaternion: quat(node.quaternion),
			scale: vec3(node.scale, 1),
			parent: parentOf(node),
		});
	}

	// The node that parents the whole skeleton (`Armature`, `ParametricBase`, …).
	// Stature scales it, which moves the skeleton and the skinned meshes hanging
	// off it together. When the Hips are parented straight to the model root we
	// leave it null rather than scale a node the viewer also owns, the Height
	// slider then simply isn't offered (see `availableProportionParams`).
	const hips = bones.get('Hips');
	const armature = hips.parent && hips.parent !== root ? hips.parent : null;

	const state = {
		bones,
		rest,
		armature,
		armatureRestScale: armature ? vec3(armature.scale, 1) : null,
	};
	REST_BY_ROOT.set(root, state);
	return state;
}

/**
 * Which parameters this rig can actually honour. A slider whose bones are
 * missing would be a dead control, and the sculpt panel's rule is that what the
 * user sees is what the rig can do.
 *
 * @param {object} root
 * @param {{ boneMap?: Map<string, object> }} [opts]
 * @returns {string[]} parameter ids
 */
export function availableProportionParams(root, opts = {}) {
	const state = captureProportionRest(root, opts);
	if (!state) return [];
	return PROPORTION_PARAMS.filter((p) => {
		if (p.op === 'stature') return !!state.armature;
		return p.bones.some((b) => state.rest.has(b));
	}).map((p) => p.id);
}

/**
 * Apply a proportion record to a loaded model, from rest.
 *
 * Restores every captured bone (rotation included) to its bind transform first,
 * so the result is a function of the record alone and repeated edits never
 * compound. The rotation reset is what makes the measurement below trustworthy;
 * a running mixer re-poses the rig on its next tick, so it is invisible.
 *
 * @param {object} root three.js Object3D
 * @param {Record<string, number>} proportions
 * @param {{ boneMap?: Map<string, object> }} [opts]
 * @returns {{ applied: string[], stature: number } | null} null when the rig has no usable skeleton
 */
export function applyProportionsToRoot(root, proportions, opts = {}) {
	const state = captureProportionRest(root, opts);
	if (!state) return null;

	// Rest first: bone locals AND rotations, so a re-apply is idempotent and the
	// ground measurement reads the bind pose.
	for (const [canonical, node] of state.bones) {
		const bone = state.rest.get(canonical);
		if (!bone) continue;
		node.position.set(bone.position.x, bone.position.y, bone.position.z);
		node.quaternion.set(bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w);
		node.scale.set(bone.scale.x, bone.scale.y, bone.scale.z);
	}
	if (state.armature && state.armatureRestScale) {
		const s = state.armatureRestScale;
		state.armature.scale.set(s.x, s.y, s.z);
	}

	const { bones, stature, applied } = computeProportionTransforms(state.rest, proportions);
	for (const [canonical, local] of bones) {
		const node = state.bones.get(canonical);
		if (!node) continue;
		node.position.set(local.position.x, local.position.y, local.position.z);
		node.scale.set(local.scale.x, local.scale.y, local.scale.z);
	}
	if (state.armature && state.armatureRestScale && stature !== 1) {
		const s = state.armatureRestScale;
		state.armature.scale.set(s.x * stature, s.y * stature, s.z * stature);
	}

	root.updateMatrixWorld?.(true);
	return { applied, stature };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Panel: rendered inside the Sculpt tab, above the morph groups
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Markup for the Proportions group. Returns '' when the rig supports none of
 * the parameters, so the caller can concatenate it unconditionally.
 *
 * @param {string[]} availableIds ids from {@link availableProportionParams}
 * @param {Record<string, number>} proportions current values
 * @returns {string}
 */
export function proportionsGroupHtml(availableIds, proportions) {
	const available = new Set(availableIds || []);
	const params = PROPORTION_PARAMS.filter((p) => available.has(p.id));
	if (!params.length) return '';

	const values = normalizeProportions(proportions);
	const changed = params.filter((p) => values[p.id] !== undefined).length;

	const sections = PROPORTION_GROUPS.map((group) => {
		const rows = params.filter((p) => p.group === group);
		if (!rows.length) return '';
		return `
			<div class="ae-prop-section">
				<h4 class="ae-prop-heading">${escHtml(group)}</h4>
				${rows.map((p) => proportionRow(p, values[p.id] ?? 1)).join('')}
			</div>`;
	}).join('');

	return `
		<details class="ae-sculpt-group ae-prop-group" open>
			<summary>
				<span>Proportions</span>
				<span class="ae-sculpt-count" id="ae-prop-count">${changed ? `${changed} changed` : 'default'}</span>
			</summary>
			<div class="ae-sculpt-rows ae-prop-rows">
				<p class="ae-prop-note">
					Bone-level build: length, width and stature. Morph sliders reshape;
					these re-proportion. Double-click a slider to reset it.
				</p>
				${sections}
				<button class="ae-btn" type="button" id="ae-prop-reset">Reset proportions</button>
			</div>
		</details>`;
}

function proportionRow(param, value) {
	return `
		<div class="ae-sculpt-row ae-prop-row">
			<div class="ae-sculpt-label">
				<span class="ae-sculpt-name" title="${escAttr(param.hint)}">${escHtml(param.label)}</span>
			</div>
			<input
				type="range"
				min="${param.min}" max="${param.max}" step="0.005"
				value="${value}"
				data-prop="${escAttr(param.id)}"
				aria-label="${escAttr(param.label)}"
			/>
			<output class="ae-sculpt-value" data-prop-for="${escAttr(param.id)}">${formatRatio(value)}</output>
		</div>`;
}

/** Human-readable ratio: 1 → "default", 1.06 → "+6%", 0.94 → "-6%". */
export function formatRatio(value) {
	const pct = Math.round((Number(value) - 1) * 1000) / 10;
	if (Math.abs(pct) < 0.05) return 'default';
	return `${pct > 0 ? '+' : ''}${pct}%`;
}

/**
 * Wire the Proportions sliders. Each input applies live to the rig; the rig
 * re-measure (root-motion rescale) is debounced because it rebuilds every bound
 * action and a slider drag fires dozens of events a second.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {object} opts.root three.js Object3D
 * @param {object} opts.working appearance object (we own `.proportions`)
 * @param {Map<string, object>} [opts.boneMap]
 * @param {() => void} [opts.onDirty]
 * @param {() => void} [opts.onRigChanged] called after the skeleton settles
 * @param {() => void} [opts.rerender] re-render the panel (used by Reset)
 */
export function wireProportionsGroup({ container, root, working, boneMap, onDirty, onRigChanged, rerender }) {
	const inputs = container.querySelectorAll('input[type="range"][data-prop]');
	if (!inputs.length) return;

	working.proportions = normalizeProportions(working.proportions);
	const countEl = container.querySelector('#ae-prop-count');

	let rigTimer = null;
	const scheduleRigChange = () => {
		if (!onRigChanged) return;
		if (rigTimer) clearTimeout(rigTimer);
		rigTimer = setTimeout(() => {
			rigTimer = null;
			onRigChanged();
		}, 140);
	};

	const commit = () => {
		applyProportionsToRoot(root, working.proportions, { boneMap });
		if (countEl) {
			const n = Object.keys(working.proportions).length;
			countEl.textContent = n ? `${n} changed` : 'default';
		}
		onDirty?.();
		scheduleRigChange();
	};

	inputs.forEach((input) => {
		const id = input.dataset.prop;
		const param = PROPORTION_PARAM_BY_ID.get(id);
		if (!param) return;
		const valEl = container.querySelector(`output[data-prop-for="${cssEscape(id)}"]`);

		const onChange = () => {
			const v = Math.min(param.max, Math.max(param.min, Number(input.value)));
			if (Math.abs(v - 1) < NEUTRAL_EPSILON) delete working.proportions[id];
			else working.proportions[id] = v;
			if (valEl) valEl.textContent = formatRatio(v);
			commit();
		};
		input.addEventListener('input', onChange);
		input.addEventListener('dblclick', () => {
			input.value = '1';
			onChange();
		});
	});

	container.querySelector('#ae-prop-reset')?.addEventListener('click', () => {
		working.proportions = {};
		applyProportionsToRoot(root, working.proportions, { boneMap });
		onDirty?.();
		scheduleRigChange();
		rerender?.();
	});
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function escHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function escAttr(s) { return escHtml(s); }
function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
