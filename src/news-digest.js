// /markets/digest — the day's crypto news clustered into narratives over
// /api/news/digest. Each story shows a stance, its tickers, a summary, and an
// expandable list of every outlet that covered it (real links, real sources).
// The engine badge is honest: "AI" when the LLM chain grouped the stories,
// "keyword clustering" when it ran on the extractive path.

import { timeAgo, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const WINDOWS = [
	{ hours: 6, label: '6h' },
	{ hours: 12, label: '12h' },
	{ hours: 24, label: '24h' },
	{ hours: 48, label: '48h' },
	{ hours: 72, label: '72h' },
];

const state = { hours: 24, loading: false, data: null };

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(body?.message || `fetch → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return body;
}

function stanceBadge(stance) {
	const glyph = stance === 'bullish' ? '▲' : stance === 'bearish' ? '▼' : '◆';
	return `<span class="art-badge ${stance === 'bullish' ? 'bullish' : stance === 'bearish' ? 'bearish' : ''}">${glyph} ${esc(stance)}</span>`;
}

function tickerChips(tickers) {
	if (!tickers?.length) return '';
	return `<div class="nw-chips">${tickers
		.map((t) => `<a class="nw-chip" href="/markets/news?q=${encodeURIComponent(t)}">${esc(t)}</a>`)
		.join('')}</div>`;
}

function readerHref(a) {
	return `/markets/news/article?${new URLSearchParams({ url: a.link, title: a.title, source: a.source })}`;
}

function narrativeHtml(n, i) {
	const lead = n.articles[0];
	const sources = [...new Set(n.articles.map((a) => a.source))];
	return `
		<article class="dg-story">
			<div class="dg-rank" aria-hidden="true">${i + 1}</div>
			<div class="dg-body">
				<div class="dg-meta">
					${stanceBadge(n.stance)}
					<span class="dg-coverage">${n.coverage} ${n.coverage === 1 ? 'report' : 'reports'} · ${esc(sources.slice(0, 3).join(', '))}${sources.length > 3 ? ` +${sources.length - 3}` : ''}</span>
					${lead?.pub_date ? `<time datetime="${esc(lead.pub_date)}">${esc(timeAgo(lead.pub_date))}</time>` : ''}
				</div>
				<h2 class="dg-title">${esc(n.title)}</h2>
				<p class="dg-summary">${esc(n.summary)}</p>
				${tickerChips(n.tickers)}
				<details class="dg-sources">
					<summary>${n.coverage} ${n.coverage === 1 ? 'source' : 'sources'}</summary>
					<ul>
						${n.articles
							.map(
								(a) => `<li>
									<a href="${esc(readerHref(a))}">${esc(a.title)}</a>
									<span class="dim">${esc(a.source)}${a.pub_date ? ` · ${esc(timeAgo(a.pub_date))}` : ''}</span>
									<a class="dg-out" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer" aria-label="Read at ${esc(a.source)}">↗</a>
								</li>`,
							)
							.join('')}
					</ul>
				</details>
			</div>
		</article>`;
}

function renderBand(d) {
	const moodClass = d.mood === 'bullish' ? 'cv-up' : d.mood === 'bearish' ? 'cv-down' : '';
	$('dg-band').innerHTML = `
		<div class="dg-band">
			<div class="dg-band-stat">
				<span class="label">Market mood</span>
				<strong class="${moodClass}">${esc(d.mood)}</strong>
			</div>
			<div class="dg-band-stat">
				<span class="label">Stories</span>
				<strong>${d.narratives.length}</strong>
			</div>
			<div class="dg-band-stat">
				<span class="label">Articles read</span>
				<strong>${d.articles_considered}</strong>
			</div>
			<div class="dg-band-stat">
				<span class="label">Feeds live</span>
				<strong>${esc(d.sources_live)}</strong>
			</div>
			<div class="dg-band-tickers">
				<span class="label">Most covered</span>
				${tickerChips(d.top_tickers)}
			</div>
		</div>`;
}

function render() {
	const d = state.data;
	if (!d?.narratives?.length) {
		$('dg-list').innerHTML = `
			<div class="cv-empty">
				<p><strong>Not enough coverage in this window.</strong></p>
				<p>Widen the window, or read the <a href="/markets/news">full news feed</a>.</p>
			</div>`;
		$('dg-band').innerHTML = '';
		$('dg-footer').textContent = '';
		return;
	}
	renderBand(d);
	$('dg-list').innerHTML = d.narratives.map(narrativeHtml).join('');
	const engineLabel =
		d.engine === 'llm'
			? `grouped by AI${d.provider ? ` (${d.provider})` : ''}`
			: 'grouped by keyword clustering';
	$('dg-footer').textContent =
		`${d.articles_considered} articles from the last ${d.window_hours}h, ${engineLabel} · generated ${timeAgo(d.generated_at)}${d.cached ? ' (cached)' : ''}`;
}

function skeleton() {
	$('dg-band').innerHTML = '<div class="cv-skel" style="height:4.5rem"></div>';
	$('dg-list').innerHTML = Array.from(
		{ length: 5 },
		() => `<div class="dg-story" aria-hidden="true">
			<div class="dg-rank"></div>
			<div class="dg-body">
				<div class="cv-skel" style="height:0.75rem;width:35%"></div>
				<div class="cv-skel" style="height:1.5rem;margin:0.5rem 0"></div>
				<div class="cv-skel" style="height:0.875rem"></div>
				<div class="cv-skel" style="height:0.875rem;width:70%"></div>
			</div>
		</div>`,
	).join('');
	$('dg-footer').textContent = 'Reading the last 24 hours of coverage…';
}

async function load({ refresh = false } = {}) {
	if (state.loading) return;
	state.loading = true;
	skeleton();
	$('dg-refresh').disabled = true;
	try {
		const p = new URLSearchParams({ hours: String(state.hours) });
		if (refresh) p.set('refresh', '1');
		state.data = await getJson(`/api/news/digest?${p}`);
		render();
	} catch (err) {
		$('dg-band').innerHTML = '';
		$('dg-list').innerHTML = `
			<div class="cv-empty">
				<p><strong>${err.status === 503 ? 'Not enough coverage in this window.' : 'Couldn’t build the digest.'}</strong></p>
				<p>${err.status === 429 ? 'Rate limited — wait a few seconds and retry.' : esc(err.message || 'The digest service didn’t respond.')}</p>
				<p><button class="arc-btn" type="button" id="dg-retry">Retry</button></p>
			</div>`;
		$('dg-footer').textContent = '';
		$('dg-retry')?.addEventListener('click', () => load());
	} finally {
		state.loading = false;
		$('dg-refresh').disabled = false;
	}
}

function renderWindows() {
	$('dg-windows').innerHTML = WINDOWS.map(
		(w) =>
			`<button class="nw-tab" type="button" data-hours="${w.hours}" aria-pressed="${String(w.hours === state.hours)}">${w.label}</button>`,
	).join('');
}

function syncUrl() {
	history.replaceState(null, '', state.hours === 24 ? '/markets/digest' : `/markets/digest?hours=${state.hours}`);
}

function init() {
	const h = parseInt(new URLSearchParams(location.search).get('hours') || '24', 10);
	if (WINDOWS.some((w) => w.hours === h)) state.hours = h;
	renderWindows();
	$('dg-windows').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-hours]');
		if (!btn) return;
		state.hours = Number(btn.dataset.hours);
		renderWindows();
		syncUrl();
		load();
	});
	$('dg-refresh').addEventListener('click', () => load({ refresh: true }));
	load();
}

init();
