// Pin-success "lock-in" celebration: the ripple timing.
//
// Anchoring your agent into the real world is the emotional payoff of IRL, and it
// used to land as nothing but a line of status text. Now a green ring pulses out
// from the avatar's feet (plus a short haptic) so pinning feels earned and worth
// doing again. This module owns the pure timing math, so it is unit-testable; the
// scene meshes live in irl.js next to the existing confidence-ring code.

// Total ripple lifetime, in seconds.
export const CELEBRATION_DURATION = 0.8;

// How far (world-radius multiplier) a ring expands over its life.
const MAX_SCALE = 2.1;
const START_SCALE = 0.15;
const PEAK_OPACITY = 0.85;

/**
 * Frame of one expanding ring at normalized celebration time `t` (0..1 across the
 * whole ripple), started after `delay` (also normalized, so a second ring can trail
 * the first). Returns the ring's scale (world-radius multiplier) and opacity;
 * `visible` is false before the ring's delay has elapsed.
 *
 * @param {number} t normalized elapsed time, 0..1
 * @param {number} [delay] normalized start offset, 0..1
 * @returns {{ visible: boolean, scale: number, opacity: number }}
 */
export function celebrationRingFrame(t, delay = 0) {
	const span = 1 - delay;
	const local = span > 1e-6 ? (t - delay) / span : 0;
	if (local <= 0) return { visible: false, scale: START_SCALE, opacity: 0 };
	const clamped = local < 1 ? local : 1;
	const ease = 1 - Math.pow(1 - clamped, 3); // cubic ease-out
	return {
		visible: true,
		scale: START_SCALE + ease * MAX_SCALE,
		opacity: (1 - clamped) * PEAK_OPACITY,
	};
}
