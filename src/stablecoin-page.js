// /stablecoin/:id — rich profile for one stablecoin, part of the three.ws
// Markets surface. Hero (name / symbol / peg + mechanism chips / price with a
// peg-health badge / link pills / description), stat cards, an interactive SVG
// supply-history chart (circulating over time with a range toggle + crosshair,
// plus minted/unreleased lines when they materially diverge), a per-chain
// circulation table with dominance bars, the mint/redeem mechanism prose, and
// audit links. Data comes from the /api/defi/stablecoin proxy (DeFiLlama) —
// never mocked. Mirrors the /exchange/:id detail-page pattern (src/exchange-page.js).

import { formatUsd, formatPrice, formatChartTick, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

// Matches the /stablecoin/:id route; falls back to the ?id= query for direct
// links and dev proxies that don't rewrite the path.
function idFromLocation() {
	const m = location.pathname.match(/^\/stablecoin\/(\d{1,6})$/);
	if (m) return m[1];
	const q = new URLSearchParams(location.search).get('id');
	return q && /^\d{1,6}$/.test(q) ? q : null;
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

// A twitter URL from DeFiLlama arrives as a full profile URL, but normalize any
// bare-handle stragglers to a canonical link.
function twitterUrl(v) {
	const s = String(v || '').trim();
	if (!s) return null;
	if (/^https?:\/\//i.test(s)) return s;
	const h = s.replace(/^@/, '').replace(/\/+$/, '');
	return h ? `https://twitter.com/${encodeURIComponent(h)}` : null;
}

// Peg deviation in basis points (1bp = 0.01%). Green within 10bp, amber within
// 50bp, red beyond — the industry rule of thumb for a healthy dollar peg.
function pegHealth(deviationPct) {
	if (deviationPct == null || !Number.isFinite(deviationPct)) return null;
	const bps = deviationPct * 100;
	const abs = Math.abs(bps);
	const band = abs <= 10 ? 'hi' : abs <= 50 ? 'mid' : 'lo';
	const label = `${bps >= 0 ? '+' : '−'}${abs.toFixed(1)} bps`;
	return { bps, band, label };
}

// ── Skeletons ────────────────────────────────────────────────────────────────

function renderSkeletons() {
	$('sc-hero').innerHTML = `
		<div class="sc-hero">
			<div class="cv-skel" style="width:64px;height:64px;border-radius:16px;flex-shrink:0"></div>
			<div style="flex:1;min-width:0">
				<div class="cv-skel" style="width:16rem;height:2rem"></div>
				<div class="cv-skel" style="width:20rem;max-width:100%;height:1.25rem;margin-top:0.75rem"></div>
				<div class="cv-skel" style="width:28rem;max-width:100%;height:3rem;margin-top:0.75rem"></div>
			</div>
		</div>`;
	$('sc-stats').innerHTML =
		'<div class="cv-stats-grid">' +
		Array.from({ length: 4 }, () => '<div class="cv-skel" style="height:5.5rem"></div>').join('') +
		'</div>';
	$('sc-chart').innerHTML =
		'<div class="cv-chart-panel"><div class="cv-skel" style="height:300px;border-radius:8px"></div></div>';
	$('sc-chains').innerHTML = `
		<h2 class="cv-h2">Circulation by chain</h2>
		<div class="cv-table-wrap" style="padding:0.75rem">
			${Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('')}
		</div>`;
	$('sc-mint').innerHTML = '';
	$('sc-audits').innerHTML = '';
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function mechanismLabel(m) {
	if (!m) return null;
	return { 'fiat-backed': 'Fiat-backed', 'crypto-backed': 'Crypto-backed', algorithmic: 'Algorithmic' }[m] || m;
}
function mechanismClass(m) {
	return { 'fiat-backed': 'sc-mech-fiat', 'crypto-backed': 'sc-mech-crypto', algorithmic: 'sc-mech-algo' }[m] || '';
}

function heroChips(d) {
	const chips = [];
	if (d.peg_type) chips.push(`<span class="sc-chip">${esc(d.peg_type)} peg</span>`);
	const ml = mechanismLabel(d.mechanism);
	if (ml) chips.push(`<span class="sc-chip ${mechanismClass(d.mechanism)}">${esc(ml)}</span>`);
	return chips.length ? `<div class="sc-chips">${chips.join('')}</div>` : '';
}

function heroPrice(d) {
	if (d.price == null) return '';
	const health = pegHealth(d.peg_deviation_pct);
	const badge = health
		? `<span class="sc-peg-badge sc-peg-${health.band}" title="Deviation from the $1.00 peg, in basis points">${esc(health.label)}</span>`
		: '';
	return `
		<div class="sc-price-row">
			<span class="sc-price cv-mono">${esc(formatPrice(d.price))}</span>
			${badge}
		</div>`;
}

function linkPill(href, label) {
	return `<a class="cv-pill" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

function heroLinks(d) {
	const pills = [];
	if (d.url) pills.push(linkPill(d.url, 'Website'));
	const tw = twitterUrl(d.twitter);
	if (tw) pills.push(linkPill(tw, 'Twitter'));
	if (Array.isArray(d.audit_links) && d.audit_links.length) {
		pills.push(linkPill(d.audit_links[0], d.audit_links.length > 1 ? 'Audits' : 'Audit'));
	}
	// Internal cross-link to the coin's full market-data page when DeFiLlama
	// carries a CoinGecko id — no new tab, it's an on-platform surface.
	if (d.gecko_id) {
		pills.push(
			`<a class="cv-pill sc-pill-internal" href="/coin/${encodeURIComponent(d.gecko_id)}">Market data →</a>`,
		);
	}
	return pills.length ? `<div class="cv-pills sc-links">${pills.join('')}</div>` : '';
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
	return paras ? `<div class="cv-prose sc-desc">${paras}</div>` : '';
}

function renderHero(d) {
	$('sc-crumb-name').textContent = d.symbol || d.name;
	const badgeChar = (d.symbol || d.name || '?').trim().charAt(0).toUpperCase();
	$('sc-hero').innerHTML = `
		<div class="sc-hero">
			<div class="sc-logo" aria-hidden="true">${esc(badgeChar)}</div>
			<div class="sc-hero-body">
				<div class="sc-title-row">
					<h1 class="cv-h1 sc-title">${esc(d.name)}</h1>
					${d.symbol ? `<span class="sc-symbol">${esc(d.symbol)}</span>` : ''}
				</div>
				${heroChips(d)}
				${heroPrice(d)}
				${heroDescription(d)}
				${heroLinks(d)}
			</div>
		</div>`;
}

// ── Stat cards ───────────────────────────────────────────────────────────────

function statCard({ label, value, valueClass = '', sub }) {
	return `
		<div class="cv-mini-stat sc-stat">
			<p class="label">${esc(label)}</p>
			<p class="value cv-mono ${valueClass}">${esc(value)}</p>
			${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
		</div>`;
}

function totalCirculating(d) {
	if (!Array.isArray(d.chains)) return null;
	let total = 0;
	let any = false;
	for (const c of d.chains) {
		if (c.circulating_usd != null && Number.isFinite(c.circulating_usd)) {
			total += c.circulating_usd;
			any = true;
		}
	}
	return any ? total : null;
}

function renderStats(d) {
	const cards = [];
	const total = totalCirculating(d);
	const pegUnit = d.peg_type ? ` ${d.peg_type}` : '';
	cards.push(
		statCard({
			label: 'Circulating',
			value: total != null ? formatUsd(total) : '—',
			sub: total != null && d.peg_type ? `denominated in${pegUnit}` : undefined,
		}),
	);
	cards.push(
		statCard({
			label: 'Chains',
			value: Array.isArray(d.chains) ? String(d.chains.length) : '—',
		}),
	);
	cards.push(statCard({ label: 'Price', value: formatPrice(d.price) }));

	const health = pegHealth(d.peg_deviation_pct);
	if (health) {
		cards.push(
			statCard({
				label: 'Peg deviation',
				value: health.label,
				valueClass: `sc-dev-${health.band}`,
			}),
		);
	}
	$('sc-stats').innerHTML = `<div class="cv-stats-grid">${cards.join('')}</div>`;
}

// ── Supply-history chart ─────────────────────────────────────────────────────

const RANGES = [
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
	{ label: 'All', days: null },
];

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 84, bottom: 30, left: 10 };

// The metrics we can overlay. `circulating` is always drawn as the area; the
// others become lines only when they materially diverge from circulating.
const METRICS = {
	circulating: { label: 'Circulating', color: 'var(--cv-chart-green)', area: true },
	unreleased: { label: 'Unreleased', color: '#f59e0b', area: false },
	minted: { label: 'Minted', color: 'var(--cv-accent)', area: false },
};

const chartState = { days: null, full: [], series: [], name: '', pegType: '', shown: ['circulating'] };

// A secondary metric is worth its own line only when it rises above 0.5% of the
// peak circulating supply somewhere in the window AND isn't just tracking
// circulating exactly (which would draw a redundant overlapping line).
function materiallyDiffers(series, key) {
	let maxCirc = 0;
	let maxMetric = 0;
	let maxGap = 0;
	for (const p of series) {
		const c = p.circulating;
		const v = p[key];
		if (c != null && c > maxCirc) maxCirc = c;
		if (v != null && v > maxMetric) maxMetric = v;
		if (c != null && v != null) maxGap = Math.max(maxGap, Math.abs(c - v));
	}
	if (maxMetric <= 0 || maxCirc <= 0) return false;
	if (maxMetric < maxCirc * 0.005) return false; // immaterial magnitude
	return maxGap > maxCirc * 0.005; // and genuinely distinct from circulating
}

function computeShown(series) {
	const shown = ['circulating'];
	for (const key of ['unreleased', 'minted']) {
		if (materiallyDiffers(series, key)) shown.push(key);
	}
	return shown;
}

function applyRange() {
	const { full, days } = chartState;
	if (days == null) {
		chartState.series = full;
	} else {
		const cutoff = Date.now() - days * 86400_000;
		const filtered = full.filter((p) => p.t >= cutoff);
		// Keep at least the last two points so a short/quiet window never blanks.
		chartState.series = filtered.length >= 2 ? filtered : full.slice(-2);
	}
	chartState.shown = computeShown(chartState.series);
}

function chartGeometry(series, shown) {
	let min = 0; // supply floors at 0 — anchor the area there
	let max = 0;
	for (const p of series) {
		for (const key of shown) {
			const v = p[key];
			if (v != null && v > max) max = v;
		}
	}
	const range = max - min || 1;
	const w = CHART_W - PAD.left - PAD.right;
	const h = CHART_H - PAD.top - PAD.bottom;
	const n = series.length;
	const x = (i) => PAD.left + (n === 1 ? w / 2 : (i / (n - 1)) * w);
	const y = (v) => PAD.top + h - ((v - min) / range) * h;

	const paths = {};
	for (const key of shown) {
		const pts = [];
		for (let i = 0; i < n; i++) {
			const v = series[i][key];
			if (v == null) continue;
			pts.push(`${pts.length === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`);
		}
		paths[key] = pts.join(' ');
	}
	// Area under circulating.
	let area = '';
	if (paths.circulating) {
		const first = x(0).toFixed(2);
		const last = x(n - 1).toFixed(2);
		const base = (PAD.top + h).toFixed(2);
		area = `${paths.circulating} L${last},${base} L${first},${base} Z`;
	}
	return { min, max, range, paths, area, x, y };
}

function yAxis(g) {
	const steps = 4;
	const h = CHART_H - PAD.top - PAD.bottom;
	return Array.from({ length: steps + 1 }, (_, i) => {
		const v = g.min + (g.range * i) / steps;
		const y = PAD.top + h - (i / steps) * h;
		return `<g><line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CHART_W - PAD.right + 8}" y="${y + 4}" font-size="10" fill="var(--cv-text-3)">${esc(formatUsd(v))}</text></g>`;
	}).join('');
}

function legend(shown) {
	if (shown.length < 2) return '';
	const items = shown
		.map(
			(key) =>
				`<span class="sc-legend-item"><span class="sc-legend-swatch" style="background:${METRICS[key].color}"></span>${esc(METRICS[key].label)}</span>`,
		)
		.join('');
	return `<div class="sc-legend">${items}</div>`;
}

function renderChart() {
	const el = $('sc-chart');
	const { days, series, shown, name } = chartState;

	const rangeBtns = RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days == null ? 'all' : r.days}" aria-pressed="${r.days === days}">${r.label}</button>`,
	).join('');

	let body;
	if (series.length < 2) {
		body = '<div class="cv-chart-state">No supply history available for this range.</div>';
	} else {
		const g = chartGeometry(series, shown);
		const lines = shown
			.map((key) =>
				METRICS[key].area
					? `<path d="${g.paths[key]}" fill="none" stroke="${METRICS[key].color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
					: `<path d="${g.paths[key]}" fill="none" stroke="${METRICS[key].color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${key === 'unreleased' ? '5 3' : '2 3'}"/>`,
			)
			.join('');
		body = `
			${legend(shown)}
			<div class="cv-chart-area">
				<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"
					aria-label="Circulating supply history for ${esc(name)}${days ? ` over ${days} days` : ' (all time)'}">
					<defs>
						<linearGradient id="sc-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${METRICS.circulating.color}" stop-opacity="0.2"/>
							<stop offset="100%" stop-color="${METRICS.circulating.color}" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${yAxis(g)}
					<path d="${g.area}" fill="url(#sc-grad)"/>
					${lines}
					<g id="sc-crosshair" hidden>
						<line id="sc-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="sc-cross-dot" r="4" fill="${METRICS.circulating.color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="sc-tip" hidden>
					<p class="p cv-mono" id="sc-tip-val"></p>
					<p class="p cv-mono" id="sc-tip-extra"></p>
					<p class="d" id="sc-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Circulating supply</span></div>
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
			applyRange();
			renderChart();
		});
	});

	wireChartPointer();
}

