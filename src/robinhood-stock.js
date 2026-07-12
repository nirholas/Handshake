// /markets/robinhood/stock/:symbol — Robinhood Chain Stock Token detail page.
//
// Chainlink NAV (current + recent round history chart), all DEX pairs,
// premium/discount, uiMultiplier, holders + recent transfers (Blockscout),
// contract links. Display-only — buy rail is an eligibility-gated outbound
// "Trade on DEX" link (Stock Tokens are tokenized debt securities, see the
// legal line in _shared.md; the acquisition gate never lives here, only the
// disclosure does).

import { formatUsd, escapeHtml as esc } from './shared/coin-format.js';
import { mountStockEligibilityGate } from './robinhood-purchase.js';

const $ = (id) => document.getElementById(id);

function symbolFromPath() {
	const m = location.pathname.match(/^\/markets\/robinhood\/stock\/([A-Za-z0-9.-]{1,10})\/?$/);
	return m ? m[1].toUpperCase() : null;
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

function fmtNav(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function premiumChip(pct) {
	if (pct == null || !Number.isFinite(pct)) return '<span class="rh-premium flat">—</span>';
	const cls = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'pos' : 'neg';
	return `<span class="rh-premium ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
}

function renderSkeletons() {
	$('rh-head').innerHTML = `
		<div class="ch-hero">
			<div class="cv-skel" style="width:14rem;height:2.5rem"></div>
			<div class="cv-skel" style="width:18rem;height:3rem;margin-top:0.75rem"></div>
		</div>`;
	$('rh-chart').innerHTML = '<div class="cv-chart-panel"><div class="cv-skel" style="height:240px;border-radius:8px"></div></div>';
	$('rh-stats').innerHTML = '<div class="cv-stats-grid">' + Array.from({ length: 6 }, () => '<div class="cv-skel" style="height:5rem"></div>').join('') + '</div>';
}

function renderHead(s) {
	document.getElementById('rh-doc-title').textContent = `${s.symbol} — Robinhood Chain Stock Token · three.ws`;
	document.getElementById('rh-doc-desc').setAttribute('content', `Live Chainlink NAV, DEX premium/discount, holders, and contract links for ${s.name} (${s.symbol}) on Robinhood Chain.`);
	document.getElementById('rh-crumb-symbol').textContent = s.symbol;

	$('rh-head').innerHTML = `
		<div class="ch-hero">
			<div class="ch-title-row">
				${s.iconUrl ? `<img src="${esc(s.iconUrl)}" alt="" width="48" height="48" style="border-radius:50%" data-no-dark-filter />` : ''}
				<h1 class="ch-title">${esc(s.name.replace(' • Robinhood Token', ''))}</h1>
				<span class="cv-rank-badge">${esc(s.symbol)}</span>
			</div>
			<div class="cv-price-row" style="margin-top:0.75rem">
				<span class="cv-price cv-mono">${fmtNav(s.nav.priceUsd)}</span>
				<span style="color:var(--cv-text-3);font-size:0.875rem">NAV (Chainlink)</span>
				${premiumChip(s.dex.premiumPct)}
			</div>
		</div>`;
}

function renderChart(s) {
	const el = $('rh-chart');
	const points = (s.nav.history || []).map((p) => p.priceUsd);
	if (points.length < 2) {
		el.innerHTML = '<div class="cv-empty"><p>No NAV history available yet.</p></div>';
		return;
	}
	const min = Math.min(...points);
	const max = Math.max(...points);
	const range = max - min || 1;
	const w = 800;
	const h = 240;
	const path = points.map((v, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
	el.innerHTML = `
		<div class="cv-chart-panel">
			<div class="cv-chart-bar"><span class="title">Chainlink NAV — recent rounds</span></div>
			<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" aria-label="NAV price history"><polyline points="${path}" fill="none" stroke="var(--cv-chart-green)" stroke-width="2"/></svg>
		</div>`;
}

function renderStats(s) {
	const mult = s.uiMultiplier ? Number(s.uiMultiplier) / 1e18 : null;
	$('rh-stats').innerHTML = `
		<div class="cv-stats-grid">
			<div class="cv-mini-stat"><div class="label">DEX Price</div><div class="value">${s.dex.priceUsd != null ? fmtNav(s.dex.priceUsd) : '—'}</div></div>
			<div class="cv-mini-stat"><div class="label">Premium / Discount</div><div class="value">${premiumChip(s.dex.premiumPct)}</div></div>
			<div class="cv-mini-stat"><div class="label">uiMultiplier</div><div class="value cv-mono">${mult != null ? mult.toFixed(4) : '—'}</div></div>
			<div class="cv-mini-stat"><div class="label">Holders</div><div class="value cv-mono">${s.holdersCount != null ? s.holdersCount.toLocaleString('en-US') : '—'}</div></div>
			<div class="cv-mini-stat"><div class="label">Circulating Mkt Cap</div><div class="value">${esc(formatUsd(s.circulatingMarketCapUsd))}</div></div>
			<div class="cv-mini-stat"><div class="label">Feed Updated</div><div class="value">${s.nav.updatedAt ? new Date(s.nav.updatedAt * 1000).toLocaleString('en-US') : '—'}</div></div>
		</div>`;
}

function renderHolders(s) {
	const el = $('rh-holders');
	const holders = s.holders || [];
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

function renderTransfers(s) {
	const el = $('rh-transfers');
	const transfers = s.recentTransfers || [];
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

function renderLinks(s) {
	$('rh-links').innerHTML = `
		<h2 class="cv-h2">Links</h2>
		<div class="cv-pills">
			<a class="cv-pill" href="${esc(s.links.explorer)}" target="_blank" rel="noopener noreferrer">Contract ↗</a>
			${s.links.feed ? `<a class="cv-pill" href="${esc(s.links.feed)}" target="_blank" rel="noopener noreferrer">Chainlink Feed ↗</a>` : ''}
			${s.links.dex ? `<a class="cv-pill" href="${esc(s.links.dex)}" target="_blank" rel="noopener noreferrer">DEX Pool ↗</a>` : ''}
		</div>`;
}

function renderNotFound(symbol) {
	document.getElementById('rh-main').removeAttribute('aria-busy');
	$('rh-head').innerHTML = `<div class="cv-empty"><p>No Stock Token found for symbol "${esc(symbol)}".</p><a class="cv-load-more" href="/markets/robinhood">Back to Robinhood Chain →</a></div>`;
	['rh-chart', 'rh-stats', 'rh-holders', 'rh-transfers', 'rh-links', 'rh-buy-rail'].forEach((id) => {
		const el = $(id);
		if (el) el.innerHTML = '';
	});
}

function renderError(message) {
	document.getElementById('rh-main').removeAttribute('aria-busy');
	$('rh-head').innerHTML = `<div class="cv-empty"><p>${esc(message || 'Failed to load this Stock Token.')}</p><button class="cv-load-more" type="button" id="rh-retry">Retry</button></div>`;
	document.getElementById('rh-retry')?.addEventListener('click', main);
}

async function main() {
	const symbol = symbolFromPath();
	if (!symbol) return;
	renderSkeletons();
	let s;
	try {
		s = await getJson(`/api/v1/robinhood/stocks-detail?symbol=${encodeURIComponent(symbol)}`);
	} catch (err) {
		if (err.status === 404) renderNotFound(symbol);
		else renderError(err.message);
		return;
	}
	document.getElementById('rh-main').removeAttribute('aria-busy');
	renderHead(s);
	renderChart(s);
	renderStats(s);
	renderHolders(s);
	renderTransfers(s);
	renderLinks(s);
	mountStockEligibilityGate($('rh-buy-rail'), { symbol: s.symbol, dexUrl: s.links.dex });
}

main();
