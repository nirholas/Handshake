// agent-screen-pnl-hud.js — the live Portfolio / PnL HUD controller.
//
// Drives one floating HUD panel on /agent-screen: the agent's wallet valued
// live (net worth in SOL + USD), a 24h delta that ticks green/red, a sparkline
// redrawn from the real wallet_value_snapshots series, and the ranked holdings
// with $THREE pinned + featured. Every number is real — see pnl-fetch.js. This
// module owns only the panel body; the panel chrome (drag/resize/min/hide) is
// the agent-screen panel framework.
//
// Transport (per the wallet program's no-storm rule):
//   • Everyone polls POST /api/agents/balances every 30s — this is the source of
//     the 24h change + sparkline (the owner stream doesn't carry them).
//   • The owner additionally subscribes to the portfolio SSE for fresher net
//     worth + per-holding cost basis between polls; we merge it over the last
//     balances snapshot, preserving the real 24h curve.
// Polling pauses when the panel is hidden or the tab is backgrounded; the SSE is
// disposed on destroy. No fabricated values, ever.

import { fetchAgentBalance, subscribePortfolio } from './shared/pnl-fetch.js';
import {
	buildSparkline, formatUsd, formatSol, formatAmount, formatPnl,
	mergePortfolioOver, THREE_COIN_URL,
} from './shared/pnl-snapshot.js';

const POLL_MS = 30_000;
const MAX_ROWS = 6;

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

