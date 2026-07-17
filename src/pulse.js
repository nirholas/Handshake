/**
 * /pulse — the Money Pulse: a real, platform-wide live feed of agent wallet
 * activity, plus aggregate money intelligence. Every row is a real, on-chain or
 * launch-record event served by GET /api/pulse — no synthetic events anywhere.
 *
 * Data flow:
 *   GET /api/pulse?view=stats&network=   headline counters + leaderboards
 *   GET /api/pulse?network=&type=        the live feed (via the shared component)
 *
 * The feed itself (live polling, offscreen pause, filters, sound, states) is the
 * shared src/shared/money-pulse.js component reused across the HUD and profiles.
 * This page wires the network toggle + the aggregate stats panel around it.
 */

import { mountMoneyPulse } from './shared/money-pulse.js';
import { wireWalletChips } from './shared/agent-wallet-chip.js';
import { createLogger } from './shared/log.js';
import { esc, fmtUsd, fmtSol, fmtNum, fmtThree, agentCardHTML, timeAgo } from './shared/pulse-format.js';
import { updateValue } from './ui-juice.js';

const log = createLogger('pulse');

const state = { network: 'mainnet', pulse: null, filter: 'all', lastUpdated: 0 };

const $ = (id) => document.getElementById(id);

// Map of data-filter values → the feed type string the component understands.
const FILTER_TO_TYPE = { all: 'all', tips: 'tips', launches: 'launches', trades: 'trades', payments: 'payments', purchases: 'purchases' };
// Label the active-filter chip to match the feed's own tab (which highlights
// "Purchases") and the 'purchase' beat kind, so clicking the Marketplace stat card
// doesn't show "Showing: Marketplace" while the Purchases tab is lit.
const FILTER_LABEL = { tips: 'Tips', launches: 'Launches', trades: 'Trades', payments: 'Payments', purchases: 'Purchases' };

