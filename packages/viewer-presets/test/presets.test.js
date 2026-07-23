import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LIGHT_CONFIG,
	FLOOR_REFLECTION_DEFAULTS,
	BLOOM_DEFAULTS,
	buildLightRig,
	floorReflectionConfig,
	bloomConfig,
	MATERIAL_PRESETS,
	MATERIAL_PRESET_NAMES,
	materialPreset,
	applyMaterialPreset,
	materialVariants,
} from '../src/index.js';

// ── minimal THREE.Color / material / object shims (no WebGL) ──────────────────
class FakeColor {
	constructor(hex = 0) {
		this._hex = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex >>> 0;
	}
	set(hex) {
		this._hex = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex >>> 0;
		return this;
	}
	setHex(h) {
		this._hex = h >>> 0;
		return this;
	}
	getHex() {
		return this._hex;
	}
}
const FakeTHREE = { Color: FakeColor };
function fakeStandardMaterial() {
	return {
		color: new FakeColor(0x808080),
		emissive: new FakeColor(0x000000),
		metalness: 0.3,
		roughness: 0.6,
		emissiveIntensity: 0,
		envMapIntensity: 1,
		transparent: false,
		opacity: 1,
		needsUpdate: false,
	};
}
// A root with .traverse yielding meshes carrying materials.
function fakeRoot(materials) {
	const nodes = materials.map((m) => ({ material: m }));
	return { traverse: (fn) => nodes.forEach(fn) };
}

// A MeshPhysicalMaterial-shaped fake — adds the clearcoat/transmission/sheen/
// anisotropy fields real MeshStandardMaterial lacks, so presets that use them
// (skin, carPaint, realGlass, brushedSteel) have something to write into.
function fakePhysicalMaterial() {
	return {
		...fakeStandardMaterial(),
		clearcoat: 0,
		clearcoatRoughness: 0,
		transmission: 0,
		thickness: 0,
		ior: 1.5,
		attenuationColor: new FakeColor(0xffffff),
		attenuationDistance: Infinity,
		sheen: 0,
		sheenColor: new FakeColor(0x000000),
		sheenRoughness: 1,
		specularIntensity: 1,
		specularColor: new FakeColor(0xffffff),
		anisotropy: 0,
		anisotropyRotation: 0,
	};
}

test('LIGHT_CONFIG preserves visage angles', () => {
	assert.equal(LIGHT_CONFIG.fillLightAngle, Math.PI / 3);
	assert.equal(LIGHT_CONFIG.backLightAngle, Math.PI / 8);
	assert.equal(LIGHT_CONFIG.keyLightAngle, Math.PI);
	assert.equal(LIGHT_CONFIG.silhouetteLightAngle, Math.PI * 1.5);
});

test('LIGHT_CONFIG defaults preserve visage colors/intensities', () => {
	const d = LIGHT_CONFIG.defaults;
	assert.equal(d.keyLightIntensity, 0.8);
	assert.equal(d.keyLightColor, '#FFFFFF');
	assert.equal(d.fillLightIntensity, 3.0);
	assert.equal(d.fillLightColor, '#6794FF');
	assert.equal(d.backLightIntensity, 6.0);
	assert.equal(d.backLightColor, '#FFB878');
});

test('LIGHT_CONFIG is frozen', () => {
	assert.throws(() => {
		LIGHT_CONFIG.fillLightAngle = 0;
	});
});

test('FLOOR_REFLECTION_DEFAULTS preserves visage params', () => {
	assert.equal(FLOOR_REFLECTION_DEFAULTS.resolution, 512);
	assert.equal(FLOOR_REFLECTION_DEFAULTS.mixStrength, 80);
	assert.deepEqual(FLOOR_REFLECTION_DEFAULTS.blur, [300, 200]);
	assert.equal(FLOOR_REFLECTION_DEFAULTS.metalness, 0.5);
	assert.equal(FLOOR_REFLECTION_DEFAULTS.mixBlur, 0.8);
});

test('BLOOM_DEFAULTS preserves visage tuning', () => {
	assert.equal(BLOOM_DEFAULTS.luminanceThreshold, 1);
	assert.equal(BLOOM_DEFAULTS.luminanceSmoothing, 1);
	assert.equal(BLOOM_DEFAULTS.mipmapBlur, true);
	assert.equal(BLOOM_DEFAULTS.intensity, 0.1);
});

test('floorReflectionConfig requires color', () => {
	assert.throws(() => floorReflectionConfig({}), /color/);
	assert.throws(() => floorReflectionConfig(), /color/);
});

test('floorReflectionConfig merges overrides', () => {
	const cfg = floorReflectionConfig({ color: '#000', resolution: 1024 });
	assert.equal(cfg.color, '#000');
	assert.equal(cfg.resolution, 1024);
	assert.equal(cfg.mixStrength, 80); // default preserved
});

