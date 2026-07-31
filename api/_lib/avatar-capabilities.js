// What can this avatar actually do?
//
// Every render, pose, expression, and lipsync call on three.ws succeeds or
// degrades based on facts that live inside the GLB: which morph targets it
// carries, whether its bone names map onto the canonical humanoid skeleton the
// pre-baked clip library addresses, and how heavy the geometry is. Until now
// those facts were only discoverable by trying: you sent an expression, got a
// picture back, and had to eyeball whether the smile landed.
//
// This module answers the question up front. It reads ONLY the glTF JSON chunk
// (a ranged read of the head of the file, never the mesh binary), then runs the
// exact same two mappers the runtime uses:
//
//   • src/runtime/arkit52.js       morph name  → canonical ARKit-52 shape
//   • src/glb-canonicalize.js      bone name   → canonical humanoid bone
//
// Because it is the same mapping, the report is not an estimate. A morph this
// module reports as supported is a morph the renderer will drive, and a rig it
// reports as animatable is one src/animation-retarget.js will retarget onto
// (its MIN_COVERAGE gate is applied here by name).
//
// Consumed by GET /api/avatar/capabilities and the /render-lab composer, which
// disables controls an avatar cannot honor instead of letting you request them
// and wonder why nothing changed.

import { getObjectRange } from './r2.js';
import { resolvePublicHost, pinnedAgent, validatePublicUrl } from './ssrf.js';
import { inspectGlb, glbJsonChunkEnd } from './glb-inspect.js';
import { conformanceFromNames, ARKIT_52 } from '../../src/runtime/arkit52.js';
import { canonicalizeBoneName, CANONICAL_BONES } from '../../src/glb-canonicalize.js';
import { MIN_COVERAGE } from '../../src/animation-retarget.js';

// 256 KB covers the JSON chunk of essentially every real avatar in one read.
// Same first-pass budget as rig-inspect.js, for the same reason.
const INITIAL_PREFIX = 256 * 1024;
// A JSON chunk past this is pathological; report "unknown" rather than pull
// megabytes hunting for names.
const MAX_PREFIX = 8 * 1024 * 1024;
// A third-party host gets one short window to answer; the JSON chunk is the
// head of the file, so a healthy server returns it immediately.
const EXTERNAL_TIMEOUT_MS = 12_000;

// Expression control needs a mouth AND a brow to read as an expression at all;
// a rig with only visemes can lipsync but cannot emote.
const EXPRESSION_MIN_SHAPES = 4;

// Bones the retargeter must have to drive a full-body clip. Fingers are graded
// separately: a rig can walk convincingly with no finger joints at all, so
// missing hands lower the grade without disqualifying the rig.
const CORE_BONES = Object.freeze([
	'Hips', 'Spine', 'Neck', 'Head',
	'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm',
	'LeftUpLeg', 'LeftLeg', 'LeftFoot',
	'RightUpLeg', 'RightLeg', 'RightFoot',
]);

const FINGER_BONES = CANONICAL_BONES.filter((b) => /Hand(Index|Middle|Pinky|Ring|Thumb)\d$/.test(b));

// Generator strings are the most reliable pipeline tell, but plenty of rigs
// arrive with a generic one; bone spelling is the fallback signal.
const RIG_SIGNATURES = Object.freeze([
	{ id: 'mixamo', label: 'Mixamo', test: (b) => b.some((n) => /^mixamorig/i.test(n)) },
	{ id: 'vrm', label: 'VRM / VRoid', test: (b) => b.some((n) => /^J_Bip_/i.test(n)) },
	{ id: 'unreal', label: 'Unreal mannequin', test: (b) => b.some((n) => /^(upperarm|thigh|calf|clavicle)_[lr]$/i.test(n)) },
	{ id: 'rigify', label: 'Blender Rigify', test: (b) => b.some((n) => /^(DEF|ORG|MCH)-/i.test(n)) },
	{ id: 'daz', label: 'Daz / Genesis', test: (b) => b.some((n) => /^(lShldr|rShldr|lForeArm|abdomen)$/i.test(n)) },
	{ id: 'smpl', label: 'SMPL / SMPL-X', test: (b) => b.some((n) => /^(left|right)_(hip|knee|ankle|elbow|wrist)$/i.test(n)) },
	{ id: 'secondlife', label: 'Second Life', test: (b) => b.some((n) => /^m(Pelvis|Torso|Chest)$/i.test(n)) },
	{ id: 'blender-side', label: 'Blender .L/.R', test: (b) => b.some((n) => /\.(L|R)$/.test(n)) },
	{ id: 'canonical', label: 'three.ws canonical', test: (b) => b.includes('Hips') && b.includes('LeftForeArm') },
]);

