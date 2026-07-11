// /protocol/:slug — rich profile for one DeFi protocol, part of the three.ws
// Markets surface. Hero (logo / name / symbol / category / audit badge /
// fork + parent chips / link pills / description), stat cards (TVL, Mcap/TVL,
// 24h fees, 24h revenue, 24h DEX volume), an interactive SVG TVL-history chart
// with a range toggle, crosshair tooltip, and hallmark event markers, a
// per-chain TVL breakdown with share bars linking into /chain/:name, a funding-
// rounds table, a fees & revenue grid, and the TVL methodology prose. Data
// comes from the /api/defi/protocol proxy (DeFiLlama) — never mocked. Mirrors
// the /exchange/:id detail-page pattern (src/exchange-page.js).

import { formatUsd, formatDateShort, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

// Matches the /protocol/:slug route; falls back to the ?slug= query for direct
// links and dev proxies that don't rewrite the path.
function slugFromLocation() {
	const m = location.pathname.match(/^\/protocol\/([a-z0-9.-]{1,80})$/i);
	if (m) return m[1].toLowerCase();
	const q = new URLSearchParams(location.search).get('slug');
	return q && /^[a-z0-9.-]{1,80}$/i.test(q) ? q.toLowerCase() : null;
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

// A twitter handle from DeFiLlama is a bare handle ("aave") but occasionally
// arrives with an @ or a full URL — normalize to a canonical profile URL.
function twitterUrl(handle) {
	const h = String(handle)
		.trim()
		.replace(/^@/, '')
		.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '')
		.replace(/\/+$/, '');
	return h ? `https://twitter.com/${encodeURIComponent(h)}` : null;
}

// ── Skeletons ────────────────────────────────────────────────────────────────

function renderSkeletons() {
	$('pr-hero').innerHTML = `
		<div class="pr-hero">
			<div class="cv-skel" style="width:72px;height:72px;border-radius:16px;flex-shrink:0"></div>
			<div style="flex:1;min-width:0">
				<div class="cv-skel" style="width:14rem;height:2rem"></div>
				<div class="cv-skel" style="width:22rem;max-width:100%;height:1.25rem;margin-top:0.75rem"></div>
				<div class="cv-skel" style="width:30rem;max-width:100%;height:3.5rem;margin-top:0.75rem"></div>
			</div>
		</div>`;
	$('pr-stats').innerHTML =
		'<div class="cv-stats-grid">' +
		Array.from({ length: 4 }, () => '<div class="cv-skel" style="height:5.5rem"></div>').join('') +
		'</div>';
	$('pr-chart').innerHTML =
		'<div class="cv-chart-panel"><div class="cv-skel" style="height:300px;border-radius:8px"></div></div>';
	$('pr-chains').innerHTML = `
		<h2 class="cv-h2">TVL by chain</h2>
		<div class="cv-table-wrap" style="padding:0.75rem">
			${Array.from({ length: 5 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('')}
		</div>`;
	$('pr-fees').innerHTML = '';
	$('pr-raises').innerHTML = '';
	$('pr-methodology').innerHTML = '';
}

// ── Hero ─────────────────────────────────────────────────────────────────────

const SHIELD_ICON =
	'<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

function auditBadge(audits) {
	if (!audits) return '';
	const n = audits.count || 0;
	const label = n > 0 ? `${n} audit${n === 1 ? '' : 's'}` : 'Audited';
	const links = Array.isArray(audits.audit_links) ? audits.audit_links : [];
	if (links.length) {
		return `<a class="pr-audit" href="${esc(links[0])}" target="_blank" rel="noopener noreferrer"
			title="View audit reports (opens in a new tab)">${SHIELD_ICON}${esc(label)} ↗</a>`;
	}
	return `<span class="pr-audit pr-audit-static" title="Independently audited">${SHIELD_ICON}${esc(label)}</span>`;
}

function metaChips(d) {
	const chips = [];
	if (d.category) chips.push(`<span class="pr-chip pr-chip-cat">${esc(d.category)}</span>`);
	for (const fork of d.forkedFrom || [])
		chips.push(`<span class="pr-chip" title="Forked from ${esc(fork)}">Fork of ${esc(fork)}</span>`);
	if (d.parentProtocol) {
		const p = d.parentProtocol.replace(/^parent#/, '');
		chips.push(`<span class="pr-chip" title="Part of the ${esc(p)} protocol family">Part of ${esc(p)}</span>`);
	}
	if (d.listedAt) chips.push(`<span class="pr-chip">Listed ${esc(formatDateShort(d.listedAt * 1000))}</span>`);
	return chips.length ? `<div class="pr-meta">${chips.join('')}</div>` : '';
}

function linkPill(href, label) {
	return `<a class="cv-pill" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

function heroLinks(d) {
	const pills = [];
	if (d.url) pills.push(linkPill(d.url, 'Website'));
	const tw = d.twitter ? twitterUrl(d.twitter) : null;
	if (tw) pills.push(linkPill(tw, 'Twitter'));
	return pills.length ? `<div class="cv-pills pr-links">${pills.join('')}</div>` : '';
}

function heroDescription(d) {
	if (!d.description) return '';
	const paras = d.description
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.slice(0, 4)
		.map((p) => `<p>${esc(p)}</p>`)
		.join('');
	return paras ? `<div class="cv-prose pr-desc">${paras}</div>` : '';
}

function renderHero(d) {
	$('pr-crumb-name').textContent = d.name;
	$('pr-hero').innerHTML = `
		<div class="pr-hero">
			${
				d.logo
					? `<img class="pr-logo" src="${esc(d.logo)}" alt="${esc(d.name)} logo" width="72" height="72" loading="eager" data-no-dark-filter />`
					: '<div class="pr-logo pr-logo-fallback" aria-hidden="true"></div>'
			}
			<div class="pr-hero-body">
				<div class="pr-title-row">
					<h1 class="cv-h1 pr-title">${esc(d.name)}</h1>
					${d.symbol ? `<span class="pr-symbol">${esc(d.symbol)}</span>` : ''}
					${auditBadge(d.audits)}
				</div>
				${metaChips(d)}
				${heroDescription(d)}
				${heroLinks(d)}
			</div>
		</div>`;
}

// ── Stat cards ───────────────────────────────────────────────────────────────

function statCard({ label, value, sub }) {
	return `
		<div class="cv-mini-stat pr-stat">
			<p class="label">${esc(label)}</p>
			<p class="value cv-mono">${esc(value)}</p>
			${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
		</div>`;
}

function renderStats(d) {
	const cards = [];
	if (d.tvl_current != null) cards.push(statCard({ label: 'Total Value Locked', value: formatUsd(d.tvl_current) }));
	if (d.mcap != null && d.tvl_current) {
		const ratio = d.mcap / d.tvl_current;
		cards.push(
			statCard({
				label: 'Mcap / TVL',
				value: ratio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
				sub: `Mcap ${formatUsd(d.mcap)}`,
			}),
		);
	}
	if (d.fees?.total24h != null)
		cards.push(statCard({ label: '24h Fees', value: formatUsd(d.fees.total24h) }));
	if (d.fees?.revenue24h != null)
		cards.push(statCard({ label: '24h Revenue', value: formatUsd(d.fees.revenue24h) }));
	if (d.dex_volume?.total24h != null)
		cards.push(statCard({ label: '24h DEX Volume', value: formatUsd(d.dex_volume.total24h) }));

	if (!cards.length) {
		$('pr-stats').innerHTML = '';
		return;
	}
	$('pr-stats').innerHTML = `<div class="cv-stats-grid">${cards.join('')}</div>`;
}

// ── TVL history chart ─────────────────────────────────────────────────────────

const TIME_RANGES = [
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
	{ label: 'All', days: null },
];

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 80, bottom: 30, left: 10 };

// series: [{ t: unix_s, tvl }], full history already downsampled server-side.
// The range toggle slices this client-side (no refetch — we have it all).
const chartState = { full: [], hallmarks: [], days: 30, name: '' };

function visibleSeries() {
	const { full, days } = chartState;
	if (days == null) return full;
	const cutoff = Date.now() / 1000 - days * 86400;
	const win = full.filter((p) => p.t >= cutoff);
	return win.length >= 2 ? win : full;
}

function chartGeometry(series) {
	const vals = series.map((p) => p.tvl);
	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const range = max - min || 1;
	const tMin = series[0].t;
	const tMax = series[series.length - 1].t;
	const tRange = tMax - tMin || 1;
	const w = CHART_W - PAD.left - PAD.right;
	const h = CHART_H - PAD.top - PAD.bottom;
	const x = (t) => PAD.left + ((t - tMin) / tRange) * w;
	const y = (v) => PAD.top + h - ((v - min) / range) * h;
	const pts = series.map((p) => ({ x: x(p.t), y: y(p.tvl) }));
	const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
	const area = `${line} L${pts[pts.length - 1].x.toFixed(2)},${(PAD.top + h).toFixed(2)} L${pts[0].x.toFixed(2)},${(PAD.top + h).toFixed(2)} Z`;
	return { min, max, range, tMin, tMax, tRange, x, y, line, area };
}

function tickLabel(ts, days) {
	const d = new Date(ts * 1000);
	if (Number.isNaN(d.getTime())) return '';
	if (days != null && days <= 90) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	return `${d.toLocaleDateString('en-US', { month: 'short' })} '${String(d.getFullYear() % 100).padStart(2, '0')}`;
}

function hallmarkMarkers(g, series) {
	const items = (chartState.hallmarks || []).filter((h) => h[0] >= g.tMin && h[0] <= g.tMax);
	if (!items.length) return '';
	const top = PAD.top;
	const bottom = CHART_H - PAD.bottom;
	return items
		.map((h) => {
			const hx = g.x(h[0]);
			return `<g class="pr-hallmark"><title>${esc(h[1])} — ${esc(formatDateShort(h[0] * 1000))}</title>
				<line x1="${hx.toFixed(2)}" y1="${top}" x2="${hx.toFixed(2)}" y2="${bottom}" stroke="var(--cv-text-3)" stroke-width="0.75" stroke-dasharray="2 3" opacity="0.55"/>
				<polygon points="${(hx - 4).toFixed(2)},${top - 8} ${(hx + 4).toFixed(2)},${top - 8} ${hx.toFixed(2)},${top - 1}" fill="var(--cv-accent)"/>
				<rect x="${(hx - 7).toFixed(2)}" y="${top - 10}" width="14" height="14" fill="transparent"/></g>`;
		})
		.join('');
}

function renderChart() {
	const el = $('pr-chart');
	const { days, name } = chartState;
	const series = visibleSeries();

	const rangeBtns = TIME_RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days == null ? 'all' : r.days}" aria-pressed="${r.days === days}">${r.label}</button>`,
	).join('');

	let body;
	if (series.length < 2) {
		body = '<div class="cv-chart-state">No TVL history available for this range.</div>';
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
					aria-label="Total value locked history for ${esc(name)}">
					<defs>
						<linearGradient id="pr-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
							<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${yLabels}
					<path d="${g.area}" fill="url(#pr-grad)"/>
					<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					${hallmarkMarkers(g, series)}
					<g id="pr-crosshair" hidden>
						<line id="pr-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="pr-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="pr-tip" hidden>
					<p class="p cv-mono" id="pr-tip-val"></p>
					<p class="d" id="pr-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Total Value Locked</span></div>
				<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
			</div>
			${body}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const raw = btn.dataset.days;
			const dd = raw === 'all' ? null : Number(raw);
			if (dd === chartState.days) return;
			chartState.days = dd;
			renderChart();
		});
	});

	wireChartPointer(series);
}