function setFeedFilter(filter) {
	const f = FILTER_TO_TYPE[filter] || 'all';
	state.filter = f;
	state.pulse?.setType(f);

	// Highlight the active counter; un-highlight all others.
	for (const el of document.querySelectorAll('[data-filter]')) {
		el.classList.toggle('px-counter--active', el.dataset.filter === f);
	}

	// Show / hide the filter bar.
	const bar = $('px-filter-bar');
	const label = $('px-filter-label');
	if (bar && label) {
		if (f === 'all') {
			bar.hidden = true;
			label.textContent = '';
		} else {
			label.textContent = `Showing: ${FILTER_LABEL[f] || f}`;
			bar.hidden = false;
		}
	}

	// Scroll the feed into view smoothly on filter change.
	if (f !== 'all') $('px-feed')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// "Updated X ago" ticker — stamps time on each stats load, ticks every 15s.
function startUpdatedTick() {
	const el = $('px-updated');
	if (!el) return;
	function tick() {
		if (!state.lastUpdated) { el.textContent = ''; return; }
		const s = Math.round((Date.now() - state.lastUpdated) / 1000);
		if (s < 10) el.textContent = 'just now';
		else if (s < 60) el.textContent = `updated ${s}s ago`;
		else el.textContent = `updated ${Math.round(s / 60)}m ago`;
	}
	tick();
	setInterval(tick, 15_000);
}

async function loadStats() {
	const host = $('px-stats');
	try {
		const res = await fetch(`/api/pulse?view=stats&network=${state.network}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`stats ${res.status}`);
		const { data } = await res.json();
		renderStats(data);
		state.lastUpdated = Date.now();
		const updEl = $('px-updated');
		if (updEl) updEl.textContent = 'just now';
	} catch (e) {
		log.warn('stats failed', e?.message);
		// The stats panel is supplementary — degrade quietly, never block the feed.
		if (host) host.innerHTML = `<div class="px-stats-err">Money stats are reconnecting…</div>`;
	}
}

// Count a live counter from its previously-shown real value to the new one and
// flash the direction of change. The #px-c-* elements persist across the 60s stats
// refresh, so updateValue counts from the real prior value (never from 0).
const intFmt = (n) => String(Math.round(n));
function setCounter(id, value, format) {
	const el = $(id);
	if (!el) return;
	if (value == null || !Number.isFinite(value)) { el.textContent = '—'; delete el.dataset.juiceVal; return; }
	updateValue(el, value, format);
}

function renderStats(d) {
	// Headline counters.
	const vol = d.volume_24h || {};
	setCounter('px-c-vol', vol.usd > 0 ? vol.usd : (vol.sol || 0), vol.usd > 0 ? fmtUsd : fmtSol);
	$('px-c-vol-sub').textContent = vol.usd > 0 ? `${fmtSol(vol.sol)} on-chain` : 'on-chain flow';
	setCounter('px-c-tips', d.tips_24h?.count ?? 0, intFmt);
	$('px-c-tips-sub').textContent = `${fmtSol(d.tips_24h?.sol)} · ${fmtUsd(d.tips_24h?.usd)}`;
	setCounter('px-c-launches', d.launches_24h ?? 0, intFmt);
	setCounter('px-c-trades', d.trades_only_24h ?? 0, intFmt);
	$('px-c-trades-sub').textContent = (d.snipes_24h ?? 0) > 0 ? `+${d.snipes_24h} snipe${d.snipes_24h === 1 ? '' : 's'}` : 'swaps';
	setCounter('px-c-pays', d.payments_24h ?? 0, intFmt);
	const mkt = d.marketplace_24h || {};
	setCounter('px-c-market', mkt.purchases ?? 0, intFmt);
	$('px-c-market-sub').textContent = mkt.gmv_three > 0
		? `${fmtThree(mkt.gmv_three)} $THREE`
		: (mkt.trials > 0 ? `${mkt.trials} trial${mkt.trials === 1 ? '' : 's'}` : 'paid skill buys');
	setCounter('px-c-active', d.active_wallets_24h ?? 0, intFmt);

	renderSparkline(d.series_7d);
	renderBigTip(d.biggest_tip_24h);

	// Top earners (7d tips).
	const earners = $('px-earners');
	if (d.top_earners?.length) {
		earners.innerHTML = d.top_earners
			.map((a) => agentCardHTML(a, `${a.usd > 0 ? fmtUsd(a.usd) : fmtSol(a.sol)} <small>${a.tip_count} tip${a.tip_count === 1 ? '' : 's'}</small>`))
			.join('');
		wireWalletChips(earners);
	} else {
		earners.innerHTML = `<p class="px-lb-empty">No tips in the last 7 days. Be the first to back an agent.</p>`;
	}

	// Busiest wallets (24h events).
	const busy = $('px-busiest');
	if (d.busiest_wallets?.length) {
		busy.innerHTML = d.busiest_wallets
			.map((a) => agentCardHTML(a, `${a.events} <small>event${a.events === 1 ? '' : 's'}</small>`))
			.join('');
		wireWalletChips(busy);
	} else {
		busy.innerHTML = `<p class="px-lb-empty">No wallet activity in the last 24 hours yet.</p>`;
	}

	renderLaunches(d.recent_launches);
}

// 7-day activity sparkline. Bars scale to the busiest day; today is highlighted.
function renderSparkline(series) {
	const host = $('px-spark-bars');
	const totalEl = $('px-spark-total');
	if (!host) return;
	const days = Array.isArray(series) ? series : [];
	const total = days.reduce((s, d) => s + (d.events || 0) + (d.launches || 0), 0);
	if (totalEl) totalEl.textContent = `${fmtNum(total)} event${total === 1 ? '' : 's'}`;
	if (!days.length) { host.innerHTML = `<p class="px-lb-empty">No activity yet.</p>`; return; }
	const peak = Math.max(1, ...days.map((d) => (d.events || 0) + (d.launches || 0)));
	host.innerHTML = days
		.map((d, i) => {
			const n = (d.events || 0) + (d.launches || 0);
			const h = Math.max(4, Math.round((n / peak) * 100));
			const today = i === days.length - 1;
			return (
				`<div class="px-spark-col${today ? ' px-spark-col--now' : ''}" title="${esc(d.day)}: ${n} event${n === 1 ? '' : 's'}">` +
				`<div class="px-spark-bar" style="height:${h}%"></div>` +
				`<span class="px-spark-lbl">${esc(d.label)}</span>` +
				`</div>`
			);
		})
		.join('');
}

function renderBigTip(t) {
	const card = $('px-bigtip-card');
	const host = $('px-bigtip');
	if (!card || !host) return;
	if (!t || !t.agent) { card.hidden = true; return; }
	card.hidden = false;
	const metric = `${t.usd > 0 ? fmtUsd(t.usd) : fmtSol(t.sol)} <small>${esc(timeAgo(t.ts))}</small>`;
	host.innerHTML = agentCardHTML(t.agent, metric);
	wireWalletChips(host);
}

function renderLaunches(list) {
	const host = $('px-launches');
	if (!host) return;
	if (!list?.length) {
		host.innerHTML = `<p class="px-lb-empty">No coins launched yet. <a href="/launch">Launch one.</a></p>`;
		return;
	}
	host.innerHTML = list
		.map((c) => {
			const a = c.agent || {};
			const av = a.avatar_thumbnail_url
				? `<img class="px-lb-av" src="${esc(a.avatar_thumbnail_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
				: `<span class="px-lb-av px-lb-av--mono" aria-hidden="true">${esc((c.symbol || c.coin_name || '?').charAt(0).toUpperCase())}</span>`;
			const title = c.symbol ? `$${esc(c.symbol)}` : esc(c.coin_name || 'Coin');
			return (
				`<a class="px-lb-row" href="/oracle/coin/${esc(c.mint)}">` +
				av +
				`<span class="px-lb-name">${title}<small>by ${esc(a.name || 'agent')}</small></span>` +
				`<span class="px-lb-metric">${esc(timeAgo(c.ts))}</span>` +
				`</a>`
			);
		})
		.join('');
}

function mountFeed() {
	const host = $('px-feed');
	if (state.pulse) state.pulse.destroy();
	state.pulse = mountMoneyPulse({
		mount: host,
		variant: 'full',
		network: state.network,
		type: new URLSearchParams(location.search).get('type') || 'all',
		live: true,
		// When the feed's empty state offers "see live activity on mainnet", route it
		// through the page switch so the stat panels follow the feed in lockstep.
		onRequestNetwork: switchNetwork,
		// When an empty FILTER offers "view all activity", route it through the page so
		// the counter chips + filter bar reset in lockstep with the feed.
		onRequestType: setFeedFilter,
	});
}

// Switch the whole page (feed + stats panel) to a network. Reused by the toolbar
// toggle and the feed's self-healing empty-state CTA. No-op if unchanged.
function switchNetwork(net) {
	const target = net === 'devnet' ? 'devnet' : 'mainnet';
	if (target === state.network) return;
	state.network = target;
	for (const b of document.querySelectorAll('[data-network]')) {
		const on = b.dataset.network === target;
		b.classList.toggle('active', on);
		b.setAttribute('aria-selected', String(on));
	}
	const label = $('px-net-label');
	if (label) label.textContent = target;
	state.pulse?.setNetwork(target);
	loadStats();
}

function wireNetworkToggle() {
	for (const btn of document.querySelectorAll('[data-network]')) {
		btn.addEventListener('click', () => switchNetwork(btn.dataset.network));
	}
}

function wireCounterClicks() {
	for (const el of document.querySelectorAll('[data-filter]')) {
		el.addEventListener('click', () => setFeedFilter(el.dataset.filter));
		el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFeedFilter(el.dataset.filter); } });
	}
	$('px-filter-clear')?.addEventListener('click', () => setFeedFilter('all'));
}

function init() {
	wireNetworkToggle();
	wireCounterClicks();
	mountFeed();
	loadStats();
	startUpdatedTick();
	// Refresh stats on a slow cadence; the feed has its own live delta polling.
	setInterval(() => { if (!document.hidden) loadStats(); }, 60_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
