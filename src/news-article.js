// /markets/news/article — the rich reader. Takes ?url= (+ title/source/image
// for instant first paint), calls /api/news/article for server-side
// extraction + analysis, and renders: hero image, byline with sentiment,
// summary + key-points card, full article prose (when the publisher allows
// extraction or ships it in their feed), detected ticker chips, and a
// related-coverage rail. Publisher-blocked pages degrade to an honest
// preview with a prominent read-at-source CTA — never a dead end.

import { timeAgo, escapeHtml as esc } from './shared/coin-format.js';
import { newsCard, wireNewsContainer } from './shared/news-render.js';

const root = document.getElementById('art-root');

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

function skeletonHtml(seed) {
	return `
		${seed.image ? `<div class="art-hero"><img src="${esc(seed.image)}" alt="" /></div>` : ''}
		<h1 class="art-title">${seed.title ? esc(seed.title) : '<span class="cv-skel" style="display:inline-block;height:2rem;width:70%"></span>'}</h1>
		<div class="art-byline">
			${seed.source ? `<span class="src">${esc(seed.source)}</span>` : ''}
			<span class="cv-spinner" aria-hidden="true"></span>
			<span>Extracting the full story…</span>
		</div>
		<div class="art-summary-card" aria-hidden="true">
			<div class="cv-skel" style="height:0.875rem;width:30%;margin-bottom:0.75rem"></div>
			<div class="cv-skel" style="height:0.875rem;margin-bottom:0.5rem"></div>
			<div class="cv-skel" style="height:0.875rem;width:85%;margin-bottom:0.5rem"></div>
			<div class="cv-skel" style="height:0.875rem;width:60%"></div>
		</div>`;
}

function bylineHtml(a) {
	const parts = [];
	parts.push(`<span class="src">${esc(a.source)}</span>`);
	if (a.author) parts.push(`<span>${esc(a.author)}</span>`);
	if (a.published_at && !Number.isNaN(Date.parse(a.published_at))) {
		parts.push(
			`<time datetime="${esc(a.published_at)}" title="${esc(new Date(a.published_at).toLocaleString())}">${esc(timeAgo(a.published_at))}</time>`,
		);
	}
	parts.push(
		`<span class="art-badge ${a.sentiment === 'bullish' ? 'bullish' : a.sentiment === 'bearish' ? 'bearish' : ''}">${a.sentiment === 'bullish' ? '▲' : a.sentiment === 'bearish' ? '▼' : '◆'} ${esc(a.sentiment)}</span>`,
	);
	if (a.extraction === 'feed') {
		parts.push(`<span class="art-badge" title="The publisher blocks page fetches; this text comes from their own RSS feed">via publisher feed</span>`);
	}
	return `<div class="art-byline">${parts.join('')}</div>`;
}

function tickersHtml(a) {
	if (!a.tickers?.length) return '';
	return `<div class="nw-chips" style="margin:0 0 1.25rem">${a.tickers
		.map(
			(t) =>
				`<a class="nw-chip" href="/markets/news?q=${encodeURIComponent(t)}" aria-label="More ${esc(t)} coverage">${esc(t)}</a>`,
		)
		.join('')}</div>`;
}

function summaryCardHtml(a) {
	const points = (a.key_points || []).filter(Boolean);
	return `
		<div class="art-summary-card">
			<h2>Summary</h2>
			<p>${esc(a.summary || a.description || '')}</p>
			${points.length ? `<h2 style="margin-top:1rem">Key points</h2><ul class="art-keypoints">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
			<p class="art-provider">${a.analysis_provider === 'heuristic' ? 'Extractive summary from the article text' : `AI summary via ${esc(a.analysis_provider)}`} · three.ws news</p>
		</div>`;
}

function render(a, seed) {
	const image = a.image || seed.image;
	const paragraphs = (a.paragraphs || []).slice(0, 60);
	const isPreview = a.extraction === 'preview';
	root.innerHTML = `
		${image ? `<div class="art-hero"><img src="${esc(image)}" alt="" data-fallback="${esc((a.source || '?').slice(0, 2).toUpperCase())}" /></div>` : ''}
		<h1 class="art-title">${esc(a.title)}</h1>
		${bylineHtml(a)}
		<div class="art-layout">
			<div>
				${tickersHtml(a)}
				${summaryCardHtml(a)}
				${
					isPreview
						? `<div class="art-preview-note">
								<span aria-hidden="true">🔒</span>
								<span><strong>${esc(a.source)}</strong> doesn’t allow embedded reading, so the full text stays on their site.
								The summary above is built from the story metadata.</span>
							</div>`
						: `<div class="art-prose">${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
				}
				<p style="margin:1.75rem 0 0">
					<a class="art-cta" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">
						Read at ${esc(a.source)}
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
					</a>
				</p>
			</div>
			<aside class="art-rail" aria-label="Related coverage">
				${a.related?.length ? `<h2>Related coverage</h2><div class="nw-grid">${a.related.map((r) => newsCard(r, { chips: false, desc: false })).join('')}</div>` : ''}
				<p style="margin-top:0.75rem"><a class="mkt-more" href="/markets/news">← All crypto news</a></p>
			</aside>
		</div>`;
	document.title = `${a.title} · Crypto News · three.ws`;
	wireNewsContainer(root);
}

function renderError(err, seed) {
	root.innerHTML = `
		${seed.title ? `<h1 class="art-title">${esc(seed.title)}</h1>` : ''}
		<div class="cv-empty">
			<p><strong>Couldn’t open this story.</strong></p>
			<p>${err.status === 429 ? 'Rate limited — wait a few seconds and retry.' : esc(err.message || 'The reader service didn’t respond.')}</p>
			<p style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap">
				<button class="arc-btn" type="button" id="art-retry">Retry</button>
				${seed.url ? `<a class="arc-btn ghost" href="${esc(seed.url)}" target="_blank" rel="noopener noreferrer">Read at the source ↗</a>` : ''}
			</p>
			<p><a href="/markets/news">← Back to crypto news</a></p>
		</div>`;
	document.getElementById('art-retry')?.addEventListener('click', init);
}

async function init() {
	const p = new URLSearchParams(location.search);
	const seed = {
		url: p.get('url') || '',
		title: p.get('title') || '',
		source: p.get('source') || '',
		image: p.get('image') || '',
	};
	if (!seed.url) {
		root.innerHTML = `
			<div class="cv-empty">
				<p><strong>No article selected.</strong></p>
				<p>Pick a story from the <a href="/markets/news">news feed</a> or the
				<a href="/markets/archive">historical archive</a>.</p>
			</div>`;
		return;
	}
	if (seed.title) document.title = `${seed.title} · Crypto News · three.ws`;
	root.innerHTML = skeletonHtml(seed);
	try {
		const q = new URLSearchParams({ url: seed.url });
		if (seed.title) q.set('title', seed.title);
		if (seed.source) q.set('source', seed.source);
		const a = await getJson(`/api/news/article?${q}`);
		render(a, seed);
	} catch (err) {
		renderError(err, seed);
	}
}

init();
