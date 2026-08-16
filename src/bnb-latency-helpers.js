// Pure helpers behind the /bnb-latency race page (src/bnb-latency.js): the
// interval-averaging + sparkline math that turns a stream of live probe
// results into "measuring…" / "live" / "reconnecting" lane state and a
// rolling bar chart — plus the honest speedup ratio between two REAL
// measured averages (never a fixed marketing number). Kept dependency-free
// and side-effect-free so it's unit-testable without mocking fetch/DOM —
// see tests/bnb-latency-helpers.test.js.
//
// formatBlockTime/formatBlockNumber/deltaFromTarget already exist for the
// /bnb hub page (src/bnb-hub-helpers.js) and apply unchanged here — reused,
// not reimplemented.

export { formatBlockTime, formatBlockNumber, deltaFromTarget } from './bnb-hub-helpers.js';

/**
 * Consecutive deltas between sorted-ascending timestamps (ms), e.g. the
 * arrival times of successive blocks landing on a lane. Returns `[]` when
 * there are fewer than two timestamps to diff.
 * @param {number[]} timestampsMs
 * @returns {number[]}
 */
export function blockIntervals(timestampsMs) {
	if (!Array.isArray(timestampsMs) || timestampsMs.length < 2) return [];
	const out = [];
	for (let i = 1; i < timestampsMs.length; i++) {
		out.push(timestampsMs[i] - timestampsMs[i - 1]);
	}
	return out;
}

/**
 * Rolling average block interval (ms) over the last `window` timestamps,
 * i.e. the exact "feed block timestamps → correct rolling average" math the
 * live lanes need. `window` defaults to using every interval available.
 * Returns `null` when fewer than two timestamps are given (not enough to
 * measure an interval yet — the page's honest "measuring…" state, never a
 * fabricated 0).
 * @param {number[]} timestampsMs
 * @param {number} [window]
 * @returns {number|null}
 */
export function rollingAverageFromTimestamps(timestampsMs, window = Infinity) {
	const intervals = blockIntervals(timestampsMs);
	if (intervals.length === 0) return null;
	const w = Math.max(1, Math.min(window, intervals.length));
	const slice = intervals.slice(-w);
	const sum = slice.reduce((a, b) => a + b, 0);
	return Math.round((sum / slice.length) * 100) / 100;
}

/**
 * A lane's display state, derived purely from whether a fetch has completed
 * yet and whether the most recent one succeeded — never a timer-driven fake
 * transition. `measuring` covers both "no fetch has resolved yet" and "a
 * fetch resolved but returned no usable sample" (e.g. a chain whose probe
 * came back ok with zero sampled blocks); `reconnecting` is a lane that HAS
 * shown a live number before and just failed a poll; `live` is a fresh good
 * sample.
 * @param {{ hasFetchedOnce: boolean, ok: boolean, hasSample?: boolean }} input
 * @returns {'measuring'|'live'|'reconnecting'}
 */
export function laneState({ hasFetchedOnce, ok, hasSample = true }) {
	if (!hasFetchedOnce) return 'measuring';
	if (ok && hasSample) return 'live';
	return 'reconnecting';
}

/**
 * True when every lane in the race is down — the page-level "all chains
 * unreachable" designed-error trigger (per-lane failures instead render as
 * an individual "reconnecting" badge while the others keep racing).
 * @param {Array<{ ok: boolean }>} lanes
 * @returns {boolean}
 */
export function allLanesDown(lanes) {
	if (!Array.isArray(lanes) || lanes.length === 0) return false;
	return lanes.every((l) => l && l.ok === false);
}

/**
 * Normalize a series of block-time measurements (ms) into 0-100 bar
 * heights for a sparkline, where FASTER (lower ms) reads as a TALLER bar —
 * the intuitive "speed" framing for a chain race, not a raw duration chart.
 * A flat series (all equal, including a single point) renders as even
 * half-height bars rather than dividing by zero. Empty input returns `[]`.
 * @param {number[]} values
 * @param {{ maxBars?: number, floor?: number }} [opts] `floor` keeps every
 *   bar visible even at the slowest measurement (default 8).
 * @returns {number[]}
 */
export function sparklineBars(values, { maxBars = 24, floor = 8 } = {}) {
	if (!Array.isArray(values) || values.length === 0) return [];
	const slice = values.slice(-maxBars).filter((v) => Number.isFinite(v));
	if (slice.length === 0) return [];
	const lo = Math.min(...slice);
	const hi = Math.max(...slice);
	if (hi === lo) return slice.map(() => 50);
	return slice.map((v) => {
		const speedPct = ((hi - v) / (hi - lo)) * 100;
		return Math.round(Math.max(floor, Math.min(100, speedPct)));
	});
}

/**
 * The headline BNB readout's state, which needs one more distinction than a
 * lane does: a headline number that is no longer live must not keep rendering
 * as if it were. `stale` is "the last poll failed but we DID measure this
 * chain earlier" (show the old number, visibly marked old, with its age);
 * `unavailable` is "polls are failing and we never got a reading at all"
 * (show nothing rather than invent one). Both replace the frozen full-opacity
 * number the page used to leave on screen through an outage.
 * @param {{ hasFetchedOnce: boolean, ok: boolean, hasSample?: boolean, hasPrevious?: boolean }} input
 * @returns {'measuring'|'live'|'stale'|'unavailable'}
 */
export function headlineState({ hasFetchedOnce, ok, hasSample = true, hasPrevious = false }) {
	if (!hasFetchedOnce) return 'measuring';
	if (ok && hasSample) return 'live';
	return hasPrevious ? 'stale' : 'unavailable';
}

/**
 * Seconds-resolution age label for a measurement taken `ms` ago ("8s ago").
 * The shared `timeAgo` collapses everything under a minute to "just now",
 * which is useless on a page that re-measures every few seconds: an outage
 * that has run for 45 seconds must not read as fresh. Returns `''` for a
 * missing or invalid age.
 * @param {number} ms
 * @returns {string}
 */
export function ageLabel(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Honest speedup ratio between two REAL measured averages ("BNB confirms
 * N.Nx faster than Base right now") — always computed from live numbers on
 * both sides, never a fixed claim. Returns `null` when either input is
 * missing/non-positive.
 * @param {number} fastMs
 * @param {number} slowMs
 * @returns {string|null}
 */
export function speedupRatio(fastMs, slowMs) {
	if (!Number.isFinite(fastMs) || !Number.isFinite(slowMs) || fastMs <= 0 || slowMs <= 0) return null;
	if (slowMs <= fastMs) return null;
	return `${(slowMs / fastMs).toFixed(1)}×`;
}
