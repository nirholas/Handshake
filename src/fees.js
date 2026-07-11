// /fees — Protocol fees & revenue. A Fees|Revenue toggle (each refetches and
// syncs ?type= in the URL), header stat cards (24h/7d/30d of the selected
// metric), an aggregate SVG area chart with a range toggle + crosshair, and a
// sortable table of the top protocols. Protocol names deep-link to /protocol/:slug
// and chain chips to /chain/:name. Data comes from /api/defi/fees (DeFiLlama,
// keyless), normalized server-side. Mirrors the /defi + /exchange page patterns:
// stat cards, cv-chart-panel, sortable cv-table, designed loading/empty/error.

import {
	formatUsd,
	formatPercent,
	formatChartTick,
	escapeHtml as esc,
} from './shared/coin-format.js';

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

// ── State ───────────────────────────────────────────────────────────────────

const state = {
	type: 'fees', // 'fees' | 'revenue'
	total24h: null,
	total7d: null,
	total30d: null,
	change_1d: null,
	chart: [],
	protocols: [],
	updated_at: 0,
	sortKey: 'total24h',
	sortDir: 'desc',
	loading: true,
	error: false,
};

const LABELS = {
	fees: { noun: 'Fees', heading: 'Top Protocols by Fees', metric: 'fees' },
	revenue: { noun: 'Revenue', heading: 'Top Protocols by Revenue', metric: 'revenue' },
};

// ── Stat cards ──────────────────────────────────────────────────────────────

const ICONS = {
	coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
	week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
	month: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
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
	const el = $('fx-stats');
	const noun = LABELS[state.type].noun;
	const c1 = state.change_1d;
	const deltaClass = c1 == null ? '' : c1 >= 0 ? 'cv-up' : 'cv-down';
	const cards = [
		statCard({
			label: `24h ${noun}`,
			value: formatUsd(state.total24h),
			delta: c1 == null ? '' : `${formatPercent(c1)} vs prior day`,
			deltaClass,
			icon: 'coins',
		}),
		statCard({ label: `7d ${noun}`, value: formatUsd(state.total7d), icon: 'week' }),
		statCard({ label: `30d ${noun}`, value: formatUsd(state.total30d), icon: 'month' }),
	];
	el.innerHTML = `<div class="fx-stat-grid">${cards.join('')}</div>`;
}

function statsSkeleton() {
	$('fx-stats').innerHTML =
		'<div class="fx-stat-grid">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6rem"></div>').join('') +
		'</div>';
}

// ── Aggregate chart ─────────────────────────────────────────────────────────

const TIME_RANGES = [
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
	{ label: 'All', days: Infinity },
];

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 80, bottom: 30, left: 10 };

const chartState = { days: 365 };

// Slice the full aggregate series to the active range window.
function seriesForRange() {
	const s = state.chart;
	if (!s.length || chartState.days === Infinity) return s;
	const cutoff = s[s.length - 1].t - chartState.days * 86400_000;
	const win = s.filter((p) => p.t >= cutoff);
	return win.length >= 2 ? win : s.slice(-2);
}

function chartGeometry(series) {
	const vals = series.map((p) => p.value);
	const min = Math.min(...vals, 0);
	const max = Math.max(...vals);
	const range = max - min || 1;
	const w = CHART_W - PAD.left - PAD.right;
	const h = CHART_H - PAD.top - PAD.bottom;
	const pts = vals.map((v, i) => ({
		x: PAD.left + (series.length === 1 ? w / 2 : (i / (series.length - 1)) * w),
		y: PAD.top + h - ((v - min) / range) * h,
	}));
	const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
	const area = `${line} L${pts[pts.length - 1].x.toFixed(2)},${(PAD.top + h).toFixed(2)} L${pts[0].x.toFixed(2)},${(PAD.top + h).toFixed(2)} Z`;
	return { min, max, range, line, area };
}

