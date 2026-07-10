// /coin/:id — rich coin detail page, adopted from the cryptocurrency.cv coin
// pages: header (icon / name / rank / price / 24h-7d-30d chips), interactive
// SVG price chart with time ranges and a crosshair tooltip, market-stats grid,
// related news, about text, and link pills. Data comes from the /api/coin/*
// proxies (CoinGecko + the native three.ws news aggregator) — never mocked.

import {
	formatUsd,
	formatPrice,
	formatPercent,
	formatSupply,
	formatDateShort,
	formatChartTick,
	timeAgo,
	escapeHtml as esc,
} from './shared/coin-format.js';

const TIME_RANGES = [
	{ label: '24H', days: 1 },
	{ label: '7D', days: 7 },
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '1Y', days: 365 },
];

const $ = (id) => document.getElementById(id);

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// A CoinGecko slug (lowercase) or a Solana mint (case-sensitive base58) —
// the detail endpoint resolves either.
function coinIdFromPath() {
	const m = location.pathname.match(/^\/coin\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})\/?$/);
	if (!m) return null;
	return MINT_RE.test(m[1]) ? m[1] : m[1].toLowerCase();
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── Skeletons ───────────────────────────────────────────────────────────────

function renderSkeletons() {
	$('cv-head').innerHTML = `
		<div class="cv-coin-head">
			<div class="cv-skel" style="width:64px;height:64px;border-radius:50%"></div>
			<div style="flex:1;min-width:0">
				<div class="cv-skel" style="width:14rem;height:2.25rem"></div>
				<div class="cv-skel" style="width:18rem;height:3rem;margin-top:0.75rem"></div>
			</div>
		</div>`;
	$('cv-chart').innerHTML =
		'<div class="cv-chart-panel"><div class="cv-skel" style="height:300px;border-radius:8px"></div></div>';
	$('cv-stats').innerHTML =
		'<div class="cv-stats-grid">' +
		Array.from({ length: 8 }, () => '<div class="cv-skel" style="height:5rem"></div>').join('') +
		'</div>';
}

// ── Header ──────────────────────────────────────────────────────────────────

function chip(label, value) {
	if (value == null || !Number.isFinite(value)) return '';
	const dir = value >= 0 ? 'up' : 'down';
	return `<span class="cv-chip ${dir}"><span class="win">${esc(label)}</span>${esc(formatPercent(value))}</span>`;
}

