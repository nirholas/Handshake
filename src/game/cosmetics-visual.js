// Cosmetic visual layer — turns a cosmetic's `visual` spec (sent in the server
// catalogue) into renderable Three.js objects layered over an avatar rig. This
// is the ONLY thing a cosmetic does: it changes how an avatar looks. Nothing
// here reads or writes any gameplay value.
//
// Three visual primitives, any of which a cosmetic may combine:
//   tint  — recolour the avatar's body materials (a dye). Multiplies into each
//           material's colour so textured models shift hue instead of going flat.
//   prop  — a GLB worn on the head (hats), auto-fitted to the avatar's height so
//           one asset sits correctly on any model.
//   aura  — a glowing, slowly-spinning ring at the avatar's feet.
//
// applyCosmetic() returns a handle: tick(dt) animates the aura, dispose() fully
// removes the layer and restores the original material colours. The rig owner
// re-applies after every avatar (re)load, since loading clears the rig.

import {
	Group, Mesh, MeshBasicMaterial, RingGeometry, Box3, Vector3,
	AdditiveBlending, DoubleSide,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { dracoLoader } from './avatar-rig.js';

// Share the Draco-enabled decoder module + cache with the avatar loader so prop
// GLBs (which may be Draco-compressed) decode without a second decoder instance.
const _loader = new GLTFLoader();
_loader.setDRACOLoader(dracoLoader);

// Cache each prop's loaded scene once; every wearer gets a deep clone so they
// never share (and mutate) one another's meshes.
const _propCache = new Map(); // url -> Promise<Object3D|null>
function loadProp(url) {
	if (!_propCache.has(url)) {
		_propCache.set(url, _loader.loadAsync(url)
			.then((g) => g.scene)
			.catch((err) => { console.warn('[cosmetics] prop load failed:', url, err?.message); return null; }));
	}
	return _propCache.get(url);
}

// Recolour every body material, remembering each material's original colour so
// dispose() can restore it exactly. Dedupes by material (a model often shares
// one across meshes) so we store/restore each once.
function applyTint(rig, hex) {
	const restore = new Map(); // material -> original hex
	rig.traverse((n) => {
		if (!n.isMesh) return;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (!m || !m.color || restore.has(m)) continue;
			restore.set(m, m.color.getHex());
			m.color.set(hex);
		}
	});
	return () => { for (const [m, orig] of restore) m.color?.setHex(orig); };
}

// A worn prop (hat). The GLB is auto-scaled so its width matches a head-ish
// target and seated near the top of the avatar, so a single asset fits models
// of any height without per-asset tuning.
const PROP_TARGET_WIDTH_M = 0.34; // ~ a human head's width
function mountProp(rig, height, url) {
	const holder = new Group();
	rig.add(holder);
	let cancelled = false;
	loadProp(url).then((scene) => {
		if (cancelled || !scene) return;
		const model = scene.clone(true);
		model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });
		// Fit width to the target, then rest the prop on top of the head.
		const box = new Box3().setFromObject(model);
		const size = box.getSize(new Vector3());
		const span = Math.max(size.x, size.z) || 1;
		const scale = PROP_TARGET_WIDTH_M / span;
		model.scale.setScalar(scale);
		const fitted = new Box3().setFromObject(model);
		const center = fitted.getCenter(new Vector3());
		// Seat the prop's base around the crown of the head (≈0.86 of total height).
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y += height * 0.86 - fitted.min.y;
		holder.add(model);
	});
	// Dispose = detach the holder only. The clone shares the cached source's
	// geometry + materials (Object3D.clone(true) copies them by reference), so
	// those GPU resources live once in _propCache and are reused by every wearer —
	// disposing them here would corrupt the cache and other players' props. The
	// cache holds one parsed scene per prop URL (a handful total), so it's bounded,
	// not a leak; the clone's wrapper objects are freed for GC when the holder goes.
	return () => { cancelled = true; rig.remove(holder); };
}

// A glowing ground aura: a bright inner ring plus a softer outer halo, laid flat
// at the feet, additively blended so it reads as light. tick() spins it and
// gently pulses the halo.
function mountAura(rig, hex) {
	const group = new Group();
	const mkRing = (inner, outer, opacity) => {
		const geo = new RingGeometry(inner, outer, 48);
		const mat = new MeshBasicMaterial({
			color: hex, transparent: true, opacity,
			blending: AdditiveBlending, side: DoubleSide, depthWrite: false,
		});
		const ring = new Mesh(geo, mat);
		ring.rotation.x = -Math.PI / 2;
		return ring;
	};
	const core = mkRing(0.42, 0.58, 0.85);
	const halo = mkRing(0.58, 0.92, 0.28);
	group.add(halo, core);
	group.position.y = 0.03;
	rig.add(group);
	let t = 0;
	return {
		tick: (dt) => {
			t += dt;
			group.rotation.y += dt * 0.6;
			halo.material.opacity = 0.20 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2));
		},
		dispose: () => {
			rig.remove(group);
			core.geometry.dispose(); core.material.dispose();
			halo.geometry.dispose(); halo.material.dispose();
		},
	};
}

// Apply a cosmetic `visual` spec to a rig at a known head-anchor `height`.
// Returns { tick(dt), dispose() }. Safe to call before the avatar model has
// finished loading — tint simply finds no meshes yet (callers re-apply on load),
// while a prop/aura attach to the rig regardless.
export function applyCosmetic(rig, height, visual) {
	if (!visual) return { tick() {}, dispose() {} };
	const undo = [];
	if (visual.tint) undo.push(applyTint(rig, visual.tint));
	if (visual.prop) undo.push(mountProp(rig, height, visual.prop));
	let aura = null;
	if (visual.aura) { aura = mountAura(rig, visual.aura); undo.push(aura.dispose); }
	return {
		tick: (dt) => aura?.tick(dt),
		dispose: () => { for (const fn of undo) { try { fn(); } catch {} } },
	};
}
