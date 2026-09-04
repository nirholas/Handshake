// /defi — DeFi TVL & protocols. Header stat cards (total TVL, protocol count,
// top category), a category filter, and a sortable table of the top protocols
// by TVL. Data comes from /api/defi/protocols (DeFiLlama, keyless), normalized
// server-side. Mirrors the /coins markets-table pattern: stat cards, sortable
// cv-table, designed loading / empty / error states.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { upstreamLogoURL, swapFailedLogos } from './shared/upstream-logo.js';

const $ = (id) => document.getElementById(id);

// A press that travels further than this is a drag, not a click on a row.
const DRAG_SLOP_PX = 6;

// True while the visitor is holding a text selection, so row-click navigation
// can stand down and let them copy.
function isSelecting() {
	const sel = typeof getSelection === 'function' ? getSelection() : null;
	return !!sel && !sel.isCollapsed && String(sel).trim().length > 0;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	const body = await res.json();
	// The API flags a payload it served from its last-good copy after an
	// upstream failure. Carry it through so the page can say the figures are
	// cached rather than present them as live.
	return { body, stale: res.headers.get('x-three-stale') === '1' };
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
	// A refresh can return data that no longer carries the category the visitor
	// picked. Keep it in the list rather than silently dropping their filter to
	// a blank select that disagrees with the empty table below it; the empty
	// state's "Show all categories" is the way back out.
	if (state.category !== '__all' && !cats.includes(state.category)) cats.push(state.category);
	sel.innerHTML =
		'<option value="__all">All categories</option>' +
		cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
	sel.value = state.category;
	// A retry re-enters load() and repopulates these options; bind the listener
	// once so a second run does not stack a duplicate handler on the select.
	if (!sel.dataset.wired) {
		sel.dataset.wired = '1';
		sel.addEventListener('change', () => {
			state.category = sel.value;
			renderTable();
		});
	}
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
	stale: false,
};

// Upstream logos are proxied same-origin so a retired icon answers 204 instead
// of 404ing in every reader's console; the swap above turns that empty image
// into the neutral disc.
function logoImg(logo) {
	const src = logo ? upstreamLogoURL(logo, 24) : '';
	return src
		? `<img class="defi-logo" src="${esc(src)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />`
		: '<span class="defi-logo-fallback" aria-hidden="true"></span>';
}

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
			'<div class="cv-empty">DeFi TVL data is temporarily unavailable. The upstream provider did not answer. <button type="button" class="cv-linkbtn" data-act="retry">Try again</button>.</div>';
		el.querySelector('[data-act="retry"]')?.addEventListener('click', () => load());
		return;
	}
	// An upstream that answers with nothing is a different state from a category
	// the visitor narrowed down to zero rows, and each needs its own way out.
	if (!state.protocols.length) {
		el.innerHTML =
			'<div class="cv-empty">No protocol TVL is being reported right now. <button type="button" class="cv-linkbtn" data-act="retry">Refresh</button> to check again.</div>';
		el.querySelector('[data-act="retry"]')?.addEventListener('click', () => load());
		return;
	}

	const rows = visibleProtocols();
	if (!rows.length) {
		el.innerHTML = `<div class="cv-empty">No protocols in “${esc(state.category)}”. <button type="button" class="cv-linkbtn" data-act="reset">Show all categories</button></div>`;
		el.querySelector('[data-act="reset"]')?.addEventListener('click', () => {
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
		const sort = active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
		return `<th scope="col" tabindex="0" data-key="${col.key}" aria-sort="${sort}" class="${col.left ? 'left' : ''} ${col.hide || ''}">${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const body = rows
		.map((p) => {
			// The protocol name is a real anchor, so /protocol/:slug is crawlable,
			// middle-clickable, and reachable by keyboard as a link. The row keeps
			// data-href purely as a click convenience, which is why the <tr> stays
			// a plain table row instead of claiming role="link" and putting all
			// hundred rows in the tab order.
			const href = p.slug ? `/protocol/${encodeURIComponent(p.slug)}` : '';
			const inner = `<span class="inner">
					${logoImg(p.logo)}
					<span class="nm">${esc(p.name)}</span>
					${p.symbol ? `<span class="sym">${esc(p.symbol)}</span>` : ''}
				</span>`;
			return `
			<tr${href ? ` data-href="${esc(href)}"` : ''}>
				<td class="rank hide-sm cv-mono">${p.__rank}</td>
				<td class="left name-cell">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</td>
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

	// A protocol icon the CDN has retired arrives empty (204 through the proxy);
	// paint the same neutral disc a logo-less row already gets.
	swapFailedLogos(el, '.defi-logo', 'defi-logo-fallback');

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
			// The header this came from is a fresh node after the re-render, so
			// keyboard users would otherwise be dropped back to the document.
			$('defi-table')?.querySelector(`th[data-key="${key}"]`)?.focus();
		};
		th.addEventListener('click', activate);
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			}
		});
	});

	// Clicking anywhere in the row follows the name cell's link. The anchor
	// handles its own click (and the whole keyboard path), so bail out on it
	// rather than navigating twice.
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		// Where the press started, so a drag that merely ends inside the row is
		// not mistaken for a click on it.
		let downX = 0;
		let downY = 0;
		tr.addEventListener('pointerdown', (e) => {
			downX = e.clientX;
			downY = e.clientY;
		});
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			// Copying a TVL figure or a protocol name means dragging across a
			// cell, and that drag ends in a click on the row. Navigating would
			// throw the selection away before the visitor can copy it.
			if (isSelecting()) return;
			if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP_PX) return;
			location.assign(tr.dataset.href);
		});
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function load() {
	// A retry re-enters here from the error state, so reset to loading before
	// painting or the skeleton would be replaced by the stale error message.
	state.loading = true;
	state.error = false;
	statsSkeleton();
	renderTable();
	try {
		const { body: data, stale } = await getJson('/api/defi/protocols');
		state.protocols = Array.isArray(data.protocols) ? data.protocols : [];
		state.total_tvl = data.total_tvl || 0;
		state.protocol_count = data.protocol_count || state.protocols.length;
		state.updated_at = data.updated_at || Date.now();
		state.stale = stale;
		state.loading = false;
		state.error = false;
		populateCategories();
		// An empty payload has no totals worth showing: a "$0.00" card would read
		// as a claim that DeFi TVL is zero rather than as missing data.
		if (state.protocols.length) {
			renderStats();
			const when = new Date(state.updated_at).toLocaleTimeString('en-US');
			$('defi-updated').textContent = state.stale
				? `Top ${state.protocols.length} protocols by TVL · Data: DeFiLlama · cached copy from ${when}, upstream is not answering`
				: `Top ${state.protocols.length} protocols by TVL · Data: DeFiLlama · updated ${when}`;
		} else {
			$('defi-stats').innerHTML = '';
			$('defi-updated').textContent = '';
		}
		renderTable();
	} catch {
		state.loading = false;
		state.error = true;
		state.protocols = [];
		state.stale = false;
		$('defi-stats').innerHTML = '';
		$('defi-updated').textContent = 'Data: DeFiLlama';
		renderTable();
	}
}

load();