test('bloomConfig merges overrides', () => {
	const cfg = bloomConfig({ intensity: 0.5 });
	assert.equal(cfg.intensity, 0.5);
	assert.equal(cfg.luminanceThreshold, 1);
});

test('buildLightRig produces five spotlights + two targets in a group', () => {
	// Minimal THREE shim — just enough to satisfy buildLightRig.
	class FakeObject3D {
		constructor() {
			this.position = {
				fromArray: function (arr) {
					this.x = arr[0];
					this.y = arr[1];
					this.z = arr[2];
					return this;
				},
				set: function (x, y, z) {
					this.x = x;
					this.y = y;
					this.z = z;
					return this;
				},
			};
			this.children = [];
		}
		add(child) {
			this.children.push(child);
		}
	}
	class FakeSpotLight extends FakeObject3D {
		constructor(color, intensity, _distance, angle) {
			super();
			this.color = color;
			this.intensity = intensity;
			this.angle = angle;
			this.isSpotLight = true;
		}
	}
	const THREE = { Object3D: FakeObject3D, Group: FakeObject3D, SpotLight: FakeSpotLight };

	const { group, headTarget, shoeTarget } = buildLightRig(THREE);
	const lights = group.children.filter((c) => c.isSpotLight);
	assert.equal(lights.length, 5);
	assert.ok(group.children.includes(headTarget));
	assert.ok(group.children.includes(shoeTarget));
	// Verify the rim colors made it through.
	const fill = lights.find((l) => l.color === '#6794FF');
	const back = lights.find((l) => l.color === '#FFB878');
	assert.ok(fill, 'fill light should be present');
	assert.ok(back, 'back light should be present');
	assert.equal(fill.intensity, 3.0);
	assert.equal(back.intensity, 6.0);
});

test('buildLightRig accepts overrides without losing defaults', () => {
	class FakeObject3D {
		constructor() {
			this.position = { fromArray() {}, set() {} };
			this.children = [];
		}
		add(c) {
			this.children.push(c);
		}
	}
	class FakeSpotLight extends FakeObject3D {
		constructor(color, intensity, _distance, angle) {
			super();
			this.color = color;
			this.intensity = intensity;
			this.angle = angle;
			this.isSpotLight = true;
		}
	}
	const THREE = { Object3D: FakeObject3D, Group: FakeObject3D, SpotLight: FakeSpotLight };
	const { group } = buildLightRig(THREE, { fillLightColor: '#ff00ff' });
	const fill = group.children.find((c) => c.isSpotLight && c.color === '#ff00ff');
	assert.ok(fill, 'override color should be applied to fill light');
});

// ── material presets ─────────────────────────────────────────────────────────

test('MATERIAL_PRESETS are frozen and expose core PBR looks', () => {
	for (const name of ['chrome', 'gold', 'glass', 'wood', 'neon']) {
		assert.ok(MATERIAL_PRESETS[name], `missing preset ${name}`);
	}
	assert.equal(MATERIAL_PRESETS.chrome.metalness, 1);
	assert.equal(MATERIAL_PRESETS.matte.metalness, 0);
	assert.equal(MATERIAL_PRESETS.glass.transparent, true);
	assert.throws(() => {
		MATERIAL_PRESETS.chrome.metalness = 0;
	});
	assert.ok(MATERIAL_PRESET_NAMES.includes('chrome'));
	assert.equal(MATERIAL_PRESET_NAMES.length, Object.keys(MATERIAL_PRESETS).length);
});

test('materialPreset resolves ids, merges overrides, rejects unknowns', () => {
	const gold = materialPreset('gold', { roughness: 0.5 });
	assert.equal(gold.metalness, 1);
	assert.equal(gold.roughness, 0.5); // override wins
	assert.throws(() => materialPreset('unobtanium'), /unknown material preset/);
	assert.throws(() => materialPreset(42), /preset id or a config/);
});

test('applyMaterialPreset mutates standard materials and restore() reverts exactly', () => {
	const mat = fakeStandardMaterial();
	const before = { color: mat.color.getHex(), metalness: mat.metalness, roughness: mat.roughness };
	const handle = applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'chrome');
	assert.equal(handle.count, 1);
	assert.equal(mat.metalness, 1);
	assert.equal(mat.roughness, MATERIAL_PRESETS.chrome.roughness);
	assert.equal(mat.needsUpdate, true);
	handle.restore();
	assert.equal(mat.color.getHex(), before.color);
	assert.equal(mat.metalness, before.metalness);
	assert.equal(mat.roughness, before.roughness);
});

test('applyMaterialPreset skips non-standard materials untouched', () => {
	const basic = { color: new FakeColor(0x123456), needsUpdate: false }; // no metalness/roughness
	const handle = applyMaterialPreset(FakeTHREE, fakeRoot([basic]), 'gold');
	assert.equal(handle.count, 0);
	assert.equal(basic.color.getHex(), 0x123456);
	assert.equal(basic.needsUpdate, false);
});

