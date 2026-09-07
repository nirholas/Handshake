// Rig report — read a GLB's glTF JSON chunk and answer the one question every
// creator asks before they upload: "will this thing actually move on three.ws?"
//
// The answer has always existed, but only after an upload, a conversion, and a
// look at the result. That is a slow, discouraging loop, and the failure mode is
// silent: a rig whose bones are named `Bip001 L UpperArm` loads fine, renders
// fine, and then stands in a frozen T-pose forever because the clip library's
// tracks address `LeftArm`. This module moves that verdict to the front of the
// funnel and makes it local.
//
// Everything here is a pure function of the GLB bytes. No network, no WebGL, no
// DOM. That is what lets the browser run it on a file the user never uploads,
// and what lets the test suite run it on fixtures without a headless GPU.
//
// The verdict deliberately mirrors AnimationManager's runtime gate
// (`_modelSupportsCanonicalClips`: a SkinnedMesh plus >= MIN_CANONICAL_BONES
// name-mapped joints) rather than approximating it. If this file and that gate
// ever disagree, this file is wrong: the runtime is the product.

import { canonicalizeBoneName, CANONICAL_BONES } from './glb-canonicalize.js';

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'

/** Mirrors MIN_CANONICAL_BONES in src/animation-manager.js. */
export const MIN_CANONICAL_BONES = 8;

/** Total joints in the canonical set, so coverage reads as a real fraction. */
export const CANONICAL_TOTAL = CANONICAL_BONES.length;

// Limb groups, in the order a person reads a body. Each group is scored on its
// own because "62% covered" tells a creator nothing actionable, while "arms and
// torso yes, legs no" tells them their character will glide instead of walk.
// The `key` bones are the ones whose absence is visible in motion; finger joints
// are counted but never gate a group, since a walk cycle survives without them.
export const LIMB_GROUPS = Object.freeze([
	{
		id: 'torso',
		label: 'Torso',
		blurb: 'Root motion, sway, and the anchor every other track hangs off.',
		bones: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'],
		key: ['Hips'],
	},
	{
		id: 'arms',
		label: 'Arms',
		blurb: 'Waves, claps, gestures. Unmapped arms freeze at the bind pose.',
		bones: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'],
		key: ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'],
	},
	{
		id: 'hands',
		label: 'Hands',
		blurb: 'Finger joints. Required for sign language and detailed emotes.',
		bones: CANONICAL_BONES.filter((b) => /Hand(Index|Middle|Pinky|Ring|Thumb)/.test(b)),
		key: ['LeftHandIndex1', 'RightHandIndex1'],
	},
	{
		id: 'legs',
		label: 'Legs',
		blurb: 'Walk and run cycles. Without these the avatar slides across the floor.',
		bones: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'],
		key: ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'],
	},
]);

