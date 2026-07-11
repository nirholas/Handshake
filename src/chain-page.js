// /chain/:name — rich profile for one blockchain, part of the three.ws Markets
// surface. Hero (chain name + native-token / chainId / rank / dominance chips),
// stat cards (TVL, share of DeFi, stablecoin supply, 24h DEX volume, 24h fees,
// protocol count), three interactive SVG charts (TVL history, stablecoin supply,
// DEX volume) each with a range toggle and crosshair tooltip, and a sortable
// table of the top protocols deployed on the chain (each linking to its
// /protocol/:slug page). Data comes from the /api/defi/chain proxy (DeFiLlama) —
// never mocked. Mirrors the /exchange/:id detail-page pattern (src/exchange-page.js).

import {
	formatUsd,
	formatPercent,
	formatChartTick,
	escapeHtml as esc,
} from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

// Matches the /chain/:name route; falls back to the ?name= query for direct
// links and dev proxies that don't rewrite the path.
function nameFromLocation() {
	const m = location.pathname.match(/^\/chain\/([A-Za-z0-9 ._%-]{1,40})$/);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch {
			return m[1];
		}
	}
	const q = new URLSearchParams(location.search).get('name');
	return q && /^[A-Za-z0-9 ._-]{1,40}$/.test(q) ? q : null;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── Skeletons ────────────────────────────────────────────────────────────────

function renderSkeletons() {
	$('ch-hero').innerHTML = `
		<div class="ch-hero">
			<div class="cv-skel" style="width:14rem;height:2.25rem"></div>
			<div class="cv-skel" style="width:26rem;max-width:100%;height:1.5rem;margin-top:0.875rem"></div>
		</div>`;
	$('ch-stats').innerHTML =
		'<div class="cv-stats-grid">' +
		Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:5.5rem"></div>').join('') +
		'</div>';
	$('ch-tvl-chart').innerHTML =
		'<div class="cv-chart-panel"><div class="cv-skel" style="height:300px;border-radius:8px"></div></div>';
	$('ch-stable-chart').innerHTML = '';
	$('ch-dex-chart').innerHTML = '';
	$('ch-protocols').innerHTML = `
		<h2 class="cv-h2">Top protocols</h2>
		<div class="cv-table-wrap" style="padding:0.75rem">
			${Array.from({ length: 8 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('')}
		</div>`;
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function chip(text, title) {
	return `<span class="ch-chip"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function renderHero(c) {
	$('ch-crumb-name').textContent = c.name;
	const chips = [];
	if (c.token_symbol) chips.push(chip(c.token_symbol, 'Native token'));
	if (c.chain_id != null) chips.push(chip(`Chain ID ${c.chain_id}`, 'EVM chain ID'));
	if (c.rank != null)
		chips.push(`<span class="ch-chip ch-chip-rank" title="Rank by total value locked">#${esc(String(c.rank))} by TVL</span>`);
	if (c.share_pct != null)
		chips.push(chip(`${c.share_pct.toFixed(2)}% of DeFi TVL`, "This chain's dominance share of all on-chain DeFi TVL"));

	$('ch-hero').innerHTML = `
		<div class="ch-hero">
			<div class="ch-title-row">
				<h1 class="cv-h1 ch-title">${esc(c.name)}</h1>
			</div>
			${chips.length ? `<div class="ch-meta">${chips.join('')}</div>` : ''}
			<p class="ch-lede">
				Total value locked, stablecoin supply, DEX volume, fees, and the protocols
				deployed on ${esc(c.name)} — live from DeFiLlama.
			</p>
			<p class="ch-back"><a href="/chains">← All chains by TVL</a></p>
		</div>`;
}

// ── Stat cards ───────────────────────────────────────────────────────────────

function statCard({ label, value, sub }) {
	return `
		<div class="cv-mini-stat ch-stat">
			<p class="label">${esc(label)}</p>
			<p class="value cv-mono">${esc(value)}</p>
			${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
		</div>`;
}

function renderStats(payload) {
	const c = payload.chain;
	const cards = [];
	cards.push(statCard({ label: 'Total Value Locked', value: formatUsd(c.tvl) }));
	if (c.share_pct != null)
		cards.push(
			statCard({
				label: 'Share of DeFi',
				value: `${c.share_pct.toFixed(2)}%`,
				sub: c.rank != null ? `Rank #${c.rank}` : undefined,
			}),
		);
	if (payload.stablecoins && payload.stablecoins.total != null)
		cards.push(statCard({ label: 'Stablecoin Supply', value: formatUsd(payload.stablecoins.total) }));
	if (payload.dex && payload.dex.total24h != null)
		cards.push(
			statCard({
				label: '24h DEX Volume',
				value: formatUsd(payload.dex.total24h),
				sub: payload.dex.total7d != null ? `${formatUsd(payload.dex.total7d)} 7d` : undefined,
			}),
		);
	if (payload.fees && payload.fees.total24h != null)
		cards.push(
			statCard({
				label: '24h Fees',
				value: formatUsd(payload.fees.total24h),
				sub: payload.fees.total7d != null ? `${formatUsd(payload.fees.total7d)} 7d` : undefined,
			}),
		);
	if (payload.protocol_count != null)
		cards.push(statCard({ label: 'Protocols', value: payload.protocol_count.toLocaleString('en-US') }));

	$('ch-stats').innerHTML = `<div class="cv-stats-grid">${cards.join('')}</div>`;
}

// ── Reusable SVG area chart with range toggle + crosshair ────────────────────

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 84, bottom: 30, left: 10 };