function prefersReducedMotion() {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {{ bodyEl: HTMLElement, agentId: string, network?: string,
 *           onNetWorth?: (snap)=>void }} cfg
 * @returns {{ start():void, destroy():void, setActive(active:boolean):void, refresh():void }}
 */
export function createPnlHud({ bodyEl, agentId, network = 'mainnet', onNetWorth }) {
	bodyEl.classList.add('asc-hud-body');
	bodyEl.innerHTML = shell();

	const els = {
		usd: bodyEl.querySelector('[data-hud-usd]'),
		sol: bodyEl.querySelector('[data-hud-sol]'),
		delta: bodyEl.querySelector('[data-hud-delta]'),
		stale: bodyEl.querySelector('[data-hud-stale]'),
		spark: bodyEl.querySelector('[data-hud-spark]'),
		sparkNote: bodyEl.querySelector('[data-hud-spark-note]'),
		rows: bodyEl.querySelector('[data-hud-rows]'),
		state: bodyEl.querySelector('[data-hud-state]'),
		live: bodyEl.querySelector('[data-hud-live]'),
	};

	let pollTimer = null;
	let unsubscribe = null;
	let destroyed = false;
	let active = true;          // panel visible
	let onVisibility = null;    // document visibilitychange listener (paused timer)
	let inflight = false;
	let lastBalances = null;    // last balances-derived snapshot (24h + sparkline)
	let lastUsd = null;         // for tick flash
	let everPriced = false;

	// ── render ────────────────────────────────────────────────────────────────
	function setPhase(phase) { bodyEl.dataset.phase = phase; }

	function renderLoading() {
		setPhase('loading');
		els.state.hidden = true;
		els.live.hidden = true;
	}

	function renderError() {
		setPhase('error');
		els.state.hidden = false;
		els.live.hidden = true;
		els.state.innerHTML =
			`<p class="asc-hud-msg">Couldn't value holdings.</p>` +
			`<button type="button" class="asc-hud-retry" data-hud-retry>Retry</button>`;
		els.state.querySelector('[data-hud-retry]')?.addEventListener('click', () => { renderLoading(); refresh(); });
	}

	function renderEmpty(snap) {
		setPhase('empty');
		els.state.hidden = false;
		els.live.hidden = true;
		const addr = snap?.address;
		els.state.innerHTML =
			`<p class="asc-hud-msg">No on-chain holdings yet.</p>` +
			`<p class="asc-hud-sub">${addr
				? 'Fund this wallet to start the scoreboard — value and 24h P&amp;L appear the moment it holds SOL or tokens.'
				: 'This agent has no wallet yet.'}</p>`;
	}

	function renderReady(snap) {
		setPhase('ready');
		everPriced = true;
		els.state.hidden = true;

		// Net worth + 24h delta.
		const usdText = formatUsd(snap.netWorthUsd, { compact: false });
		els.usd.textContent = usdText;
		els.usd.setAttribute('title', usdText);
		els.sol.textContent = formatSol(snap.netWorthSol);

		const d = formatPnl(snap.change24hPct);
		els.delta.dataset.tone = d.tone;
		const usd24 = snap.change24hUsd != null ? ` · ${formatUsd(snap.change24hUsd)}` : '';
		const win = snap.windowHours != null && snap.windowHours > 0
			? `${Math.round(snap.windowHours)}h` : '24h';
		els.delta.innerHTML = d.tone === 'none'
			? `<span class="asc-hud-delta-na" title="Not enough history yet to compute a change">— ${esc(win)}</span>`
			: `<span class="asc-hud-arrow">${d.arrow}</span>${esc(d.text)}<span class="asc-hud-delta-meta">${esc(usd24)} · ${esc(win)}</span>`;

		// Net-worth tick flash on a real change.
		if (lastUsd != null && snap.netWorthUsd != null && Math.abs(snap.netWorthUsd - lastUsd) > 1e-6 && !prefersReducedMotion()) {
			els.usd.classList.remove('tick-up', 'tick-down');
			void els.usd.offsetWidth;
			els.usd.classList.add(snap.netWorthUsd > lastUsd ? 'tick-up' : 'tick-down');
		}
		lastUsd = snap.netWorthUsd;

		drawSparkline(snap);
		renderRows(snap);
		onNetWorth?.(snap);
	}

	function drawSparkline(snap) {
		const canvas = els.spark;
		const tone = formatPnl(snap.change24hPct).tone;
		const css = getComputedStyle(canvas);
		const stroke = tone === 'down'
			? css.getPropertyValue('--danger').trim() || '#f87171'
			: tone === 'up'
				? css.getPropertyValue('--success').trim() || '#4ade80'
				: 'rgba(255,255,255,0.45)';

		const cssW = canvas.clientWidth || 220;
		const cssH = canvas.clientHeight || 48;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		const ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);

		const geo = buildSparkline(snap.sparkline, { width: cssW, height: cssH, pad: 4 });
		if (geo.empty) {
			els.sparkNote.hidden = false;
			els.sparkNote.textContent = 'Tracking starts now';
			ctx.strokeStyle = 'rgba(255,255,255,0.16)';
			ctx.setLineDash([3, 4]);
			ctx.beginPath();
			ctx.moveTo(4, cssH - 5);
			ctx.lineTo(cssW - 4, cssH - 5);
			ctx.stroke();
			ctx.setLineDash([]);
			return;
		}
		els.sparkNote.hidden = true;
		if (geo.single) {
			ctx.fillStyle = stroke;
			ctx.beginPath();
			ctx.arc(geo.last.x, geo.last.y, 2.4, 0, Math.PI * 2);
			ctx.fill();
			return;
		}
		// Area fill + line.
		ctx.beginPath();
		geo.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
		ctx.lineTo(geo.points[geo.points.length - 1].x, cssH);
		ctx.lineTo(geo.points[0].x, cssH);
		ctx.closePath();
		const grad = ctx.createLinearGradient(0, 0, 0, cssH);
		grad.addColorStop(0, hexA(stroke, 0.22));
		grad.addColorStop(1, hexA(stroke, 0));
		ctx.fillStyle = grad;
		ctx.fill();

		ctx.beginPath();
		geo.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
		ctx.strokeStyle = stroke;
		ctx.lineWidth = 1.5;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.stroke();

		ctx.fillStyle = stroke;
		ctx.beginPath();
		ctx.arc(geo.last.x, geo.last.y, 2, 0, Math.PI * 2);
		ctx.fill();
	}

	function renderRows(snap) {
		const rows = snap.holdings.slice(0, MAX_ROWS);
		if (!rows.length) {
			els.rows.innerHTML = `<div class="asc-hud-rows-empty">Holdings appear here once valued.</div>`;
			return;
		}
		const overflow = snap.holdingsTotal > rows.length ? snap.holdingsTotal - rows.length : 0;
		els.rows.innerHTML = rows.map((h) => rowHTML(h)).join('') +
			(overflow ? `<div class="asc-hud-more">+${overflow} more ${overflow === 1 ? 'holding' : 'holdings'}</div>` : '');
	}

	function rowHTML(h) {
		const sym = esc((h.symbol || '?').slice(0, 12));
		const val = formatUsd(h.valueUsd);
		const amt = h.amount != null ? formatAmount(h.amount) : '';
		const pct = h.pct != null ? `${h.pct}%` : '';
		// Owner-only per-holding unrealized P&L, when present.
		const up = h.unrealizedPct != null ? formatPnl(h.unrealizedPct) : null;
		const upTag = up && up.tone !== 'none'
			? `<span class="asc-hud-row-pnl" data-tone="${up.tone}" title="Unrealized P&amp;L vs cost basis">${esc(up.text)}</span>` : '';

		if (h.isThree) {
			// $THREE — pinned, featured, linked to its live 3D coin page. The only
			// holding that gets a featured chip; never a buy/recommend affordance.
			return (
				`<a class="asc-hud-row asc-hud-row--three" href="${esc(THREE_COIN_URL)}" title="View $THREE in 3D" target="_blank" rel="noopener">` +
				`<span class="asc-hud-row-sym"><span class="asc-hud-three-chip">★ $THREE</span></span>` +
				`<span class="asc-hud-row-amt">${esc(amt)}</span>` +
				`<span class="asc-hud-row-val">${esc(val)}${upTag}</span>` +
				`</a>`
			);
		}
		const logo = h.logo
			? `<img class="asc-hud-row-logo" src="${esc(h.logo)}" alt="" loading="lazy" data-fallback="hide">`
			: `<span class="asc-hud-row-logo asc-hud-row-logo--ph"></span>`;
		return (
			`<div class="asc-hud-row" title="${esc(sym)}${pct ? ` · ${pct} of net worth` : ''}">` +
			`<span class="asc-hud-row-sym">${logo}${sym}</span>` +
			`<span class="asc-hud-row-amt">${esc(amt)}</span>` +
			`<span class="asc-hud-row-val">${esc(val)}${upTag}</span>` +
			`</div>`
		);
	}

	function markStale(stale) {
		els.stale.hidden = !stale;
	}

	// ── data ────────────────────────────────────────────────────────────────
	async function refresh() {
		if (destroyed || inflight) return;
		inflight = true;
		try {
			const snap = await fetchAgentBalance(agentId, { network });
			if (destroyed) return;
			markStale(false);
			if (snap.priced) {
				lastBalances = snap;
				renderReady(snap);
				maybeStartOwnerStream(snap);
			} else if (everPriced && lastBalances) {
				// A transient miss after we've shown real data — keep the last good
				// value and flag it stale rather than blanking the scoreboard.
				markStale(true);
			} else {
				// Distinguish "no wallet/holdings" (empty) from a fetch error: an
				// un-priced snapshot with an address is an empty wallet.
				snap.address ? renderEmpty(snap) : renderError();
			}
		} catch {
			if (destroyed) return;
			if (everPriced) markStale(true);
			else renderError();
		} finally {
			inflight = false;
		}
	}

	function maybeStartOwnerStream(snap) {
		if (unsubscribe || !snap.isOwner) return;
		unsubscribe = subscribePortfolio(agentId, (live) => {
			if (destroyed || !live.priced) return;
			const merged = mergePortfolioOver(lastBalances, live);
			els.live.hidden = false;
			els.live.dataset.state = 'open';
			markStale(false);
			renderReady(merged);
		}, {
			network,
			onStatus: (s) => {
				if (destroyed) return;
				if (s === 'reconnecting') { els.live.hidden = false; els.live.dataset.state = 'reconnecting'; }
				else if (s === 'open') { els.live.hidden = false; els.live.dataset.state = 'open'; }
			},
		});
	}

	function syncPolling() {
		const shouldPoll = active && !destroyed && (typeof document === 'undefined' || document.visibilityState === 'visible');
		if (shouldPoll && !pollTimer) {
			pollTimer = setInterval(() => {
				if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
			}, POLL_MS);
		} else if (!shouldPoll && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// ── public ────────────────────────────────────────────────────────────────
	function start() {
		renderLoading();
		refresh();
		syncPolling();
		if (!onVisibility && typeof document !== 'undefined') {
			onVisibility = () => syncPolling();
			document.addEventListener('visibilitychange', onVisibility);
		}
	}
	function setActive(next) {
		active = !!next;
		syncPolling();
		if (active && everPriced) refresh(); // freshen on re-show
	}
	function destroy() {
		destroyed = true;
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
		if (unsubscribe) { unsubscribe(); unsubscribe = null; }
		if (onVisibility && typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibility);
			onVisibility = null;
		}
	}

	return { start, destroy, setActive, refresh };
}

// Translate a hex / rgb color to an rgba with the given alpha for the area fill.
function hexA(color, alpha) {
	const c = String(color).trim();
	if (c.startsWith('#')) {
		const h = c.slice(1);
		const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
		const n = parseInt(full.slice(0, 6), 16);
		if (Number.isFinite(n)) return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
	}
	const m = c.match(/rgba?\(([^)]+)\)/);
	if (m) {
		const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
		return `rgba(${r || 0},${g || 0},${b || 0},${alpha})`;
	}
	return `rgba(74,222,128,${alpha})`;
}

