// /markets/archive — explorer over the 662k-article historical archive
// (/api/news/archive, GCS-backed). Corpus stats band, rich filters (keyword,
// ticker, source, date range, sentiment, language), year quick-jump, trending
// ticker chips, dense result rows with honest coverage reporting (the API
// scans newest→oldest months and says exactly how far it got).

import { escapeHtml as esc } from './shared/coin-format.js';
import { ensureX402 } from './shared/x402-loader.js';
import { readerHref } from './shared/news-render.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

const state = {
	q: '',
	ticker: '',
	source: '',
	from: '',
	to: '',
	sentiment: '',
	lang: '',
	offset: 0,
	articles: [],
	scanned: null,
	totalMatches: 0,
	hasMore: false,
	loading: false,
	stats: null,
};

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(body?.message || `fetch → ${res.status}`);
		err.status = res.status;
		err.body = body; // a 402 carries the x402 challenge (price + networks)
		throw err;
	}
	return body;
}

function queryUrl(offset) {
	const p = new URLSearchParams();
	if (state.q) p.set('q', state.q);
	if (state.ticker) p.set('ticker', state.ticker);
	if (state.source) p.set('source', state.source);
	if (state.from) p.set('start_date', state.from);
	if (state.to) p.set('end_date', state.to);
	if (state.sentiment) p.set('sentiment', state.sentiment);
	if (state.lang) p.set('lang', state.lang);
	p.set('limit', String(PAGE_SIZE));
	p.set('offset', String(offset));
	return `/api/news/archive?${p}`;
}

function syncUrl() {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries({
		q: state.q, ticker: state.ticker, source: state.source,
		from: state.from, to: state.to, sentiment: state.sentiment, lang: state.lang,
	})) if (v) p.set(k, v);
	const qs = p.toString();
	history.replaceState(null, '', qs ? `/markets/archive?${qs}` : '/markets/archive');
}

// ── Stats band ───────────────────────────────────────────────────────────────

function statCard(value, label) {
	return `<div class="cv-stat-card"><div class="cv-mini-stat"><strong>${value}</strong><span>${label}</span></div></div>`;
}

async function loadStats() {
	try {
		const data = await getJson('/api/news/archive?stats=true');
		state.stats = data.stats;
		const s = data.stats;
		const first = new Date(s.first_article_date);
		const last = new Date(s.last_article_date);
		const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
		$('arc-stats').innerHTML = [
			statCard(s.total_articles.toLocaleString(), 'articles'),
			statCard(`${fmt(first)} → ${fmt(last)}`, 'coverage'),
			statCard(String(data.months?.count ?? '—'), 'months of history'),
			statCard(s.top_sources?.length >= 30 ? '100+' : String(s.top_sources?.length || '—'), 'sources'),
			statCard('EN + 中文', 'languages'),
		].join('');
		renderYears();
	} catch {
		$('arc-stats').innerHTML = '';
	}
}

async function loadTrending() {
	try {
		const data = await getJson('/api/news/archive?trending=true');
		if (!data.trending?.length) return;
		const chips = data.trending
			.slice(0, 12)
			.map(
				(t) =>
					`<button class="nw-chip" type="button" data-trend="${esc(t.ticker)}" title="${t.count.toLocaleString()} mentions in the newest archive months">${esc(t.ticker)}</button>`,
			)
			.join('');
		$('arc-years').insertAdjacentHTML(
			'beforeend',
			`<span style="flex-basis:100%;height:0"></span><span class="arc-coverage" style="margin:0">Most covered:</span>${chips}`,
		);
	} catch {
		// trending strip is decorative — the explorer works without it
	}
}

function renderYears() {
	const s = state.stats;
	if (!s) return;
	const firstYear = new Date(s.first_article_date).getUTCFullYear();
	const lastYear = new Date(s.last_article_date).getUTCFullYear();
	let html = '';
	for (let y = lastYear; y >= firstYear; y--) {
		html += `<button class="nw-tab" type="button" data-year="${y}" aria-pressed="${String(state.from === `${y}-01-01` && state.to === `${y}-12-31`)}">${y}</button>`;
	}
	$('arc-years').innerHTML = html;
	loadTrending();
}

// ── Results ──────────────────────────────────────────────────────────────────

