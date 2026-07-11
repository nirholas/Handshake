// Shared renderers for crypto-news cards — used by /markets/news,
// /markets/news/article (related rail), and the /markets hub news column.
// Pure render functions + one event wirer + the saved-stories store.
//
// Preview images load through a three-step chain so a card never shows a
// broken image:
//   1. The feed image loads directly (referrerpolicy=no-referrer clears most
//      hotlink-referrer blocks for free).
//   2. On error, one retry through the same-origin /api/img proxy — the server
//      fetch is immune to referrer/CORS blocking and mixed-content rules.
//   3. On a second error, the source-initials tile.
// Articles whose feed ships no image at all render the initials tile
// immediately and upgrade in place: /api/news/image resolves the publisher
// page's og:image server-side, fetched from here with fetch() (not an <img>
// src) so its designed "no preview exists" 404 never logs a console error.

import { timeAgo, escapeHtml as esc } from './coin-format.js';
import { storyPath } from './news-links.js';

/**
 * Href for reading an article on three.ws. Articles with a stable identity
 * (16-hex id + publication date — everything from the live feed and the
 * archive) get their canonical, indexable story page
 * (/markets/news/<YYYY-MM>/<id>-<slug>, server-rendered for SEO); anything
 * else falls back to the query-param reader, which carries enough metadata
 * for instant first paint.
 */
export function readerHref(a) {
	const canonical = storyPath(a);
	if (canonical) return canonical;
	const p = new URLSearchParams({ url: a.link, title: a.title, source: a.source });
	if (a.image) p.set('image', a.image);
	return `/markets/news/article?${p}`;
}

export function sentimentDot(a) {
	const label = a.sentiment?.label || 'neutral';
	const cls = label.includes('positive') ? 'pos' : label.includes('negative') ? 'neg' : '';
	return `<span class="nw-dot ${cls}" title="Sentiment: ${esc(label.replace('_', ' '))}"></span>`;
}

export function tickerChips(a, { max = 4 } = {}) {
	if (!a.tickers?.length) return '';
	return `<div class="nw-chips">${a.tickers
		.slice(0, max)
		.map(
			(t) =>
				`<button class="nw-chip" type="button" data-ticker="${esc(t)}" aria-label="Search news for ${esc(t)}">${esc(t)}</button>`,
		)
		.join('')}</div>`;
}

// ── Saved stories (localStorage) ─────────────────────────────────────────────
// Full article snapshots, not just ids — feed articles age out of the live
// window, and a saved story must still render weeks later.

const SAVED_KEY = 'twx_news_saved';
const SAVED_MAX = 200;