// Skeleton-convention fingerprints, most specific first. `test` sees the raw
// joint-name list plus the node/mesh names, because some conventions are only
// identifiable from what surrounds the skeleton (Ready Player Me ships Mixamo
// bone names and is distinguishable solely by its `Wolf3D_*` mesh nodes).
//
// `schema` maps onto the avatar-manifest `skeleton` enum
// (packages/avatar-schema/schema/avatar.v1.json), so the generated manifest
// declares the right value instead of defaulting everything to `custom`.
export const CONVENTIONS = [
	{
		id: 'rpm', label: 'Ready Player Me', schema: 'rpm',
		test: (ctx) => ctx.meshNames.some((n) => /^Wolf3D_/i.test(n)) && ctx.joints.some((n) => /Hips$/i.test(n)),
		evidence: 'Wolf3D_* mesh nodes alongside a Mixamo-named skeleton',
	},
	{
		id: 'mixamo', label: 'Mixamo', schema: 'mixamo',
		test: (ctx) => ctx.joints.some((n) => /^mixamorig\d*[_:]/i.test(n)),
		evidence: 'mixamorig: joint prefix',
	},
	{
		id: 'vrm', label: 'VRM / VRoid', schema: 'vrm-humanoid',
		test: (ctx) => ctx.joints.some((n) => /^J_(Bip|Sec|Adj)_/i.test(n)),
		evidence: 'J_Bip_* humanoid joint names',
	},
	{
		id: 'mmd', label: 'MikuMikuDance (PMX/PMD)', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^(センター|上半身2?|下半身|[左右](腕|ひじ|ひざ|手首|足首))$/.test(n)),
		evidence: 'Japanese PMX bone names (センター / 上半身 / 左腕)',
	},
	{
		id: 'reallusion', label: 'Reallusion Character Creator', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^CC_Base_/i.test(n)),
		evidence: 'CC_Base_* joint prefix',
	},
	{
		id: 'unreal', label: 'Unreal Engine mannequin', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^pelvis$/i.test(n)) && ctx.joints.some((n) => /^(thigh|calf|clavicle|upperarm)_[lr]$/i.test(n)),
		evidence: 'pelvis / thigh_l / clavicle_l mannequin naming',
	},
	{
		id: 'biped', label: '3ds Max Biped', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^Bip\d+[\s_]/i.test(n)),
		evidence: 'Bip01/Bip001 joint prefix',
	},
	{
		id: 'rigify', label: 'Blender Rigify', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^(DEF|ORG|MCH)[-_]/i.test(n)),
		evidence: 'DEF-/ORG-/MCH- Rigify bone layers',
	},
	{
		id: 'humanik', label: 'Autodesk HumanIK / MotionBuilder', schema: 'custom',
		test: (ctx) => ctx.joints.filter((n) => /^[A-Za-z]\w*:/.test(n) && !/^mixamorig/i.test(n)).length >= 4,
		evidence: 'character-namespaced joints (Character1:Hips)',
	},
	{
		id: 'daz', label: 'Daz Genesis', schema: 'custom',
		test: (ctx) => ctx.joints.some((n) => /^(lShldr|rShldr|abdomen|lThigh|rThigh)/i.test(n)),
		evidence: 'Daz lShldr / abdomen / lThigh naming',
	},
	{
		id: 'makehuman', label: 'MakeHuman / Blender side-suffix', schema: 'custom',
		test: (ctx) => ctx.joints.filter((n) => /\.[LR]$/.test(n)).length >= 4,
		evidence: 'Blender .L/.R side suffixes',
	},
	{
		id: 'avaturn', label: 'Avaturn / three.ws canonical', schema: 'avaturn',
		test: (ctx) => {
			const set = new Set(ctx.joints);
			return ['Hips', 'Spine2', 'LeftUpLeg', 'RightForeArm'].every((b) => set.has(b));
		},
		evidence: 'joint names already match the canonical set exactly',
	},
];

// Oculus/OVR viseme set — what the lip-sync pipeline drives. An avatar missing
// these can still animate; it just cannot speak with its mouth.
const OVR_VISEMES = ['viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_kk', 'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'];
// A representative ARKit blendshape slice. Presence of these means the face can
// be driven expressively (brows, jaw, smile) rather than just phonetically.
const ARKIT_SAMPLE = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'eyeBlinkLeft', 'eyeBlinkRight'];

/**
 * Read the glTF JSON chunk out of a GLB ArrayBuffer.
 * Kept separate from analysis so a caller can inspect the raw document.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ json: object, jsonBytes: number, binBytes: number }}
 * @throws {Error} with a message written for a human, not a stack trace
 */
export function readGlbJson(buffer) {
	if (!(buffer instanceof ArrayBuffer)) throw new TypeError('readGlbJson: ArrayBuffer required');
	if (buffer.byteLength < 20) throw new Error('This file is too small to be a GLB.');
	const view = new DataView(buffer);
	if (view.getUint32(0, true) !== GLB_MAGIC) {
		throw new Error('Not a binary glTF. Export as .glb (binary), not .gltf (JSON) or .fbx.');
	}
	if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 binaries are supported.');
	const c0Len = view.getUint32(12, true);
	if (view.getUint32(16, true) !== CHUNK_TYPE_JSON) throw new Error('Malformed GLB: the first chunk is not JSON.');
	if (20 + c0Len > buffer.byteLength) throw new Error('Malformed GLB: the JSON chunk runs past the end of the file.');
	let json;
	try {
		json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, c0Len)));
	} catch (err) {
		throw new Error(`Malformed GLB: the JSON chunk did not parse (${err.message}).`);
	}
	const binOffset = 20 + c0Len;
	const binBytes = binOffset + 8 <= buffer.byteLength ? view.getUint32(binOffset, true) : 0;
	return { json, jsonBytes: c0Len, binBytes };
}

