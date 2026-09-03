/**
 * Bonding Curve widget — a live, animated view of a pump.fun token's climb
 * toward graduation.
 *
 * Distinct from the trade-feed widgets (kol-trades / live-trades-canvas /
 * pumpfun-feed): those show *flow* (individual trades). This shows *state* —
 * how far a single token has progressed along its bonding curve and how close
 * it is to graduating to an AMM pool.
 *
 * Data source: GET /api/pump/curve?mint=…&network=… (real on-chain reads via
 * the pump SDK, edge-cached ~10s). USD figures are enriched client-side from
 * Jupiter's public price API; if that fails we degrade gracefully to SOL.
 *
 * Exported functions:
 *   lamportsToSol / fmtSol / fmtUsd / fmtPrice  — pure formatters (tested)
 *   curveValue / curvePoints / areaPathFor       — pure curve geometry (tested)
 *   computeView(data, solUsd)                     — pure view-model (tested)
 *   getSolUsd(): shared, cached SOL/USD read
 *   renderCardShell(view, cfg)                    — pure HTML string (tested)
 *   mountBondingCurve(rootEl, opts)               — full mount + polling + anim
 *
 * The generic <three-ws-widget type="bonding-curve" mint="…"> element is
 * handled by the dispatcher in kol-trades.js.
 */

import { hasThreeWsMark } from '../solana/vanity/brand.js';
import { solToUsd } from '../shared/usd-price.js';

const UNKNOWN_VALUE = '\u2014'; // the card's placeholder for a value it cannot read
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// pump.fun mints a fixed 1B total supply, all of which is sold through the curve
// and seeded into the AMM on graduation — so fully-diluted value equals market
// cap. Used to derive a graduated coin's market cap from its DEX price when the
// endpoint didn't already enrich one.
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