async function readGlbPrefix(storageKey, length) {
	if (/^https?:\/\//i.test(storageKey)) {
		const r = await fetch(storageKey, { headers: { Range: `bytes=0-${length - 1}` } });
		if (!r.ok) throw new Error(`http ${r.status}`);
		return Buffer.from(await r.arrayBuffer());
	}
	return getObjectRange(storageKey, length);
}

// Ranged read of a URL nobody on this platform controls. The host is resolved
// and pinned before the request so a redirect or a DNS rebind cannot walk the
// fetch onto a private address, and the Range header caps what a hostile server
// can make us buffer.
async function readUntrustedGlbPrefix(rawUrl, length) {
	const url = validatePublicUrl(rawUrl);
	const addrs = await resolvePublicHost(url.hostname);
	const agent = pinnedAgent(url.hostname, addrs);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			redirect: 'error',
			signal: controller.signal,
			dispatcher: agent,
			headers: {
				Range: `bytes=0-${length - 1}`,
				'user-agent': 'three-ws-capabilities/1.0 (+https://three.ws/render-lab)',
			},
		});
		if (!r.ok) throw new Error(`http ${r.status}`);
		const buf = Buffer.from(await r.arrayBuffer());
		// A server that ignores Range answers 200 with the whole file; truncate
		// rather than hold an arbitrarily large body in memory.
		return buf.length > length ? buf.subarray(0, length) : buf;
	} finally {
		clearTimeout(timer);
		await agent.close().catch(() => {});
	}
}

async function inspectPrefix(storageKey, { untrusted = false } = {}) {
	const read = untrusted ? readUntrustedGlbPrefix : readGlbPrefix;
	let buf = await read(storageKey, INITIAL_PREFIX);
	let info = inspectGlb(buf, { allowPartial: true });
	if (!info) {
		const need = glbJsonChunkEnd(buf);
		if (need > buf.length && need <= MAX_PREFIX) {
			buf = await read(storageKey, need);
			info = inspectGlb(buf, { allowPartial: true });
		}
	}
	return info;
}

function detectRig(boneNames, generator) {
	for (const sig of RIG_SIGNATURES) {
		if (sig.test(boneNames)) return { id: sig.id, label: sig.label };
	}
	if (generator && /avaturn/i.test(generator)) return { id: 'avaturn', label: 'Avaturn' };
	if (generator && /ready ?player ?me/i.test(generator)) return { id: 'rpm', label: 'Ready Player Me' };
	return { id: 'unknown', label: boneNames.length ? 'Unrecognized humanoid' : 'No skeleton' };
}

function gradeSkeleton(boneNames) {
	const mapped = new Map();
	const unmapped = [];
	for (const raw of boneNames) {
		const canonical = canonicalizeBoneName(raw);
		if (canonical && !mapped.has(canonical)) mapped.set(canonical, raw);
		else if (!canonical) unmapped.push(raw);
	}
	const mappedNames = CANONICAL_BONES.filter((b) => mapped.has(b));
	const coverage = mappedNames.length / CANONICAL_BONES.length;
	const coreMissing = CORE_BONES.filter((b) => !mapped.has(b));
	const fingersMapped = FINGER_BONES.filter((b) => mapped.has(b)).length;
	return {
		coverage,
		mapped: mappedNames,
		missing: CANONICAL_BONES.filter((b) => !mapped.has(b)),
		unmapped,
		coreMissing,
		fingerCoverage: FINGER_BONES.length ? fingersMapped / FINGER_BONES.length : 0,
		// The retargeter's own gate, applied by name so this answer and the
		// runtime's answer cannot drift apart.
		retargetable: coverage >= MIN_COVERAGE && coreMissing.length === 0,
	};
}

/**
 * Human-readable reason a capability is or is not available. The UI shows this
 * verbatim, so it has to explain the fix, not just the fact.
 */
