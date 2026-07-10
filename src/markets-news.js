// /markets/news — live aggregated crypto news over /api/news/feed (native
// three.ws aggregator). Category tabs, debounced search, language and source
// filters, lead-story hero, card grid with sentiment + ticker chips, offset
// pagination. Every story opens the rich reader at /markets/news/article; the
// source link goes straight to the publisher.
//
// Language defaults to English. The registry also carries international feeds,
// which are opt-in via the language selector so the default feed reads as one
// coherent stream rather than an interleaving of scripts.

import { timeAgo, escapeHtml as esc } from './shared/coin-format.js';
import {
	newsCard,
	newsMedia,
	sentimentDot,
	tickerChips,
	readerHref,
	wireNewsContainer,
} from './shared/news-render.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 24;

// Covers every category the registry can emit. The tab bar renders from the
// API's live category list, so a missing label leaks a raw key ("ai_crypto").
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
	category: 'all',
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

function feedUrl(offset) {
	const p = new URLSearchParams();
	if (state.category && state.category !== 'all') p.set('category', state.category);
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
	if (state.category !== 'all') p.set('category', state.category);
	if (state.lang !== 'en') p.set('lang', state.lang);
	if (state.q) p.set('q', state.q);
	if (state.source) p.set('source', state.source);
	const qs = p.toString();
	history.replaceState(null, '', qs ? `/markets/news?${qs}` : '/markets/news');
}

function heroHtml(a) {
	return `
		<article class="nw-hero" data-href="${esc(readerHref(a))}">
			${newsMedia(a, { heroic: true })}
			<div class="nw-hero-body">
				<div class="nw-meta">${sentimentDot(a)}<span class="nw-src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.pub_date || '')}">${a.pub_date ? esc(timeAgo(a.pub_date)) : ''}</time></div>
				<h2><a href="${esc(readerHref(a))}">${esc(a.title)}</a></h2>
				${a.description ? `<p class="nw-desc" style="-webkit-line-clamp:3">${esc(a.description)}</p>` : ''}
				${tickerChips(a)}
			</div>
		</article>`;
}

function skeleton() {
	const card = `<div class="nw-card" aria-hidden="true"><div class="nw-media cv-skel"></div>
		<div class="nw-body"><div class="cv-skel" style="height:0.75rem;width:40%"></div>
		<div class="cv-skel" style="height:1rem"></div><div class="cv-skel" style="height:1rem;width:80%"></div></div></div>`;
	return `<div class="nw-grid">${card.repeat(9)}</div>`;
}

function render() {
	const feedEl = $('nw-feed');
	const { articles } = state;
	if (!articles.length) {
		feedEl.innerHTML = `
			<div class="cv-empty">
				<p><strong>No stories match.</strong></p>
				<p>Try a different search, another category, or browse the
				<a href="/markets/archive">662k-article archive</a> for older coverage.</p>
			</div>`;
		$('nw-count').textContent = '';
		$('nw-more').hidden = true;
		return;
	}
	const showHero = !state.q && !state.source && articles[0]?.image;
	const heroA = showHero ? articles[0] : null;
	const rest = showHero ? articles.slice(1) : articles;
	feedEl.innerHTML = `${heroA ? heroHtml(heroA) : ''}<div class="nw-grid">${rest.map((a) => newsCard(a)).join('')}</div>`;
	const src = state.meta?.sources?.find((s) => s.key === state.source);
	$('nw-count').textContent =
		`${state.total.toLocaleString()} stories · ${state.sourcesOk}/${state.sourcesTotal} feeds live` +
		(state.category !== 'all' ? ` · ${CATEGORY_LABELS[state.category] || state.category}` : '') +
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
		render();
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

function renderTabs() {
	const cats = state.meta?.categories ? ['all', ...state.meta.categories] : Object.keys(CATEGORY_LABELS);
	$('nw-tabs').innerHTML = cats
		.map(
			(c) =>
				`<button class="nw-tab" type="button" data-cat="${esc(c)}" aria-pressed="${String(c === state.category)}">${esc(CATEGORY_LABELS[c] || c)}</button>`,
		)
		.join('');
}

function hydrateFilters() {
	renderTabs();

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
	state.q = ticker;
	$('nw-search').value = ticker;
	syncUrl();
	load();
}

function wireEvents() {
	$('nw-tabs').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-cat]');
		if (!btn) return;
		state.category = btn.dataset.cat;
		for (const t of $('nw-tabs').querySelectorAll('.nw-tab')) {
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
			syncUrl();
			load();
		}, 300);
	});

	$('nw-lang').addEventListener('change', (e) => {
		state.lang = e.target.value;
		// The previous source may not publish in the new language — clear it
		// rather than silently returning nothing.
		state.source = '';
		hydrateFilters();
		syncUrl();
		load();
	});

	$('nw-source').addEventListener('change', (e) => {
		state.source = e.target.value;
		syncUrl();
		load();
	});

	$('nw-more').addEventListener('click', () => load({ append: true }));
	wireNewsContainer($('nw-feed'), { onTicker: applyTicker });
}

function init() {
	const p = new URLSearchParams(location.search);
	state.category = p.get('category') || 'all';
	state.lang = p.get('lang') || 'en';
	state.q = p.get('q') || '';
	state.source = p.get('source') || '';
	if (state.q) $('nw-search').value = state.q;
	if (!CATEGORY_LABELS[state.category]) state.category = 'all';
	if (state.lang !== 'all' && !LANGUAGE_LABELS[state.lang]) state.lang = 'en';
	renderTabs();
	wireEvents();
	load();
}

init();
