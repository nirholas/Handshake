// vrm-loader — VRM avatars and props in /play (W-world-online P3.4).
//
// A VRM file IS a glTF binary: same 12-byte header, same JSON + BIN chunks, with
// the humanoid/material/spring data hanging off `extensions.VRM` (VRM 0.x) or
// `extensions.VRMC_vrm` (VRM 1.0). That means our existing GLTFLoader already
// parses one and gets real meshes, real materials and a real skeleton out of it.
// It does NOT, on its own, get three things right, and those three are exactly
// what makes an untouched VRM look broken in-engine:
//
//   1. Facing. VRM 0.x characters face -Z; VRM 1.0 (and every other avatar we
//      load) faces +Z. Without the flip a VRM 0.x avatar walks backwards.
//   2. Culling. VRM exporters routinely ship skinned meshes whose bind-pose
//      bounding boxes don't cover the animated pose, so three.js frustum-culls
//      body parts as the camera moves and the avatar flickers apart.
//   3. Double-sided hair/clothing planes authored for MToon read as one-sided
//      holes under a standard material.
//
// This module fixes all three on the plain-glTF path, so VRM avatars and props
// work today with no new dependency, and the skeleton is picked up by
// src/glb-canonicalize.js, which already maps both VRM 0.x (`J_Bip_C_Hips`) and
// VRM 1.0 (`upperChest`) bone naming onto the canonical rig — so the pre-baked
// idle/walk/emote clips retarget onto a VRM the same as any other humanoid.
//
// ── The @pixiv/three-vrm seam ────────────────────────────────────────────────
// What the plain path does NOT reproduce is MToon's toon shading + outlines,
// spring-bone physics (hair/skirt secondary motion), the humanoid normalization
// rig, blend-shape expression presets and look-at. Those need the reference
// implementation. `setVrmPluginFactory()` is the single integration point for it:
// call it once at boot with a factory that returns a GLTFLoader plugin, and every
// avatar/prop load in the app routes through it automatically — no call site
// changes. To light it up:
//
//     npm install @pixiv/three-vrm
//
//     // src/game/boot-avatar.js (or any boot path), once:
//     import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
//     import { setVrmPluginFactory } from './vrm-loader.js';
//     setVrmPluginFactory((parser) => new VRMLoaderPlugin(parser), { VRMUtils });
//
// Until that call happens the plain path above runs, which is a real, working
// VRM load, not a stub: nothing here fakes support it doesn't have.

import { Box3, Vector3, DoubleSide } from 'three';
import { log } from '../shared/log.js';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/** The glTF extension keys that mark a file as VRM. */
export const VRM_EXT_0 = 'VRM';        // VRM 0.x
export const VRM_EXT_1 = 'VRMC_vrm';   // VRM 1.0

// The optional reference implementation, installed by setVrmPluginFactory().
let _pluginFactory = null;
let _vrmUtils = null;

/**
 * Register @pixiv/three-vrm (or any GLTFLoader plugin with the same contract) as
 * the VRM parser for the whole app. Idempotent; pass null to unregister.
 * @param {(parser:object)=>object|null} factory returns a GLTFLoader plugin
 * @param {object} [opts]
 * @param {object} [opts.VRMUtils] the library's VRMUtils, used for rotateVRM0 /
 *   combineSkeletons / removeUnnecessaryJoints when available
 */
export function setVrmPluginFactory(factory, { VRMUtils = null } = {}) {
	_pluginFactory = typeof factory === 'function' ? factory : null;
	_vrmUtils = VRMUtils;
}

/** Is the reference VRM implementation wired up? Honest capability probe. */
export function hasVrmPlugin() { return !!_pluginFactory; }

/**
 * Register the VRM plugin on a GLTFLoader, if one has been installed.
 * Safe (and free) to call on every loader; returns whether anything was added.
 */
export function installVrmPlugin(loader) {
	if (!_pluginFactory || !loader?.register) return false;
	if (loader.__vrmPluginInstalled) return true;
	loader.register((parser) => _pluginFactory(parser));
	loader.__vrmPluginInstalled = true;
	return true;
}

