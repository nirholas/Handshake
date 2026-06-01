/**
 * KOL / smart-money trades widget.
 *
 * Polls GET /api/kol/trades?mint=…&limit=… every `refreshMs` and renders a
 * table of buy/sell events from tracked wallets.
 *
 * Exported functions:
 *   renderTrades(trades)           — pure, returns HTML string (testable in node)
 *   mountKolTradesWidget(root, opts) — full mount with polling + cleanup
 *
 * The <three-ws-widget type="kol-trades" mint="…"> custom element is registered
 * at the bottom of this file when running in a browser. That same element also
 * dispatches type="bonding-curve" to the bonding-curve runtime.
 */

import { mountBondingCurve } from './bonding-curve.js';

const SOURCE_BADGE = {
	kol: { label: 'KOL', color: '#ffffff' },
	whale: { label: 'Whale', color: '#60a5fa' },
	'smart-money': { label: 'Smart $', color: '#34d399' },
};

const STYLES = `
.kol-trades {
	font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
	color: #e5e5e5;
	padding: 0.75rem 0;
}
.kol-trades-head {
	font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase;
	color: rgba(255,255,255,0.45); margin-bottom: 0.5rem; padding: 0 0.5rem;
}
.kol-trades-row {
	display: grid;
	grid-template-columns: 3.5rem 2.5rem 1fr 4rem 4rem;
	align-items: center; gap: 0.4rem;
	padding: 0.3rem 0.5rem; border-radius: 6px;
	transition: background 0.1s;
}
.kol-trades-row:hover { background: rgba(255,255,255,0.04); }
.kol-trades-time { font-size: 0.7rem; color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums; }
.kol-trades-side { font-size: 0.75rem; font-weight: 600; }
.kol-trades-wallet {
	font-family: ui-monospace, monospace; font-size: 0.72rem;
	color: rgba(180,210,255,0.75); text-decoration: none; overflow: hidden; text-overflow: ellipsis;
}
.kol-trades-wallet:hover { color: rgba(180,210,255,1); text-decoration: underline; }
.kol-trades-usd { font-size: 0.78rem; text-align: right; font-variant-numeric: tabular-nums; }
.kol-trades-tag {
	font-size: 0.65rem; font-weight: 600; letter-spacing: 0.04em;
	text-align: right; text-transform: uppercase;
}
.kol-trades-empty {
	text-align: center; padding: 1.5rem 0.5rem;
	color: rgba(255,255,255,0.4); font-size: 0.82rem;
}
`;

let _stylesInjected = false;
function injectStyles(doc) {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const tag = doc.createElement('style');
	tag.textContent = STYLES;
	doc.head.appendChild(tag);
}

function shortAddr(s, n = 4) {
	if (!s || s.length < n * 2 + 1) return s || '';
	return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function timeAgo(iso) {
	if (!iso) return '';
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

function fmtUsd(n) {
	if (n == null) return '—';
	const v = Number(n);
	if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
	return `$${v.toFixed(2)}`;
}

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

function rowHtml(trade) {
	const side = trade.side === 'buy' ? 'buy' : 'sell';
	const sideColor = side === 'buy' ? '#34d399' : '#f87171';
	const sideLabel = side === 'buy' ? 'Buy' : 'Sell';
	const solscanUrl = `https://solscan.io/account/${escHtml(trade.wallet)}`;
	const badge = SOURCE_BADGE[trade.source] || SOURCE_BADGE['smart-money'];
	return `<div class="kol-trades-row">
		<span class="kol-trades-time">${escHtml(timeAgo(trade.time))}</span>
		<span class="kol-trades-side" style="color:${sideColor}">${sideLabel}</span>
		<a class="kol-trades-wallet" href="${solscanUrl}" target="_blank" rel="noopener noreferrer">${escHtml(shortAddr(trade.wallet))}</a>
		<span class="kol-trades-usd">${escHtml(fmtUsd(trade.usd))}</span>
		<span class="kol-trades-tag" style="color:${badge.color}">${escHtml(badge.label)}</span>
	</div>`;
}

/** Pure renderer — returns an HTML string. Exported for unit testing. */
export function renderTrades(trades) {
	if (!trades || trades.length === 0) {
		return '<div class="kol-trades-empty">No smart-money activity yet for this token.</div>';
	}
	return `<div class="kol-trades-head">Smart Money</div>${trades.map(rowHtml).join('')}`;
}

/**
 * Mount the KOL trades widget inside `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {{ mint?: string, limit?: number, refreshMs?: number }} opts
 * @returns {{ destroy(): void }}
 */
export function mountKolTradesWidget(rootEl, opts = {}) {
	const mint = opts.mint || '';
	const limit = Number(opts.limit ?? 20);
	const refreshMs = Number(opts.refreshMs ?? 30_000);

	const doc = rootEl.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
	if (!doc) return { destroy() {} };

	injectStyles(doc);

	const container = doc.createElement('div');
	container.className = 'kol-trades';
	rootEl.appendChild(container);

	let timer = null;
	let destroyed = false;

	async function poll() {
		if (destroyed) return;
		if (!mint) {
			container.innerHTML = renderTrades([]);
			return;
		}
		try {
			const resp = await fetch(
				`/api/kol/trades?mint=${encodeURIComponent(mint)}&limit=${limit}`,
			);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			if (!destroyed) container.innerHTML = renderTrades(data.trades ?? []);
		} catch {
			// silent — no unhandled rejection on unmount / network failure
		}
	}

	poll();
	timer = setInterval(poll, refreshMs);

	return {
		destroy() {
			destroyed = true;
			if (timer) clearInterval(timer);
			container.remove();
		},
	};
}

// ---------------------------------------------------------------------------
// Standalone custom element — registered when running in a browser.
// ---------------------------------------------------------------------------
if (typeof customElements !== 'undefined' && !customElements.get('three-ws-widget')) {
	customElements.define(
		'three-ws-widget',
		class ThreeWsWidget extends HTMLElement {
			static get observedAttributes() {
				return ['type', 'mint', 'limit', 'refresh-ms', 'network', 'show-usd', 'accent'];
			}

			connectedCallback() {
				this._mount();
			}

			disconnectedCallback() {
				this._ctrl?.destroy();
				this._ctrl = null;
			}

			attributeChangedCallback() {
				if (this.isConnected) {
					this._ctrl?.destroy();
					this._ctrl = null;
					this._mount();
				}
			}

			_mount() {
				const type = this.getAttribute('type');
				if (type === 'kol-trades') {
					this._ctrl = mountKolTradesWidget(this, {
						mint: this.getAttribute('mint') || '',
						limit: Number(this.getAttribute('limit') || '20'),
						refreshMs: Number(this.getAttribute('refresh-ms') || '30000'),
					});
				} else if (type === 'bonding-curve') {
					this._ctrl = mountBondingCurve(this, {
						mint: this.getAttribute('mint') || '',
						network: this.getAttribute('network') || 'mainnet',
						refreshMs: Number(this.getAttribute('refresh-ms') || '15000'),
						showUsd: this.getAttribute('show-usd') !== 'false',
						accent: this.getAttribute('accent') || '',
					});
				}
			}
		},
	);
}
