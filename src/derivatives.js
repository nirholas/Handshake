// /derivatives — perpetual futures markets, part of the three.ws Markets
// surface. A sortable table of live perps across the major exchanges: price,
// 24h move, funding rate, open interest, and 24h volume, filterable by the
// underlying index. Real data via /api/coin/derivatives — never mocked. Mirrors
// the /coins market-table pattern (src/coins-index.js).

import { formatUsd, formatPrice, formatPercent, escapeHtml as esc } from './shared/coin-format.js';

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

// ── Header stat cards ─────────────────────────────────────────────────────────

const ICONS = {
	layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
	vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 9V6"/><path d="m14.5 10.5 2-2"/><path d="M15 12h3"/></svg>',
	bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
};

function statCard({ label, value, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function renderStats() {
	const el = $('dv-stats');
	if (!state.tickers.length) {
		el.innerHTML = '';
		return;
	}
	const totalOi = state.tickers.reduce((s, t) => s + (t.open_interest ?? 0), 0);
	const totalVol = state.tickers.reduce((s, t) => s + (t.volume_24h ?? 0), 0);
	const cards = [
		statCard({
			label: 'Perpetual Markets',
			value: state.tickers.length.toLocaleString('en-US'),
			icon: 'layers',
		}),
		statCard({ label: 'Total Open Interest', value: formatUsd(totalOi), icon: 'vault' }),
		statCard({ label: 'Total 24h Volume', value: formatUsd(totalVol), icon: 'bars' }),
	];
	el.innerHTML = `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${cards.join('')}</div>`;
}

// ── Index filter chips ────────────────────────────────────────────────────────

// Well-known indexes float to the front; the rest follow by market count.
const INDEX_PRIORITY = ['BTC', 'ETH', 'SOL'];
const MAX_CHIPS = 9;

function buildFilters() {
	const counts = new Map();
	for (const t of state.tickers) {
		if (!t.index_id) continue;
		counts.set(t.index_id, (counts.get(t.index_id) || 0) + 1);
	}
	const indexes = [...counts.keys()].sort((a, b) => {
		const pa = INDEX_PRIORITY.indexOf(a);
		const pb = INDEX_PRIORITY.indexOf(b);
		if (pa !== -1 || pb !== -1) {
			if (pa === -1) return 1;
			if (pb === -1) return -1;
			return pa - pb;
		}
		return counts.get(b) - counts.get(a);
	});
	state.indexes = indexes.slice(0, MAX_CHIPS);

	const el = $('dv-filters');
	if (state.indexes.length < 2) {
		el.hidden = true;
		return;
	}
	const chips = [{ id: 'all', label: 'All' }, ...state.indexes.map((id) => ({ id, label: id }))];
	el.innerHTML = chips
		.map(
			(c) =>
				`<button type="button" data-index="${esc(c.id)}" aria-pressed="${c.id === state.filter}">${esc(c.label)}</button>`,
		)
		.join('');
	el.hidden = false;
	el.querySelectorAll('button[data-index]').forEach((btn) => {
		btn.addEventListener('click', () => {
			state.filter = btn.dataset.index;
			el.querySelectorAll('button[data-index]').forEach((b) => {
				b.setAttribute('aria-pressed', b.dataset.index === state.filter ? 'true' : 'false');
			});
			renderTable();
		});
	});
}

// ── Table ─────────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'market', label: 'Market', left: true },
	{ key: 'symbol', label: 'Symbol', left: true, hide: 'hide-sm' },
	{ key: 'index_id', label: 'Index', left: true },
	{ key: 'price', label: 'Price', num: true },
	{ key: 'change_24h', label: '24h %', num: true },
	{ key: 'funding_rate', label: 'Funding', num: true },
	{ key: 'open_interest', label: 'Open Interest', hide: 'hide-md', num: true },
	{ key: 'volume_24h', label: 'Vol (24h)', num: true },
];

const state = {
	tickers: [],
	indexes: [],
	filter: 'all',
	sortKey: 'volume_24h',
	sortDir: 'desc',
};

function pctCell(v) {
	if (v == null) return '<td class="pct dim">—</td>';
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

// Funding rate from CoinGecko is already a percentage value — show 4 decimals.
function fundingCell(v) {
	if (v == null) return '<td class="pct dim">—</td>';
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'}">${v >= 0 ? '+' : ''}${esc(v.toFixed(4))}%</td>`;
}

function sortValue(t, key) {
	if (key === 'market' || key === 'symbol' || key === 'index_id') {
		return String(t[key] || '￿').toLowerCase(); // blanks sort last
	}
	return t[key] ?? -Infinity;
}

function filteredTickers() {
	if (state.filter === 'all') return state.tickers;
	return state.tickers.filter((t) => t.index_id === state.filter);
}

function sortedTickers() {
	const copy = filteredTickers();
	const { sortKey, sortDir } = state;
	const out = [...copy];
	out.sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return out;
}

function renderTable() {
	const el = $('dv-market');
	if (!state.tickers.length) {
		el.innerHTML =
			'<div class="cv-empty">Derivatives data is temporarily unavailable. Please try again shortly.</div>';
		return;
	}

	const rows = sortedTickers();
	if (!rows.length) {
		el.innerHTML = `<div class="cv-empty">No perpetual markets for ${esc(state.filter)}. <a href="#" id="dv-clear">Clear filter</a></div>`;
		$('dv-clear')?.addEventListener('click', (e) => {
			e.preventDefault();
			state.filter = 'all';
			buildFilters();
			renderTable();
		});
		return;
	}

	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const body = rows
		.map(
			(t) => `
			<tr>
				<td class="left name-cell"><span class="nm">${esc(t.market)}</span></td>
				<td class="left dim hide-sm cv-mono">${esc(t.symbol || '—')}</td>
				<td class="left">${t.index_id ? `<span class="dv-index">${esc(t.index_id)}</span>` : '<span class="dim">—</span>'}</td>
				<td class="price">${esc(formatPrice(t.price))}</td>
				${pctCell(t.change_24h)}
				${fundingCell(t.funding_rate)}
				<td class="dim hide-md">${esc(formatUsd(t.open_interest))}</td>
				<td class="dim">${esc(formatUsd(t.volume_24h))}</td>
			</tr>`,
		)
		.join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table dv-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;

	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === state.sortKey) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortKey = key;
				// Text columns default A→Z; numeric columns default high→low.
				state.sortDir =
					key === 'market' || key === 'symbol' || key === 'index_id' ? 'asc' : 'desc';
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
}

// ── Derivatives exchanges section ───────────────────────────────────────────
// A second table ranked by open interest, from /api/coin/derivatives?view=
// exchanges. Rows deep-link to the internal /exchange/:id profile (the detail
// endpoint's derivatives fallback serves these venues). The section container
// is injected here rather than living in the static HTML.

const exState = { exchanges: [], loading: true, error: false };

// BTC amount: 4 decimals below 1 BTC, whole otherwise; em dash for missing.
function formatBtc(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 0 });
}

