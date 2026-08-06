/**
 * Agent Wallet hub — Portfolio Command tab (owner-only).
 *
 * One real-time, unified view of everything the agent wallet holds and has done:
 *   - a net-worth header (SOL + USD) with a live sparkline built from the stream,
 *   - a holdings table (live value, FIFO cost basis, unrealized P&L, liquidity
 *     warning) with a one-click jump to trade/exit,
 *   - a PnL attribution breakdown (what's making / losing money, by source),
 *   - a risk panel (reserve / dry powder, concentration of the volatile sleeve,
 *     tape exposure, drawdown, realized vol) with plain-language flags. Holding
 *     SOL/stables is treated as reserve, never as "concentration risk".
 *
 * Every figure is real, from GET /api/agents/:id/portfolio (api/_lib/portfolio.js):
 * live on-chain valuation + the sniper position ledger + the custody/spend ledger.
 * Unpriceable holdings are flagged, never guessed. Live updates arrive over the
 * SSE stream at …/portfolio/stream. Every state is designed; accessible; responsive.
 */

import { registerWalletTab } from '../registry.js';
import { formatSol, formatUsd } from '../util.js';

const PORT_STYLE_ID = 'awh-portfolio-style';
const PORT_STYLE = `
.awh-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.awh-port { display: flex; flex-direction: column; gap: var(--awh-gap, 16px); }
.awh-port-nw { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4,16px); flex-wrap: wrap; }
.awh-port-nw-main { min-width: 0; }
.awh-port-nw-label { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim,#888); }
.awh-port-nw-usd { font-family: var(--font-display, system-ui); font-size: clamp(2rem, 6vw, 2.6rem); font-weight: 800; letter-spacing: -.02em; color: var(--ink-bright,#fff); line-height: 1.05; margin-top: 6px; font-variant-numeric: tabular-nums; }
.awh-port-nw-sol { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top: 6px; font-variant-numeric: tabular-nums; }
.awh-port-spark { flex: 0 0 auto; align-self: center; }
.awh-port-spark svg { display: block; overflow: visible; }
.awh-port-pnl-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--space-4,16px); }
.awh-port-pnl { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim,#888); background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px); padding: 5px 11px; }
.awh-port-pnl b { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 700; font-size: var(--text-sm,.764rem); letter-spacing: 0; text-transform: none; }

/* Allocation — portfolio composition at a glance. */
.awh-alloc { margin-top: var(--space-4,16px); }
.awh-alloc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
.awh-alloc-head .k { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim,#888); }
.awh-alloc-head .v { font-size: var(--text-2xs,.6875rem); color: var(--ink-faint,#666); font-family: var(--font-mono, ui-monospace, monospace); }
.awh-alloc-bar { display: flex; height: 12px; border-radius: var(--radius-pill,999px); overflow: hidden; background: var(--surface-2, rgba(255,255,255,.05)); box-shadow: inset 0 0 0 1px var(--stroke, rgba(255,255,255,.06)); }
.awh-alloc-seg { flex: 0 0 auto; min-width: 2px; background: var(--c,#888); }
.awh-alloc-seg:not(:last-child) { box-shadow: inset -1.5px 0 0 rgba(0,0,0,.45); }
.awh-alloc-legend { display: flex; flex-wrap: wrap; gap: 7px 16px; margin-top: 12px; }
.awh-alloc-key { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.awh-alloc-key i { width: 9px; height: 9px; border-radius: 3px; background: var(--c,#888); flex: none; }
.awh-alloc-key b { color: var(--ink-bright,#fff); font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; font-size: var(--text-2xs,.6875rem); }
.awh-pos { color: var(--success,#4ade80); }
.awh-neg { color: var(--danger,#f87171); }
.awh-live { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.awh-live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--success,#4ade80); box-shadow: 0 0 0 0 color-mix(in srgb, var(--success,#4ade80) 60%, transparent); animation: awh-live-pulse 2s ease-out infinite; }
@keyframes awh-live-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--success,#4ade80) 50%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .awh-live::before { animation: none; } }
.awh-paused { appearance: none; font: inherit; font-size: var(--text-2xs,.6875rem); color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warn,#fbbf24) 35%, transparent); border-radius: var(--radius-pill,999px); padding: 1px 9px; cursor: pointer; transition: background var(--duration-fast,140ms); }
.awh-paused:hover { background: color-mix(in srgb, var(--warn,#fbbf24) 20%, transparent); }
.awh-paused:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }

.awh-port-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm,.764rem); }
.awh-port-table th { text-align: right; font-weight: 500; color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .04em; padding: 0 0 8px; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.08)); }
.awh-port-table th:first-child { text-align: left; }
.awh-port-table td { text-align: right; padding: 9px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); font-family: var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.awh-port-table td:first-child { text-align: left; font-family: inherit; white-space: normal; }
.awh-port-table td + td, .awh-port-table th + th { padding-left: 16px; }
.awh-port-table td:last-child, .awh-port-table th:last-child { width: 1%; }
.awh-port-table tr:last-child td { border-bottom: none; }
.awh-port-table tbody tr { transition: background var(--duration-fast,140ms); }
.awh-port-table tbody tr:hover td { background: var(--surface-1, rgba(255,255,255,.035)); }
.awh-port-table td.col-val { color: var(--ink-bright,#fff); font-weight: 600; }
.awh-port-asset { display: flex; align-items: center; gap: 9px; min-width: 0; }
.awh-port-asset img { width: 22px; height: 22px; border-radius: 50%; flex: none; background: var(--surface-2, rgba(255,255,255,.05)); object-fit: cover; }
.awh-port-asset .ph { width: 22px; height: 22px; border-radius: 50%; flex: none; background: var(--surface-3, rgba(255,255,255,.08)); display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: var(--ink-dim,#888); font-family: var(--font-mono, ui-monospace, monospace); }
.awh-port-sym { color: var(--ink-bright,#fff); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-port-sub { color: var(--ink-faint,#666); font-size: var(--text-2xs,.6875rem); }
.awh-port-warn { display: inline-block; margin-left: 6px; font-size: var(--text-2xs,.6875rem); color: var(--warn,#fbbf24); border: 1px solid color-mix(in srgb, var(--warn,#fbbf24) 40%, transparent); border-radius: var(--radius-pill,999px); padding: 1px 7px; vertical-align: middle; }
.awh-port-trade { font-size: var(--text-2xs,.6875rem); padding: 5px 10px; }
.awh-muted { color: var(--ink-faint,#666); }

.awh-attr { display: flex; flex-direction: column; gap: 2px; }
.awh-attr-row { display: grid; grid-template-columns: 1fr auto auto; gap: var(--space-3,12px); align-items: center; padding: 9px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); }
.awh-attr-row:last-child { border-bottom: none; }
.awh-attr-label { color: var(--ink,#e8e8e8); font-size: var(--text-sm,.764rem); }
.awh-attr-bar { grid-column: 1 / -1; height: 4px; border-radius: var(--radius-pill,999px); background: var(--surface-2, rgba(255,255,255,.05)); overflow: hidden; }
.awh-attr-bar > span { display: block; height: 100%; border-radius: inherit; }
.awh-attr-val { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); }
.awh-attr-sub { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); font-family: var(--font-mono, ui-monospace, monospace); }

.awh-risk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(124px, 1fr)); gap: var(--space-3,12px); }
.awh-risk-cell { position: relative; overflow: hidden; background: var(--surface-1, rgba(255,255,255,.03)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding: var(--space-3,12px); transition: border-color var(--duration-fast,140ms), transform var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.awh-risk-cell::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent, transparent); opacity: .8; }
.awh-risk-cell:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent, #fff) 45%, var(--stroke, rgba(255,255,255,.12))); background: var(--surface-2, rgba(255,255,255,.05)); }
.awh-risk-k { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim,#888); }
.awh-risk-v { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-lg,1.236rem); font-weight: 700; color: var(--ink-bright,#fff); margin-top: 4px; font-variant-numeric: tabular-nums; }
.awh-risk-meter { height: 4px; border-radius: var(--radius-pill,999px); background: var(--surface-2, rgba(255,255,255,.06)); margin-top: 10px; overflow: hidden; }
.awh-risk-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--accent, #888); }

/* Staggered entrance — first paint only (gated by .awh-anim-in on the panel). */
.awh-anim-in > .awh-card { animation: awh-rise .5s cubic-bezier(.2,.7,.2,1) both; }
.awh-anim-in > .awh-card:nth-child(1) { animation-delay: .02s; }
.awh-anim-in > .awh-card:nth-child(2) { animation-delay: .09s; }
.awh-anim-in > .awh-card:nth-child(3) { animation-delay: .16s; }
.awh-anim-in > .awh-card:nth-child(4) { animation-delay: .23s; }
.awh-anim-in .awh-alloc-bar { animation: awh-wipe .8s .18s cubic-bezier(.2,.7,.2,1) both; }
.awh-anim-in .awh-risk-meter > span { animation: awh-meter .8s .12s cubic-bezier(.2,.7,.2,1) both; }
@keyframes awh-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes awh-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes awh-meter { from { transform: scaleX(0); transform-origin: left; } to { transform: scaleX(1); } }
@media (prefers-reduced-motion: reduce) { .awh-anim-in > .awh-card, .awh-anim-in .awh-alloc-bar, .awh-anim-in .awh-risk-meter > span { animation: none; } }
.awh-flags { list-style: none; margin: var(--space-3,12px) 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.awh-flag { display: flex; gap: 9px; align-items: flex-start; font-size: var(--text-sm,.764rem); padding: 9px 11px; border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-flag::before { content: '•'; flex: none; }
.awh-flag.is-danger { border-color: color-mix(in srgb, var(--danger,#ef4444) 45%, transparent); color: var(--danger,#f87171); }
.awh-flag.is-warn { border-color: color-mix(in srgb, var(--warn,#fbbf24) 45%, transparent); color: var(--warn,#fbbf24); }
.awh-flag.is-info { color: var(--ink-dim,#888); }
.awh-port-note { font-size: var(--text-2xs,.6875rem); color: var(--ink-faint,#666); margin-top: var(--space-3,12px); }

.awh-port-skel span { display: block; background: var(--surface-2, rgba(255,255,255,.05)); border-radius: var(--radius-sm,6px); animation: awh-skel 1.4s ease-in-out infinite; }
.awh-port-skel .a { height: 30px; width: 46%; margin-bottom: 10px; }
.awh-port-skel .b { height: 14px; width: 28%; margin-bottom: 20px; }
.awh-port-skel .c { height: 18px; width: 100%; margin-bottom: 10px; }
.awh-port-skel .c:nth-child(4) { width: 82%; }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .awh-port-skel span, .awh-port-table td { animation: none; } }
@media (max-width: 480px) {
	.awh-port-table .col-basis, .awh-port-table .col-amt { display: none; }
}
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(PORT_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = PORT_STYLE_ID;
	tag.textContent = PORT_STYLE;
	document.head.appendChild(tag);
}

const SPARK_MAX = 40; // points retained for the live net-worth sparkline

function fmtSolSigned(sol) {
	if (sol == null || !Number.isFinite(sol)) return '—';
	const s = formatSol(Math.abs(sol));
	return `${sol > 0 ? '+' : sol < 0 ? '−' : ''}${s} SOL`;
}
function pnlClass(n) { return n > 0 ? 'awh-pos' : n < 0 ? 'awh-neg' : ''; }

function sparkline(points, w = 150, h = 46) {
	const vals = points.filter((v) => Number.isFinite(v));
	if (vals.length < 2) return '';
	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const span = max - min || 1;
	const pad = 3;
	const stepX = w / (vals.length - 1);
	const xy = vals.map((v, i) => {
		const x = i * stepX;
		const y = h - pad - ((v - min) / span) * (h - pad * 2);
		return [x, y];
	});
	const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const area = `${line} L${w},${h} L0,${h} Z`;
	const [ex, ey] = xy[xy.length - 1];
	const up = vals[vals.length - 1] >= vals[0];
	const stroke = up ? 'var(--success,#4ade80)' : 'var(--danger,#f87171)';
	return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Net worth trend">
		<defs><linearGradient id="awhSparkFill" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="${stroke}" stop-opacity=".26" />
			<stop offset="1" stop-color="${stroke}" stop-opacity="0" />
		</linearGradient></defs>
		<path d="${area}" fill="url(#awhSparkFill)" stroke="none" />
		<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
		<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${stroke}" fill-opacity=".22" />
		<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="1.9" fill="${stroke}" />
	</svg>`;
}