function renderChart() {
	const el = $('fx-chart');
	const noun = LABELS[state.type].noun;
	const rangeBtns = TIME_RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days}" aria-pressed="${r.days === chartState.days}">${r.label}</button>`,
	).join('');

	const series = seriesForRange();
	let body;
	if (state.loading) {
		body = '<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading chart…</div>';
	} else if (state.error) {
		body = '<div class="cv-chart-state">Chart is temporarily unavailable.</div>';
	} else if (series.length < 2) {
		body = '<div class="cv-chart-state">No history available for this range.</div>';
	} else {
		const g = chartGeometry(series);
		const color = 'var(--cv-chart-green)';
		const steps = 4;
		const h = CHART_H - PAD.top - PAD.bottom;
		const yLabels = Array.from({ length: steps + 1 }, (_, i) => {
			const v = g.min + (g.range * i) / steps;
			const y = PAD.top + h - (i / steps) * h;
			return `<g><line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CHART_W - PAD.right + 8}" y="${y + 4}" font-size="10" fill="var(--cv-text-3)">${esc(formatUsd(v))}</text></g>`;
		}).join('');
		body = `
			<div class="cv-chart-area">
				<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"
					aria-label="Daily ${esc(noun.toLowerCase())} across all tracked protocols">
					<defs>
						<linearGradient id="fx-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
							<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${yLabels}
					<path d="${g.area}" fill="url(#fx-grad)"/>
					<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					<g id="fx-crosshair" hidden>
						<line id="fx-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="fx-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="fx-tip" hidden>
					<p class="p cv-mono" id="fx-tip-val"></p>
					<p class="d" id="fx-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Daily ${esc(noun)} · all protocols</span></div>
				<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
			</div>
			${body}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const dd = Number(btn.dataset.days);
			if (dd === chartState.days) return;
			chartState.days = dd;
			renderChart();
		});
	});

	wireChartPointer(series);
}

function wireChartPointer(series) {
	const svg = $('fx-chart').querySelector('svg');
	const tip = $('fx-tip');
	if (!svg || !tip || series.length < 2) return;
	const g = chartGeometry(series);
	const cross = svg.querySelector('#fx-crosshair');
	const crossLine = svg.querySelector('#fx-cross-line');
	const crossDot = svg.querySelector('#fx-cross-dot');
	const usableW = CHART_W - PAD.left - PAD.right;
	const usableH = CHART_H - PAD.top - PAD.bottom;

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
		const n = series.length;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mouseX - PAD.left) / usableW) * (n - 1))));
		const { t, value } = series[i];
		const x = PAD.left + (i / (n - 1)) * usableW;
		const y = PAD.top + usableH - ((value - g.min) / g.range) * usableH;
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);
		crossDot.setAttribute('cx', x);
		crossDot.setAttribute('cy', y);
		tip.hidden = false;
		tip.style.left = `${(x / CHART_W) * 100}%`;
		$('fx-tip-val').textContent = formatUsd(value);
		$('fx-tip-date').textContent = formatChartTick(t, chartState.days === Infinity ? 365 : chartState.days);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

// ── Table ───────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Protocol', left: true },
	{ key: 'category', label: 'Category', left: true, hide: 'hide-md' },
	{ key: 'chains', label: 'Chains', left: true, hide: 'hide-lg' },
	{ key: 'total24h', label: '24h', num: true },
	{ key: 'total7d', label: '7d', hide: 'hide-md', num: true },
	{ key: 'total30d', label: '30d', hide: 'hide-lg', num: true },
	{ key: 'change_1d', label: '24h Δ', num: true },
];

function pctCell(v, extraClass = '') {
	if (v == null) return `<td class="pct dim ${extraClass}">—</td>`;
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'} ${extraClass}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

function chainsCell(chains) {
	if (!chains || !chains.length) return '<td class="left dim hide-lg">—</td>';
	const shown = chains
		.slice(0, 3)
		.map(
			(c) =>
				`<a class="fx-chip" href="/chain/${encodeURIComponent(c)}">${esc(c)}</a>`,
		)
		.join('');
	const extra =
		chains.length > 3 ? `<span class="fx-more">+${chains.length - 3}</span>` : '';
	return `<td class="left hide-lg"><span class="fx-chips">${shown}${extra}</span></td>`;
}

function sortValue(p, key) {
	if (key === 'name') return (p.name || '').toLowerCase();
	if (key === 'category') return (p.category || '').toLowerCase();
	if (key === 'chains') return p.chains ? p.chains.length : 0;
	if (key === 'rank') return p.__rank ?? Infinity;
	return p[key] ?? -Infinity;
}

function sortedProtocols() {
	const ranked = [...state.protocols].sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0));
	ranked.forEach((p, i) => (p.__rank = i + 1));
	const { sortKey, sortDir } = state;
	const sorted = [...ranked].sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return sorted;
}

function nameCell(p) {
	const logo = p.logo
		? `<img src="${esc(p.logo)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />`
		: '<span class="fx-logo-fallback" aria-hidden="true"></span>';
	const inner = `${logo}<span class="nm">${esc(p.name)}</span>`;
	if (p.slug) {
		return `<td class="left name-cell"><a class="fx-name-link inner" href="/protocol/${encodeURIComponent(p.slug)}">${inner}</a></td>`;
	}
	return `<td class="left name-cell"><span class="inner">${inner}</span></td>`;
}

