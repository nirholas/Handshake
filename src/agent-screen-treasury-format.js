// Treasury cockpit — pure presentation helpers.
//
// No DOM, no Three.js, no network. Every function here is total and
// side-effect-free so the cockpit's number formatting, runway-gauge math, and
// policy-line wording can be unit-tested in Node (tests/agent-screen-treasury.test.js)
// and reused identically by the live renderer and the offscreen wall-frame draw.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** USD with adaptive precision: cents under $1k, whole dollars above, compact in the millions. */
export function fmtUsd(n, { compact = false } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	const sign = v < 0 ? '-' : '';
	if (compact && abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
	if (compact && abs >= 10_000) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
	if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
	if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
	if (abs === 0) return '$0.00';
	return `${sign}$${abs.toFixed(abs < 0.01 ? 4 : 3)}`;
}

/** SOL with trailing-zero trim and a sane cap on precision. */
export function fmtSol(n, dp = 4) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const s = v.toFixed(dp).replace(/\.?0+$/, '');
	return `${s || '0'} SOL`;
}

/** Compact integer-ish token count: 412,000 → "412K", 1_240_000 → "1.24M". */
export function fmtCompact(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	const v = Number(n);
	const abs = Math.abs(v);
	const sign = v < 0 ? '-' : '';
	if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
	if (abs >= 1) return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
	return `${sign}${abs.toFixed(2)}`;
}

/**
 * Resolve the runway gauge state from a real `computeRunway` payload.
 *
 * `runway_days` is null in two distinct cases the gauge must NOT conflate:
 *   - the agent is self-sustaining (income ≥ burn) → a full, healthy arc (∞)
 *   - the price feed / balance read was unavailable → an honest "unknown" arc
 *
 * @param {object} runway  computeRunway() result
 * @param {{ maxDays?: number }} [opts]  full-arc horizon (default 90 days)
 * @returns {{ fraction:number, days:number|null, infinite:boolean, unknown:boolean,
 *             tone:'sustain'|'healthy'|'warn'|'critical'|'unknown', label:string, sublabel:string }}
 */
export function runwayGauge(runway = {}, { maxDays = 90 } = {}) {
	const r = runway || {};
	const days = r.runway_days;
	const selfSustaining = r.self_sustaining === true;
	const priceKnown = r.price_usd != null && r.balance_usd != null;

	if (selfSustaining) {
		return { fraction: 1, days: null, infinite: true, unknown: false, tone: 'sustain', label: '∞', sublabel: 'Self-sustaining' };
	}
	if (days == null || !priceKnown) {
		return { fraction: 0, days: null, infinite: false, unknown: true, tone: 'unknown', label: '—', sublabel: 'Runway unknown' };
	}
	const d = Number(days);
	const fraction = clamp(d / Math.max(1, maxDays), 0, 1);
	let tone = 'healthy';
	if (d < 7) tone = 'critical';
	else if (d < 30) tone = 'warn';
	const label = d >= 1 ? `${Math.round(d)}d` : '<1d';
	return { fraction, days: d, infinite: false, unknown: false, tone, label, sublabel: 'Runway left' };
}

/** Stroke-dasharray pair for an SVG arc of `circumference`, filled to `fraction`. */
export function arcDash(fraction, circumference) {
	const f = clamp(Number(fraction) || 0, 0, 1);
	const filled = f * circumference;
	return { dash: `${filled} ${circumference}`, filled };
}

const RULE_GLYPH = Object.freeze({
	self_fund: '🧠',
	buffer: '🛟',
	dca: '📈',
	buyback: '🔥',
	sweep: '↗',
});

/**
 * One display row for a compiled or live autopilot rule. Works for both the
 * compile preview (no run history) and the saved policy (with last_status).
 */
export function policyLine(rule = {}) {
	const kind = rule.kind || 'rule';
	const paused = rule.paused === true;
	const off = rule.enabled === false;
	const state = paused ? 'paused' : off ? 'off' : 'armed';
	const last = typeof rule.last_status === 'string' ? rule.last_status : null;
	return {
		kind,
		glyph: RULE_GLYPH[kind] || '•',
		text: rule.label || kind,
		state,
		stateLabel: paused ? 'Paused' : off ? 'Off' : 'Armed',
		lastStatus: last,
		note: typeof rule.last_note === 'string' ? rule.last_note : null,
	};
}

// Activity wording that means a real treasury movement just happened — used to
// decide when to fire a toast and re-read the live balance. Matches the memos and
// narration the autopilot executor + per-coin crons emit.
const TREASURY_ACTIVITY_RE =
	/\b(bought ?back|buy ?back|buyback|distribut(?:e|ed|ion)|swept|sweep|dca|dollar[- ]cost|self[- ]?fund|treasury|buffer breached|compounded)\b/i;

/** True when a pushed activity line describes an autopilot money movement. */
export function isTreasuryActivity(text) {
	return TREASURY_ACTIVITY_RE.test(String(text || ''));
}

/** Short, holder-readable toast line for a settled autopilot result row. */
export function actionToast(result = {}) {
	const usd = result.usd != null ? fmtUsd(result.usd) : null;
	const kind = result.kind;
	const verb = {
		buyback: 'Bought back $THREE',
		dca: 'Bought $THREE',
		sweep: 'Swept profit to owner',
		self_fund: 'Paid compute costs',
		buffer: 'Buffer check',
	}[kind] || 'Treasury action';
	if (result.last_status && result.last_status !== 'ok' && result.last_status !== 'confirmed') {
		return result.last_note ? `${verb}: ${result.last_note}` : `${verb}: ${result.last_status}`;
	}
	return usd ? `${verb} — ${usd}` : verb;
}

/**
 * Line for one row of a SIMULATED cycle (`last_status: 'would_run'`).
 *
 * Kept separate from actionToast on purpose: a preview must never be phrased in
 * the past tense. "Bought back $THREE" and "Would buy back $THREE" describe very
 * different states of the wallet, and reusing the settled formatter here would
 * render an untouched balance as a completed spend.
 */
export function previewLine(result = {}) {
	const usd = result.usd != null ? fmtUsd(result.usd) : null;
	const verb = {
		buyback: 'Would buy back $THREE',
		dca: 'Would buy $THREE',
		sweep: 'Would sweep profit to owner',
		self_fund: 'Would pay compute costs',
		buffer: 'Would top up the buffer',
	}[result.kind] || 'Would run a treasury action';
	return usd ? `${verb} — ${usd}` : verb;
}