function renderHead(coin) {
	const m = coin.market || {};
	const todayAbs = m.change_24h_abs;
	$('cv-crumb-name').textContent = coin.name;
	$('cv-head').innerHTML = `
		<div class="cv-coin-head">
			${coin.image ? `<img class="coin-icon" src="${esc(coin.image)}" alt="" width="64" height="64" data-no-dark-filter />` : ''}
			<div style="flex:1;min-width:0">
				<div class="title-row">
					<h1>${esc(coin.name)}</h1>
					<span class="ticker">${esc(coin.symbol || '')}</span>
					${coin.rank != null ? `<span class="cv-rank-badge">#${coin.rank}</span>` : ''}
				</div>
				<div class="cv-price-row">
					<span class="cv-price cv-mono">${esc(formatPrice(m.price))}</span>
					<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
						${chip('24h', m.change_pct?.h24)}${chip('7d', m.change_pct?.d7)}${chip('30d', m.change_pct?.d30)}
					</div>
				</div>
				${
					todayAbs != null
						? `<p class="cv-today">${todayAbs >= 0 ? '+' : '−'}$${Math.abs(todayAbs).toFixed(Math.abs(todayAbs) < 1 ? 4 : 2)} today</p>`
						: ''
				}
				${
					coin.categories?.length
						? `<div class="cv-cats">${coin.categories.map((c) => `<span class="cv-cat">${esc(c)}</span>`).join('')}</div>`
						: ''
				}
			</div>
		</div>`;
}

// ── Chart ───────────────────────────────────────────────────────────────────

const chartState = { days: 30, series: [], loading: true, error: null };

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 60, bottom: 30, left: 10 };

function chartGeometry(series) {
	const closes = series.map((p) => p[1]);
	const min = Math.min(...closes);
	const max = Math.max(...closes);
	const range = max - min || 1;
	const w = CHART_W - PAD.left - PAD.right;
	const h = CHART_H - PAD.top - PAD.bottom;
	const pts = closes.map((v, i) => ({
		x: PAD.left + (i / (closes.length - 1)) * w,
		y: PAD.top + h - ((v - min) / range) * h,
	}));
	const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
	const area = `${line} L${pts[pts.length - 1].x.toFixed(2)},${PAD.top + h} L${pts[0].x.toFixed(2)},${PAD.top + h} Z`;
	const first = closes[0];
	const last = closes[closes.length - 1];
	return {
		min,
		max,
		range,
		line,
		area,
		up: last >= first,
		changePct: first > 0 ? ((last - first) / first) * 100 : 0,
	};
}

function renderChart(coin) {
	const el = $('cv-chart');
	const { days, series, loading, error } = chartState;

	const rangeBtns = TIME_RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days}" aria-pressed="${r.days === days}">${r.label}</button>`,
	).join('');

	let body;
	if (loading) {
		body = '<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading chart…</div>';
	} else if (error || series.length < 2) {
		body = '<div class="cv-chart-state">Chart data unavailable</div>';
	} else {
		const g = chartGeometry(series);
		const color = g.up ? 'var(--cv-chart-green)' : 'var(--cv-chart-red)';
		const steps = 4;
		const h = CHART_H - PAD.top - PAD.bottom;
		const yLabels = Array.from({ length: steps + 1 }, (_, i) => {
			const price = g.min + (g.range * i) / steps;
			const y = PAD.top + h - (i / steps) * h;
			return `<g><line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CHART_W - PAD.right + 8}" y="${y + 4}" font-size="10" fill="var(--cv-text-3)">${esc(formatPrice(price))}</text></g>`;
		}).join('');
		body = `
			<div class="cv-chart-area">
				<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"
					aria-label="Price chart for ${esc(coin.name)} over ${days} day${days > 1 ? 's' : ''}. Change: ${esc(formatPercent(g.changePct))}">
					<defs>
						<linearGradient id="cv-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
							<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${yLabels}
					<path d="${g.area}" fill="url(#cv-grad)"/>
					<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					<g id="cv-crosshair" hidden>
						<line id="cv-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="cv-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="cv-tip" hidden>
					<p class="p cv-mono" id="cv-tip-price"></p>
					<p class="d" id="cv-tip-date"></p>
				</div>
			</div>`;
	}

	const pct =
		!loading && !error && series.length >= 2
			? (() => {
					const g = chartGeometry(series);
					return `<span class="pct ${g.up ? 'cv-up' : 'cv-down'} cv-mono">${esc(formatPercent(g.changePct))}</span>`;
				})()
			: '';

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">Price Chart</span>${pct}</div>
				<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
			</div>
			${body}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const d = Number(btn.dataset.days);
			if (d === chartState.days) return;
			chartState.days = d;
			loadChart(coin);
		});
	});

	wireChartPointer();
}

function wireChartPointer() {
	const svg = $('cv-chart').querySelector('svg');
	const tip = $('cv-tip');
	if (!svg || !tip || chartState.series.length < 2) return;
	const g = chartGeometry(chartState.series);
	const cross = svg.querySelector('#cv-crosshair');
	const crossLine = svg.querySelector('#cv-cross-line');
	const crossDot = svg.querySelector('#cv-cross-dot');
	const usableW = CHART_W - PAD.left - PAD.right;
	const usableH = CHART_H - PAD.top - PAD.bottom;

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
		const n = chartState.series.length;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mouseX - PAD.left) / usableW) * (n - 1))));
		const [ts, price] = chartState.series[i];
		const x = PAD.left + (i / (n - 1)) * usableW;
		const y = PAD.top + usableH - ((price - g.min) / g.range) * usableH;
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);
		crossDot.setAttribute('cx', x);
		crossDot.setAttribute('cy', y);
		tip.hidden = false;
		tip.style.left = `${(x / CHART_W) * 100}%`;
		$('cv-tip-price').textContent = formatPrice(price);
		$('cv-tip-date').textContent = formatChartTick(ts, chartState.days);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

async function loadChart(coin) {
	chartState.loading = true;
	chartState.error = null;
	renderChart(coin);
	try {
		const { data } = await getJson(`/api/coin/ohlc?id=${encodeURIComponent(coin.id)}&days=${chartState.days}`);
		chartState.series = data;
		chartState.loading = false;
	} catch (err) {
		chartState.loading = false;
		chartState.error = err;
		chartState.series = [];
	}
	renderChart(coin);
}

