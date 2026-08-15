// /yields — DeFi yield-pool explorer over /api/defi/yields (DeFiLlama, keyless).
// The API does all filtering, sorting and paging server-side against a slimmed,
// cached copy of DeFiLlama's ~15k-pool dataset, so this module keeps no local
// pool cache: every filter change is a fresh request, and "Load more" appends
// the next offset window. Each row expands into an inline drawer that fetches
// the pool's APY + TVL history (chart mode) and draws a dual-axis SVG chart
// with a hover crosshair adapted from src/coin-page.js.

import { formatUsd, escapeHtml as esc } from './shared/coin-format.js';

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

// ── Formatting ──────────────────────────────────────────────────────────────

/** Unsigned APY percentage: "2.21%". Em dash for missing input. */
function fmtApy(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `${n.toFixed(2)}%`;
}

/** Signed APY delta with 2 decimals: "+0.31%" / "−0.07%". */
function fmtDelta(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
}

// ── State ───────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const state = {
	// filters (mirrored to the URL query string)
	chain: '',
	project: '',
	stablecoin: false,
	minTvl: 0,
	search: '',
	sort: 'tvl', // tvl | apy
	// data
	pools: [],
	total: 0,
	offset: 0,
	facets: null,
	facetsReady: false,
	stats: null,
	// ui
	loading: true,
	loadingMore: false,
	error: false,
	updatedAt: null,
	expanded: null, // pool uuid whose drawer is open
	charts: new Map(), // uuid → { status:'loading'|'ready'|'empty'|'error', points }
};

// ── URL sync ────────────────────────────────────────────────────────────────

function readUrl() {
	const p = new URLSearchParams(location.search);
	state.chain = (p.get('chain') || '').trim();
	state.project = (p.get('project') || '').trim();
	state.stablecoin = p.get('stablecoin') === 'true';
	state.minTvl = Math.max(0, Number(p.get('minTvl')) || 0);
	state.search = (p.get('search') || '').trim();
	state.sort = p.get('sort') === 'apy' ? 'apy' : 'tvl';
}

function writeUrl() {
	const p = new URLSearchParams();
	if (state.chain) p.set('chain', state.chain);
	if (state.project) p.set('project', state.project);
	if (state.stablecoin) p.set('stablecoin', 'true');
	if (state.minTvl) p.set('minTvl', String(state.minTvl));
	if (state.search) p.set('search', state.search);
	if (state.sort !== 'tvl') p.set('sort', state.sort);
	const qs = p.toString();
	const url = qs ? `${location.pathname}?${qs}` : location.pathname;
	history.replaceState(null, '', url);
}

function buildQuery(offset) {
	const p = new URLSearchParams();
	if (state.chain) p.set('chain', state.chain);
	if (state.project) p.set('project', state.project);
	if (state.stablecoin) p.set('stablecoin', 'true');
	if (state.minTvl) p.set('minTvl', String(state.minTvl));
	if (state.search) p.set('search', state.search);
	p.set('sort', state.sort);
	p.set('limit', String(PAGE_SIZE));
	p.set('offset', String(offset));
	return `/api/defi/yields?${p.toString()}`;
}

// ── Filter controls ─────────────────────────────────────────────────────────

function syncControlsFromState() {
	$('yl-search-input').value = state.search;
	$('yl-mintvl').value = String(state.minTvl);
	$('yl-stable').checked = state.stablecoin;
	$('yl-chain').value = state.chain;
	$('yl-project').value = state.project;
	$('yl-sort')
		.querySelectorAll('button')
		.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
}

// Populate the chain/project dropdowns once, from the filter-agnostic facets the
// API returns. A pre-selected value from the URL that isn't in the top-N facet
// list is preserved as an extra option so the filter still reflects the URL.
function populateFacets() {
	if (state.facetsReady || !state.facets) return;
	fillSelect($('yl-chain'), state.facets.chains, state.chain);
	fillSelect($('yl-project'), state.facets.projects, state.project);
	state.facetsReady = true;
}

