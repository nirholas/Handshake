/*
 * PBR material presets for three.ws viewers — data-first and framework-agnostic.
 *
 * Where `lights.js` / `floor.js` / `bloom.js` tune how a scene is *lit*, this module
 * tunes how a model's *surfaces* read: a curated set of physically-plausible
 * MeshStandardMaterial parameter sets (chrome, gold, glass, wood, …) plus helpers to
 * apply one to a loaded glTF non-destructively and to fan a base look out into a set
 * of seeded, reproducible colorway variants.
 *
 * The preset values are hand-tuned for MeshStandardMaterial / MeshPhysicalMaterial —
 * the material every three.ws viewer and Forge export uses — so a caller can drop any
 * preset onto any GLB and get a coherent result. All exports are pure data + pure
 * functions (THREE is passed in, never imported) so the package stays renderer- and
 * framework-agnostic and unit-testable without a WebGL context.
 *
 * Copyright 2026 three.ws contributors, Apache-2.0.
 */

/**
 * Curated PBR looks. Each value is a plain, frozen parameter set applied onto a
 * MeshStandardMaterial. Fields map 1:1 to material properties; `color`/`emissive`
 * are hex strings (parsed via the caller-supplied THREE.Color). `transparent`/
 * `opacity` are only set when present (so opaque presets never touch blending).
 *
 * @type {Readonly<Record<string, Readonly<MaterialPreset>>>}
 */
export const MATERIAL_PRESETS = Object.freeze({
	chrome: freeze({ label: 'Chrome', color: '#c9ced4', metalness: 1, roughness: 0.05, envMapIntensity: 1.6 }),
	gold: freeze({ label: 'Gold', color: '#ffcf5c', metalness: 1, roughness: 0.18, envMapIntensity: 1.4 }),
	copper: freeze({ label: 'Copper', color: '#c4744a', metalness: 1, roughness: 0.28, envMapIntensity: 1.3 }),
	// Real brushed-metal anisotropy: the elongated micro-grooves from brushing
	// scatter reflections along one axis only. anisotropy/anisotropyRotation
	// are MeshPhysicalMaterial-only fields (three >=0.140) — assignPreset()
	// sets them just like clearcoat/transmission, guarded so plain
	// MeshStandardMaterial targets silently skip the field.
	brushedSteel: freeze({ label: 'Brushed steel', color: '#b7bcc2', metalness: 0.95, roughness: 0.45, envMapIntensity: 1.1, anisotropy: 0.85, anisotropyRotation: 0 }),
	gunmetal: freeze({ label: 'Gunmetal', color: '#3b4048', metalness: 0.9, roughness: 0.5, envMapIntensity: 1 }),
	matte: freeze({ label: 'Matte plastic', color: '#8b90a0', metalness: 0, roughness: 0.9, envMapIntensity: 0.6 }),
	glossy: freeze({ label: 'Glossy plastic', color: '#4f8bff', metalness: 0, roughness: 0.18, envMapIntensity: 1 }),
	rubber: freeze({ label: 'Rubber', color: '#26282c', metalness: 0, roughness: 0.95, envMapIntensity: 0.4 }),
	ceramic: freeze({ label: 'Glazed ceramic', color: '#f2efe9', metalness: 0, roughness: 0.28, envMapIntensity: 1 }),
	// Legacy fake-glass look (opacity blend, no real refraction) — kept for
	// callers/tests that expect the old cheap preset. `realGlass` below is the
	// physically-correct KHR_materials_transmission version.
	glass: freeze({ label: 'Glass', color: '#dff1ff', metalness: 0, roughness: 0.05, envMapIntensity: 1.5, transparent: true, opacity: 0.35 }),
	// Real glass via transmission (light actually refracts through the
	// surface rather than alpha-blending) + IOR 1.45 (soda-lime glass).
	// Requires a MeshPhysicalMaterial + the renderer's transmission render
	// target (three.js sets this up automatically once `transmission > 0`).
	realGlass: freeze({ label: 'Glass (real)', color: '#f4fbff', metalness: 0, roughness: 0.03, envMapIntensity: 1.4, transmission: 1, thickness: 0.6, ior: 1.45, attenuationColor: '#eef8ff', attenuationDistance: 1.2 }),
	wood: freeze({ label: 'Wood', color: '#8a5a34', metalness: 0, roughness: 0.72, envMapIntensity: 0.6 }),
	stone: freeze({ label: 'Stone', color: '#8d8b86', metalness: 0, roughness: 0.85, envMapIntensity: 0.5 }),
	fabric: freeze({ label: 'Fabric', color: '#6b6456', metalness: 0, roughness: 0.88, envMapIntensity: 0.4, sheen: 0.6, sheenColor: '#8a8272', sheenRoughness: 0.7 }),
	// Real human skin: 0 metalness, 0.45-0.6 roughness (measured range for
	// bare skin), a warm sheen layer approximating subsurface scattering, and
	// a below-default specular F0 (skin reflects ~2.8% at normal incidence
	// vs. the ~4% MeshStandardMaterial default) so highlights read soft.
	skin: freeze({ label: 'Skin', color: '#e8b892', metalness: 0, roughness: 0.52, envMapIntensity: 0.7, sheen: 0.35, sheenColor: '#ffe0c2', sheenRoughness: 0.6, specularIntensity: 0.6 }),
	// Automotive base-coat + clearcoat: KHR_materials_clearcoat. The base
	// coat carries the color/metalness, the clearcoat is a separate, always
	// non-metal, near-mirror lacquer layer on top — this is what makes car
	// paint read as "wet" rather than flat metallic.
	carPaint: freeze({ label: 'Car paint', color: '#b3101c', metalness: 0.6, roughness: 0.35, envMapIntensity: 1.2, clearcoat: 1, clearcoatRoughness: 0.03 }),
	neon: freeze({ label: 'Neon', color: '#0b0b12', metalness: 0, roughness: 0.4, emissive: '#00ffd5', emissiveIntensity: 1.6, envMapIntensity: 0.8 }),
	holographic: freeze({ label: 'Holographic', color: '#b6a8ff', metalness: 1, roughness: 0.12, emissive: '#2a1f5c', emissiveIntensity: 0.35, envMapIntensity: 1.8 }),
});