// ── Stats grid ──────────────────────────────────────────────────────────────

function miniStat(label, value, { sub, tone } = {}) {
	return `
		<div class="cv-mini-stat">
			<p class="label">${esc(label)}</p>
			<p class="value cv-mono${tone ? ` ${tone}` : ''}">${esc(value)}</p>
			${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
		</div>`;
}

function renderStats(coin) {
	const m = coin.market || {};
	$('cv-stats').innerHTML = `
		<h2 class="cv-h2">Market Stats</h2>
		<div class="cv-stats-grid">
			${miniStat('Market Cap', formatUsd(m.market_cap))}
			${miniStat('24h Volume', formatUsd(m.volume_24h))}
			${miniStat('Circulating Supply', formatSupply(m.circulating))}
			${miniStat('Total Supply', m.total != null ? formatSupply(m.total) : '—')}
			${miniStat('All-Time High', formatPrice(m.ath), { sub: m.ath_date ? formatDateShort(m.ath_date) : undefined, tone: 'green' })}
			${miniStat('All-Time Low', formatPrice(m.atl), { sub: m.atl_date ? formatDateShort(m.atl_date) : undefined, tone: 'red' })}
			${miniStat('24h High', formatPrice(m.high_24h))}
			${miniStat('24h Low', formatPrice(m.low_24h))}
		</div>`;
}

// ── News ────────────────────────────────────────────────────────────────────

async function loadNews(coin) {
	const el = $('cv-news');
	try {
		const { articles } = await getJson(
			`/api/coin/news?q=${encodeURIComponent(coin.name)}&limit=8`,
		);
		if (!articles?.length) {
			el.innerHTML = '';
			return;
		}
		el.innerHTML = `
			<h2 class="cv-h2">Latest ${esc(coin.name)} News</h2>
			<div class="cv-news-grid">
				${articles
					.map(
						(a) => `
					<a class="cv-news-card" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">
						${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" />` : ''}
						<div style="min-width:0">
							<p class="t">${esc(a.title)}</p>
							<p class="m">${a.source ? `<span class="src">${esc(a.source)}</span> · ` : ''}${esc(timeAgo(a.published_at))}</p>
						</div>
					</a>`,
					)
					.join('')}
			</div>`;
	} catch {
		// News is an enhancement rail — a failed upstream hides the section
		// rather than blocking the coin profile.
		el.innerHTML = '';
	}
}

// ── About + links ───────────────────────────────────────────────────────────

function renderAbout(coin) {
	const el = $('cv-about');
	if (!coin.description) {
		el.innerHTML = '';
		return;
	}
	const paras = coin.description
		.split(/\n{2,}/)
		.filter((p) => p.trim())
		.slice(0, 6)
		.map((p) => `<p>${esc(p.trim())}</p>`)
		.join('');
	el.innerHTML = `<h2 class="cv-h2">About ${esc(coin.name)}</h2><div class="cv-prose">${paras}</div>`;
}

function pill(href, label) {
	return `<a class="cv-pill" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

function renderLinks(coin) {
	const l = coin.links || {};
	const pills = [];
	if (l.homepage) pills.push(pill(l.homepage, 'Website'));
	if (l.twitter) pills.push(pill(`https://twitter.com/${l.twitter}`, 'Twitter'));
	if (l.reddit) pills.push(pill(l.reddit, 'Reddit'));
	if (l.telegram) pills.push(pill(`https://t.me/${l.telegram}`, 'Telegram'));
	if (l.github) pills.push(pill(l.github, 'GitHub'));
	for (const url of (l.explorers || []).slice(0, 2)) pills.push(pill(url, 'Explorer'));

	// three.ws integration: a Solana contract gets first-party intel links.
	const solMint = coin.platforms?.solana;
	const contracts = Object.entries(coin.platforms || {}).slice(0, 3);

	let contractHtml = '';
	if (contracts.length) {
		contractHtml = `
			<div class="cv-pills" style="margin-top:0.75rem">
				${contracts
					.map(
						([chain, addr]) => `
					<span class="cv-contract" title="${esc(addr)}">
						<span>${esc(chain)}: ${esc(addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr)}</span>
						<button type="button" data-copy="${esc(addr)}" aria-label="Copy ${esc(chain)} contract address">Copy</button>
					</span>`,
					)
					.join('')}
			</div>`;
	}

	let threewsHtml = '';
	if (solMint && MINT_RE.test(solMint)) {
		threewsHtml = `
			<div class="cv-pills" style="margin-top:0.75rem">
				<a class="cv-pill" href="/alpha-copilot?mint=${encodeURIComponent(solMint)}">Analyze with Alpha Copilot</a>
				<a class="cv-pill" href="/trades?mint=${encodeURIComponent(solMint)}">Live trades on three.ws</a>
			</div>`;
	}

	$('cv-links').innerHTML = pills.length || contractHtml || threewsHtml
		? `<h2 class="cv-h2">Links</h2><div class="cv-pills">${pills.join('')}</div>${contractHtml}${threewsHtml}`
		: '';

	$('cv-links').querySelectorAll('button[data-copy]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(btn.dataset.copy);
				btn.textContent = 'Copied';
				setTimeout(() => (btn.textContent = 'Copy'), 1500);
			} catch {
				btn.textContent = 'Copy failed';
			}
		});
	});
}

