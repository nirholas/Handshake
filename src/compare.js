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

// state.coins: [{ id, color, detail, series, status, seriesError }]
// status: 'loading' while /api/coin/detail is in flight, 'ready' once it lands,
// 'missing' when the id does not exist (404), 'failed' for anything else. Every
// non-ready status is surfaced in the UI; none of them is allowed to leave a
// skeleton on screen forever.
const state = { coins: [], days: 30, loadingChart: false, booting: true };

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

async function loadDetail(entry) {
	entry.status = 'loading';
	try {
		const { coin } = await getJson(`/api/coin/detail?id=${encodeURIComponent(entry.id)}`);
		entry.detail = coin;
		entry.status = 'ready';
	} catch (err) {
		entry.detail = null;
		entry.status = err.status === 404 ? 'missing' : 'failed';
	}
}

/** Returns why the add was refused, or 'added' once the coin has been fetched. */
async function addCoin(id) {
	id = id.toLowerCase();
	if (state.coins.length >= MAX_COINS) return 'full';
	if (state.coins.find((c) => c.id === id)) return 'duplicate';
	const entry = { id, color: nextColor(), detail: null, series: null, status: 'loading' };
	state.coins.push(entry);
	renderChips();
	renderTable();
	renderChart();
	syncUrl();
	await loadDetail(entry);
	renderChips();
	renderTable();
	await loadSeries(entry);
	renderChart();
	return entry.status === 'ready' ? 'added' : entry.status;
}

function removeCoin(id) {
	state.coins = state.coins.filter((c) => c.id !== id);
	renderChips();
	renderTable();
	renderChart();
	syncUrl();
}

/** Re-fetch every coin whose detail request failed on a transport error. */
async function retryFailed() {
	const failed = state.coins.filter((c) => c.status === 'failed');
	if (!failed.length) return;
	for (const c of failed) c.status = 'loading';
	renderChips();
	renderTable();
	await Promise.all(failed.map(loadDetail));
	renderChips();
	renderTable();
	await Promise.all(failed.map(loadSeries));
	renderChart();
}

function dropUnresolved(status) {
	const keep = state.coins.filter((c) => c.status !== status);
	if (keep.length === state.coins.length) return;
	state.coins = keep;
	renderChips();
	renderTable();
	renderChart();
	syncUrl();
}

// ── Chips ─────────────────────────────────────────────────────────────────────

const CHIP_NOTE = {
	loading: 'Loading',
	missing: 'Not found',
	failed: 'Failed to load',
};

function renderChips() {
	const el = $('cmp-chips');
	el.innerHTML = state.coins
		.map((c) => {
			const d = c.detail;
			const name = d ? `${esc(d.name)}` : esc(c.id);
			const img = d?.image
				? `<img loading="lazy" decoding="async" src="${esc(d.image)}" alt="" width="18" height="18" data-no-dark-filter />`
				: `<span class="dot" style="background:${c.color}"></span>`;
			const note = CHIP_NOTE[c.status];
			const state_ = c.status && c.status !== 'ready' ? ` data-state="${c.status}"` : '';
			return `<span class="cmp-chip" role="listitem"${state_} style="border-color:${c.color}55">
				<span class="dot" style="background:${c.color}"></span>
				${img}
				<span>${name}${d?.symbol ? ` <span style="color:var(--cv-text-3)">${esc(d.symbol)}</span>` : ''}</span>
				${note ? `<span class="note">${note}</span>` : ''}
				<button type="button" data-remove="${esc(c.id)}" aria-label="Remove ${name}">×</button>
			</span>`;
		})
		.join('');
	el.querySelectorAll('button[data-remove]').forEach((b) =>
		b.addEventListener('click', () => removeCoin(b.dataset.remove)),
	);
	syncPicker();
}

/** The picker has to say why it is closed once four coins are on screen. */
function syncPicker() {
	const input = $('cmp-search-input');
	const hint = $('cmp-limit-hint');
	const share = $('cmp-share');
	const full = state.coins.length >= MAX_COINS;
	if (input) {
		input.disabled = full;
		input.placeholder = full
			? 'Four coins is the maximum'
			: `Add a coin to compare (up to ${MAX_COINS})…`;
	}
	if (hint) hint.hidden = !full;
	if (share) share.disabled = !state.coins.length;
}

// ── Overlay chart ─────────────────────────────────────────────────────────────

const CW = 760;
const CH = 300;
const PAD = { top: 16, right: 56, bottom: 26, left: 16 };

