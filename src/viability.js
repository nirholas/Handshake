/**
 * /viability: the honest signal behind three.ws. Two real money loops measured
 * without vanity: the skill marketplace (real $THREE GMV, take-rate, repeat
 * buyers, trading pairs) and agent trading (real guarded coin-trade flow, cost
 * and realized P&L on closed positions). Every figure is served by GET /api/pulse
 * from real on-chain and launch-record data, with no synthetic activity anywhere.
 *
 * The panels themselves live in shared/viability-panels.js, which owns their
 * loading, ready and error states. This module wires the network toggle, the
 * per-panel Retry actions, the "updated X ago" ticker, and the slow refresh.
 */

import { loadMarketplace, loadTrading } from './shared/viability-panels.js';

const state = { network: 'mainnet', lastUpdated: 0, status: 'loading' };
const $ = (id) => document.getElementById(id);

// The "updated" stamp tracks the last time a panel actually rendered live
// figures. A read in flight says so, and a failed read never claims freshness:
// with no good read yet it reports the failure, and with an older one it dates
// that read instead of pretending the numbers on screen are current.
function ago(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 3600)}h`;
}

function renderUpdated() {
	const el = $('px-updated');
	if (!el) return;
	if (state.status === 'loading' && !state.lastUpdated) { el.textContent = 'reading live data'; return; }
	if (!state.lastUpdated) { el.textContent = 'live read failed'; return; }
	const since = Date.now() - state.lastUpdated;
	if (state.status === 'failed') { el.textContent = `last good read ${ago(since)} ago`; return; }
	el.textContent = since < 10_000 ? 'just now' : `updated ${ago(since)} ago`;
}

async function loadAll() {
	state.status = 'loading';
	renderUpdated();
	const results = await Promise.all([loadMarketplace(state.network), loadTrading(state.network)]);
	const ok = results.some(Boolean);
	if (ok) state.lastUpdated = Date.now();
	state.status = results.every(Boolean) ? 'ok' : 'failed';
	renderUpdated();
}

// Switch every panel to a network. No-op if unchanged.
function switchNetwork(net) {
	const target = net === 'devnet' ? 'devnet' : 'mainnet';
	if (target === state.network) return;
	state.network = target;
	for (const b of document.querySelectorAll('[data-network]')) {
		const on = b.dataset.network === target;
		b.classList.toggle('active', on);
		b.setAttribute('aria-pressed', String(on));
	}
	const label = $('px-net-label');
	if (label) label.textContent = target;
	loadAll();
}

function wireNetworkToggle() {
	for (const btn of document.querySelectorAll('[data-network]')) {
		btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
	}
}

// A failed panel offers a Retry that re-runs only its own read, so a working
// panel is never thrown away to recover a broken one.
function wireRetries() {
	for (const btn of document.querySelectorAll('[data-retry]')) {
		btn.addEventListener('click', async () => {
			const load = btn.dataset.retry === 'trading' ? loadTrading : loadMarketplace;
			btn.disabled = true;
			try {
				if (await load(state.network)) { state.lastUpdated = Date.now(); state.status = 'ok'; }
				renderUpdated();
			} finally {
				btn.disabled = false;
			}
		});
	}
}

function init() {
	wireNetworkToggle();
	wireRetries();
	loadAll();
	setInterval(renderUpdated, 15_000);
	// Slow refresh while the tab is visible: these are aggregates, not a live feed.
	setInterval(() => { if (!document.hidden) loadAll(); }, 60_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
