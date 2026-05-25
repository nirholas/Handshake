// Pure helpers used by widgets.js. Kept in their own module so they're
// testable without booting the page IIFE that mounts the dashboard shell.

/** Sum the `count` field across an /api/widgets/:id/stats `recent_*_7d` array. */
export function sumDaily(arr) {
	if (!Array.isArray(arr)) return 0;
	let total = 0;
	for (const r of arr) total += Number(r?.count || 0);
	return total;
}

/** Compact integer formatter for KPI strips: "12", "1,200", "12.3k". */
export function formatCount(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
	if (v >= 1000) return v.toLocaleString('en-US');
	return String(Math.round(v));
}

/**
 * Render an integer number of seconds as a compact duration string.
 *   42  → "42s"
 *   95  → "1m 35s"
 *   3700 → "1h 2m"
 * Negative values are clamped at zero (single-message sessions land here).
 */
export function formatDuration(sec) {
	const s = Math.max(0, Math.round(Number(sec) || 0));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Roll up `sessions_7d` blobs from per-widget /stats responses into the
 * thread-weighted average session duration shown in the aggregate strip.
 * Returns null when no widget has any threads in the window.
 */
export function weightedAvgSessionSeconds(statsArray) {
	let weighted = 0;
	let totalThreads = 0;
	for (const s of statsArray) {
		const ss = s?.sessions_7d;
		const threads = Number(ss?.thread_count || 0);
		if (threads > 0) {
			weighted += Number(ss.avg_seconds || 0) * threads;
			totalThreads += threads;
		}
	}
	if (totalThreads === 0) return null;
	return weighted / totalThreads;
}