function readSaved() {
	try {
		const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Saved articles, most recently saved first. */
export function savedArticles() {
	return readSaved();
}

export function isSaved(id) {
	return readSaved().some((a) => a.id === id);
}

/** Toggle an article in the saved store. Returns true if it is now saved. */
export function toggleSaved(article) {
	if (!article?.id) return false;
	const list = readSaved();
	const idx = list.findIndex((a) => a.id === article.id);
	let saved;
	if (idx >= 0) {
		list.splice(idx, 1);
		saved = false;
	} else {
		const { id, title, link, description, image, source, source_key, category, pub_date, tickers, sentiment } = article;
		list.unshift({ id, title, link, description, image, source, source_key, category, pub_date, tickers, sentiment, saved_at: new Date().toISOString() });
		if (list.length > SAVED_MAX) list.length = SAVED_MAX;
		saved = true;
	}
	try {
		localStorage.setItem(SAVED_KEY, JSON.stringify(list));
	} catch {
		/* storage full or blocked — the in-page toggle still reflects the click */
	}
	return saved;
}

function starButton(a) {
	const saved = isSaved(a.id);
	return `<button class="nw-star" type="button" data-star="${esc(a.id)}" aria-pressed="${saved}"
		aria-label="${saved ? 'Remove from saved stories' : 'Save story'}" title="${saved ? 'Saved — click to remove' : 'Save story'}">${saved ? '★' : '☆'}</button>`;
}

// Articles rendered this page-view, keyed by id, so the delegated star handler
// can persist a full snapshot at click time without threading state through
// every caller.
const renderedArticles = new Map();

// ── Media ────────────────────────────────────────────────────────────────────

const proxied = (u) => `/api/img?url=${encodeURIComponent(u)}`;

export function newsMedia(a, { heroic = false } = {}) {
	const cls = heroic ? 'nw-hero-media' : 'nw-media';
	const initials = esc((a.source || '?').slice(0, 2).toUpperCase());
	if (!a.image) {
		// Designed tile now; wireNewsContainer resolves the publisher's og:image
		// in the background and swaps the tile when one exists.
		return `<div class="${cls}" style="position:relative" data-resolve="${esc(a.link)}"><div class="nw-fallback">${initials}</div></div>`;
	}
	return `<div class="${cls}" style="position:relative"><img src="${esc(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${initials}" data-retry="${esc(proxied(a.image))}" /></div>`;
}

// og:image resolution for imageless articles, bounded to a few fetches in
// flight — a page of text-only stories must not fire fifteen concurrent
// upstream page-fetches through the resolver.
const RESOLVE_CONCURRENCY = 4;
let resolveActive = 0;
const resolveQueue = [];

function pumpResolveQueue() {
	while (resolveActive < RESOLVE_CONCURRENCY && resolveQueue.length) {
		const job = resolveQueue.shift();
		resolveActive++;
		job().finally(() => {
			resolveActive--;
			pumpResolveQueue();
		});
	}
}

async function resolveMedia(el, link) {
	try {
		const res = await fetch(`/api/news/image?url=${encodeURIComponent(link)}`);
		if (!res.ok) return; // no preview exists — the tile IS the design
		const blob = await res.blob();
		if (!blob.type.startsWith('image/')) return;
		const tile = el.querySelector('.nw-fallback');
		if (!tile || !el.isConnected) return;
		const img = document.createElement('img');
		img.alt = '';
		img.decoding = 'async';
		const url = URL.createObjectURL(blob);
		img.onload = () => {
			URL.revokeObjectURL(url);
			tile.replaceWith(img);
		};
		img.src = url;
	} catch {
		/* network hiccup — the tile stays */
	}
}

function queueMediaResolves(container) {
	for (const el of container.querySelectorAll('[data-resolve]')) {
		const link = el.dataset.resolve;
		el.removeAttribute('data-resolve'); // claim before the job runs — never double-queue
		if (link) resolveQueue.push(() => resolveMedia(el, link));
	}
	pumpResolveQueue();
}

// ── Cards / rows ─────────────────────────────────────────────────────────────

export function newsCard(a, { chips = true, desc = true, star = true } = {}) {
	renderedArticles.set(a.id, a);
	return `
		<article class="nw-card" data-href="${esc(readerHref(a))}" tabindex="0">
			${newsMedia(a)}
			<div class="nw-body">
				<div class="nw-meta">${sentimentDot(a)}<span class="nw-src">${esc(a.source)}</span>${star ? starButton(a) : ''}<time datetime="${esc(a.pub_date || '')}">${a.pub_date ? esc(timeAgo(a.pub_date)) : ''}</time></div>
				<h3 class="nw-title"><a href="${esc(readerHref(a))}">${esc(a.title)}</a></h3>
				${desc && a.description ? `<p class="nw-desc">${esc(a.description)}</p>` : ''}
				${chips ? tickerChips(a) : ''}
			</div>
		</article>`;
}

/**
 * Compact headline row — the "Top stories" rail and the Saved tab. Thumbnail
 * on the right so the text keeps one clean reading column.
 */
export function newsRow(a, { thumb = true, star = true } = {}) {
	renderedArticles.set(a.id, a);
	const cat = a.category && a.category !== 'general' ? a.category.replace(/_/g, ' ') : 'general';
	return `
		<article class="nw-row" data-href="${esc(readerHref(a))}" tabindex="0">
			<div class="nw-row-body">
				<div class="nw-meta">${sentimentDot(a)}<span class="nw-src">${esc(a.source)}</span>${star ? starButton(a) : ''}</div>
				<h3 class="nw-row-title"><a href="${esc(readerHref(a))}">${esc(a.title)}</a></h3>
				<div class="nw-row-sub"><time datetime="${esc(a.pub_date || '')}">${a.pub_date ? esc(timeAgo(a.pub_date)) : ''}</time><span class="nw-row-cat">${esc(cat)}</span></div>
			</div>
			${thumb ? `<div class="nw-row-thumb">${newsMedia(a)}</div>` : ''}
		</article>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/**
 * One delegated wirer per container:
 *   • image fallback chain (image error events don't bubble — capture phase)
 *   • data-href cards behave as links (click + Enter) without swallowing real
 *     anchors/buttons inside them
 *   • ticker chips → onTicker
 *   • star buttons → saved store; onSave lets the Saved tab react live
 */
export function wireNewsContainer(container, { onTicker, onSave } = {}) {
	// Upgrade imageless tiles now and after every re-render (tab switches and
	// load-more replace innerHTML; the observer catches them all).
	queueMediaResolves(container);
	let resolveScheduled = false;
	new MutationObserver(() => {
		if (resolveScheduled) return;
		resolveScheduled = true;
		requestAnimationFrame(() => {
			resolveScheduled = false;
			queueMediaResolves(container);
		});
	}).observe(container, { childList: true, subtree: true });

	container.addEventListener(
		'error',
		(e) => {
			const img = e.target;
			if (img?.tagName !== 'IMG' || !img.dataset.fallback) return;
			if (img.dataset.retry) {
				const retry = img.dataset.retry;
				delete img.dataset.retry;
				img.src = retry;
				return;
			}
			const tile = document.createElement('div');
			tile.className = 'nw-fallback';
			tile.textContent = img.dataset.fallback;
			img.replaceWith(tile);
		},
		true,
	);
	container.addEventListener('click', (e) => {
		const starBtn = e.target.closest('[data-star]');
		if (starBtn) {
			e.preventDefault();
			e.stopPropagation();
			const article = renderedArticles.get(starBtn.dataset.star);
			if (!article) return;
			const saved = toggleSaved(article);
			// One story can render in several places (hero + rail + grid) — keep
			// every copy of its star in sync.
			for (const btn of document.querySelectorAll(`[data-star="${CSS.escape(starBtn.dataset.star)}"]`)) {
				btn.setAttribute('aria-pressed', String(saved));
				btn.setAttribute('aria-label', saved ? 'Remove from saved stories' : 'Save story');
				btn.title = saved ? 'Saved — click to remove' : 'Save story';
				btn.textContent = saved ? '★' : '☆';
			}
			if (onSave) onSave(article, saved);
			return;
		}
		const chip = e.target.closest('[data-ticker]');
		if (chip) {
			e.preventDefault();
			e.stopPropagation();
			if (onTicker) onTicker(chip.dataset.ticker);
			else window.location.href = `/markets/news?q=${encodeURIComponent(chip.dataset.ticker)}`;
			return;
		}
		if (e.target.closest('a, button')) return;
		const card = e.target.closest('[data-href]');
		if (card) window.location.href = card.dataset.href;
	});
	container.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		const card = e.target.closest('[data-href]');
		if (card && !e.target.closest('a, button')) window.location.href = card.dataset.href;
	});
}
