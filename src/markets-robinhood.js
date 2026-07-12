// /markets/robinhood — Robinhood Chain hub: Stocks / Coins / Chain tabs.
//
// Hydrates the static skeleton in pages/markets-robinhood.html (tabs + three
// empty panel sections). Every panel builds its own toolbar, stat strip, and
// table entirely from here — real data only, from /api/v1/robinhood/*. Each
// tab has its own loading skeleton, empty state, and retry-on-error state.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { sparkline } from './shared/market-table.js';
import { onPageReady } from './shell/page-lifecycle.js';

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		const err = new Error(body?.error_description || body?.error || `request failed (${res.status})`);
		err.status = res.status;
		throw err;
	}
	return body?.data ?? body;
}

function fmtNav(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function premiumChip(pct) {
	if (pct == null || !Number.isFinite(pct)) return '<span class="rh-premium flat">—</span>';
	const cls = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'pos' : 'neg';
	const sign = pct > 0 ? '+' : '';
	return `<span class="rh-premium ${cls}">${sign}${pct.toFixed(2)}%</span>`;
}

function skeletonTable(cols, rows = 6) {
	const body = Array.from({ length: rows })
		.map(() => `<tr>${Array.from({ length: cols }).map(() => `<td><div class="cv-skel" style="height:14px;width:80%"></div></td>`).join('')}</tr>`)
		.join('');
	return `<div class="cv-table-wrap"><table class="cv-table"><tbody>${body}</tbody></table></div>`;
}

function emptyState(message, retryAction) {
	return `<div class="cv-empty"><p>${esc(message)}</p>${retryAction ? `<button class="cv-load-more" type="button" data-retry="${esc(retryAction)}">Retry</button>` : ''}</div>`;
}

function wireRowLinks(root) {
	root.querySelectorAll('tr[data-href]').forEach((tr) => {
		tr.style.cursor = 'pointer';
		tr.addEventListener('click', () => {
			window.location.href = tr.dataset.href;
		});
	});
}

function wireRetries(root, handlers) {
	root.querySelectorAll('[data-retry]').forEach((btn) => {
		const fn = handlers[btn.dataset.retry];
		if (fn) btn.addEventListener('click', fn);
	});
}

// ── Stocks panel ─────────────────────────────────────────────────────────────
const stocksState = { rows: [], sort: 'symbol', q: '' };

function stocksTableHtml(rows) {
	if (!rows.length) return emptyState('No Stock Tokens matched your search.');
	return `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>
					<th class="left">Symbol</th><th>NAV</th><th>DEX Price</th><th>Premium</th><th class="hide-md">24h Vol</th><th class="hide-lg">Liquidity</th>
				</tr></thead>
				<tbody>
					${rows
						.map(
							(r) => `
						<tr data-href="/markets/robinhood/stock/${encodeURIComponent(r.symbol)}">
							<td class="left"><div class="rh-symbol-cell"><span class="sym">${esc(r.symbol)}</span><span class="name hide-sm">${esc((r.name || '').replace(' • Robinhood Token', ''))}</span></div></td>
							<td class="cv-mono">${fmtNav(r.navPriceUsd)}</td>
							<td class="cv-mono">${r.dexPriceUsd != null ? fmtNav(r.dexPriceUsd) : '—'}</td>
							<td>${premiumChip(r.premiumPct)}</td>
							<td class="hide-md">${esc(formatUsd(r.volume24hUsd))}</td>
							<td class="hide-lg">${esc(formatUsd(r.liquidityUsd))}</td>
						</tr>`,
						)
						.join('')}
				</tbody>
			</table>
		</div>`;
}

function renderStocksRows() {
	const tableEl = document.getElementById('rh-stocks-table');
	if (!tableEl) return;
	let rows = stocksState.rows;
	if (stocksState.q) {
		const q = stocksState.q.toLowerCase();
		rows = rows.filter((r) => r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
	}
	const key = { symbol: 'symbol', volume: 'volume24hUsd', premium: 'premiumPct', liquidity: 'liquidityUsd' }[stocksState.sort] || 'symbol';
	rows = [...rows].sort((a, b) => (key === 'symbol' ? a.symbol.localeCompare(b.symbol) : (b[key] ?? -Infinity) - (a[key] ?? -Infinity)));
	tableEl.innerHTML = stocksTableHtml(rows);
	wireRowLinks(tableEl);
}

function renderStocksShell() {
	const panel = document.getElementById('rh-panel-stocks');
	if (!panel) return;
	panel.innerHTML = `
		<div class="rh-toolbar">
			<input class="rh-search" id="rh-stocks-search" type="search" placeholder="Search stocks (e.g. AAPL)" aria-label="Search Stock Tokens" />
			<div class="rh-sortbar" role="group" aria-label="Sort stocks">
				<button type="button" class="rh-sort-btn" data-sort="symbol" aria-pressed="true">Symbol</button>
				<button type="button" class="rh-sort-btn" data-sort="volume" aria-pressed="false">Volume</button>
				<button type="button" class="rh-sort-btn" data-sort="premium" aria-pressed="false">Premium</button>
				<button type="button" class="rh-sort-btn" data-sort="liquidity" aria-pressed="false">Liquidity</button>
			</div>
		</div>
		<div id="rh-stocks-table">${skeletonTable(6)}</div>
		<p class="rh-disclosure">
			Stock Tokens are tokenized debt securities issued by Robinhood Assets (Jersey) Ltd and
			may not be offered, sold, or delivered to US persons (extra limits: Canada, UK,
			Switzerland). Data shown here is display-only.
		</p>
	`;
	const search = panel.querySelector('#rh-stocks-search');
	let debounce;
	search?.addEventListener('input', () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			stocksState.q = search.value.trim();
			renderStocksRows();
		}, 200);
	});
	panel.querySelectorAll('.rh-sort-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			panel.querySelectorAll('.rh-sort-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
			btn.setAttribute('aria-pressed', 'true');
			stocksState.sort = btn.dataset.sort;
			renderStocksRows();
		});
	});
}

