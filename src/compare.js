// /compare — side-by-side coin comparison, adopted from the cryptocurrency.cv
// compare surface: an overlay of normalized price performance plus a stats
// table for up to four coins. Reuses the existing /api/coin proxies (search,
// detail, ohlc) — all data is real and cached, never mocked. The selection is
// mirrored to the URL (?ids=…) so a matchup is shareable.

import {
	formatUsd,
	formatPrice,
	formatPercent,
	formatSupply,
	formatDateShort,
	formatChartTick,
	escapeHtml as esc,
} from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const MAX_COINS = 4;
const COLORS = ['#3b82f6', '#f59e0b', '#22c55e', '#a855f7'];

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// state.coins: [{ id, color, detail, series }]
const state = { coins: [], days: 30, loadingChart: false };

const RANGES = [
	{ label: '7D', days: 7 },
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
];

function idsFromUrl() {
	const raw = new URL(location.href).searchParams.get('ids') || '';
	const ids = raw
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(s));
	const seen = new Set();
	const unique = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
	return unique.slice(0, MAX_COINS);
}

function syncUrl() {
	const ids = state.coins.map((c) => c.id).join(',');
	const url = new URL(location.href);
	if (ids) url.searchParams.set('ids', ids);
	else url.searchParams.delete('ids');
	history.replaceState(null, '', url);
}

function nextColor() {
	const used = new Set(state.coins.map((c) => c.color));
	return COLORS.find((c) => !used.has(c)) || COLORS[state.coins.length % COLORS.length];
}

// ── Add / remove ──────────────────────────────────────────────────────────────

async function addCoin(id) {
	id = id.toLowerCase();
	if (state.coins.length >= MAX_COINS) return;
	if (state.coins.find((c) => c.id === id)) return;
	const entry = { id, color: nextColor(), detail: null, series: null, error: false };
	state.coins.push(entry);
	renderChips();
	syncUrl();
	try {
		const { coin } = await getJson(`/api/coin/detail?id=${encodeURIComponent(id)}`);
		entry.detail = coin;
	} catch {
		entry.error = true;
	}
	renderChips();
	renderTable();
	await loadSeries(entry);
	renderChart();
}

function removeCoin(id) {
	state.coins = state.coins.filter((c) => c.id !== id);
	renderChips();
	renderTable();
	renderChart();
	syncUrl();
}

// ── Chips ─────────────────────────────────────────────────────────────────────

function renderChips() {
	const el = $('cmp-chips');
	el.innerHTML = state.coins
		.map((c) => {
			const d = c.detail;
			const name = d ? `${esc(d.name)}` : esc(c.id);
			const img = d?.image
				? `<img loading="lazy" decoding="async" src="${esc(d.image)}" alt="" width="18" height="18" data-no-dark-filter />`
				: `<span class="dot" style="background:${c.color}"></span>`;
			return `<span class="cmp-chip" style="border-color:${c.color}55">
				<span class="dot" style="background:${c.color}"></span>
				${img}
				<span>${name}${d?.symbol ? ` <span style="color:var(--cv-text-3)">${esc(d.symbol)}</span>` : ''}</span>
				<button type="button" data-remove="${esc(c.id)}" aria-label="Remove ${name}">×</button>
			</span>`;
		})
		.join('');
	el.querySelectorAll('button[data-remove]').forEach((b) =>
		b.addEventListener('click', () => removeCoin(b.dataset.remove)),
	);
}

// ── Overlay chart ─────────────────────────────────────────────────────────────

const CW = 760;
const CH = 300;
const PAD = { top: 16, right: 56, bottom: 26, left: 16 };

async function loadSeries(entry) {
	entry.series = null;
	try {
		const { data } = await getJson(
			`/api/coin/ohlc?id=${encodeURIComponent(entry.id)}&days=${state.days}`,
		);
		// Normalize to % change from the first point.
		const base = data[0]?.[1];
		entry.series = base
			? data
					.map(([ts, p]) => [ts, ((p - base) / base) * 100])
					.filter((d) => Number.isFinite(d[1]))
			: [];
	} catch {
		entry.series = [];
	}
}

async function reloadAllSeries() {
	state.loadingChart = true;
	renderChart();
	await Promise.all(state.coins.map(loadSeries));
	state.loadingChart = false;
	renderChart();
}

function chartGeometry() {
	const withData = state.coins.filter((c) => c.series && c.series.length >= 2);
	if (!withData.length) return null;
	let tMin = Infinity,
		tMax = -Infinity,
		vMin = Infinity,
		vMax = -Infinity;
	for (const c of withData) {
		for (const [t, v] of c.series) {
			if (t < tMin) tMin = t;
			if (t > tMax) tMax = t;
			if (v < vMin) vMin = v;
			if (v > vMax) vMax = v;
		}
	}
	const span = tMax - tMin || 1;
	const pad = (vMax - vMin) * 0.08 || 1;
	vMin -= pad;
	vMax += pad;
	const range = vMax - vMin || 1;
	const w = CW - PAD.left - PAD.right;
	const h = CH - PAD.top - PAD.bottom;
	const xOf = (t) => PAD.left + ((t - tMin) / span) * w;
	const yOf = (v) => PAD.top + h - ((v - vMin) / range) * h;
	return { withData, tMin, tMax, vMin, vMax, w, h, xOf, yOf };
}

