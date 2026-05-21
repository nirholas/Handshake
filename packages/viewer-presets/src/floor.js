/*
 * Floor reflection presets for three.ws avatar viewers.
 *
 * Portions of this file are derived from Ready Player Me's `visage` package
 * (https://github.com/readyplayerme/visage), specifically
 * src/components/FloorReflection/FloorReflection.component.tsx.
 * Original work: Copyright (c) 2023 Ready Player Me, MIT License.
 * Modifications: Copyright 2025-2026 three.ws contributors, Apache-2.0.
 *
 * What changed vs. the original:
 *   - Exports plain data (no React component, no @react-three/drei dep).
 *   - Caller wires the constants into their own MeshReflectorMaterial /
 *     custom reflector implementation.
 *   - Param names preserved so visage tutorials and the @three-ws/avatar-sdk
 *     viewer share a vocabulary.
 */

export const FLOOR_REFLECTION_DEFAULTS = Object.freeze({
	resolution: 512,
	mixBlur: 0.8,
	mixStrength: 80,
	metalness: 0.5,
	blur: [300, 200],
	mirror: 1,
	minDepthThreshold: 0.4,
	maxDepthThreshold: 1.4,
	depthScale: 1.2,
	depthToBlurRatioBias: 1,
	distortion: 0,
	mixContrast: 1,
	reflectorOffset: 0,
	roughness: 1,
	envMapIntensity: 0,
	// Plane geometry args (width, height) for the reflector mesh.
	planeSize: [20, 10],
	// Fog should match the canvas background color for a seamless transition
	// into the reflective plane.
	fogNear: 2,
	fogFar: 6,
});

/**
 * Returns a configuration object for a floor reflector mesh.
 *
 * @param {Partial<typeof FLOOR_REFLECTION_DEFAULTS> & { color: string }} props
 *   `color` is required; it should match the canvas background so the
 *   reflective plane fades seamlessly into the scene.
 */
export function floorReflectionConfig(props) {
	if (!props || typeof props.color !== 'string') {
		throw new Error('floorReflectionConfig: `color` is required and must match the canvas background');
	}
	return { ...FLOOR_REFLECTION_DEFAULTS, ...props };
}
