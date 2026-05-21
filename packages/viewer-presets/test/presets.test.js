import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LIGHT_CONFIG,
	FLOOR_REFLECTION_DEFAULTS,
	BLOOM_DEFAULTS,
	buildLightRig,
	floorReflectionConfig,
	bloomConfig,
} from '../src/index.js';

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