function renderTable() {
	const el = $('fx-table');

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
			'<div class="cv-empty">Fee data is temporarily unavailable. <button type="button" class="fx-retry">Try again</button> shortly.</div>';
		el.querySelector('.fx-retry')?.addEventListener('click', () => load(state.type));
		return;
	}
	if (!state.protocols.length) {
		el.innerHTML =
			'<div class="cv-empty">No protocols reporting fees right now. <button type="button" class="fx-retry">Refresh</button> to retry.</div>';
		el.querySelector('.fx-retry')?.addEventListener('click', () => load(state.type));
		return;
	}

	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const body = sortedProtocols()
		.map(
			(p) => `
			<tr>
				<td class="rank hide-sm cv-mono">${p.__rank}</td>
				${nameCell(p)}
				<td class="left dim hide-md">${p.category ? esc(p.category) : '—'}</td>
				${chainsCell(p.chains)}
				<td class="price">${esc(formatUsd(p.total24h))}</td>
				<td class="price hide-md">${esc(formatUsd(p.total7d))}</td>
				<td class="price hide-lg">${esc(formatUsd(p.total30d))}</td>
				${pctCell(p.change_1d)}
			</tr>`,
		)
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
}

// ── Toggle + URL sync ───────────────────────────────────────────────────────

function syncToggle() {
	for (const type of ['fees', 'revenue']) {
		const btn = $(`fx-tab-${type}`);
		if (btn) btn.setAttribute('aria-selected', String(type === state.type));
	}
	$('fx-table-heading').textContent = LABELS[state.type].heading;
	document.title = `${LABELS[state.type].noun === 'Fees' ? 'Protocol Fees & Revenue' : 'Protocol Revenue & Fees'} · three.ws`;
}

function wireToggle() {
	for (const type of ['fees', 'revenue']) {
		$(`fx-tab-${type}`)?.addEventListener('click', () => {
			if (state.type === type) return;
			const url = new URL(location.href);
			if (type === 'fees') url.searchParams.delete('type');
			else url.searchParams.set('type', 'revenue');
			history.replaceState(null, '', url);
			load(type);
		});
	}
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function load(type) {
	state.type = type === 'revenue' ? 'revenue' : 'fees';
	state.loading = true;
	state.error = false;
	syncToggle();
	statsSkeleton();
	renderChart();
	renderTable();
	try {
		const data = await getJson(`/api/defi/fees?type=${state.type}`);
		state.total24h = data.total24h ?? null;
		state.total7d = data.total7d ?? null;
		state.total30d = data.total30d ?? null;
		state.change_1d = data.change_1d ?? null;
		state.chart = Array.isArray(data.chart) ? data.chart : [];
		state.protocols = Array.isArray(data.protocols) ? data.protocols : [];
		state.updated_at = data.updated_at || Date.now();
		state.loading = false;
		state.error = false;
		renderStats();
		renderChart();
		renderTable();
		$('fx-updated').textContent =
			`Top ${state.protocols.length} protocols by ${LABELS[state.type].metric} · Data: DeFiLlama · updated ${new Date(state.updated_at).toLocaleTimeString('en-US')}`;
	} catch {
		state.loading = false;
		state.error = true;
		$('fx-stats').innerHTML = '';
		renderChart();
		renderTable();
		$('fx-updated').textContent = '';
	}
}

function initialType() {
	return new URLSearchParams(location.search).get('type') === 'revenue' ? 'revenue' : 'fees';
}

wireToggle();
load(initialType());
