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

// Find the rig's head bone so a worn prop can ride the actual skull through the
// idle/walk animation instead of floating at a fixed height. Prefers a real Bone
// named like a head joint (Mixamo `mixamorigHead`, VRM `Head`/`J_Bip_C_Head`,
// or plain `head`), skipping the `HeadTop_End`/`*_end` leaf joints. Returns null
// for rigs without a recognisable head (the fallback capsule, abstract avatars),
// where the prop falls back to a height-anchored position.
function findHeadBone(rig) {
	let bone = null;
	rig.traverse((o) => {
		if (bone || !o.isBone) return;
		const n = (o.name || '').toLowerCase();
		if (n.includes('head') && !n.includes('end') && !n.includes('top')) bone = o;
	});
	return bone;
}

// A worn prop (hat / glasses). The GLB is auto-fitted to a head-ish width so one
// asset fits models of any height, anchored to the head bone when present (so it
// tracks head movement) and to a height fraction otherwise. `anchor` is 'head'
// (hats rest on the crown) or 'face' (glasses sit at eye level).
const PROP_TARGET_WIDTH_M = 0.34; // ~ a human head's width
function mountProp(rig, height, url, anchor) {
	const holder = new Group();
	rig.add(holder);
	const face = anchor === 'face';
	const headBone = findHeadBone(rig);
	const upOffset = (face ? 0.02 : 0.05) * height;   // above the bone origin
	const fwdOffset = face ? 0.05 : 0;                // nudge glasses off the face
	const fallbackY = height * (face ? 0.82 : 0.86);  // no-bone height anchor
	const tmp = new Vector3();
	let model = null;
	let cancelled = false;

	const place = () => {
		if (!model) return;
		if (headBone) {
			// Bone world position → rig-local (holder is a child of rig at unit scale),
			// so the prop glues to the head every frame, riding the animation.
			headBone.getWorldPosition(tmp);
			rig.worldToLocal(tmp);
			holder.position.set(tmp.x, tmp.y + upOffset, tmp.z + fwdOffset);
		} else {
			holder.position.set(0, fallbackY, fwdOffset);
		}
	};

	loadProp(url).then((scene) => {
		if (cancelled || !scene) return;
		model = scene.clone(true);
		model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });
		// Fit width to the target, then anchor the prop's reference point at the
		// holder origin: a hat rests on its base (sits on the crown); glasses centre
		// on the eye line.
		const box = new Box3().setFromObject(model);
		const size = box.getSize(new Vector3());
		const span = Math.max(size.x, size.z) || 1;
		model.scale.setScalar(PROP_TARGET_WIDTH_M / span);
		const fitted = new Box3().setFromObject(model);
		const c = fitted.getCenter(new Vector3());
		model.position.x -= c.x;
		model.position.z -= c.z;
		model.position.y -= face ? c.y : fitted.min.y;
		holder.add(model);
		place();
	});

	return {
		// Re-glue to the head each frame (cheap: one world-matrix read). No-op until
		// the GLB has loaded, or static when the rig has no head bone.
		tick: () => { if (headBone) place(); },
		// Dispose = detach the holder only. The clone shares the cached source's
		// geometry + materials (Object3D.clone(true) copies them by reference), so
		// those GPU resources live once in _propCache and are reused by every wearer —
		// disposing them here would corrupt the cache and other players' props. The
		// cache holds one parsed scene per prop URL (a handful total), so it's bounded,
		// not a leak; the clone's wrapper objects are freed for GC when the holder goes.
		dispose: () => { cancelled = true; rig.remove(holder); },
	};
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
	const tickers = [];
	if (visual.tint) undo.push(applyTint(rig, visual.tint));
	if (visual.prop) {
		const prop = mountProp(rig, height, visual.prop, visual.anchor);
		tickers.push(prop.tick); undo.push(prop.dispose);
	}
	if (visual.aura) {
		const aura = mountAura(rig, visual.aura);
		tickers.push(aura.tick); undo.push(aura.dispose);
	}
	return {
		tick: (dt) => { for (const t of tickers) t(dt); },
		dispose: () => { for (const fn of undo) { try { fn(); } catch {} } },
	};
}
