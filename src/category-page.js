// /category/:id — crypto sector detail page. A hero (name, market-cap rank,
// description) over four stat cards, then the sortable table of coins that make
// up the sector, and a strip of the rank-nearest related categories. The sector
// profile comes from /api/coin/category?id=<slug>; the coins table proxies
// /api/coin/markets?category=<slug> (same shared coin-row shape as /coins). All
// real endpoints, cached server-side — never mocked.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { coinRow, COIN_COLUMNS, coinSortValue } from './shared/market-table.js';

const $ = (id) => document.getElementById(id);

const CATEGORY_ID_RE = /^[a-z0-9-]{1,80}$/;

// The slug lives in the path (/category/layer-1) with a ?id= query fallback so
// the page still resolves if it is ever served without the pretty rewrite.
function categoryIdFromLocation() {
	const m = location.pathname.match(/^\/category\/([a-z0-9-]{1,80})$/);
	if (m) return m[1].toLowerCase();
	const q = (new URLSearchParams(location.search).get('id') || '').trim().toLowerCase();
	return CATEGORY_ID_RE.test(q) ? q : null;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

// ── Hero ─────────────────────────────────────────────────────────────────────

function avatarStack(coins) {
	if (!coins || !coins.length) return '';
	const imgs = coins
		.map((u) => `<img src="${esc(u)}" alt="" loading="lazy" width="34" height="34" data-no-dark-filter />`)
		.join('');
	return `<span class="cat-hero-avatars" aria-hidden="true">${imgs}</span>`;
}

function renderHero(cat) {
	$('cat-crumb').textContent = cat.name;
	const rankChip =
		cat.rank != null
			? `<span class="cv-rank-badge">#${cat.rank} by market cap</span>`
			: '';
	const desc = cat.description
		? `<div class="cv-prose cat-desc">${cat.description
				.split(/\n{2,}/)
				.filter((p) => p.trim())
				.slice(0, 4)
				.map((p) => `<p>${esc(p.trim())}</p>`)
				.join('')}</div>`
		: '';
	$('cat-hero').innerHTML = `
		<div class="cat-hero-head">
			${avatarStack(cat.top_3_coins)}
			<div style="min-width:0">
				<div class="cat-hero-title">
					<h1>${esc(cat.name)}</h1>
					${rankChip}
				</div>
				<p class="cat-hero-kicker">Crypto category</p>
			</div>
		</div>
		${desc}`;
}

// ── Stat cards ───────────────────────────────────────────────────────────────

const ICONS = {
	cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
	trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
	vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
	pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
};

function statCard({ label, value, valueClass, delta, deltaClass, icon, tip }) {
	const tipEl = tip
		? `<span class="cat-info" tabindex="0" role="note" aria-label="${esc(tip)}" data-tip="${esc(tip)}">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
			</span>`
		: '';
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}${tipEl}</p>
				<p class="value cv-mono ${valueClass || ''}">${esc(value)}</p>
				${delta ? `<p class="delta ${deltaClass || ''}">${esc(delta)}</p>` : ''}
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function renderStats(cat) {
	const change = cat.market_cap_change_24h;
	const changeStr =
		change != null && Number.isFinite(change)
			? `${change >= 0 ? '▲' : '▼'} ${formatPercent(change)}`
			: '—';
	const cards = [
		statCard({ label: 'Market Cap', value: formatUsd(cat.market_cap), icon: 'cap' }),
		statCard({
			label: '24h Change',
			value: changeStr,
			valueClass: change == null ? '' : change >= 0 ? 'cv-up' : 'cv-down',
			icon: 'trend',
		}),
		statCard({ label: '24h Volume', value: formatUsd(cat.volume_24h), icon: 'vol' }),
		statCard({
			label: 'Share of categorized market',
			value: cat.share_of_total != null ? `${cat.share_of_total.toFixed(1)}%` : '—',
			icon: 'pie',
			tip: "Categories overlap, so shares don't sum to 100%.",
		}),
	];
	$('cat-stats').innerHTML = `<div class="cat-stat-grid">${cards.join('')}</div>`;
}

// ── Coins table ──────────────────────────────────────────────────────────────

const PER_PAGE = 100;
const MAX_PAGE = 20; // markets.js caps page at 20

const table = {
	coins: [],
	page: 0,
	loading: false,
	done: false,
	error: false,
	sortKey: 'rank',
	sortDir: 'asc',
};

let currentId = null;

function tableSkeleton() {
	$('cat-coins').innerHTML = `
		<h2 class="cv-h2">Coins in this category</h2>
		<div class="cv-table-wrap" style="padding:0.75rem">
			${Array.from({ length: 10 }, () => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>').join('')}
		</div>`;
}

function renderTable() {
	const el = $('cat-coins');
	const { coins, loading, error, done } = table;

	if (!coins.length && loading) {
		tableSkeleton();
		return;
	}
	if (!coins.length && error) {
		el.innerHTML = `
			<h2 class="cv-h2">Coins in this category</h2>
			<div class="cat-table-error">
				<p style="margin:0 0 0.75rem">The coins in this category are temporarily unavailable.</p>
				<button type="button" id="cat-coins-retry">Retry</button>
			</div>`;
		$('cat-coins-retry')?.addEventListener('click', () => {
			table.error = false;
			table.page = 0;
			table.done = false;
			loadCoins();
		});
		return;
	}
	if (!coins.length) {
		el.innerHTML = `
			<h2 class="cv-h2">Coins in this category</h2>
			<div class="cv-empty">
				<p style="margin:0 0 0.5rem">No coins tracked in this category yet.</p>
				<p style="margin:0">Browse every sector on the <a href="/categories">categories index</a>.</p>
			</div>`;
		return;
	}

	const head = COIN_COLUMNS.map((col) => {
		const active = col.key === table.sortKey;
		const arrow = active ? (table.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${table.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const sorted = [...coins].sort((a, b) => {
		const va = coinSortValue(a, table.sortKey);
		const vb = coinSortValue(b, table.sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return table.sortDir === 'asc' ? cmp : -cmp;
	});

	el.innerHTML = `
		<div class="cat-coins-bar">
			<h2 class="cv-h2" style="margin:0">Coins in this category</h2>
			<span class="cat-coins-count">${coins.length.toLocaleString('en-US')} shown</span>
		</div>
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${head}<th class="hide-xl" aria-hidden="true">7d Chart</th></tr></thead>
				<tbody>${sorted.map(coinRow).join('')}</tbody>
			</table>
		</div>
		${done ? '' : `<button type="button" class="cv-load-more" id="cat-coins-more"${loading ? ' disabled' : ''}>${loading ? 'Loading…' : 'Load more coins'}</button>`}`;

	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === table.sortKey) {
				table.sortDir = table.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				table.sortKey = key;
				table.sortDir = key === 'name' || key === 'rank' ? 'asc' : 'desc';
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

	$('cat-coins-more')?.addEventListener('click', loadCoins);
}

async function loadCoins() {
	if (table.loading || table.done) return;
	table.loading = true;
	renderTable();
	try {
		const next = table.page + 1;
		const { coins } = await getJson(
			`/api/coin/markets?category=${encodeURIComponent(currentId)}&per_page=${PER_PAGE}&page=${next}`,
		);
		const rows = coins || [];
		table.page = next;
		table.coins.push(...rows);
		// A short page (upstream returned fewer than a full page) or the page
		// ceiling ends pagination.
		if (rows.length < PER_PAGE || next >= MAX_PAGE) table.done = true;
		table.error = false;
	} catch {
		table.error = true;
	}
	table.loading = false;
	renderTable();
}

// ── Related categories ───────────────────────────────────────────────────────

function renderRelated(related) {
	const el = $('cat-related');
	if (!related?.length) {
		el.innerHTML = '';
		return;
	}
	const cards = related
		.map((r) => {
			const change = r.market_cap_change_24h;
			const has = change != null && Number.isFinite(change);
			const cls = !has ? 'dim' : change >= 0 ? 'cv-up' : 'cv-down';
			const chg = has ? `${change >= 0 ? '▲' : '▼'} ${formatPercent(change)}` : '—';
			return `
				<a class="cat-rel-card" href="/category/${encodeURIComponent(r.id)}">
					<span class="nm">${esc(r.name)}</span>
					<span class="mc cv-mono">${esc(formatUsd(r.market_cap))}</span>
					<span class="chg ${cls}">${esc(chg)}</span>
				</a>`;
		})
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">Related categories</h2>
		<div class="cat-rel-grid">${cards}</div>`;
}

// ── Footer link ──────────────────────────────────────────────────────────────

function renderFooterLink(id) {
	$('cat-footer-link').innerHTML = `
		<p class="cat-footer-link">
			Want the full markets table filtered to this sector?
			<a href="/coins?category=${encodeURIComponent(id)}">Open it in the coins screener →</a>
		</p>`;
}

// ── Not-found / error states ─────────────────────────────────────────────────

function clearBelowHero() {
	$('cat-stats').innerHTML = '';
	$('cat-coins').innerHTML = '';
	$('cat-related').innerHTML = '';
	$('cat-footer-link').innerHTML = '';
}

function renderNotFound(id) {
	$('cat-crumb').textContent = 'Not found';
	$('cat-hero').innerHTML = `
		<h1 class="cv-h1">Category not found</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0 0 0.75rem">Could not find a crypto category for “${esc(id)}”. The sector may
			not be tracked by the market data source, or the id is misspelled.</p>
			<p style="margin:0">Browse every sector on the <a href="/categories">categories index</a>.</p>
		</div>`;
	clearBelowHero();
}

function renderError() {
	$('cat-crumb').textContent = 'Unavailable';
	$('cat-hero').innerHTML = `
		<h1 class="cv-h1">Category data unavailable</h1>
		<div class="cv-empty" style="text-align:left">
			<p style="margin:0">The market data source is temporarily unreachable. This usually clears in
			under a minute — <a href="javascript:location.reload()">reload the page</a> or head back to the
			<a href="/categories">categories index</a>.</p>
		</div>`;
	clearBelowHero();
}

// ── SEO / document metadata ──────────────────────────────────────────────────

function updateMeta(cat) {
	const title = `${cat.name} — Crypto Category · three.ws`;
	document.title = title;
	const set = (sel, attr, val) => document.querySelector(sel)?.setAttribute(attr, val);
	const bits = [];
	if (cat.market_cap != null) bits.push(`${formatUsd(cat.market_cap)} market cap`);
	if (cat.rank != null) bits.push(`ranked #${cat.rank}`);
	const desc = `The ${cat.name} crypto sector${bits.length ? ` — ${bits.join(', ')}` : ''}. Live market cap, 24h move, volume, and the coins that make it up.`;
	set('meta[name="description"]', 'content', desc);
	set('meta[property="og:title"]', 'content', title);
	set('meta[property="og:description"]', 'content', desc);
	set('meta[name="twitter:title"]', 'content', title);
	set('meta[name="twitter:description"]', 'content', desc);
	const url = `https://three.ws/category/${cat.id}`;
	set('meta[property="og:url"]', 'content', url);
	let canon = document.querySelector('link[rel="canonical"]');
	if (!canon) {
		canon = document.createElement('link');
		canon.rel = 'canonical';
		document.head.appendChild(canon);
	}
	canon.href = url;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

function heroSkeleton() {
	$('cat-hero').innerHTML = `
		<div class="cat-hero-head">
			<div class="cv-skel" style="width:88px;height:34px;border-radius:999px"></div>
			<div style="flex:1;min-width:0">
				<div class="cv-skel" style="width:16rem;height:2.25rem"></div>
				<div class="cv-skel" style="width:8rem;height:1rem;margin-top:0.75rem"></div>
			</div>
		</div>`;
	$('cat-stats').innerHTML = `<div class="cat-stat-grid">${Array.from(
		{ length: 4 },
		() => '<div class="cv-skel" style="height:6rem"></div>',
	).join('')}</div>`;
}

async function main() {
	const id = categoryIdFromLocation();
	const root = $('cat-main');
	if (!id) {
		location.replace('/categories');
		return;
	}
	currentId = id;
	renderFooterLink(id);
	heroSkeleton();
	tableSkeleton();

	let data;
	try {
		data = await getJson(`/api/coin/category?id=${encodeURIComponent(id)}`);
	} catch (err) {
		root.removeAttribute('aria-busy');
		if (err.status === 404 || err.status === 400) renderNotFound(id);
		else renderError();
		return;
	}

	root.removeAttribute('aria-busy');
	const cat = data.category;
	updateMeta(cat);
	renderHero(cat);
	renderStats(cat);
	renderRelated(data.related);

	// The coins table streams in independently of the sector profile.
	loadCoins();
}

main();
