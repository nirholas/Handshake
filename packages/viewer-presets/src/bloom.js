/*
 * Postprocessing/bloom presets for three.ws avatar viewers.
 *
 * Portions of this file are derived from Ready Player Me's `visage` package
 * (https://github.com/readyplayerme/visage), specifically
 * src/components/Bloom/Bloom.component.tsx.
 * Original work: Copyright (c) 2023 Ready Player Me, MIT License.
 * Modifications: Copyright 2025-2026 three.ws contributors, Apache-2.0.
 *
 * What changed vs. the original:
 *   - Stripped React-specific wiring; exports plain data callers feed into
 *     `postprocessing` (or any equivalent) Bloom effect.
 *   - Tuned defaults preserved verbatim from visage so the look is identical.
 */

export const BLOOM_DEFAULTS = Object.freeze({
	luminanceThreshold: 1,
	luminanceSmoothing: 1,
	mipmapBlur: true,
	intensity: 0.1,
	kernelSize: 0,
});

/**
 * Merge caller overrides into the visage-derived bloom defaults.
 *
 * @param {Partial<typeof BLOOM_DEFAULTS>} [overrides]
 */
export function bloomConfig(overrides = {}) {
	return { ...BLOOM_DEFAULTS, ...overrides };
}
