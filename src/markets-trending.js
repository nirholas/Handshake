// /markets/trending — "Trending": the most-searched crypto on CoinGecko over
// the last 24h, sibling to /markets/news. One serverless read (/api/coin/trending
// → CoinGecko /search/trending) hydrates three sections: trending coins (ranked
// with price, market cap, 24h volume, change, sparkline), trending sectors, and
// trending NFT collections. Coins link into /coin/:id, sectors into /category/:slug
// (only when CoinGecko gives a slug); NFTs are display-only — the platform has no
// NFT pages, so no dead links are ever rendered.
//
// The whole surface is one endpoint, so a fault shows a single retry panel; a
// success auto-refreshes every 120s (matching the CDN window) and stamps a real
// "updated Xs ago" timestamp — no fake spinner, no fake progress.

import { formatUsd, formatPrice, formatPercent, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 120_000;

const state = {
	loading: false,
	lastLoadedAt: 0,
	timer: null,
	tick: null,
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

// ── Formatting helpers ───────────────────────────────────────────────────────

function pct(n) {
	if (n == null || !Number.isFinite(n)) return '<span class="trd-pct">—</span>';
	const dir = n >= 0 ? 'cv-up' : 'cv-down';
	return `<span class="trd-pct ${dir} cv-mono">${esc(formatPercent(n))}</span>`;
}

function floorNative(n, sym) {
	if (n == null || !Number.isFinite(n)) return '—';
	const val = n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : n.toPrecision(3);
	return `${val}${sym ? ` ${esc(sym)}` : ''}`;
}

// ── Coins ────────────────────────────────────────────────────────────────────

function coinRow(c, i) {
	const flame = i === 0 ? '<span class="trd-flame" aria-hidden="true">🔥</span>' : '';
	const href = `/coin/${encodeURIComponent(c.id)}`;
	const spark = c.sparkline_url
		? `<img class="trd-spark" src="${esc(c.sparkline_url)}" loading="lazy" alt="" width="120" height="40" onerror="this.remove()" />`
		: '<span class="trd-spark trd-spark-empty" aria-hidden="true"></span>';
	const img = c.image
		? `<img class="trd-coin-img" src="${esc(c.image)}" loading="lazy" alt="" width="28" height="28" onerror="this.style.visibility='hidden'" />`
		: '<span class="trd-coin-img" aria-hidden="true"></span>';
	return `
		<a class="trd-coin" href="${esc(href)}">
			<span class="trd-rank" aria-label="Trending rank ${i + 1}">${flame}<span class="trd-rank-n">#${i + 1}</span></span>
			${img}
			<span class="trd-coin-id">
				<span class="trd-coin-name">${esc(c.name)}</span>
				<span class="trd-coin-sym">${esc(c.symbol || '')}${c.rank != null ? `<span class="trd-mcap-rank" title="Market-cap rank">#${c.rank}</span>` : ''}</span>
			</span>
			<span class="trd-coin-price cv-mono">${esc(formatPrice(c.price_usd))}</span>
			<span class="trd-coin-chg">${pct(c.change_24h_pct)}</span>
			<span class="trd-coin-mcap cv-mono" title="Market cap">${esc(formatUsd(c.market_cap_usd))}</span>
			<span class="trd-coin-vol cv-mono" title="24h volume">${esc(formatUsd(c.volume_24h_usd))}</span>
			${spark}
		</a>`;
}

function renderCoins(coins) {
	const el = $('trd-coins');
	if (!coins.length) {
		el.innerHTML = emptyPanel('No trending coins', 'CoinGecko has no coins on its 24-hour trending list right now. Check back shortly.');
		return;
	}
	el.innerHTML = `
		<div class="trd-coins-head" aria-hidden="true">
			<span>Rank</span><span></span><span>Asset</span><span>Price</span>
			<span>24h</span><span>Market cap</span><span>Volume</span><span>Last 7d</span>
		</div>
		${coins.map(coinRow).join('')}`;
}

// ── Categories (sectors) ─────────────────────────────────────────────────────

function categoryCard(c) {
	const inner = `
		<span class="trd-card-name">${esc(c.name)}</span>
		<dl class="trd-card-stats">
			<div><dt>Coins</dt><dd>${c.coins_count != null ? c.coins_count.toLocaleString('en-US') : '—'}</dd></div>
			<div><dt>1h mcap</dt><dd>${pct(c.mcap_change_1h_pct)}</dd></div>
			<div><dt>Market cap</dt><dd class="cv-mono">${esc(formatUsd(c.market_cap_usd))}</dd></div>
		</dl>`;
	// Only link when CoinGecko provides a slug — /category/:slug exists, but an
	// unslugged sector would produce a dead link, so it stays unlinked.
	return c.slug
		? `<a class="trd-card trd-card-link" href="/category/${encodeURIComponent(c.slug)}">${inner}</a>`
		: `<div class="trd-card">${inner}</div>`;
}

function renderCategories(cats) {
	const el = $('trd-cats');
	if (!cats.length) {
		el.innerHTML = emptyPanel('No trending sectors', 'No crypto sectors are trending on CoinGecko right now.');
		return;
	}
	el.innerHTML = cats.map(categoryCard).join('');
}

// ── NFTs (display-only) ──────────────────────────────────────────────────────

function nftCard(n) {
	const thumb = n.thumb
		? `<img class="trd-nft-img" src="${esc(n.thumb)}" loading="lazy" alt="" width="40" height="40" onerror="this.style.visibility='hidden'" />`
		: '<span class="trd-nft-img" aria-hidden="true"></span>';
	return `
		<div class="trd-card trd-nft">
			<span class="trd-nft-head">
				${thumb}
				<span class="trd-card-name">${esc(n.name)}${n.symbol ? ` <span class="trd-coin-sym">${esc(n.symbol)}</span>` : ''}</span>
			</span>
			<dl class="trd-card-stats">
				<div><dt>Floor</dt><dd class="cv-mono">${esc(floorNative(n.floor_price_native, n.native_currency_symbol))}${n.floor_price_usd != null ? `<span class="trd-usd">${esc(formatUsd(n.floor_price_usd))}</span>` : ''}</dd></div>
				<div><dt>24h floor</dt><dd>${pct(n.floor_change_24h_pct)}</dd></div>
				<div><dt>24h vol</dt><dd class="cv-mono">${esc(formatUsd(n.volume_24h_usd))}</dd></div>
			</dl>
		</div>`;
}

function renderNfts(nfts) {
	const el = $('trd-nfts');
	if (!nfts.length) {
		el.innerHTML = emptyPanel('No trending NFTs', 'CoinGecko has no NFT collections on its trending list right now.');
		return;
	}
	el.innerHTML = nfts.map(nftCard).join('');
}

// ── States ───────────────────────────────────────────────────────────────────

function emptyPanel(title, body) {
	return `<div class="cv-empty trd-empty"><p><strong>${esc(title)}</strong></p><p>${esc(body)}</p></div>`;
}

function skeleton(kind) {
	if (kind === 'coins') {
		return `<div class="trd-skel-coins" aria-hidden="true">${'<div class="cv-skel trd-skel-row"></div>'.repeat(7)}</div>`;
	}
	return `<div class="trd-skel-cards" aria-hidden="true">${'<div class="cv-skel trd-skel-card"></div>'.repeat(kind === 'cats' ? 6 : 4)}</div>`;
}

function showSkeletons() {
	$('trd-coins').innerHTML = skeleton('coins');
	$('trd-cats').innerHTML = skeleton('cats');
	$('trd-nfts').innerHTML = skeleton('nfts');
}

function showError(status) {
	const msg =
		status === 429
			? 'You’re moving fast — give it a few seconds and retry.'
			: 'CoinGecko’s trending feed didn’t respond. It usually recovers on its own.';
	$('trd-coins').innerHTML = `
		<div class="cv-empty trd-error">
			<p><strong>Couldn’t load trending data.</strong></p>
			<p>${esc(msg)}</p>
			<p><button class="arc-btn" type="button" id="trd-retry">Retry</button></p>
		</div>`;
	$('trd-cats').innerHTML = '';
	$('trd-nfts').innerHTML = '';
	$('trd-retry')?.addEventListener('click', () => load());
}

// ── Updated timestamp ────────────────────────────────────────────────────────

function stampUpdated() {
	const el = $('trd-updated');
	if (!el || !state.lastLoadedAt) return;
	const s = Math.max(0, Math.floor((Date.now() - state.lastLoadedAt) / 1000));
	const rel = s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
	el.innerHTML = `<span class="trd-live-dot" aria-hidden="true"></span>Updated ${rel}`;
}

// ── Load / refresh ───────────────────────────────────────────────────────────

async function load() {
	if (state.loading) return;
	state.loading = true;
	// Only paint skeletons on the first load — a background refresh keeps the
	// current data on screen so the page never flickers to empty every 2 min.
	if (!state.lastLoadedAt) showSkeletons();
	try {
		const data = await getJson('/api/coin/trending');
		renderCoins(Array.isArray(data.coins) ? data.coins : []);
		renderCategories(Array.isArray(data.categories) ? data.categories : []);
		renderNfts(Array.isArray(data.nfts) ? data.nfts : []);
		state.lastLoadedAt = Date.now();
		stampUpdated();
	} catch (err) {
		// A background refresh that fails leaves the last good render in place;
		// only a cold first load shows the retry panel.
		if (!state.lastLoadedAt) showError(err.status);
	} finally {
		state.loading = false;
	}
}

function init() {
	load();
	// Auto-refresh on the CDN window; pause while the tab is hidden so a
	// backgrounded page doesn't keep hitting the endpoint.
	const start = () => {
		if (!state.timer) state.timer = setInterval(load, REFRESH_MS);
		if (!state.tick) state.tick = setInterval(stampUpdated, 1000);
	};
	const stop = () => {
		clearInterval(state.timer);
		clearInterval(state.tick);
		state.timer = null;
		state.tick = null;
	};
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stop();
		else { load(); start(); }
	});
	start();
}

init();
