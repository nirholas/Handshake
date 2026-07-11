// /markets/news — "Your briefing": the front page of the crypto-news wing over
// /api/news/feed + /api/news/digest (both native three.ws aggregation).
//
// Layout: masthead (title + date + search + language/source + Ask AI), primary
// briefing tabs (Featured / Headlines / Trending / DeFi / Bitcoin / Ethereum /
// Analysis / Saved / All), a breaking-news ticker for stories under 45 minutes
// old, a collapsible "Today's AI Briefing" card fed by the digest engine, a
// Top-stories block (hero + compact rail), and the Latest grid with offset
// pagination. Every story opens the rich reader at /markets/news/article.
//
// Language defaults to English. The registry also carries international feeds,
// which are opt-in via the language selector so the default feed reads as one
// coherent stream rather than an interleaving of scripts.

import { timeAgo, escapeHtml as esc } from './shared/coin-format.js';
import {
	newsCard,
	newsRow,
	newsMedia,
	sentimentDot,
	tickerChips,
	readerHref,
	savedArticles,
	wireNewsContainer,
} from './shared/news-render.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 24;
const BREAKING_WINDOW_MS = 45 * 60_000;
const BRIEF_OPEN_KEY = 'twx_news_brief_open';

// ── Primary briefing tabs ────────────────────────────────────────────────────
// A small, opinionated set fronts the full category registry; "All" unfolds
// the complete category list below the bar.

