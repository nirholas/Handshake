// /categories: crypto sector leaderboard, styled after the /coins markets
// index. A couple of summary stat cards up top, then a searchable, sortable
// table of every CoinGecko category ranked by market cap with its top-3 coin
// icons, 24h move, and 24h volume. Consumes /api/coin/categories.
//
// The upstream returns ~750 categories. Rendering all of them at once meant
// ~2,250 lazy <img> nodes on first paint, so the table pages in PAGE_SIZE rows
// at a time and the search box narrows the set before you ever need to page.

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

const statsGrid = (inner) =>
	`<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${inner}</div>`;

// The cards land in the same beat as the table rows, so they get the same
// skeleton treatment rather than popping in from an empty strip.
function statSkeletons() {
	return statsGrid(
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6.25rem"></div>').join(''),
	);
}

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
		el.innerHTML = state.status === 'loading' ? statSkeletons() : '';
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
	el.innerHTML = statsGrid(cards.join(''));
}

// ── Category table ────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Category', left: true },
	{ key: 'market_cap', label: 'Market Cap', num: true },
	{ key: 'market_cap_change_24h', label: '24h %', num: true },
	{ key: 'volume_24h', label: 'Volume (24h)', hide: 'hide-md', num: true },
];

const PAGE_SIZE = 50;

const state = {
	categories: [],
	sortKey: 'rank',
	sortDir: 'asc',
	query: '',
	shown: PAGE_SIZE,
	status: 'loading', // loading | ready | error
};

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

function matchesQuery(c, q) {
	return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
}

function visibleCategories() {
	const q = state.query.trim().toLowerCase();
	const copy = q ? state.categories.filter((c) => matchesQuery(c, q)) : [...state.categories];
	const { sortKey, sortDir } = state;
	copy.sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return copy;
}

function skeletonRows() {
	return (
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>'
	);
}

// The three no-rows outcomes are different problems and get different copy:
// a failed fetch is retryable here, an upstream that returned nothing is not
// the user's doing, and a search that matched nothing is fixed by clearing it.
function renderPlaceholder(el) {
	if (state.status === 'loading') {
		el.innerHTML = skeletonRows();
		return true;
	}
	if (state.status === 'error') {
		el.innerHTML =
			'<div class="cv-empty">Category data could not be loaded. The market data provider did not answer. <button type="button" class="cv-linkbtn" data-act="retry">Try again</button>.</div>';
		return true;
	}
	if (!state.categories.length) {
		el.innerHTML =
			'<div class="cv-empty">No categories are being reported right now. <button type="button" class="cv-linkbtn" data-act="retry">Refresh</button> to check again.</div>';
		return true;
	}
	return false;
}

function renderTable() {
	const el = $('cat-table');
	if (renderPlaceholder(el)) {
		bindActions(el);
		return;
	}

	const matches = visibleCategories();
	if (!matches.length) {
		el.innerHTML = `<div class="cv-empty">No category matches “${esc(state.query.trim())}”. <button type="button" class="cv-linkbtn" data-act="clear">Clear the search</button> to see all ${state.categories.length.toLocaleString('en-US')}.</div>`;
		bindActions(el);
		return;
	}

	const page = matches.slice(0, state.shown);
	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		const sort = active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
		return `<th scope="col" tabindex="0" data-key="${col.key}" aria-sort="${sort}" class="${col.left ? 'left' : ''} ${col.hide || ''}">${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const rows = page
		.map((c) => {
			const href = `/category/${encodeURIComponent(c.id)}`;
			return `
			<tr data-href="${esc(href)}">
				<td class="rank hide-sm cv-mono">${c.rank ?? '—'}</td>
				<td class="left name-cell"><a href="${esc(href)}"><span class="inner">
					${avatarStack(c.top_3_coins)}
					<span class="nm" title="${esc(c.name)}">${esc(c.name)}</span>
				</span></a></td>
				<td class="dim">${esc(formatUsd(c.market_cap))}</td>
				${pctCell(c.market_cap_change_24h)}
				<td class="dim hide-md">${esc(formatUsd(c.volume_24h))}</td>
			</tr>`;
		})
		.join('');

	const remaining = matches.length - page.length;
	const more = remaining
		? `<button type="button" class="cv-load-more" data-act="more">Show ${Math.min(PAGE_SIZE, remaining).toLocaleString('en-US')} more (${remaining.toLocaleString('en-US')} left)</button>`
		: '';

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<caption class="sr-only">Crypto categories ranked by market cap, showing ${page.length} of ${matches.length}</caption>
				<thead><tr>${head}</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
		${more}`;

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
			// The header this came from is a fresh node after the re-render, so
			// keyboard users would otherwise be dropped back to the document.
			$('cat-table')?.querySelector(`th[data-key="${key}"]`)?.focus();
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

	bindActions(el);
	renderCount(matches.length);
}

function bindActions(el) {
	el.querySelector('[data-act="retry"]')?.addEventListener('click', () => loadCategories());
	el.querySelector('[data-act="clear"]')?.addEventListener('click', () => {
		const input = $('cat-search-input');
		if (input) input.value = '';
		setQuery('');
		input?.focus();
	});
	el.querySelector('[data-act="more"]')?.addEventListener('click', () => {
		state.shown += PAGE_SIZE;
		renderTable();
		// Land focus on the first newly revealed row so the keyboard path
		// continues where the button was instead of at the top of the table.
		$('cat-table')
			?.querySelectorAll('tbody tr')
			[state.shown - PAGE_SIZE]?.querySelector('a')
			?.focus();
	});
}

// ── Search ────────────────────────────────────────────────────────────────────

function renderCount(shownTotal) {
	const el = $('cat-count');
	if (!el) return;
	const total = state.categories.length;
	const visible = Math.min(state.shown, shownTotal);
	el.textContent = state.query.trim()
		? `${shownTotal.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} categories match`
		: `Showing ${visible.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} categories`;
}

function setQuery(value) {
	state.query = value;
	state.shown = PAGE_SIZE;
	renderTable();
	if (!visibleCategories().length) renderCount(0);
}

function wireSearch() {
	const input = $('cat-search-input');
	if (!input) return;
	let timer = 0;
	input.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(() => setQuery(input.value), 120);
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && input.value) {
			e.preventDefault();
			input.value = '';
			setQuery('');
		}
	});
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadCategories() {
	state.status = 'loading';
	state.shown = PAGE_SIZE;
	$('cat-updated').textContent = '';
	renderStats();
	renderTable();
	try {
		const { categories } = await getJson('/api/coin/categories');
		// The endpoint returns market-cap-desc order; that ordinal is the rank.
		state.categories = (categories || []).map((c, i) => ({ ...c, rank: i + 1 }));
		state.status = 'ready';
		$('cat-updated').textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
	} catch {
		state.categories = [];
		state.status = 'error';
		$('cat-updated').textContent = '';
	}
	const search = $('cat-search');
	if (search) search.hidden = state.status !== 'ready' || !state.categories.length;
	renderStats();
	renderTable();
	if (state.status !== 'ready' || !state.categories.length) {
		const count = $('cat-count');
		if (count) count.textContent = '';
	}
}

wireSearch();
loadCategories();