// Allocation-segment colour: SOL (Solana violet), $THREE (platform green), stables
// (teal), and a rotating warm palette for volatile positions. Gradients read richer
// than flats in the composition bar.
const ALLOC_RISK_PALETTE = ['#fb923c', '#f472b6', '#facc15', '#c084fc', '#38bdf8', '#f87171'];
function allocColor(h, riskIndex) {
	if (h.isNative) return 'linear-gradient(90deg,#9945FF,#8752F3)';
	if (h.is_three) return 'linear-gradient(90deg,#34d399,#10b981)';
	if (h.stable) return 'linear-gradient(90deg,#2dd4bf,#14b8a6)';
	return ALLOC_RISK_PALETTE[riskIndex % ALLOC_RISK_PALETTE.length];
}

// Heat colour for a 0..100 "more is worse" share (concentration, exposure).
function heatColor(pct) {
	if (pct == null || !Number.isFinite(pct)) return 'var(--ink-faint,#666)';
	if (pct >= 75) return 'var(--danger,#f87171)';
	if (pct >= 50) return 'var(--warn,#fbbf24)';
	if (pct >= 25) return '#a3e635';
	return 'var(--success,#4ade80)';
}

registerWalletTab({
	id: 'portfolio',
	label: 'Portfolio',
	order: 15,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, toast, copyToClipboard } = ctx;

		let destroyed = false;
		let visible = false;
		let detachNet = null;
		let es = null;
		const state = {
			loaded: false,
			error: null,
			data: null,
			spark: [], // net-worth USD history for the sparkline
			live: false,
			streamDown: false, // SSE permanently closed → live updates paused
			animated: false, // entrance animation plays once, not on every live tick
		};

		function pushSpark(usd) {
			if (!Number.isFinite(usd)) return;
			state.spark.push(usd);
			if (state.spark.length > SPARK_MAX) state.spark.shift();
		}

		function isEmpty(d) {
			const nw = d?.net_worth?.usd ?? 0;
			const nwSol = d?.net_worth?.sol ?? 0;
			return (!d?.holdings || d.holdings.length === 0) && (d?.metrics?.closed_count ?? 0) === 0 && nw <= 0 && nwSol <= 0;
		}

		function render() {
			if (destroyed) return;
			if (!state.loaded) {
				panel.innerHTML = `<div class="awh-card awh-port-skel" aria-busy="true" aria-label="Loading portfolio">
					<span class="a"></span><span class="b"></span><span class="c"></span><span class="c"></span><span class="c"></span>
				</div>`;
				return;
			}
			if (state.error) {
				panel.innerHTML = `<div class="awh-card">
					<div class="awh-empty">Could not load the portfolio — ${escapeHtml(state.error)}.
					<button class="awh-btn awh-port-trade" type="button" data-act="retry">Retry</button></div>
				</div>`;
				panel.querySelector('[data-act="retry"]')?.addEventListener('click', () => { reload(); });
				return;
			}
			const d = state.data;
			if (isEmpty(d)) {
				panel.innerHTML = `<div class="awh-card">
					<h2 class="awh-card-h">Portfolio Command</h2>
					<div class="awh-empty">
						This wallet is empty. Once it holds SOL or tokens — or makes its first trade or snipe —
						its live net worth, cost basis, P&amp;L attribution, and risk metrics appear here.
						<div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
							<button class="awh-btn awh-port-trade" type="button" data-go="deposit">Deposit funds</button>
							<button class="awh-btn awh-port-trade" type="button" data-go="trade">Make a trade</button>
						</div>
					</div>
				</div>`;
				panel.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.openTab(b.dataset.go)));
				return;
			}

			panel.innerHTML = `
				${renderHeader(d)}
				${renderHoldings(d)}
				${renderAttribution(d)}
				${renderRisk(d)}
			`;
			// Entrance animation runs on the first populated paint only — live stream
			// re-renders (every few seconds) must not replay it.
			if (!state.animated) { panel.classList.add('awh-anim-in'); state.animated = true; }
			else panel.classList.remove('awh-anim-in');
			wire();
		}

		function renderHeader(d) {
			const nw = d.net_worth || {};
			const realized = nw.realized_pnl_sol ?? 0;
			const unrealized = nw.unrealized_pnl_sol ?? 0;
			const usd = formatUsd(nw.usd ?? 0) || '$0.00';
			const spark = sparkline(state.spark);
			return `<div class="awh-card">
				<div class="awh-port-nw">
					<div class="awh-port-nw-main">
						<div class="awh-port-nw-label">Net worth ${state.live
							? '<span class="awh-live">live</span>'
							: state.streamDown
								? '<button class="awh-paused" type="button" data-act="resume" title="Live updates paused — click to reconnect">updates paused ↻</button>'
								: ''}</div>
						<div class="awh-port-nw-usd">${escapeHtml(usd)}</div>
						<div class="awh-port-nw-sol">${escapeHtml(formatSol(nw.sol))} SOL${d.sol_usd ? ` · SOL ${escapeHtml(formatUsd(d.sol_usd) || '')}` : ''}</div>
					</div>
					${spark ? `<div class="awh-port-spark">${spark}</div>` : ''}
				</div>
				<div class="awh-port-pnl-row">
					<span class="awh-port-pnl">Realized <b class="${pnlClass(realized)}">${escapeHtml(fmtSolSigned(realized))}</b></span>
					<span class="awh-port-pnl">Unrealized <b class="${pnlClass(unrealized)}">${escapeHtml(fmtSolSigned(unrealized))}</b></span>
				</div>
				${renderAllocation(d)}
			</div>`;
		}

		function renderAllocation(d) {
			const valued = (d.holdings || []).filter((h) => Number.isFinite(h.usd_value) && h.usd_value > 0);
			const total = valued.reduce((s, h) => s + h.usd_value, 0);
			if (!valued.length || total <= 0) return '';

			// Cap segments so the bar stays legible; fold the tail into "Other".
			const MAX_SEG = 7;
			let segs = valued.slice();
			if (valued.length > MAX_SEG) {
				const head = valued.slice(0, MAX_SEG - 1);
				const tail = valued.slice(MAX_SEG - 1);
				const otherUsd = tail.reduce((s, h) => s + h.usd_value, 0);
				segs = [...head, { symbol: `+${tail.length} more`, usd_value: otherUsd, _other: true }];
			}

			let riskI = 0;
			const parts = segs.map((h) => {
				const pct = (h.usd_value / total) * 100;
				const color = h._other ? 'var(--surface-3, rgba(255,255,255,.14))' : allocColor(h, h.isNative || h.stable || h.is_three ? 0 : riskI++);
				const sym = escapeHtml(h.symbol || '?');
				const label = `${sym} · ${pct.toFixed(pct < 10 ? 1 : 0)}% · ${formatUsd(h.usd_value) || ''}`;
				return {
					seg: `<span class="awh-alloc-seg" style="flex-basis:${pct.toFixed(2)}%; --c:${color};" title="${escapeHtml(label)}"></span>`,
					key: `<span class="awh-alloc-key"><i style="--c:${color};"></i>${sym} <b>${pct.toFixed(pct < 10 ? 1 : 0)}%</b></span>`,
				};
			});
			const summary = segs.map((h) => `${h.symbol} ${((h.usd_value / total) * 100).toFixed(0)}%`).join(', ');
			return `<div class="awh-alloc">
				<div class="awh-alloc-head">
					<span class="k">Allocation</span>
					<span class="v">${valued.length} priced asset${valued.length === 1 ? '' : 's'}</span>
				</div>
				<div class="awh-alloc-bar" role="img" aria-label="Allocation: ${escapeHtml(summary)}">${parts.map((p) => p.seg).join('')}</div>
				<div class="awh-alloc-legend">${parts.map((p) => p.key).join('')}</div>
			</div>`;
		}

		function renderHoldings(d) {
			const rows = d.holdings || [];
			if (!rows.length) {
				return `<div class="awh-card"><h2 class="awh-card-h">Holdings</h2>
					<div class="awh-empty">No holdings yet — deposits and buys appear here.</div></div>`;
			}
			const body = rows.map((h) => {
				const sym = escapeHtml(h.symbol || '?');
				const sub = h.isNative ? 'Native' : (h.is_three ? '$THREE' : (h.stable ? 'Stable' : escapeHtml(h.name || '')));
				const img = h.logo
					? `<img src="${escapeHtml(h.logo)}" alt="" loading="lazy" data-fallback="element" data-fallback-tag="span" data-fallback-class="ph" data-fallback-text="${sym.slice(0, 2)}">`
					: `<span class="ph">${sym.slice(0, 2)}</span>`;
				const value = h.usd_value != null ? (formatUsd(h.usd_value) || '—') : '<span class="awh-muted">unpriced</span>';
				const amt = h.amount != null ? formatNum(h.amount) : '—';
				const basis = h.cost_basis_sol != null ? `${formatSol(h.cost_basis_sol)}◎` : '<span class="awh-muted">—</span>';
				let upnl = '<span class="awh-muted">—</span>';
				if (h.unrealized_sol != null) {
					const pct = h.unrealized_pct != null ? ` (${h.unrealized_pct > 0 ? '+' : ''}${h.unrealized_pct}%)` : '';
					upnl = `<span class="${pnlClass(h.unrealized_sol)}">${escapeHtml(fmtSolSigned(h.unrealized_sol))}${pct}</span>`;
				}
				const warn = h.liquidity_warning ? `<span class="awh-port-warn" title="No live market price — value shown is unknown, never guessed.">illiquid</span>` : '';
				const tradeBtn = h.isNative
					? ''
					: `<button class="awh-btn awh-port-trade" type="button" data-trade="${escapeHtml(h.mint || '')}" aria-label="Trade ${sym}">Trade ↗</button>`;
				return `<tr>
					<td>
						<div class="awh-port-asset">${img}
							<span style="min-width:0;">
								<span class="awh-port-sym">${sym}${warn}</span><br>
								<span class="awh-port-sub">${sub}</span>
							</span>
						</div>
					</td>
					<td class="col-amt">${escapeHtml(amt)}</td>
					<td class="col-val">${value}</td>
					<td class="col-basis">${basis}</td>
					<td>${upnl}</td>
					<td>${tradeBtn}</td>
				</tr>`;
			}).join('');
			return `<div class="awh-card">
				<h2 class="awh-card-h">Holdings <span class="awh-port-sub">${rows.length}</span></h2>
				<div style="overflow-x:auto;">
				<table class="awh-port-table">
					<thead><tr>
						<th scope="col">Asset</th><th scope="col" class="col-amt">Amount</th><th scope="col">Value</th>
						<th scope="col" class="col-basis">Cost basis</th><th scope="col">Unrealized</th><th scope="col"><span class="awh-sr-only">Actions</span></th>
					</tr></thead>
					<tbody>${body}</tbody>
				</table>
				</div>
			</div>`;
		}

		function renderAttribution(d) {
			const rows = (d.attribution || []).filter((a) => !a.is_outflow);
			const outflows = (d.attribution || []).filter((a) => a.is_outflow);
			if (!rows.length && !outflows.length) {
				return `<div class="awh-card"><h2 class="awh-card-h">P&amp;L attribution</h2>
					<div class="awh-empty">No closed or open trades to attribute yet.</div></div>`;
			}
			const maxAbs = Math.max(1, ...rows.map((a) => Math.abs(a.total_sol ?? 0)));
			const body = rows.map((a) => {
				const total = a.total_sol ?? 0;
				const w = Math.min(100, (Math.abs(total) / maxAbs) * 100);
				const col = total >= 0 ? 'var(--success,#4ade80)' : 'var(--danger,#f87171)';
				const realized = a.realized_sol ?? 0;
				const unreal = a.unrealized_sol ?? 0;
				return `<div class="awh-attr-row">
					<span class="awh-attr-label">${escapeHtml(a.label)}</span>
					<span class="awh-attr-sub">R ${escapeHtml(fmtSolSigned(realized))} · U ${escapeHtml(fmtSolSigned(unreal))}</span>
					<span class="awh-attr-val ${pnlClass(total)}">${escapeHtml(fmtSolSigned(total))}</span>
					<span class="awh-attr-bar"><span style="width:${w}%; background:${col};"></span></span>
				</div>`;
			}).join('');
			const out = outflows.map((a) =>
				`<div class="awh-attr-row">
					<span class="awh-attr-label awh-muted">${escapeHtml(a.label)}</span>
					<span class="awh-attr-sub">outflow</span>
					<span class="awh-attr-val awh-muted">${escapeHtml(formatSol(a.spent_sol))} SOL</span>
				</div>`).join('');
			return `<div class="awh-card">
				<h2 class="awh-card-h">P&amp;L attribution</h2>
				<div class="awh-attr">${body}${out}</div>
				<div class="awh-port-note">${escapeHtml(d.basis_note || '')}</div>
			</div>`;
		}

		function renderRisk(d) {
			const r = d.risk || {};
			// Concentration is the largest *volatile* position — holding SOL/stables
			// is reserve, not a risk bet. "None" when nothing is at tape risk.
			const hasRisk = (r.risk_assets_count ?? 0) > 0;
			const topRisk = hasRisk ? (r.top_risk_position_pct ?? 0) : 0;
			const conc = !hasRisk ? 'None' : (r.top_risk_position_pct != null ? `${r.top_risk_position_pct}%` : '—');
			const dd = r.max_drawdown_pct;
			// [label, value, help, meter fraction 0..1 | null, accent colour]
			const cells = [
				['Reserve', r.reserve_pct != null ? `${r.reserve_pct}%` : '—', 'SOL + stables — dry powder ready to deploy, no tape risk',
					r.reserve_pct != null ? r.reserve_pct / 100 : null, 'var(--success,#4ade80)'],
				['Concentration', conc, 'Largest single memecoin position, as a share of net worth',
					hasRisk ? topRisk / 100 : 0, heatColor(hasRisk ? topRisk : 0)],
				['Tape exposure', r.exposure_pct != null ? `${r.exposure_pct}%` : '—', 'Share of net worth in volatile memecoins',
					r.exposure_pct != null ? r.exposure_pct / 100 : null, heatColor(r.exposure_pct)],
				['Max drawdown', dd != null ? `${dd}%` : '—', 'Largest realized drop from a net-worth peak',
					dd != null ? Math.min(dd, 100) / 100 : null, heatColor(dd)],
				['Realized vol', r.realized_volatility_pct != null ? `${r.realized_volatility_pct}%` : '—', 'Standard deviation of per-trade returns',
					null, 'var(--ink-faint,#666)'],
			];
			const grid = cells.map(([k, v, help, frac, accent]) =>
				`<div class="awh-risk-cell" style="--accent:${accent};" title="${escapeHtml(help)}" aria-label="${escapeHtml(`${k}: ${v}. ${help}`)}">
					<div class="awh-risk-k">${escapeHtml(k)}</div>
					<div class="awh-risk-v">${escapeHtml(v)}</div>
					${frac != null ? `<div class="awh-risk-meter"><span style="width:${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%;"></span></div>` : ''}
				</div>`).join('');
			const flags = (d.risk_flags || []).map((f) =>
				`<li class="awh-flag is-${escapeHtml(f.level)}">${escapeHtml(f.text)}</li>`).join('');
			return `<div class="awh-card">
				<h2 class="awh-card-h">Risk</h2>
				<div class="awh-risk-grid">${grid}</div>
				${flags ? `<ul class="awh-flags">${flags}</ul>` : ''}
			</div>`;
		}

		function wire() {
			panel.querySelector('[data-act="resume"]')?.addEventListener('click', () => {
				state.streamDown = false;
				render();
				reload();
			});
			panel.querySelectorAll('[data-trade]').forEach((b) => {
				b.addEventListener('click', async () => {
					const mint = b.dataset.trade;
					if (mint) await copyToClipboard(mint);
					ctx.openTab('trade');
					toast('Mint copied — paste it into Trade to load this coin.');
				});
			});
		}

		async function fetchSnapshot() {
			const net = ctx.getNetwork();
			const url = `/api/agents/${encodeURIComponent(ctx.agentId)}/portfolio?network=${encodeURIComponent(net)}`;
			const r = await fetch(url, { credentials: 'include' });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) {
				const code = typeof j?.error === 'string' ? j.error : j?.error?.code || `error ${r.status}`;
				throw new Error(j?.error_description || j?.error?.message || code);
			}
			return j.data;
		}

		async function reload() {
			state.loaded = false;
			state.error = null;
			render();
			try {
				const d = await fetchSnapshot();
				if (destroyed) return;
				state.data = d;
				pushSpark(d?.net_worth?.usd);
				state.error = null;
			} catch (e) {
				state.error = e?.message || 'network error';
			} finally {
				state.loaded = true;
				render();
				if (!state.error) openStream();
			}
		}

		function openStream() {
			closeStream();
			if (destroyed || !visible) return;
			const net = ctx.getNetwork();
			try {
				es = new EventSource(
					`/api/agents/${encodeURIComponent(ctx.agentId)}/portfolio/stream?network=${encodeURIComponent(net)}`,
					{ withCredentials: true },
				);
			} catch { es = null; return; }
			es.addEventListener('snapshot', (msg) => {
				let ev;
				try { ev = JSON.parse(msg.data); } catch { return; }
				if (destroyed || !ev) return;
				state.data = { ...state.data, ...ev };
				pushSpark(ev?.net_worth?.usd);
				state.live = true;
				state.streamDown = false;
				render();
			});
			es.addEventListener('error', () => {
				state.live = false;
				// EventSource auto-reconnects; if the server closed permanently, stop
				// and surface a "paused" affordance so the user knows data is frozen.
				if (es && es.readyState === EventSource.CLOSED) {
					closeStream();
					state.streamDown = true;
					render();
				}
			});
		}
		function closeStream() {
			if (es) { try { es.close(); } catch { /* noop */ } es = null; }
			state.live = false;
		}

		detachNet = ctx.onNetworkChange(() => {
			state.spark = [];
			closeStream();
			reload();
		});

		render();

		return {
			onShow() {
				visible = true;
				if (!state.loaded || state.error) reload();
				else { render(); openStream(); }
			},
			onHide() {
				visible = false;
				closeStream();
			},
			destroy() {
				destroyed = true;
				closeStream();
				detachNet?.();
			},
		};
	},
});

function formatNum(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
	if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
	return Number(n.toPrecision(4)).toString();
}