const icon = (d) =>
	`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const TABS = [
	{ key: 'featured', label: 'Featured', icon: icon('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 6h6M5 9h6M5 12h3.5"/>') },
	{ key: 'headlines', label: 'Headlines', icon: icon('<path d="M8.8 1.5 3 9h4l-.8 5.5L12 7H8l.8-5.5z"/>') },
	{ key: 'trending', label: 'Trending', icon: icon('<path d="M8 1.8c.4 2.5-2.8 3.7-2.8 6.7a2.8 2.8 0 0 0 5.6 0c0-1-.4-1.8-.9-2.5-.2 1-.7 1.5-1.4 1.7.5-1.9-.1-4.4-.5-5.9z"/>') },
	{ key: 'defi', label: 'DeFi', category: 'defi', icon: icon('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5v7M10 6.2c-.4-.7-1.1-1-2-1-1.1 0-1.9.6-1.9 1.5C6.1 8.7 10 8 10 9.9c0 .9-.9 1.5-2 1.5-1 0-1.7-.4-2.1-1.1"/>') },
	{ key: 'bitcoin', label: 'Bitcoin', category: 'bitcoin', icon: icon('<path d="M6 3h3.2a2 2 0 0 1 0 4H6zM6 7h3.7a2 2 0 0 1 0 4H6zM6 3v8M7.2 1.8V3M7.2 11v1.2M9.5 1.8V3M9.5 11v1.2"/>') },
	{ key: 'ethereum', label: 'Ethereum', category: 'ethereum', icon: icon('<path d="M8 1.5 3.5 8 8 10.5 12.5 8zM3.5 9.2 8 14.5l4.5-5.3L8 11.7z"/>') },
	{ key: 'analysis', label: 'Analysis', category: 'research', icon: icon('<path d="M2.5 13.5h11M3.5 13V9M7 13V5.5M10.5 13V7.5M14 13V3.5"/>') },
	{ key: 'saved', label: 'Saved', icon: icon('<path d="M4 2h8v12.5L8 11l-4 3.5z"/>') },
	{ key: 'all', label: 'All', icon: icon('<circle cx="8" cy="8" r="6.2"/><path d="M2 8h12M8 1.8c-3.5 3.5-3.5 8.9 0 12.4M8 1.8c3.5 3.5 3.5 8.9 0 12.4"/>') },
];

// Covers every category the registry can emit. The "All" picker renders from
// the API's live category list, so a missing label leaks a raw key ("ai_crypto").
const CATEGORY_LABELS = {
	all: 'All',
	general: 'Top',
	bitcoin: 'Bitcoin',
	ethereum: 'Ethereum',
	layer2: 'Layer 2',
	solana: 'Solana',
	altl1: 'Alt L1',
	defi: 'DeFi',
	nft: 'NFT',
	gaming: 'Gaming',
	trading: 'Trading',
	derivatives: 'Derivatives',
	research: 'Research',
	onchain: 'On-chain',
	quant: 'Quant',
	institutional: 'Institutional',
	tradfi: 'TradFi',
	etf: 'ETF',
	stablecoin: 'Stablecoins',
	fintech: 'Fintech',
	mainstream: 'Mainstream',
	geopolitical: 'Geopolitics',
	regulation: 'Regulation',
	security: 'Security',
	developer: 'Developer',
	depin: 'DePIN',
	ai_crypto: 'AI x Crypto',
	mining: 'Mining',
	macro: 'Macro',
	social: 'Social',
	journalism: 'Journalism',
	asia: 'Asia',
};

// The registry carries feeds in 17 languages beyond English. English is the
// API default; the rest are opt-in, so the feed never interleaves scripts.
const LANGUAGE_LABELS = {
	en: 'English', zh: '中文', ko: '한국어', ja: '日本語', es: 'Español', pt: 'Português',
	de: 'Deutsch', fr: 'Français', ru: 'Русский', tr: 'Türkçe', it: 'Italiano', id: 'Bahasa Indonesia',
	nl: 'Nederlands', pl: 'Polski', vi: 'Tiếng Việt', th: 'ไทย', ar: 'العربية', hi: 'हिन्दी',
	fa: 'فارسی',
};

const state = {
	tab: 'headlines',
	category: 'all', // only meaningful on the "All" tab
	lang: 'en',
	q: '',
	source: '',
	offset: 0,
	articles: [],
	total: 0,
	sourcesOk: 0,
	sourcesTotal: 0,
	loading: false,
	meta: null,
};

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

function activeTab() {
	return TABS.find((t) => t.key === state.tab) || TABS[1];
}

function activeCategory() {
	const tab = activeTab();
	if (tab.category) return tab.category;
	if (tab.key === 'all' && state.category !== 'all') return state.category;
	return null;
}

function feedUrl(offset) {
	const p = new URLSearchParams();
	const category = activeCategory();
	if (category) p.set('category', category);
	if (state.tab === 'featured') p.set('featured', '1');
	if (state.lang && state.lang !== 'en') p.set('lang', state.lang);
	if (state.q) p.set('q', state.q);
	if (state.source) p.set('source', state.source);
	p.set('limit', String(PAGE_SIZE));
	p.set('offset', String(offset));
	if (!state.meta) p.set('meta', '1');
	return `/api/news/feed?${p}`;
}

function syncUrl() {
	const p = new URLSearchParams();
	if (state.tab !== 'headlines') p.set('tab', state.tab);
	if (state.tab === 'all' && state.category !== 'all') p.set('category', state.category);
	if (state.lang !== 'en') p.set('lang', state.lang);
	if (state.q) p.set('q', state.q);
	if (state.source) p.set('source', state.source);
	const qs = p.toString();
	history.replaceState(null, '', qs ? `/markets/news?${qs}` : '/markets/news');
}

// ── Masthead date ────────────────────────────────────────────────────────────

function renderDate() {
	$('nwb-date').textContent = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
	}).format(new Date());
}

// ── Breaking ticker ──────────────────────────────────────────────────────────
// Stories younger than 45 minutes, newest first, from the unfiltered feed so a
// category tab still surfaces market-wide breaks. Hidden when nothing is fresh.

async function loadBreaking() {
	const el = $('nwb-breaking');
	try {
		const data = await getJson('/api/news/feed?limit=20');
		const cutoff = Date.now() - BREAKING_WINDOW_MS;
		const fresh = (data.articles || [])
			.filter((a) => a.pub_date && new Date(a.pub_date).getTime() >= cutoff)
			.slice(0, 8);
		if (!fresh.length) return; // stays hidden — no fake urgency
		const items = fresh
			.map(
				(a) => `<a class="nwb-break-item" href="${esc(readerHref(a))}">
					<span class="nwb-break-title">${esc(a.title)}</span>
					<time datetime="${esc(a.pub_date)}">${esc(timeAgo(a.pub_date))}</time>
				</a>`,
			)
			.join('<span class="nwb-break-sep" aria-hidden="true">•</span>');
		// Track duplicated once so the CSS loop is seamless; the copy is
		// presentation-only.
		el.innerHTML = `
			<span class="nwb-break-label">${icon('<path d="M8.8 1.5 3 9h4l-.8 5.5L12 7H8l.8-5.5z"/>')} BREAKING</span>
			<div class="nwb-break-viewport"><div class="nwb-break-track">
				<div class="nwb-break-run">${items}</div>
				<div class="nwb-break-run" aria-hidden="true">${items}</div>
			</div></div>`;
		el.hidden = false;
	} catch {
		/* the ticker is an enhancement — a failed fetch just leaves it hidden */
	}
}

// ── Today's AI Briefing ──────────────────────────────────────────────────────
// One digest fetch serves both the briefing card and the Trending tab.

let digestPromise = null;
function fetchDigest() {
	if (!digestPromise) {
		digestPromise = getJson('/api/news/digest?hours=24&limit=10').catch((err) => {
			digestPromise = null; // let a retry re-fetch
			throw err;
		});
	}
	return digestPromise;
}

function firstSentence(text, max = 220) {
	const t = String(text || '').trim();
	if (!t) return '';
	const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
	const s = (m ? m[0] : t).trim();
	return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')}…` : s;
}