function rowHtml(a) {
	const d = a.pub_date ? new Date(a.pub_date) : null;
	const dateStr = d && !Number.isNaN(d.getTime())
		? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
		: '—';
	const label = a.sentiment?.label || 'neutral';
	const dotCls = label.includes('positive') ? 'pos' : label.includes('negative') ? 'neg' : '';
	const titleInner = a.link ? `<a href="${esc(readerHref(a))}">${esc(a.title)}</a>` : esc(a.title);
	return `
		<div class="arc-row">
			<span class="arc-date">${esc(dateStr)}</span>
			<span class="nw-dot ${dotCls}" title="Sentiment: ${esc(label.replace('_', ' '))}"></span>
			<span class="arc-title">${titleInner}${a.lang === 'zh' ? '<span class="lang">中文</span>' : ''}
				${(a.tickers || []).slice(0, 3).map((t) => `<button class="nw-chip" type="button" data-arc-ticker="${esc(t)}" style="margin-left:0.375rem">${esc(t)}</button>`).join('')}
			</span>
			<span class="arc-src">${esc(a.source)}</span>
		</div>`;
}

function coverageText() {
	const sc = state.scanned;
	if (!sc) return '';
	const fmtMonth = (m) => {
		if (!m) return '—';
		const [y, mo] = m.split('-');
		return new Date(Date.UTC(+y, +mo - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	};
	let text = `${state.totalMatches.toLocaleString()} matches in ${fmtMonth(sc.from)} → ${fmtMonth(sc.to)}`;
	if (!sc.complete) {
		text += ` · ${sc.months_remaining} older months not scanned yet — narrow the date range (or use the year buttons) to search further back`;
	}
	return text;
}

function render() {
	const el = $('arc-results');
	if (!state.articles.length) {
		el.innerHTML = `
			<div class="cv-empty">
				<p><strong>No archived articles match.</strong></p>
				<p>${state.scanned && !state.scanned.complete ? 'The newest months had no hits — pick a year or date range to search deeper into the archive.' : 'Loosen a filter and try again.'}</p>
			</div>`;
		$('arc-coverage').textContent = coverageText();
		$('arc-more').hidden = true;
		return;
	}
	el.innerHTML = `<div class="arc-list">${state.articles.map(rowHtml).join('')}</div>`;
	$('arc-coverage').textContent = coverageText();
	$('arc-more').hidden = !state.hasMore;
}

function applyData(data, append) {
	state.articles = append ? state.articles.concat(data.articles) : data.articles;
	state.offset = state.articles.length;
	state.scanned = data.scanned;
	state.totalMatches = data.total_scanned_matches;
	state.hasMore = data.has_more && data.articles.length > 0;
	render();
}

// The free daily search quota is exhausted — the API answered with an x402
// 402 challenge. Offer the real paid path (X402.pay drives wallet connect →
// sign → retry with X-PAYMENT) alongside the "come back tomorrow" one.
function renderPaywall({ append, challenge }) {
	const paid = (challenge?.accepts || []).find((a) => Number(a?.amount) > 0);
	const usd = paid ? Number(paid.amount) / 1e6 : 0.001;
	const price = `$${usd.toLocaleString(undefined, { maximumSignificantDigits: 2 })}`;
	const el = $('arc-results');
	el.innerHTML = `
		<div class="cv-empty">
			<p><strong>Today’s free archive searches are used up.</strong></p>
			<p>Free searches reset daily. Keep digging now for ${esc(price)} USDC per search (each payment unlocks a 15-minute session), or go
				<a href="/dashboard/data-api"><strong>Premium</strong></a> — a monthly pass paid in $THREE, SOL, or USDC with unmetered search and an API key.</p>
			<p><button class="arc-btn" type="button" id="arc-pay">Pay ${esc(price)} &amp; search</button>
				<a class="arc-btn" href="/dashboard/data-api" style="text-decoration:none">Get Premium</a></p>
			<p class="arc-coverage" style="margin:0">Corpus stats, months, and trending tickers stay free — only deep search is metered. Premium members: the payment dialog offers “sign with wallet” instead of paying.</p>
		</div>`;
	$('arc-coverage').textContent = '';
	document.getElementById('arc-pay')?.addEventListener('click', async () => {
		const btn = document.getElementById('arc-pay');
		btn.disabled = true;
		try {
			const X402 = await ensureX402();
			const out = await X402.pay({
				endpoint: queryUrl(append ? state.offset : 0),
				method: 'GET',
				merchant: 'three.ws',
				action: 'Archive search',
				autoClose: true,
			});
			if (out?.ok && out.result) applyData(out.result, append);
		} catch (err) {
			if (err?.code !== 'cancelled') {
				el.querySelector('.cv-empty')?.insertAdjacentHTML(
					'beforeend',
					`<p class="arc-coverage" style="margin:0">${esc(err?.message || 'Payment failed — try again.')}</p>`,
				);
			}
		} finally {
			btn.disabled = false;
		}
	});
}

async function load({ append = false } = {}) {
	if (state.loading) return;
	state.loading = true;
	const el = $('arc-results');
	const moreBtn = $('arc-more');
	if (!append) {
		state.offset = 0;
		el.innerHTML = `<div class="arc-list" aria-hidden="true">${`<div class="arc-row"><span class="cv-skel" style="height:0.75rem"></span><span></span><span class="cv-skel" style="height:0.875rem"></span><span class="cv-skel" style="height:0.75rem;width:60px"></span></div>`.repeat(10)}</div>`;
		$('arc-coverage').textContent = 'Searching the archive…';
	} else {
		moreBtn.disabled = true;
		moreBtn.textContent = 'Loading…';
	}
	try {
		const data = await getJson(queryUrl(append ? state.offset : 0));
		applyData(data, append);
	} catch (err) {
		if (err.status === 402) {
			renderPaywall({ append, challenge: err.body });
			$('arc-more').hidden = true;
		} else {
			el.innerHTML = `
				<div class="cv-empty">
					<p><strong>The archive didn’t respond.</strong></p>
					<p>${err.status === 429 ? 'Rate limited — wait a few seconds and retry.' : esc(err.message || 'Try again in a moment.')}</p>
					<p><button class="arc-btn" type="button" id="arc-retry">Retry</button></p>
				</div>`;
			$('arc-coverage').textContent = '';
			document.getElementById('arc-retry')?.addEventListener('click', () => load());
		}
	} finally {
		state.loading = false;
		moreBtn.disabled = false;
		moreBtn.textContent = 'Load more';
	}
}

// ── Events ───────────────────────────────────────────────────────────────────

function readForm() {
	state.q = $('arc-q').value.trim();
	state.ticker = $('arc-ticker').value.trim().toUpperCase();
	state.source = $('arc-source').value.trim();
	state.from = $('arc-from').value;
	state.to = $('arc-to').value;
	state.sentiment = $('arc-sentiment').value;
	state.lang = $('arc-lang').value;
}

function writeForm() {
	$('arc-q').value = state.q;
	$('arc-ticker').value = state.ticker;
	$('arc-source').value = state.source;
	$('arc-from').value = state.from;
	$('arc-to').value = state.to;
	$('arc-sentiment').value = state.sentiment;
	$('arc-lang').value = state.lang;
}

function wireEvents() {
	$('arc-filters').addEventListener('submit', (e) => {
		e.preventDefault();
		readForm();
		syncUrl();
		renderYears();
		load();
	});
	$('arc-reset').addEventListener('click', (e) => {
		e.preventDefault();
		for (const k of ['q', 'ticker', 'source', 'from', 'to', 'sentiment', 'lang']) state[k] = '';
		writeForm();
		syncUrl();
		renderYears();
		load();
	});
	$('arc-years').addEventListener('click', (e) => {
		const yearBtn = e.target.closest('[data-year]');
		if (yearBtn) {
			const y = yearBtn.dataset.year;
			state.from = `${y}-01-01`;
			state.to = `${y}-12-31`;
			writeForm();
			syncUrl();
			renderYears();
			load();
			return;
		}
		const trend = e.target.closest('[data-trend]');
		if (trend) {
			state.ticker = trend.dataset.trend;
			writeForm();
			syncUrl();
			load();
		}
	});
	$('arc-results').addEventListener('click', (e) => {
		const chip = e.target.closest('[data-arc-ticker]');
		if (!chip) return;
		state.ticker = chip.dataset.arcTicker;
		writeForm();
		syncUrl();
		load();
	});
	$('arc-more').addEventListener('click', () => load({ append: true }));
}

function init() {
	const p = new URLSearchParams(location.search);
	state.q = p.get('q') || '';
	state.ticker = (p.get('ticker') || '').toUpperCase();
	state.source = p.get('source') || '';
	state.from = p.get('from') || '';
	state.to = p.get('to') || '';
	state.sentiment = p.get('sentiment') || '';
	state.lang = p.get('lang') || '';
	writeForm();
	wireEvents();
	loadStats();
	load();
}

init();