function wireChartPointer() {
	const svg = $('sc-chart').querySelector('svg');
	const tip = $('sc-tip');
	if (!svg || !tip || chartState.series.length < 2) return;
	const g = chartGeometry(chartState.series, chartState.shown);
	const cross = svg.querySelector('#sc-crosshair');
	const crossLine = svg.querySelector('#sc-cross-line');
	const crossDot = svg.querySelector('#sc-cross-dot');
	const usableW = CHART_W - PAD.left - PAD.right;

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
		const n = chartState.series.length;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mouseX - PAD.left) / usableW) * (n - 1))));
		const p = chartState.series[i];
		const x = g.x(i);
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);
		if (p.circulating != null) {
			crossDot.removeAttribute('hidden');
			crossDot.setAttribute('cx', x);
			crossDot.setAttribute('cy', g.y(p.circulating));
		} else {
			crossDot.setAttribute('hidden', '');
		}
		tip.hidden = false;
		tip.style.left = `${(x / CHART_W) * 100}%`;
		$('sc-tip-val').textContent = formatUsd(p.circulating);
		const extras = chartState.shown
			.filter((k) => k !== 'circulating' && p[k] != null)
			.map((k) => `${METRICS[k].label}: ${formatUsd(p[k])}`)
			.join(' · ');
		$('sc-tip-extra').textContent = extras;
		$('sc-tip-extra').hidden = !extras;
		$('sc-tip-date').textContent = formatChartTick(p.t, chartState.days || 400);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