function briefOpen() {
	try {
		return localStorage.getItem(BRIEF_OPEN_KEY) !== '0';
	} catch {
		return true;
	}
}

function setBriefOpen(open) {
	try {
		localStorage.setItem(BRIEF_OPEN_KEY, open ? '1' : '0');
	} catch {
		/* preference just won't persist */
	}
}

async function loadBriefing() {
	const el = $('nwb-brief');
	try {
		const digest = await fetchDigest();
		const points = (digest.narratives || []).slice(0, 3);
		if (!points.length) return;
		const open = briefOpen();
		const generated = digest.generated_at
			? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(digest.generated_at))
			: '';
		el.innerHTML = `
			<div class="nwb-brief-head">
				<h2 class="nwb-brief-title"><span class="nwb-brief-spark" aria-hidden="true">✦</span> Today's AI Briefing</h2>
				${generated ? `<time class="nwb-brief-time" datetime="${esc(digest.generated_at)}">${esc(generated)}</time>` : ''}
				<button class="nwb-brief-toggle" type="button" aria-expanded="${open}" aria-controls="nwb-brief-body" aria-label="${open ? 'Collapse' : 'Expand'} AI briefing">
					${icon('<path d="M3.5 6 8 10.5 12.5 6"/>')}
				</button>
			</div>
			<div class="nwb-brief-body" id="nwb-brief-body" ${open ? '' : 'hidden'}>
				<ol class="nwb-brief-list">
					${points
						.map((n) => {
							const lead = n.articles?.[0];
							const text = firstSentence(n.summary) || n.title;
							return `<li>${lead ? `<a href="${esc(readerHref(lead))}">${esc(text)}</a>` : esc(text)}</li>`;
						})
						.join('')}
				</ol>
				<a class="nwb-brief-more" href="/markets/digest">Read full briefing <span aria-hidden="true">↓</span></a>
			</div>`;
		el.hidden = false;
		el.querySelector('.nwb-brief-toggle').addEventListener('click', (e) => {
			const btn = e.currentTarget;
			const body = $('nwb-brief-body');
			const nowOpen = body.hidden;
			body.hidden = !nowOpen;
			btn.setAttribute('aria-expanded', String(nowOpen));
			btn.setAttribute('aria-label', `${nowOpen ? 'Collapse' : 'Expand'} AI briefing`);
			setBriefOpen(nowOpen);
		});
	} catch {
		/* briefing is an enhancement — the feed stands on its own */
	}
}

// ── Feed views ───────────────────────────────────────────────────────────────

function skeleton() {
	const card = `<div class="nw-card" aria-hidden="true"><div class="nw-media cv-skel"></div>
		<div class="nw-body"><div class="cv-skel" style="height:0.75rem;width:40%"></div>
		<div class="cv-skel" style="height:1rem"></div><div class="cv-skel" style="height:1rem;width:80%"></div></div></div>`;
	return `<div class="nwb-top" aria-hidden="true"><div class="nw-hero cv-skel" style="min-height:320px"></div>
		<div class="nwb-rail">${`<div class="nw-row cv-skel" style="height:88px"></div>`.repeat(4)}</div></div>
		<div class="nw-grid">${card.repeat(6)}</div>`;
}

function heroHtml(a) {
	return `
		<article class="nw-hero" data-href="${esc(readerHref(a))}" tabindex="0">
			${newsMedia(a, { heroic: true })}
			<div class="nw-hero-body">
				<div class="nw-meta">${sentimentDot(a)}<span class="nw-src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.pub_date || '')}">${a.pub_date ? esc(timeAgo(a.pub_date)) : ''}</time></div>
				<h2><a href="${esc(readerHref(a))}">${esc(a.title)}</a></h2>
				${a.description ? `<p class="nw-desc" style="-webkit-line-clamp:3">${esc(a.description)}</p>` : ''}
				${tickerChips(a)}
			</div>
		</article>`;
}