// Every node index reachable from skins[].joints[]. This is the authoritative
// definition of "is a bone" — a node named `Head` that no skin references is a
// prop, and counting it would inflate coverage on a rig that cannot deform.
function jointNodeIndices(json) {
	const set = new Set();
	for (const skin of json.skins || []) {
		for (const j of skin.joints || []) set.add(j);
	}
	return set;
}

export function detectConvention(ctx) {
	for (const c of CONVENTIONS) {
		let hit = false;
		try {
			hit = c.test(ctx);
		} catch {
			hit = false;
		}
		if (hit) return { id: c.id, label: c.label, schema: c.schema, evidence: c.evidence };
	}
	return { id: 'unknown', label: 'Unrecognised', schema: 'custom', evidence: 'no known vendor fingerprint in the joint names' };
}

// Triangles across every primitive, honouring the glTF `mode` enum: only modes
// 4/5/6 (TRIANGLES, STRIP, FAN) produce triangles, and strips/fans yield
// count-2 rather than count/3. Getting this wrong would misreport a stylised
// low-poly avatar as three times heavier than it is.
function countGeometry(json) {
	const accessors = json.accessors || [];
	let triangles = 0;
	let vertices = 0;
	let primitives = 0;
	for (const mesh of json.meshes || []) {
		for (const prim of mesh.primitives || []) {
			primitives++;
			const posIdx = prim.attributes?.POSITION;
			const vcount = posIdx != null ? accessors[posIdx]?.count || 0 : 0;
			vertices += vcount;
			const mode = prim.mode == null ? 4 : prim.mode;
			const elements = prim.indices != null ? accessors[prim.indices]?.count || 0 : vcount;
			if (mode === 4) triangles += Math.floor(elements / 3);
			else if (mode === 5 || mode === 6) triangles += Math.max(0, elements - 2);
		}
	}
	return { triangles, vertices, primitives, meshes: (json.meshes || []).length };
}

function collectTextures(json) {
	const views = json.bufferViews || [];
	return (json.images || []).map((img, i) => {
		const bytes = img.bufferView != null ? views[img.bufferView]?.byteLength || 0 : 0;
		return {
			index: i,
			name: img.name || `image_${i}`,
			mimeType: img.mimeType || (img.uri ? guessMime(img.uri) : 'unknown'),
			bytes,
			external: !!img.uri && !/^data:/i.test(img.uri),
		};
	});
}

function guessMime(uri) {
	if (/^data:([^;,]+)/i.test(uri)) return uri.match(/^data:([^;,]+)/i)[1];
	if (/\.png$/i.test(uri)) return 'image/png';
	if (/\.jpe?g$/i.test(uri)) return 'image/jpeg';
	if (/\.webp$/i.test(uri)) return 'image/webp';
	if (/\.ktx2$/i.test(uri)) return 'image/ktx2';
	return 'unknown';
}

// Morph-target names live on mesh.extras.targetNames (the glTF convention every
// major exporter follows) rather than on the targets themselves. Union them
// across meshes so a head-and-body split avatar reports one coherent set.
function collectMorphs(json) {
	const names = new Set();
	for (const mesh of json.meshes || []) {
		const fromMesh = mesh.extras?.targetNames;
		if (Array.isArray(fromMesh)) fromMesh.forEach((n) => typeof n === 'string' && names.add(n));
		for (const prim of mesh.primitives || []) {
			const fromPrim = prim.extras?.targetNames;
			if (Array.isArray(fromPrim)) fromPrim.forEach((n) => typeof n === 'string' && names.add(n));
		}
	}
	const list = [...names];
	const lower = new Set(list.map((n) => n.toLowerCase()));
	const visemes = OVR_VISEMES.filter((v) => lower.has(v.toLowerCase()));
	const arkit = ARKIT_SAMPLE.filter((v) => lower.has(v.toLowerCase()));
	return {
		total: list.length,
		names: list,
		visemes,
		visemeCount: visemes.length,
		visemeComplete: visemes.length === OVR_VISEMES.length,
		arkit,
		arkitCount: arkit.length,
		lipSync: visemes.length >= 8,
	};
}

/**
 * Full diagnostic for a GLB, ready to render.
 *
 * @param {ArrayBuffer} buffer raw .glb bytes
 * @param {{ fileName?: string }} [opts]
 * @returns {object} report; never throws for a readable GLB
 * @throws {Error} only when the bytes are not a readable glTF 2.0 binary
 */