// ── Chain distribution ───────────────────────────────────────────────────────

function renderChains(d) {
	const el = $('sc-chains');
	const chains = Array.isArray(d.chains) ? d.chains : [];
	if (!chains.length) {
		el.innerHTML = `
			<h2 class="cv-h2">Circulation by chain</h2>
			<div class="cv-empty">No per-chain circulation is reported for this stablecoin right now.</div>`;
		return;
	}
	const rows = chains
		.map((c) => {
			const share = c.share_pct != null && Number.isFinite(c.share_pct) ? c.share_pct : null;
			const bar = share != null ? Math.max(1, Math.min(100, share)) : 0;
			return `
				<tr>
					<td class="left">
						<a class="sc-chain-link" href="/chain/${encodeURIComponent(c.chain)}">${esc(c.chain)}</a>
					</td>
					<td class="cv-mono">${esc(formatUsd(c.circulating_usd))}</td>
					<td class="sc-share-cell">
						<span class="sc-share-bar" aria-hidden="true"><span style="width:${bar}%"></span></span>
						<span class="cv-mono sc-share-pct">${share != null ? `${share.toFixed(share < 1 ? 2 : 1)}%` : '—'}</span>
					</td>
				</tr>`;
		})
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">Circulation by chain</h2>
		<div class="cv-table-wrap">
			<table class="cv-table sc-chain-table">
				<thead>
					<tr>
						<th scope="col" class="left">Chain</th>
						<th scope="col">Circulating</th>
						<th scope="col">Dominance</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

// ── Mint / redeem + audits ───────────────────────────────────────────────────

function renderMint(d) {
	const el = $('sc-mint');
	if (!d.mint_redeem) {
		el.innerHTML = '';
		return;
	}
	el.innerHTML = `
		<h2 class="cv-h2">Mint &amp; redeem</h2>
		<div class="cv-prose sc-prose"><p>${esc(d.mint_redeem)}</p></div>`;
}

function renderAudits(d) {
	const el = $('sc-audits');
	const links = Array.isArray(d.audit_links) ? d.audit_links : [];
	if (!links.length) {
		el.innerHTML = '';
		return;
	}
	const pills = links
		.map((url, i) => {
			const label = links.length > 1 ? `Audit ${i + 1}` : 'Audit report';
			return `<a class="cv-pill" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
		})
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">Audits</h2>
		<div class="cv-pills sc-audit-pills">${pills}</div>`;
}

// ── Error / not-found states ─────────────────────────────────────────────────

function clearSections() {
	for (const id of ['sc-stats', 'sc-chart', 'sc-chains', 'sc-mint', 'sc-audits']) $(id).innerHTML = '';
}

function renderNotFound(id) {
	$('sc-crumb-name').textContent = 'Not found';
	$('sc-hero').innerHTML = `
		<h1 class="cv-h1">Stablecoin not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find a stablecoin for id “${esc(id)}”. It may not be
			tracked by DeFiLlama, or the id is wrong.</p>
			<p style="margin:0">Browse the <a href="/stablecoins">stablecoins board</a> or head back to
			<a href="/markets">Markets</a>.</p>
		</div>`;
	clearSections();
}

function renderError() {
	$('sc-hero').innerHTML = `
		<h1 class="cv-h1">Stablecoin data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">The market-data source is temporarily unreachable. This usually
			clears within a minute.</p>
			<button type="button" class="sc-retry" id="sc-retry">Retry</button>
			<span style="margin-left:0.75rem">or return to the <a href="/stablecoins">stablecoins board</a>.</span>
		</div>`;
	clearSections();
	$('sc-retry')?.addEventListener('click', () => main());
}

// ── SEO / document metadata ──────────────────────────────────────────────────

function updateMeta(d, id) {
	const title = `${d.name}${d.symbol ? ` (${d.symbol})` : ''} — Stablecoin · three.ws`;
	document.title = title;
	const url = `https://three.ws/stablecoin/${id}`;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const mech = mechanismLabel(d.mechanism);
	const desc = `${d.name}${d.symbol ? ` (${d.symbol})` : ''}${mech ? ` — ${mech.toLowerCase()} stablecoin` : ' stablecoin'}: peg health, per-chain circulation, supply history, and audits. Real DeFiLlama data.`;
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
	const id = idFromLocation();
	const root = $('sc-main');
	if (!id) {
		location.replace('/stablecoins');
		return;
	}
	renderSkeletons();

	let d;
	try {
		d = await getJson(`/api/defi/stablecoin?id=${encodeURIComponent(id)}`);
	} catch (err) {
		root.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(id);
		else renderError();
		return;
	}

	root.removeAttribute('aria-busy');
	updateMeta(d, id);
	renderHero(d);
	renderStats(d);
	renderChains(d);
	renderMint(d);
	renderAudits(d);

	// Supply history.
	const series = Array.isArray(d.supply_series) ? d.supply_series : [];
	if (series.length < 2) {
		$('sc-chart').innerHTML = '';
	} else {
		chartState.full = series;
		chartState.name = d.name;
		chartState.pegType = d.peg_type || '';
		chartState.days = null; // default to the full history
		applyRange();
		renderChart();
	}

	const upd = $('sc-updated');
	upd.hidden = false;
	upd.textContent = `Updated ${new Date(d.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: DeFiLlama`;
}

main();