function emptyBrowse() {
	return `
		<div class="cv-empty">
			<p><strong>No stories match.</strong></p>
			<p>Try a different search, another section, or browse the
			<a href="/markets/archive">662k-article archive</a> for older coverage.</p>
		</div>`;
}

function renderFeed() {
	const feedEl = $('nw-feed');
	const { articles } = state;
	if (!articles.length) {
		feedEl.innerHTML = emptyBrowse();
		$('nw-count').textContent = '';
		$('nw-more').hidden = true;
		return;
	}

	// A search or single-source view is a flat result list; a browse view gets
	// the briefing treatment: hero + compact rail, then the Latest grid.
	const flat = Boolean(state.q || state.source);
	if (flat) {
		feedEl.innerHTML = `<div class="nw-grid">${articles.map((a) => newsCard(a)).join('')}</div>`;
	} else {
		// Hero: first story carrying a feed image among the leaders, so the
		// masthead visual is never a fallback tile; everything else keeps order.
		const heroIdx = Math.max(0, articles.slice(0, 8).findIndex((a) => a.image));
		const hero = articles[heroIdx] || articles[0];
		const rest = articles.filter((_, i) => i !== heroIdx);
		const rail = rest.slice(0, 4);
		const grid = rest.slice(4);
		feedEl.innerHTML = `
			<h2 class="nwb-section-h">${icon('<path d="M8.8 1.5 3 9h4l-.8 5.5L12 7H8l.8-5.5z"/>')} Top stories</h2>
			<div class="nwb-top">
				${heroHtml(hero)}
				<div class="nwb-rail">${rail.map((a) => newsRow(a)).join('')}</div>
			</div>
			${grid.length ? `<h2 class="nwb-section-h">Latest</h2><div class="nw-grid">${grid.map((a) => newsCard(a)).join('')}</div>` : ''}`;
	}

	const src = state.meta?.sources?.find((s) => s.key === state.source);
	const tab = activeTab();
	$('nw-count').textContent =
		`${state.total.toLocaleString()} stories · ${state.sourcesOk}/${state.sourcesTotal} feeds live` +
		(tab.key !== 'headlines' && tab.key !== 'all' ? ` · ${tab.label}` : '') +
		(state.tab === 'all' && state.category !== 'all' ? ` · ${CATEGORY_LABELS[state.category] || state.category}` : '') +
		(state.lang !== 'en' ? ` · ${state.lang === 'all' ? 'All languages' : LANGUAGE_LABELS[state.lang] || state.lang}` : '') +
		(src ? ` · ${src.name}` : '') +
		(state.q ? ` · “${state.q}”` : '');
	$('nw-more').hidden = state.articles.length >= state.total;
}

async function load({ append = false } = {}) {
	if (state.loading) return;
	state.loading = true;
	const feedEl = $('nw-feed');
	const moreBtn = $('nw-more');
	if (!append) {
		state.offset = 0;
		feedEl.innerHTML = skeleton();
		$('nw-count').textContent = '';
		moreBtn.hidden = true;
	} else {
		moreBtn.disabled = true;
		moreBtn.textContent = 'Loading…';
	}
	try {
		const data = await getJson(feedUrl(append ? state.offset : 0));
		if (data.categories && data.sources) {
			state.meta = { categories: data.categories, sources: data.sources };
			hydrateFilters();
		}
		state.total = data.total;
		state.sourcesOk = data.sources_ok;
		state.sourcesTotal = data.sources_total;
		state.articles = append ? state.articles.concat(data.articles) : data.articles;
		state.offset = state.articles.length;
		renderFeed();
	} catch (err) {
		feedEl.innerHTML = `
			<div class="cv-empty">
				<p><strong>Couldn’t load the news feed.</strong></p>
				<p>${err.status === 429 ? 'You’re moving fast — give it a few seconds and retry.' : 'The aggregator didn’t respond. It usually recovers on its own.'}</p>
				<p><button class="arc-btn" type="button" id="nw-retry">Retry</button></p>
			</div>`;
		document.getElementById('nw-retry')?.addEventListener('click', () => load());
	} finally {
		state.loading = false;
		moreBtn.disabled = false;
		moreBtn.textContent = 'Load more stories';
	}
}