function wireChartPointer(series) {
	const svg = $('pr-chart').querySelector('svg');
	const tip = $('pr-tip');
	if (!svg || !tip || series.length < 2) return;
	const g = chartGeometry(series);
	const cross = svg.querySelector('#pr-crosshair');
	const crossLine = svg.querySelector('#pr-cross-line');
	const crossDot = svg.querySelector('#pr-cross-dot');

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
		// Nearest point by rendered x (series may be time-non-uniform after windowing).
		let i = 0;
		let best = Infinity;
		for (let k = 0; k < series.length; k++) {
			const dx = Math.abs(g.x(series[k].t) - mouseX);
			if (dx < best) {
				best = dx;
				i = k;
			}
		}
		const p = series[i];
		const x = g.x(p.t);
		const y = g.y(p.tvl);
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);
		crossDot.setAttribute('cx', x);
		crossDot.setAttribute('cy', y);
		tip.hidden = false;
		tip.style.left = `${(x / CHART_W) * 100}%`;
		$('pr-tip-val').textContent = formatUsd(p.tvl);
		$('pr-tip-date').textContent = formatDateShort(p.t * 1000);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

// ── Chain breakdown ────────────────────────────────────────────────────────────

function renderChains(d) {
	const el = $('pr-chains');
	const chains = Array.isArray(d.chain_tvls) ? d.chain_tvls : [];
	if (!chains.length) {
		el.innerHTML = '';
		return;
	}
	const total = chains.reduce((s, c) => s + c.tvl, 0) || 1;
	const rows = chains
		.map((c) => {
			const share = (c.tvl / total) * 100;
			return `
			<tr>
				<td class="left">
					<a class="pr-chain-link" href="/chain/${encodeURIComponent(c.chain)}">${esc(c.chain)}</a>
				</td>
				<td class="cv-mono">${esc(formatUsd(c.tvl))}</td>
				<td class="pr-share-cell">
					<span class="pr-share-track" aria-hidden="true"><span class="pr-share-fill" style="width:${share.toFixed(2)}%"></span></span>
					<span class="cv-mono pr-share-num">${share.toFixed(share < 1 ? 2 : 1)}%</span>
				</td>
			</tr>`;
		})
		.join('');
	const single = chains.length === 1 ? '<p class="pr-note">This protocol reports TVL on a single chain.</p>' : '';
	el.innerHTML = `
		<h2 class="cv-h2">TVL by chain</h2>
		<div class="cv-table-wrap">
			<table class="cv-table pr-chain-table">
				<thead>
					<tr>
						<th scope="col" class="left">Chain</th>
						<th scope="col">TVL</th>
						<th scope="col">Share</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
		${single}`;
}

