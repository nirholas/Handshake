// /defi — DeFi TVL & protocols. Header stat cards (total TVL, protocol count,
// top category), a category filter, and a sortable table of the top protocols
// by TVL. Data comes from /api/defi/protocols (DeFiLlama, keyless), normalized
// server-side. Mirrors the /coins markets-table pattern: stat cards, sortable
// cv-table, designed loading / empty / error states.

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

// ── Stat cards ────────────────────────────────────────────────────────────

const ICONS = {
	lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
	layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
	tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
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

function topCategory(protocols) {
	const byCat = new Map();
	for (const p of protocols) {
		if (!p.category) continue;
		byCat.set(p.category, (byCat.get(p.category) || 0) + (p.tvl || 0));
	}
	let best = null;
	for (const [cat, tvl] of byCat) {
		if (!best || tvl > best.tvl) best = { cat, tvl };
	}
	return best;
}

function renderStats() {
	const el = $('defi-stats');
	const { total_tvl, protocol_count, protocols } = state;
	const top = topCategory(protocols);
	const cards = [
		statCard({ label: 'Total DeFi TVL', value: formatUsd(total_tvl), icon: 'lock' }),
		statCard({
			label: 'Protocols Tracked',
			value: protocol_count.toLocaleString('en-US'),
			icon: 'layers',
		}),
	];
	if (top) {
		cards.push(
			statCard({
				label: 'Top Category',
				value: top.cat,
				delta: formatUsd(top.tvl),
				icon: 'tag',
			}),
		);
	}
	el.innerHTML = `<div class="defi-stat-grid">${cards.join('')}</div>`;
}

function statsSkeleton() {
	$('defi-stats').innerHTML =
		'<div class="defi-stat-grid">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6rem"></div>').join(
			'',
		) +
		'</div>';
}

// ── Category filter ───────────────────────────────────────────────────────

function populateCategories() {
	const sel = $('defi-category');
	if (!sel) return;
	const byCat = new Map();
	for (const p of state.protocols) {
		if (!p.category) continue;
		byCat.set(p.category, (byCat.get(p.category) || 0) + (p.tvl || 0));
	}
	const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
	sel.innerHTML =
		'<option value="__all">All categories</option>' +
		cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
	sel.value = state.category;
	sel.addEventListener('change', () => {
		state.category = sel.value;
		renderTable();
	});
}

// ── Table ─────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Protocol', left: true },
	{ key: 'category', label: 'Category', left: true, hide: 'hide-md' },
	{ key: 'chains', label: 'Chains', left: true, hide: 'hide-lg' },
	{ key: 'tvl', label: 'TVL', num: true },
	{ key: 'change_1d', label: '1d %', num: true },
	{ key: 'change_7d', label: '7d %', hide: 'hide-md', num: true },
];

const state = {
	protocols: [],
	total_tvl: 0,
	protocol_count: 0,
	updated_at: 0,
	sortKey: 'tvl',
	sortDir: 'desc',
	category: '__all',
	loading: true,
	error: false,
};

function pctCell(v, extraClass = '') {
	if (v == null) return `<td class="pct dim ${extraClass}">—</td>`;
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'} ${extraClass}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

function chainsCell(chains) {
	if (!chains || !chains.length) return '<td class="left dim hide-lg">—</td>';
	const shown = chains
		.slice(0, 3)
		.map((c) => esc(c))
		.join(', ');
	const extra = chains.length > 3 ? ` <span class="defi-more">+${chains.length - 3}</span>` : '';
	return `<td class="left dim hide-lg defi-chains">${shown}${extra}</td>`;
}

function sortValue(p, key) {
	if (key === 'name') return (p.name || '').toLowerCase();
	if (key === 'category') return (p.category || '').toLowerCase();
	if (key === 'chains') return p.chain_count ?? 0;
	if (key === 'rank') return p.__rank ?? Infinity;
	return p[key] ?? -Infinity;
}

function visibleProtocols() {
	let rows =
		state.category === '__all'
			? state.protocols
			: state.protocols.filter((p) => p.category === state.category);
	// Rank is by TVL across the filtered set, independent of the active sort.
	rows = [...rows].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
	rows.forEach((p, i) => (p.__rank = i + 1));

	const { sortKey, sortDir } = state;
	const sorted = [...rows].sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return sorted;
}

function renderTable() {
	const el = $('defi-table');

	if (state.loading) {
		el.innerHTML =
			'<div class="cv-table-wrap" style="padding:0.75rem">' +
			Array.from(
				{ length: 12 },
				() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
			).join('') +
			'</div>';
		return;
	}
	if (state.error) {
		el.innerHTML =
			'<div class="cv-empty">DeFi data is temporarily unavailable. <a href="/defi">Try again</a> shortly.</div>';
		return;
	}

	const rows = visibleProtocols();
	if (!rows.length) {
		el.innerHTML = `<div class="cv-empty">No protocols in “${esc(state.category)}”. <button type="button" class="defi-reset">Show all categories</button></div>`;
		el.querySelector('.defi-reset')?.addEventListener('click', () => {
			state.category = '__all';
			const sel = $('defi-category');
			if (sel) sel.value = '__all';
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
		.map((p) => {
			// Whole row opens the internal /protocol/:slug detail page when we have
			// a DeFiLlama slug; keyboard-accessible.
			const nav = p.slug
				? ` data-href="/protocol/${encodeURIComponent(p.slug)}" tabindex="0" role="link" aria-label="Open ${esc(p.name)} protocol detail"`
				: '';
			return `
			<tr${nav}>
				<td class="rank hide-sm cv-mono">${p.__rank}</td>
				<td class="left name-cell"><span class="inner">
					${p.logo ? `<img src="${esc(p.logo)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />` : '<span class="defi-logo-fallback" aria-hidden="true"></span>'}
					<span class="nm">${esc(p.name)}</span>
					${p.symbol ? `<span class="sym">${esc(p.symbol)}</span>` : ''}
				</span></td>
				<td class="left dim hide-md">${p.category ? esc(p.category) : '—'}</td>
				${chainsCell(p.chains)}
				<td class="price">${esc(formatUsd(p.tvl))}</td>
				${pctCell(p.change_1d)}
				${pctCell(p.change_7d, 'hide-md')}
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
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
				state.sortDir = key === 'name' || key === 'category' ? 'asc' : 'desc';
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

	// Row → /protocol/:slug navigation (header clicks sort, never navigate).
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		const go = () => location.assign(tr.dataset.href);
		tr.addEventListener('click', go);
		tr.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				go();
			}
		});
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function load() {
	statsSkeleton();
	renderTable();
	try {
		const data = await getJson('/api/defi/protocols');
		state.protocols = Array.isArray(data.protocols) ? data.protocols : [];
		state.total_tvl = data.total_tvl || 0;
		state.protocol_count = data.protocol_count || state.protocols.length;
		state.updated_at = data.updated_at || Date.now();
		state.loading = false;
		state.error = false;
		renderStats();
		populateCategories();
		renderTable();
		$('defi-updated').textContent =
			`Top ${state.protocols.length} protocols by TVL · Data: DeFiLlama · updated ${new Date(state.updated_at).toLocaleTimeString('en-US')}`;
	} catch {
		state.loading = false;
		state.error = true;
		$('defi-stats').innerHTML = '';
		renderTable();
	}
}

load();