/** Ordered list of preset ids — for building pickers. @type {readonly string[]} */
export const MATERIAL_PRESET_NAMES = Object.freeze(Object.keys(MATERIAL_PRESETS));

/**
 * Resolve a preset (by id or an inline config) and merge overrides — the material
 * analogue of `bloomConfig()`. Unknown ids throw so a typo never silently no-ops.
 *
 * @param {string | Partial<MaterialPreset>} presetOrConfig
 * @param {Partial<MaterialPreset>} [overrides]
 * @returns {MaterialPreset}
 */
export function materialPreset(presetOrConfig, overrides = {}) {
	let base;
	if (typeof presetOrConfig === 'string') {
		base = MATERIAL_PRESETS[presetOrConfig];
		if (!base) {
			throw new Error(
				`unknown material preset "${presetOrConfig}" — known: ${MATERIAL_PRESET_NAMES.join(', ')}`,
			);
		}
	} else if (presetOrConfig && typeof presetOrConfig === 'object') {
		base = presetOrConfig;
	} else {
		throw new Error('materialPreset: pass a preset id or a config object');
	}
	return { ...base, ...overrides };
}

/**
 * Apply a preset onto every compatible material under `root`, non-destructively.
 *
 * Standard-material properties (color, metalness, roughness, emissive, …) are the
 * only ones touched, and only on materials that actually expose them — a
 * MeshBasicMaterial or a sprite is skipped untouched. The previous values are
 * captured on first apply, so the returned `restore()` puts the model back exactly
 * as it was (the caller keeps the original; edits produce a reversible layer).
 *
 * @param {any} THREE  the three.js module (for `THREE.Color`)
 * @param {any} root   an Object3D with `.traverse` (a loaded glTF scene/group)
 * @param {string | Partial<MaterialPreset>} presetOrConfig
 * @param {{ overrides?: Partial<MaterialPreset> }} [opts]
 * @returns {{ restore: () => void, count: number }}
 */
export function applyMaterialPreset(THREE, root, presetOrConfig, opts = {}) {
	if (!THREE || typeof THREE.Color !== 'function') {
		throw new Error('applyMaterialPreset: first arg must be the three.js module (needs THREE.Color)');
	}
	if (!root || typeof root.traverse !== 'function') {
		throw new Error('applyMaterialPreset: second arg must be an Object3D with .traverse');
	}
	const cfg = materialPreset(presetOrConfig, opts.overrides);
	const captures = [];
	root.traverse((node) => {
		const mats = materialsOf(node);
		for (const m of mats) {
			if (!isStandardLike(m)) continue;
			captures.push(captureMaterial(m));
			assignPreset(THREE, m, cfg);
		}
	});
	return {
		count: captures.length,
		restore() {
			for (const cap of captures) restoreMaterial(cap);
		},
	};
}