// ── Fees & revenue grid ────────────────────────────────────────────────────────

function feeItem(label, value) {
	return `<div class="pr-fee-item"><p class="pr-fee-label">${esc(label)}</p><p class="pr-fee-val cv-mono">${esc(value)}</p></div>`;
}

function renderFees(d) {
	const el = $('pr-fees');
	const f = d.fees;
	if (!f) {
		el.innerHTML = '';
		return;
	}
	const items = [];
	const push = (label, v) => {
		if (v != null) items.push(feeItem(label, formatUsd(v)));
	};
	push('Fees · 24h', f.total24h);
	push('Fees · 7d', f.total7d);
	push('Fees · 30d', f.total30d);
	push('Fees · all-time', f.totalAllTime);
	push('Revenue · 24h', f.revenue24h);
	push('Revenue · 7d', f.revenue7d);
	push('Revenue · 30d', f.revenue30d);
	if (d.dex_volume?.total24h != null) push('DEX volume · 24h', d.dex_volume.total24h);
	if (d.dex_volume?.total7d != null) push('DEX volume · 7d', d.dex_volume.total7d);
	if (!items.length) {
		el.innerHTML = '';
		return;
	}
	el.innerHTML = `
		<h2 class="cv-h2">Fees &amp; revenue</h2>
		<p class="pr-fees-sub">Fees are what users pay to use the protocol; revenue is the share that accrues to the protocol and its token holders.</p>
		<div class="pr-fee-grid">${items.join('')}</div>`;
}

