// AccessoryManager — applies outfit morph bindings and bone-attached GLB accessories
// at runtime without touching the canonical avatar GLB on R2.
//
// Appearance lives in agent_identities.meta.appearance =
//   { outfit?, accessories, morphs, colors?, hidden? }.
// colors/hidden drive the garment-layer system (recolour + show/hide) defined
// in src/avatar-wardrobe.js; outfit is the legacy single-outfit field.
// The Empathy Layer's morph loop only iterates its own _morphTarget dict, so
// outfit morphs set here are never clobbered by emotion blending.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { resolveURI } from './ipfs.js';
import { collectSlotTargets } from './avatar-wardrobe.js';

const SINGLE_SLOT_KINDS = new Set(['outfit', 'hat', 'glasses']);

export class AccessoryManager {
	/** @param {import('./viewer.js').Viewer} viewer — raw Viewer, not SceneController */
	constructor(viewer) {
		this.viewer = viewer;
		this._loader = new GLTFLoader();
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
				console.warn(`[accessories] unknown preset id on boot: ${id}`);
			}
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
		let gltf;
		try {
			gltf = await _loadGLB(this._loader, preset.glbUrl);
		} catch (err) {
			console.warn(`[accessories] failed to load ${preset.glbUrl}:`, err);
			return;
		}

		const bone = _findBone(this.viewer?.content, preset.attachBone);
		if (!bone) {
			console.warn(
				`[accessories] bone not found: ${preset.attachBone} (preset: ${preset.id})`,
			);
			// Still record as applied so list() and removePreset() work correctly
			this._applied.set(preset.id, { preset, object: null });
			return;
		}

		const obj = gltf.scene;
		bone.add(obj);
		this._applied.set(preset.id, { preset, object: obj });
		this.viewer?.invalidate?.();
	}

	_applyMorphBinding(preset) {
		if (!this.viewer?.content) {
			console.warn(`[accessories] no model loaded yet for preset ${preset.id}`);
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

let _presetsCache = null;
async function _fetchPresets() {
	if (_presetsCache) return _presetsCache;
	const res = await fetch('/accessories/presets.json');
	_presetsCache = await res.json();
	return _presetsCache;
}
