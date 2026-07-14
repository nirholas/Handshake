// Pure helpers for the /bnb hub page (src/bnb.js). Kept dependency-free and
// side-effect-free so they're unit-testable without mocking fetch or the DOM
// — see tests/bnb-hub-helpers.test.js.

/**
 * Format a block-time measurement in milliseconds as a short duration string.
 * Sub-second reads two decimals ("0.45s"), otherwise one ("1.2s"). Returns
 * "—" for missing/invalid input so callers never branch on null before
 * rendering.
 */
export function formatBlockTime(ms) {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
	const seconds = ms / 1000;
	return seconds < 1 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

/**
 * Compact integer formatting for block numbers / counts: locale-grouped
 * ("108,693,266"). Returns "—" for missing/invalid input.
 */
export function formatBlockNumber(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return Math.round(n).toLocaleString('en-US');
}

/**
 * How far off a measured block time is from the marketing target, as a
 * signed percentage ("+2.2%" measured slower, "-4.0%" measured faster).
 * Returns null when either input is missing (no target on testnet).
 */
export function deltaFromTarget(measuredMs, targetMs) {
	if (!Number.isFinite(measuredMs) || !Number.isFinite(targetMs) || targetMs === 0) return null;
	const pct = ((measuredMs - targetMs) / targetMs) * 100;
	return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * Interpret an HTTP probe outcome into a track's liveness state.
 *
 * A track "exists" the moment its route/API resolves — regardless of which
 * status it answers with. A 404 means the file genuinely isn't deployed yet
 * (Vercel/Cloud Run route table has no match). A 405 means the route exists
 * but the probe method isn't what it wants: that still counts as live
 * (defensive only, since the hub probes POST-only APIs with OPTIONS precisely
 * so no 405 ever shows up in the console). Any 2xx/3xx/4xx other
 * than 404 counts as live; a network failure (status === null) or a 5xx
 * fails closed to "coming-soon" — an unreachable/erroring dependency should
 * never read as a shipped feature.
 *
 * @param {number|null} status - HTTP status code, or null on network error.
 * @returns {'live'|'coming-soon'}
 */
export function trackLiveness(status) {
	if (status == null) return 'coming-soon';
	if (status === 404) return 'coming-soon';
	if (status >= 500) return 'coming-soon';
	return 'live';
}

/**
 * Reduce N per-check results (a card can gate on more than one route) to one
 * card state: live only when every check is live.
 * @param {Array<'live'|'coming-soon'>} states
 * @returns {'live'|'coming-soon'}
 */
export function combineTrackStates(states) {
	if (!Array.isArray(states) || states.length === 0) return 'coming-soon';
	return states.every((s) => s === 'live') ? 'live' : 'coming-soon';
}