function poseVerdict(skeleton, isRigged) {
	if (!isRigged) {
		return {
			supported: false,
			reason: 'This model has no skeleton, so poses and animation clips cannot drive it. Rig it first (POST /api/rig) and every pose preset becomes available.',
		};
	}
	if (skeleton.retargetable) {
		return {
			supported: true,
			reason: `${skeleton.mapped.length} of ${CANONICAL_BONES.length} canonical bones mapped; every pose preset and animation clip retargets onto this rig.`,
		};
	}
	if (skeleton.coreMissing.length) {
		return {
			supported: false,
			reason: `Core bones did not map (${skeleton.coreMissing.slice(0, 6).join(', ')}). Renders fall back to the default rig rather than showing a broken pose.`,
		};
	}
	return {
		supported: false,
		reason: `Only ${Math.round(skeleton.coverage * 100)}% of the canonical skeleton mapped, below the ${Math.round(MIN_COVERAGE * 100)}% retarget floor. Renders fall back to the default rig.`,
	};
}

function expressionVerdict(morphs) {
	if (!morphs.implemented.length && !morphs.visemes.length) {
		return {
			supported: false,
			reason: 'No ARKit-52 morph targets on this model, so the expression parameter has nothing to drive. The render still succeeds and reports x-render-expression: none.',
		};
	}
	if (morphs.implemented.length < EXPRESSION_MIN_SHAPES) {
		return {
			supported: false,
			partial: true,
			reason: `Only ${morphs.implemented.length} ARKit shape(s) present (${morphs.implemented.join(', ')}). Requests naming anything else come back as x-render-expression: partial.`,
		};
	}
	return {
		supported: true,
		reason: `${morphs.implemented.length} of ${ARKIT_52.length} ARKit-52 shapes present. Anything outside that set reports back in x-render-expression-missing.`,
	};
}

function lipsyncVerdict(morphs) {
	const jaw = morphs.implemented.includes('jawOpen');
	if (morphs.visemes.length >= 8) {
		return { supported: true, reason: `${morphs.visemes.length} viseme shapes present: phoneme-accurate lipsync.` };
	}
	if (jaw) {
		return { supported: true, degraded: true, reason: 'No viseme set, but jawOpen is present: lipsync falls back to amplitude-driven jaw motion.' };
	}
	return { supported: false, reason: 'Neither visemes nor jawOpen are present, so speech cannot move this face. Voice still plays; the mouth stays still.' };
}

/**
 * Full capability report for a GLB.
 *
 * @param {string} storageKey — R2 object key or absolute URL
 * @param {object} [opts]
 * @param {boolean} [opts.untrusted=false] — the URL came from a caller, so
 *        resolve and pin the host before fetching (SSRF guard).
 * @returns {Promise<null | object>} null when the object is not a parseable GLB
 */
export async function inspectGlbCapabilities(storageKey, opts = {}) {
	if (!storageKey) return null;
	const info = await inspectPrefix(storageKey, opts);
	if (!info) return null;

	const morphs = conformanceFromNames(info.morphTargetNames);
	const skeleton = gradeSkeleton(info.boneNames);
	const rig = detectRig(info.boneNames, info.generator);

	const pose = poseVerdict(skeleton, info.isRigged);
	const expression = expressionVerdict(morphs);
	const lipsync = lipsyncVerdict(morphs);

	return {
		rig: {
			detected: rig.id,
			label: rig.label,
			generator: info.generator,
			isRigged: info.isRigged,
			boneCount: info.boneNames.length,
			skinCount: info.skinCount,
			canonicalCoverage: Number(skeleton.coverage.toFixed(4)),
			fingerCoverage: Number(skeleton.fingerCoverage.toFixed(4)),
			mappedBones: skeleton.mapped,
			unmappedBones: skeleton.unmapped.slice(0, 64),
			bakedAnimations: info.animationNames,
		},
		morphs: {
			total: info.morphTargetNames.length || info.morphTargetSlots,
			named: info.morphTargetNames.length,
			arkitCoverage: Number(morphs.coverage.toFixed(4)),
			supported: morphs.implemented,
			missing: morphs.missing,
			visemes: morphs.visemes,
			// Shapes the model carries that are not part of the ARKit set:
			// custom sliders (body shape, hair, accessories) a caller may still
			// want to know exist even though the expression parameter ignores them.
			custom: morphs.unmapped.slice(0, 64),
		},
		geometry: {
			triangles: info.triangleCount,
			vertices: info.vertexCount,
			meshes: info.meshCount,
			primitives: info.primitiveCount,
			materials: info.materialCount,
			textures: info.textureCount,
			extensions: info.extensionsUsed,
		},
		can: { pose, expression, lipsync },
	};
}

export { CORE_BONES, EXPRESSION_MIN_SHAPES };
