// Shared renderers for crypto-news cards — used by /markets/news,
// /markets/news/article (related rail), and the /markets hub news column.
// Pure functions + one event wirer; no module side effects.

import { timeAgo, escapeHtml as esc } from './coin-format.js';

/** Reader-page href carrying enough metadata for instant first paint. */
export function readerHref(a) {
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

export function newsMedia(a, { heroic = false } = {}) {
	const cls = heroic ? 'nw-hero-media' : 'nw-media';
	const initials = esc((a.source || '?').slice(0, 2).toUpperCase());
	if (a.image) {
		return `<div class="${cls}" style="position:relative"><img src="${esc(a.image)}" alt="" loading="lazy" decoding="async" data-fallback="${initials}" /></div>`;
	}
	return `<div class="${cls}" style="position:relative"><div class="nw-fallback">${initials}</div></div>`;
}

export function newsCard(a, { chips = true, desc = true } = {}) {
	return `
		<article class="nw-card" data-href="${esc(readerHref(a))}">
			${newsMedia(a)}
			<div class="nw-body">
				<div class="nw-meta">${sentimentDot(a)}<span class="nw-src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.pub_date || '')}">${a.pub_date ? esc(timeAgo(a.pub_date)) : ''}</time></div>
				<h3 class="nw-title"><a href="${esc(readerHref(a))}">${esc(a.title)}</a></h3>
				${desc && a.description ? `<p class="nw-desc">${esc(a.description)}</p>` : ''}
				${chips ? tickerChips(a) : ''}
			</div>
		</article>`;
}

/**
 * Broken/hotlink-blocked thumbnails become a source-initials tile. Image
 * error events don't bubble, so listen in the capture phase. Also makes
 * data-href cards behave as links (click + Enter) without swallowing real
 * anchors/buttons inside them.
 */
export function wireNewsContainer(container, { onTicker } = {}) {
	container.addEventListener(
		'error',
		(e) => {
			const img = e.target;
			if (img?.tagName !== 'IMG' || !img.dataset.fallback) return;
			const tile = document.createElement('div');
			tile.className = 'nw-fallback';
			tile.textContent = img.dataset.fallback;
			img.replaceWith(tile);
		},
		true,
	);
	container.addEventListener('click', (e) => {
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