const RANGES = [
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
	{ label: 'All', days: Infinity },
];

// Build a self-contained chart instance bound to a container. `series` is the
// full history [{ t, value }]; the range toggle slices it client-side (the API
// already returns full downsampled history, so no refetch is needed).
function makeChart({ el, title, series, color, format }) {
	const state = { days: rangeDefault(series), series };

	function visible() {
		if (!Number.isFinite(state.days)) return state.series;
		const cutoff = Date.now() - state.days * 86_400_000;
		const win = state.series.filter((p) => p.t >= cutoff);
		return win.length >= 2 ? win : state.series;
	}

	function geometry(pts) {
		const vals = pts.map((p) => p.value);
		const min = Math.min(...vals, 0);
		const max = Math.max(...vals);
		const range = max - min || 1;
		const w = CHART_W - PAD.left - PAD.right;
		const h = CHART_H - PAD.top - PAD.bottom;
		const coords = pts.map((p, i) => ({
			x: PAD.left + (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w),
			y: PAD.top + h - ((p.value - min) / range) * h,
		}));
		const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
		const area = `${line} L${coords[coords.length - 1].x.toFixed(2)},${(PAD.top + h).toFixed(2)} L${coords[0].x.toFixed(2)},${(PAD.top + h).toFixed(2)} Z`;
		return { min, max, range, coords, line, area };
	}

	function draw() {
		const pts = visible();
		const rangeBtns = RANGES.map(
			(r) =>
				`<button type="button" class="cv-range-btn" data-days="${r.days}" aria-pressed="${r.days === state.days}">${r.label}</button>`,
		).join('');

		let body;
		if (pts.length < 2) {
			body = '<div class="cv-chart-state">No history available for this range.</div>';
		} else {
			const g = geometry(pts);
			const steps = 4;
			const h = CHART_H - PAD.top - PAD.bottom;
			const yLabels = Array.from({ length: steps + 1 }, (_, i) => {
				const v = g.min + (g.range * i) / steps;
				const y = PAD.top + h - (i / steps) * h;
				return `<g><line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CHART_W - PAD.right + 8}" y="${y + 4}" font-size="10" fill="var(--cv-text-3)">${esc(format(v))}</text></g>`;
			}).join('');
			const gid = `grad-${title.replace(/\W+/g, '')}`;
			body = `
				<div class="cv-chart-area">
					<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${esc(title)} history">
						<defs>
							<linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
								<stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
								<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
							</linearGradient>
						</defs>
						${yLabels}
						<path d="${g.area}" fill="url(#${gid})"/>
						<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						<g class="ch-crosshair" hidden>
							<line class="ch-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
							<circle class="ch-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
						</g>
					</svg>
					<div class="cv-chart-tip" hidden>
						<p class="p cv-mono ch-tip-val"></p>
						<p class="d ch-tip-date"></p>
					</div>
				</div>`;
		}

		el.innerHTML = `
			<div class="cv-chart-panel">
				<div class="cv-chart-bar">
					<div class="left"><span class="title">${esc(title)}</span></div>
					<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
				</div>
				${body}
			</div>`;

		el.querySelectorAll('.cv-range-btn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const dd = Number(btn.dataset.days);
				if (dd === state.days) return;
				state.days = dd;
				draw();
			});
		});

		wirePointer(pts);
	}

	function wirePointer(pts) {
		const svg = el.querySelector('svg');
		const tip = el.querySelector('.cv-chart-tip');
		if (!svg || !tip || pts.length < 2) return;
		const g = geometry(pts);
		const cross = svg.querySelector('.ch-crosshair');
		const crossLine = svg.querySelector('.ch-cross-line');
		const crossDot = svg.querySelector('.ch-cross-dot');
		const usableW = CHART_W - PAD.left - PAD.right;
		const usableH = CHART_H - PAD.top - PAD.bottom;
		const days = Number.isFinite(state.days) ? state.days : 3650;

		const show = (clientX) => {
			const rect = svg.getBoundingClientRect();
			const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
			const n = pts.length;
			const i = Math.max(0, Math.min(n - 1, Math.round(((mouseX - PAD.left) / usableW) * (n - 1))));
			const p = pts[i];
			const x = PAD.left + (i / (n - 1)) * usableW;
			const y = PAD.top + usableH - ((p.value - g.min) / g.range) * usableH;
			cross.removeAttribute('hidden');
			crossLine.setAttribute('x1', x);
			crossLine.setAttribute('x2', x);
			crossDot.setAttribute('cx', x);
			crossDot.setAttribute('cy', y);
			tip.hidden = false;
			tip.style.left = `${(x / CHART_W) * 100}%`;
			tip.querySelector('.ch-tip-val').textContent = format(p.value);
			tip.querySelector('.ch-tip-date').textContent = formatChartTick(p.t, days);
		};
		const hide = () => {
			cross.setAttribute('hidden', '');
			tip.hidden = true;
		};
		svg.addEventListener('pointermove', (e) => show(e.clientX));
		svg.addEventListener('pointerleave', hide);
		svg.addEventListener('pointerdown', (e) => show(e.clientX));
	}

	draw();
}