async function loadSeries(entry) {
	entry.series = null;
	entry.seriesError = false;
	if (entry.status === 'missing') {
		entry.series = [];
		return;
	}
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
		entry.seriesError = true;
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

	const pending =
		state.loadingChart ||
		state.coins.some((c) => c.status === 'loading' || (c.series === null && c.status !== 'missing'));

	let body;
	if (!state.coins.length) {
		body = state.booting
			? '<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading comparison…</div>'
			: '<div class="cv-chart-state">Add a coin with the search box to start comparing.</div>';
	} else if (pending) {
		body =
			'<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading performance…</div>';
	} else {
		const g = chartGeometry();
		if (!g) {
			// Every coin came back without a usable series. Say which failure it was
			// and give the user the one control that can fix it.
			const transport = state.coins.some((c) => c.seriesError || c.status === 'failed');
			body = `<div class="cv-chart-state col" role="alert">
					<p>${
						transport
							? 'Performance data could not be loaded. The market data service did not respond.'
							: 'No performance history is published for this selection over the last ' +
								state.days +
								' days.'
					}</p>
					<button type="button" class="cv-linkbtn" id="cmp-chart-retry">${transport ? 'Retry' : 'Reload'}</button>
				</div>`;
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

	// A coin the overlay could not draw still owns a legend slot, labelled so the
	// missing line reads as a known gap rather than a rendering bug.
	const legend = state.coins.length
		? `<div class="cmp-legend">${state.coins
				.map((c) => {
					const drawn = !pending && c.series && c.series.length >= 2;
					return `<span class="li${drawn ? '' : ' na'}"><span class="dot" style="background:${c.color}"></span>${esc(c.detail?.symbol || c.id)}${
						pending || drawn ? '' : ' <span class="tag">no data</span>'
					}</span>`;
				})
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
	el.querySelector('#cmp-chart-retry')?.addEventListener('click', () => reloadAllSeries());
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
		// Clamped so the tooltip never hangs off the panel and drags the page into
		// a horizontal scroll on a narrow viewport.
		tip.style.left = `${Math.max(14, Math.min(86, (x / CW) * 100))}%`;
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

function listIds(coins) {
	return coins.map((c) => `<strong>${esc(c.detail?.name || c.id)}</strong>`).join(', ');
}

/** Anything the selection asked for and the API could not give back. */
function issuesHtml() {
	const missing = state.coins.filter((c) => c.status === 'missing');
	const failed = state.coins.filter((c) => c.status === 'failed');
	if (!missing.length && !failed.length) return '';
	const lines = [];
	if (failed.length)
		lines.push(
			`<p>Could not load ${listIds(failed)}. The market data service did not respond.</p>`,
		);
	if (missing.length)
		lines.push(
			`<p>No coin matches ${listIds(missing)}. Use the search box to pick one that exists.</p>`,
		);
	const acts = [
		failed.length
			? '<button type="button" class="cv-linkbtn" data-retry-failed>Retry</button>'
			: '',
		missing.length
			? `<button type="button" class="cv-linkbtn" data-drop-missing>Remove ${missing.length > 1 ? 'them' : 'it'}</button>`
			: '',
	].join('');
	return `<div class="cmp-issues" role="alert">${lines.join('')}<div class="acts">${acts}</div></div>`;
}

function wireIssueActions(el) {
	el.querySelector('[data-retry-failed]')?.addEventListener('click', retryFailed);
	el.querySelector('[data-drop-missing]')?.addEventListener('click', () =>
		dropUnresolved('missing'),
	);
}

function renderTable() {
	const el = $('cmp-table');
	const ready = state.coins.filter((c) => c.detail);
	if (!state.coins.length) {
		el.innerHTML = '';
		return;
	}
	const issues = issuesHtml();
	if (!ready.length) {
		// Never leave the skeleton up once every request has settled: a permanent
		// shimmer reads as a hung page, not as a failure the user can act on.
		const stillLoading = state.coins.some((c) => c.status === 'loading');
		el.innerHTML = issues + (stillLoading ? '<div class="cv-skel" style="height:16rem"></div>' : '');
		wireIssueActions(el);
		return;
	}

	const head = ready
		.map(
			(c) =>
				`<th scope="col"><a class="coin" href="/coin/${encodeURIComponent(c.id)}" style="text-decoration:none;color:inherit">
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
		return `<tr><th scope="row">${esc(row.label)}</th>${cells}</tr>`;
	}).join('');

	el.innerHTML = `
		${issues}
		<div class="cmp-table-wrap">
			<table class="cmp-table">
				<caption class="cv-sr-only">Key market statistics for the selected coins, best value in each row highlighted.</caption>
				<thead><tr><th scope="col"><span class="cv-sr-only">Metric</span></th>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;
	wireIssueActions(el);
}

// ── Search type-ahead (mirrors the /coins picker) ─────────────────────────────

function wireSearch() {
	const input = $('cmp-search-input');
	const pop = $('cmp-search-pop');
	let timer = null;
	let items = [];
	let active = -1;
	let lastQuery = '';
	// Monotonic id for the in-flight query, so a slow response cannot land on top
	// of a newer one when the upstream index is cold.
	let seq = 0;

	const close = () => {
		seq++;
		pop.hidden = true;
		input.setAttribute('aria-expanded', 'false');
		input.removeAttribute('aria-activedescendant');
		active = -1;
	};

	const openPop = (html) => {
		pop.innerHTML = html;
		pop.hidden = false;
		input.setAttribute('aria-expanded', 'true');
		input.removeAttribute('aria-activedescendant');
	};

	function renderPop() {
		if (!items.length) {
			pop.innerHTML = `<div class="none">No coins match “${esc(lastQuery)}”.</div>`;
			input.removeAttribute('aria-activedescendant');
		} else {
			// Picking an option adds a comparison column, it does not navigate, so an
			// option is a listbox option and never a link. Focus stays on the input
			// (the combobox pattern); aria-activedescendant is what moves.
			pop.innerHTML = items
				.map(
					(c, i) => `
				<div id="cmp-opt-${i}" role="option" data-id="${esc(c.id)}" data-active="${i === active ? 1 : 0}" aria-selected="${i === active}">
					${c.thumb ? `<img loading="lazy" decoding="async" src="${esc(c.thumb)}" alt="" width="20" height="20" data-no-dark-filter />` : ''}
					<span>${esc(c.name)}</span>
					<span class="sym">${esc(c.symbol)}</span>
					${c.rank != null ? `<span class="rk">#${c.rank}</span>` : ''}
				</div>`,
				)
				.join('');
			pop.querySelectorAll('[data-id]').forEach((opt) =>
				opt.addEventListener('click', () => pick(opt.dataset.id)),
			);
			if (active >= 0) input.setAttribute('aria-activedescendant', `cmp-opt-${active}`);
			else input.removeAttribute('aria-activedescendant');
		}
		pop.hidden = false;
		input.setAttribute('aria-expanded', 'true');
	}

	async function pick(id) {
		input.value = '';
		close();
		const outcome = await addCoin(id);
		if (outcome === 'full') announce(`Remove a coin first. ${MAX_COINS} is the maximum.`);
		else if (!$('cmp-search-input').disabled) $('cmp-search-input').focus();
	}

	input.addEventListener('input', () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) return close();
		timer = setTimeout(async () => {
			const mine = ++seq;
			lastQuery = q;
			// The coin index can take several seconds on a cold cache; an empty
			// dropdown for that long reads as a broken search box.
			items = [];
			active = -1;
			openPop(
				'<div class="none"><span class="cv-spinner" aria-hidden="true"></span>Searching coins…</div>',
			);
			try {
				const { coins } = await getJson(`/api/coin/markets?q=${encodeURIComponent(q)}`);
				// A slower earlier query must never overwrite a later one.
				if (mine !== seq) return;
				items = coins.filter((c) => !state.coins.find((s) => s.id === c.id));
				active = -1;
				renderPop();
			} catch {
				if (mine !== seq) return;
				// A silent close reads as a dead search box. Say what happened.
				items = [];
				active = -1;
				openPop(
					'<div class="none">Coin search is unavailable right now. Check your connection and type again.</div>',
				);
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

// ── Status line + share ───────────────────────────────────────────────────────

let announceTimer = null;

/** One polite live region for outcomes that have no other place to land. */
function announce(message) {
	const el = $('cmp-status');
	if (!el) return;
	el.textContent = message;
	clearTimeout(announceTimer);
	announceTimer = setTimeout(() => {
		if (el.textContent === message) el.textContent = '';
	}, 6000);
}

function wireShare() {
	const btn = $('cmp-share');
	if (!btn) return;
	btn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(location.href);
			announce('Matchup link copied to the clipboard.');
		} catch {
			// Clipboard access can be refused (insecure origin, denied permission).
			// The URL is already the shareable artifact, so point at it.
			announce('Copying was blocked by the browser. The matchup link is in the address bar.');
		}
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
	wireSearch();
	wireShare();
	renderChips();
	renderChart();
	// Default matchup so the page is never an empty void; overridable via ?ids=.
	const initial = idsFromUrl();
	const ids = initial.length ? initial : ['bitcoin', 'ethereum', 'solana'];
	// Parallel: three sequential round trips left the panel loading far longer
	// than the slowest single request needed.
	await Promise.all(ids.map(addCoin));
	state.booting = false;
	renderChips();
	renderTable();
	renderChart();
}

init();