// ── Funding rounds ─────────────────────────────────────────────────────────────

function investorList(lead, other) {
	const names = [...(lead || []), ...(other || [])];
	if (!names.length) return '<span class="dim">—</span>';
	const shown = names.slice(0, 4).map(esc).join(', ');
	const extra = names.length > 4 ? ` +${names.length - 4}` : '';
	const leadTag = (lead || []).length ? ' <span class="pr-lead-tag">lead</span>' : '';
	return `${shown}${extra}${leadTag}`;
}

function renderRaises(d) {
	const el = $('pr-raises');
	const raises = d.raises;
	if (!raises || !raises.length) {
		el.innerHTML = '';
		return;
	}
	const rows = raises
		.map((r) => {
			const amount = r.amount_usd != null ? formatUsd(r.amount_usd) : '—';
			const valuation = r.valuation != null ? formatUsd(r.valuation * 1e6) : '';
			const round = r.round ? esc(r.round) : '—';
			const roundCell = r.source
				? `<a class="pr-chain-link" href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">${round} ↗</a>`
				: round;
			return `
			<tr>
				<td class="left">${r.date ? esc(formatDateShort(r.date * 1000)) : '—'}</td>
				<td>${roundCell}</td>
				<td class="cv-mono">${esc(amount)}${valuation ? `<span class="pr-val-sub">@ ${esc(valuation)}</span>` : ''}</td>
				<td class="pr-investors">${investorList(r.leadInvestors, r.otherInvestors)}</td>
			</tr>`;
		})
		.join('');
	const totalRaised = raises.reduce((s, r) => s + (r.amount_usd || 0), 0);
	const totalNote = totalRaised > 0 ? `<p class="pr-note">Total disclosed funding: <span class="cv-mono">${esc(formatUsd(totalRaised))}</span> across ${raises.length} round${raises.length === 1 ? '' : 's'}.</p>` : '';
	el.innerHTML = `
		<h2 class="cv-h2">Funding rounds</h2>
		<div class="cv-table-wrap">
			<table class="cv-table pr-raise-table">
				<thead>
					<tr>
						<th scope="col" class="left">Date</th>
						<th scope="col">Round</th>
						<th scope="col">Amount</th>
						<th scope="col">Investors</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
		${totalNote}`;
}

