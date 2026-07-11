// /stablecoins — stablecoin market-cap board, part of the three.ws Markets
// surface. Header stat cards (total mcap, count, top dominance), a peg-mechanism
// filter, and a sortable table of the top 100 stablecoins by circulating supply.
// Each row shows peg health (price colored by deviation from its $1.00 peg),
// market cap, dominance share, mechanism, and the chains it lives on. Data is the
// free, keyless DeFiLlama stablecoins API via /api/defi/stablecoins.

import { formatUsd, formatPrice, escapeHtml as esc } from './shared/coin-format.js';

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

// ── Stat cards ────────────────────────────────────────────────────────────────

const ICONS = {
	trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
	coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
	pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
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

// ── Peg-mechanism display ──────────────────────────────────────────────────────

// DeFiLlama's raw mechanism tokens → { css class, human label }. Unknown tokens
// keep their raw value, title-cased, under a neutral "other" class.
const MECHANISMS = {
	'fiat-backed': { cls: 'fiat', label: 'Fiat-backed' },
	'crypto-backed': { cls: 'crypto', label: 'Crypto-backed' },
	algorithmic: { cls: 'algo', label: 'Algorithmic' },
};

// DeFiLlama ships a small number of records with a misspelled mechanism token
// ("crytpo-backed"). Fold known typos into their canonical value so the filter
// and chips don't split one mechanism across two look-alike entries.
const MECH_ALIASES = { 'crytpo-backed': 'crypto-backed' };

function normalizeMechanism(raw) {
	if (typeof raw !== 'string') return raw;
	return MECH_ALIASES[raw] || raw;
}

function titleCase(s) {
	return String(s || '')
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function mechanism(raw) {
	if (!raw) return { cls: 'other', label: 'Unknown' };
	return MECHANISMS[raw] || { cls: 'other', label: titleCase(raw) };
}

// ── Peg health ─────────────────────────────────────────────────────────────────

// Peg health is only meaningful against a known target. USD-pegged assets peg to
// $1.00, so deviation = |price − 1|. Within 0.5% reads healthy (green); beyond
// reads off-peg (red). Non-USD pegs (peggedEUR, peggedGBP, …) have no $1 target
// available here, so they render neutral rather than being falsely flagged.
function pegHealth(price, pegType) {
	if (price == null || !Number.isFinite(price)) return { cls: '', dev: null };
	if (pegType && pegType !== 'peggedUSD') return { cls: '', dev: null };
	const dev = price - 1;
	return { cls: Math.abs(dev) <= 0.005 ? 'on' : 'off', dev };
}

function priceCell(c) {
	const { cls, dev } = pegHealth(c.price, c.peg_type);
	const toneClass = cls === 'on' ? 'cv-up' : cls === 'off' ? 'cv-down' : 'dim';
	const price = esc(formatPrice(c.price));
	// Only surface a deviation badge when the asset is measurably off its peg —
	// that's the signal worth drawing the eye to.
	const badge =
		cls === 'off' && dev != null
			? `<span class="sc-depeg">${dev >= 0 ? '+' : '−'}${(Math.abs(dev) * 100).toFixed(1)}%</span>`
			: '';
	return `<td class="price cv-mono ${toneClass}">${price}${badge}</td>`;
}

// ── Table ───────────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Stablecoin', left: true },
	{ key: 'price', label: 'Price · Peg', num: true },
	{ key: 'circulating_usd', label: 'Market Cap', num: true },
	{ key: 'dominance', label: 'Dominance', hide: 'hide-md', num: true },
	{ key: 'peg_mechanism', label: 'Mechanism', hide: 'hide-lg', left: true },
	{ key: 'chain_count', label: 'Chains', hide: 'hide-lg', left: true },
];

const state = {
	all: [],
	total: 0,
	updatedAt: null,
	filter: 'all',
	sortKey: 'rank',
	sortDir: 'asc',
};

function dominance(c) {
	return state.total > 0 ? (c.circulating_usd / state.total) * 100 : 0;
}

function chainsCell(c) {
	const chains = Array.isArray(c.chains) ? c.chains : [];
	if (!chains.length) return '<td class="hide-lg left dim">—</td>';
	const shown = chains.slice(0, 3).map((n) => `<span class="sc-chain">${esc(n)}</span>`);
	const extra = chains.length - 3;
	if (extra > 0) shown.push(`<span class="sc-chain more">+${extra}</span>`);
	return `<td class="hide-lg left"><span class="sc-chains">${shown.join('')}</span></td>`;
}

function sortValue(c, key) {
	if (key === 'name') return (c.name || '').toLowerCase();
	if (key === 'rank') return c._rank ?? Infinity;
	if (key === 'dominance') return dominance(c);
	if (key === 'peg_mechanism') return mechanism(c.peg_mechanism).label.toLowerCase();
	return c[key] ?? 0;
}

function visibleRows() {
	let rows = state.all;
	if (state.filter !== 'all') rows = rows.filter((c) => (c.peg_mechanism || '') === state.filter);
	const { sortKey, sortDir } = state;
	const copy = [...rows];
	copy.sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return copy;
}

function renderTable() {
	const el = $('sc-table');
	const rows = visibleRows();

	if (!state.all.length) {
		el.innerHTML =
			'<div class="cv-empty">Stablecoin data is temporarily unavailable. Please <a href="/stablecoins">try again</a> shortly.</div>';
		return;
	}
	if (!rows.length) {
		el.innerHTML = `<div class="cv-empty">No stablecoins match this filter. <a href="#" data-reset="1">Show all</a>.</div>`;
		el.querySelector('[data-reset]')?.addEventListener('click', (e) => {
			e.preventDefault();
			setFilter('all');
		});
		return;
	}

	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const body = rows
		.map((c) => {
			const m = mechanism(c.peg_mechanism);
			// Whole row opens the internal /stablecoin/:id detail page when we
			// have DeFiLlama's numeric id; keyboard-accessible.
			const nav = c.id
				? ` data-href="/stablecoin/${encodeURIComponent(c.id)}" tabindex="0" role="link" aria-label="Open ${esc(c.name)} detail page"`
				: '';
			return `
			<tr${nav}>
				<td class="rank hide-sm cv-mono">${c._rank ?? '—'}</td>
				<td class="left name-cell"><span class="inner">
					<span class="nm">${esc(c.name)}</span>
					<span class="sym">${esc(c.symbol)}</span>
				</span></td>
				${priceCell(c)}
				<td class="cv-mono">${esc(formatUsd(c.circulating_usd))}</td>
				<td class="cv-mono hide-md dim">${dominance(c).toFixed(2)}%</td>
				<td class="left hide-lg"><span class="cv-chip sc-mech ${m.cls}">${esc(m.label)}</span></td>
				${chainsCell(c)}
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
				state.sortDir =
					key === 'name' || key === 'rank' || key === 'peg_mechanism' ? 'asc' : 'desc';
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

	// Row → /stablecoin/:id navigation (a header click must never navigate).
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

// ── Filters ─────────────────────────────────────────────────────────────────────

function setFilter(value) {
	state.filter = value;
	const seg = $('sc-filter');
	seg?.querySelectorAll('button').forEach((b) => {
		b.setAttribute('aria-pressed', String(b.dataset.mech === value));
	});
	renderTable();
}

function renderFilters() {
	const seg = $('sc-filter');
	if (!seg) return;
	// Derive the filter set from the data — only mechanisms actually present get a
	// chip, in the canonical order, with anything unrecognised grouped last.
	const present = new Set(state.all.map((c) => c.peg_mechanism).filter(Boolean));
	const order = ['fiat-backed', 'crypto-backed', 'algorithmic'];
	const known = order.filter((m) => present.has(m));
	const others = [...present].filter((m) => !order.includes(m)).sort();
	const chips = [{ mech: 'all', label: 'All' }].concat(
		known.map((m) => ({ mech: m, label: mechanism(m).label })),
		others.map((m) => ({ mech: m, label: mechanism(m).label })),
	);
	seg.innerHTML = chips
		.map(
			(c) =>
				`<button type="button" data-mech="${esc(c.mech)}" aria-pressed="${c.mech === state.filter}">${esc(c.label)}</button>`,
		)
		.join('');
	seg.querySelectorAll('button').forEach((b) => {
		b.addEventListener('click', () => setFilter(b.dataset.mech));
	});
}

// ── Stats ───────────────────────────────────────────────────────────────────────

function renderStats() {
	const el = $('sc-stats');
	const top = state.all[0];
	const topDom = top ? dominance(top) : null;
	const cards = [
		statCard({
			label: 'Total Stablecoin Market Cap',
			value: formatUsd(state.total),
			icon: 'trend',
		}),
		statCard({
			label: 'Stablecoins Tracked',
			value: state.count != null ? state.count.toLocaleString('en-US') : '—',
			icon: 'coins',
		}),
	];
	if (top && topDom != null) {
		cards.push(
			statCard({
				label: `${top.symbol || top.name} Dominance`,
				value: `${topDom.toFixed(1)}%`,
				delta: 'Largest stablecoin',
				icon: 'pie',
			}),
		);
	}
	el.innerHTML = `<div class="sc-stats-grid">${cards.join('')}</div>`;
}

function renderUpdated() {
	const el = $('sc-updated');
	if (!el) return;
	const when = state.updatedAt
		? new Date(state.updatedAt).toLocaleTimeString('en-US', {
				hour: '2-digit',
				minute: '2-digit',
			})
		: null;
	el.textContent = when ? `Data: DeFiLlama · updated ${when}` : 'Data: DeFiLlama';
}

// ── Boot ─────────────────────────────────────────────────────────────────────────

function skeletons() {
	$('sc-stats').innerHTML =
		'<div class="sc-stats-grid">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6.5rem"></div>').join(
			'',
		) +
		'</div>';
	$('sc-table').innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>';
}

async function load() {
	skeletons();
	try {
		const data = await getJson('/api/defi/stablecoins');
		const list = Array.isArray(data.stablecoins) ? data.stablecoins : [];
		state.all = list.map((c, i) => ({
			...c,
			peg_mechanism: normalizeMechanism(c.peg_mechanism),
			_rank: i + 1,
		}));
		state.total = Number.isFinite(data.total_mcap) ? data.total_mcap : 0;
		state.count = Number.isFinite(data.count) ? data.count : state.all.length;
		state.updatedAt = data.updated_at || null;
		renderStats();
		renderFilters();
		renderTable();
		renderUpdated();
	} catch {
		state.all = [];
		$('sc-stats').innerHTML = '';
		renderTable();
		renderUpdated();
	}
}

load();
