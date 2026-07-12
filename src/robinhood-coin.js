// /markets/robinhood/coin/:address — Robinhood Chain memecoin detail page.
//
// DexScreener market data (price, mcap, FDV, liquidity, volume, pools) +
// Blockscout holders/transfers/contract links, and the real buy panel
// (wallet connect, chain-switch to 4663, live Uniswap v3 quote + swap).
// Non-security token — no eligibility gate.

import { formatUsd, formatPercent, escapeHtml as esc } from './shared/coin-format.js';
import { mountBuyPanel } from './robinhood-purchase.js';

const $ = (id) => document.getElementById(id);
const ADDR_RE = /^\/markets\/robinhood\/coin\/(0x[0-9a-fA-F]{40})\/?$/;

function addressFromPath() {
	const m = location.pathname.match(ADDR_RE);
	return m ? m[1] : null;
}

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

function renderSkeletons() {
	$('rh-head').innerHTML = `
		<div class="ch-hero">
			<div class="cv-skel" style="width:14rem;height:2.5rem"></div>
			<div class="cv-skel" style="width:18rem;height:3rem;margin-top:0.75rem"></div>
		</div>`;
	$('rh-stats').innerHTML = '<div class="cv-stats-grid">' + Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:5rem"></div>').join('') + '</div>';
	$('rh-buy-rail').innerHTML = '<div class="rh-buy-panel"><div class="cv-skel" style="height:200px"></div></div>';
}

function renderHead(c) {
	const symbol = c.symbol || 'Unknown';
	document.getElementById('rh-doc-title').textContent = `${symbol} — Robinhood Chain coin · three.ws`;
	document.getElementById('rh-doc-desc').setAttribute('content', `Live price, liquidity, holders, and a real buy flow for ${c.name || symbol} on Robinhood Chain.`);
	document.getElementById('rh-crumb-symbol').textContent = symbol;

	const pct = c.market?.priceChange?.h24;
	$('rh-head').innerHTML = `
		<div class="ch-hero">
			<div class="ch-title-row">
				${c.iconUrl ? `<img src="${esc(c.iconUrl)}" alt="" width="48" height="48" style="border-radius:50%" data-no-dark-filter />` : ''}
				<h1 class="ch-title">${esc(c.name || symbol)}</h1>
				<span class="cv-rank-badge">${esc(symbol)}</span>
			</div>
			<div class="cv-price-row" style="margin-top:0.75rem">
				<span class="cv-price cv-mono">${esc(formatUsd(c.market?.priceUsd))}</span>
				${pct != null ? `<span class="cv-chip ${pct >= 0 ? 'up' : 'down'}"><span class="win">24h</span>${esc(formatPercent(pct))}</span>` : ''}
			</div>
		</div>`;
}

function renderStats(c) {
	$('rh-stats').innerHTML = `
		<div class="cv-stats-grid">
			<div class="cv-mini-stat"><div class="label">Market Cap</div><div class="value">${esc(formatUsd(c.market?.marketCapUsd))}</div></div>
			<div class="cv-mini-stat"><div class="label">FDV</div><div class="value">${esc(formatUsd(c.market?.fdvUsd))}</div></div>
			<div class="cv-mini-stat"><div class="label">Liquidity</div><div class="value">${esc(formatUsd(c.market?.liquidityUsd))}</div></div>
			<div class="cv-mini-stat"><div class="label">24h Volume</div><div class="value">${esc(formatUsd(c.market?.volume24hUsd))}</div></div>
			<div class="cv-mini-stat"><div class="label">Holders</div><div class="value cv-mono">${c.holdersCount != null ? c.holdersCount.toLocaleString('en-US') : '—'}</div></div>
			<div class="cv-mini-stat"><div class="label">24h Txns</div><div class="value cv-mono">${c.market?.txns24h ? `${(c.market.txns24h.buys || 0) + (c.market.txns24h.sells || 0)}` : '—'}</div></div>
		</div>`;
}

function renderPools(c) {
	const el = $('rh-pools');
	const pools = c.pools || [];
	if (!pools.length) {
		el.innerHTML = '<h2 class="cv-h2">Pools</h2><div class="cv-empty"><p>No live pool found for this token yet.</p></div>';
		return;
	}
	el.innerHTML = `
		<h2 class="cv-h2">Pools</h2>
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr><th class="left">DEX</th><th class="left">Pair</th><th>Price</th><th class="hide-md">Liquidity</th><th class="hide-lg">24h Vol</th></tr></thead>
				<tbody>${pools
					.map(
						(p) => `
					<tr>
						<td class="left">${esc(p.dexId)}</td>
						<td class="left cv-mono">${esc(p.quoteSymbol || '')}</td>
						<td class="cv-mono">${esc(formatUsd(p.priceUsd))}</td>
						<td class="hide-md">${esc(formatUsd(p.liquidityUsd))}</td>
						<td class="hide-lg">${esc(formatUsd(p.volume24hUsd))}</td>
					</tr>`,
					)
					.join('')}</tbody>
			</table>
		</div>`;
}