test('applyMaterialPreset glass sets transparency; switching to opaque clears it', () => {
	const mat = fakeStandardMaterial();
	applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'glass');
	assert.equal(mat.transparent, true);
	assert.ok(mat.opacity < 1);
	applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'chrome');
	assert.equal(mat.transparent, false);
	assert.equal(mat.opacity, 1);
});

test('applyMaterialPreset validates its args', () => {
	assert.throws(() => applyMaterialPreset({}, fakeRoot([]), 'gold'), /three\.js module/);
	assert.throws(() => applyMaterialPreset(FakeTHREE, {}, 'gold'), /Object3D with \.traverse/);
});

test('materialVariants is deterministic per seed and honors count', () => {
	const a = materialVariants('gold', { seed: 7, count: 5 });
	const b = materialVariants('gold', { seed: 7, count: 5 });
	const c = materialVariants('gold', { seed: 8, count: 5 });
	assert.equal(a.length, 5);
	assert.deepEqual(a, b, 'same seed → identical variants');
	assert.notDeepEqual(a[0].config.color, c[0].config.color, 'different seed → different colorway');
	for (const v of a) {
		assert.match(v.config.color, /^#[0-9a-f]{6}$/);
		assert.ok(v.config.roughness >= 0 && v.config.roughness <= 1);
		assert.ok(v.config.metalness >= 0 && v.config.metalness <= 1);
	}
});

test('materialVariants clamps count into [1,64]', () => {
	assert.equal(materialVariants('wood', { count: 0 }).length, 1);
	assert.equal(materialVariants('wood', { count: 999 }).length, 64);
});

// ── measured-value physical presets ──────────────────────────────────────────

test('MATERIAL_PRESETS exposes the measured-value physical presets', () => {
	assert.equal(MATERIAL_PRESETS.skin.metalness, 0);
	assert.ok(MATERIAL_PRESETS.skin.roughness >= 0.45 && MATERIAL_PRESETS.skin.roughness <= 0.6);
	assert.equal(MATERIAL_PRESETS.carPaint.clearcoat, 1);
	assert.equal(MATERIAL_PRESETS.realGlass.transmission, 1);
	assert.equal(MATERIAL_PRESETS.realGlass.ior, 1.45);
	assert.ok(MATERIAL_PRESETS.brushedSteel.anisotropy > 0);
});

test('applyMaterialPreset writes clearcoat onto a MeshPhysicalMaterial target', () => {
	const mat = fakePhysicalMaterial();
	applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'carPaint');
	assert.equal(mat.clearcoat, 1);
	assert.equal(mat.clearcoatRoughness, MATERIAL_PRESETS.carPaint.clearcoatRoughness);
	assert.equal(mat.metalness, MATERIAL_PRESETS.carPaint.metalness);
});

test('applyMaterialPreset writes transmission onto a MeshPhysicalMaterial target and clears legacy transparency', () => {
	const mat = fakePhysicalMaterial();
	applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'realGlass');
	assert.equal(mat.transmission, 1);
	assert.equal(mat.ior, 1.45);
	assert.equal(mat.transparent, false, 'transmission replaces alpha-blend, not stacks with it');
});

test('applyMaterialPreset writes sheen onto skin and anisotropy onto brushedSteel', () => {
	const skinMat = fakePhysicalMaterial();
	applyMaterialPreset(FakeTHREE, fakeRoot([skinMat]), 'skin');
	assert.equal(skinMat.sheen, MATERIAL_PRESETS.skin.sheen);
	assert.equal(skinMat.specularIntensity, MATERIAL_PRESETS.skin.specularIntensity);

	const steelMat = fakePhysicalMaterial();
	applyMaterialPreset(FakeTHREE, fakeRoot([steelMat]), 'brushedSteel');
	assert.equal(steelMat.anisotropy, MATERIAL_PRESETS.brushedSteel.anisotropy);
});

test('applyMaterialPreset physical fields are a no-op on a plain Standard-shaped material', () => {
	const mat = fakeStandardMaterial(); // no clearcoat/transmission/sheen/anisotropy fields
	const handle = applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'carPaint');
	assert.equal(handle.count, 1, 'still applies the standard-material fields');
	assert.equal(mat.metalness, MATERIAL_PRESETS.carPaint.metalness);
	assert.equal('clearcoat' in mat, false);
});

test('applyMaterialPreset restore() reverts physical fields exactly', () => {
	const mat = fakePhysicalMaterial();
	const before = { clearcoat: mat.clearcoat, transmission: mat.transmission, sheen: mat.sheen };
	const handle = applyMaterialPreset(FakeTHREE, fakeRoot([mat]), 'realGlass');
	assert.notEqual(mat.transmission, before.transmission);
	handle.restore();
	assert.equal(mat.clearcoat, before.clearcoat);
	assert.equal(mat.transmission, before.transmission);
	assert.equal(mat.sheen, before.sheen);
});