function fillSelect(sel, items, current) {
	// Keep the markup's "All chains" / "All projects" option node rather than
	// re-emitting it: it carries the data-i18n annotation (and, on a non-English
	// locale, the already-translated label) that a rewritten innerHTML would drop.
	const placeholder = sel.querySelector('option[value=""]');
	const seen = new Set();
	const frag = document.createDocumentFragment();
	if (placeholder) frag.append(placeholder);
	for (const it of items || []) {
		seen.add(it.name);
		const opt = document.createElement('option');
		opt.value = it.name;
		opt.textContent = `${it.name} (${it.pool_count.toLocaleString('en-US')})`;
		frag.append(opt);
	}
	if (current && !seen.has(current)) {
		const opt = document.createElement('option');
		opt.value = current;
		opt.textContent = current;
		frag.append(opt);
	}
	sel.replaceChildren(frag);
	sel.value = current || '';
}

function resetFilters() {
	state.chain = '';
	state.project = '';
	state.stablecoin = false;
	state.minTvl = 0;
	state.search = '';
	state.sort = 'tvl';
	syncControlsFromState();
	writeUrl();
	load();
}

// ── Stats ───────────────────────────────────────────────────────────────────

const STAT_IDS = ['yl-stat-pools', 'yl-stat-tvl', 'yl-stat-apy'];

function setStat(id, text, outage) {
	const el = $(id);
	el.textContent = text;
	el.classList.toggle('yl-stat-out', outage === true);
}

function renderStats() {
	const s = state.stats;
	if (!s) return;
	const pools = s.pool_count != null ? s.pool_count.toLocaleString('en-US') : 'Unavailable';
	setStat('yl-stat-pools', pools, s.pool_count == null);
	setStat('yl-stat-tvl', formatUsd(s.total_tvl), false);
	setStat('yl-stat-apy', fmtApy(s.median_apy), false);
}

// The three stat cards open as skeletons. If the feed never answers, they have
// to say so: a skeleton that never resolves reads as a page still loading.
function renderStatsOutage() {
	for (const id of STAT_IDS) setStat(id, 'Unavailable', true);
}

function updateCount() {
	const el = $('yl-count');
	if (!el) return;
	if (state.error) {
		el.textContent = 'Pool data unavailable';
		return;
	}
	if (!state.stats) {
		el.textContent = '';
		return;
	}
	const shown = state.pools.length;
	el.textContent = `${shown.toLocaleString('en-US')} of ${state.total.toLocaleString('en-US')} pools`;
}

// ── Table rendering ─────────────────────────────────────────────────────────

const COLUMNS = [
	{ label: 'Pool', left: true },
	{ label: 'Project', left: true, hide: 'hide-md' },
	{ label: 'Chain', left: true, hide: 'hide-sm' },
	{ label: 'TVL' },
	{ label: 'APY' },
	{ label: '30d Avg', hide: 'hide-lg' },
	{ label: 'Δ7d', hide: 'hide-md' },
	{ label: 'Risk / Outlook', left: true, hide: 'hide-lg' },
];

function skeletonRows(n) {
	return (
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: n },
			() => '<div class="cv-skel" style="height:2.75rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>'
	);
}

function ilChip(risk) {
	if (risk === 'yes') return '<span class="yl-chip il-yes">IL risk</span>';
	if (risk === 'no') return '<span class="yl-chip il-no">No IL</span>';
	return '';
}

function outlookChip(outlook, confidence) {
	if (!outlook) return '';
	const conf = confidence != null && Number.isFinite(confidence) ? ` ${Math.round(confidence)}%` : '';
	const up = /up/i.test(outlook);
	const down = /down/i.test(outlook);
	const cls = up ? 'up' : down ? 'down' : 'flat';
	return `<span class="yl-chip outlook ${cls}" title="Predicted outlook">${esc(outlook)}${conf}</span>`;
}

function apyCell(p) {
	const hasSplit = p.apy_base != null && p.apy_reward != null && p.apy_reward > 0;
	const sub = hasSplit
		? `<span class="sub">${fmtApy(p.apy_base)} base + ${fmtApy(p.apy_reward)} reward</span>`
		: '';
	return `<td class="num yl-apy"><span class="big">${esc(fmtApy(p.apy))}</span>${sub}</td>`;
}

function deltaCell(v) {
	if (v == null || !Number.isFinite(v)) return '<td class="num hide-md dim">—</td>';
	const cls = v >= 0 ? 'cv-up' : 'cv-down';
	return `<td class="num hide-md ${cls}">${esc(fmtDelta(v))}</td>`;
}

