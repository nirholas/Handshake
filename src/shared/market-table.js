// Shared coin-table primitives for the Markets surfaces (/coins, /markets).
// Pure render helpers — no state, no fetching.

import { formatUsd, formatPrice, formatPercent, escapeHtml as esc } from './coin-format.js';

export function sparkline(prices) {
	if (!prices || prices.length < 2) return '';
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const range = max - min || 1;
	const w = 120;
	const h = 32;
	const pts = prices
		.map((p, i) => `${((i / (prices.length - 1)) * w).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`)
		.join(' ');
	const up = prices[prices.length - 1] >= prices[0];
	return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:inline-block"><polyline points="${pts}" fill="none" stroke="${up ? 'var(--cv-chart-green)' : 'var(--cv-chart-red)'}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

export function pctCell(v, extraClass = '') {
	if (v == null) return `<td class="pct dim ${extraClass}">—</td>`;
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'} ${extraClass}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

export function coinRow(c) {
	const href = `/coin/${encodeURIComponent(c.id)}`;
	return `
		<tr data-href="${esc(href)}">
			<td class="rank hide-sm cv-mono">${c.rank ?? '—'}</td>
			<td class="left name-cell"><a href="${esc(href)}"><span class="inner">
				${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />` : ''}
				<span class="nm">${esc(c.name)}</span>
				<span class="sym">${esc(c.symbol)}</span>
			</span></a></td>
			<td class="price">${esc(formatPrice(c.price))}</td>
			${pctCell(c.change_24h)}
			${pctCell(c.change_7d, 'hide-md')}
			<td class="dim hide-lg">${esc(formatUsd(c.market_cap))}</td>
			<td class="dim hide-lg">${esc(formatUsd(c.volume_24h))}</td>
			<td class="hide-xl">${sparkline(c.sparkline)}</td>
		</tr>`;
}

export const COIN_COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Coin', left: true },
	{ key: 'price', label: 'Price', num: true },
	{ key: 'change_24h', label: '24h %', num: true },
	{ key: 'change_7d', label: '7d %', hide: 'hide-md', num: true },
	{ key: 'market_cap', label: 'Mkt Cap', hide: 'hide-lg', num: true },
	{ key: 'volume_24h', label: 'Vol (24h)', hide: 'hide-lg', num: true },
];

export function coinSortValue(c, key) {
	if (key === 'name') return (c.name || '').toLowerCase();
	if (key === 'rank') return c.rank ?? Infinity;
	return c[key] ?? 0;
}
