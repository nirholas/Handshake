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
 *   renderCardShell(view, cfg)                    — pure HTML string (tested)
 *   mountBondingCurve(rootEl, opts)               — full mount + polling + anim
 *
 * The generic <three-ws-widget type="bonding-curve" mint="…"> element is
 * handled by the dispatcher in kol-trades.js.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
	if (!data || !data.curve) {
		return { status: 'empty', progress: 0, hasUsd: false };
	}
	const grad = data.graduation || {};
	const price = data.price || {};
	const isGraduated = Boolean(grad.isGraduated || price.isGraduated || data.curve.complete);
	const progress = isGraduated ? 1 : clamp01(Number(grad.progressBps) / 10_000);

	// The SDK can report a small negative market cap for a freshly-created
	// curve (real reserves still at zero) — clamp so we never show "-$2".
	const marketCapSol = Math.max(0, lamportsToSol(price.marketCap));
	const raisedSol = Math.max(0, lamportsToSol(grad.solAccumulated ?? data.curve.realSolReserves));
	const priceSol = Math.max(0, lamportsToSol(price.buyPricePerToken));
	const hasUsd = Number.isFinite(Number(solUsd)) && Number(solUsd) > 0;

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
	width: min(420px, 92vw);
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

let _solUsd = { value: null, at: 0, inflight: null };
const SOL_USD_TTL = 60_000;

async function getSolUsd() {
	const now = Date.now();
	if (_solUsd.value != null && now - _solUsd.at < SOL_USD_TTL) return _solUsd.value;
	if (_solUsd.inflight) return _solUsd.inflight;
	_solUsd.inflight = (async () => {
		try {
			const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const d = await r.json();
			const usd = Number(d?.[SOL_MINT]?.usdPrice ?? d?.[SOL_MINT]?.price);
			if (Number.isFinite(usd) && usd > 0) {
				_solUsd = { value: usd, at: Date.now(), inflight: null };
				return usd;
			}
		} catch {
			/* graceful — caller falls back to SOL-only display */
		}
		_solUsd.inflight = null;
		return _solUsd.value;
	})();
	return _solUsd.inflight;
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
	const refreshMs = Math.max(5_000, Number(opts.refreshMs) || 15_000);
	const showUsd = opts.showUsd !== false;
	const accent = /^#[0-9a-fA-F]{3,8}$/.test(opts.accent || '') ? opts.accent : '#8b5cf6';

	const wrap = doc.createElement('div');
	wrap.className = 'bcw';
	wrap.style.setProperty('--bcw-accent', accent);
	wrap.style.setProperty('--bcw-accent-soft', accentSoft(accent));
	rootEl.appendChild(wrap);

	let destroyed = false;
	let timer = null;
	let raf = null;
	let displayedProgress = 0; // currently-rendered marker/percent position
	let view = { status: mint ? 'loading' : 'empty', progress: 0 };

	// Initial paint — shell + empty/loading state.
	wrap.innerHTML = renderCardShell(view, { mint, network, showPoweredBy: opts.showPoweredBy });
	const card = wrap.querySelector('.bcw-card');
	if (mint) card.classList.add('is-loading');
	const els = grab(wrap);
	if (!mint) applyEmptyState(card, els);
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
			setText(els.mc, fmtUsd(v.marketCapUsd));
			setText(els.raised, `${fmtSol(v.raisedSol)} · ${fmtUsd(v.raisedUsd)}`);
			setText(els.price, fmtPrice(v.priceUsd, { usd: true }));
		} else {
			setText(els.mc, fmtSol(v.marketCapSol));
			setText(els.raised, fmtSol(v.raisedSol));
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

	async function poll() {
		if (destroyed || !mint) return;
		try {
			const [resp, solUsd] = await Promise.all([
				fetch(`/api/pump/curve?mint=${encodeURIComponent(mint)}&network=${network}`),
				showUsd ? getSolUsd() : Promise.resolve(null),
			]);
			if (destroyed) return;
			if (resp.status === 404) {
				view = computeView(null);
				applyEmptyState(
					card,
					els,
					'No active bonding curve — this token may have graduated or isn’t a pump.fun mint.',
				);
				return;
			}
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			if (destroyed) return;
			view = computeView(data, solUsd);
			if (view.status === 'empty') {
				applyEmptyState(card, els);
			} else {
				renderValues(view);
			}
		} catch {
			// Network blip — keep last good frame, retry on next tick.
		}
	}

	poll();
	timer = setInterval(poll, refreshMs);

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