function renderHolders(c) {
	const el = $('rh-holders');
	const holders = c.holders || [];
	if (!holders.length) {
		el.innerHTML = '<h2 class="cv-h2">Holders</h2><div class="cv-empty"><p>No holder data available.</p></div>';
		return;
	}
	el.innerHTML = `
		<h2 class="cv-h2">Holders</h2>
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr><th class="left">Address</th><th>Balance</th></tr></thead>
				<tbody>${holders
					.map(
						(h) => `
					<tr><td class="left cv-mono">${h.address ? `<a href="https://robinhoodchain.blockscout.com/address/${esc(h.address)}" target="_blank" rel="noopener noreferrer">${esc(h.address.slice(0, 8))}…${esc(h.address.slice(-6))}</a>` : '—'}</td><td class="cv-mono">${h.value ? Number(h.value).toLocaleString('en-US') : '—'}</td></tr>`,
					)
					.join('')}</tbody>
			</table>
		</div>`;
}

function renderTransfers(c) {
	const el = $('rh-transfers');
	const transfers = c.recentTransfers || [];
	if (!transfers.length) {
		el.innerHTML = '<h2 class="cv-h2">Recent Transfers</h2><div class="cv-empty"><p>No recent transfers.</p></div>';
		return;
	}
	el.innerHTML = `
		<h2 class="cv-h2">Recent Transfers</h2>
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr><th class="left">Tx</th><th class="left">From</th><th class="left">To</th></tr></thead>
				<tbody>${transfers
					.map(
						(t) => `
					<tr>
						<td class="left cv-mono">${t.hash ? `<a href="https://robinhoodchain.blockscout.com/tx/${esc(t.hash)}" target="_blank" rel="noopener noreferrer">${esc(t.hash.slice(0, 8))}…</a>` : '—'}</td>
						<td class="left cv-mono">${t.from ? `${esc(t.from.slice(0, 6))}…${esc(t.from.slice(-4))}` : '—'}</td>
						<td class="left cv-mono">${t.to ? `${esc(t.to.slice(0, 6))}…${esc(t.to.slice(-4))}` : '—'}</td>
					</tr>`,
					)
					.join('')}</tbody>
			</table>
		</div>`;
}

function renderLinks(c) {
	$('rh-links').innerHTML = `
		<h2 class="cv-h2">Links</h2>
		<div class="cv-pills">
			<a class="cv-pill" href="${esc(c.links.explorer)}" target="_blank" rel="noopener noreferrer">Contract ↗</a>
			${c.links.dex ? `<a class="cv-pill" href="${esc(c.links.dex)}" target="_blank" rel="noopener noreferrer">DEX Pool ↗</a>` : ''}
		</div>`;
}

function renderNotFound(address) {
	document.getElementById('rh-main').removeAttribute('aria-busy');
	$('rh-head').innerHTML = `<div class="cv-empty"><p>No market or token record found for ${esc(address)}.</p><a class="cv-load-more" href="/markets/robinhood">Back to Robinhood Chain →</a></div>`;
	['rh-pools', 'rh-stats', 'rh-holders', 'rh-transfers', 'rh-links', 'rh-buy-rail'].forEach((id) => {
		const el = $(id);
		if (el) el.innerHTML = '';
	});
}

function renderError(message) {
	document.getElementById('rh-main').removeAttribute('aria-busy');
	$('rh-head').innerHTML = `<div class="cv-empty"><p>${esc(message || 'Failed to load this coin.')}</p><button class="cv-load-more" type="button" id="rh-retry">Retry</button></div>`;
	document.getElementById('rh-retry')?.addEventListener('click', main);
}

async function main() {
	const address = addressFromPath();
	if (!address) return;
	renderSkeletons();
	let c;
	try {
		c = await getJson(`/api/v1/robinhood/coins-detail?address=${encodeURIComponent(address)}`);
	} catch (err) {
		if (err.status === 404) renderNotFound(address);
		else renderError(err.message);
		return;
	}
	document.getElementById('rh-main').removeAttribute('aria-busy');
	renderHead(c);
	renderPools(c);
	renderStats(c);
	renderHolders(c);
	renderTransfers(c);
	renderLinks(c);
	mountBuyPanel($('rh-buy-rail'), { address, symbol: c.symbol, decimals: c.decimals ?? 18 });
}

main();
