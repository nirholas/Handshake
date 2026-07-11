// /markets — the markets hub: live global stats bar, every markets surface
// as its own hero card (with live stats hydrated in), a sortable top-100
// table, and a latest-news rail. All real endpoints, all already cached
// server-side: /api/coin/global, /api/coin/markets, /api/coin/gas,
// /api/news/feed, /api/news/archive?stats=true.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { coinRow, COIN_COLUMNS, coinSortValue } from './shared/market-table.js';
import { newsCard, wireNewsContainer } from './shared/news-render.js';
import { onPageReady } from './shell/page-lifecycle.js';

const $ = (id) => document.getElementById(id);

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── Global stats bar (same cards as /coins) ─────────────────────────────────

const ICONS = {
	trend:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
	bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
	pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
	coins:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
	gauge:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
	activity:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
};

function statCard({ label, value, delta, deltaClass, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
				${delta ? `<p class="delta ${deltaClass || ''}">${esc(delta)}</p>` : ''}
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function fgClass(v) {
	if (v == null) return '';
	if (v <= 25) return 'cv-down';
	if (v <= 55) return '';
	return 'cv-up';
}

function renderStats(global) {
	const el = $('cv-stats');
	if (!el) return; // shell navigation left /markets while the fetch was in flight
	const { market, fear_greed } = global || {};
	const cards = [];
	if (market) {
		cards.push(
			statCard({
				label: 'Total Market Cap',
				value: formatUsd(market.market_cap_usd),
				delta:
					market.market_cap_change_pct_24h != null ? formatPercent(market.market_cap_change_pct_24h) : null,
				deltaClass: (market.market_cap_change_pct_24h ?? 0) >= 0 ? 'cv-up' : 'cv-down',
				icon: 'trend',
			}),
			statCard({ label: '24h Volume', value: formatUsd(market.volume_24h_usd), icon: 'bars' }),
		);
		for (const [i, d] of (market.dominance || []).entries()) {
			cards.push(statCard({ label: `${d.symbol} Dominance`, value: `${d.pct.toFixed(1)}%`, icon: i === 0 ? 'pie' : 'coins' }));
		}
	}
	if (fear_greed) {
		cards.push(
			statCard({
				label: 'Fear & Greed',
				value: String(fear_greed.value),
				delta: fear_greed.label || null,
				deltaClass: fgClass(fear_greed.value),
				icon: 'gauge',
			}),
		);
	}
	if (market?.active_coins != null) {
		cards.push(statCard({ label: 'Active Coins', value: market.active_coins.toLocaleString('en-US'), icon: 'activity' }));
	}
	el.innerHTML = cards.length
		? `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">${cards.join('')}</div>`
		: '';
}

// ── Suite hero cards ─────────────────────────────────────────────────────────

const G = {
	table:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h18M3 12h18M3 19h18"/></svg>',
	grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
	filter:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
	compare:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v18M16 3v18M3 8h18M3 16h18" opacity="0.4"/><polyline points="4 14 8 10 12 13 16 8 20 11"/></svg>',
	gauge:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
	flame:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
	news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z"/></svg>',
	digest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/></svg>',
	archive:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
	cats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><circle cx="17" cy="17" r="3"/></svg>',
	bank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-6 9 6M4 9v11M20 9v11M8 13v4M12 13v4M16 13v4M2 20h20"/></svg>',
	derivs:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="m7 15 3-6 3 4 4-8"/></svg>',
	swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 3 4 4-4 4M21 7H9M7 21l-4-4 4-4M3 17h12"/></svg>',
	defi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
	link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
	dollar:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
	yield:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14s1.5-4 5-4 5 3 5-2"/><circle cx="18" cy="7" r="1.5"/></svg>',
	fees: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h3"/></svg>',
	volume:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M9 20V4M14 20v-8M19 20V8"/></svg>',
	shield:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9.5 12 2 2 3.5-4"/></svg>',
	fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c1 3 4 5 4 9a4 4 0 0 1-8 0c0-1 .5-2 1-3-2 1-4 3-4 6a7 7 0 0 0 14 0c0-5-4-8-7-12z"/></svg>',
	radar:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62a10 10 0 1 0 19.02-1.27"/><path d="M16.24 7.76a6 6 0 1 0-8.01 8.91"/><path d="M12 18h.01"/><path d="M17.99 11.66a6 6 0 0 1-2.22 5.01"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/></svg>',
};

const SUITE = [
	{ href: '/coins', glyph: 'table', title: 'Coins', desc: 'Sortable markets table for hundreds of assets with a rich detail page each.', stat: 'coins' },
	{ href: '/markets/news', glyph: 'news', title: 'Crypto News', desc: 'Live headlines from 192 publisher feeds, filterable and searchable.', stat: 'news' },
	{ href: '/markets/digest', glyph: 'digest', title: 'News Digest', desc: 'The day in stories, not headlines — coverage clustered into what moved.', stat: 'digest' },
	{ href: '/markets/archive', glyph: 'archive', title: 'News Archive', desc: 'The largest open crypto-news archive, back to September 2017.', stat: 'archive' },
	{ href: '/heatmap', glyph: 'grid', title: 'Heatmap', desc: 'The whole market in one view — tiles sized by cap, colored by move.', stat: 'mover' },
	{ href: '/screener', glyph: 'filter', title: 'Screener', desc: 'Filter the top 250 by cap, volume, and 24h move to find movers fast.' },
	{ href: '/compare', glyph: 'compare', title: 'Compare', desc: 'Overlay up to four coins head-to-head with lined-up stats.' },
	{ href: '/fear-greed', glyph: 'gauge', title: 'Fear & Greed', desc: 'One number for market mood, with full interactive history.', stat: 'fg' },
	{ href: '/gas', glyph: 'flame', title: 'Gas Tracker', desc: 'Live Ethereum fees with USD cost estimates per action.', stat: 'gas' },
	{ href: '/categories', glyph: 'cats', title: 'Categories', desc: 'Every crypto sector ranked by market cap — AI, memes, L2s, more.' },
	{ href: '/exchanges', glyph: 'bank', title: 'Exchanges', desc: 'Top venues ranked by trust score and 24h volume.' },
	{ href: '/derivatives', glyph: 'derivs', title: 'Derivatives', desc: 'Perpetual futures — funding, open interest, and volume by market.' },
	{ href: '/converter', glyph: 'swap', title: 'Converter', desc: 'Convert between any crypto and major fiat at live rates.' },
	{ href: '/defi', glyph: 'defi', title: 'DeFi TVL', desc: 'Total value locked across DeFi protocols, live from DeFiLlama.' },
	{ href: '/chains', glyph: 'link', title: 'Chains', desc: 'Blockchain TVL leaderboard with dominance share per chain.' },
	{ href: '/stablecoins', glyph: 'dollar', title: 'Stablecoins', desc: 'Market caps and peg health across every major issuer.' },
	{ href: '/yields', glyph: 'yield', title: 'DeFi Yields', desc: 'Explore ~15k live yield pools by APY and TVL, each with its own history.' },
	{ href: '/fees', glyph: 'fees', title: 'Protocol Fees', desc: 'Fees paid and revenue kept across DeFi, ranked and charted.' },
	{ href: '/dex-volumes', glyph: 'volume', title: 'DEX Volumes', desc: 'The decentralized-exchange volume leaderboard, with share.' },
	{ href: '/hacks', glyph: 'shield', title: 'Hacks Database', desc: 'Every major DeFi exploit — amount, technique, chain, source.' },
	{ href: '/markets/trending', glyph: 'fire', title: 'Trending', desc: 'The most-searched coins, categories, and NFTs right now.' },
	{ href: '/coin-intel', glyph: 'radar', title: 'Coin Intelligence', desc: 'Every launch classified — organic vs bundle, with a learning score.' },
];

function renderSuite(stats = {}) {
	const suiteEl = $('mkt-suite');
	if (!suiteEl) return; // shell navigation left /markets while stats resolved
	suiteEl.innerHTML = SUITE.map((s) => {
		const stat = stats[s.stat];
		return `
			<a class="mkt-hero-card" href="${esc(s.href)}">
				<span class="glyph" aria-hidden="true">${G[s.glyph] || ''}</span>
				<h3>${esc(s.title)}</h3>
				<p>${esc(s.desc)}</p>
				${stat ? `<span class="stat">${stat}</span>` : ''}
			</a>`;
	}).join('');
}

// ── Top 100 table ────────────────────────────────────────────────────────────

const tbl = { coins: [], sortKey: 'rank', sortDir: 'asc' };

function renderTable() {
	const el = $('mkt-table');
	if (!el) return; // shell navigation left /markets while the fetch was in flight
	if (!tbl.coins.length) {
		el.innerHTML =
			'<div class="cv-empty">Market data is temporarily unavailable. <a href="/coins">Try the full markets table</a>.</div>';
		return;
	}
	const head = COIN_COLUMNS.map((col) => {
		const active = col.key === tbl.sortKey;
		const arrow = active ? (tbl.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${tbl.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');
	const sorted = [...tbl.coins].sort((a, b) => {
		const va = coinSortValue(a, tbl.sortKey);
		const vb = coinSortValue(b, tbl.sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return tbl.sortDir === 'asc' ? cmp : -cmp;
	});
	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${head}<th class="hide-xl" aria-hidden="true">7d Chart</th></tr></thead>
				<tbody>${sorted.map(coinRow).join('')}</tbody>
			</table>
		</div>`;
	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === tbl.sortKey) tbl.sortDir = tbl.sortDir === 'asc' ? 'desc' : 'asc';
			else {
				tbl.sortKey = key;
				tbl.sortDir = key === 'name' || key === 'rank' ? 'asc' : 'desc';
			}
			renderTable();
		};
		th.addEventListener('click', activate);
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			}
		});
	});
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			location.href = tr.dataset.href;
		});
	});
}

// ── News rail ────────────────────────────────────────────────────────────────

function renderNews(articles) {
	const el = $('mkt-news');
	if (!el) return; // shell navigation left /markets while the fetch was in flight
	if (!articles?.length) {
		el.innerHTML =
			'<div class="cv-empty">The news feed is warming up — <a href="/markets/news">open the news page</a>.</div>';
		return;
	}
	el.innerHTML = `<div class="nw-grid">${articles.slice(0, 5).map((a) => newsCard(a, { chips: false })).join('')}</div>`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

function skeletons() {
	$('cv-stats').innerHTML =
		'<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
		Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:6rem"></div>').join('') +
		'</div>';
	renderSuite({});
	$('mkt-table').innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from({ length: 10 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('') +
		'</div>';
	$('mkt-news').innerHTML = `<div class="nw-grid">${'<div class="nw-card" aria-hidden="true"><div class="nw-media cv-skel"></div><div class="nw-body"><div class="cv-skel" style="height:0.875rem"></div><div class="cv-skel" style="height:0.875rem;width:70%"></div></div></div>'.repeat(3)}</div>`;
}

async function init() {
	skeletons();
	wireNewsContainer($('mkt-news'));

	const suiteStats = {};
	const jobs = [
		getJson('/api/coin/global')
			.then((g) => {
				renderStats(g);
				if (g?.fear_greed?.value != null) {
					suiteStats.fg = `${g.fear_greed.value} <span class="dim">· ${esc(g.fear_greed.label || '')}</span>`;
				}
				if (g?.market?.active_coins != null) {
					suiteStats.coins = `${g.market.active_coins.toLocaleString()} <span class="dim">tracked assets</span>`;
				}
			})
			.catch(() => {
				const el = $('cv-stats');
				if (el) el.innerHTML = '';
			}),
		getJson('/api/coin/markets?page=1&per_page=100')
			.then(({ coins }) => {
				tbl.coins = coins || [];
				renderTable();
				const mover = [...(coins || [])]
					.filter((c) => c.change_24h != null)
					.sort((a, b) => Math.abs(b.change_24h) - Math.abs(a.change_24h))[0];
				if (mover) {
					const up = mover.change_24h >= 0;
					suiteStats.mover = `<span class="${up ? 'cv-up' : 'cv-down'}">${esc(mover.symbol)} ${up ? '▲' : '▼'} ${esc(formatPercent(mover.change_24h))}</span> <span class="dim">top mover</span>`;
				}
			})
			.catch(() => {
				tbl.coins = [];
				renderTable();
			}),
		getJson('/api/news/feed?limit=6')
			.then((d) => {
				renderNews(d.articles);
				suiteStats.news = `${d.total.toLocaleString()} <span class="dim">live stories · ${d.sources_ok} feeds</span>`;
			})
			.catch(() => renderNews(null)),
		getJson('/api/news/digest?hours=24')
			.then((d) => {
				if (d?.narratives?.length) {
					suiteStats.digest = `${d.narratives.length} <span class="dim">stories · mood ${esc(d.mood)}</span>`;
				}
			})
			.catch(() => {}),
		getJson('/api/news/archive?stats=true')
			.then((d) => {
				if (d?.stats?.total_articles) {
					suiteStats.archive = `${d.stats.total_articles.toLocaleString()} <span class="dim">articles since 2017</span>`;
					const teaser = $('mkt-archive-teaser')?.querySelector('p');
					if (teaser) {
						const first = new Date(d.stats.first_article_date);
						const last = new Date(d.stats.last_article_date);
						const fmt = (x) => x.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
						teaser.textContent = `${d.stats.total_articles.toLocaleString()} articles, ${fmt(first)} → ${fmt(last)} — searchable by ticker, keyword, date, sentiment, and language.`;
					}
				}
			})
			.catch(() => {}),
		getJson('/api/coin/gas')
			.then((d) => {
				const std = d?.tiers?.find((t) => t.key === 'standard') || d?.tiers?.[1];
				const gwei = std?.gas_price_gwei ?? d?.base_fee_gwei;
				if (gwei != null) suiteStats.gas = `${Number(gwei).toFixed(gwei < 10 ? 2 : 0)} <span class="dim">gwei standard</span>`;
			})
			.catch(() => {}),
	];
	await Promise.allSettled(jobs);
	renderSuite(suiteStats);
}

// /markets is a persistent-shell page (<html data-shell> in pages/markets.html):
// the module loads once and re-initializes on every shell navigation back here.
onPageReady(() => init(), { match: (p) => p.replace(/\/$/, '') === '/markets' });
