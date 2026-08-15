/**
 * Mission Control — price chart.
 *
 * A TradingView-grade candlestick + volume chart for the focused coin, built on
 * TradingView's open-source `lightweight-charts`. Two real data paths, never
 * fabricated:
 *
 *   • History — GET /api/pump/price-history (Birdeye → GeckoTerminal OHLCV).
 *   • Realtime — the per-mint trade firehose (SSE /api/pump/trades-stream?mint).
 *     Each on-chain buy/sell updates the live candle tick-by-tick: the execution
 *     price is `sol_amount / token_amount × sol_price` (falling back to
 *     market-cap ÷ supply), and `sol_value_usd` accrues into the volume bar.
 *
 * The candle the user watches forming is the same trade flow the feed streams —
 * when the next history poll lands it reconciles silently against the upstream
 * OHLCV, so the live tail self-corrects and never drifts.
 */

import { createChart, CandlestickSeries, HistogramSeries, CrosshairMode } from 'lightweight-charts';
import { createSseClient } from './realtime.js';

// pump.fun mints a fixed 1B supply — the fallback when a trade lacks the
// sol/token legs needed to derive an execution price directly.
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

// Each interval pairs the price-history `interval` code with its bucket size (s)
// and how far back to load, so every timeframe lands a useful number of candles.
const INTERVALS = [
	{ code: '1m', label: '1m', sec: 60, span: 3 * 3600 },
	{ code: '5m', label: '5m', sec: 300, span: 12 * 3600 },
	{ code: '15m', label: '15m', sec: 900, span: 2 * 86400 },
	{ code: '1H', label: '1H', sec: 3600, span: 10 * 86400 },
	{ code: '6H', label: '6H', sec: 21600, span: 30 * 86400 },
	{ code: '1D', label: '1D', sec: 86400, span: 30 * 86400 },
];
const DEFAULT_INTERVAL = '5m';

// CSS-variable colors with hard fallbacks so the canvas (which can't read CSS
// vars) always paints, even before the theme stylesheet resolves.
function readColors(host) {
	const cs = getComputedStyle(host);
	const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
	return {
		up: v('--success', '#4ade80'),
		down: v('--danger', '#f87171'),
		ink: v('--ink', '#e8e8e8'),
		dim: v('--ink-dim', '#888'),
		faint: v('--ink-faint', '#666'),
		grid: 'rgba(255,255,255,0.05)',
		accent: v('--accent', '#7dd3fc'),
	};
}

