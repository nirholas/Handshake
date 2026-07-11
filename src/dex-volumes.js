// /dex-volumes — DEX volume rankings. Header stat cards (24h volume, 7d volume,
// 7d-over-prior-7d change), an aggregate SVG area chart with a range toggle +
// crosshair, and a sortable table of the top DEXs by 24h volume with an inline
// market-share bar. DEX names deep-link to /protocol/:slug and chain chips to
// /chain/:name. Data comes from /api/defi/dex-volumes (DeFiLlama, keyless),
// normalized server-side. Mirrors the /defi + /exchange + /fees page patterns:
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
	total24h: null,
	total7d: null,
	change_7dover7d: null,
	chart: [],
	protocols: [],
	updated_at: 0,
	sortKey: 'total24h',
	sortDir: 'desc',
	loading: true,
	error: false,
};

// ── Stat cards ──────────────────────────────────────────────────────────────

const ICONS = {
	swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
	week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
	trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
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
	const el = $('dx-stats');
	const c = state.change_7dover7d;
	const deltaClass = c == null ? '' : c >= 0 ? 'cv-up' : 'cv-down';
	const cards = [
		statCard({ label: '24h DEX Volume', value: formatUsd(state.total24h), icon: 'swap' }),
		statCard({ label: '7d DEX Volume', value: formatUsd(state.total7d), icon: 'week' }),
		statCard({
			label: '7d Change',
			value: c == null ? '—' : formatPercent(c),
			delta: 'vs prior 7 days',
			deltaClass,
			icon: 'trend',
		}),
	];
	el.innerHTML = `<div class="dx-stat-grid">${cards.join('')}</div>`;
}

function statsSkeleton() {
	$('dx-stats').innerHTML =
		'<div class="dx-stat-grid">' +
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
	const el = $('dx-chart');
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
		const color = 'var(--cv-accent)';
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
					aria-label="Daily DEX trading volume across all tracked venues">
					<defs>
						<linearGradient id="dx-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${color}" stop-opacity="0.24"/>
							<stop offset="100%" stop-color="${color}" stop-opacity="0.03"/>
						</linearGradient>
					</defs>
					${yLabels}
					<path d="${g.area}" fill="url(#dx-grad)"/>
					<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					<g id="dx-crosshair" hidden>
						<line id="dx-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="dx-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="dx-tip" hidden>
					<p class="p cv-mono" id="dx-tip-val"></p>
					<p class="d" id="dx-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Daily DEX Volume · all venues</span></div>
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
	const svg = $('dx-chart').querySelector('svg');
	const tip = $('dx-tip');
	if (!svg || !tip || series.length < 2) return;
	const g = chartGeometry(series);
	const cross = svg.querySelector('#dx-crosshair');
	const crossLine = svg.querySelector('#dx-cross-line');
	const crossDot = svg.querySelector('#dx-cross-dot');
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
		$('dx-tip-val').textContent = formatUsd(value);
		$('dx-tip-date').textContent = formatChartTick(t, chartState.days === Infinity ? 365 : chartState.days);
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
	{ key: 'name', label: 'DEX', left: true },
	{ key: 'chains', label: 'Chains', left: true, hide: 'hide-lg' },
	{ key: 'total24h', label: '24h Vol', num: true },
	{ key: 'total7d', label: '7d Vol', hide: 'hide-md', num: true },
	{ key: 'change_7d', label: 'Δ7d', num: true },
	{ key: 'share_pct', label: 'Share', left: true, hide: 'hide-md' },
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
		.map((c) => `<a class="dx-chip" href="/chain/${encodeURIComponent(c)}">${esc(c)}</a>`)
		.join('');
	const extra = chains.length > 3 ? `<span class="dx-more">+${chains.length - 3}</span>` : '';
	return `<td class="left hide-lg"><span class="dx-chips">${shown}${extra}</span></td>`;
}

function shareCell(share, maxShare) {
	const pct = Math.max(0, share || 0);
	const barPct = Math.max(2, (pct / maxShare) * 100);
	return `<td class="left hide-md dx-share-cell">
		<span class="dx-share">
			<span class="dx-share-bar" role="img" aria-label="${pct.toFixed(2)}% of total DEX volume">
				<span class="dx-share-fill" style="width:${barPct.toFixed(1)}%"></span>
			</span>
			<span class="dx-share-num cv-mono">${pct.toFixed(2)}%</span>
		</span>
	</td>`;
}

function nameCell(p) {
	const logo = p.logo
		? `<img src="${esc(p.logo)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />`
		: '<span class="dx-logo-fallback" aria-hidden="true"></span>';
	const inner = `${logo}<span class="nm">${esc(p.name)}</span>`;
	if (p.slug) {
		return `<td class="left name-cell"><a class="dx-name-link inner" href="/protocol/${encodeURIComponent(p.slug)}">${inner}</a></td>`;
	}
	return `<td class="left name-cell"><span class="inner">${inner}</span></td>`;
}

function sortValue(p, key) {
	if (key === 'name') return (p.name || '').toLowerCase();
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

function renderTable() {
	const el = $('dx-table');

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
			'<div class="cv-empty">DEX volume data is temporarily unavailable. <button type="button" class="dx-retry">Try again</button> shortly.</div>';
		el.querySelector('.dx-retry')?.addEventListener('click', () => load());
		return;
	}
	if (!state.protocols.length) {
		el.innerHTML =
			'<div class="cv-empty">No DEX volume to show right now. <button type="button" class="dx-retry">Refresh</button> to retry.</div>';
		el.querySelector('.dx-retry')?.addEventListener('click', () => load());
		return;
	}

	// The share bar scales to the leader so the top DEX fills the cell and the
	// rest read as a fraction of it — a clearer visual than raw share %.
	const maxShare = Math.max(...state.protocols.map((p) => p.share_pct || 0), 0.0001);

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
				${chainsCell(p.chains)}
				<td class="price">${esc(formatUsd(p.total24h))}</td>
				<td class="price hide-md">${esc(formatUsd(p.total7d))}</td>
				${pctCell(p.change_7d)}
				${shareCell(p.share_pct, maxShare)}
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
				state.sortDir = key === 'name' ? 'asc' : 'desc';
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

// ── Boot ────────────────────────────────────────────────────────────────────

async function load() {
	state.loading = true;
	state.error = false;
	statsSkeleton();
	renderChart();
	renderTable();
	try {
		const data = await getJson('/api/defi/dex-volumes');
		state.total24h = data.total24h ?? null;
		state.total7d = data.total7d ?? null;
		state.change_7dover7d = data.change_7dover7d ?? null;
		state.chart = Array.isArray(data.chart) ? data.chart : [];
		state.protocols = Array.isArray(data.protocols) ? data.protocols : [];
		state.updated_at = data.updated_at || Date.now();
		state.loading = false;
		state.error = false;
		renderStats();
		renderChart();
		renderTable();
		$('dx-updated').textContent =
			`Top ${state.protocols.length} DEXs by 24h volume · Data: DeFiLlama · updated ${new Date(state.updated_at).toLocaleTimeString('en-US')}`;
	} catch {
		state.loading = false;
		state.error = true;
		$('dx-stats').innerHTML = '';
		renderChart();
		renderTable();
		$('dx-updated').textContent = '';
	}
}

load();
