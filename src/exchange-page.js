// /exchange/:id — rich profile for one crypto exchange, part of the three.ws
// Markets surface. Hero (logo / name / trust score / rank / country / year /
// centralized chip / description / link pills), stat cards, an interactive SVG
// volume-history chart with a range toggle and crosshair tooltip (spot venues
// only), and a markets/contracts table. Derivatives venues — which live on a
// separate CoinGecko namespace — render open interest, perp/futures counts, and
// a contracts table instead of a volume chart. Data comes from the
// /api/coin/exchange proxy (CoinGecko + live BTC price) — never mocked. Mirrors
// the /coin/:id detail-page pattern (src/coin-page.js).

import {
	formatUsd,
	formatPrice,
	formatChartTick,
	escapeHtml as esc,
} from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

// Matches the /exchange/:id route; falls back to the ?id= query for direct
// links and dev proxies that don't rewrite the path.
function idFromLocation() {
	const m = location.pathname.match(/^\/exchange\/([a-z0-9_-]{1,60})$/i);
	if (m) return m[1].toLowerCase();
	const q = new URLSearchParams(location.search).get('id');
	return q && /^[a-z0-9_-]{1,60}$/i.test(q) ? q.toLowerCase() : null;
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

// BTC volume figure: 4 decimals below 1 BTC, whole otherwise.
function formatBtc(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 0 })} BTC`;
}

// A twitter_handle from CoinGecko is a bare handle ("binance") but occasionally
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
	$('ex-hero').innerHTML = `
		<div class="ex-hero">
			<div class="cv-skel" style="width:72px;height:72px;border-radius:16px;flex-shrink:0"></div>
			<div style="flex:1;min-width:0">
				<div class="cv-skel" style="width:14rem;height:2rem"></div>
				<div class="cv-skel" style="width:22rem;max-width:100%;height:1.25rem;margin-top:0.75rem"></div>
				<div class="cv-skel" style="width:30rem;max-width:100%;height:3.5rem;margin-top:0.75rem"></div>
			</div>
		</div>`;
	$('ex-stats').innerHTML =
		'<div class="cv-stats-grid">' +
		Array.from({ length: 4 }, () => '<div class="cv-skel" style="height:5.5rem"></div>').join('') +
		'</div>';
	$('ex-chart').innerHTML =
		'<div class="cv-chart-panel"><div class="cv-skel" style="height:300px;border-radius:8px"></div></div>';
	$('ex-markets').innerHTML = `
		<h2 class="cv-h2">Markets</h2>
		<div class="cv-table-wrap" style="padding:0.75rem">
			${Array.from({ length: 8 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('')}
		</div>`;
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function trustScoreBadge(score) {
	if (score == null || !Number.isFinite(score)) return '';
	const band = score >= 7 ? 'hi' : score >= 5 ? 'mid' : 'lo';
	return `<span class="ex-score ex-score-${band}" title="CoinGecko trust score — a 0–10 measure of a venue's liquidity, scale, and data integrity">${esc(
		score.toFixed(1),
	)}<span class="of">/10</span></span>`;
}

function metaChips(d) {
	const chips = [];
	if (d.centralized === true) chips.push('<span class="ex-chip">Centralized</span>');
	else if (d.centralized === false) chips.push('<span class="ex-chip ex-chip-dex">DEX</span>');
	if (d.type === 'derivatives') chips.push('<span class="ex-chip">Derivatives</span>');
	if (d.country) chips.push(`<span class="ex-chip">${esc(d.country)}</span>`);
	if (d.year_established != null)
		chips.push(`<span class="ex-chip">Est. ${esc(String(d.year_established))}</span>`);
	return chips.length ? `<div class="ex-meta">${chips.join('')}</div>` : '';
}

function linkPill(href, label) {
	return `<a class="cv-pill" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

function heroLinks(d) {
	const s = d.socials || {};
	const pills = [];
	if (d.url) pills.push(linkPill(d.url, 'Website'));
	const tw = s.twitter ? twitterUrl(s.twitter) : null;
	if (tw) pills.push(linkPill(tw, 'Twitter'));
	if (s.reddit_url) pills.push(linkPill(s.reddit_url, 'Reddit'));
	if (s.telegram_url) pills.push(linkPill(s.telegram_url, 'Telegram'));
	if (s.facebook_url) pills.push(linkPill(s.facebook_url, 'Facebook'));
	for (const url of s.other_urls || []) pills.push(linkPill(url, 'Link'));
	return pills.length ? `<div class="cv-pills ex-links">${pills.join('')}</div>` : '';
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
	return paras ? `<div class="cv-prose ex-desc">${paras}</div>` : '';
}

function renderHero(d) {
	$('ex-crumb-name').textContent = d.name;
	$('ex-hero').innerHTML = `
		<div class="ex-hero">
			${
				d.image
					? `<img class="ex-logo" src="${esc(d.image)}" alt="${esc(d.name)} logo" width="72" height="72" loading="eager" data-no-dark-filter />`
					: '<div class="ex-logo ex-logo-fallback" aria-hidden="true"></div>'
			}
			<div class="ex-hero-body">
				<div class="ex-title-row">
					<h1 class="cv-h1 ex-title">${esc(d.name)}</h1>
					${trustScoreBadge(d.trust_score)}
					${d.trust_score_rank != null ? `<span class="ex-rank" title="Trust-score rank">#${esc(String(d.trust_score_rank))}</span>` : ''}
				</div>
				${metaChips(d)}
				${heroDescription(d)}
				${heroLinks(d)}
			</div>
		</div>`;
}

// ── Stat cards ───────────────────────────────────────────────────────────────

const INFO_ICON =
	'<span class="ex-info" tabindex="0" role="img" aria-label="Adjusted to discount inflated or wash-traded volume" title="Adjusted to discount inflated or wash-traded volume">ⓘ</span>';

function statCard({ label, value, sub, info }) {
	return `
		<div class="cv-mini-stat ex-stat">
			<p class="label">${esc(label)}${info ? ` ${INFO_ICON}` : ''}</p>
			<p class="value cv-mono">${esc(value)}</p>
			${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
		</div>`;
}

// A BTC amount rendered as USD when the live BTC price is available, with the
// BTC figure as the sub-line; falls back to BTC-only when the price is missing.
function btcValueSub(btc, btcUsd) {
	if (btc == null || !Number.isFinite(btc)) return { value: '—', sub: undefined };
	if (btcUsd != null && btcUsd > 0) return { value: formatUsd(btc * btcUsd), sub: formatBtc(btc) };
	return { value: formatBtc(btc), sub: undefined };
}

function renderStats(d, btcUsd) {
	const cards = [];
	if (d.type === 'derivatives') {
		const oi = btcValueSub(d.open_interest_btc, btcUsd);
		const vol = btcValueSub(d.trade_volume_24h_btc, btcUsd);
		cards.push(statCard({ label: 'Open Interest', value: oi.value, sub: oi.sub }));
		cards.push(statCard({ label: '24h Volume', value: vol.value, sub: vol.sub }));
		cards.push(
			statCard({
				label: 'Perpetual Pairs',
				value: d.number_of_perpetual_pairs != null ? d.number_of_perpetual_pairs.toLocaleString('en-US') : '—',
			}),
		);
		cards.push(
			statCard({
				label: 'Futures Pairs',
				value: d.number_of_futures_pairs != null ? d.number_of_futures_pairs.toLocaleString('en-US') : '—',
			}),
		);
	} else {
		const vol = btcValueSub(d.trade_volume_24h_btc, btcUsd);
		const norm = btcValueSub(d.trade_volume_24h_btc_normalized, btcUsd);
		cards.push(statCard({ label: '24h Volume', value: vol.value, sub: vol.sub }));
		cards.push(
			statCard({
				label: 'Normalized 24h Volume',
				value: norm.value,
				sub: norm.sub,
				info: true,
			}),
		);
		cards.push(
			statCard({
				label: 'Markets',
				value: d.tickers_count != null ? d.tickers_count.toLocaleString('en-US') : '—',
			}),
		);
		cards.push(
			statCard({
				label: 'Trust Rank',
				value: d.trust_score_rank != null ? `#${d.trust_score_rank}` : '—',
			}),
		);
	}
	$('ex-stats').innerHTML = `<div class="cv-stats-grid">${cards.join('')}</div>`;
}

