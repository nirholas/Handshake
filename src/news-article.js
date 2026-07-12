// The rich reader behind BOTH article surfaces:
//   • /markets/news/<YYYY-MM>/<id>-<slug> — the canonical story pages. The
//     server (api/news/story-page.js) renders the shell with real meta tags
//     and a crawler-visible body plus a #art-seed JSON block; this module
//     keeps that content on screen and upgrades it in place once the full
//     extraction + analysis arrives.
//   • /markets/news/article?url=… — the legacy query-param reader (noindex),
//     still used for articles without a stable id/date.
// Renders: hero image, byline with sentiment, summary + key-points card, full
// article prose (when the publisher allows extraction or ships it in their
// feed), ticker chips deep-linking to /coin/:id, market context at
// publication, and a related-coverage rail. Publisher-blocked pages degrade
// to an honest preview with a prominent read-at-source CTA — never a dead end.

import { timeAgo, escapeHtml as esc, formatPrice, formatPercent, formatUsd } from './shared/coin-format.js';
import { newsCard, wireNewsContainer } from './shared/news-render.js';
import { tickerHref, TICKER_COIN_IDS } from './shared/news-links.js';

const root = document.getElementById('art-root');

let wired = false;
function wire() {
	// wireNewsContainer attaches delegated listeners to the container itself —
	// they survive innerHTML swaps, so wiring twice would double-fire clicks.
	if (wired) return;
	wireNewsContainer(root);
	wired = true;
}

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
	} else if (a.extraction === 'reader') {
		parts.push(`<span class="art-badge" title="The publisher blocks direct fetches; the full text was recovered through a reader service">full text recovered</span>`);
	}
	return `<div class="art-byline">${parts.join('')}</div>`;
}

function tickersHtml(a) {
	if (!a.tickers?.length) return '';
	return `<div class="nw-chips" style="margin:0 0 1.25rem">${a.tickers
		.map(
			(t) =>
				`<a class="nw-chip" href="${esc(tickerHref(t))}" aria-label="${TICKER_COIN_IDS[t] ? `${esc(t)} price and profile` : `More ${esc(t)} coverage`}">${esc(t)}</a>`,
		)
		.join('')}</div>`;
}

// Topics/entities the story is about — subtle, non-linked context chips that
// double as the tags recorded into the agent knowledge base.
function contextTagsHtml(a) {
	const tags = [...new Set([...(a.topics || []), ...(a.entities || [])])]
		.filter((t) => typeof t === 'string' && t.trim().length > 1)
		.slice(0, 8);
	if (!tags.length) return '';
	return `<div class="art-tags" aria-label="Topics">${tags.map((t) => `<span class="art-tag">${esc(t)}</span>`).join('')}</div>`;
}

// Filled-area sparkline for a coin card — reads at a glance which way the week
// went. Green above the open, red below, matched to the chart tokens.
function coinSpark(prices) {
	const pts = (prices || []).filter((n) => typeof n === 'number' && Number.isFinite(n));
	if (pts.length < 2) return '';
	const min = Math.min(...pts);
	const max = Math.max(...pts);
	const range = max - min || 1;
	const w = 180;
	const h = 44;
	const coords = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - ((p - min) / range) * (h - 4) - 2]);
	const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const up = pts[pts.length - 1] >= pts[0];
	const stroke = up ? 'var(--cv-chart-green)' : 'var(--cv-chart-red)';
	const gid = `sg${Math.round(pts[0] * 1e3) % 100000}`;
	const area = `0,${h} ${line} ${w},${h}`;
	return `<svg class="art-coin-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
		<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${stroke}" stop-opacity="0.28"/>
			<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
		</linearGradient></defs>
		<polygon points="${area}" fill="url(#${gid})" stroke="none"/>
		<polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
	</svg>`;
}

function pct(v) {
	if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="dim">—</span>';
	const up = v >= 0;
	return `<span class="${up ? 'cv-up' : 'cv-down'}">${up ? '▲' : '▼'} ${esc(formatPercent(Math.abs(v)))}</span>`;
}

function compactUsd(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) return null;
	if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
	return formatUsd(n);
}