// Default range: the tightest window that still shows ≥2 points, so a young
// chain with only weeks of history doesn't open on an empty "1Y" view.
function rangeDefault(series) {
	for (const days of [30, 90, 365]) {
		const cutoff = Date.now() - days * 86_400_000;
		if (series.filter((p) => p.t >= cutoff).length >= 2) return days;
	}
	return Infinity;
}

// ── Top-protocols table (sortable) ───────────────────────────────────────────

const protoState = { rows: [], sort: 'tvl', dir: -1, chainName: '' };

function sortRows() {
	const { rows, sort, dir } = protoState;
	const keyed = rows.slice().sort((a, b) => {
		let av;
		let bv;
		if (sort === 'name') {
			av = (a.name || '').toLowerCase();
			bv = (b.name || '').toLowerCase();
			return av < bv ? -dir : av > bv ? dir : 0;
		}
		if (sort === 'category') {
			av = (a.category || '').toLowerCase();
			bv = (b.category || '').toLowerCase();
			return av < bv ? -dir : av > bv ? dir : 0;
		}
		av = sort === 'change_7d' ? (a.change_7d ?? -Infinity) : (a.tvl_on_chain ?? -Infinity);
		bv = sort === 'change_7d' ? (b.change_7d ?? -Infinity) : (b.tvl_on_chain ?? -Infinity);
		return (av - bv) * dir;
	});
	return keyed;
}

function changeCell(v) {
	if (v == null || !Number.isFinite(v)) return '<span class="dim">—</span>';
	return `<span class="${v >= 0 ? 'cv-up' : 'cv-down'}">${esc(formatPercent(v))}</span>`;
}