/**
 * Fan a base look out into `count` reproducible colorway variants. Given the same
 * base + seed the output is byte-identical (mulberry32 PRNG), so variants are
 * shareable by seed and align with Forge's `seed` semantics. Hue rotates around the
 * base color; saturation/lightness and roughness/metalness jitter within safe
 * bounds. Emissive presets keep their glow. Pure — returns configs, mutates nothing.
 *
 * @param {string | Partial<MaterialPreset>} base
 * @param {{ seed?: number, count?: number, hueSpread?: number, jitter?: number }} [opts]
 * @returns {{ label: string, seed: number, config: MaterialPreset }[]}
 */
export function materialVariants(base, opts = {}) {
	const cfg = materialPreset(base);
	const count = clampInt(opts.count ?? 6, 1, 64);
	const seed = (opts.seed ?? 0) >>> 0;
	const hueSpread = opts.hueSpread ?? 360;
	const jitter = clamp01(opts.jitter ?? 0.18);
	const rand = mulberry32(seed);
	const baseHsl = hexToHsl(cfg.color || '#808080');
	const out = [];
	for (let i = 0; i < count; i++) {
		// Evenly spread the hue across the requested arc, nudged by seeded noise so
		// a set never looks mechanically banded.
		const hue = wrapHue(baseHsl.h + (hueSpread * i) / count + (rand() - 0.5) * (hueSpread / count));
		const sat = clamp01(baseHsl.s * (1 + (rand() - 0.5) * jitter));
		const light = clamp01(baseHsl.l * (1 + (rand() - 0.5) * jitter * 0.6));
		const rough = clamp01((cfg.roughness ?? 0.5) * (1 + (rand() - 0.5) * jitter));
		const metal = clamp01((cfg.metalness ?? 0) * (1 + (rand() - 0.5) * jitter * 0.5));
		out.push({
			label: `${cfg.label || 'variant'} ${i + 1}`,
			seed: (seed + i) >>> 0,
			config: { ...cfg, color: hslToHex(hue, sat, light), roughness: rough, metalness: metal },
		});
	}
	return out;
}

// ── material helpers ─────────────────────────────────────────────────────────

function materialsOf(node) {
	if (!node || !node.material) return [];
	return Array.isArray(node.material) ? node.material.filter(Boolean) : [node.material];
}

// A material we can meaningfully re-skin: it exposes the standard PBR knobs. Covers
// MeshStandardMaterial and MeshPhysicalMaterial; skips Basic/sprite/line materials.
function isStandardLike(m) {
	return !!m && 'metalness' in m && 'roughness' in m && !!m.color && typeof m.color.getHex === 'function';
}

// Physical-only (MeshPhysicalMaterial) scalar/color fields a preset may set.
// Absent on plain MeshStandardMaterial, so every read/write below is guarded
// by an `in m` check — a preset with clearcoat/transmission/anisotropy still
// applies its color/metalness/roughness cleanly to a Standard-only target,
// it just quietly skips the physical-only layer.
const PHYSICAL_SCALAR_FIELDS = ['clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'sheen', 'sheenRoughness', 'specularIntensity', 'anisotropy', 'anisotropyRotation', 'attenuationDistance'];
const PHYSICAL_COLOR_FIELDS = ['sheenColor', 'attenuationColor', 'specularColor'];

function captureMaterial(m) {
	const cap = {
		m,
		color: m.color.getHex(),
		metalness: m.metalness,
		roughness: m.roughness,
		emissive: m.emissive ? m.emissive.getHex() : null,
		emissiveIntensity: m.emissiveIntensity,
		envMapIntensity: m.envMapIntensity,
		transparent: m.transparent,
		opacity: m.opacity,
	};
	for (const f of PHYSICAL_SCALAR_FIELDS) if (f in m) cap[f] = m[f];
	for (const f of PHYSICAL_COLOR_FIELDS) if (m[f]) cap[f] = m[f].getHex();
	return cap;
}

function restoreMaterial(cap) {
	const { m } = cap;
	m.color.setHex(cap.color);
	m.metalness = cap.metalness;
	m.roughness = cap.roughness;
	if (m.emissive && cap.emissive != null) m.emissive.setHex(cap.emissive);
	m.emissiveIntensity = cap.emissiveIntensity;
	m.envMapIntensity = cap.envMapIntensity;
	m.transparent = cap.transparent;
	m.opacity = cap.opacity;
	for (const f of PHYSICAL_SCALAR_FIELDS) if (f in cap) m[f] = cap[f];
	for (const f of PHYSICAL_COLOR_FIELDS) if (f in cap && m[f]) m[f].setHex(cap[f]);
	m.needsUpdate = true;
}

function assignPreset(THREE, m, cfg) {
	if (cfg.color) m.color.set(cfg.color);
	if (cfg.metalness != null) m.metalness = cfg.metalness;
	if (cfg.roughness != null) m.roughness = cfg.roughness;
	if (m.emissive) {
		m.emissive.set(cfg.emissive || '#000000');
		m.emissiveIntensity = cfg.emissiveIntensity != null ? cfg.emissiveIntensity : cfg.emissive ? 1 : 0;
	}
	if (cfg.envMapIntensity != null && 'envMapIntensity' in m) m.envMapIntensity = cfg.envMapIntensity;
	for (const f of PHYSICAL_SCALAR_FIELDS) {
		if (cfg[f] != null && f in m) m[f] = cfg[f];
	}
	for (const f of PHYSICAL_COLOR_FIELDS) {
		if (cfg[f] != null && m[f]) m[f].set(cfg[f]);
	}
	if (cfg.transmission != null && 'transmission' in m) {
		// Real transmission replaces alpha-blend transparency entirely — a
		// realGlass preset must not also carry the old opacity-blend path.
		m.transparent = false;
		m.opacity = 1;
	} else if (cfg.transparent != null) {
		m.transparent = !!cfg.transparent;
		if (cfg.opacity != null) m.opacity = cfg.opacity;
	} else {
		// Opaque preset: undo any prior transparency/transmission so switching
		// glass→chrome is clean.
		m.transparent = false;
		m.opacity = 1;
		if ('transmission' in m) m.transmission = 0;
		if ('clearcoat' in m && cfg.clearcoat == null) m.clearcoat = 0;
		if ('anisotropy' in m && cfg.anisotropy == null) m.anisotropy = 0;
		if ('sheen' in m && cfg.sheen == null) m.sheen = 0;
	}
	m.needsUpdate = true;
}

// ── color + rng helpers (small, inline — no dependency for a few functions) ────

function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hexToHsl(hex) {
	const { r, g, b } = hexToRgb(hex);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
	}
	return { h, s, l };
}