// ── Volume chart (spot venues) ───────────────────────────────────────────────

const TIME_RANGES = [
	{ label: '7D', days: 7 },
	{ label: '14D', days: 14 },
	{ label: '30D', days: 30 },
	{ label: '90D', days: 90 },
	{ label: '180D', days: 180 },
	{ label: '1Y', days: 365 },
];

const CHART_W = 800;
const CHART_H = 300;
const PAD = { top: 20, right: 72, bottom: 30, left: 10 };

// series: [[ts_ms, vol_btc], …]. btcUsd converts the crosshair readout to USD.
const chartState = { days: 30, series: [], btcUsd: null, loading: false, error: false, name: '' };

function chartGeometry(series) {
	const vals = series.map((p) => p[1]);
	const min = Math.min(...vals, 0); // volume floors at 0 — anchor the area there
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

function volAxisLabel(btc, btcUsd) {
	return btcUsd != null && btcUsd > 0 ? formatUsd(btc * btcUsd) : formatBtc(btc);
}

function renderChart() {
	const el = $('ex-chart');
	const { days, series, loading, error, name } = chartState;

	const rangeBtns = TIME_RANGES.map(
		(r) =>
			`<button type="button" class="cv-range-btn" data-days="${r.days}" aria-pressed="${r.days === days}">${r.label}</button>`,
	).join('');

	let body;
	if (loading) {
		body = '<div class="cv-chart-state"><span class="cv-spinner" aria-hidden="true"></span>Loading chart…</div>';
	} else if (error) {
		body = '<div class="cv-chart-state">Volume history is temporarily unavailable.</div>';
	} else if (series.length < 2) {
		body = '<div class="cv-chart-state">No volume history available for this range.</div>';
	} else {
		const g = chartGeometry(series);
		const color = 'var(--cv-chart-green)';
		const steps = 4;
		const h = CHART_H - PAD.top - PAD.bottom;
		const yLabels = Array.from({ length: steps + 1 }, (_, i) => {
			const v = g.min + (g.range * i) / steps;
			const y = PAD.top + h - (i / steps) * h;
			return `<g><line x1="${PAD.left}" y1="${y}" x2="${CHART_W - PAD.right}" y2="${y}" stroke="var(--cv-border)" stroke-width="0.5" stroke-dasharray="4 4" opacity="0.5"/><text x="${CHART_W - PAD.right + 8}" y="${y + 4}" font-size="10" fill="var(--cv-text-3)">${esc(volAxisLabel(v, chartState.btcUsd))}</text></g>`;
		}).join('');
		body = `
			<div class="cv-chart-area">
				<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img"
					aria-label="24h volume history for ${esc(name)} over ${days} day${days > 1 ? 's' : ''}, denominated in BTC">
					<defs>
						<linearGradient id="ex-grad" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
							<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
						</linearGradient>
					</defs>
					${yLabels}
					<path d="${g.area}" fill="url(#ex-grad)"/>
					<path d="${g.line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					<g id="ex-crosshair" hidden>
						<line id="ex-cross-line" x1="0" y1="${PAD.top}" x2="0" y2="${CHART_H - PAD.bottom}" stroke="var(--cv-text-3)" stroke-width="0.5" stroke-dasharray="3 3"/>
						<circle id="ex-cross-dot" r="4" fill="${color}" stroke="var(--cv-surface)" stroke-width="2"/>
					</g>
				</svg>
				<div class="cv-chart-tip" id="ex-tip" hidden>
					<p class="p cv-mono" id="ex-tip-val"></p>
					<p class="p cv-mono" id="ex-tip-btc"></p>
					<p class="d" id="ex-tip-date"></p>
				</div>
			</div>`;
	}

	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar">
				<div class="left"><span class="title">24h Volume History</span></div>
				<div class="cv-ranges" role="group" aria-label="Chart time range">${rangeBtns}</div>
			</div>
			${body}
		</div>`;

	el.querySelectorAll('.cv-range-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const dd = Number(btn.dataset.days);
			if (dd === chartState.days) return;
			chartState.days = dd;
			loadChart();
		});
	});

	wireChartPointer();
}

function wireChartPointer() {
	const svg = $('ex-chart').querySelector('svg');
	const tip = $('ex-tip');
	if (!svg || !tip || chartState.series.length < 2) return;
	const g = chartGeometry(chartState.series);
	const cross = svg.querySelector('#ex-crosshair');
	const crossLine = svg.querySelector('#ex-cross-line');
	const crossDot = svg.querySelector('#ex-cross-dot');
	const usableW = CHART_W - PAD.left - PAD.right;
	const usableH = CHART_H - PAD.top - PAD.bottom;

	function show(clientX) {
		const rect = svg.getBoundingClientRect();
		const mouseX = ((clientX - rect.left) / rect.width) * CHART_W;
		const n = chartState.series.length;
		const i = Math.max(0, Math.min(n - 1, Math.round(((mouseX - PAD.left) / usableW) * (n - 1))));
		const [ts, btc] = chartState.series[i];
		const x = PAD.left + (i / (n - 1)) * usableW;
		const y = PAD.top + usableH - ((btc - g.min) / g.range) * usableH;
		cross.removeAttribute('hidden');
		crossLine.setAttribute('x1', x);
		crossLine.setAttribute('x2', x);
		crossDot.setAttribute('cx', x);
		crossDot.setAttribute('cy', y);
		tip.hidden = false;
		tip.style.left = `${(x / CHART_W) * 100}%`;
		const usd =
			chartState.btcUsd != null && chartState.btcUsd > 0 ? formatUsd(btc * chartState.btcUsd) : null;
		$('ex-tip-val').textContent = usd || formatBtc(btc);
		$('ex-tip-btc').textContent = usd ? formatBtc(btc) : '';
		$('ex-tip-btc').hidden = !usd;
		$('ex-tip-date').textContent = formatChartTick(ts, chartState.days);
	}
	function hide() {
		cross.setAttribute('hidden', '');
		tip.hidden = true;
	}
	svg.addEventListener('pointermove', (e) => show(e.clientX));
	svg.addEventListener('pointerleave', hide);
	svg.addEventListener('pointerdown', (e) => show(e.clientX));
}

async function loadChart() {
	chartState.loading = true;
	chartState.error = false;
	renderChart();
	try {
		const { volume_chart, btc_usd } = await getJson(
			`/api/coin/exchange?id=${encodeURIComponent(chartState.id)}&view=chart&days=${chartState.days}`,
		);
		chartState.series = Array.isArray(volume_chart) ? volume_chart : [];
		if (btc_usd != null) chartState.btcUsd = btc_usd;
		chartState.loading = false;
	} catch {
		chartState.loading = false;
		chartState.error = true;
		chartState.series = [];
	}
	renderChart();
}

// ── Markets / contracts table ────────────────────────────────────────────────

const TRADE_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

function trustDot(trust) {
	if (!trust) return '<span class="ex-trust-cell"><span class="dim">—</span></span>';
	const label = { green: 'High', yellow: 'Fair', red: 'Low' }[trust] || '';
	return `<span class="ex-trust-cell"><span class="ex-dot ex-dot-${esc(trust)}" aria-hidden="true"></span>${esc(label)}</span>`;
}

function spotRow(t) {
	const pairLabel = esc(t.pair || '—');
	const pairCell = t.coin_id
		? `<a class="ex-pair-link" href="/coin/${encodeURIComponent(t.coin_id)}">${pairLabel}</a>`
		: `<span>${pairLabel}</span>`;
	const trade = t.trade_url
		? `<a class="ex-trade" href="${esc(t.trade_url)}" target="_blank" rel="noopener noreferrer" aria-label="Trade ${pairLabel} (opens in a new tab)">${TRADE_ICON}</a>`
		: '';
	return `
		<tr class="${t.stale ? 'ex-stale' : ''}">
			<td class="left"><span class="ex-pair">${pairCell}${trade}</span></td>
			<td class="cv-mono">${esc(formatPrice(t.price_usd))}</td>
			<td class="cv-mono">${t.spread_pct != null ? `${t.spread_pct.toFixed(2)}%` : '—'}</td>
			<td class="cv-mono">${esc(formatUsd(t.volume_usd))}</td>
			<td>${trustDot(t.trust)}</td>
		</tr>`;
}

function derivRow(t) {
	const sym = esc(t.symbol || '—');
	const symCell = t.trade_url
		? `<a class="ex-pair-link" href="${esc(t.trade_url)}" target="_blank" rel="noopener noreferrer">${sym} <span class="ex-trade-inline" aria-hidden="true">↗</span></a>`
		: `<span>${sym}</span>`;
	const funding =
		t.funding_rate != null
			? `<span class="${t.funding_rate >= 0 ? 'cv-up' : 'cv-down'}">${t.funding_rate >= 0 ? '+' : ''}${t.funding_rate.toFixed(4)}%</span>`
			: '—';
	return `
		<tr>
			<td class="left"><span class="ex-pair">${symCell}</span></td>
			<td class="cv-mono">${esc(formatPrice(t.price))}</td>
			<td class="cv-mono">${esc(formatPrice(t.index))}</td>
			<td class="cv-mono">${funding}</td>
			<td class="cv-mono">${esc(formatUsd(t.open_interest_usd))}</td>
			<td class="cv-mono">${esc(formatUsd(t.volume_24h_usd))}</td>
		</tr>`;
}

function renderMarkets(d) {
	const el = $('ex-markets');
	const tickers = Array.isArray(d.tickers) ? d.tickers : [];
	const heading = d.type === 'derivatives' ? 'Contracts' : 'Markets';
	if (!tickers.length) {
		el.innerHTML = `
			<h2 class="cv-h2">${heading}</h2>
			<div class="cv-empty">No ${d.type === 'derivatives' ? 'active contracts' : 'markets'} to show for this exchange right now.</div>`;
		return;
	}

	const head =
		d.type === 'derivatives'
			? `<tr>
					<th scope="col" class="left">Symbol</th>
					<th scope="col">Price</th>
					<th scope="col">Index</th>
					<th scope="col">Funding</th>
					<th scope="col">Open Interest</th>
					<th scope="col">24h Vol</th>
				</tr>`
			: `<tr>
					<th scope="col" class="left">Pair</th>
					<th scope="col">Price</th>
					<th scope="col">Spread</th>
					<th scope="col">24h Volume</th>
					<th scope="col">Trust</th>
				</tr>`;
	const body = tickers.map(d.type === 'derivatives' ? derivRow : spotRow).join('');
	const shown = tickers.length;
	const total = d.tickers_count ?? shown;
	const note =
		total > shown
			? `<p class="ex-mkt-note">Showing the top ${shown} of ${total.toLocaleString('en-US')} ${d.type === 'derivatives' ? 'contracts' : 'markets'} by volume.</p>`
			: '';

	el.innerHTML = `
		<h2 class="cv-h2">${heading}</h2>
		<div class="cv-table-wrap">
			<table class="cv-table ex-mkt-table">
				<thead>${head}</thead>
				<tbody>${body}</tbody>
			</table>
		</div>
		${note}`;
}

// ── Error / not-found states ─────────────────────────────────────────────────

function renderNotFound(id) {
	$('ex-crumb-name').textContent = 'Not found';
	$('ex-hero').innerHTML = `
		<h1 class="cv-h1">Exchange not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find an exchange for “${esc(id)}”. It may not be
			tracked by the market-data source, or the id is misspelled.</p>
			<p style="margin:0">Browse the <a href="/exchanges">exchanges directory</a> or head back to
			<a href="/markets">Markets</a>.</p>
		</div>`;
	$('ex-stats').innerHTML = '';
	$('ex-chart').innerHTML = '';
	$('ex-markets').innerHTML = '';
}

function renderError(id) {
	$('ex-hero').innerHTML = `
		<h1 class="cv-h1">Exchange data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">The market-data source is temporarily unreachable. This usually
			clears within a minute.</p>
			<button type="button" class="ex-retry" id="ex-retry">Retry</button>
			<span style="margin-left:0.75rem">or return to the <a href="/exchanges">exchanges directory</a>.</span>
		</div>`;
	$('ex-stats').innerHTML = '';
	$('ex-chart').innerHTML = '';
	$('ex-markets').innerHTML = '';
	$('ex-retry')?.addEventListener('click', () => main());
}

// ── SEO / document metadata ──────────────────────────────────────────────────

function updateMeta(d, id) {
	const title = `${d.name} — Exchange · three.ws`;
	document.title = title;
	const url = `https://three.ws/exchange/${id}`;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const kind = d.type === 'derivatives' ? 'derivatives exchange' : 'crypto exchange';
	const desc = `${d.name} ${kind} profile${d.trust_score != null ? ` — trust score ${d.trust_score.toFixed(1)}/10` : ''}: 24h volume, markets, and history. Real CoinGecko data.`;
	set('meta[name="description"]', 'content', desc);
	set('meta[property="og:title"]', 'content', title);
	set('meta[property="og:description"]', 'content', desc);
	set('meta[property="og:url"]', 'content', url);
	set('meta[name="twitter:title"]', 'content', title);
	set('meta[name="twitter:description"]', 'content', desc);
	if (d.image) {
		set('meta[property="og:image"]', 'content', d.image);
		set('meta[name="twitter:image"]', 'content', d.image);
	}
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
	const root = $('ex-main');
	if (!id) {
		location.replace('/exchanges');
		return;
	}
	renderSkeletons();

	let payload;
	try {
		payload = await getJson(`/api/coin/exchange?id=${encodeURIComponent(id)}`);
	} catch (err) {
		root.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(id);
		else renderError(id);
		return;
	}

	const d = payload.detail || {};
	const btcUsd = payload.btc_usd ?? null;
	root.removeAttribute('aria-busy');

	updateMeta(d, id);
	renderHero(d);
	renderStats(d, btcUsd);
	renderMarkets(d);

	// Volume history is spot-only — derivatives venues have no upstream chart.
	if (d.type === 'derivatives' || payload.volume_chart == null) {
		$('ex-chart').innerHTML = '';
	} else {
		chartState.id = id;
		chartState.name = d.name;
		chartState.btcUsd = btcUsd;
		chartState.days = 30;
		chartState.series = Array.isArray(payload.volume_chart) ? payload.volume_chart : [];
		chartState.loading = false;
		chartState.error = false;
		renderChart();
	}

	const upd = $('ex-updated');
	upd.hidden = false;
	upd.textContent = `Updated ${new Date(payload.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: CoinGecko`;
}

main();