function protoRow(p) {
	const label = esc(p.name || 'Unknown');
	const logo = p.logo
		? `<img class="ch-proto-logo" src="${esc(p.logo)}" alt="" width="22" height="22" loading="lazy" data-no-dark-filter />`
		: '<span class="ch-proto-logo ch-proto-logo-fallback" aria-hidden="true"></span>';
	const nameCell = p.slug
		? `<a class="ch-proto-link" href="/protocol/${encodeURIComponent(p.slug)}">${logo}<span>${label}</span></a>`
		: `<span class="ch-proto-link">${logo}<span>${label}</span></span>`;
	return `
		<tr>
			<td class="left"><span class="ch-proto">${nameCell}</span></td>
			<td>${p.category ? esc(p.category) : '<span class="dim">—</span>'}</td>
			<td class="cv-mono">${esc(formatUsd(p.tvl_on_chain))}</td>
			<td class="cv-mono">${changeCell(p.change_7d)}</td>
		</tr>`;
}

function sortHeader(key, label, extraClass) {
	const active = protoState.sort === key;
	const arrow = active ? (protoState.dir === -1 ? ' ▼' : ' ▲') : '';
	return `<th scope="col" class="ch-sortable${extraClass ? ` ${extraClass}` : ''}${active ? ' active' : ''}" data-sort="${key}" role="button" tabindex="0" aria-sort="${active ? (protoState.dir === -1 ? 'descending' : 'ascending') : 'none'}">${esc(label)}${arrow}</th>`;
}

function renderProtocols(payload) {
	const el = $('ch-protocols');
	protoState.rows = Array.isArray(payload.protocols) ? payload.protocols : [];
	protoState.chainName = payload.chain.name;

	if (!protoState.rows.length) {
		el.innerHTML = `
			<div class="cv-toolbar">
				<h2 class="cv-h2" style="margin:0">Top protocols</h2>
				<a class="cv-pill" href="/defi">All protocols →</a>
			</div>
			<div class="cv-empty">No DeFi protocols are reporting TVL on ${esc(payload.chain.name)} right now. Once a protocol deploys and reports here, it will appear in this table.</div>`;
		return;
	}
	drawProtoTable();
}

function drawProtoTable() {
	const el = $('ch-protocols');
	const rows = sortRows();
	const total = protoState.rows.length;
	const note =
		protoState.chainName && total >= 50
			? `<p class="ch-mkt-note">Showing the top 50 protocols by TVL on ${esc(protoState.chainName)}.</p>`
			: '';

	el.innerHTML = `
		<div class="cv-toolbar">
			<h2 class="cv-h2" style="margin:0">Top protocols</h2>
			<a class="cv-pill" href="/defi">All protocols →</a>
		</div>
		<div class="cv-table-wrap">
			<table class="cv-table ch-proto-table">
				<thead>
					<tr>
						${sortHeader('name', 'Protocol', 'left')}
						${sortHeader('category', 'Category')}
						${sortHeader('tvl', 'TVL on chain')}
						${sortHeader('change_7d', '7d')}
					</tr>
				</thead>
				<tbody>${rows.map(protoRow).join('')}</tbody>
			</table>
		</div>
		${note}`;

	el.querySelectorAll('.ch-sortable').forEach((th) => {
		const apply = () => {
			const key = th.dataset.sort;
			if (protoState.sort === key) protoState.dir *= -1;
			else {
				protoState.sort = key;
				// Text columns default A→Z; numeric columns default high→low.
				protoState.dir = key === 'name' || key === 'category' ? 1 : -1;
			}
			drawProtoTable();
		};
		th.addEventListener('click', apply);
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				apply();
			}
		});
	});
}

// ── Error / not-found states ─────────────────────────────────────────────────

function clearSections() {
	$('ch-stats').innerHTML = '';
	$('ch-tvl-chart').innerHTML = '';
	$('ch-stable-chart').innerHTML = '';
	$('ch-dex-chart').innerHTML = '';
	$('ch-protocols').innerHTML = '';
}

