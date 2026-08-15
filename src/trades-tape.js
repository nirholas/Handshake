/**
 * Live trade tape for a single coin.
 *
 * Two real sources, no fabrication:
 *   • Seed/fallback — GET /api/pump/dex-trades (GeckoTerminal, covers graduated
 *     coins like $THREE that the bonding-curve WS never sees).
 *   • Realtime — SSE /api/pump/trades-stream?mint (PumpPortal, covers coins
 *     still on the curve). Each event prepends a row.
 *
 * Whichever source has data wins; both can run at once and the tape de-dupes by
 * signature. A coin that is fully graduated simply shows the dex seed and the
 * stream stays quiet — that is honest, not broken.
 */

import { createSseClient } from './mission-control/realtime.js';
import { shortAddr } from './trader-format.js';

const MAX_ROWS = 60;

function fmtAmt(sol) {
	const n = Number(sol);
	if (!Number.isFinite(n)) return '—';
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	if (n >= 1) return n.toFixed(2);
	return n.toFixed(3);
}
function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return '';
	if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
	return `$${v.toFixed(0)}`;
}
function ago(tsSec) {
	const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(tsSec || 0));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

function normalize(t) {
	const sig = t.signature || t.tx_signature || t.txHash || null;
	const isBuy = t.is_buy ?? (t.txType === 'buy' || t.tx_type === 'buy');
	return {
		sig,
		isBuy: Boolean(isBuy),
		sol: Number(t.sol_amount ?? t.solAmount),
		usd: Number(t.sol_value_usd),
		trader: t.trader || t.owner || t.user || null,
		ts: Number(t.timestamp) || Math.floor(Date.now() / 1000),
	};
}

function rowHtml(t) {
	const side = t.isBuy ? 'buy' : 'sell';
	const usd = fmtUsd(t.usd);
	const traderCell = t.trader
		? `<a href="https://solscan.io/account/${t.trader}" target="_blank" rel="noopener" class="tp-trader">${shortAddr(t.trader, 4, 4)}</a>`
		: '<span class="tp-trader tp-trader--anon">—</span>';
	return `<div class="tp-row tp-${side}" data-sig="${t.sig || ''}">
		<span class="tp-side">${t.isBuy ? 'BUY' : 'SELL'}</span>
		<span class="tp-amt">${fmtAmt(t.sol)} ◎</span>
		<span class="tp-usd">${usd}</span>
		${traderCell}
		<span class="tp-time">${ago(t.ts)}</span>
	</div>`;
}

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {string} opts.mint
 * @returns {{ destroy(): void }}
 */
export function mountTradeTape(host, opts = {}) {
	const mint = String(opts.mint || '').trim();
	host.innerHTML = `
		<div class="tp-head">
			<span class="tp-live" data-state="off"><span class="tp-live-dot"></span>live tape</span>
			<span class="tp-cols"><span>SIDE</span><span>SOL</span><span>USD</span><span>TRADER</span><span>AGE</span></span>
		</div>
		<div class="tp-body" data-host="rows"><div class="tp-msg">Loading recent trades…</div></div>`;

	const rowsEl = host.querySelector('[data-host="rows"]');
	const liveEl = host.querySelector('.tp-live');

	const seen = new Set();
	const rows = [];
	let destroyed = false;
	let sse = null;
	let ageTimer = null;
	// Set when the server tells us the upstream refused the live trade
	// subscription. The seeded dex rows stay valid, so we keep them and only
	// correct the claim that the tape is streaming.
	let streamDegraded = false;

	function render() {
		if (!rows.length) {
			rowsEl.innerHTML = streamDegraded
				? '<div class="tp-msg">Live trades are unavailable for this coin right now. Showing settled trades only.</div>'
				: '<div class="tp-msg">No recent trades on this venue.</div>';
			return;
		}
		rowsEl.innerHTML = rows.map(rowHtml).join('');
	}

	function add(raw, { prepend = true } = {}) {
		const t = normalize(raw);
		if (t.sig && seen.has(t.sig)) return false;
		if (t.sig) seen.add(t.sig);
		if (!Number.isFinite(t.sol)) return false;
		if (prepend) rows.unshift(t); else rows.push(t);
		if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
		return true;
	}

	async function seed() {
		try {
			const r = await fetch(`/api/pump/dex-trades?mint=${encodeURIComponent(mint)}&limit=40`, {
				headers: { accept: 'application/json' },
			});
			if (!r.ok) throw new Error(String(r.status));
			const data = await r.json();
			const list = Array.isArray(data?.trades) ? data.trades : [];
			// newest first
			list.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
			for (const t of list) add(t, { prepend: false });
		} catch {
			/* dex venue may not exist (pre-graduation) — the stream covers it */
		}
		if (!destroyed) render();
	}

	function startStream() {
		sse = createSseClient({
			url: `/api/pump/trades-stream?mint=${encodeURIComponent(mint)}`,
			events: {
				trade: (d) => {
					if (destroyed || !d || d.mint !== mint) return;
					if (add(d, { prepend: true })) render();
				},
				// The socket is up but the upstream refused the trade subscription,
				// so no trade will ever arrive on it. Say so instead of showing a
				// lit "live" lamp above a tape that can only ever stay still.
				notice: () => {
					if (destroyed) return;
					streamDegraded = true;
					liveEl.dataset.state = 'off';
					liveEl.title = 'Live trade stream unavailable (settled trades only)';
					render();
				},
				close: () => {},
			},
			onState: (state) => {
				if (streamDegraded) return;
				liveEl.dataset.state = state === 'live' ? 'on' : 'off';
			},
		});
		sse.start();
	}

	// Re-render the relative ages every 5s so the tape feels alive even when quiet.
	ageTimer = setInterval(() => { if (!destroyed && rows.length) render(); }, 5_000);

	seed();
	startStream();

	return {
		destroy() {
			destroyed = true;
			clearInterval(ageTimer);
			try { sse?.stop(); } catch { /* already stopped */ }
			host.innerHTML = '';
		},
	};
}