// ── Not found / error states ────────────────────────────────────────────────

function renderNotFound(id) {
	const mintish = MINT_RE.test(id);
	$('cv-head').innerHTML = `
		<h1 class="cv-h1">Coin not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find market data for “${esc(id)}”. The coin may not be
			listed on the market data source, or the id is misspelled.</p>
			<p style="margin:0">
				Try the <a href="/coins">markets index</a>${
					mintish
						? ` — or, since this looks like a Solana mint address, check
					<a href="/launches/${esc(id)}">its launch profile</a> or
					<a href="/coin-intel">Coin Intelligence</a> on three.ws`
						: ''
				}.
			</p>
		</div>`;
	$('cv-chart').innerHTML = '';
	$('cv-stats').innerHTML = '';
	$('cv-crumb-name').textContent = 'Not found';
}

function renderError() {
	$('cv-head').innerHTML = `
		<h1 class="cv-h1">Market data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0">The market data source is temporarily unreachable. This usually clears in
			under a minute — <a href="javascript:location.reload()">reload the page</a> or head back to the
			<a href="/coins">markets index</a>.</p>
		</div>`;
	$('cv-chart').innerHTML = '';
	$('cv-stats').innerHTML = '';
}

// ── SEO / document metadata ─────────────────────────────────────────────────

function updateMeta(coin) {
	const m = coin.market || {};
	const title = `${coin.name} (${coin.symbol}) Price${m.price != null ? ` — ${formatPrice(m.price)}` : ''} · three.ws`;
	document.title = title;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const desc = `Live ${coin.name} price, interactive chart, market stats, and news.${m.change_pct?.h24 != null ? ` 24h: ${formatPercent(m.change_pct.h24)}.` : ''}`;
	set('meta[name="description"]', 'content', desc);
	set('meta[property="og:title"]', 'content', title);
	set('meta[property="og:description"]', 'content', desc);
	set('meta[property="og:url"]', 'content', `https://three.ws/coin/${coin.id}`);
	let canon = document.querySelector('link[rel="canonical"]');
	if (!canon) {
		canon = document.createElement('link');
		canon.rel = 'canonical';
		document.head.appendChild(canon);
	}
	canon.href = `https://three.ws/coin/${coin.id}`;
	if (coin.image) set('meta[property="og:image"]', 'content', coin.image);
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
	const id = coinIdFromPath();
	const main_ = $('cv-main');
	if (!id) {
		location.replace('/coins');
		return;
	}
	renderSkeletons();

	let coin;
	try {
		const param = MINT_RE.test(id) ? `contract=${encodeURIComponent(id)}` : `id=${encodeURIComponent(id)}`;
		({ coin } = await getJson(`/api/coin/detail?${param}`));
	} catch (err) {
		main_.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(id);
		else renderError();
		return;
	}

	main_.removeAttribute('aria-busy');
	updateMeta(coin);
	renderHead(coin);
	renderStats(coin);
	renderAbout(coin);
	renderLinks(coin);
	if (coin.last_updated) {
		const upd = $('cv-updated');
		upd.hidden = false;
		upd.textContent = `Last updated: ${new Date(coin.last_updated).toLocaleString()}`;
	}
	// Chart + news stream in independently of the core profile.
	loadChart(coin);
	loadNews(coin);
}

main();