// Micro-cap prices need significant-figure formatting, not fixed decimals.
// Renders sub-cent values DexScreener-style with a subscript zero count:
// 0.00000489 → "0.0₅489". Used for axis labels, the legend, and the tooltip.
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
function subscript(n) {
	return String(n).split('').map((d) => SUBSCRIPTS[+d]).join('');
}
function formatPrice(p) {
	if (!Number.isFinite(p) || p <= 0) return '—';
	if (p >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	if (p >= 0.01) return p.toFixed(4);
	const exp = Math.floor(Math.log10(p)); // negative
	const leadingZeros = -exp - 1;
	const sig = Math.round(p * 10 ** (-exp + 2)); // 3 significant digits
	if (leadingZeros >= 4) return `0.0${subscript(leadingZeros)}${sig}`;
	return p.toFixed(Math.min(leadingZeros + 3, 12));
}

// Granularity for the price scale — ~3 significant figures around the data.
function minMoveFor(repPrice) {
	if (!Number.isFinite(repPrice) || repPrice <= 0) return 0.01;
	const exp = Math.floor(Math.log10(repPrice));
	return 10 ** (exp - 2);
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host  — container the chart mounts into (sized via CSS).
 * @param {string} opts.mint
 * @returns {{ destroy(): void }}
 */
export function mountPriceChart({ host, mint }) {
	const colors = readColors(host);
	let interval = INTERVALS.find((i) => i.code === DEFAULT_INTERVAL) || INTERVALS[1];
	let destroyed = false;
	let seq = 0;
	let sse = null;
	let chart = null;
	let candle = null;
	let volume = null;
	let lastBar = null; // { time, open, high, low, close }
	let lastVol = 0;
	let latestSolPrice = 0;

	host.innerHTML = `
		<div class="mc-chart">
			<div class="mc-chart-head">
				<div class="mc-chart-legend" data-host="legend"><span class="mc-section-h">Price</span></div>
				<div class="mc-chart-right">
					<span class="mc-chart-live" data-host="live" data-state="off" title="Realtime trade stream"><span class="mc-chart-live-dot"></span>live</span>
					<div class="mc-chart-ivs" role="tablist" aria-label="Chart interval" data-host="ivs"></div>
				</div>
			</div>
			<div class="mc-chart-body">
				<div class="mc-chart-canvas" data-host="canvas"></div>
				<div class="mc-chart-msg" data-host="msg" hidden></div>
			</div>
		</div>`;

	const $ = (sel) => host.querySelector(sel);
	const canvasEl = $('[data-host="canvas"]');
	const legendEl = $('[data-host="legend"]');
	const msgEl = $('[data-host="msg"]');
	const liveEl = $('[data-host="live"]');
	const ivsEl = $('[data-host="ivs"]');

	// ── interval switcher ───────────────────────────────────────────────────────
	ivsEl.innerHTML = INTERVALS.map(
		(iv) =>
			`<button type="button" class="mc-chart-iv" role="tab" data-code="${iv.code}" aria-selected="${iv.code === interval.code}">${iv.label}</button>`,
	).join('');
	ivsEl.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-code]');
		if (!btn) return;
		const next = INTERVALS.find((i) => i.code === btn.dataset.code);
		if (!next || next.code === interval.code) return;
		interval = next;
		for (const b of ivsEl.querySelectorAll('[data-code]')) b.setAttribute('aria-selected', String(b === btn));
		loadHistory();
	});

	function showMsg(text) {
		msgEl.textContent = text;
		msgEl.hidden = false;
		canvasEl.style.visibility = 'hidden';
	}
	function clearMsg() {
		msgEl.hidden = true;
		canvasEl.style.visibility = 'visible';
	}

	function setLive(state) {
		liveEl.dataset.state = state === 'live' ? 'on' : 'off';
	}

	// ── chart construction (once) ────────────────────────────────────────────────
	function buildChart(repPrice) {
		if (chart) return;
		chart = createChart(canvasEl, {
			autoSize: true,
			layout: {
				background: { color: 'transparent' },
				textColor: colors.dim,
				fontFamily: getComputedStyle(host).getPropertyValue('--font-mono') || 'ui-monospace, monospace',
				attributionLogo: false,
			},
			grid: {
				vertLines: { color: colors.grid },
				horzLines: { color: colors.grid },
			},
			crosshair: {
				mode: CrosshairMode.Normal,
				vertLine: { color: colors.faint, width: 1, style: 3, labelBackgroundColor: colors.faint },
				horzLine: { color: colors.faint, width: 1, style: 3, labelBackgroundColor: colors.faint },
			},
			rightPriceScale: { borderColor: colors.grid, scaleMargins: { top: 0.1, bottom: 0.28 } },
			timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false, rightOffset: 4 },
			handleScale: { axisPressedMouseMove: { time: true, price: false } },
		});

		candle = chart.addSeries(CandlestickSeries, {
			upColor: colors.up,
			downColor: colors.down,
			borderUpColor: colors.up,
			borderDownColor: colors.down,
			wickUpColor: colors.up,
			wickDownColor: colors.down,
			priceFormat: { type: 'custom', formatter: formatPrice, minMove: minMoveFor(repPrice) },
		});

		volume = chart.addSeries(HistogramSeries, {
			priceFormat: { type: 'volume' },
			priceScaleId: 'vol',
			priceLineVisible: false,
			lastValueVisible: false,
		});
		chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

		chart.subscribeCrosshairMove(onCrosshair);
	}

	function colorFor(bar) {
		return bar.close >= bar.open
			? 'rgba(74,222,128,0.45)'
			: 'rgba(248,113,113,0.45)';
	}

	function renderLegend(bar, change) {
		if (!bar) {
			legendEl.innerHTML = `<span class="mc-section-h">Price</span>`;
			return;
		}
		const cls = change == null ? '' : change >= 0 ? 'pos' : 'neg';
		const sign = change == null ? '' : change >= 0 ? '+' : '';
		const pct = change == null ? '' : `<span class="mc-chart-chg ${cls}">${sign}${change.toFixed(2)}%</span>`;
		legendEl.innerHTML =
			`<span class="mc-chart-px">$${formatPrice(bar.close)}</span>` +
			pct +
			`<span class="mc-chart-ohlc">O <b>${formatPrice(bar.open)}</b> H <b>${formatPrice(bar.high)}</b> L <b>${formatPrice(bar.low)}</b> C <b>${formatPrice(bar.close)}</b></span>`;
	}

	function onCrosshair(param) {
		if (!candle || !param || !param.time || !param.point) {
			// Off the chart — fall back to the latest bar vs the session open.
			if (lastBar) renderLegend(lastBar, sessionChange());
			return;
		}
		const bar = param.seriesData.get(candle);
		if (!bar) return;
		const ch = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : null;
		renderLegend(bar, ch);
	}

	let firstClose = null;
	function sessionChange() {
		if (firstClose == null || !lastBar) return null;
		return firstClose ? ((lastBar.close - firstClose) / firstClose) * 100 : null;
	}

	// ── history load ─────────────────────────────────────────────────────────────
	async function loadHistory(quiet = false) {
		const mySeq = ++seq;
		if (!quiet) showMsg('Loading chart…');
		const to = Math.floor(Date.now() / 1000);
		const from = to - interval.span;
		let payload = null;
		try {
			const r = await fetch(
				`/api/pump/price-history?mint=${encodeURIComponent(mint)}&interval=${interval.code}&from=${from}&to=${to}`,
				{ headers: { accept: 'application/json' } },
			);
			if (r.ok) payload = await r.json();
			else if (r.status === 502) payload = { data: [] };
		} catch {
			/* network — handled below */
		}
		if (destroyed || mySeq !== seq) return;

		// A visible load put the "Loading chart…" overlay up and hid the canvas, so
		// every exit from here has to resolve it. Gating on `!chart` instead left
		// the overlay stuck over a blanked chart forever whenever an interval switch
		// came back short. Quiet background polls never raised it, so they leave the
		// last good chart alone.
		const rows = Array.isArray(payload?.data) ? payload.data : null;
		if (!rows) {
			if (!quiet) showMsg('Price history is unavailable right now.');
			return;
		}
		const bars = rows
			.map((d) => ({ time: Number(d.t), open: Number(d.o), high: Number(d.h), low: Number(d.l), close: Number(d.c), vol: Number(d.v) }))
			.filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close) && b.close > 0)
			.sort((a, b) => a.time - b.time);

		if (bars.length < 2) {
			if (!quiet) showMsg(`No ${interval.label} price history yet for this coin.`);
			return;
		}

		clearMsg();
		const rep = bars[bars.length - 1].close;
		buildChart(rep);
		candle.applyOptions({ priceFormat: { type: 'custom', formatter: formatPrice, minMove: minMoveFor(rep) } });
		candle.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
		volume.setData(bars.map((b) => ({ time: b.time, value: Number.isFinite(b.vol) ? b.vol : 0, color: colorFor(b) })));
		chart.timeScale().fitContent();

		firstClose = bars[0].close;
		lastBar = { ...bars[bars.length - 1] };
		lastVol = Number.isFinite(lastBar.vol) ? lastBar.vol : 0;
		renderLegend(lastBar, sessionChange());
	}

	// ── realtime: fold each trade into the forming candle ────────────────────────
	function tradePrice(t) {
		const sol = Number(t.sol_amount ?? t.solAmount);
		const tok = Number(t.token_amount);
		const solPx = Number(t.sol_price) || latestSolPrice;
		if (Number.isFinite(sol) && Number.isFinite(tok) && tok > 0 && solPx > 0) return (sol / tok) * solPx;
		if (Number.isFinite(Number(t.market_cap_usd))) return Number(t.market_cap_usd) / PUMP_TOTAL_SUPPLY;
		return null;
	}

	function onTrade(t) {
		if (!t || t.mint !== mint || !candle || !lastBar) return;
		if (Number(t.sol_price) > 0) latestSolPrice = Number(t.sol_price);
		const px = tradePrice(t);
		if (!Number.isFinite(px) || px <= 0) return;
		const ts = Number(t.timestamp) || Math.floor(Date.now() / 1000);
		const bucket = Math.floor(ts / interval.sec) * interval.sec;
		const vUsd = Number(t.sol_value_usd) || (Number(t.sol_amount ?? t.solAmount) || 0) * (Number(t.sol_price) || latestSolPrice || 0);

		if (bucket < lastBar.time) return; // can't rewrite a settled candle
		if (bucket > lastBar.time) {
			lastBar = { time: bucket, open: lastBar.close, high: px, low: px, close: px };
			lastVol = 0;
		} else {
			lastBar.high = Math.max(lastBar.high, px);
			lastBar.low = Math.min(lastBar.low, px);
			lastBar.close = px;
		}
		lastVol += Number.isFinite(vUsd) ? vUsd : 0;
		candle.update({ time: lastBar.time, open: lastBar.open, high: lastBar.high, low: lastBar.low, close: lastBar.close });
		volume.update({ time: lastBar.time, value: lastVol, color: colorFor(lastBar) });
		renderLegend(lastBar, sessionChange());
	}

	function startStream() {
		sse = createSseClient({
			url: `/api/pump/trades-stream?mint=${encodeURIComponent(mint)}`,
			events: {
				trade: (d) => onTrade(d),
				close: () => {},
			},
			onState: (state) => setLive(state),
		});
		sse.start();
	}

	// ── periodic reconciliation against upstream OHLCV (self-correcting tail) ─────
	// Trade-implied prices can drift a hair from the indexer; a quiet reload every
	// ~45s realigns the candles without disturbing what the user is watching.
	const reconcileTimer = setInterval(() => {
		if (!destroyed && document.visibilityState === 'visible') loadHistory(true);
	}, 45_000);

	loadHistory();
	startStream();

	return {
		destroy() {
			destroyed = true;
			seq++;
			clearInterval(reconcileTimer);
			try { sse?.stop(); } catch { /* already stopped */ }
			try { chart?.remove(); } catch { /* already removed */ }
			chart = candle = volume = null;
			host.innerHTML = '';
		},
	};
}
