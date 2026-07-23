/**
 * Avatar material realism — upgrades a loaded avatar's skin, eye, and hair
 * materials from flat glTF PBR (whatever the forge lane exported) to a
 * physically-tuned look, so avatars read as people instead of mannequins.
 *
 * Applied automatically by the viewer right after a humanoid GLB loads (see
 * viewer.js setContent()) — this is not a separate opt-in step. Mesh/material
 * classification is name-based (the same convention glb-canonicalize.js
 * already relies on for bone mapping): Ready Player Me / Avaturn / Mixamo /
 * VRM / VRoid exports all name skin, eye, and hair primitives predictably.
 * A rig with none of these names is left untouched — no guessing on props.
 *
 * Values are measured-real, not stylized:
 *   - skin: roughness 0.45-0.6 (matte-to-slightly-oily human skin), a warm
 *     sheen layer standing in for subsurface scattering (three.js's
 *     MeshPhysicalMaterial has no true SSS term for opaque geometry — sheen
 *     is the closest physically-based approximation to the soft, warm
 *     falloff skin shows at grazing angles), 0 metalness, low specular F0.
 *   - eyes: high clearcoat (wet cornea) over a low-roughness iris/sclera,
 *     IOR 1.376 (real corneal index).
 *   - hair: alpha-cutout, double-sided, low sheen, mid roughness (individual
 *     strands are not resolved so anisotropy would be misleading here).
 */

import { Color, DoubleSide } from 'three';
import { MeshPhysicalMaterial } from 'three';

// Boundary is "start/underscore/hyphen/whitespace" on one side and
// "underscore/hyphen/whitespace/end/(optional left|right suffix)" on the
// other — mesh names glue words together with no separator before a L/R
// suffix ("EyeLeft", "HairBack"), so the trailing boundary can't require a
// hard separator the way the leading one can.
const SKIN_NAME_RE = /(^|[_\s-])(skin|body|face|head|torso|arm|leg|hand|feet|foot)(?=[_\s-]|$)/i;
const WOLF3D_SKIN_RE = /wolf3d_skin|wolf3d_body|wolf3d_head/i;
const EYE_NAME_RE = /(^|[_\s-])(eye|cornea|iris|sclera)(left|right)?(?=[_\s-]|$)/i;
const HAIR_NAME_RE = /(^|[_\s-])(hair|eyebrow|eyelash|beard|fur)(left|right|back|front)?(?=[_\s-]|$)/i;
const TEETH_NAME_RE = /(^|[_\s-])(teeth|tongue|mouth)(?=[_\s-]|$)/i;

function nameOf(node) {
	return `${node?.name || ''} ${node?.material?.name || ''}`;
}

function classify(node) {
	const n = nameOf(node);
	if (WOLF3D_SKIN_RE.test(n) || SKIN_NAME_RE.test(n)) return 'skin';
	if (EYE_NAME_RE.test(n)) return 'eye';
	if (HAIR_NAME_RE.test(n)) return 'hair';
	if (TEETH_NAME_RE.test(n)) return 'teeth';
	return null;
}

// Fields worth carrying over from a plain MeshStandardMaterial onto its
// MeshPhysicalMaterial upgrade. Deliberately NOT using MeshPhysicalMaterial's
// own .copy() — it assumes the source is already a MeshPhysicalMaterial and
// unconditionally copies physical-only sub-objects (e.g. clearcoatNormalScale)
// straight off the source, which is undefined on a plain Standard material
// and throws. Copying field-by-field is the correct, source-type-agnostic way.
const CARRY_OVER_FIELDS = [
	'map', 'normalMap', 'normalScale', 'roughnessMap', 'metalnessMap', 'aoMap', 'aoMapIntensity',
	'emissiveMap', 'emissiveIntensity', 'alphaMap', 'envMap', 'envMapIntensity', 'side', 'transparent',
	'opacity', 'alphaTest', 'flatShading', 'wireframe', 'vertexColors', 'name', 'metalness', 'roughness',
];

function upgradeToPhysical(material) {
	if (material.isMeshPhysicalMaterial) return material;
	const physical = new MeshPhysicalMaterial();
	for (const f of CARRY_OVER_FIELDS) {
		if (material[f] !== undefined) physical[f] = material[f];
	}
	physical.color.copy(material.color);
	if (material.emissive) physical.emissive.copy(material.emissive);
	return physical;
}