function shell() {
	return `
<div class="asc-hud" data-phase="loading">
	<div class="asc-hud-head">
		<div class="asc-hud-net">
			<div class="asc-hud-usd" data-hud-usd>—</div>
			<div class="asc-hud-sol" data-hud-sol>—</div>
		</div>
		<div class="asc-hud-aside">
			<div class="asc-hud-delta" data-hud-delta data-tone="none">—</div>
			<span class="asc-hud-stale" data-hud-stale hidden title="Showing the last good value — refreshing">stale</span>
			<span class="asc-hud-livedot" data-hud-live hidden data-state="open" title="Live owner feed"></span>
		</div>
	</div>
	<div class="asc-hud-spark-wrap">
		<canvas class="asc-hud-spark" data-hud-spark height="48"></canvas>
		<span class="asc-hud-spark-note" data-hud-spark-note hidden></span>
	</div>
	<div class="asc-hud-rows" data-hud-rows></div>
	<div class="asc-hud-state" data-hud-state hidden></div>
	<div class="asc-hud-skel" aria-hidden="true">
		<span class="asc-hud-skel-bar w60"></span>
		<span class="asc-hud-skel-bar w35"></span>
		<span class="asc-hud-skel-spark"></span>
		<span class="asc-hud-skel-bar w80"></span>
		<span class="asc-hud-skel-bar w70"></span>
	</div>
</div>`;
}
