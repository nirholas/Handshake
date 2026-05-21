/*
 * Light rig presets for three.ws avatar viewers.
 *
 * Portions of this file are derived from Ready Player Me's `visage` package
 * (https://github.com/readyplayerme/visage), specifically
 * src/components/Lights/Lights.component.tsx.
 * Original work: Copyright (c) 2023 Ready Player Me, MIT License.
 * Modifications: Copyright 2025-2026 three.ws contributors, Apache-2.0.
 *
 * What changed vs. the original:
 *   - Stripped React-specific wiring; exports plain data + a framework-agnostic
 *     `buildLightRig(THREE)` factory that returns three.js Object3Ds.
 *   - Angles/positions/colors/intensities preserved from visage's tuning so
 *     avatars rendered through three.ws look color-accurate to the RPM
 *     reference setup.
 *   - Added a `lightTarget` Object3D builder so the rig is self-contained.
 */

export const LIGHT_CONFIG = Object.freeze({
	fillLightAngle: Math.PI / 3,
	backLightAngle: Math.PI / 8,
	keyLightAngle: Math.PI,
	silhouetteLightAngle: Math.PI * 1.5,
	// Positions are in three.js world coordinates with the avatar standing on (0, 0, 0).
	keyLightPosition: [0.5, 1.55, 0.5],
	liftLightPosition: [0.25, 1.7, 2.0],
	dirLightPosition: [-0.75, 2.5, -1.0],
	silhouetteLightPosition: [-1.5, 0.1, -1.5],
	defaults: Object.freeze({
		keyLightIntensity: 0.8,
		keyLightColor: '#FFFFFF',
		fillLightIntensity: 3.0,
		fillLightColor: '#6794FF',
		fillLightPosition: [-0.5, 1.6, -0.5],
		backLightIntensity: 6.0,
		backLightColor: '#FFB878',
		backLightPosition: [0.5, 1.6, -1.0],
		lightTarget: [0.0, 1.7, 0.0],
	}),
});

/**
 * Build the full visage-equivalent light rig as a three.js Group.
 *
 * Callers pass in their `THREE` namespace so this package stays a peer of
 * three.js, not a hard dependency.
 *
 * @param {object} THREE  The three.js namespace.
 * @param {Partial<typeof LIGHT_CONFIG.defaults>} [overrides]
 * @returns {{ group: any, headTarget: any, shoeTarget: any }}
 */
export function buildLightRig(THREE, overrides = {}) {
	const cfg = { ...LIGHT_CONFIG.defaults, ...overrides };

	const headTarget = new THREE.Object3D();
	headTarget.position.fromArray(cfg.lightTarget);

	const shoeTarget = new THREE.Object3D();
	shoeTarget.position.set(0, 0, 0);

	const group = new THREE.Group();
	group.add(headTarget);
	group.add(shoeTarget);

	// Fill light — strong blue rim on the right face side.
	const fill = new THREE.SpotLight(
		cfg.fillLightColor,
		cfg.fillLightIntensity,
		0,
		LIGHT_CONFIG.fillLightAngle,
	);
	fill.position.fromArray(cfg.fillLightPosition);
	fill.target = headTarget;
	fill.castShadow = true;
	group.add(fill);

	// Back light — warm rim on the left face side.
	const back = new THREE.SpotLight(
		cfg.backLightColor,
		cfg.backLightIntensity,
		0,
		LIGHT_CONFIG.backLightAngle,
	);
	back.position.fromArray(cfg.backLightPosition);
	back.target = headTarget;
	back.castShadow = true;
	group.add(back);

	// Key light — soft face fill.
	const key = new THREE.SpotLight(
		cfg.keyLightColor,
		cfg.keyLightIntensity,
		0,
		LIGHT_CONFIG.keyLightAngle,
	);
	key.position.fromArray(LIGHT_CONFIG.keyLightPosition);
	key.target = headTarget;
	group.add(key);

	// Lift light — soft body/shoe wash.
	const lift = new THREE.SpotLight(
		cfg.keyLightColor,
		cfg.keyLightIntensity * 0.25,
		0,
		LIGHT_CONFIG.keyLightAngle,
	);
	lift.position.fromArray(LIGHT_CONFIG.liftLightPosition);
	lift.target = shoeTarget;
	group.add(lift);

	// Silhouette light — rim on arms and legs.
	const silhouette = new THREE.SpotLight(
		cfg.keyLightColor,
		cfg.keyLightIntensity * 0.25,
		0,
		LIGHT_CONFIG.silhouetteLightAngle,
	);
	silhouette.position.fromArray(LIGHT_CONFIG.silhouetteLightPosition);
	silhouette.target = headTarget;
	group.add(silhouette);

	return { group, headTarget, shoeTarget };
}