function renderNotFound(name) {
	$('ch-crumb-name').textContent = 'Not found';
	$('ch-hero').innerHTML = `
		<h1 class="cv-h1">Chain not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find a blockchain for “${esc(name)}”. It may not be
			tracked by the market-data source, or the name is misspelled.</p>
			<p style="margin:0">Browse the <a href="/chains">chains directory</a> or head back to
			<a href="/markets">Markets</a>.</p>
		</div>`;
	clearSections();
}

function renderError() {
	$('ch-hero').innerHTML = `
		<h1 class="cv-h1">Chain data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">The market-data source is temporarily unreachable. This usually
			clears within a minute.</p>
			<button type="button" class="ch-retry" id="ch-retry">Retry</button>
			<span style="margin-left:0.75rem">or return to the <a href="/chains">chains directory</a>.</span>
		</div>`;
	clearSections();
	$('ch-retry')?.addEventListener('click', () => main());
}

// ── SEO / document metadata ──────────────────────────────────────────────────

function updateMeta(c) {
	const title = `${c.name} — Chain TVL · three.ws`;
	document.title = title;
	const url = `https://three.ws/chain/${encodeURIComponent(c.name)}`;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const tvl = formatUsd(c.tvl);
	const desc = `${c.name} blockchain profile — ${tvl} total value locked${c.rank != null ? ` (rank #${c.rank})` : ''}, stablecoin supply, DEX volume, fees, and top protocols. Real DeFiLlama data.`;
	set('meta[name="description"]', 'content', desc);
	set('meta[property="og:title"]', 'content', title);
	set('meta[property="og:description"]', 'content', desc);
	set('meta[property="og:url"]', 'content', url);
	set('meta[name="twitter:title"]', 'content', title);
	set('meta[name="twitter:description"]', 'content', desc);
	let canon = document.querySelector('link[rel="canonical"]');
	if (!canon) {
		canon = document.createElement('link');
		canon.rel = 'canonical';
		document.head.appendChild(canon);
	}
	canon.href = url;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
	const name = nameFromLocation();
	const root = $('ch-main');
	if (!name) {
		location.replace('/chains');
		return;
	}
	renderSkeletons();

	let payload;
	try {
		payload = await getJson(`/api/defi/chain?name=${encodeURIComponent(name)}`);
	} catch (err) {
		root.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(name);
		else renderError();
		return;
	}

	const c = payload.chain || {};
	root.removeAttribute('aria-busy');

	updateMeta(c);
	renderHero(c);
	renderStats(payload);
	renderProtocols(payload);

	// TVL chart — always present for a tracked chain.
	const tvlSeries = (payload.tvl_series || []).map((p) => ({ t: p.t, value: p.tvl }));
	if (tvlSeries.length >= 2) {
		makeChart({
			el: $('ch-tvl-chart'),
			title: 'Total Value Locked',
			series: tvlSeries,
			color: 'var(--cv-chart-green)',
			format: formatUsd,
		});
	} else {
		$('ch-tvl-chart').innerHTML = '';
	}

	// Stablecoin supply — hidden when the chain has no stablecoin history.
	const stableSeries = (payload.stablecoins?.series || []).map((p) => ({ t: p.t, value: p.total }));
	if (stableSeries.length >= 2 && stableSeries.some((p) => p.value > 0)) {
		makeChart({
			el: $('ch-stable-chart'),
			title: 'Stablecoin Supply',
			series: stableSeries,
			color: 'var(--cv-accent)',
			format: formatUsd,
		});
	} else {
		$('ch-stable-chart').innerHTML = '';
	}

	// DEX volume — hidden when the chain has no DEX coverage.
	const dexSeries = (payload.dex?.series || []).map((p) => ({ t: p.t, value: p.v }));
	if (dexSeries.length >= 2 && dexSeries.some((p) => p.value > 0)) {
		makeChart({
			el: $('ch-dex-chart'),
			title: 'DEX Volume',
			series: dexSeries,
			color: 'var(--cv-chart-red)',
			format: formatUsd,
		});
	} else {
		$('ch-dex-chart').innerHTML = '';
	}

	const upd = $('ch-updated');
	upd.hidden = false;
	upd.textContent = `Updated ${new Date(payload.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: DeFiLlama`;
}

main();
