// Shared display formatters for the global coin pages (/coins, /coin/:id).
// Pure functions only — imported by both page bundles and unit-tested in
// tests/coin-format.test.js. Every formatter returns an em dash for missing
// input so callers never branch on null before rendering.

/** Compact USD amount: $1.23T / $4.56B / $7.89M / $1.20K / $42.10. */
export function formatUsd(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
	if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
	return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Exact price: locale-grouped with 2 decimals at $1+, 4 significant figures
 * below (micro-cap coins live many zeros deep — toPrecision keeps them legible
 * without printing 12 fixed decimals).
 */
export function formatPrice(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n === 0) return '$0.00';
	if (Math.abs(n) >= 1)
		return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	// toPrecision can emit exponent notation for very small values; expand it.
	const s = n.toPrecision(4);
	return `$${s.includes('e') ? Number(s).toFixed(12).replace(/0+$/, '') : s}`;
}

/** Signed percentage with 2 decimals: +4.20% / -1.30%. */
export function formatPercent(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** Compact unitless supply: 19.71M, 120.45B, 999.00K, 42. */
export function formatSupply(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
	return n.toLocaleString('en-US');
}

/** Short date: "Mar 14, 2024". Returns — for unparseable input. */
export function formatDateShort(iso) {
	if (!iso) return '—';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '—';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Chart axis timestamp: hh:mm inside a day, "Mar 14" inside a month, "Mar '24" beyond. */
export function formatChartTick(ts, days) {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '';
	if (days <= 1) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	if (days <= 90) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	// "Mar '26", not "Mar 26" — a bare 2-digit year reads as a day of month.
	return `${d.toLocaleDateString('en-US', { month: 'short' })} '${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

/**
 * Normalize a timestamp to epoch ms. Accepts ISO strings, Date objects,
 * epoch milliseconds, and epoch seconds (values below 1e12 are treated as
 * seconds — that boundary is Sep 2001 in ms and year 33658 in seconds, so
 * real timestamps are unambiguous). Returns NaN for unparseable input.
 */
export function toEpochMs(input) {
	if (input == null || input === '') return NaN;
	if (input instanceof Date) return input.getTime();
	if (typeof input === 'number' && Number.isFinite(input)) {
		return input < 1e12 ? input * 1000 : input;
	}
	if (typeof input === 'string' && /^\d+$/.test(input)) return toEpochMs(Number(input));
	return new Date(input).getTime();
}

/**
 * Relative age: "3m ago", "2h ago", "5d ago". Falls back to a short date past
 * 14 days. Accepts any timestamp shape `toEpochMs` understands, so callers
 * with unix-seconds or ms inputs share one contract.
 */
export function timeAgo(iso, now = Date.now()) {
	const t = toEpochMs(iso);
	if (Number.isNaN(t)) return '';
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 14 * 86400) return `${Math.floor(s / 86400)}d ago`;
	return formatDateShort(iso);
}

/** HTML-escape for interpolating remote strings into innerHTML templates. */
export function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Downsample a numeric series to at most `max` points, always keeping the
 * final point (sparklines care most about where the line ends).
 */
export function downsample(series, max) {
	if (!Array.isArray(series) || series.length <= max) return series || [];
	const step = (series.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(series[Math.round(i * step)]);
	return out;
}