async function loadStocks() {
	renderStocksShell();
	const tableEl = document.getElementById('rh-stocks-table');
	try {
		const data = await getJson('/api/v1/robinhood/stocks');
		stocksState.rows = data.stocks || [];
		renderStocksRows();
	} catch (err) {
		if (tableEl) {
			tableEl.innerHTML = emptyState(err.message || 'Failed to load Stock Tokens.', 'stocks');
			wireRetries(tableEl, { stocks: loadStocks });
		}
	}
}

// ── Coins panel ──────────────────────────────────────────────────────────────
const coinsState = { category: 'meme', sort: 'market_cap' };

function coinRowHtml(c) {
	const href = `/markets/robinhood/coin/${encodeURIComponent(c.id)}`;
	return `
		<tr data-href="${esc(href)}">
			<td class="left"><div class="rh-symbol-cell">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" />` : ''}<span class="sym">${esc(c.symbol)}</span><span class="name hide-sm">${esc(c.name)}</span></div></td>
			<td class="cv-mono">${esc(formatUsd(c.priceUsd))}</td>
			<td class="${(c.priceChange24hPct ?? 0) >= 0 ? 'cv-up' : 'cv-down'}">${esc(formatPercent(c.priceChange24hPct))}</td>
			<td class="hide-md">${esc(formatUsd(c.marketCapUsd))}</td>
			<td class="hide-lg">${esc(formatUsd(c.volume24hUsd))}</td>
			<td class="hide-xl">${c.sparkline7d ? sparkline(c.sparkline7d) : ''}</td>
		</tr>`;
}

async function loadCoins() {
	const el = document.getElementById('rh-coins-table');
	if (!el) return;
	el.innerHTML = skeletonTable(6);
	try {
		const data = await getJson(`/api/v1/robinhood/coins?category=${encodeURIComponent(coinsState.category)}&sort=${encodeURIComponent(coinsState.sort)}`);
		const coins = data.coins || [];
		if (!coins.length) {
			el.innerHTML = emptyState('No coins found in this category right now.');
			return;
		}
		el.innerHTML = `
			<div class="cv-table-wrap">
				<table class="cv-table">
					<thead><tr><th class="left">Coin</th><th>Price</th><th>24h %</th><th class="hide-md">Mkt Cap</th><th class="hide-lg">Volume</th><th class="hide-xl">7d</th></tr></thead>
					<tbody>${coins.map(coinRowHtml).join('')}</tbody>
				</table>
			</div>`;
		wireRowLinks(el);
	} catch (err) {
		el.innerHTML = emptyState(err.message || 'Failed to load coins.', 'coins');
		wireRetries(el, { coins: loadCoins });
	}
}

async function loadLaunches() {
	const el = document.getElementById('rh-launches-table');
	if (!el) return;
	el.innerHTML = skeletonTable(4, 5);
	try {
		const data = await getJson('/api/v1/robinhood/launches?limit=20');
		const launches = data.launches || [];
		if (!launches.length) {
			el.innerHTML = emptyState('No recent launches found.');
			return;
		}
		el.innerHTML = `
			<div class="cv-table-wrap">
				<table class="cv-table">
					<thead><tr><th class="left">Token</th><th>Launchpad</th><th class="hide-md">Price</th><th class="hide-lg">Mkt Cap</th></tr></thead>
					<tbody>${launches
						.map(
							(l) => `
						<tr data-href="/markets/robinhood/coin/${encodeURIComponent(l.token)}">
							<td class="left cv-mono">${esc(l.symbol || `${l.token.slice(0, 6)}…${l.token.slice(-4)}`)}</td>
							<td><span class="rh-launchpad-badge">${esc(l.launchpad)}</span></td>
							<td class="hide-md cv-mono">${l.priceUsd != null ? esc(formatUsd(l.priceUsd)) : '—'}</td>
							<td class="hide-lg">${l.marketCapUsd != null ? esc(formatUsd(l.marketCapUsd)) : '—'}</td>
						</tr>`,
						)
						.join('')}</tbody>
				</table>
			</div>`;
		wireRowLinks(el);
	} catch {
		el.innerHTML = '';
	}
}

function renderCoinsShell() {
	const panel = document.getElementById('rh-panel-coins');
	if (!panel) return;
	panel.innerHTML = `
		<div class="rh-toolbar">
			<div class="rh-sortbar" role="group" aria-label="Coin category">
				<button type="button" class="rh-cat-btn rh-sort-btn" data-cat="meme" aria-pressed="true">Memecoins</button>
				<button type="button" class="rh-cat-btn rh-sort-btn" data-cat="stocks-ecosystem" aria-pressed="false">Stocks Ecosystem</button>
				<button type="button" class="rh-cat-btn rh-sort-btn" data-cat="ecosystem" aria-pressed="false">Ecosystem</button>
			</div>
			<div class="rh-sortbar" role="group" aria-label="Sort coins">
				<button type="button" class="rh-coin-sort-btn rh-sort-btn" data-sort="market_cap" aria-pressed="true">Market Cap</button>
				<button type="button" class="rh-coin-sort-btn rh-sort-btn" data-sort="volume" aria-pressed="false">Volume</button>
				<button type="button" class="rh-coin-sort-btn rh-sort-btn" data-sort="gainers" aria-pressed="false">Gainers</button>
				<button type="button" class="rh-coin-sort-btn rh-sort-btn" data-sort="losers" aria-pressed="false">Losers</button>
			</div>
		</div>
		<div id="rh-coins-table">${skeletonTable(6)}</div>
		<div class="cv-toolbar" style="margin: 2rem 0 1rem"><h2 class="cv-h2" style="margin: 0">Recent Launches</h2></div>
		<div id="rh-launches-table">${skeletonTable(4, 5)}</div>
	`;
	panel.querySelectorAll('.rh-cat-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			panel.querySelectorAll('.rh-cat-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
			btn.setAttribute('aria-pressed', 'true');
			coinsState.category = btn.dataset.cat;
			loadCoins();
		});
	});
	panel.querySelectorAll('.rh-coin-sort-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			panel.querySelectorAll('.rh-coin-sort-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
			btn.setAttribute('aria-pressed', 'true');
			coinsState.sort = btn.dataset.sort;
			loadCoins();
		});
	});
}

async function loadCoinsPanel() {
	renderCoinsShell();
	await Promise.allSettled([loadCoins(), loadLaunches()]);
}

// ── Chain panel ──────────────────────────────────────────────────────────────
function renderChainShell() {
	const panel = document.getElementById('rh-panel-chain');
	if (!panel) return;
	panel.innerHTML = `
		<div class="rh-stat-strip" id="rh-chain-stats">
			${Array.from({ length: 4 }).map(() => `<div class="cv-stat-card"><div class="cv-skel" style="height:12px;width:60%;margin-bottom:8px"></div><div class="cv-skel" style="height:20px;width:80%"></div></div>`).join('')}
		</div>
		<div class="cv-toolbar" style="margin: 1.5rem 0 1rem"><h2 class="cv-h2" style="margin: 0">TVL — last 90 days</h2></div>
		<div id="rh-chain-chart"></div>
	`;
}

async function loadChainPanel() {
	renderChainShell();
	const statsEl = document.getElementById('rh-chain-stats');
	const chartEl = document.getElementById('rh-chain-chart');
	try {
		const chain = await getJson('/api/v1/robinhood/chain');
		if (statsEl) {
			statsEl.innerHTML = `
				<div class="cv-stat-card"><div class="label">Chain ID</div><div class="value">4663</div></div>
				<div class="cv-stat-card"><div class="label">Chain TVL</div><div class="value">${esc(formatUsd(chain.tvlUsd))}</div></div>
				<div class="cv-stat-card"><div class="label">Gas (avg)</div><div class="value cv-mono">${chain.gas?.average != null ? `${chain.gas.average} gwei` : '—'}</div></div>
				<div class="cv-stat-card"><div class="label">Block Time</div><div class="value">${chain.averageBlockTimeMs != null ? `${chain.averageBlockTimeMs}ms` : '—'}</div></div>
			`;
		}
		if (chartEl && Array.isArray(chain.tvlHistory) && chain.tvlHistory.length > 1) {
			const points = chain.tvlHistory.map((p) => p.tvl);
			const min = Math.min(...points);
			const max = Math.max(...points);
			const range = max - min || 1;
			const w = 800;
			const h = 240;
			const path = points
				.map((v, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
				.join(' ');
			chartEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" aria-label="Chain TVL, last 90 days"><polyline points="${path}" fill="none" stroke="var(--cv-chart-green)" stroke-width="2"/></svg>`;
		} else if (chartEl) {
			chartEl.innerHTML = emptyState('No TVL history available yet.');
		}
	} catch (err) {
		if (statsEl) {
			statsEl.innerHTML = emptyState(err.message || 'Failed to load chain stats.', 'chain');
			wireRetries(statsEl, { chain: loadChainPanel });
		}
	}
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = ['stocks', 'coins', 'chain'];
const LOADERS = { stocks: loadStocks, coins: loadCoinsPanel, chain: loadChainPanel };
const loaded = new Set();

