// /coins — markets index, adopted from the cryptocurrency.cv markets page:
// global stats bar (market cap, volume, dominance, Fear & Greed, active coins),
// a sortable top-coins table with 7d sparklines, a search type-ahead, and
// load-more pagination. Every row links to the rich /coin/:id detail page.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { coinRow, COIN_COLUMNS, coinSortValue } from './shared/market-table.js';
import { onPageReady } from './shell/page-lifecycle.js';

const $ = (id) => document.getElementById(id);

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── Global stats bar ────────────────────────────────────────────────────────

const ICONS = {
	trend:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
	bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
	pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
	coins:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
	gauge:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
	activity:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
};

function statCard({ label, value, delta, deltaClass, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
				${delta ? `<p class="delta ${deltaClass || ''}">${esc(delta)}</p>` : ''}
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

// Fear & Greed tone thresholds mirror the source design.
function fgClass(v) {
	if (v == null) return '';
	if (v <= 25) return 'cv-down';
	if (v <= 55) return '';
	return 'cv-up';
}

async function loadStats() {
	const el = $('cv-stats');
	el.innerHTML =
		'<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
		Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:6rem"></div>').join('') +
		'</div>';
	try {
		const { market, fear_greed } = await getJson('/api/coin/global');
		const cards = [];
		if (market) {
			cards.push(
				statCard({
					label: 'Total Market Cap',
					value: formatUsd(market.market_cap_usd),
					delta:
						market.market_cap_change_pct_24h != null
							? formatPercent(market.market_cap_change_pct_24h)
							: null,
					deltaClass: (market.market_cap_change_pct_24h ?? 0) >= 0 ? 'cv-up' : 'cv-down',
					icon: 'trend',
				}),
				statCard({ label: '24h Volume', value: formatUsd(market.volume_24h_usd), icon: 'bars' }),
			);
			for (const [i, d] of (market.dominance || []).entries()) {
				cards.push(
					statCard({
						label: `${d.symbol} Dominance`,
						value: `${d.pct.toFixed(1)}%`,
						icon: i === 0 ? 'pie' : 'coins',
					}),
				);
			}
		}
		if (fear_greed) {
			cards.push(
				statCard({
					label: 'Fear & Greed',
					value: String(fear_greed.value),
					delta: fear_greed.label || null,
					deltaClass: fgClass(fear_greed.value),
					icon: 'gauge',
				}),
			);
		}
		if (market?.active_coins != null) {
			cards.push(
				statCard({
					label: 'Active Coins',
					value: market.active_coins.toLocaleString('en-US'),
					icon: 'activity',
				}),
			);
		}
		el.innerHTML = cards.length
			? `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${cards.join('')}</div>`
			: '';
	} catch {
		el.innerHTML = ''; // Stats bar is an enhancement — the table is the page.
	}
}

// ── Market table ────────────────────────────────────────────────────────────
// Row/column/sort primitives are shared with the /markets hub — see
// src/shared/market-table.js.

const state = { coins: [], sortKey: 'rank', sortDir: 'asc', page: 1, loadingMore: false };

function sortedCoins() {
	const copy = [...state.coins];
	const { sortKey, sortDir } = state;
	copy.sort((a, b) => {
		const va = coinSortValue(a, sortKey);
		const vb = coinSortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return copy;
}

function renderTable() {
	const el = $('cv-market');
	if (!el) return; // shell navigation left /coins while a fetch was in flight
	if (!state.coins.length) {
		el.innerHTML =
			'<div class="cv-empty">Market data is temporarily unavailable. Please try again shortly.</div>';
		return;
	}

	const head = COIN_COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const rows = sortedCoins().map(coinRow).join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${head}<th class="hide-xl" aria-hidden="true">7d Chart</th></tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
		<button type="button" class="cv-load-more" id="cv-load-more"${state.loadingMore ? ' disabled' : ''}>
			${state.loadingMore ? 'Loading…' : 'Load more coins'}
		</button>`;

	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === state.sortKey) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortKey = key;
				state.sortDir = key === 'name' || key === 'rank' ? 'asc' : 'desc';
			}
			renderTable();
		};
		th.addEventListener('click', activate);
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			}
		});
	});

	// Whole row navigates; the name link inside stays a real anchor for
	// middle-click / keyboard users.
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			location.href = tr.dataset.href;
		});
	});

	$('cv-load-more')?.addEventListener('click', loadMore);
}

async function loadCoins() {
	const el = $('cv-market');
	el.innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from({ length: 12 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('') +
		'</div>';
	try {
		const { coins } = await getJson('/api/coin/markets?page=1&per_page=100');
		state.coins = coins;
		state.page = 1;
	} catch {
		state.coins = [];
	}
	renderTable();
}

async function loadMore() {
	if (state.loadingMore) return;
	state.loadingMore = true;
	renderTable();
	try {
		const { coins } = await getJson(`/api/coin/markets?page=${state.page + 1}&per_page=100`);
		const seen = new Set(state.coins.map((c) => c.id));
		state.coins.push(...coins.filter((c) => !seen.has(c.id)));
		state.page += 1;
	} catch {
		// keep what we have; button re-enables for a retry
	}
	state.loadingMore = false;
	renderTable();
}

// ── Search type-ahead ───────────────────────────────────────────────────────

function wireSearch() {
	const input = $('cv-search-input');
	const pop = $('cv-search-pop');
	if (!input || !pop) return;
	let timer = null;
	let items = [];
	let active = -1;
	let lastQuery = '';

	function close() {
		pop.hidden = true;
		input.setAttribute('aria-expanded', 'false');
		active = -1;
	}

	function renderPop() {
		if (!items.length) {
			pop.innerHTML = `<div class="none">No coins match “${esc(lastQuery)}”.</div>`;
		} else {
			pop.innerHTML = items
				.map(
					(c, i) => `
				<a href="/coin/${encodeURIComponent(c.id)}" role="option" data-active="${i === active ? 1 : 0}" aria-selected="${i === active}">
					${c.thumb ? `<img src="${esc(c.thumb)}" alt="" width="20" height="20" data-no-dark-filter />` : ''}
					<span>${esc(c.name)}</span>
					<span class="sym">${esc(c.symbol)}</span>
					${c.rank != null ? `<span class="rk">#${c.rank}</span>` : ''}
				</a>`,
				)
				.join('');
		}
		pop.hidden = false;
		input.setAttribute('aria-expanded', 'true');
	}

	input.addEventListener('input', () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) {
			close();
			return;
		}
		timer = setTimeout(async () => {
			try {
				const { coins } = await getJson(`/api/coin/markets?q=${encodeURIComponent(q)}`);
				lastQuery = q;
				items = coins;
				active = -1;
				renderPop();
			} catch {
				close();
			}
		}, 250);
	});

	input.addEventListener('keydown', (e) => {
		if (pop.hidden) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + dir + items.length) % Math.max(items.length, 1);
			renderPop();
		} else if (e.key === 'Enter' && active >= 0 && items[active]) {
			e.preventDefault();
			location.href = `/coin/${encodeURIComponent(items[active].id)}`;
		} else if (e.key === 'Escape') {
			close();
		}
	});

	document.addEventListener('click', (e) => {
		if (!e.target.closest('#cv-search')) close();
	});
}

// ── Liquidations pulse strip ────────────────────────────────────────────────
// Real-time long/short liquidation pain across Binance, Bybit, and OKX
// futures, fed by /api/coin/liquidations (proxying the standalone
// services/liquidation-collector). Optional enrichment: an offline collector
// degrades to a quiet single line, never fabricated numbers.

const LIQ_POLL_MS = 30_000;
const LIQ_1H_MS = 60 * 60 * 1000;
let liqTimer = null;
let liqLoaded = false;
let lastLiqData = null; // last successful payload, re-rendered once state.coins loads (see loadCoins().then below) so symbol→id links resolve even when liquidations loads faster than the markets table.

// Resolve a liquidation's ticker symbol to a /coin/:id detail page — only for
// symbols present in the currently loaded markets table (state.coins), per
// the page's design: we don't guess at an id the table hasn't confirmed.
function resolveCoinId(symbol) {
	const hit = state.coins.find((c) => (c.symbol || '').toUpperCase() === symbol);
	return hit ? hit.id : null;
}

function liqBadgeClass(side) {
	if (side === 'LONG PAIN') return 'pain';
	if (side === 'SHORT SQUEEZE') return 'squeeze';
	return 'balanced';
}

function renderLiqSkeleton() {
	const el = $('cv-liq');
	if (!el) return;
	el.innerHTML =
		'<div class="cv-liq-skel">' +
		'<div class="cv-skel" style="height:1.5rem;width:8rem;border-radius:999px"></div>' +
		'<div class="cv-skel" style="height:2.5rem;flex:1;max-width:280px"></div>' +
		'<div class="cv-skel" style="height:1.75rem;flex:2"></div>' +
		'</div>';
}

function renderLiqOffline() {
	const el = $('cv-liq');
	if (!el) return;
	el.innerHTML =
		'<p class="cv-liq-offline" role="status"><span class="dot" aria-hidden="true"></span>Liquidation feed offline — showing the rest of the markets page as usual.</p>';
}

function renderLiqPopulated(data) {
	const el = $('cv-liq');
	if (!el) return;
	const { summary, liquidations } = data;
	const recent = Array.isArray(liquidations) ? liquidations : [];

	// 1h long vs short liquidated USD, derived from the real recent-liquidations
	// list (already timestamped) rather than the collector's 4h window total.
	const cutoff1h = Date.now() - LIQ_1H_MS;
	let long1h = 0;
	let short1h = 0;
	for (const l of recent) {
		if (l.time < cutoff1h) continue;
		if (l.side === 'LONG') long1h += l.value;
		else if (l.side === 'SHORT') short1h += l.value;
	}
	const maxBar = Math.max(long1h, short1h, 1);

	const top3 = [...recent].sort((a, b) => b.value - a.value).slice(0, 3);

	const badge = summary?.dominantSide || 'BALANCED';
	const badgeCls = liqBadgeClass(badge);

	const bars = `
		<div class="cv-liq-bars">
			<div class="cv-liq-bar-row">
				<span class="lbl">1h Long</span>
				<span class="cv-liq-bar-track"><span class="cv-liq-bar-fill long" style="width:${((long1h / maxBar) * 100).toFixed(1)}%"></span></span>
				<span class="amt cv-mono">${esc(formatUsd(long1h))}</span>
			</div>
			<div class="cv-liq-bar-row">
				<span class="lbl">1h Short</span>
				<span class="cv-liq-bar-track"><span class="cv-liq-bar-fill short" style="width:${((short1h / maxBar) * 100).toFixed(1)}%"></span></span>
				<span class="amt cv-mono">${esc(formatUsd(short1h))}</span>
			</div>
		</div>`;

	const items = top3.length
		? top3
				.map((l) => {
					const sideCls = l.side === 'LONG' ? 'long' : 'short';
					const inner = `
						<span class="sym">${esc(l.symbol)}</span>
						<span class="side ${sideCls}">${esc(l.side)}</span>
						<span class="bucket">${esc(l.severity)}</span>
						<span class="usd">${esc(formatUsd(l.value))}</span>`;
					const id = resolveCoinId(l.symbol);
					return id
						? `<a class="cv-liq-item" href="/coin/${encodeURIComponent(id)}">${inner}</a>`
						: `<span class="cv-liq-item">${inner}</span>`;
				})
				.join('')
		: '<span class="cv-liq-item" style="color:var(--cv-text-3)">No liquidations in the last 4h — quiet market.</span>';

	el.innerHTML = `
		<span class="cv-liq-badge ${badgeCls}">${esc(badge)}</span>
		${bars}
		<div class="cv-liq-top" aria-label="Largest recent liquidations">${items}</div>`;
}

async function pollLiquidations() {
	if (document.hidden) return;
	try {
		const data = await getJson('/api/coin/liquidations');
		lastLiqData = data;
		renderLiqPopulated(data);
	} catch {
		// 503 collector_offline (or any other failure) → quiet offline line, never
		// fabricated numbers. First load shows the offline state; subsequent polls
		// that fail after a populated render just leave the last-good data up.
		if (!liqLoaded) renderLiqOffline();
	} finally {
		liqLoaded = true;
	}
}

function scheduleLiquidations() {
	clearInterval(liqTimer);
	liqTimer = setInterval(pollLiquidations, LIQ_POLL_MS);
}

function loadLiquidations(signal) {
	if (!$('cv-liq')) return;
	renderLiqSkeleton();
	pollLiquidations();
	scheduleLiquidations();
	// A shell navigation away from /coins aborts the signal — stop polling a
	// strip that no longer exists instead of hitting the API from other pages.
	signal?.addEventListener('abort', () => clearInterval(liqTimer));
	document.addEventListener(
		'visibilitychange',
		() => {
			if (!document.hidden) pollLiquidations();
		},
		{ signal },
	);
}

// ── Boot ────────────────────────────────────────────────────────────────────
// /coins is a persistent-shell page (<html data-shell> in pages/coins.html):
// the module loads once and re-initializes on every shell navigation here.

onPageReady(
	({ signal }) => {
		loadStats();
		// If the liquidations strip's first poll lands before the markets table finishes
		// loading, its top-3 items resolve no symbol→id links yet (state.coins is still
		// empty). Re-render with the same data once the table is in so those items pick
		// up their /coin/:id links without waiting for the next 30s poll.
		loadCoins().then(() => {
			if (lastLiqData) renderLiqPopulated(lastLiqData);
		});
		loadLiquidations(signal);
		wireSearch();
	},
	{ match: (p) => p.replace(/\/$/, '') === '/coins' },
);