function renderChart() {
	const el = $('cmp-chart');
	const rangeBtns = RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days}" aria-pressed="${r.days === state.days}">${r.label}</button>`,
	).join('');

	let body;
	if (!state.coins.length) {
		body = '<div class="cv-chart-state">Add a coin above to start comparing.</div>';
	} else if (state.loadingChart) {
		body =
			'<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading performance…</div>';
	} else {
		const g = chartGeometry();
		if (!g) {
			body =
				'<div class="cv-chart-state">Performance data unavailable for the current selection.</div>';
		} else {
			const h = CH - PAD.top - PAD.bottom;
			const steps = 4;
			const yLabels = Array.from({ length: steps + 1 }, (_, i) => {
				const v = g.vMin + (g.vMax - g.vMin) * (i / steps);
				const y = PAD.top + h - (i / steps) * h;
				return `<g><line x1="${PAD.left}" y1="${y}" x2="${CW - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CW - PAD.right + 6}" y="${y + 3}" font-size="10" fill="var(--cv-text-3)">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</text></g>`;
			}).join('');
			// Zero baseline (start-of-window) emphasized.
			const zeroY = g.yOf(0);
			const zeroLine =
				g.vMin < 0 && g.vMax > 0
					? `<line x1="${PAD.left}" y1="${zeroY}" x2="${CW - PAD.right}" y2="${zeroY}" stroke="var(--cv-text-3)" stroke-width="0.75" opacity="0.5"/>`
					: '';
			const paths = g.withData
				.map((c) => {
					const d = c.series
						.map(
							([t, v], i) =>
								`${i === 0 ? 'M' : 'L'}${g.xOf(t).toFixed(1)},${g.yOf(v).toFixed(1)}`,
						)
						.join(' ');
					return `<path d="${d}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
				})
				.join('');
			body = `
				<div class="cv-chart-area">
					<svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Normalized performance comparison over ${state.days} days">
						${yLabels}
						${zeroLine}
						${paths}
						<g id="cmp-cross" hidden>
							<line id="cmp-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CH - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						</g>
					</svg>
					<div class="cv-chart-tip" id="cmp-tip" hidden></div>
				</div>`;
		}
	}

	const legend = state.coins.length
		? `<div class="cmp-legend">${state.coins
				.map(
					(c) =>
						`<span class="li"><span class="dot" style="background:${c.color}"></span>${esc(c.detail?.symbol || c.id)}</span>`,
				)
				.join('')}</div>`
		: '';

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Performance (% change)</span></div>
				<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
			</div>
			${body}
			${legend}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const d = Number(btn.dataset.days);
			if (d === state.days) return;
			state.days = d;
			reloadAllSeries();
		});
	});
	wireChartPointer();
}

function wireChartPointer() {
	const svg = $('cmp-chart').querySelector('svg');
	const tip = $('cmp-tip');
	const g = chartGeometry();
	if (!svg || !tip || !g) return;
	const cross = svg.querySelector('#cmp-cross');
	const line = svg.querySelector('#cmp-cross-line');

	const nearest = (series, t) => {
		let best = series[0];
		let bd = Infinity;
		for (const p of series) {
			const d = Math.abs(p[0] - t);
			if (d < bd) {
				bd = d;
				best = p;
			}
		}
		return best;
	};

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mx = ((clientX - rect.left) / rect.width) * CW;
		const frac = Math.max(0, Math.min(1, (mx - PAD.left) / g.w));
		const t = g.tMin + frac * (g.tMax - g.tMin);
		const x = g.xOf(t);
		cross.removeAttribute('hidden');
		line.setAttribute('x1', x);
		line.setAttribute('x2', x);
		const rows = g.withData
			.map((c) => {
				const [, v] = nearest(c.series, t);
				return `<p class="r" style="display:flex;justify-content:space-between;gap:1rem;margin:0.0625rem 0"><span style="color:${c.color}">${esc(c.detail?.symbol || c.id)}</span><span class="cv-mono" style="color:var(--cv-text)">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span></p>`;
			})
			.join('');
		tip.hidden = false;
		tip.innerHTML = `<p class="d" style="margin:0 0 0.25rem">${esc(formatChartTick(t, state.days))}</p>${rows}`;
		tip.style.left = `${(x / CW) * 100}%`;
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

// ── Stats table ───────────────────────────────────────────────────────────────

const ROWS = [
	{ label: 'Price', get: (m) => m.price, fmt: formatPrice },
	{
		label: '24h %',
		get: (m) => m.change_pct?.h24,
		fmt: formatPercent,
		best: 'max',
		signed: true,
	},
	{ label: '7d %', get: (m) => m.change_pct?.d7, fmt: formatPercent, best: 'max', signed: true },
	{
		label: '30d %',
		get: (m) => m.change_pct?.d30,
		fmt: formatPercent,
		best: 'max',
		signed: true,
	},
	{ label: 'Market Cap', get: (m) => m.market_cap, fmt: formatUsd, best: 'max' },
	{ label: '24h Volume', get: (m) => m.volume_24h, fmt: formatUsd, best: 'max' },
	{ label: 'FDV', get: (m) => m.fdv, fmt: formatUsd },
	{ label: 'Circ. Supply', get: (m) => m.circulating, fmt: formatSupply },
	{ label: 'All-Time High', get: (m) => m.ath, fmt: formatPrice },
	{
		label: 'From ATH',
		get: (m) => m.ath_change_pct,
		fmt: formatPercent,
		best: 'max',
		signed: true,
	},
];

function renderTable() {
	const el = $('cmp-table');
	const ready = state.coins.filter((c) => c.detail);
	if (!state.coins.length) {
		el.innerHTML = '';
		return;
	}
	if (!ready.length) {
		el.innerHTML = '<div class="cv-skel" style="height:16rem"></div>';
		return;
	}

	const head = ready
		.map(
			(c) =>
				`<th><a class="coin" href="/coin/${encodeURIComponent(c.id)}" style="text-decoration:none;color:inherit">
					${c.detail.image ? `<img loading="lazy" decoding="async" src="${esc(c.detail.image)}" alt="" data-no-dark-filter />` : ''}
					<span style="color:${c.color}">${esc(c.detail.symbol || c.detail.name)}</span>
				</a></th>`,
		)
		.join('');

	const body = ROWS.map((row) => {
		const vals = ready.map((c) => row.get(c.detail.market));
		let bestIdx = -1;
		if (row.best === 'max') {
			let bv = -Infinity;
			vals.forEach((v, i) => {
				if (Number.isFinite(v) && v > bv) {
					bv = v;
					bestIdx = i;
				}
			});
		}
		const cells = vals
			.map((v, i) => {
				const cls = [];
				if (i === bestIdx && ready.length > 1) cls.push('best');
				if (row.signed && Number.isFinite(v)) cls.push(v >= 0 ? 'cv-up' : 'cv-down');
				return `<td class="${cls.join(' ')}">${esc(row.fmt(v))}</td>`;
			})
			.join('');
		return `<tr><td>${esc(row.label)}</td>${cells}</tr>`;
	}).join('');

	el.innerHTML = `
		<div class="cmp-table-wrap">
			<table class="cmp-table">
				<thead><tr><th></th>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;
}

// ── Search type-ahead (mirrors the /coins picker) ─────────────────────────────

function wireSearch() {
	const input = $('cmp-search-input');
	const pop = $('cmp-search-pop');
	let timer = null;
	let items = [];
	let active = -1;
	let lastQuery = '';

	const close = () => {
		pop.hidden = true;
		input.setAttribute('aria-expanded', 'false');
		active = -1;
	};

	function renderPop() {
		if (!items.length) {
			pop.innerHTML = `<div class="none">No coins match “${esc(lastQuery)}”.</div>`;
		} else {
			pop.innerHTML = items
				.map(
					(c, i) => `
				<a href="#" role="option" data-id="${esc(c.id)}" data-active="${i === active ? 1 : 0}" aria-selected="${i === active}">
					${c.thumb ? `<img loading="lazy" decoding="async" src="${esc(c.thumb)}" alt="" width="20" height="20" data-no-dark-filter />` : ''}
					<span>${esc(c.name)}</span>
					<span class="sym">${esc(c.symbol)}</span>
					${c.rank != null ? `<span class="rk">#${c.rank}</span>` : ''}
				</a>`,
				)
				.join('');
			pop.querySelectorAll('a[data-id]').forEach((a) =>
				a.addEventListener('click', (e) => {
					e.preventDefault();
					pick(a.dataset.id);
				}),
			);
		}
		pop.hidden = false;
		input.setAttribute('aria-expanded', 'true');
	}

	function pick(id) {
		addCoin(id);
		input.value = '';
		close();
		input.focus();
	}

	input.addEventListener('input', () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) return close();
		timer = setTimeout(async () => {
			try {
				const { coins } = await getJson(`/api/coin/markets?q=${encodeURIComponent(q)}`);
				lastQuery = q;
				items = coins.filter((c) => !state.coins.find((s) => s.id === c.id));
				active = -1;
				renderPop();
			} catch {
				close();
			}
		}, 250);
	});

	input.addEventListener('keydown', (e) => {
		if (pop.hidden) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			active = (active + dir + items.length) % Math.max(items.length, 1);
			renderPop();
		} else if (e.key === 'Enter' && active >= 0 && items[active]) {
			e.preventDefault();
			pick(items[active].id);
		} else if (e.key === 'Escape') {
			close();
		}
	});

	document.addEventListener('click', (e) => {
		if (!e.target.closest('#cmp-search')) close();
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
	wireSearch();
	renderChips();
	renderChart();
	// Default matchup so the page is never an empty void; overridable via ?ids=.
	const initial = idsFromUrl();
	const ids = initial.length ? initial : ['bitcoin', 'ethereum', 'solana'];
	for (const id of ids) await addCoin(id);
}

init();
