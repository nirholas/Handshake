// /hacks — DeFi exploit & hack history. Header stat cards (all-time stolen,
// last-12mo stolen, incidents 12mo, bridge-hack share), a debounced search
// synced to the URL, and a paginated table of incidents (newest first) with a
// "Load more" control. Data comes from /api/defi/hacks (DeFiLlama's keyless
// hacks database), normalized server-side. Mirrors the /defi list-page
// pattern: stat cards, cv-table, designed loading / empty / error states.

import { formatUsd, formatDateShort, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── State ───────────────────────────────────────────────────────────────────

const state = {
	stats: null,
	rows: [], // accumulated incidents across loaded pages
	count: 0, // total matching the active search
	updatedAt: 0,
	search: '',
	offset: 0,
	loading: true, // first page in flight
	loadingMore: false,
	error: false,
};

// ── Stat cards ────────────────────────────────────────────────────────────

const ICONS = {
	skull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/></svg>',
	calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
	list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
	bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M4 12v6"/><path d="M20 12v6"/><path d="M2 12a10 10 0 0 1 20 0"/><path d="M9 12v3"/><path d="M15 12v3"/></svg>',
};

function statCard({ label, value, delta, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
				${delta ? `<p class="delta">${esc(delta)}</p>` : ''}
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function renderStats() {
	const el = $('hacks-stats');
	const s = state.stats;
	if (!s) {
		el.innerHTML = '';
		return;
	}
	const pct = Number.isFinite(s.bridge_hack_share_pct) ? s.bridge_hack_share_pct : 0;
	el.innerHTML =
		'<div class="hacks-stat-grid">' +
		[
			statCard({ label: 'Total Stolen · All Time', value: formatUsd(s.total_stolen_all_time), icon: 'skull' }),
			statCard({ label: 'Stolen · Last 12 Months', value: formatUsd(s.total_stolen_12mo), icon: 'calendar' }),
			statCard({
				label: 'Incidents · Last 12 Months',
				value: (s.incidents_12mo || 0).toLocaleString('en-US'),
				icon: 'list',
			}),
			statCard({
				label: 'Bridge-Hack Share',
				value: `${pct.toFixed(1)}%`,
				delta: 'of all-time losses',
				icon: 'bridge',
			}),
		].join('') +
		'</div>';
}

function statsSkeleton() {
	$('hacks-stats').innerHTML =
		'<div class="hacks-stat-grid">' +
		Array.from({ length: 4 }, () => '<div class="cv-skel" style="height:6rem"></div>').join('') +
		'</div>';
}

// ── Table ─────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ label: 'Date', cls: 'left' },
	{ label: 'Name', cls: 'left' },
	{ label: 'Amount', cls: 'num' },
	{ label: 'Classification', cls: 'left hide-md' },
	{ label: 'Technique', cls: 'left hide-lg' },
	{ label: 'Chains', cls: 'left hide-lg' },
	{ label: 'Target', cls: 'left hide-md' },
	{ label: '', cls: 'num' }, // bridge flag + source
];

// Bold red scale by magnitude — the larger the theft, the hotter the amount.
function amountClass(usd) {
	if (usd == null) return '';
	if (usd >= 1e8) return 'amt-4';
	if (usd >= 1e7) return 'amt-3';
	if (usd >= 1e6) return 'amt-2';
	return 'amt-1';
}

function truncate(s, n) {
	if (!s) return '';
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function chainsCell(chains) {
	if (!chains || !chains.length) return '<td class="left dim hide-lg">—</td>';
	const shown = chains.slice(0, 2).map((c) => `<span class="hacks-chip">${esc(c)}</span>`).join('');
	const extra =
		chains.length > 2
			? `<span class="hacks-more-chip" title="${esc(chains.slice(2).join(', '))}">+${chains.length - 2}</span>`
			: '';
	return `<td class="left hide-lg hacks-chains">${shown}${extra}</td>`;
}

function rowHtml(h) {
	const dateIso = new Date(h.date).toISOString();
	const amtCls = amountClass(h.amount_usd);
	const returned =
		h.returned_usd != null
			? `<span class="hacks-returned" title="Funds returned / recovered">↩ ${esc(formatUsd(h.returned_usd))}</span>`
			: '';
	const flags = [];
	if (h.bridge) flags.push('<span class="hacks-flag hacks-flag-bridge" title="Cross-chain bridge exploit">Bridge</span>');
	if (h.source) {
		flags.push(
			`<a class="hacks-src" href="${esc(h.source)}" target="_blank" rel="noopener noreferrer" aria-label="Read source report for ${esc(h.name)}">source <span aria-hidden="true">↗</span></a>`,
		);
	}
	return `
		<tr>
			<td class="left dim cv-mono hacks-date">${esc(formatDateShort(dateIso))}</td>
			<td class="left name-cell"><span class="nm">${esc(h.name)}</span></td>
			<td class="price hacks-amount ${amtCls}">${esc(formatUsd(h.amount_usd))}${returned ? `<br>${returned}` : ''}</td>
			<td class="left hide-md">${h.classification ? `<span class="hacks-class">${esc(h.classification)}</span>` : '<span class="dim">—</span>'}</td>
			<td class="left dim hide-lg hacks-tech" title="${esc(h.technique || '')}">${h.technique ? esc(truncate(h.technique, 40)) : '—'}</td>
			${chainsCell(h.chains)}
			<td class="left dim hide-md">${h.target_type ? esc(h.target_type) : '—'}</td>
			<td class="num hacks-flags">${flags.join('') || '<span class="dim">—</span>'}</td>
		</tr>`;
}

function tableSkeleton() {
	return (
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>'
	);
}

function renderTable() {
	const el = $('hacks-table');

	if (state.loading) {
		el.innerHTML = tableSkeleton();
		renderMore();
		return;
	}
	if (state.error) {
		el.innerHTML =
			'<div class="cv-empty">DeFi hacks data is temporarily unavailable. <button type="button" class="hacks-retry">Try again</button></div>';
		el.querySelector('.hacks-retry')?.addEventListener('click', () => load());
		renderMore();
		return;
	}
	if (!state.rows.length) {
		el.innerHTML = state.search
			? `<div class="cv-empty">No incidents match “${esc(state.search)}”. <button type="button" class="hacks-reset">Clear search</button></div>`
			: '<div class="cv-empty">No incidents on record.</div>';
		el.querySelector('.hacks-reset')?.addEventListener('click', () => {
			const input = $('hacks-search');
			if (input) input.value = '';
			applySearch('');
		});
		renderMore();
		return;
	}

	const head = COLUMNS.map(
		(c) => `<th scope="col" class="${c.cls}">${esc(c.label)}</th>`,
	).join('');
	const body = state.rows.map(rowHtml).join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table hacks-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;
	renderMore();
}

function renderMore() {
	const el = $('hacks-more');
	if (!el) return;
	const remaining = state.count - state.rows.length;
	if (state.loading || state.error || remaining <= 0) {
		el.innerHTML = '';
		return;
	}
	el.innerHTML = `<button type="button" class="hacks-load-more"${state.loadingMore ? ' disabled' : ''}>
		${state.loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, remaining)} more`}
		<span class="hacks-remaining">${remaining.toLocaleString('en-US')} more</span>
	</button>`;
	el.querySelector('.hacks-load-more')?.addEventListener('click', loadMore);
}

function renderUpdated() {
	const el = $('hacks-updated');
	if (!el) return;
	if (state.loading || state.error) {
		el.textContent = '';
		return;
	}
	const scope = state.search
		? `${state.count.toLocaleString('en-US')} incidents match “${state.search}”`
		: `${state.count.toLocaleString('en-US')} incidents on record`;
	el.textContent = `${scope} · Data: DeFiLlama · updated ${new Date(state.updatedAt || Date.now()).toLocaleTimeString('en-US')}`;
}

// ── Data loading ────────────────────────────────────────────────────────────

function apiUrl(offset) {
	const p = new URLSearchParams();
	if (state.search) p.set('search', state.search);
	p.set('limit', String(PAGE_SIZE));
	p.set('offset', String(offset));
	return `/api/defi/hacks?${p.toString()}`;
}

async function load() {
	state.loading = true;
	state.error = false;
	state.offset = 0;
	statsSkeleton();
	renderTable();
	renderUpdated();
	try {
		const data = await getJson(apiUrl(0));
		state.stats = data.stats || null;
		state.rows = Array.isArray(data.hacks) ? data.hacks : [];
		state.count = Number.isFinite(data.count) ? data.count : state.rows.length;
		state.updatedAt = data.updated_at || Date.now();
		state.offset = state.rows.length;
		state.loading = false;
		state.error = false;
		renderStats();
		renderTable();
		renderUpdated();
	} catch {
		state.loading = false;
		state.error = true;
		state.stats = null;
		$('hacks-stats').innerHTML = '';
		renderTable();
		renderUpdated();
	}
}

async function loadMore() {
	if (state.loadingMore || state.rows.length >= state.count) return;
	state.loadingMore = true;
	renderMore();
	try {
		const data = await getJson(apiUrl(state.offset));
		const more = Array.isArray(data.hacks) ? data.hacks : [];
		state.rows = state.rows.concat(more);
		state.offset += more.length;
		state.count = Number.isFinite(data.count) ? data.count : state.count;
		state.loadingMore = false;
		renderTable();
		renderUpdated();
	} catch {
		state.loadingMore = false;
		// Keep what we have; surface a retryable affordance in the more slot.
		const el = $('hacks-more');
		if (el) {
			el.innerHTML =
				'<button type="button" class="hacks-load-more">Couldn’t load more — retry</button>';
			el.querySelector('.hacks-load-more')?.addEventListener('click', loadMore);
		}
	}
}

// ── Search (debounced + URL-synced) ──────────────────────────────────────────

let searchTimer = 0;

function syncUrl() {
	const url = new URL(window.location.href);
	if (state.search) url.searchParams.set('search', state.search);
	else url.searchParams.delete('search');
	window.history.replaceState(null, '', url);
}

function applySearch(value) {
	const next = value.trim();
	if (next === state.search) return;
	state.search = next;
	syncUrl();
	load();
}

function initSearch() {
	const input = $('hacks-search');
	if (!input) return;
	// Hydrate from the URL so a shared /hacks?search=… link lands pre-filtered.
	const initial = new URL(window.location.href).searchParams.get('search') || '';
	if (initial) {
		input.value = initial;
		state.search = initial.trim();
	}
	input.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = window.setTimeout(() => applySearch(input.value), 300);
	});
	// Enter applies immediately (skip the debounce).
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			clearTimeout(searchTimer);
			applySearch(input.value);
		}
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────

initSearch();
load();