function applySkin(material) {
	const m = upgradeToPhysical(material);
	m.roughness = Math.min(0.6, Math.max(0.45, m.roughness || 0.5));
	m.metalness = 0;
	// Warm sheen approximates the soft subsurface falloff of skin without a
	// true SSS term — sheenColor picks up the skin's own hue automatically.
	m.sheen = 0.35;
	m.sheenColor = new Color(0xffe0c2).multiply(m.color || new Color(0xffffff));
	m.sheenRoughness = 0.6;
	// Human skin's specular reflectance (F0) is ~0.028, well below the
	// MeshStandardMaterial default (~0.04, i.e. specularIntensity=1) — this
	// softens the plasticky highlight non-metals get by default.
	m.specularIntensity = 0.6;
	m.specularColor = new Color(0xffffff);
	m.envMapIntensity = Math.min(m.envMapIntensity ?? 1, 0.7);
	m.needsUpdate = true;
	return m;
}

function applyEye(material) {
	const m = upgradeToPhysical(material);
	m.roughness = 0.08;
	m.metalness = 0;
	m.clearcoat = 1;
	m.clearcoatRoughness = 0.03;
	m.ior = 1.376; // real corneal index of refraction
	m.envMapIntensity = Math.max(m.envMapIntensity ?? 1, 1.1);
	m.needsUpdate = true;
	return m;
}

function applyHair(material) {
	const m = upgradeToPhysical(material);
	m.roughness = Math.min(0.55, Math.max(0.3, m.roughness || 0.4));
	m.metalness = 0;
	m.sheen = 0.5;
	m.sheenColor = (m.color || new Color(0x2a1f1a)).clone();
	m.sheenRoughness = 0.4;
	m.side = DoubleSide;
	if (m.map && 'alphaTest' in m) m.alphaTest = Math.max(m.alphaTest || 0, 0.35);
	m.needsUpdate = true;
	return m;
}

function applyTeeth(material) {
	const m = upgradeToPhysical(material);
	m.roughness = 0.25;
	m.metalness = 0;
	m.clearcoat = 0.4;
	m.clearcoatRoughness = 0.15;
	m.needsUpdate = true;
	return m;
}

const APPLIERS = { skin: applySkin, eye: applyEye, hair: applyHair, teeth: applyTeeth };

/**
 * Traverse `root` and upgrade any skin/eye/hair/teeth mesh materials in
 * place. Idempotent — re-running on an already-upgraded material is a no-op
 * beyond reassigning the same tuned values. Returns a count per class so
 * callers (and tests) can assert coverage on a given rig.
 *
 * @param {import('three').Object3D} root
 * @returns {{skin:number, eye:number, hair:number, teeth:number}}
 */
export function applyAvatarMaterialRealism(root) {
	const counts = { skin: 0, eye: 0, hair: 0, teeth: 0 };
	if (!root || typeof root.traverse !== 'function') return counts;

	root.traverse((node) => {
		if (!node.isMesh || !node.material) return;
		const cls = classify(node);
		if (!cls) return;
		const applier = APPLIERS[cls];
		const mats = Array.isArray(node.material) ? node.material : [node.material];
		const upgraded = mats.map((mat) => {
			if (!mat || !('roughness' in mat)) return mat; // skip Basic/line/sprite materials
			counts[cls]++;
			return applier(mat);
		});
		node.material = Array.isArray(node.material) ? upgraded : upgraded[0];
	});

	return counts;
}

/**
 * True if `root` contains at least one skin or eye mesh by name — the
 * signal viewer.js uses to decide whether a loaded GLB is an avatar worth
 * running the realism pass on (props/vehicles/etc. never match).
 *
 * @param {import('three').Object3D} root
 * @returns {boolean}
 */
export function looksLikeAvatarMesh(root) {
	if (!root || typeof root.traverse !== 'function') return false;
	let found = false;
	root.traverse((node) => {
		if (found || !node.isMesh) return;
		const cls = classify(node);
		if (cls === 'skin' || cls === 'eye') found = true;
	});
	return found;
}