function rowHtml(p) {
	const expanded = state.expanded === p.pool;
	const meta = p.pool_meta ? `<span class="meta">${esc(p.pool_meta)}</span>` : '';
	const stableTag = p.stablecoin ? '<span class="yl-tag">stable</span>' : '';
	return `
		<tr class="yl-row${expanded ? ' is-open' : ''}" data-pool="${esc(p.pool)}" tabindex="0" role="button"
			aria-expanded="${expanded ? 'true' : 'false'}" aria-label="Toggle history for ${esc(p.symbol)} on ${esc(p.project)}">
			<td class="left yl-pool">
				<span class="chev" aria-hidden="true">▸</span>
				<span class="pool-inner">
					<span class="sym">${esc(p.symbol)}${stableTag}</span>
					${meta}
				</span>
			</td>
			<td class="left hide-md yl-project">${p.project ? `<a class="yl-link" href="/protocol/${encodeURIComponent(p.project)}">${esc(p.project)}</a>` : '—'}</td>
			<td class="left hide-sm yl-chain">${p.chain ? `<a class="yl-link" href="/chain/${encodeURIComponent(p.chain)}">${esc(p.chain)}</a>` : '—'}</td>
			<td class="num">${esc(formatUsd(p.tvl_usd))}</td>
			${apyCell(p)}
			<td class="num hide-lg dim">${esc(fmtApy(p.apy_mean_30d))}</td>
			${deltaCell(p.apy_change_7d)}
			<td class="left hide-lg yl-chips">${ilChip(p.il_risk)}${outlookChip(p.outlook, p.outlook_confidence)}</td>
		</tr>
		<tr class="yl-drawer-row${expanded ? ' is-open' : ''}" data-drawer="${esc(p.pool)}"${expanded ? '' : ' hidden'}>
			<td colspan="${COLUMNS.length}" class="yl-drawer-cell">
				<div class="yl-drawer" id="drawer-${esc(p.pool)}"></div>
			</td>
		</tr>`;
}