/** Does this url name a VRM file? (Cheap pre-check; the buffer probe is truth.) */
export function isVrmUrl(url) {
	return typeof url === 'string' && /\.vrm(\?|#|$)/i.test(url);
}

/**
 * Read the glTF JSON chunk out of a GLB/VRM ArrayBuffer without a full parse.
 * Returns the parsed JSON, or null if the bytes are not a GLB.
 */
export function readGlbJson(buffer) {
	try {
		const view = new DataView(buffer);
		if (view.byteLength < 20) return null;
		if (view.getUint32(0, true) !== GLB_MAGIC) return null;
		const chunkLength = view.getUint32(12, true);
		if (view.getUint32(16, true) !== CHUNK_JSON) return null;
		if (20 + chunkLength > view.byteLength) return null;
		const text = new TextDecoder().decode(new Uint8Array(buffer, 20, chunkLength));
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Which VRM generation, if any, does this parsed glTF JSON declare?
 * @returns {0|1|null} 0 for VRM 0.x, 1 for VRM 1.0, null for a plain glTF
 */
export function vrmVersionOfJson(json) {
	const ext = json?.extensions;
	const used = Array.isArray(json?.extensionsUsed) ? json.extensionsUsed : [];
	if (ext?.[VRM_EXT_1] || used.includes(VRM_EXT_1)) return 1;
	if (ext?.[VRM_EXT_0] || used.includes(VRM_EXT_0)) return 0;
	return null;
}

/** Same probe, straight off an ArrayBuffer. */
export function vrmVersionOfBuffer(buffer) {
	return vrmVersionOfJson(readGlbJson(buffer));
}

/** Same probe, off a parsed GLTFLoader result. */
export function vrmVersionOfGltf(gltf) {
	if (gltf?.userData?.vrm) return gltf.userData.vrm.meta?.metaVersion === '1' ? 1 : 0;
	return vrmVersionOfJson(gltf?.parser?.json);
}

/**
 * Make a parsed VRM behave like every other avatar in the scene. No-op for a
 * plain glTF, so it is safe to call on every load.
 *
 * @param {object} gltf GLTFLoader result
 * @returns {{vrm:boolean, version:0|1|null, plugin:boolean}}
 */
export function prepareVrmModel(gltf) {
	const version = vrmVersionOfGltf(gltf);
	if (version == null) return { vrm: false, version: null, plugin: false };

	const scene = gltf.scene;
	const vrm = gltf.userData?.vrm || null;

	// With the reference implementation present, let it do the heavy lifting: its
	// humanoid normalization and skeleton merge are strictly better than anything
	// re-derived here.
	if (vrm && _vrmUtils) {
		try {
			if (version === 0) _vrmUtils.rotateVRM0?.(vrm);
			_vrmUtils.combineSkeletons?.(scene);
			_vrmUtils.removeUnnecessaryVertices?.(scene);
		} catch (e) {
			log.warn('[vrm-loader] VRMUtils pass failed', e?.message || e);
		}
	} else if (version === 0) {
		// Plain-glTF path: VRM 0.x faces -Z, everything else in this app faces +Z.
		// Rotating the scene root (rather than the hips) keeps the skeleton's local
		// transforms untouched, so retargeted clips still apply cleanly.
		scene.rotation.y += Math.PI;
		scene.updateMatrixWorld(true);
	}

	// Skinned VRM meshes routinely carry bind-pose bounds that don't contain the
	// animated pose; three.js then culls limbs mid-stride. Opting these meshes out
	// of frustum culling costs one extra draw call each and fixes the flicker.
	scene.traverse((n) => {
		if (!n.isMesh) return;
		if (n.isSkinnedMesh) n.frustumCulled = false;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (!m) continue;
			// MToon authors hair and cloth as single-quad planes meant to be seen
			// from both sides; the standard-material fallback renders them
			// one-sided, which reads as holes through the model.
			if (m.transparent || m.alphaTest > 0) {
				m.side = DoubleSide;
				m.needsUpdate = true;
			}
		}
	});

	return { vrm: true, version, plugin: !!vrm };
}

/**
 * Measure a prepared model: standing height and largest horizontal extent. Used
 * by the prop path to fit an upload onto the ground at a sane size.
 */
export function measureModel(object3d) {
	const size = new Vector3();
	new Box3().setFromObject(object3d).getSize(size);
	return { height: size.y, extent: Math.max(size.x, size.y, size.z) };
}