// ── Trending view (digest narratives) ────────────────────────────────────────

async function loadTrending() {
	const feedEl = $('nw-feed');
	$('nw-more').hidden = true;
	$('nw-count').textContent = '';
	feedEl.innerHTML = `<div class="nwb-trend" aria-hidden="true">${`<div class="nwb-trend-item cv-skel" style="height:120px"></div>`.repeat(5)}</div>`;
	try {
		const digest = await fetchDigest();
		const narratives = digest.narratives || [];
		if (!narratives.length) {
			feedEl.innerHTML = emptyBrowse();
			return;
		}
		if (state.tab !== 'trending') return; // user already switched away
		feedEl.innerHTML = `
			<div class="nwb-trend">
				${narratives
					.map((n, i) => {
						const lead = n.articles?.[0];
						const outlets = [...new Set((n.articles || []).map((a) => a.source))];
						return `
						<article class="nwb-trend-item" ${lead ? `data-href="${esc(readerHref(lead))}" tabindex="0"` : ''}>
							<span class="nwb-trend-rank" aria-hidden="true">${i + 1}</span>
							<div class="nwb-trend-body">
								<div class="nw-meta">
									<span class="nwb-stance nwb-stance-${esc(n.stance || 'neutral')}">${esc(n.stance || 'neutral')}</span>
									<span>${n.coverage || outlets.length} outlet${(n.coverage || outlets.length) === 1 ? '' : 's'}</span>
								</div>
								<h3 class="nwb-trend-title">${lead ? `<a href="${esc(readerHref(lead))}">${esc(n.title)}</a>` : esc(n.title)}</h3>
								<p class="nw-desc" style="-webkit-line-clamp:3">${esc(n.summary || '')}</p>
								<div class="nwb-trend-srcs">${outlets.slice(0, 5).map((s) => `<span>${esc(s)}</span>`).join('')}</div>
								${tickerChips({ tickers: n.tickers })}
							</div>
						</article>`;
					})
					.join('')}
			</div>
			<p class="nw-count" style="margin-top:1rem">Clustered from ${Number(digest.articles_considered || 0).toLocaleString()} articles over the last ${digest.window_hours || 24}h · mood: ${esc(digest.mood || 'neutral')}</p>`;
	} catch {
		if (state.tab !== 'trending') return;
		feedEl.innerHTML = `
			<div class="cv-empty">
				<p><strong>Couldn’t build the trending view.</strong></p>
				<p>The digest engine didn’t respond. It usually recovers on its own.</p>
				<p><button class="arc-btn" type="button" id="nw-retry-trend">Retry</button></p>
			</div>`;
		document.getElementById('nw-retry-trend')?.addEventListener('click', () => loadTrending());
	}
}

// ── Saved view (localStorage) ────────────────────────────────────────────────

function renderSaved() {
	const feedEl = $('nw-feed');
	$('nw-more').hidden = true;
	const saved = savedArticles();
	$('nw-count').textContent = saved.length
		? `${saved.length} saved ${saved.length === 1 ? 'story' : 'stories'} · stored in this browser`
		: '';
	if (!saved.length) {
		feedEl.innerHTML = `
			<div class="cv-empty">
				<p><strong>No saved stories yet.</strong></p>
				<p>Tap the ☆ on any story to keep it here — saved stories live in this
				browser and survive the live feed moving on.</p>
			</div>`;
		return;
	}
	feedEl.innerHTML = `<div class="nwb-rail nwb-saved">${saved.map((a) => newsRow(a)).join('')}</div>`;
}

// ── Routing between views ────────────────────────────────────────────────────

function show() {
	renderTabs();
	$('nwb-cats').hidden = state.tab !== 'all';
	if (state.tab === 'all') renderCats();
	syncUrl();
	if (state.tab === 'trending') loadTrending();
	else if (state.tab === 'saved') renderSaved();
	else load();
}

function renderTabs() {
	$('nw-tabs').innerHTML = TABS.map(
		(t) =>
			`<button class="nwb-tab" type="button" data-tab="${t.key}" aria-pressed="${String(t.key === state.tab)}">${t.icon}<span>${t.label}</span></button>`,
	).join('');
}

function renderCats() {
	const cats = state.meta?.categories ? ['all', ...state.meta.categories] : Object.keys(CATEGORY_LABELS);
	$('nwb-cats').innerHTML = cats
		.map(
			(c) =>
				`<button class="nw-tab" type="button" data-cat="${esc(c)}" aria-pressed="${String(c === state.category)}">${esc(CATEGORY_LABELS[c] || c)}</button>`,
		)
		.join('');
}