function renderTable() {
	const el = $('yl-table');

	if (state.error) {
		el.innerHTML = `
			<div class="cv-empty">
				<p>DeFi yield data is unavailable right now.</p>
				<button type="button" class="yl-retry" id="yl-retry">Retry</button>
			</div>`;
		$('yl-retry')?.addEventListener('click', () => load());
		$('yl-more-wrap').hidden = true;
		updateCount();
		return;
	}

	if (state.loading) {
		el.innerHTML = skeletonRows(12);
		$('yl-more-wrap').hidden = true;
		return;
	}

	if (!state.pools.length) {
		el.innerHTML = `
			<div class="cv-empty">
				<p>No pools match these filters.</p>
				<p class="cv-empty-sub">Loosen your chain, project, TVL or stablecoin filters to see more.</p>
				<button type="button" class="yl-retry" id="yl-empty-reset">Reset filters</button>
			</div>`;
		$('yl-empty-reset')?.addEventListener('click', resetFilters);
		$('yl-more-wrap').hidden = true;
		updateCount();
		return;
	}

	const head = COLUMNS.map(
		(c) => `<th scope="col" class="${c.left ? 'left' : ''} ${c.hide || ''}">${esc(c.label)}</th>`,
	).join('');

	const body = state.pools.map(rowHtml).join('');

	el.innerHTML = `
		<div class="cv-table-wrap yl-table-wrap">
			<table class="cv-table yl-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;

	el.querySelectorAll('tr.yl-row').forEach((tr) => {
		const toggle = () => toggleRow(tr.dataset.pool);
		tr.addEventListener('click', (e) => {
			// A click on the project/chain cross-link navigates; it must not
			// also toggle the pool's history drawer.
			if (e.target.closest('a.yl-link')) return;
			toggle();
		});
		tr.addEventListener('keydown', (e) => {
			if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('a.yl-link')) {
				e.preventDefault();
				toggle();
			}
		});
	});

	// Re-open drawer content if one was expanded before a re-render.
	if (state.expanded) renderDrawer(state.expanded);

	$('yl-more-wrap').hidden = state.pools.length >= state.total;
	updateCount();
}

// ── Row expansion + chart ───────────────────────────────────────────────────

function toggleRow(pool) {
	if (state.expanded === pool) {
		state.expanded = null;
		renderTable();
		return;
	}
	state.expanded = pool;
	renderTable();
	loadChart(pool);
	// Bring the freshly-opened drawer into view on small screens.
	const row = $('yl-table').querySelector(`tr.yl-row[data-pool="${cssEsc(pool)}"]`);
	row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function cssEsc(s) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

async function loadChart(pool) {
	const cached = state.charts.get(pool);
	if (cached && (cached.status === 'ready' || cached.status === 'empty')) {
		renderDrawer(pool);
		return;
	}
	state.charts.set(pool, { status: 'loading', points: [] });
	renderDrawer(pool);
	try {
		const data = await getJson(`/api/defi/yields?pool=${encodeURIComponent(pool)}`);
		const points = Array.isArray(data?.points) ? data.points : [];
		state.charts.set(pool, { status: points.length ? 'ready' : 'empty', points });
	} catch (err) {
		// A 404 from the API means "no history for this pool", not an outage.
		if (err?.status === 404) state.charts.set(pool, { status: 'empty', points: [] });
		else state.charts.set(pool, { status: 'error', points: [] });
	}
	if (state.expanded === pool) renderDrawer(pool);
}

function renderDrawer(pool) {
	const host = $(`drawer-${pool}`);
	if (!host) return;
	const c = state.charts.get(pool) || { status: 'loading', points: [] };

	if (c.status === 'loading') {
		host.innerHTML =
			'<div class="yl-chart-skel"><span class="cv-spinner" aria-hidden="true"></span>Loading APY &amp; TVL history…</div>';
		return;
	}
	if (c.status === 'error') {
		host.innerHTML = `
			<div class="yl-chart-state">
				<p>Couldn't load this pool's history.</p>
				<button type="button" class="yl-retry" data-retry="${esc(pool)}">Retry</button>
			</div>`;
		host.querySelector('[data-retry]')?.addEventListener('click', () => {
			state.charts.delete(pool);
			loadChart(pool);
		});
		return;
	}
	if (c.status === 'empty' || c.points.length < 2) {
		host.innerHTML = '<div class="yl-chart-state">No history yet for this pool.</div>';
		return;
	}

	const geom = chartGeom(host.clientWidth);
	host.innerHTML = renderChartSvg(pool, c.points, geom);
	wireChartPointer(pool, c.points, geom);
}

// ── Dual-axis SVG chart (APY left, TVL right) ───────────────────────────────

// The viewBox is sized to the drawer's real pixel width so one user unit is one
// CSS pixel. A fixed 760-unit box scaled into a 288px phone drawer shrank every
// axis label to a third of its size (9px type rendering at under 3px) and left
// the plot 72px tall; sizing to the container keeps type at its stated size and
// lets the axis gutters shrink instead of the content.
const CH_REGULAR = 220;
const CH_COMPACT = 200;
const COMPACT_AT = 520;

function chartGeom(width) {
	const w = Math.max(280, Math.round(width) || 760);
	const compact = w < COMPACT_AT;
	return {
		w,
		h: compact ? CH_COMPACT : CH_REGULAR,
		pad: compact
			? { top: 14, right: 46, bottom: 22, left: 42 }
			: { top: 18, right: 66, bottom: 26, left: 56 },
		steps: compact ? 3 : 4,
		font: compact ? 8.5 : 9,
	};
}

function seriesExtent(points, key) {
	let min = Infinity;
	let max = -Infinity;
	for (const p of points) {
		const v = p[key];
		if (v == null || !Number.isFinite(v)) continue;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (!Number.isFinite(min)) return null;
	return { min, max, range: max - min || Math.abs(max) || 1 };
}

function linePath(points, key, ext, g) {
	const w = g.w - g.pad.left - g.pad.right;
	const h = g.h - g.pad.top - g.pad.bottom;
	const n = points.length;
	let d = '';
	let started = false;
	for (let i = 0; i < n; i++) {
		const v = points[i][key];
		if (v == null || !Number.isFinite(v)) {
			started = false; // break the line across a gap
			continue;
		}
		const x = g.pad.left + (i / (n - 1)) * w;
		const y = g.pad.top + h - ((v - ext.min) / ext.range) * h;
		d += `${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
		started = true;
	}
	return d.trim();
}