// Live market cards for the coins a story mentions — real price, 24h/7d moves,
// a 7d sparkline, and market cap, deep-linked into the coin profile.
function coinsHtml(a) {
	const coins = (a.coins || []).filter((c) => c && c.price != null);
	if (!coins.length) return '';
	return `
		<section class="art-coins" aria-label="Coins in this story">
			<h2>Coins in this story</h2>
			<div class="art-coin-grid">
				${coins
					.map(
						(c) => `
					<a class="art-coin-card" href="${esc(c.href || `/coin/${c.id}`)}" aria-label="${esc(c.name)} — ${esc(formatPrice(c.price))}">
						<div class="art-coin-head">
							${c.image ? `<img class="art-coin-logo" src="${esc(c.image)}" alt="" loading="lazy" width="26" height="26"/>` : ''}
							<div class="art-coin-id">
								<span class="art-coin-sym">${esc(c.symbol)}</span>
								<span class="art-coin-name">${esc(c.name)}</span>
							</div>
							${c.rank ? `<span class="art-coin-rank">#${esc(String(c.rank))}</span>` : ''}
						</div>
						${coinSpark(c.sparkline)}
						<div class="art-coin-price">${esc(formatPrice(c.price))}</div>
						<div class="art-coin-stats">
							<span title="24h change">24h ${pct(c.change_24h)}</span>
							<span title="7d change">7d ${pct(c.change_7d)}</span>
							${compactUsd(c.market_cap) ? `<span class="dim" title="Market cap">${esc(compactUsd(c.market_cap))}</span>` : ''}
						</div>
					</a>`,
					)
					.join('')}
			</div>
			<p class="art-coins-note">Live market data · tap a coin for its full profile</p>
		</section>`;
}

function fmtUsd(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) return null;
	return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
}

// The market snapshot the hourly archiver captured when the story was
// published — real recorded data the publisher's own page doesn't have.
function marketContextHtml(mc) {
	if (!mc) return '';
	const parts = [];
	if (fmtUsd(mc.btc_price)) parts.push(`BTC ${fmtUsd(mc.btc_price)}`);
	if (fmtUsd(mc.eth_price)) parts.push(`ETH ${fmtUsd(mc.eth_price)}`);
	if (mc.fear_greed_index != null) parts.push(`Fear &amp; Greed ${esc(String(mc.fear_greed_index))}`);
	return parts.length ? `<p class="art-provider">Market at publication: ${parts.join(' · ')}</p>` : '';
}

function summaryCardHtml(a, seed) {
	const points = (a.key_points || []).filter(Boolean);
	return `
		<div class="art-summary-card">
			<h2>Summary</h2>
			<p>${esc(a.summary || a.description || '')}</p>
			${points.length ? `<h2 style="margin-top:1rem">Key points</h2><ul class="art-keypoints">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
			${marketContextHtml(a.market_context || seed?.market_context)}
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
				${coinsHtml(a)}
				${summaryCardHtml(a, seed)}
				${contextTagsHtml(a)}
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
	wire();
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

// On a server-rendered story page the crawler body is already meaningful —
// keep it on screen and only signal that the full text is on its way.
function ssrLoadingIndicator(show) {
	document.getElementById('art-ssr-loading')?.remove();
	if (!show) return;
	const el = document.createElement('div');
	el.id = 'art-ssr-loading';
	el.className = 'art-byline';
	el.innerHTML = `<span class="cv-spinner" aria-hidden="true"></span><span>Extracting the full story…</span>`;
	const anchor = root.querySelector('.art-byline');
	if (anchor) anchor.after(el);
	else root.prepend(el);
}

function ssrErrorNotice(err) {
	ssrLoadingIndicator(false);
	const el = document.createElement('div');
	el.className = 'art-preview-note';
	el.innerHTML = `
		<span aria-hidden="true">⚠️</span>
		<span>Full-text extraction is unavailable right now
		(${err.status === 429 ? 'rate limited — reload in a few seconds' : esc(err.message || 'the reader service didn’t respond')}).
		The story summary above and the read-at-source link still work.</span>`;
	const anchor = root.querySelector('.art-summary-card');
	if (anchor) anchor.after(el);
	else root.append(el);
}

function readSsrSeed() {
	const el = document.getElementById('art-seed');
	if (!el) return null;
	try {
		const seed = JSON.parse(el.textContent);
		return seed?.url ? seed : null;
	} catch {
		return null;
	}
}

async function init() {
	const ssrSeed = readSsrSeed();
	const p = new URLSearchParams(location.search);
	const seed = ssrSeed || {
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
	wire();
	if (ssrSeed) {
		ssrLoadingIndicator(true);
	} else {
		if (seed.title) document.title = `${seed.title} · Crypto News · three.ws`;
		root.innerHTML = skeletonHtml(seed);
	}
	try {
		const q = new URLSearchParams({ url: seed.url });
		if (seed.title) q.set('title', seed.title);
		if (seed.source) q.set('source', seed.source);
		const a = await getJson(`/api/news/article?${q}`);
		render(a, seed);
	} catch (err) {
		if (ssrSeed) ssrErrorNotice(err);
		else renderError(err, seed);
	}
}

init();
