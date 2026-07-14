// Pure pinch-to-resize math for WebXR AR placement (no DOM, no THREE).
//
// A two-finger pinch during an immersive-ar session resizes the placed agent,
// matching the native Scene Viewer / Quick Look gesture users already know.
// The state machine is deliberately tiny and allocation-free so the session
// controller (src/ar/webxr.js) can drive it from raw touch points every frame:
//
//   const p = createPinchState();
//   pinchStart(p, dist, currentScale)   // two fingers down
//   pinchMove(p, dist)  → new scale     // fingers move (null = not pinching)
//   pinchEnd(p)         → final scale   // a finger lifts (null = wasn't pinching)
//
// Scale is the ratio of the current finger distance to the distance at pinch
// start, applied to the scale the content already had — so consecutive pinches
// compose naturally instead of snapping back to 1. Clamped to sane bounds: a
// life-size avatar squeezed to a desk figurine (MIN) or grown to a statue (MAX).

export const PINCH_SCALE_MIN = 0.25;
export const PINCH_SCALE_MAX = 4;

/** Minimum finger distance (px) considered a real pinch — rejects palm noise. */
export const PINCH_DEADZONE_PX = 24;

export function createPinchState() {
	return { active: false, startDist: 0, baseScale: 1, scale: 1 };
}

/**
 * Begin a pinch. Ignored (returns false) when the finger spread is inside the
 * dead zone or inputs are not finite — the caller keeps treating input as taps.
 *
 * @param {ReturnType<createPinchState>} p
 * @param {number} dist       Distance between the two touch points, px.
 * @param {number} baseScale  The content's current uniform scale.
 * @returns {boolean} true when the pinch is engaged.
 */
export function pinchStart(p, dist, baseScale) {
	if (!Number.isFinite(dist) || dist < PINCH_DEADZONE_PX) return false;
	const base = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
	p.active = true;
	p.startDist = dist;
	p.baseScale = base;
	p.scale = base;
	return true;
}

/**
 * Advance an engaged pinch. Returns the new clamped scale, or null when no
 * pinch is engaged or the distance is degenerate (caller applies nothing).
 *
 * @param {ReturnType<createPinchState>} p
 * @param {number} dist  Current distance between the two touch points, px.
 * @returns {number|null}
 */
export function pinchMove(p, dist) {
	if (!p.active || !Number.isFinite(dist) || dist <= 0 || p.startDist <= 0) return null;
	const next = p.baseScale * (dist / p.startDist);
	p.scale = Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, next));
	return p.scale;
}

/**
 * End the pinch (a finger lifted). Returns the final scale to persist, or
 * null when no pinch was engaged (a plain tap — nothing to save).
 *
 * @param {ReturnType<createPinchState>} p
 * @returns {number|null}
 */
export function pinchEnd(p) {
	if (!p.active) return null;
	p.active = false;
	return p.scale;
}

/**
 * Clamp a persisted pin scale for rendering. Anything non-finite or
 * non-positive (legacy pins, absent column) renders at natural size.
 *
 * @param {unknown} v  Raw anchor_scale from the API (may be null/undefined).
 * @returns {number}
 */
export function clampPinScale(v) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return 1;
	return Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, n));
}
