/**
 * Unified avatar export — GLB, USDZ, and VRM 1.0.
 *
 * Single source of truth for "give the user their avatar as a file". The three
 * paths share a common loader+sanitizer so a GLB exported as VRM and then
 * re-exported as USDZ stays self-consistent.
 *
 *   downloadAvatar(blobOrUrl, { format, filename, meta })
 *
 * Format support matrix:
 *   - 'glb'   → original bytes if Blob, fetched bytes if URL. No re-encode.
 *   - 'usdz'  → Three.js USDZExporter via ./usdz-pipeline.js. Coerces unlit
 *               materials to MeshStandardMaterial so Quick Look accepts them.
 *   - 'vrm'   → GLTFExporter + in-place injection of the VRMC_vrm 1.0
 *               extension (humanoid bones, ARKit-52 expression presets, meta).
 *               No third-party exporter package — pixiv/three-vrm doesn't ship
 *               one, and VRM 1.0 is just glTF 2.0 + a root extension.
 *
 * Mapping rules are conservative: we only emit human bones we can identify
 * with high confidence (Mixamo / VRM-native / RPM / CC bone naming) and only
 * emit expression presets whose source ARKit morph actually exists on the
 * mesh. Better to ship a small valid VRM than a large invalid one.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { glbBlobToUsdzBlob } from './usdz-pipeline.js';

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const GLB_JSON_CHUNK = 0x4e4f534a; // 'JSON'
const GLB_BIN_CHUNK = 0x004e4942; // 'BIN\0'

/* ────────────────────────────────────────────────────────────────────────── *
 * Public API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Build an export Blob from a source GLB (Blob or URL) in the requested format.
 *
 * @param {Blob|string} source — staged Blob or remote GLB URL
 * @param {object} opts
 * @param {'glb'|'usdz'|'vrm'} opts.format
 * @param {object} [opts.meta] — for VRM: { name, version, authors[], licenseUrl, ... }
 * @returns {Promise<{ blob: Blob, mime: string, ext: string }>}
 */
export async function exportAvatar(source, { format, meta } = {}) {
	const glbBlob = await coerceGlbBlob(source);
	switch (format) {
		case 'glb':
			return { blob: glbBlob, mime: 'model/gltf-binary', ext: 'glb' };
		case 'usdz': {
			const blob = await glbBlobToUsdzBlob(glbBlob);
			return { blob, mime: 'model/vnd.usdz+zip', ext: 'usdz' };
		}
		case 'vrm': {
			const blob = await glbBlobToVrmBlob(glbBlob, meta || {});
			return { blob, mime: 'model/gltf-binary', ext: 'vrm' };
		}
		default:
			throw new Error(`exportAvatar: unsupported format "${format}"`);
	}
}

/**
 * Convenience: export, save to disk, return descriptor. Triggers a browser
 * download of the result with the supplied filename (sans extension — we add
 * the right one per format).
 */