function activateTab(name) {
	for (const t of TABS) {
		const btn = document.getElementById(`rh-tab-${t}`);
		const panel = document.getElementById(`rh-panel-${t}`);
		const active = t === name;
		if (btn) {
			btn.setAttribute('aria-selected', String(active));
			btn.classList.toggle('is-active', active);
		}
		if (panel) panel.hidden = !active;
	}
	if (!loaded.has(name)) {
		loaded.add(name);
		LOADERS[name]?.();
	}
}

function wireTabs() {
	TABS.forEach((t, idx) => {
		const btn = document.getElementById(`rh-tab-${t}`);
		if (!btn) return;
		btn.addEventListener('click', () => activateTab(t));
		btn.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowRight') activateTab(TABS[(idx + 1) % TABS.length]);
			else if (e.key === 'ArrowLeft') activateTab(TABS[(idx - 1 + TABS.length) % TABS.length]);
		});
	});
}

function init() {
	if (!document.getElementById('rh-panel-stocks')) return;
	wireTabs();
	activateTab('stocks');
	const updated = document.getElementById('rh-updated');
	if (updated) {
		updated.hidden = false;
		updated.textContent = `Live data — refreshed on load. Last checked ${new Date().toLocaleTimeString('en-US')}.`;
	}
}

onPageReady(() => init(), { match: (p) => p.replace(/\/$/, '') === '/markets/robinhood' });
