// AccessoryManager — applies outfit morph bindings and bone-attached GLB accessories
// at runtime without touching the canonical avatar GLB on R2.
//
// Appearance lives in agent_identities.meta.appearance =
//   { outfit?, accessories, morphs, colors?, hidden? }.
// colors/hidden drive the garment-layer system (recolour + show/hide) defined
// in src/avatar-wardrobe.js; outfit is the legacy single-outfit field.
// The Empathy Layer's morph loop only iterates its own _morphTarget dict, so
// outfit morphs set here are never clobbered by emotion blending.

import { Box3, Group, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { resolveURI } from './ipfs.js';
import { collectSlotTargets } from './avatar-wardrobe.js';
import { isSafeQueryModelUrl } from './shared/safe-model-url.js';
import { log } from './shared/log.js';

const SINGLE_SLOT_KINDS = new Set(['outfit', 'hat', 'glasses']);

export class AccessoryManager {
	/** @param {import('./viewer.js').Viewer} viewer — raw Viewer, not SceneController */
	constructor(viewer) {
		this.viewer = viewer;
		this._loader = new GLTFLoader();
		// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
		this._meshoptReady = getMeshoptDecoder().then((d) => this._loader.setMeshoptDecoder(d));
		// id → { preset, object?: THREE.Group, morphs?: Array<{node,name,idx}> }
		this._applied = new Map();
		// material.uuid → original THREE.Color, captured the first time we tint a
		// garment so "default" can restore the authored colour exactly.
		this._slotColorOriginals = new Map();
		// Last applied layer state ({colors, hidden}), replayed after a model
		// swap (onModelReplaced).
		this._layers = null;
	}

	/**
	 * Apply a preset. Handles conflict rules (only one outfit/hat/glasses at a time).
	 * If the preset is already applied, re-applies it (no-op if same).
	 * @param {{ id, kind, glbUrl?, attachBone?, morphBinding?, name }} preset
	 */
	async applyPreset(preset) {
		// Enforce single-slot per kind (not for earrings)
		if (SINGLE_SLOT_KINDS.has(preset.kind)) {
			this._removeByKind(preset.kind);
		} else if (this._applied.has(preset.id)) {
			return; // earrings: silently skip duplicates
		}

		if (preset.glbUrl) {
			await this._applyGLB(preset);
		} else if (preset.morphBinding) {
			this._applyMorphBinding(preset);
		}
	}

	/** Remove a preset by id, disposing GPU resources. */
	removePreset(id) {
		const entry = this._applied.get(id);
		if (!entry) return;

		if (entry.object) {
			entry.object.parent?.remove(entry.object);
			_disposeObject(entry.object);
		}
		if (entry.morphs) {
			_zeroMorphs(entry.morphs);
		}

		this._applied.delete(id);
		this.viewer?.invalidate?.();
	}

	/** Returns the currently applied preset ids. */
	list() {
		return [...this._applied.keys()];
	}

	/**
	 * Apply all presets from a meta.appearance record on boot.
	 * Fetches presets.json to resolve ids → full preset objects.
	 */
	async hydrateFromAppearance(appearance) {
		if (!appearance) return;

		const presets = await _fetchPresets();
		const byId = new Map(presets.map((p) => [p.id, p]));

		const ids = [];
		if (appearance.outfit) ids.push(appearance.outfit);
		for (const id of appearance.accessories || []) ids.push(id);

		// Extra morph overrides (arbitrary morph names, not preset-driven)
		if (appearance.morphs && this.viewer?.content) {
			_applyRawMorphs(this.viewer.content, appearance.morphs);
		}

		// Garment-layer state: hide/show + recolour the model's own meshes.
		if (appearance.colors || appearance.hidden) {
			this.applyLayers({ colors: appearance.colors, hidden: appearance.hidden });
		}

		for (const id of ids) {
			const preset = byId.get(id);
			if (preset) {
				await this.applyPreset(preset);
			} else {
				log.warn(`[accessories] unknown preset id on boot: ${id}`);
			}
		}

		// Custom bone-mounted props (Scene Composer's saved outfit). These carry
		// their own URL instead of naming a catalog preset, so they become
		// synthetic presets and ride the same load-and-attach path. The URL was
		// host-checked when it was stored (api/_lib/accessories.js); re-checking
		// here keeps a record written before that guard from loading a stranger's
		// bytes into this page.
		for (const preset of attachmentPresets(appearance.attachments)) {
			await this.applyPreset(preset);
		}
	}

	/**
	 * Called when the avatar GLB is replaced (task 01/02 path).
	 * Re-attaches bone overlays to the new skeleton; re-applies morph bindings.
	 * Surfaces a console warning per preset if its required bone/morph is missing.
	 */
	async onModelReplaced(newViewer) {
		if (newViewer) this.viewer = newViewer;

		const snapshot = [...this._applied.values()].map((e) => e.preset);

		// Detach/dispose everything — old bone refs belong to the discarded model
		for (const [, entry] of this._applied) {
			if (entry.object) _disposeObject(entry.object);
		}
		this._applied.clear();

		// The colour-restore receipts referenced the discarded model's materials.
		this._slotColorOriginals = new Map();

		for (const preset of snapshot) {
			await this.applyPreset(preset);
		}

		// Replay garment-layer state onto the new skeleton's meshes.
		if (this._layers) this.applyLayers(this._layers);
	}

	/**
	 * Apply garment-layer state to the live model: toggle each detected slot's
	 * meshes visible/hidden and tint their materials. Idempotent and absolute —
	 * pass the full layer state every call; slots not listed reset to visible +
	 * original colour. See src/avatar-wardrobe.js for the slot taxonomy.
	 *
	 * @param {{ colors?: { [slotId:string]: string }, hidden?: string[] }} layers
	 */
	applyLayers(layers) {
		const root = this.viewer?.content;
		if (!root) return;
		const colors = layers?.colors || {};
		const hiddenSet = new Set(layers?.hidden || []);
		this._layers = { colors: { ...colors }, hidden: [...hiddenSet] };

		const targets = collectSlotTargets(root);
		for (const [slotId, { meshes, materials }] of targets) {
			const hide = hiddenSet.has(slotId);
			for (const mesh of meshes) mesh.visible = !hide;
			const hex = colors[slotId] || null;
			for (const mat of materials) _tintMaterial(mat, hex, this._slotColorOriginals);
		}
		this.viewer?.invalidate?.();
	}

	// ── Private ──────────────────────────────────────────────────────────────

	async _applyGLB(preset) {
		await this._meshoptReady;
		let gltf;
		try {
			gltf = await _loadGLB(this._loader, preset.glbUrl);
		} catch (err) {
			log.warn(`[accessories] failed to load ${preset.glbUrl}:`, err);
			return;
		}

		const bone = _findBone(this.viewer?.content, preset.attachBone);
		if (!bone) {
			log.warn(
				`[accessories] bone not found: ${preset.attachBone} (preset: ${preset.id})`,
			);
			// Still record as applied so list() and removePreset() work correctly
			this._applied.set(preset.id, { preset, object: null });
			return;
		}

		// Anchored props (currently eyewear) get a placement pass that recentres,
		// auto-fits and offsets the asset to the right facial landmark — source
		// GLBs vary (some authored at the head-bone origin, some lying flat), so a
		// raw bone.add() lands them inside the cheeks. Props without an anchor keep
		// the legacy raw attach (hats/earrings already bake their offset into the GLB).
		const obj = preset.anchor
			? _placeAnchoredProp(gltf.scene, bone, this.viewer?.content, preset.anchor)
			: gltf.scene;
		bone.add(obj);
		this._applied.set(preset.id, { preset, object: obj });
		this.viewer?.invalidate?.();
	}

	_applyMorphBinding(preset) {
		if (!this.viewer?.content) {
			log.warn(`[accessories] no model loaded yet for preset ${preset.id}`);
			return;
		}

		const morphs = _applyMorphsToModel(this.viewer.content, preset.morphBinding);
		this._applied.set(preset.id, { preset, morphs });
		this.viewer?.invalidate?.();
	}

	_removeByKind(kind) {
		for (const [id, entry] of this._applied) {
			if (entry.preset.kind === kind) {
				this.removePreset(id);
				return; // only one active per single-slot kind
			}
		}
	}
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _loadGLB(loader, url) {
	const resolved = resolveURI(url);
	return new Promise((resolve, reject) => {
		loader.load(resolved, resolve, undefined, reject);
	});
}

/**
 * Find a bone by name, tolerating mixamorig / CC_Base_ prefixes.
 * Returns the first match or null.
 */
function _findBone(model, boneName) {
	if (!model || !boneName) return null;
	const target = boneName.toLowerCase();
	let found = null;
	model.traverse((n) => {
		if (found || !n.isBone) return;
		const canon = n.name
			.replace(/^mixamorig[_:]?/i, '')
			.replace(/^CC_Base_/i, '')
			.replace(/^rig_/i, '')
			.toLowerCase();
		if (canon === target || n.name === boneName) found = n;
	});
	return found;
}

// Placement ratios are expressed against the avatar's overall height so the same
// numbers work whether the loaded GLB is a ~1.8 m ReadyPlayerMe body or a custom
// avatar normalised to a different scale. Calibrated for the 'face' (eyewear)
// anchor: width ≈ a human face, lifted from the head-bone origin to the eye line
// and pushed forward to the front of the face.
const FACE_WIDTH_RATIO = 0.083; // ~0.15 m at 1.8 m tall
const FACE_UP_RATIO = 0.033; // head-bone origin → eye line
const FACE_FWD_RATIO = 0.044; // head-bone origin → face front
const DEFAULT_HEIGHT_M = 1.8;

/**
 * Recentre, auto-fit and offset an accessory GLB so it sits on the correct facial
 * landmark, then return it wrapped in a holder whose transform is expressed in the
 * bone's local space (the caller parents the holder to the bone). The holder is
 * kept world-upright and world-scaled regardless of the bone's own frame, so the
 * prop tracks head movement without inheriting bone rotation/scale skew.
 *
 * @param {import('three').Object3D} scene  loaded GLB scene (mutated in place)
 * @param {import('three').Bone} bone       attach bone (already resolved)
 * @param {import('three').Object3D|null} root  avatar root, for height estimation
 * @param {'face'} anchor
 * @returns {import('three').Group}
 */
function _placeAnchoredProp(scene, bone, root, anchor) {
	if (root) root.updateMatrixWorld(true);
	const height = root
		? new Box3().setFromObject(root).getSize(new Vector3()).y || DEFAULT_HEIGHT_M
		: DEFAULT_HEIGHT_M;

	const model = scene;

	// 1. Fit width so any source asset matches this avatar's face.
	let box = new Box3().setFromObject(model);
	let size = box.getSize(new Vector3());
	const span = Math.max(size.x, size.z) || 1;
	model.scale.setScalar((FACE_WIDTH_RATIO * height) / span);

	// 2. Stand up props authored lying flat (e.g. shades modelled in the XZ plane).
	box = new Box3().setFromObject(model);
	size = box.getSize(new Vector3());
	if (size.y < size.x * 0.3) {
		model.rotateX(-Math.PI / 2);
	}

	// 3. Recentre the mesh on its own midpoint so the holder origin is its pivot.
	box = new Box3().setFromObject(model);
	const center = box.getCenter(new Vector3());
	model.position.sub(center);

	const holder = new Group();
	holder.add(model);

	// 4. Offset from the head-bone origin to the eye line, in world axes, then map
	//    into the bone's local frame and cancel the bone's rotation + scale so the
	//    prop renders upright at true scale.
	const target = bone
		.getWorldPosition(new Vector3())
		.add(new Vector3(0, FACE_UP_RATIO * height, FACE_FWD_RATIO * height));
	holder.position.copy(bone.worldToLocal(target));
	holder.quaternion.copy(bone.getWorldQuaternion(new Quaternion()).invert());
	const boneScale = bone.getWorldScale(new Vector3());
	holder.scale.set(1 / (boneScale.x || 1), 1 / (boneScale.y || 1), 1 / (boneScale.z || 1));

	return holder;
}

/**
 * Set morph target influences from a name→weight map.
 * Returns a receipts array that _zeroMorphs() can use to undo.
 */
function _applyMorphsToModel(model, binding) {
	const receipts = [];
	model.traverse((node) => {
		if (!node.isMesh || !node.morphTargetDictionary || !node.morphTargetInfluences) return;
		for (const [name, weight] of Object.entries(binding)) {
			const idx = node.morphTargetDictionary[name];
			if (idx === undefined) continue;
			node.morphTargetInfluences[idx] = Math.max(0, Math.min(1, weight));
			receipts.push({ node, idx });
		}
	});
	return receipts;
}

/** Apply raw morph overrides (arbitrary names, not preset-driven). */
function _applyRawMorphs(model, morphs) {
	model.traverse((node) => {
		if (!node.isMesh || !node.morphTargetDictionary || !node.morphTargetInfluences) return;
		for (const [name, weight] of Object.entries(morphs)) {
			const idx = node.morphTargetDictionary[name];
			if (idx === undefined) continue;
			node.morphTargetInfluences[idx] = Math.max(0, Math.min(1, weight));
		}
	});
}

/**
 * Tint (or restore) a single material. `hex` multiplies the authored base
 * colour via material.color (glTF baseColorFactor); passing null restores the
 * original colour captured on first tint. Records originals keyed by material
 * uuid so repeated tints don't drift.
 */
function _tintMaterial(m, hex, originals) {
	if (!m || !m.color) return;
	if (!originals.has(m.uuid)) originals.set(m.uuid, m.color.clone());
	if (hex) m.color.set(hex);
	else m.color.copy(originals.get(m.uuid));
	m.needsUpdate = true;
}

function _zeroMorphs(receipts) {
	for (const { node, idx } of receipts) {
		if (node.morphTargetInfluences) node.morphTargetInfluences[idx] = 0;
	}
}

function _disposeObject(obj) {
	obj.traverse((child) => {
		child.geometry?.dispose();
		if (child.material) {
			const mats = Array.isArray(child.material) ? child.material : [child.material];
			for (const m of mats) {
				m.map?.dispose();
				m.normalMap?.dispose();
				m.roughnessMap?.dispose();
				m.metalnessMap?.dispose();
				m.emissiveMap?.dispose();
				m.dispose();
			}
		}
	});
}

/**
 * Turn stored `appearance.attachments` into synthetic presets the normal
 * apply path understands. Ids are namespaced (`attach:<i>:<bone>`) so they can
 * never collide with a catalog preset id, and `kind` is 'accessory' because
 * these stack rather than replacing a single slot the way a hat does.
 *
 * @param {Array<{bone: string, url: string, name?: string}> | undefined} attachments
 * @returns {Array<{id: string, kind: string, glbUrl: string, attachBone: string, label: string}>}
 */
export function attachmentPresets(attachments) {
	if (!Array.isArray(attachments)) return [];
	const out = [];
	attachments.forEach((a, i) => {
		if (!a || typeof a.bone !== 'string' || !a.bone) return;
		if (!isSafeQueryModelUrl(a.url)) {
			log.warn(`[accessories] attachment url rejected: ${a.url}`);
			return;
		}
		out.push({
			id: `attach:${i}:${a.bone}`,
			kind: 'accessory',
			glbUrl: a.url,
			attachBone: a.bone,
			label: a.name || 'Attachment',
		});
	});
	return out;
}

let _presetsCache = null;
async function _fetchPresets() {
	if (_presetsCache) return _presetsCache;
	const res = await fetch('/accessories/presets.json');
	_presetsCache = await res.json();
	return _presetsCache;
}
