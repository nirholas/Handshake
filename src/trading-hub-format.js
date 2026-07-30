// Pure formatting and interpretation helpers for /trading.
//
// Kept out of trading-hub.js so the interesting logic (what counts as a healthy
// fleet, how a sparkline is drawn, how a null renders) is unit-testable without
// a DOM or a network. No imports, no side effects.

/** A dot that is not a number renders as a neutral placeholder, never as 0. */
const PLACEHOLDER = '·';

/**
 * Format lamport-derived SOL for display.
 * @param {number|string|null|undefined} n
 * @param {{signed?: boolean}} [opts] signed prefixes a positive value with "+"
 * @returns {string}
 */
export function formatSol(n, { signed = true } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return PLACEHOLDER;
	const v = Number(n);
	// Small balances need more places or every row reads "0.000 SOL".
	const places = Math.abs(v) < 0.01 && v !== 0 ? 4 : 3;
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(places)} SOL`;
}

/**
 * Format a percentage for display.
 * @param {number|string|null|undefined} n
 * @param {{signed?: boolean}} [opts]
 * @returns {string}
 */
export function formatPct(n, { signed = true } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return PLACEHOLDER;
	const v = Number(n);
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/**
 * Human "time since" for an ISO timestamp.
 * @param {string|null|undefined} iso
 * @param {number} [now] epoch ms, injectable so tests do not depend on the clock
 * @returns {string}
 */
export function formatAgo(iso, now = Date.now()) {
	if (!iso) return 'never';
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return 'never';
	const ms = now - t;
	if (ms < 0) return 'just now';
	if (ms < 60_000) return 'just now';
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
	return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Duration since boot, in the coarsest unit that still reads honestly.
 * @param {string|null|undefined} iso
 * @param {number} [now]
 * @returns {string}
 */
export function formatUptime(iso, now = Date.now()) {
	if (!iso) return PLACEHOLDER;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return PLACEHOLDER;
	const ms = now - t;
	if (ms < 0) return PLACEHOLDER;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Interpret a /api/sniper/status payload into display state.
 *
 * The distinction that matters: a worker can be beating steadily while its
 * launch feed has gone quiet, which looks identical to "healthy" on a naive
 * check and means the fleet is seeing nothing. Feed health is therefore
 * reported separately from process health, and a silent feed is called out
 * rather than folded into a single green light.
 *
 * @param {object|null|undefined} status
 * @returns {{tone: string, label: string, detail: string, feedTone: string,
 *            feedLabel: string, feedDetail: string, uptimeLabel: string}}
 */
export function describeFleet(status, now = Date.now()) {
	const s = status || {};
	const mode = s.mode === 'live' ? 'live' : s.mode === 'simulate' ? 'simulate' : null;
	const killed = s.globalKill === true;
	const feedLive = s.feedLive === true;
	const feedSilent = s.feedSilent === true;

	let feedTone = 'muted';
	let feedLabel = 'Unknown';
	let feedDetail = 'The worker did not report feed state.';
	if (feedLive && !feedSilent) {
		feedTone = 'live';
		feedLabel = 'Connected';
		const age = Number(s.lastEventAgeMs);
		feedDetail = Number.isFinite(age)
			? `Last launch seen ${Math.max(0, Math.round(age / 1000))}s ago`
			: 'Receiving launches';
	} else if (feedSilent) {
		feedTone = 'warn';
		feedLabel = 'Silent';
		feedDetail = 'Connected but no launches are arriving.';
	} else if (s.feedLive === false) {
		feedTone = 'down';
		feedLabel = 'Disconnected';
		feedDetail = 'The worker is not receiving launches.';
	}

	let tone = 'unknown';
	let label = 'Fleet status unknown';
	let detail = 'The status endpoint returned no recognizable state.';
	if (killed) {
		tone = 'down';
		label = 'Fleet halted';
		detail = 'The global kill switch is on. No new entries will be taken.';
	} else if (mode === 'live') {
		tone = feedTone === 'live' ? 'live' : 'warn';
		label = feedTone === 'live' ? 'Trading live' : 'Live, feed degraded';
		detail = `${s.strategies ?? 0} strategies armed, ${s.openPositions ?? 0} open. ${feedDetail}`;
	} else if (mode === 'simulate') {
		tone = 'muted';
		label = 'Simulating';
		detail = `Real quotes, no broadcast. ${s.strategies ?? 0} strategies armed.`;
	}

	return {
		tone,
		label,
		detail,
		feedTone,
		feedLabel,
		feedDetail,
		uptimeLabel: formatUptime(s.bootAt, now),
	};
}

/**
 * Build an SVG path for a cumulative profit-and-loss sparkline.
 *
 * Returns an empty string when there is nothing honest to draw (fewer than two
 * points), so the caller can omit the element entirely rather than render a
 * flat line that implies a result the data does not contain.
 *
 * @param {Array<number>} series
 * @param {number} w
 * @param {number} h
 * @returns {string} an SVG path "d" attribute, or "" when undrawable
 */
export function sparkPath(series, w = 120, h = 32) {
	if (!Array.isArray(series)) return '';
	const pts = series.map(Number).filter((n) => Number.isFinite(n));
	if (pts.length < 2) return '';
	const min = Math.min(...pts);
	const max = Math.max(...pts);
	const pad = 2;
	const usableH = Math.max(1, h - pad * 2);
	// A flat series has no range to normalize against; draw it down the middle
	// instead of dividing by zero.
	const range = max - min;
	const x = (i) => (i / (pts.length - 1)) * w;
	const y = (v) => (range === 0 ? h / 2 : pad + usableH - ((v - min) / range) * usableH);
	return pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
}