export function analyzeGlb(buffer, opts = {}) {
	const { json, jsonBytes, binBytes } = readGlbJson(buffer);
	const nodes = json.nodes || [];
	const jointIdx = jointNodeIndices(json);

	// Skinned = at least one mesh primitive is bound to a skin. This is the
	// glTF-level equivalent of three.js's `node.isSkinnedMesh` check, which the
	// runtime gate uses; a skinless mesh cannot be deformed by any clip.
	const skinned = nodes.some((n) => n.skin != null && n.mesh != null);

	const joints = [...jointIdx].map((i) => nodes[i]?.name || '').filter(Boolean);
	const meshNames = nodes.filter((n) => n.mesh != null).map((n) => n.name || '');

	// canonical → the first source joint that claimed it. Later duplicates are
	// recorded as collisions rather than silently overwriting, because a rig
	// with two nodes both mapping to `Hips` is a real authoring bug worth naming.
	const mapped = new Map();
	const collisions = [];
	const unmapped = [];
	const renames = [];
	for (const name of joints) {
		const canonical = canonicalizeBoneName(name);
		if (!canonical) {
			unmapped.push(name);
			continue;
		}
		if (mapped.has(canonical)) collisions.push({ canonical, names: [mapped.get(canonical), name] });
		else mapped.set(canonical, name);
		if (name !== canonical) renames.push({ from: name, to: canonical });
	}

	const convention = detectConvention({ joints, meshNames, json });
	const groups = LIMB_GROUPS.map((g) => {
		const have = g.bones.filter((b) => mapped.has(b));
		const keyHave = g.key.filter((b) => mapped.has(b));
		return {
			id: g.id,
			label: g.label,
			blurb: g.blurb,
			have: have.length,
			total: g.bones.length,
			pct: g.bones.length ? Math.round((have.length / g.bones.length) * 100) : 0,
			driven: keyHave.length === g.key.length,
			missingKey: g.key.filter((b) => !mapped.has(b)),
		};
	});

	const geometry = countGeometry(json);
	const textures = collectTextures(json);
	const morphs = collectMorphs(json);
	const animations = (json.animations || []).map((a, i) => ({
		name: a.name || `animation_${i}`,
		channels: (a.channels || []).length,
	}));

	const drivable = skinned && mapped.size >= MIN_CANONICAL_BONES;
	const report = {
		fileName: opts.fileName || 'model.glb',
		bytes: buffer.byteLength,
		jsonBytes,
		binBytes,
		generator: json.asset?.generator || 'unknown',
		gltfVersion: json.asset?.version || '2.0',
		extensions: [...new Set([...(json.extensionsUsed || []), ...(json.extensionsRequired || [])])].sort(),
		extensionsRequired: json.extensionsRequired || [],
		counts: {
			nodes: nodes.length,
			meshes: geometry.meshes,
			materials: (json.materials || []).length,
			textures: (json.textures || []).length,
			images: textures.length,
			skins: (json.skins || []).length,
			animations: animations.length,
		},
		geometry,
		textures,
		textureBytes: textures.reduce((sum, t) => sum + t.bytes, 0),
		morphs,
		animations,
		skeleton: {
			skinned,
			jointCount: joints.length,
			joints,
			convention,
			mapped: mapped.size,
			total: CANONICAL_TOTAL,
			pct: Math.round((mapped.size / CANONICAL_TOTAL) * 100),
			mappedNames: Object.fromEntries(mapped),
			unmapped,
			collisions,
			renames,
			groups,
		},
	};
	report.verdict = buildVerdict(report, drivable);
	return report;
}

