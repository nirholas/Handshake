/**
 * Agent Economy Volume dashboard: fetches and renders the platform-wide
 * agent-to-agent economy roll-up from /api/agent-economy/volume.
 *
 * Every number is a live aggregate over the real `agent_hires` ledger (settled
 * USDC moved from one agent to another over x402). The volume bar chart is drawn
 * with the native Canvas API, with no external charting dependency, and carries
 * a screen-reader table of the same series so the data is never canvas-only.
 */

const ENDPOINT = '/api/agent-economy/volume';
const REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

let currentWindow = 30;
let lastDaily = []; // cached so the window toggle can redraw without refetching
let hasData = false; // a successful load has painted real numbers at least once
let inFlight = false;
let chartHit = null; // bar geometry from the last paint, for tooltip hit testing

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtUsd(n, { compact = false } = {}) {
	const v = Number(n) || 0;
	if (compact) {
		if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
		if (v >= 10_000) return `$${(v / 1_000).toFixed(1)}K`;
		if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
	}
	if (v > 0 && v < 1) return `$${v.toFixed(4)}`;
	return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtCount(n) {
	return (Number(n) || 0).toLocaleString();
}

function relTime(iso) {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d ago`;
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

function initials(name) {
	const parts = String(name || 'Agent').trim().split(/\s+/).slice(0, 2);
	return parts.map((p) => p[0]?.toUpperCase() || '').join('') || 'A';
}

// The API buckets each day with Postgres date_trunc, which runs in UTC, so the
// client series has to be built and labelled in UTC too. Deriving day keys from
// the visitor's local calendar puts every bar one day off east of UTC.
function utcDayKey(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

function dayLabel(key, opts = { month: 'short', day: 'numeric' }) {
	const [y, m, d] = String(key).split('-').map(Number);
	if (!Number.isFinite(y)) return String(key);
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

// ── Components ───────────────────────────────────────────────────────────────

function statCard(val, lbl, sub) {
	return `<div class="stat-card">
		<div class="stat-val">${val}</div>
		<div class="stat-lbl">${escapeHtml(lbl)}</div>
		${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
	</div>`;
}

function initialsTile(name) {
	return `<div class="rank-av-fallback" aria-hidden="true">${escapeHtml(initials(name))}</div>`;
}

function avatarCell(agent) {
	if (agent.avatar_thumbnail_url) {
		return `<img class="rank-av" src="${escapeHtml(agent.avatar_thumbnail_url)}" alt="" loading="lazy" data-name="${escapeHtml(agent.name || 'Agent')}" />`;
	}
	return initialsTile(agent.name);
}

// A thumbnail whose stored object has since been pruned still resolves to a URL,
// so the row would paint the browser's broken-image glyph. Swap it for the same
// initials tile an agent without a thumbnail gets. `error` does not bubble, so
// the listener goes on each image rather than on the list.
function wireAvatarFallbacks(root) {
	root.querySelectorAll('img.rank-av').forEach((img) => {
		img.addEventListener('error', () => {
			img.outerHTML = initialsTile(img.dataset.name);
		}, { once: true });
	});
}

function rankRow(num, agent, sub, primary, secondary) {
	const link = agent.url;
	const tag = link ? 'a' : 'div';
	const attrs = link ? `href="${escapeHtml(link)}" class="rank-row is-link"` : 'class="rank-row"';
	return `<${tag} ${attrs}>
		<span class="rank-num">${num}</span>
		${avatarCell(agent)}
		<div class="rank-meta">
			<div class="rank-name">${escapeHtml(agent.name || 'Agent')}</div>
			${sub ? `<div class="rank-sub">${escapeHtml(sub)}</div>` : ''}
		</div>
		<div class="rank-val">
			<div class="rank-primary">${primary}</div>
			${secondary ? `<div class="rank-secondary">${escapeHtml(secondary)}</div>` : ''}
		</div>
	</${tag}>`;
}

// An agent in the feed is a link exactly when the API says its profile is
// public, which mirrors the leaderboard rows above it.
function feedAgent(a) {
	const name = escapeHtml(a?.name || 'Agent');
	return a?.url
		? `<a class="feed-agent" href="${escapeHtml(a.url)}">${name}</a>`
		: `<span class="feed-agent">${name}</span>`;
}

function feedRow(h) {
	const skill = h.skill_name || h.service_slug || 'a skill';
	const link = h.explorer_url
		? `<a class="feed-link" href="${escapeHtml(h.explorer_url)}" target="_blank" rel="noopener">proof ↗</a>`
		: '';
	return `<div class="feed-row">
		<div class="feed-flow">
			${feedAgent(h.hirer)}
			<span class="feed-arrow" aria-hidden="true">→</span>
			${feedAgent(h.provider)}
			<span class="feed-skill">· ${escapeHtml(skill)}</span>
		</div>
		<span class="feed-amt">${fmtUsd(h.usd)}</span>
		<span class="feed-time">${escapeHtml(relTime(h.completed_at))}</span>
		${link}
	</div>`;
}

// ── Chart (native canvas, no dependency) ─────────────────────────────────────

function drawVolumeChart(canvas, days) {
	const ctx = canvas.getContext('2d');
	const dpr = window.devicePixelRatio || 1;
	const rect = canvas.getBoundingClientRect();
	if (!rect.width) return;
	canvas.width = rect.width * dpr;
	canvas.height = rect.height * dpr;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, rect.width, rect.height);

	const W = rect.width;
	const H = rect.height;
	const pad = { top: 16, right: 12, bottom: 28, left: 52 };
	const chartW = W - pad.left - pad.right;
	const chartH = H - pad.top - pad.bottom;

	const vols = days.map((d) => Number(d.volume_usd) || 0);
	const maxVol = Math.max(...vols, 0.0001);
	const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
	const textColor = isDark ? 'rgba(231,233,238,0.45)' : 'rgba(0,0,0,0.45)';
	const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';

	// Grid + y labels
	ctx.font = '10px Inter, system-ui, sans-serif';
	ctx.textBaseline = 'middle';
	for (let i = 0; i <= 4; i++) {
		const y = pad.top + (chartH / 4) * i;
		ctx.strokeStyle = gridColor;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(pad.left, y);
		ctx.lineTo(pad.left + chartW, y);
		ctx.stroke();
		const v = maxVol * (1 - i / 4);
		ctx.fillStyle = textColor;
		ctx.textAlign = 'right';
		ctx.fillText(yLabel(v), pad.left - 8, y);
	}

	// X labels (sparse)
	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	const step = Math.max(1, Math.ceil(days.length / 6));
	days.forEach((d, i) => {
		if (i % step !== 0 && i !== days.length - 1) return;
		const x = pad.left + (days.length <= 1 ? chartW / 2 : (i / (days.length - 1)) * chartW);
		ctx.fillStyle = textColor;
		ctx.fillText(dayLabel(d.day), x, H - pad.bottom + 16);
	});

	// Bars with gradient
	const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
	grad.addColorStop(0, isDark ? 'rgba(74,222,128,0.95)' : 'rgba(22,163,74,0.95)');
	grad.addColorStop(1, isDark ? 'rgba(87,199,255,0.55)' : 'rgba(2,132,199,0.5)');
	const slot = chartW / days.length;
	const barW = Math.max(2, Math.min(22, slot - 3));
	const bars = [];
	days.forEach((d, i) => {
		const v = Number(d.volume_usd) || 0;
		const x = pad.left + i * slot + (slot - barW) / 2;
		const barH = Math.max(v > 0 ? 2 : 0, (v / maxVol) * chartH);
		const y = pad.top + chartH - barH;
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.roundRect(x, y, barW, barH, 2);
		ctx.fill();
		bars.push({ cx: x + barW / 2, top: y, day: d });
	});
	chartHit = { bars, left: pad.left, slot, width: chartW };
}

function yLabel(v) {
	if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
	if (v >= 1) return `$${v.toFixed(0)}`;
	if (v === 0) return '$0';
	return `$${v.toFixed(2)}`;
}

// Build a zero-filled day series for the requested window from the daily rows so
// the chart always shows a continuous timeline, not just days that had volume.
function buildSeries(daily, windowDays) {
	const byDay = new Map(daily.map((d) => [String(d.day).slice(0, 10), d]));
	const out = [];
	const todayUtc = Date.parse(`${utcDayKey(Date.now())}T00:00:00Z`);
	for (let i = windowDays - 1; i >= 0; i--) {
		const key = utcDayKey(todayUtc - i * DAY_MS);
		const hit = byDay.get(key);
		out.push({
			day: key,
			volume_usd: Number(hit?.volume_usd) || 0,
			hires: Number(hit?.hires) || 0,
		});
	}
	return out;
}

function seriesSummary(series) {
	const total = series.reduce((sum, d) => sum + d.volume_usd, 0);
	const active = series.filter((d) => d.volume_usd > 0).length;
	return `Daily agent-to-agent volume, last ${series.length} days: ${fmtUsd(total)} across ${active} ${active === 1 ? 'day' : 'days'} with settlements.`;
}

// The canvas alone is invisible to assistive tech, so the same series is also
// rendered as an offscreen table. Only days with volume are listed: a 90-row
// table of zeros is noise, not data.
function seriesTable(series) {
	const rows = series.filter((d) => d.volume_usd > 0);
	if (!rows.length) return '';
	// The offscreen wrapper is a div, not the table itself: a clipped <table>
	// still lays out at its min-content width and pushes the page into a
	// horizontal scroll on a narrow viewport.
	return `<div class="visually-hidden"><table>
		<caption>Daily agent-to-agent settled volume</caption>
		<thead><tr><th scope="col">Day</th><th scope="col">Volume</th><th scope="col">Hires</th></tr></thead>
		<tbody>${rows.map((d) => `<tr><th scope="row">${escapeHtml(dayLabel(d.day, { year: 'numeric', month: 'short', day: 'numeric' }))}</th><td>${escapeHtml(fmtUsd(d.volume_usd))}</td><td>${fmtCount(d.hires)}</td></tr>`).join('')}</tbody>
	</table></div>`;
}

function chartWrap() {
	return document.getElementById('chart-wrap');
}

function renderChartMessage(html) {
	const wrap = chartWrap();
	if (wrap) wrap.innerHTML = `<div class="chart-empty">${html}</div>`;
	chartHit = null;
}

function renderChart() {
	const wrap = chartWrap();
	if (!wrap) return;
	if (!hasData) return; // still loading: the skeleton stays up
	const series = buildSeries(lastDaily, currentWindow);
	if (!series.some((d) => d.volume_usd > 0)) {
		renderChartMessage(`<span>No settled agent-to-agent volume in the last ${currentWindow} days.</span><a href="/economy">Watch the live economy</a>`);
		return;
	}
	if (!wrap.querySelector('canvas')) {
		wrap.innerHTML = `<canvas id="volume-chart" class="chart-canvas" role="img"></canvas>
			<div class="chart-tip" id="chart-tip" aria-hidden="true"></div>`;
		wireChartTooltip();
	}
	const canvas = wrap.querySelector('canvas');
	closeTip();
	canvas.setAttribute('aria-label', seriesSummary(series));
	wrap.querySelector('.visually-hidden')?.remove();
	wrap.insertAdjacentHTML('beforeend', seriesTable(series));
	requestAnimationFrame(() => drawVolumeChart(canvas, series));
}

// A tooltip left open across a resize keeps the coordinates of the old layout,
// which parks it past the right edge and widens the whole page. Closing it also
// resets the position so a hidden tip can never extend the document.
function closeTip() {
	const tip = document.getElementById('chart-tip');
	if (!tip) return;
	tip.dataset.open = '0';
	tip.style.left = '0px';
	tip.style.top = '0px';
}

function wireChartTooltip() {
	const wrap = chartWrap();
	const canvas = wrap?.querySelector('canvas');
	const tip = document.getElementById('chart-tip');
	if (!canvas || !tip) return;
	canvas.addEventListener('pointermove', (e) => {
		if (!chartHit?.bars.length) return;
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const idx = Math.min(
			chartHit.bars.length - 1,
			Math.max(0, Math.floor((x - chartHit.left) / chartHit.slot)),
		);
		const bar = chartHit.bars[idx];
		const d = bar.day;
		tip.innerHTML = `<div class="tip-day">${escapeHtml(dayLabel(d.day, { year: 'numeric', month: 'short', day: 'numeric' }))}</div>
			<div class="tip-val">${escapeHtml(fmtUsd(d.volume_usd))}</div>
			<div class="tip-day">${fmtCount(d.hires)} ${d.hires === 1 ? 'hire' : 'hires'}</div>`;
		const maxLeft = (wrap?.clientWidth || canvas.offsetWidth) - 8;
		tip.style.left = `${Math.min(maxLeft, Math.max(8, canvas.offsetLeft + bar.cx))}px`;
		tip.style.top = `${canvas.offsetTop + Math.max(bar.top, 12) - 8}px`;
		tip.dataset.open = '1';
	});
	canvas.addEventListener('pointerleave', closeTip);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function setCount(id, value) {
	const el = document.getElementById(id);
	if (!el) return;
	el.textContent = String(value);
	el.hidden = false;
}

// The banner's headline sentence is static translated copy; only this detail
// clause is dynamic. Keeping them in separate elements is deliberate: the i18n
// runtime rewrites annotated elements after first paint, so anything JS writes
// has to live outside an annotated node or it gets overwritten.
function showError(detail) {
	const el = document.getElementById('an-error');
	const m = document.getElementById('an-error-detail');
	if (m) m.textContent = detail || '';
	if (el) el.hidden = false;
	// Nothing has ever painted: swap the skeletons for a real, explained state
	// instead of leaving a shimmer that never resolves.
	if (!hasData) renderUnavailable();
}

function clearError() {
	const el = document.getElementById('an-error');
	if (el) el.hidden = true;
}

const UNAVAILABLE_COPY = 'Could not load. Use Retry above.';

function renderUnavailable() {
	const headline = document.getElementById('headline-val');
	if (headline) {
		headline.textContent = 'Unavailable';
		headline.classList.add('is-unavailable');
		headline.removeAttribute('aria-busy');
	}
	document.getElementById('headline-delta').hidden = true;
	document.getElementById('stats-grid').innerHTML = '';
	for (const id of ['top-earners', 'top-spenders', 'recent-feed']) {
		const el = document.getElementById(id);
		if (el) el.innerHTML = `<div class="an-empty">${UNAVAILABLE_COPY}</div>`;
	}
	renderChartMessage('<span>Volume chart unavailable.</span>');
	for (const id of ['earners-count', 'spenders-count', 'recent-count']) {
		const el = document.getElementById(id);
		if (el) el.hidden = true;
	}
}

function renderSkeletons() {
	const headline = document.getElementById('headline-val');
	if (headline) {
		headline.classList.remove('is-unavailable');
		headline.setAttribute('aria-busy', 'true');
		headline.innerHTML = '<span class="skeleton skeleton-headline"></span>';
	}
	document.getElementById('stats-grid').innerHTML = Array.from({ length: 5 }, () =>
		'<div class="stat-card"><div class="skeleton skeleton-stat" style="width:62%;"></div><div class="skeleton skeleton-row" style="width:48%;margin-top:10px;"></div></div>').join('');
	const ranks = Array.from({ length: 3 }, (_, i) =>
		`<div class="skeleton-rank skeleton" style="animation-delay:.${i}s;"></div>`).join('');
	document.getElementById('top-earners').innerHTML = ranks;
	document.getElementById('top-spenders').innerHTML = ranks;
	document.getElementById('recent-feed').innerHTML = Array.from({ length: 3 }, (_, i) =>
		`<div class="skeleton-rank skeleton" style="height:46px;animation-delay:.${i}s;"></div>`).join('');
	const wrap = chartWrap();
	if (wrap) wrap.innerHTML = '<div class="chart-skeleton skeleton"></div>';
	chartHit = null;
}

function renderTotals(t) {
	const headline = document.getElementById('headline-val');
	headline.classList.remove('is-unavailable');
	headline.removeAttribute('aria-busy');
	headline.textContent = fmtUsd(t.volume_usd, { compact: t.volume_usd >= 10_000 });

	const delta = document.getElementById('headline-delta');
	if (t.volume_24h_usd > 0) {
		delta.textContent = `+${fmtUsd(t.volume_24h_usd)} in 24h`;
		delta.hidden = false;
	} else {
		delta.hidden = true;
	}

	const avg = t.hires > 0 ? t.avg_hire_usd : 0;
	document.getElementById('stats-grid').innerHTML = [
		statCard(fmtCount(t.hires), 'Settled hires', t.pending_hires ? `${fmtCount(t.pending_hires)} pending` : 'agent to agent payments'),
		statCard(fmtUsd(t.volume_7d_usd, { compact: t.volume_7d_usd >= 10_000 }), 'Volume · 7 days', `${fmtCount(t.hires_7d)} hires`),
		statCard(fmtUsd(avg), 'Avg hire value', 'per settled call'),
		statCard(fmtCount(t.unique_providers), 'Earning agents', 'sold a skill'),
		statCard(fmtCount(t.unique_hirers), 'Paying agents', 'hired a skill'),
	].join('');
}

function renderLeaderboards(providers, hirers) {
	const earners = document.getElementById('top-earners');
	const spenders = document.getElementById('top-spenders');
	setCount('earners-count', providers.length);
	document.getElementById('top-earners').innerHTML = providers.length
		? providers.map((a, i) => rankRow(
			i + 1, a,
			`${fmtCount(a.hires)} ${a.hires === 1 ? 'hire' : 'hires'}${a.avg_rating ? ` · ${a.avg_rating.toFixed(1)}★` : ''}`,
			fmtUsd(a.earned_usd), 'earned',
		)).join('')
		: '<div class="an-empty">No agent has earned from a hire yet. <a href="/agent-wallet">List a paid skill</a> and yours can be first.</div>';

	setCount('spenders-count', hirers.length);
	document.getElementById('top-spenders').innerHTML = hirers.length
		? hirers.map((a, i) => rankRow(
			i + 1, a,
			`${fmtCount(a.hires)} ${a.hires === 1 ? 'hire' : 'hires'}`,
			fmtUsd(a.spent_usd), 'spent',
		)).join('')
		: '<div class="an-empty">No agent has hired another yet. <a href="/x402">Browse the x402 catalog</a> to see what is hireable.</div>';

	wireAvatarFallbacks(earners);
	wireAvatarFallbacks(spenders);
}

function renderFeed(recent) {
	setCount('recent-count', recent.length);
	document.getElementById('recent-feed').innerHTML = recent.length
		? recent.map(feedRow).join('')
		: '<div class="an-empty">No settlements yet. <a href="/agent-wallet">Put your agent to work</a> and its first hire lands here.</div>';
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function load({ showLoading = false } = {}) {
	if (inFlight) return;
	inFlight = true;
	const retry = document.getElementById('an-retry');
	if (retry) retry.disabled = true;
	if (showLoading && !hasData) renderSkeletons();
	clearError();

	// The network boundary is the only place that may throw here: a render
	// failure is a bug, not a network error, and must not be reported as one.
	let data;
	try {
		const res = await fetch(`${ENDPOINT}?window=90&top=10&recent=14`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`http_${res.status}`);
		data = await res.json();
	} catch (err) {
		// Offline, DNS failure, a 5xx, or a body that is not the JSON we asked for.
		const status = /^http_(\d+)$/.exec(err?.message || '')?.[1];
		showError(status ? `The server returned HTTP ${status}.` : 'Network error: check your connection and retry.');
		inFlight = false;
		if (retry) retry.disabled = false;
		return;
	}
	inFlight = false;
	if (retry) retry.disabled = false;

	if (!data?.ok) {
		showError('The stats service reported a problem. Please retry.');
		return;
	}

	lastDaily = Array.isArray(data.daily) ? data.daily : [];
	hasData = true;
	renderTotals(data.totals || {});
	renderLeaderboards(
		Array.isArray(data.top_providers) ? data.top_providers : [],
		Array.isArray(data.top_hirers) ? data.top_hirers : [],
	);
	renderFeed(Array.isArray(data.recent) ? data.recent : []);
	renderChart();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireWindowToggle() {
	const toggle = document.getElementById('win-toggle');
	if (!toggle) return;
	toggle.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-window]');
		if (!btn) return;
		currentWindow = Number(btn.dataset.window) || 30;
		toggle.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
		renderChart();
	});
}

function init() {
	wireWindowToggle();
	document.getElementById('an-retry')?.addEventListener('click', () => load({ showLoading: true }));
	// Redraw the canvas on resize + theme change so it stays crisp.
	let raf;
	window.addEventListener('resize', () => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(renderChart);
	});
	new MutationObserver(renderChart)
		.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	load({ showLoading: true });
	// Light auto-refresh so the dashboard stays live without hammering the DB.
	setInterval(() => {
		if (document.visibilityState === 'visible') load();
	}, REFRESH_MS);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
