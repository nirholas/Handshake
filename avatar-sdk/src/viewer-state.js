// Pure helpers for <three-ws-viewer>'s load lifecycle, split out so the state
// math is unit-testable without a DOM or a WebGL context. The component owns the
// shadow-DOM overlays; this owns the decisions that drive them.

/**
 * Download progress as a whole-number percent, or null when the server didn't
 * send a Content-Length (progress isn't computable, so show an indeterminate
 * spinner instead of a lying bar).
 *
 * @param {number} loaded bytes received
 * @param {number} total  bytes expected (0/undefined when unknown)
 * @returns {number|null} 0..100, or null when not computable
 */
export function loadPercent(loaded, total) {
	if (!Number.isFinite(total) || total <= 0) return null;
	if (!Number.isFinite(loaded) || loaded < 0) return 0;
	const pct = Math.round((loaded / total) * 100);
	return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

/**
 * The label shown while loading: a percent when known, else a plain "Loading".
 * @param {number|null} pct output of loadPercent
 * @returns {string}
 */
export function progressLabel(pct) {
	return pct == null ? 'Loading' : `${pct}%`;
}

/**
 * The lifecycle state the viewer should be in given its src and load outcome.
 * Keeps the transition rules in one testable place.
 *
 * @param {{ hasSrc: boolean, loading?: boolean, error?: boolean }} ctx
 * @returns {'empty'|'loading'|'error'|'ready'}
 */
export function nextViewerState({ hasSrc, loading = false, error = false }) {
	if (!hasSrc) return 'empty';
	if (error) return 'error';
	if (loading) return 'loading';
	return 'ready';
}