// The verdict is the whole product: one sentence a creator can act on, plus the
// specific reasons behind it. Ordering matters — the first blocker a creator can
// actually fix should be the first thing they read.
function buildVerdict(report, drivable) {
	const s = report.skeleton;
	const notes = [];
	const fixes = [];

	if (!s.skinned) {
		return {
			level: 'fail',
			headline: 'This model has no skinned mesh, so no clip can deform it.',
			detail: 'three.ws will still display it, but it will render as a static prop and every animation control is hidden.',
			notes: [s.jointCount ? `${s.jointCount} joints found, but no mesh is bound to a skin.` : 'No skin definitions at all.'],
			fixes: ['Re-export with skinning enabled, or host the mesh and run it through the auto-rigger (POST /api/forge?action=rig with a glb_url) to get a humanoid skeleton bound to it.'],
			drivable: false,
		};
	}

	if (!drivable) {
		return {
			level: 'fail',
			headline: `Only ${s.mapped} of this rig's joints map to the canonical skeleton, under the ${MIN_CANONICAL_BONES} needed to drive a clip.`,
			detail: 'three.ws falls back to the default rig for models like this rather than leaving them in a T-pose, so your own mesh will not be the one moving.',
			notes: [
				`Detected convention: ${s.convention.label} (${s.convention.evidence}).`,
				s.unmapped.length ? `${s.unmapped.length} joint names were not recognised, including ${s.unmapped.slice(0, 3).join(', ')}.` : 'The skeleton has very few joints.',
			],
			fixes: [
				'Rename the joints to the canonical set below, or let the auto-rigger rebuild the skeleton (POST /api/forge?action=rig).',
				'If this is a common rig convention we should already know, the unmapped names below are exactly what belongs in src/glb-canonicalize.js.',
			],
			drivable: false,
		};
	}

	const frozen = s.groups.filter((g) => !g.driven);
	if (frozen.length) {
		for (const g of frozen) {
			notes.push(`${g.label}: ${g.have}/${g.total} joints mapped, missing ${g.missingKey.join(', ')}.`);
		}
		fixes.push('Rename the missing joints listed under Coverage. Every other group will animate regardless.');
		if (frozen.some((g) => g.id === 'legs')) fixes.push('Legs specifically: without them a walk cycle plays as a slide. This is the most-reported rig complaint.');
		return {
			level: 'warn',
			headline: `This rig animates, but ${frozen.map((g) => g.label.toLowerCase()).join(' and ')} will not move.`,
			detail: `${s.mapped} of ${s.total} canonical joints mapped. Clips retarget onto the joints that resolved and leave the rest at their authored bind pose.`,
			notes,
			fixes,
			drivable: true,
		};
	}

	notes.push(`${s.mapped} of ${s.total} canonical joints mapped from a ${s.convention.label} rig.`);
	if (report.morphs.lipSync) notes.push(`${report.morphs.visemeCount} visemes present, so lip-sync will work too.`);
	else notes.push('No viseme blendshapes, so this avatar animates but cannot lip-sync.');
	if (!report.morphs.lipSync) fixes.push('Add the 15 Oculus visemes (viseme_aa, viseme_PP, …) if you want speech.');
	if (report.geometry.triangles > 150000) fixes.push(`${report.geometry.triangles.toLocaleString()} triangles is heavy for a web avatar. Decimate toward 60k for smooth mobile playback.`);
	if (report.textureBytes > 12 * 1024 * 1024) fixes.push('Textures exceed 12 MB. Compress with KTX2/Basis to cut first-load time.');

	return {
		level: 'pass',
		headline: 'Every limb group is drivable. This rig performs the full clip library.',
		detail: 'Torso, arms, hands, and legs all resolved to canonical joints, so retargeted clips will move the whole character.',
		notes,
		fixes,
		drivable: true,
	};
}

/**
 * Build a schema-v1 avatar manifest skeleton from a report. Everything the
 * report can know is filled in; the caller supplies identity (id/name/owner)
 * and the public mesh URI, which no local file can provide.
 *
 * @param {object} report from analyzeGlb
 * @param {{ id: string, name: string, meshUri: string, owner: string, sha256?: string, createdAt: string }} identity
 * @returns {object} manifest matching packages/avatar-schema/schema/avatar.v1.json
 */
export function manifestFromReport(report, identity) {
	const manifest = {
		schemaVersion: 1,
		id: identity.id,
		name: identity.name,
		mesh: {
			uri: identity.meshUri,
			sha256: identity.sha256 || '',
			format: 'glb',
			kBytes: Math.round(report.bytes / 1024),
		},
		skeleton: report.skeleton.convention.schema,
		traits: {
			triangles: report.geometry.triangles,
			joints: report.skeleton.jointCount,
			canonicalJoints: report.skeleton.mapped,
			morphTargets: report.morphs.total,
			lipSync: report.morphs.lipSync,
		},
		owner: { chain: 'solana', address: identity.owner },
		createdAt: identity.createdAt,
	};
	if (report.animations.length) {
		manifest.traits.embeddedClips = report.animations.map((a) => a.name);
	}
	return manifest;
}

/**
 * Human-readable byte size. Used in the UI and in the CLI-style summary, so it
 * lives here rather than in the page module.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return '0 B';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