// Settlement / native tokens that can never carry a pump.fun bonding curve.
// Listed only to *exclude* them from curve lookups — never to promote them.
const NON_CURVE_MINTS = new Set([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (mainnet)
	'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC (devnet)
	SOL_MINT, // wrapped SOL
	'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Address-only pre-filter, mirroring the server's gate in
// api/_lib/pump-curve-view.js. A pump.fun-ground mint ends in the literal
// suffix "pump"; a three.ws custodial launch carries the "3ws" mark as a prefix
// instead (src/solana/vanity/brand.js) and is just as curve-bearing; and on
// devnet nothing grinds a mark at all, so the shape says nothing and every
// plausible address is worth asking about. A settlement token is excluded
// everywhere. Anything else on mainnet is skipped here rather than contributing
// to a /api/pump/curve 404 storm from a misconfigured (e.g. USDC) mount: the
// server still recognizes an unmarked coin of ours from its own launch
// registry, so a real agent token is never left unrendered by this shortcut.
export function isPumpMint(mint, network = 'mainnet') {
	if (typeof mint !== 'string' || NON_CURVE_MINTS.has(mint)) return false;
	if (network === 'devnet') return isPlausibleMint(mint);
	return mint.endsWith('pump') || hasThreeWsMark(mint);
}

/** A base58 string of Solana address length: the shape, not the existence. */
export function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
}

// SVG geometry. viewBox is fixed; the element scales to its container.
const VB = Object.freeze({ w: 320, h: 150, pl: 14, pr: 14, pt: 18, pb: 18 });
const CURVE_EXP = 1.85; // convex/accelerating — mirrors the pump.fun price curve
const CURVE_SAMPLES = 48;

// ---------------------------------------------------------------------------
// Pure helpers — no DOM, exported for unit testing.
// ---------------------------------------------------------------------------

export function lamportsToSol(lamports) {
	const n = Number(lamports);
	if (!Number.isFinite(n)) return 0;
	return n / LAMPORTS_PER_SOL;
}

/**
 * Whole tokens behind a curve. `tokenTotalSupply` is atomic and pump.fun mints
 * with 6 decimals; a payload without it falls back to the fixed 1B supply every
 * pump.fun coin is created with.
 */
export function totalSupplyTokens(curve) {
	const atomic = Number(curve?.tokenTotalSupply);
	if (!Number.isFinite(atomic) || atomic <= 0) return PUMP_TOTAL_SUPPLY;
	return atomic / 1e6;
}

export function clamp01(n) {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/** Compact SOL amount, e.g. "◎ 18.4" / "◎ 1.2K". */
export function fmtSol(sol) {
	const v = Number(sol);
	if (!Number.isFinite(v)) return '◎ —';
	if (v >= 1_000_000) return `◎ ${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1_000) return `◎ ${(v / 1_000).toFixed(2)}K`;
	if (v >= 1) return `◎ ${v.toFixed(2)}`;
	if (v > 0) return `◎ ${v.toFixed(3)}`;
	return '◎ 0';
}

/** Compact USD, e.g. "$12.3K". */
export function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$—';
	if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
	if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
	if (v >= 1) return `$${v.toFixed(2)}`;
	if (v > 0) return `$${v.toPrecision(2)}`;
	return '$0';
}

/** Per-token price — tiny numbers, shown with significant digits. */
export function fmtPrice(value, { usd = false } = {}) {
	const v = Number(value);
	if (!Number.isFinite(v) || v <= 0) return usd ? '$—' : '◎ —';
	const sym = usd ? '$' : '◎ ';
	if (v >= 0.01) return `${sym}${v.toFixed(usd ? 4 : 5)}`;
	// Sub-cent: trim a fixed-notation value so we never render "1e-7".
	const fixed = v.toFixed(12).replace(/0+$/, '');
	return `${sym}${fixed}`;
}

export function shortMint(mint, n = 4) {
	const s = String(mint || '');
	if (s.length <= n * 2 + 1) return s;
	return `${s.slice(0, n)}…${s.slice(-n)}`;
}

/** Curve height fraction in [0,1] for a horizontal fraction t in [0,1]. */
export function curveValue(t) {
	return Math.pow(clamp01(t), CURVE_EXP);
}

/** Screen point for a fraction t along the curve. */
export function curvePointAt(t, vb = VB) {
	const innerW = vb.w - vb.pl - vb.pr;
	const innerH = vb.h - vb.pt - vb.pb;
	const baseY = vb.h - vb.pb;
	const x = vb.pl + clamp01(t) * innerW;
	const y = baseY - curveValue(t) * innerH;
	return { x, y };
}

/** Sample the full curve as an SVG polyline `d` string. */
export function curvePoints(samples = CURVE_SAMPLES, vb = VB) {
	let d = '';
	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const { x, y } = curvePointAt(t, vb);
		d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
		if (i < samples) d += ' ';
	}
	return d;
}

/** Filled-area path under the curve from the origin up to `progress`. */
export function areaPathFor(progress, samples = CURVE_SAMPLES, vb = VB) {
	const p = clamp01(progress);
	const baseY = vb.h - vb.pb;
	const start = curvePointAt(0, vb);
	let d = `M${start.x.toFixed(2)} ${baseY.toFixed(2)} L${start.x.toFixed(2)} ${start.y.toFixed(2)} `;
	const steps = Math.max(1, Math.round(samples * p));
	for (let i = 1; i <= steps; i++) {
		const t = (p * i) / steps;
		const { x, y } = curvePointAt(t, vb);
		d += `L${x.toFixed(2)} ${y.toFixed(2)} `;
	}
	const end = curvePointAt(p, vb);
	d += `L${end.x.toFixed(2)} ${baseY.toFixed(2)} Z`;
	return d;
}

/**
 * Build a render-ready view model from a /api/pump/curve response.
 * @param {object|null} data  Raw API payload, or null on error/empty.
 * @param {number|null} solUsd  SOL price in USD, or null when unavailable.
 */
export function computeView(data, solUsd = null) {
	if (!data || (!data.curve && !data.graduated)) {
		return { status: 'empty', progress: 0, hasUsd: false };
	}

	const grad = data.graduation || {};
	const price = data.price || {};
	// A coin is graduated when it has migrated to its AMM. The endpoint signals
	// this in several shapes depending on whether the on-chain curve account is
	// still readable: a top-level `graduated` flag (account closed), the nested
	// `graduation.isGraduated`, or a `curve.complete` flag (account lingers with
	// zeroed reserves — exactly the case for our own $THREE post-migration).
	const isGraduated = Boolean(
		data.graduated || grad.isGraduated || price.isGraduated || data.curve?.complete,
	);

	// Graduated coin: there's no curve raise left to chart, but the token trades
	// live on a DEX. The endpoint enriches that price as `graduatedPrice`; render a
	// 100% "Graduated" state with the real price + fixed-supply market cap rather
	// than the $0 the closed curve's zeroed reserves would otherwise produce. This
	// fires whether or not the curve account still exists, so it covers both the
	// `curve: null` and the lingering-`curve.complete` payloads.
	const gp = data.graduatedPrice || {};
	const gpPrice = Number(gp.priceUsd);
	if (isGraduated && Number.isFinite(gpPrice) && gpPrice > 0) {
		const gpMc = Number(gp.marketCapUsd);
		return {
			status: 'graduated',
			progress: 1,
			progressPct: 100,
			marketCapSol: 0,
			marketCapUsd: Number.isFinite(gpMc) && gpMc > 0 ? gpMc : gpPrice * PUMP_TOTAL_SUPPLY,
			raisedSol: null, // the raise completed and the curve closed — N/A now
			raisedUsd: null,
			priceSol: 0,
			priceUsd: gpPrice,
			isMayhem: Boolean(data.curve?.isMayhemMode),
			network: data.network === 'devnet' ? 'devnet' : 'mainnet',
			mint: data.mint || '',
			hasUsd: true,
		};
	}

	// Graduated but with no usable DEX price (Jupiter blip), or a live bonding
	// curve — fall through to the on-chain curve math. Without a curve account and
	// no graduated price there's nothing to show.
	if (!data.curve) {
		return { status: 'empty', progress: 0, hasUsd: false };
	}
	const progress = isGraduated ? 1 : clamp01(Number(grad.progressBps) / 10_000);

	const raisedSol = Math.max(0, lamportsToSol(grad.solAccumulated ?? data.curve.realSolReserves));
	const priceSol = Math.max(0, lamportsToSol(price.buyPricePerToken));
	const hasUsd = Number.isFinite(Number(solUsd)) && Number(solUsd) > 0;

	// Market cap is derived here rather than taken from the SDK's `price.marketCap`,
	// which is not one: on a live devnet curve 95% of the way to graduation it
	// reports -1.75 SOL while the curve holds 30.3 SOL of virtual reserves. Every
	// consumer clamped that negative to zero and rendered "◎0" for a coin with a
	// real price. The curve carries the two honest numbers instead: the current
	// per-token price and the token's total supply: and pump.fun sells the entire
	// fixed supply through the curve, so price × supply IS the market cap.
	const marketCapSol = priceSol * totalSupplyTokens(data.curve);

	return {
		status: isGraduated ? 'graduated' : 'bonding',
		progress,
		progressPct: progress * 100,
		marketCapSol,
		marketCapUsd: hasUsd ? marketCapSol * solUsd : null,
		raisedSol,
		raisedUsd: hasUsd ? raisedSol * solUsd : null,
		priceSol,
		priceUsd: hasUsd ? priceSol * solUsd : null,
		isMayhem: Boolean(data.curve.isMayhemMode),
		network: data.network === 'devnet' ? 'devnet' : 'mainnet',
		mint: data.mint || '',
		hasUsd,
	};
}

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Render the static card shell (everything except the values that animate).
 * Returns an HTML string. The mount step queries the marked nodes and updates
 * them live, so this stays a pure, testable function.
 */
export function renderCardShell(view, cfg = {}) {
	const mint = view.mint || cfg.mint || '';
	const net = view.network || cfg.network || 'mainnet';
	const pumpUrl = `https://pump.fun/${esc(mint)}`;
	const netBadge = net === 'devnet' ? '<span class="bcw-net bcw-net--dev">devnet</span>' : '';
	const mayhem = view.isMayhem
		? '<span class="bcw-mayhem" title="Mayhem mode">⚡ mayhem</span>'
		: '';

	const statusClass =
		view.status === 'graduated'
			? 'is-grad'
			: view.status === 'bonding'
				? 'is-bonding'
				: 'is-empty';
	const statusLabel =
		view.status === 'graduated'
			? 'Graduated'
			: view.status === 'bonding'
				? 'Bonding'
				: view.status === 'loading'
					? 'Loading'
					: 'No curve';

	return `<div class="bcw-card ${statusClass}">
		<header class="bcw-head">
			<span class="bcw-status"><i class="bcw-led"></i>${esc(statusLabel)}</span>
			<a class="bcw-mint" href="${pumpUrl}" target="_blank" rel="noopener noreferrer" title="${esc(mint)}">${esc(shortMint(mint))}</a>
			${netBadge}${mayhem}
		</header>

		<div class="bcw-meter">
			<div class="bcw-pct" data-pct><span class="bcw-pct-num">0</span><span class="bcw-pct-sym">%</span></div>
			<div class="bcw-pct-label">to graduation</div>
		</div>

		<svg class="bcw-curve" viewBox="0 0 ${VB.w} ${VB.h}" preserveAspectRatio="none" aria-hidden="true">
			<defs>
				<linearGradient id="bcw-fill" x1="0" y1="1" x2="1" y2="0">
					<stop offset="0%" stop-color="var(--bcw-accent)" stop-opacity="0.04"/>
					<stop offset="100%" stop-color="var(--bcw-accent)" stop-opacity="0.42"/>
				</linearGradient>
				<filter id="bcw-glow" x="-60%" y="-60%" width="220%" height="220%">
					<feGaussianBlur stdDeviation="3.2" result="b"/>
					<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
				</filter>
			</defs>
			<line class="bcw-grad-line" x1="${VB.pl}" y1="${VB.pt}" x2="${VB.w - VB.pr}" y2="${VB.pt}"/>
			<path class="bcw-area" data-area fill="url(#bcw-fill)" d=""/>
			<path class="bcw-line" data-line fill="none" d="${curvePoints()}"/>
			<g data-marker class="bcw-marker" filter="url(#bcw-glow)">
				<circle class="bcw-marker-halo" r="6.5"/>
				<circle class="bcw-marker-dot" r="3.2"/>
			</g>
		</svg>

		<dl class="bcw-stats">
			<div><dt>Market cap</dt><dd data-mc>—</dd></div>
			<div><dt>Raised</dt><dd data-raised>—</dd></div>
			<div><dt>Price</dt><dd data-price>—</dd></div>
		</dl>

		<a class="bcw-cta" href="${pumpUrl}" target="_blank" rel="noopener noreferrer" data-cta>Trade on pump.fun →</a>
		${cfg.showPoweredBy === false ? '' : '<a class="bcw-by" href="https://three.ws" target="_blank" rel="noopener noreferrer">three.ws</a>'}
	</div>`;
}

// ---------------------------------------------------------------------------
// Styles — injected once per document.
// ---------------------------------------------------------------------------

const STYLES = `
.bcw {
	font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
	color: #f2f3f7; pointer-events: none;
}
.bcw-card {
	pointer-events: auto;
	/* 92vw keeps the floating/overlay mount off the viewport edges; max-width
	   keeps an embedded mount inside its container, which at 320px is far
	   narrower than 92vw once page and card padding are taken out. */
	width: min(420px, 92vw);
	max-width: 100%;
	box-sizing: border-box;
	padding: 18px 18px 16px;
	border-radius: 18px;
	background: rgba(12, 14, 22, 0.82);
	border: 1px solid rgba(255, 255, 255, 0.08);
	box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05);
	backdrop-filter: blur(14px) saturate(1.1);
	-webkit-backdrop-filter: blur(14px) saturate(1.1);
	position: relative; overflow: hidden;
	animation: bcw-rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.bcw-card::before {
	content: ''; position: absolute; inset: 0; pointer-events: none;
	background: radial-gradient(120% 70% at 85% 0%, var(--bcw-accent-soft), transparent 60%);
	opacity: 0.7;
}
@keyframes bcw-rise { from { opacity: 0; transform: translateY(10px) scale(0.99); } to { opacity: 1; transform: none; } }

.bcw-head { display: flex; align-items: center; gap: 8px; position: relative; }
.bcw-status {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
	color: rgba(255, 255, 255, 0.62);
}
.bcw-led { width: 7px; height: 7px; border-radius: 50%; background: var(--bcw-accent); box-shadow: 0 0 0 0 var(--bcw-accent); }
.is-bonding .bcw-led { animation: bcw-pulse 1.8s ease-out infinite; }
.is-grad .bcw-led { background: #34d399; box-shadow: 0 0 8px #34d399; }
.is-empty .bcw-led { background: rgba(255,255,255,0.3); }
@keyframes bcw-pulse {
	0% { box-shadow: 0 0 0 0 var(--bcw-accent-soft); }
	70% { box-shadow: 0 0 0 7px transparent; }
	100% { box-shadow: 0 0 0 0 transparent; }
}
.bcw-mint {
	margin-left: auto; font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.78rem;
	color: rgba(190, 210, 255, 0.85); text-decoration: none; padding: 2px 7px; border-radius: 6px;
	background: rgba(255, 255, 255, 0.05); transition: background 0.15s, color 0.15s;
}
.bcw-mint:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
.bcw-net, .bcw-mayhem {
	font-size: 0.62rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
	padding: 2px 6px; border-radius: 5px;
}
.bcw-net--dev { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
.bcw-mayhem { background: rgba(244, 114, 182, 0.16); color: #f472b6; }

.bcw-meter { margin: 14px 0 2px; }
.bcw-pct {
	display: flex; align-items: baseline; gap: 2px; line-height: 1;
	font-weight: 700; letter-spacing: -0.02em;
	font-variant-numeric: tabular-nums;
}
.bcw-pct-num { font-size: 2.9rem; background: linear-gradient(180deg, #fff, var(--bcw-accent)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.bcw-pct-sym { font-size: 1.3rem; color: var(--bcw-accent); font-weight: 600; }
.bcw-pct-label { font-size: 0.74rem; color: rgba(255, 255, 255, 0.45); letter-spacing: 0.03em; margin-top: 2px; }
.is-grad .bcw-pct-num { background: linear-gradient(180deg, #fff, #34d399); -webkit-background-clip: text; background-clip: text; }
.is-grad .bcw-pct-sym { color: #34d399; }

.bcw-curve { width: 100%; height: 92px; display: block; margin: 6px 0 12px; overflow: visible; }
.bcw-grad-line { stroke: rgba(255, 255, 255, 0.16); stroke-width: 1; stroke-dasharray: 3 4; }
.bcw-line { stroke: rgba(255, 255, 255, 0.28); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.bcw-marker-halo { fill: var(--bcw-accent); opacity: 0.28; }
.bcw-marker-dot { fill: #fff; stroke: var(--bcw-accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.is-grad .bcw-marker-dot { stroke: #34d399; }
.is-grad .bcw-marker-halo { fill: #34d399; }

.bcw-stats {
	display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 14px;
	padding: 12px 0 0; border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.bcw-stats div { min-width: 0; }
.bcw-stats dt { font-size: 0.64rem; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255, 255, 255, 0.42); margin: 0 0 3px; }
.bcw-stats dd { margin: 0; font-size: 0.95rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.bcw-cta {
	display: block; text-align: center; text-decoration: none;
	font-size: 0.84rem; font-weight: 600; color: #0a0a0a;
	padding: 9px 14px; border-radius: 10px;
	background: var(--bcw-accent);
	transition: transform 0.12s ease, filter 0.15s ease, box-shadow 0.15s ease;
	box-shadow: 0 6px 18px -6px var(--bcw-accent-soft);
}
.bcw-cta:hover { transform: translateY(-1px); filter: brightness(1.07); }
.bcw-cta:active { transform: translateY(0); }
.bcw-cta:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.is-empty .bcw-cta { background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.7); box-shadow: none; }

.bcw-by {
	display: block; text-align: center; margin-top: 9px;
	font-size: 0.64rem; letter-spacing: 0.08em; text-transform: uppercase;
	color: rgba(255, 255, 255, 0.32); text-decoration: none; transition: color 0.15s;
}
.bcw-by:hover { color: rgba(255, 255, 255, 0.6); }

.bcw-empty-msg { margin: 2px 0 14px; font-size: 0.82rem; color: rgba(255, 255, 255, 0.5); }
.bcw-retry {
	appearance: none; margin-left: 6px; padding: 3px 10px; border-radius: 7px;
	border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.06);
	color: #f2f3f7; font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
	transition: background 0.15s, border-color 0.15s;
}
.bcw-retry:hover { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.3); }
.bcw-retry:active { transform: translateY(1px); }
.bcw-retry:focus-visible { outline: 2px solid var(--bcw-accent); outline-offset: 2px; }
.bcw-card.is-loading .bcw-pct-num,
.bcw-card.is-loading .bcw-stats dd { color: transparent; background: rgba(255,255,255,0.08); border-radius: 6px; animation: bcw-shimmer 1.2s ease-in-out infinite; }
@keyframes bcw-shimmer { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
	.bcw-card, .is-bonding .bcw-led { animation: none; }
}
`;

let _stylesInjected = false;
function injectStyles(doc) {
	if (_stylesInjected) return;
	const tag = doc.createElement('style');
	tag.setAttribute('data-bcw', '');
	tag.textContent = STYLES;
	doc.head.appendChild(tag);
	_stylesInjected = true;
}

// ---------------------------------------------------------------------------
// SOL/USD price — fetched once, refreshed lazily, shared across mounts.
// ---------------------------------------------------------------------------

// Shared, cached SOL/USD read through the five-feed chain in
// src/shared/usd-price.js (Jupiter, CoinGecko, Coinbase, DefiLlama, Kraken).
// Resolves null when every feed is down; the caller falls back to SOL-only.
export async function getSolUsd() {
	return solToUsd(1);
}

const _easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------

/**
 * Mount the bonding-curve widget inside `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {{ mint?: string, network?: string, refreshMs?: number, showUsd?: boolean,
 *           accent?: string, showPoweredBy?: boolean }} opts
 * @returns {{ destroy(): void }}
 */
export function mountBondingCurve(rootEl, opts = {}) {
	const doc = rootEl.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
	if (!doc) return { destroy() {} };
	injectStyles(doc);

	const mint = String(opts.mint || '').trim();
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	// A mint that can't have a bonding curve (a settlement token, or a mainnet
	// address carrying neither launcher's mark) is treated like no mint at all:
	// paint the empty state, never poll. This stops a misconfigured mount from
	// firing /api/pump/curve requests that can only 404. The test is
	// network-aware because devnet mints carry no mark to test.
	const pollable = Boolean(mint) && isPumpMint(mint, network);
	const refreshMs = Math.max(5_000, Number(opts.refreshMs) || 15_000);
	const showUsd = opts.showUsd !== false;
	const accent = /^#[0-9a-fA-F]{3,8}$/.test(opts.accent || '') ? opts.accent : '#888888';

	const wrap = doc.createElement('div');
	wrap.className = 'bcw';
	wrap.style.setProperty('--bcw-accent', accent);
	wrap.style.setProperty('--bcw-accent-soft', accentSoft(accent));
	rootEl.appendChild(wrap);

	let destroyed = false;
	let stopped = false; // set once a mint is known to have no bonding curve (404)
	let timer = null;
	let raf = null;
	let displayedProgress = 0; // currently-rendered marker/percent position
	let everLoaded = false;    // a poll has resolved at least once (good frame on screen)
	let failStreak = 0;        // consecutive failed polls since the last good frame
	let view = { status: pollable ? 'loading' : 'empty', progress: 0 };

	// Initial paint — shell + empty/loading state.
	wrap.innerHTML = renderCardShell(view, { mint, network, showPoweredBy: opts.showPoweredBy });
	const card = wrap.querySelector('.bcw-card');
	if (pollable) card.classList.add('is-loading');
	const els = grab(wrap);
	if (!pollable) {
		applyEmptyState(
			card,
			els,
			mint ? 'No bonding curve — this isn’t a pump.fun mint.' : undefined,
		);
	}
	paintGeometry(els, 0);

	function setText(el, text) {
		if (el && el.textContent !== text) el.textContent = text;
	}

	function renderValues(v) {
		// Status class swap (bonding → graduated transitions live).
		card.classList.remove('is-bonding', 'is-grad', 'is-empty', 'is-loading');
		card.classList.add(
			v.status === 'graduated' ? 'is-grad' : v.status === 'empty' ? 'is-empty' : 'is-bonding',
		);
		setText(els.status, v.status === 'graduated' ? 'Graduated' : 'Bonding');

		if (v.hasUsd) {
			setText(els.mc, v.marketCapUsd == null ? '—' : fmtUsd(v.marketCapUsd));
			setText(
				els.raised,
				v.raisedSol == null ? '—' : `${fmtSol(v.raisedSol)} · ${fmtUsd(v.raisedUsd)}`,
			);
			setText(els.price, fmtPrice(v.priceUsd, { usd: true }));
		} else {
			setText(els.mc, fmtSol(v.marketCapSol));
			setText(els.raised, v.raisedSol == null ? '—' : fmtSol(v.raisedSol));
			setText(els.price, fmtPrice(v.priceSol));
		}
		animateTo(v.progress);
	}

	function animateTo(target) {
		const from = displayedProgress;
		const to = clamp01(target);
		if (Math.abs(to - from) < 0.0005) {
			displayedProgress = to;
			paintGeometry(els, to);
			return;
		}
		const dur = 700;
		const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
		if (raf) cancelAnimationFrame(raf);
		const step = (now) => {
			if (destroyed) return;
			const k = _easeOutCubic(Math.min(1, (now - start) / dur));
			displayedProgress = from + (to - from) * k;
			paintGeometry(els, displayedProgress);
			if (k < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
	}

	// A first load that never lands leaves the shell shimmering under a "Loading"
	// badge forever, which reads as a slow network long after the fetch gave up.
	// Once two attempts have failed with no good frame yet, say so and offer the
	// retry. Later failures keep the last good frame instead (a blip, not an outage).
	function applyLoadError() {
		card.classList.remove('is-loading', 'is-bonding', 'is-grad');
		card.classList.add('is-empty');
		setTextSafe(els.status, 'Offline');
		if (els.pctNum) els.pctNum.textContent = UNKNOWN_VALUE;
		if (!els.meter || wrap.querySelector('[data-bcw-retry]')) return;
		const p = doc.createElement('p');
		p.className = 'bcw-empty-msg';
		p.setAttribute('role', 'alert');
		p.textContent = 'Couldn’t reach the bonding-curve feed. ';
		const btn = doc.createElement('button');
		btn.type = 'button';
		btn.className = 'bcw-retry';
		btn.dataset.bcwRetry = '';
		btn.textContent = 'Retry';
		btn.addEventListener('click', () => {
			p.remove();
			failStreak = 0;
			card.classList.add('is-loading');
			setTextSafe(els.status, 'Loading');
			poll();
		});
		p.appendChild(btn);
		els.meter.insertAdjacentElement('afterend', p);
	}

	function clearLoadError() {
		const btn = wrap.querySelector('[data-bcw-retry]');
		if (btn) btn.parentElement.remove();
	}

	async function poll() {
		if (destroyed || stopped || !pollable) return;
		try {
			const [resp, solUsd] = await Promise.all([
				fetch(`/api/pump/curve?mint=${encodeURIComponent(mint)}&network=${network}`),
				showUsd ? getSolUsd() : Promise.resolve(null),
			]);
			if (destroyed) return;
			if (resp.status === 404) {
				everLoaded = true;
				failStreak = 0;
				clearLoadError();
				// A 404 is terminal: this mint has no bonding curve (graduated or
				// not a pump.fun token) and never will. Stop the interval instead
				// of re-polling forever — an interval against a curve-less mint is
				// exactly what turned a misconfigured demo into a 404 storm.
				view = computeView(null);
				applyEmptyState(
					card,
					els,
					'No active bonding curve — this token may have graduated or isn’t a pump.fun mint.',
				);
				stopPolling();
				return;
			}
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			if (destroyed) return;
			everLoaded = true;
			failStreak = 0;
			clearLoadError();
			view = computeView(data, solUsd);
			if (view.status === 'empty') {
				applyEmptyState(card, els);
			} else {
				renderValues(view);
			}
		} catch {
			// Network blip: keep the last good frame and retry on the next tick.
			// With no good frame yet, surface the failure instead of shimmering on.
			failStreak += 1;
			if (!everLoaded && failStreak >= 2) applyLoadError();
		}
	}

	function stopPolling() {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	if (pollable) {
		poll();
		if (!stopped) timer = setInterval(poll, refreshMs);
	}

	return {
		destroy() {
			destroyed = true;
			if (timer) clearInterval(timer);
			if (raf) cancelAnimationFrame(raf);
			wrap.remove();
		},
	};
}

// --- mount-local DOM helpers ------------------------------------------------

function grab(wrap) {
	return {
		status: wrap.querySelector('.bcw-status'),
		pctNum: wrap.querySelector('.bcw-pct-num'),
		area: wrap.querySelector('[data-area]'),
		marker: wrap.querySelector('[data-marker]'),
		mc: wrap.querySelector('[data-mc]'),
		raised: wrap.querySelector('[data-raised]'),
		price: wrap.querySelector('[data-price]'),
		meter: wrap.querySelector('.bcw-meter'),
	};
}

function paintGeometry(els, progress) {
	const p = clamp01(progress);
	if (els.area) els.area.setAttribute('d', areaPathFor(p));
	if (els.marker) {
		const { x, y } = curvePointAt(p);
		els.marker.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
	}
	if (els.pctNum) els.pctNum.textContent = (p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0);
}

function applyEmptyState(card, els, msg) {
	card.classList.remove('is-bonding', 'is-grad', 'is-loading');
	card.classList.add('is-empty');
	setTextSafe(els.status, 'No curve');
	setTextSafe(els.mc, '—');
	setTextSafe(els.raised, '—');
	setTextSafe(els.price, '—');
	if (els.pctNum) els.pctNum.textContent = '—';
	if (els.meter && !els.meter.querySelector('.bcw-empty-msg') && msg) {
		const p = document.createElement('p');
		p.className = 'bcw-empty-msg';
		p.textContent = msg;
		els.meter.insertAdjacentElement('afterend', p);
	}
}

function setTextSafe(el, text) {
	if (el) el.textContent = text;
}

/** Derive a translucent accent for glows from a hex color. */
function accentSoft(hex) {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return 'rgba(139, 92, 246, 0.22)';
	return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, 0.22)`;
}