function exSection() {
	let el = $('dv-exchanges');
	if (el) return el;
	el = document.createElement('section');
	el.id = 'dv-exchanges';
	el.className = 'cv-section';
	el.setAttribute('aria-label', 'Derivatives exchanges');
	const updated = $('dv-updated');
	const market = $('dv-market');
	// Sit between the perps table and the "updated" line.
	if (updated && updated.parentNode) updated.parentNode.insertBefore(el, updated);
	else if (market && market.parentNode) market.parentNode.appendChild(el);
	else document.querySelector('.cv-container')?.appendChild(el);
	return el;
}

const EX_COLUMNS = [
	{ label: 'Exchange', left: true },
	{ label: 'Open Interest BTC', num: true },
	{ label: '24h Vol BTC', num: true },
	{ label: 'Perps', num: true, hide: 'hide-sm' },
	{ label: 'Futures', num: true, hide: 'hide-sm' },
	{ label: 'Year', num: true, hide: 'hide-md' },
	{ label: 'Country', left: true, hide: 'hide-md' },
];

function renderExchanges() {
	const el = exSection();
	const heading = '<h2 class="cv-h2">Derivatives Exchanges</h2>';

	if (exState.loading) {
		el.innerHTML = `${heading}<div class="cv-table-wrap" style="padding:0.75rem">${Array.from(
			{ length: 6 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('')}</div>`;
		return;
	}
	if (exState.error) {
		el.innerHTML = `${heading}<div class="cv-empty">Derivatives exchange data is temporarily unavailable. Please try again shortly.</div>`;
		return;
	}
	if (!exState.exchanges.length) {
		el.innerHTML = `${heading}<div class="cv-empty">No derivatives exchanges to show right now.</div>`;
		return;
	}

	const head = EX_COLUMNS.map(
		(c) =>
			`<th scope="col" class="${c.left ? 'left' : ''} ${c.hide || ''}">${esc(c.label)}</th>`,
	).join('');

	const body = exState.exchanges
		.map((e) => {
			const rowAttrs = e.id
				? ` data-href="/exchange/${encodeURIComponent(e.id)}" tabindex="0" role="link" aria-label="Open ${esc(e.name)} exchange profile"`
				: '';
			return `
			<tr${rowAttrs}>
				<td class="left name-cell"><span class="inner">
					${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />` : ''}
					<span class="nm">${esc(e.name)}</span>
				</span></td>
				<td class="cv-mono">${esc(formatBtc(e.open_interest_btc))}</td>
				<td class="cv-mono">${esc(formatBtc(e.trade_volume_24h_btc))}</td>
				<td class="cv-mono hide-sm">${e.perpetual_pairs ?? '—'}</td>
				<td class="cv-mono hide-sm">${e.futures_pairs ?? '—'}</td>
				<td class="cv-mono hide-md">${e.year_established ?? '—'}</td>
				<td class="left dim hide-md">${esc(e.country || '—')}</td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		${heading}
		<div class="cv-table-wrap">
			<table class="cv-table dv-table dv-ex-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;

	// Whole row opens the internal /exchange/:id profile; keyboard-accessible.
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		const go = () => window.location.assign(tr.dataset.href);
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			go();
		});
		tr.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				go();
			}
		});
	});
}

async function loadExchanges() {
	exState.loading = true;
	exState.error = false;
	renderExchanges();
	try {
		const data = await getJson('/api/coin/derivatives?view=exchanges');
		exState.exchanges = Array.isArray(data.exchanges) ? data.exchanges : [];
		exState.loading = false;
	} catch {
		exState.loading = false;
		exState.error = true;
		exState.exchanges = [];
	}
	renderExchanges();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function renderSkeleton() {
	$('dv-stats').innerHTML =
		'<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6rem"></div>').join(
			'',
		) +
		'</div>';
	$('dv-market').innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>';
}

async function load() {
	renderSkeleton();
	try {
		const data = await getJson('/api/coin/derivatives');
		state.tickers = Array.isArray(data.tickers) ? data.tickers : [];
		$('dv-updated').textContent =
			`Updated ${new Date(data.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: CoinGecko`;
	} catch {
		state.tickers = [];
		$('dv-updated').textContent = '';
	}
	renderStats();
	buildFilters();
	renderTable();
	// The derivatives-exchanges table streams in independently of the perps.
	loadExchanges();
}

load();