function renderChartSvg(pool, points, g) {
	const apyExt = seriesExtent(points, 'apy');
	const tvlExt = seriesExtent(points, 'tvl_usd');
	const h = g.h - g.pad.top - g.pad.bottom;

	const apyPath = apyExt ? linePath(points, 'apy', apyExt, g) : '';
	const tvlPath = tvlExt ? linePath(points, 'tvl_usd', tvlExt, g) : '';

	// Left axis labels (APY), right axis labels (TVL); gridlines shared.
	let grid = '';
	for (let i = 0; i <= g.steps; i++) {
		const y = g.pad.top + h - (i / g.steps) * h;
		const apyLabel = apyExt ? fmtApy(apyExt.min + (apyExt.range * i) / g.steps) : '';
		const tvlLabel = tvlExt ? formatUsd(tvlExt.min + (tvlExt.range * i) / g.steps) : '';
		grid += `<line x1="${g.pad.left}" y1="${y}" x2="${g.w - g.pad.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/>`;
		grid += `<text x="${g.pad.left - 6}" y="${y + 3}" text-anchor="end" font-size="${g.font}" fill="var(--yl-apy-axis)">${esc(apyLabel)}</text>`;
		grid += `<text x="${g.w - g.pad.right + 6}" y="${y + 3}" font-size="${g.font}" fill="var(--yl-tvl-axis)">${esc(tvlLabel)}</text>`;
	}

	const from = points[0]?.t;
	const to = points[points.length - 1]?.t;

	return `
		<div class="yl-chart-head">
			<div class="yl-legend">
				<span class="yl-leg apy"><i></i>APY (left)</span>
				<span class="yl-leg tvl"><i></i>TVL (right)</span>
			</div>
			<span class="yl-chart-range">${esc(fmtDate(from))} to ${esc(fmtDate(to))}</span>
		</div>
		<div class="yl-chart-area">
			<svg viewBox="0 0 ${g.w} ${g.h}" role="img"
				aria-label="APY and TVL history for this pool over ${points.length} points">
				${grid}
				${tvlPath ? `<path d="${tvlPath}" fill="none" stroke="var(--yl-tvl-axis)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>` : ''}
				${apyPath ? `<path d="${apyPath}" fill="none" stroke="var(--yl-apy-axis)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
				<g class="yl-cross" data-cross="${esc(pool)}" hidden>
					<line class="cl" x1="0" y1="${g.pad.top}" x2="0" y2="${g.h - g.pad.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
					<circle class="dot-apy" r="4" fill="var(--yl-apy-axis)" stroke="var(--cv-surface)" stroke-width="2" hidden/>
					<circle class="dot-tvl" r="4" fill="var(--yl-tvl-axis)" stroke="var(--cv-surface)" stroke-width="2" hidden/>
				</g>
			</svg>
			<div class="yl-tip" data-tip="${esc(pool)}" hidden>
				<p class="d"></p>
				<p class="a"><i class="apy"></i><span></span></p>
				<p class="a"><i class="tvl"></i><span></span></p>
			</div>
		</div>`;
}

function fmtDate(t) {
	if (t == null) return '';
	const d = new Date(t);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function wireChartPointer(pool, points, g) {
	const host = $(`drawer-${pool}`);
	const svg = host?.querySelector('svg');
	const cross = host?.querySelector('.yl-cross');
	const tip = host?.querySelector('.yl-tip');
	if (!svg || !cross || !tip) return;

	const apyExt = seriesExtent(points, 'apy');
	const tvlExt = seriesExtent(points, 'tvl_usd');
	const w = g.w - g.pad.left - g.pad.right;
	const h = g.h - g.pad.top - g.pad.bottom;
	const n = points.length;
	const crossLine = cross.querySelector('.cl');
	const dotApy = cross.querySelector('.dot-apy');
	const dotTvl = cross.querySelector('.dot-tvl');

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mx = ((clientX - rect.left) / rect.width) * g.w;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mx - g.pad.left) / w) * (n - 1))));
		const pt = points[i];
		const x = g.pad.left + (i / (n - 1)) * w;
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);

		if (apyExt && pt.apy != null && Number.isFinite(pt.apy)) {
			const y = g.pad.top + h - ((pt.apy - apyExt.min) / apyExt.range) * h;
			dotApy.setAttribute('cx', x);
			dotApy.setAttribute('cy', y);
			dotApy.removeAttribute('hidden');
		} else {
			dotApy.setAttribute('hidden', '');
		}
		if (tvlExt && pt.tvl_usd != null && Number.isFinite(pt.tvl_usd)) {
			const y = g.pad.top + h - ((pt.tvl_usd - tvlExt.min) / tvlExt.range) * h;
			dotTvl.setAttribute('cx', x);
			dotTvl.setAttribute('cy', y);
			dotTvl.removeAttribute('hidden');
		} else {
			dotTvl.setAttribute('hidden', '');
		}

		tip.hidden = false;
		// The tip is centred on the crosshair, so clamp its anchor away from both
		// edges or a reading near either end hangs outside the drawer.
		const half = (tip.offsetWidth / 2 / rect.width) * 100;
		tip.style.left = `${Math.min(100 - half, Math.max(half, (x / g.w) * 100))}%`;
		tip.querySelector('.d').textContent = fmtDate(pt.t);
		tip.querySelectorAll('.a span')[0].textContent = `APY ${fmtApy(pt.apy)}`;
		tip.querySelectorAll('.a span')[1].textContent = `TVL ${formatUsd(pt.tvl_usd)}`;
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
}