// ── Methodology ────────────────────────────────────────────────────────────────

function renderMethodology(d) {
	const el = $('pr-methodology');
	if (!d.methodology) {
		el.innerHTML = '';
		return;
	}
	const paras = d.methodology
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => `<p>${esc(p)}</p>`)
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">How TVL is measured</h2>
		<div class="cv-prose pr-methodology">${paras}</div>`;
}

// ── Error / not-found states ───────────────────────────────────────────────────

function clearSections(except) {
	for (const id of ['pr-stats', 'pr-chart', 'pr-chains', 'pr-fees', 'pr-raises', 'pr-methodology']) {
		if (id !== except) $(id).innerHTML = '';
	}
}

function renderNotFound(slug) {
	$('pr-crumb-name').textContent = 'Not found';
	$('pr-hero').innerHTML = `
		<h1 class="cv-h1">Protocol not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find a DeFi protocol for “${esc(slug)}”. It may not be
			tracked by DeFiLlama, or the slug is misspelled.</p>
			<p style="margin:0">Browse the <a href="/defi">DeFi protocols directory</a> or head back to
			<a href="/markets">Markets</a>.</p>
		</div>`;
	clearSections();
}

function renderError() {
	$('pr-hero').innerHTML = `
		<h1 class="cv-h1">Protocol data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">The market-data source is temporarily unreachable. This usually
			clears within a minute.</p>
			<button type="button" class="pr-retry" id="pr-retry">Retry</button>
			<span style="margin-left:0.75rem">or return to the <a href="/defi">DeFi directory</a>.</span>
		</div>`;
	clearSections();
	$('pr-retry')?.addEventListener('click', () => main());
}

// ── SEO / document metadata ────────────────────────────────────────────────────

function updateMeta(d, slug) {
	const title = `${d.name} — DeFi Protocol · three.ws`;
	document.title = title;
	const url = `https://three.ws/protocol/${slug}`;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const tvl = d.tvl_current != null ? ` — ${formatUsd(d.tvl_current)} TVL` : '';
	const cat = d.category ? `${d.category} protocol` : 'DeFi protocol';
	const desc = `${d.name} ${cat}${tvl}: TVL history, per-chain breakdown, fees, revenue, and funding rounds. Real DeFiLlama data.`;
	set('meta[name="description"]', 'content', desc);
	set('meta[property="og:title"]', 'content', title);
	set('meta[property="og:description"]', 'content', desc);
	set('meta[property="og:url"]', 'content', url);
	set('meta[name="twitter:title"]', 'content', title);
	set('meta[name="twitter:description"]', 'content', desc);
	if (d.logo) {
		set('meta[property="og:image"]', 'content', d.logo);
		set('meta[name="twitter:image"]', 'content', d.logo);
	}
	let canon = document.querySelector('link[rel="canonical"]');
	if (!canon) {
		canon = document.createElement('link');
		canon.rel = 'canonical';
		document.head.appendChild(canon);
	}
	canon.href = url;
}

// ── Boot ───────────────────────────────────────────────────────────────────────

async function main() {
	const slug = slugFromLocation();
	const root = $('pr-main');
	if (!slug) {
		location.replace('/defi');
		return;
	}
	renderSkeletons();

	let d;
	try {
		d = await getJson(`/api/defi/protocol?slug=${encodeURIComponent(slug)}`);
	} catch (err) {
		root.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(slug);
		else renderError();
		return;
	}

	root.removeAttribute('aria-busy');
	updateMeta(d, slug);
	renderHero(d);
	renderStats(d);

	if (Array.isArray(d.tvl_series) && d.tvl_series.length >= 2) {
		chartState.full = d.tvl_series;
		chartState.hallmarks = Array.isArray(d.hallmarks) ? d.hallmarks : [];
		chartState.name = d.name;
		// Default to the shortest range that still shows ≥2 points.
		chartState.days = 30;
		renderChart();
	} else {
		$('pr-chart').innerHTML = '';
	}

	renderChains(d);
	renderFees(d);
	renderRaises(d);
	renderMethodology(d);

	const upd = $('pr-updated');
	upd.hidden = false;
	upd.textContent = `Updated ${new Date(d.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: DeFiLlama`;
}

main();