function hslToHex(h, s, l) {
	h = wrapHue(h) / 360;
	let r;
	let g;
	let b;
	if (s === 0) {
		r = g = b = l;
	} else {
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	return rgbToHex(r, g, b);
}

function hue2rgb(p, q, t) {
	if (t < 0) t += 1;
	if (t > 1) t -= 1;
	if (t < 1 / 6) return p + (q - p) * 6 * t;
	if (t < 1 / 2) return q;
	if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
	return p;
}

function hexToRgb(hex) {
	const h = String(hex).replace('#', '');
	const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
	const int = parseInt(n, 16);
	return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}

function rgbToHex(r, g, b) {
	const to = (v) => {
		const s = Math.round(clamp01(v) * 255).toString(16);
		return s.length === 1 ? '0' + s : s;
	};
	return `#${to(r)}${to(g)}${to(b)}`;
}

function wrapHue(h) {
	return ((h % 360) + 360) % 360;
}
function clamp01(n) {
	return Math.min(1, Math.max(0, n));
}
function clampInt(n, lo, hi) {
	return Math.min(hi, Math.max(lo, Math.round(n)));
}
function freeze(o) {
	return Object.freeze(o);
}

/**
 * @typedef {Object} MaterialPreset
 * @property {string} [label]
 * @property {string} [color]            base color hex
 * @property {number} [metalness]        0..1
 * @property {number} [roughness]        0..1
 * @property {string} [emissive]         emissive color hex
 * @property {number} [emissiveIntensity]
 * @property {number} [envMapIntensity]
 * @property {boolean} [transparent]
 * @property {number} [opacity]          0..1, only with transparent
 * @property {number} [clearcoat]           0..1, MeshPhysicalMaterial only (KHR_materials_clearcoat)
 * @property {number} [clearcoatRoughness]  0..1
 * @property {number} [transmission]        0..1, MeshPhysicalMaterial only (KHR_materials_transmission)
 * @property {number} [thickness]           world units, paired with transmission
 * @property {number} [ior]                 1..2.333, index of refraction
 * @property {string} [attenuationColor]    hex, paired with transmission
 * @property {number} [attenuationDistance] world units
 * @property {number} [sheen]               0..1, MeshPhysicalMaterial only
 * @property {string} [sheenColor]           hex
 * @property {number} [sheenRoughness]       0..1
 * @property {number} [specularIntensity]   0..1, MeshPhysicalMaterial only
 * @property {string} [specularColor]        hex
 * @property {number} [anisotropy]           0..1, MeshPhysicalMaterial only (KHR_materials_anisotropy)
 * @property {number} [anisotropyRotation]   radians
 */