export async function downloadAvatar(source, { format, filename = 'avatar', meta } = {}) {
	const { blob, ext } = await exportAvatar(source, { format, meta });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${sanitizeFilename(filename)}.${ext}`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1500);
	return { size: blob.size, format, filename: a.download };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * GLB Blob loader
 * ────────────────────────────────────────────────────────────────────────── */

async function coerceGlbBlob(source) {
	if (source instanceof Blob) return source;
	if (typeof source !== 'string' || !source) {
		throw new Error('avatar-export: source must be a Blob or URL string');
	}
	const res = await fetch(source, { credentials: 'omit' });
	if (!res.ok) throw new Error(`avatar-export: fetch ${source} → ${res.status}`);
	return await res.blob();
}

function sanitizeFilename(name) {
	return String(name || 'avatar')
		.replace(/[^a-z0-9._-]+/gi, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80)
		|| 'avatar';
}

/* ────────────────────────────────────────────────────────────────────────── *
 * VRM 1.0 exporter
 *
 * VRM 1.0 is glTF 2.0 + the VRMC_vrm root extension. The shortest valid
 * exporter is therefore: (1) re-export the loaded scene as GLB with
 * GLTFExporter, (2) decode the JSON chunk, (3) inject VRMC_vrm with
 * humanoid + expressions + meta, (4) re-encode the GLB. We do not bother
 * with springbones, lookAt-bone targets, or constraints — those are
 * optional in the spec and require runtime state that doesn't survive an
 * export pass cleanly. A consuming runtime that wants physics can re-apply
 * its own springbones on top.
 * ────────────────────────────────────────────────────────────────────────── */

async function glbBlobToVrmBlob(glbBlob, meta) {
	const gltf = await loadGlb(glbBlob);
	const scene = gltf.scene || gltf.scenes?.[0];
	if (!scene) throw new Error('vrm: glb contained no scene');

	const skinnedMesh = findRepresentativeSkinnedMesh(scene);
	const skeleton = skinnedMesh?.skeleton || null;
	if (!skeleton) {
		throw new Error('vrm: source has no skeleton — cannot map to humanoid');
	}

	// Build a map of mesh → morph target dictionary so we can look up morphs
	// for expression bindings even before the GLB is re-exported.
	const morphLookup = collectMorphTargets(scene);

	// 1. Re-export with GLTFExporter to get a clean GLB byte stream.
	const exporter = new GLTFExporter();
	const rawArrayBuffer = await new Promise((resolve, reject) => {
		exporter.parse(
			scene,
			(out) => resolve(out),
			(err) => reject(err),
			{ binary: true, embedImages: true, animations: gltf.animations || [] },
		);
	});

	// 2. Parse the GLB so we can inject VRMC_vrm into the JSON chunk.
	const glb = decodeGlb(new Uint8Array(rawArrayBuffer));
	const jsonText = TEXT_DECODER.decode(glb.json);
	const json = JSON.parse(jsonText);

	// 3. Build the VRMC_vrm payload from the in-memory scene. We index back
	//    into json.nodes by name — GLTFExporter preserves node names so this
	//    is stable.
	const nodeIndexByName = new Map();
	(json.nodes || []).forEach((n, idx) => {
		if (n.name) nodeIndexByName.set(n.name, idx);
	});

	const humanBones = buildHumanBones(skeleton, nodeIndexByName);
	if (Object.keys(humanBones).length < 8) {
		throw new Error(
			`vrm: only matched ${Object.keys(humanBones).length} humanoid bones — need at least Hips/Spine/Head/arms+legs`,
		);
	}

	const expressions = buildExpressionsFromArkit(morphLookup, json, nodeIndexByName);

	const vrmExt = {
		specVersion: '1.0',
		meta: {
			name: meta.name || 'three.ws avatar',
			version: meta.version || '1',
			authors: Array.isArray(meta.authors) && meta.authors.length ? meta.authors : ['three.ws user'],
			copyrightInformation: meta.copyrightInformation || '',
			contactInformation: meta.contactInformation || '',
			references: meta.references || [],
			thirdPartyLicenses: meta.thirdPartyLicenses || '',
			thumbnailImage: undefined, // optional; we don't bake one in
			licenseUrl: meta.licenseUrl || 'https://vrm.dev/licenses/1.0/index.html',
			avatarPermission: meta.avatarPermission || 'everyone',
			allowExcessivelyViolentUsage: meta.allowExcessivelyViolentUsage ?? false,
			allowExcessivelySexualUsage: meta.allowExcessivelySexualUsage ?? false,
			commercialUsage: meta.commercialUsage || 'personalNonProfit',
			allowPoliticalOrReligiousUsage: meta.allowPoliticalOrReligiousUsage ?? false,
			allowAntisocialOrHateUsage: meta.allowAntisocialOrHateUsage ?? false,
			creditNotation: meta.creditNotation || 'required',
			allowRedistribution: meta.allowRedistribution ?? false,
			modification: meta.modification || 'prohibited',
			otherLicenseUrl: meta.otherLicenseUrl || '',
		},
		humanoid: { humanBones },
		expressions,
		lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.06, 0] },
		firstPerson: { meshAnnotations: [] },
	};

	// Strip undefined optionals — VRM consumers (UniVRM, three-vrm) tolerate
	// missing keys but trip on explicit nulls.
	pruneUndefined(vrmExt.meta);

	json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []), 'VRMC_vrm']));
	json.extensions = { ...(json.extensions || {}), VRMC_vrm: vrmExt };

	// 4. Re-encode GLB.
	const rebuiltJson = TEXT_ENCODER.encode(JSON.stringify(json));
	return new Blob([encodeGlb(rebuiltJson, glb.bin)], { type: 'model/gltf-binary' });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Humanoid bone mapping
 *
 * Accepts Mixamo (mixamorig:Hips), VRM-native (Hips, J_Bip_C_Hips), Ready
 * Player Me (Hips, Spine, Neck), CC4 (CC_Base_Hip), and Unity-export naming.
 * The matcher strips common prefixes/suffixes, normalizes left/right markers,
 * and routes to canonical VRM names.
 * ────────────────────────────────────────────────────────────────────────── */

const VRM_BONE_TARGETS = [
	'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
	'leftEye', 'rightEye', 'jaw',
	'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
	'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
	'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
	'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
	'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
	'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
	'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
	'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
	'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
	'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal',
	'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
	'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
	'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
	'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
];

export function normalizeBoneName(raw) {
	return String(raw || '')
		.toLowerCase()
		.replace(/^mixamorig:?_?/, '')
		.replace(/^cc_base_/, '')
		.replace(/^armature[:_|]/, '')
		.replace(/^j_bip_[clr]_/, '')
		.replace(/^rig[:_]/, '')
		.replace(/^bip01_?/, '')
		.replace(/[._\-\s]/g, '');
}

function classifyBone(rawName) {
	const n = normalizeBoneName(rawName);
	const isLeft = /(^|[^a-z])l(?![a-z])|left/.test(n);
	const isRight = /(^|[^a-z])r(?![a-z])|right/.test(n);
	const stripped = n.replace(/^(l|left|r|right)/, '').replace(/(l|r)$/, '');

	if (n === 'hips' || n === 'hip' || n === 'pelvis') return 'hips';
	if (n === 'spine' || n === 'spine1') return 'spine';
	if (n === 'spine2' || n === 'chest') return 'chest';
	if (n === 'spine3' || n === 'upperchest') return 'upperChest';
	if (n === 'neck') return 'neck';
	if (n === 'head') return 'head';
	if (n === 'jaw') return 'jaw';
	if (/eye/.test(n) && isLeft) return 'leftEye';
	if (/eye/.test(n) && isRight) return 'rightEye';

	const sideKey = (base) => (isLeft ? 'left' : isRight ? 'right' : null) + base;

	if (/shoulder|clavicle/.test(stripped)) return sideKey('Shoulder');
	if (/upperarm|^arm$/.test(stripped)) return sideKey('UpperArm');
	if (/lowerarm|forearm/.test(stripped)) return sideKey('LowerArm');
	if (/^hand$/.test(stripped) || /^hand[0-9]?$/.test(n)) return sideKey('Hand');

	if (/upleg|upperleg|thigh/.test(stripped)) return sideKey('UpperLeg');
	if (/lowerleg|^leg$|calf|shin/.test(stripped)) return sideKey('LowerLeg');
	if (/^foot$|ankle/.test(stripped)) return sideKey('Foot');
	if (/toe(?!nail)|toebase/.test(stripped)) return sideKey('Toes');

	const fingerMatch = stripped.match(/(thumb|index|middle|ring|little|pinky)([0-9])?/);
	if (fingerMatch) {
		const finger = fingerMatch[1] === 'pinky' ? 'Little' : capitalize(fingerMatch[1]);
		const segment = fingerMatch[2] || '1';
		const segmentName =
			segment === '1' ? (finger === 'Thumb' ? 'Metacarpal' : 'Proximal') :
			segment === '2' ? (finger === 'Thumb' ? 'Proximal' : 'Intermediate') :
			(finger === 'Thumb' ? 'Distal' : 'Distal');
		const side = isLeft ? 'left' : isRight ? 'right' : null;
		if (side) return `${side}${finger}${segmentName}`;
	}

	return null;
}

function capitalize(s) {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function buildHumanBones(skeleton, nodeIndexByName) {
	const out = {};
	const seen = new Set();
	for (const bone of skeleton.bones || []) {
		const vrmName = classifyBone(bone.name);
		if (!vrmName || !VRM_BONE_TARGETS.includes(vrmName) || seen.has(vrmName)) continue;
		const idx = nodeIndexByName.get(bone.name);
		if (idx == null) continue;
		out[vrmName] = { node: idx };
		seen.add(vrmName);
	}
	return out;
}

function findRepresentativeSkinnedMesh(scene) {
	let best = null;
	let bestCount = 0;
	scene.traverse((obj) => {
		if (!obj.isSkinnedMesh || !obj.skeleton?.bones?.length) return;
		const c = obj.skeleton.bones.length;
		if (c > bestCount) {
			best = obj;
			bestCount = c;
		}
	});
	return best;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * ARKit-52 → VRM expression preset binding
 *
 * VRM 1.0 preset names: aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight,
 * happy, angry, sad, relaxed, surprised, neutral, lookUp, lookDown, lookLeft,
 * lookRight. Each preset has morphTargetBinds[] referencing { node, index, weight }.
 *
 * We bind by *finding* the morph target name on any mesh in json.meshes and
 * recording (node-of-that-mesh, index-of-that-morph, weight=1.0). If the
 * source morph is missing, the preset is omitted entirely.
 * ────────────────────────────────────────────────────────────────────────── */

const ARKIT_TO_VRM_PRESETS = [
	// Visemes (Oculus → VRM)
	{ preset: 'aa', sources: [{ morph: 'viseme_aa', w: 1 }, { morph: 'jawOpen', w: 0.7 }, { morph: 'mouthFunnel', w: -0.3 }] },
	{ preset: 'ih', sources: [{ morph: 'viseme_I', w: 1 }, { morph: 'mouthSmileLeft', w: 0.3 }, { morph: 'mouthSmileRight', w: 0.3 }] },
	{ preset: 'ou', sources: [{ morph: 'viseme_U', w: 1 }, { morph: 'mouthPucker', w: 0.6 }] },
	{ preset: 'ee', sources: [{ morph: 'viseme_E', w: 1 }, { morph: 'mouthStretchLeft', w: 0.4 }, { morph: 'mouthStretchRight', w: 0.4 }] },
	{ preset: 'oh', sources: [{ morph: 'viseme_O', w: 1 }, { morph: 'mouthFunnel', w: 0.6 }] },

	// Blinks
	{ preset: 'blink', sources: [{ morph: 'eyeBlinkLeft', w: 1 }, { morph: 'eyeBlinkRight', w: 1 }] },
	{ preset: 'blinkLeft', sources: [{ morph: 'eyeBlinkLeft', w: 1 }] },
	{ preset: 'blinkRight', sources: [{ morph: 'eyeBlinkRight', w: 1 }] },

	// Emotions
	{ preset: 'happy', sources: [{ morph: 'mouthSmileLeft', w: 1 }, { morph: 'mouthSmileRight', w: 1 }, { morph: 'cheekSquintLeft', w: 0.5 }, { morph: 'cheekSquintRight', w: 0.5 }, { morph: 'eyeSquintLeft', w: 0.4 }, { morph: 'eyeSquintRight', w: 0.4 }] },
	{ preset: 'angry', sources: [{ morph: 'browDownLeft', w: 1 }, { morph: 'browDownRight', w: 1 }, { morph: 'mouthPressLeft', w: 0.6 }, { morph: 'mouthPressRight', w: 0.6 }, { morph: 'noseSneerLeft', w: 0.3 }, { morph: 'noseSneerRight', w: 0.3 }] },
	{ preset: 'sad', sources: [{ morph: 'mouthFrownLeft', w: 1 }, { morph: 'mouthFrownRight', w: 1 }, { morph: 'browInnerUp', w: 0.7 }, { morph: 'mouthShrugLower', w: 0.4 }] },
	{ preset: 'relaxed', sources: [{ morph: 'mouthSmileLeft', w: 0.3 }, { morph: 'mouthSmileRight', w: 0.3 }] },
	{ preset: 'surprised', sources: [{ morph: 'eyeWideLeft', w: 1 }, { morph: 'eyeWideRight', w: 1 }, { morph: 'browInnerUp', w: 0.8 }, { morph: 'browOuterUpLeft', w: 0.8 }, { morph: 'browOuterUpRight', w: 0.8 }, { morph: 'jawOpen', w: 0.5 }] },

	// Look direction (handled by lookAt expression, optional duplicate of eye bones)
	{ preset: 'lookUp', sources: [{ morph: 'eyeLookUpLeft', w: 1 }, { morph: 'eyeLookUpRight', w: 1 }] },
	{ preset: 'lookDown', sources: [{ morph: 'eyeLookDownLeft', w: 1 }, { morph: 'eyeLookDownRight', w: 1 }] },
	{ preset: 'lookLeft', sources: [{ morph: 'eyeLookOutLeft', w: 1 }, { morph: 'eyeLookInRight', w: 1 }] },
	{ preset: 'lookRight', sources: [{ morph: 'eyeLookInLeft', w: 1 }, { morph: 'eyeLookOutRight', w: 1 }] },
];

/**
 * Walk every mesh in the scene and record `{ meshName: { morphName: index } }`.
 * This runs against the live Three.js scene before re-export, so we use the
 * actual mesh.userData / mesh.morphTargetDictionary.
 */
function collectMorphTargets(scene) {
	const out = new Map(); // meshName → { morphName → index }
	scene.traverse((obj) => {
		if (!obj.isMesh || !obj.morphTargetDictionary) return;
		out.set(obj.name, obj.morphTargetDictionary);
	});
	return out;
}

/**
 * Resolve the (gltf-node-index, mesh-primitive-morph-index) for a morph name.
 * GLTFExporter writes meshes back to json.meshes, each primitive carrying
 * `targets` whose order matches morphTargetDictionary index. Node→mesh is in
 * json.nodes[i].mesh. Mesh extras.targetNames carries the morph names.
 */
function resolveMorphBinding(morphName, json) {
	const meshes = json.meshes || [];
	for (let meshIdx = 0; meshIdx < meshes.length; meshIdx++) {
		const mesh = meshes[meshIdx];
		const targetNames = mesh.extras?.targetNames;
		if (!Array.isArray(targetNames)) continue;
		const morphIdx = targetNames.indexOf(morphName);
		if (morphIdx < 0) continue;
		// Find the node that points at this mesh.
		const nodes = json.nodes || [];
		for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
			if (nodes[nodeIdx].mesh === meshIdx) {
				return { node: nodeIdx, index: morphIdx };
			}
		}
	}
	return null;
}

function buildExpressionsFromArkit(_morphLookup, json, _nodeIndexByName) {
	const preset = {};
	for (const def of ARKIT_TO_VRM_PRESETS) {
		const binds = [];
		for (const src of def.sources) {
			const found = resolveMorphBinding(src.morph, json);
			if (!found) continue;
			binds.push({ node: found.node, index: found.index, weight: src.w });
		}
		if (!binds.length) continue;
		preset[def.preset] = {
			morphTargetBinds: binds,
			isBinary: false,
			overrideBlink: 'none',
			overrideLookAt: 'none',
			overrideMouth: 'none',
		};
	}
	return { preset };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * GLB encode / decode helpers
 *
 * Minimal binary glTF reader/writer. We only need to extract+rewrite the JSON
 * chunk; the BIN chunk is passed through unmodified.
 * ────────────────────────────────────────────────────────────────────────── */

function decodeGlb(bytes) {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('glb: bad magic');
	if (dv.getUint32(4, true) !== 2) throw new Error('glb: unsupported version');
	let offset = 12;
	let json = null;
	let bin = new Uint8Array(0);
	while (offset < bytes.length) {
		const chunkLen = dv.getUint32(offset, true);
		const chunkType = dv.getUint32(offset + 4, true);
		const chunkStart = offset + 8;
		const chunkData = bytes.subarray(chunkStart, chunkStart + chunkLen);
		if (chunkType === GLB_JSON_CHUNK) json = chunkData;
		else if (chunkType === GLB_BIN_CHUNK) bin = chunkData;
		offset = chunkStart + chunkLen;
	}
	if (!json) throw new Error('glb: missing JSON chunk');
	return { json, bin };
}

function padTo4(arr, padByte) {
	const remainder = arr.byteLength % 4;
	if (remainder === 0) return arr;
	const padded = new Uint8Array(arr.byteLength + (4 - remainder));
	padded.set(arr, 0);
	padded.fill(padByte, arr.byteLength);
	return padded;
}

function encodeGlb(jsonBytes, binBytes) {
	const jsonChunk = padTo4(jsonBytes, 0x20); // space-pad JSON per spec
	const binChunk = binBytes.byteLength ? padTo4(binBytes, 0x00) : new Uint8Array(0);
	const headerLen = 12;
	const jsonHeaderLen = 8;
	const binHeaderLen = binChunk.byteLength ? 8 : 0;
	const totalLen = headerLen + jsonHeaderLen + jsonChunk.byteLength + binHeaderLen + binChunk.byteLength;

	const out = new Uint8Array(totalLen);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, GLB_MAGIC, true);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, totalLen, true);

	dv.setUint32(12, jsonChunk.byteLength, true);
	dv.setUint32(16, GLB_JSON_CHUNK, true);
	out.set(jsonChunk, 20);

	if (binChunk.byteLength) {
		const binOffset = 20 + jsonChunk.byteLength;
		dv.setUint32(binOffset, binChunk.byteLength, true);
		dv.setUint32(binOffset + 4, GLB_BIN_CHUNK, true);
		out.set(binChunk, binOffset + 8);
	}

	return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * GLB loader (shared with USDZ pipeline)
 * ────────────────────────────────────────────────────────────────────────── */

async function loadGlb(blob) {
	const loader = new GLTFLoader();
	const buf = await blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		loader.parse(buf, '', resolve, reject);
	});
}

function pruneUndefined(obj) {
	for (const k of Object.keys(obj)) {
		if (obj[k] === undefined) delete obj[k];
	}
}