// ── Data loading ────────────────────────────────────────────────────────────

async function load() {
	state.loading = true;
	state.error = false;
	state.offset = 0;
	state.expanded = null;
	renderTable();
	try {
		const data = await getJson(buildQuery(0));
		state.pools = Array.isArray(data.pools) ? data.pools : [];
		state.total = Number(data.total) || state.pools.length;
		state.offset = state.pools.length;
		state.facets = data.facets || state.facets;
		state.stats = data.stats || state.stats;
		state.updatedAt = data.updated_at || null;
		state.loading = false;
		populateFacets();
		renderStats();
		$('yl-updated').textContent = state.updatedAt
			? `Updated ${new Date(state.updatedAt).toLocaleTimeString('en-US')} · DeFiLlama`
			: '';
	} catch {
		state.loading = false;
		state.error = true;
		$('yl-updated').textContent = '';
		// Keep whatever stats a previous successful load produced; only a page
		// that never had any needs the outage treatment.
		if (state.stats) renderStats();
		else renderStatsOutage();
	}
	renderTable();
}

async function loadMore() {
	if (state.loadingMore || state.pools.length >= state.total) return;
	state.loadingMore = true;
	const btn = $('yl-more');
	btn.disabled = true;
	btn.textContent = 'Loading…';
	try {
		const data = await getJson(buildQuery(state.offset));
		const more = Array.isArray(data.pools) ? data.pools : [];
		state.pools = state.pools.concat(more);
		state.total = Number(data.total) || state.total;
		state.offset = state.pools.length;
		renderTable();
	} catch {
		btn.textContent = 'Retry loading more';
		btn.disabled = false;
		state.loadingMore = false;
		return;
	}
	state.loadingMore = false;
	btn.disabled = false;
	btn.textContent = 'Load more pools';
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wireControls() {
	const input = $('yl-search-input');
	let timer = null;
	input.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const v = input.value.trim();
			if (v === state.search) return;
			state.search = v;
			writeUrl();
			load();
		}, 300);
	});

	$('yl-chain').addEventListener('change', (e) => {
		state.chain = e.target.value;
		writeUrl();
		load();
	});
	$('yl-project').addEventListener('change', (e) => {
		state.project = e.target.value;
		writeUrl();
		load();
	});
	$('yl-mintvl').addEventListener('change', (e) => {
		state.minTvl = Number(e.target.value) || 0;
		writeUrl();
		load();
	});
	$('yl-stable').addEventListener('change', (e) => {
		state.stablecoin = e.target.checked;
		writeUrl();
		load();
	});

	$('yl-sort')
		.querySelectorAll('button')
		.forEach((btn) => {
			btn.addEventListener('click', () => {
				if (state.sort === btn.dataset.sort) return;
				state.sort = btn.dataset.sort;
				$('yl-sort')
					.querySelectorAll('button')
					.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
				writeUrl();
				load();
			});
		});

	$('yl-reset').addEventListener('click', resetFilters);
	$('yl-more').addEventListener('click', loadMore);

	// The chart's viewBox is sized to the drawer at render time, so a width change
	// (rotation, window resize) has to redraw it or the axes keep the old scale.
	let resizeTimer = null;
	window.addEventListener('resize', () => {
		if (!state.expanded) return;
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			if (state.expanded) renderDrawer(state.expanded);
		}, 150);
	});

	// Reflect back/forward navigation into the filters.
	window.addEventListener('popstate', () => {
		readUrl();
		syncControlsFromState();
		load();
	});
}

readUrl();
syncControlsFromState();
wireControls();
load();