function hydrateFilters() {
	if (state.tab === 'all') renderCats();

	const langSel = $('nw-lang');
	const langs = state.meta?.languages || ['en'];
	langSel.innerHTML =
		langs
			.map((l) => `<option value="${esc(l)}"${l === state.lang ? ' selected' : ''}>${esc(LANGUAGE_LABELS[l] || l)}</option>`)
			.join('') +
		`<option value="all"${state.lang === 'all' ? ' selected' : ''}>All languages</option>`;

	// The source list follows the language: offering a Korean outlet while the
	// feed is set to English hands the user an empty result for no reason.
	const sel = $('nw-source');
	const current = state.source;
	const sources = (state.meta?.sources || []).filter((s) => {
		if (state.lang === 'all') return true;
		return state.lang === 'en' ? !s.language : s.language === state.lang;
	});
	sel.innerHTML =
		'<option value="">All sources</option>' +
		sources
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((s) => {
				const tag = state.lang === 'all' && s.language ? ` (${LANGUAGE_LABELS[s.language] || s.language})` : '';
				return `<option value="${esc(s.key)}"${s.key === current ? ' selected' : ''}>${esc(s.name + tag)}</option>`;
			})
			.join('');
}

function applyTicker(ticker) {
	if (state.tab === 'trending' || state.tab === 'saved') state.tab = 'headlines';
	state.q = ticker;
	$('nw-search').value = ticker;
	show();
}

function wireEvents() {
	$('nw-tabs').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-tab]');
		if (!btn || btn.dataset.tab === state.tab) return;
		state.tab = btn.dataset.tab;
		show();
	});

	$('nwb-cats').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-cat]');
		if (!btn) return;
		state.category = btn.dataset.cat;
		for (const t of $('nwb-cats').querySelectorAll('.nw-tab')) {
			t.setAttribute('aria-pressed', String(t.dataset.cat === state.category));
		}
		syncUrl();
		load();
	});

	let debounce;
	$('nw-search').addEventListener('input', (e) => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			state.q = e.target.value.trim();
			// Search always lands on a live-feed view — trending narratives and the
			// local saved list aren't searchable server-side.
			if (state.q && (state.tab === 'trending' || state.tab === 'saved')) state.tab = 'headlines';
			show();
		}, 300);
	});

	$('nw-lang').addEventListener('change', (e) => {
		state.lang = e.target.value;
		// The previous source may not publish in the new language — clear it
		// rather than silently returning nothing.
		state.source = '';
		hydrateFilters();
		syncUrl();
		if (state.tab !== 'trending' && state.tab !== 'saved') load();
	});

	$('nw-source').addEventListener('change', (e) => {
		state.source = e.target.value;
		if (state.source && (state.tab === 'trending' || state.tab === 'saved')) state.tab = 'headlines';
		show();
	});

	$('nw-more').addEventListener('click', () => load({ append: true }));
	wireNewsContainer($('nw-feed'), {
		onTicker: applyTicker,
		onSave: () => {
			if (state.tab === 'saved') renderSaved();
		},
	});
	wireNewsContainer($('nwb-breaking'));
}

function init() {
	const p = new URLSearchParams(location.search);
	const tab = (p.get('tab') || '').toLowerCase();
	const category = (p.get('category') || '').toLowerCase();
	state.lang = p.get('lang') || 'en';
	state.q = p.get('q') || '';
	state.source = p.get('source') || '';

	if (TABS.some((t) => t.key === tab)) state.tab = tab;
	// Legacy deep links: /markets/news?category=defi picks the matching primary
	// tab; any other category lands on "All" with that category selected.
	if (!tab && category && category !== 'all') {
		const primary = TABS.find((t) => t.category === category);
		if (primary) state.tab = primary.key;
		else if (CATEGORY_LABELS[category]) {
			state.tab = 'all';
			state.category = category;
		}
	} else if (state.tab === 'all' && CATEGORY_LABELS[category]) {
		state.category = category;
	}
	if (state.lang !== 'all' && !LANGUAGE_LABELS[state.lang]) state.lang = 'en';
	if (state.q) $('nw-search').value = state.q;

	renderDate();
	wireEvents();
	show();
	loadBreaking();
	loadBriefing();
}

init();
