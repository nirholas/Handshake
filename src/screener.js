// /screener: a client-side token screener over the live top-250 markets.
// Loads /api/coin/markets?page=1&per_page=250&sparkline=0 once, then filters
// and sorts entirely in the browser: text search, gainers/losers, market-cap
// and volume floors, and click-to-sort columns. Rows, columns, sorting and
// row navigation come from src/shared/market-table.js, the same primitives
// /coins renders, so the two tables cannot drift apart. Every row links to the
// rich /coin/:id detail page.

import { escapeHtml as esc } from './shared/coin-format.js';
import {
	coinRow,
	COIN_COLUMNS,
	coinSortValue,
	sortableHeaderCells,
	bindSortableHeaders,
	bindRowNavigation,
} from './shared/market-table.js';

const $ = (id) => document.getElementById(id);

// The screener renders no 7d chart column, so it asks the endpoint to leave the
// sparkline arrays out. Over 250 rows that is the difference between a ~215KB
// and a ~70KB response for exactly the same table.
const MARKETS_URL = '/api/coin/markets?page=1&per_page=250&sparkline=0';

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} -> ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
	coins: [],
	loaded: false,
	// A 429 is our own per-IP budget rather than an upstream outage, so the two
	// failures need different advice; null means the fetch has not failed.
	errorStatus: null,
	// Set when the endpoint served last-known-good rows because every live
	// provider was down. The table is real data, just not current, and saying so
	// beats a timestamp that claims otherwise.
	staleAsOf: null,
	sortKey: 'rank',
	sortDir: 'asc',
	q: '',
	dir: 'all', // all | gainers | losers
	minMcap: 0,
	minVol: 0,
};

// ── Filtering + sorting ────────────────────────────────────────────────────────

function filtered() {
	const q = state.q.toLowerCase();
	return state.coins.filter((c) => {
		if (q && !`${c.name} ${c.symbol}`.toLowerCase().includes(q)) return false;
		if (state.dir === 'gainers' && !((c.change_24h ?? 0) > 0)) return false;
		if (state.dir === 'losers' && !((c.change_24h ?? 0) < 0)) return false;
		if (state.minMcap && (c.market_cap ?? 0) < state.minMcap) return false;
		if (state.minVol && (c.volume_24h ?? 0) < state.minVol) return false;
		return true;
	});
}

function sorted(rows) {
	const { sortKey, sortDir } = state;
	return [...rows].sort((a, b) => {
		const va = coinSortValue(a, sortKey);
		const vb = coinSortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function updateCount(shown) {
	const el = $('scr-count');
	if (!el) return;
	el.textContent = state.loaded
		? `${shown.toLocaleString('en-US')} of ${state.coins.length.toLocaleString('en-US')} coins`
		: '';
}

// The failure the user hit decides the advice: retrying into our own rate limit
// only spends the next request they have, so that case asks for a pause first.
function whyFailed(status) {
	return status === 429
		? 'You have loaded this feed too many times in a row. Give it a minute, then'
		: 'The market data provider did not answer.';
}

function renderSkeleton() {
	$('scr-table').innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 14 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>';
}

function renderTable() {
	const el = $('scr-table');
	if (!el) return;

	if (state.errorStatus) {
		el.innerHTML = `<div class="cv-empty" role="status">The screener could not load the market table. ${whyFailed(state.errorStatus)} <button type="button" class="cv-linkbtn" data-act="retry">${state.errorStatus === 429 ? 'load it again' : 'Try again'}</button>.</div>`;
		el.querySelector('[data-act="retry"]')?.addEventListener('click', load);
		updateCount(0);
		return;
	}
	if (!state.loaded) return; // skeleton already on screen

	const rows = sorted(filtered());
	updateCount(rows.length);

	if (!state.coins.length) {
		el.innerHTML =
			'<div class="cv-empty" role="status">No coins are being reported right now. <button type="button" class="cv-linkbtn" data-act="retry">Refresh</button> to check again.</div>';
		el.querySelector('[data-act="retry"]')?.addEventListener('click', load);
		return;
	}

	if (!rows.length) {
		el.innerHTML =
			'<div class="cv-empty" role="status">No coins match these filters. Try widening your market-cap or volume floor, or <button type="button" class="cv-linkbtn" data-act="reset">reset all filters</button>.</div>';
		el.querySelector('[data-act="reset"]')?.addEventListener('click', resetFilters);
		return;
	}

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${sortableHeaderCells(COIN_COLUMNS, state.sortKey, state.sortDir)}</tr></thead>
				<tbody>${rows.map((c) => coinRow(c, { sparkline: false })).join('')}</tbody>
			</table>
		</div>`;

	bindSortableHeaders(el, state, renderTable);
	bindRowNavigation(el);
}

// The footer line is the page's only claim about freshness, so it never says
// "Updated <now>" over rows the endpoint flagged as last-known-good.
function renderUpdated() {
	const el = $('scr-updated');
	if (!el) return;
	if (state.errorStatus || !state.loaded) {
		el.textContent = '';
		return;
	}
	if (state.staleAsOf) {
		const at = new Date(state.staleAsOf);
		const when = Number.isNaN(at.getTime()) ? null : at.toLocaleString('en-US');
		el.innerHTML = `<span class="cv-src-note" title="Every live market provider is unreachable, so these are the last rows this feed fetched successfully.">Live market data is unavailable${when ? `; showing the last rows fetched at ${esc(when)}` : '; showing the last rows fetched'}.</span> <button type="button" class="cv-linkbtn" data-act="refresh">Try for live prices</button>.`;
		el.querySelector('[data-act="refresh"]')?.addEventListener('click', load);
		return;
	}
	el.textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
}

// ── Controls ──────────────────────────────────────────────────────────────────

function resetFilters() {
	state.q = '';
	state.dir = 'all';
	state.minMcap = 0;
	state.minVol = 0;
	state.sortKey = 'rank';
	state.sortDir = 'asc';
	$('scr-search-input').value = '';
	$('scr-mcap').value = '0';
	$('scr-vol').value = '0';
	$('scr-dir')
		.querySelectorAll('button')
		.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === 'all')));
	renderTable();
}

function wireControls() {
	const input = $('scr-search-input');
	let timer = null;
	input.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			state.q = input.value.trim();
			renderTable();
		}, 200);
	});

	$('scr-dir')
		.querySelectorAll('button')
		.forEach((btn) => {
			btn.addEventListener('click', () => {
				state.dir = btn.dataset.dir;
				$('scr-dir')
					.querySelectorAll('button')
					.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
				renderTable();
			});
		});

	$('scr-mcap').addEventListener('change', (e) => {
		state.minMcap = Number(e.target.value) || 0;
		renderTable();
	});
	$('scr-vol').addEventListener('change', (e) => {
		state.minVol = Number(e.target.value) || 0;
		renderTable();
	});
	$('scr-reset').addEventListener('click', resetFilters);
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
	// A retry starts from the same clean slate as the first load, so a recovered
	// upstream clears the error box instead of rendering behind it.
	state.errorStatus = null;
	state.staleAsOf = null;
	state.loaded = false;
	renderSkeleton();
	renderUpdated();
	try {
		const data = await getJson(MARKETS_URL);
		state.coins = Array.isArray(data.coins) ? data.coins : [];
		state.staleAsOf = data.stale ? data.as_of || null : null;
		state.loaded = true;
	} catch (err) {
		state.errorStatus = err.status || 502;
	}
	renderTable();
	renderUpdated();
}

wireControls();
load();
