// /categories — crypto sector leaderboard, styled after the /coins markets
// index: a couple of summary stat cards up top, then a sortable table of every
// CoinGecko category ranked by market cap with its top-3 coin icons, 24h move,
// and 24h volume. Consumes /api/coin/categories.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';

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

// ── Summary stat cards ────────────────────────────────────────────────────────

const ICONS = {
	grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
	trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
	bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
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

function renderStats() {
	const el = $('cat-stats');
	const cats = state.categories;
	if (!cats.length) {
		el.innerHTML = '';
		return;
	}
	// Categories overlap (a coin sits in many), so a summed market cap would
	// double-count. The largest category is the honest headline number instead.
	const top = cats.reduce(
		(best, c) => ((c.market_cap ?? 0) > (best.market_cap ?? 0) ? c : best),
		cats[0],
	);
	const gainers = cats.filter((c) => (c.market_cap_change_24h ?? 0) > 0).length;
	const cards = [
		statCard({
			label: 'Categories Tracked',
			value: cats.length.toLocaleString('en-US'),
			icon: 'grid',
		}),
		statCard({
			label: 'Largest Category',
			value: top.name,
			delta: formatUsd(top.market_cap),
			icon: 'bars',
		}),
		statCard({
			label: 'Advancing (24h)',
			value: `${gainers} / ${cats.length}`,
			delta: `${cats.length - gainers} declining`,
			deltaClass: gainers >= cats.length - gainers ? 'cv-up' : 'cv-down',
			icon: 'trend',
		}),
	];
	el.innerHTML = `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${cards.join('')}</div>`;
}

// ── Category table ────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Category', left: true },
	{ key: 'market_cap', label: 'Market Cap', num: true },
	{ key: 'market_cap_change_24h', label: '24h %', num: true },
	{ key: 'volume_24h', label: 'Volume (24h)', hide: 'hide-md', num: true },
];

const state = { categories: [], sortKey: 'rank', sortDir: 'asc' };

function pctCell(v) {
	if (v == null) return '<td class="pct dim">—</td>';
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

function avatarStack(coins) {
	if (!coins || !coins.length) return '';
	const imgs = coins
		.map(
			(u) =>
				`<img src="${esc(u)}" alt="" loading="lazy" width="22" height="22" data-no-dark-filter />`,
		)
		.join('');
	return `<span class="cat-avatars" aria-hidden="true">${imgs}</span>`;
}

function sortValue(c, key) {
	if (key === 'name') return (c.name || '').toLowerCase();
	if (key === 'rank') return c.rank ?? Infinity;
	return c[key] ?? -Infinity;
}

function sortedCategories() {
	const copy = [...state.categories];
	const { sortKey, sortDir } = state;
	copy.sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return copy;
}

function renderTable() {
	const el = $('cat-table');
	if (!state.categories.length) {
		el.innerHTML =
			'<div class="cv-empty">Category data is temporarily unavailable. Please try again shortly.</div>';
		return;
	}

	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const rows = sortedCategories()
		.map((c) => {
			const href = `/category/${encodeURIComponent(c.id)}`;
			return `
			<tr data-href="${esc(href)}">
				<td class="rank hide-sm cv-mono">${c.rank ?? '—'}</td>
				<td class="left name-cell"><a href="${esc(href)}"><span class="inner">
					${avatarStack(c.top_3_coins)}
					<span class="nm">${esc(c.name)}</span>
				</span></a></td>
				<td class="dim">${esc(formatUsd(c.market_cap))}</td>
				${pctCell(c.market_cap_change_24h)}
				<td class="dim hide-md">${esc(formatUsd(c.volume_24h))}</td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;

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

	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			location.href = tr.dataset.href;
		});
	});
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadCategories() {
	const el = $('cat-table');
	el.innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>';
	try {
		const { categories } = await getJson('/api/coin/categories');
		// The endpoint returns market-cap-desc order; that ordinal is the rank.
		state.categories = (categories || []).map((c, i) => ({ ...c, rank: i + 1 }));
		$('cat-updated').textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
	} catch {
		state.categories = [];
		$('cat-updated').textContent = '';
	}
	renderStats();
	renderTable();
}

loadCategories();
