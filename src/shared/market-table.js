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
		.map(
			(p, i) =>
				`${((i / (prices.length - 1)) * w).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`,
		)
		.join(' ');
	const up = prices[prices.length - 1] >= prices[0];
	return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:inline-block"><polyline points="${pts}" fill="none" stroke="${up ? 'var(--cv-chart-green)' : 'var(--cv-chart-red)'}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

export function pctCell(v, extraClass = '') {
	if (v == null) return `<td class="pct dim ${extraClass}">—</td>`;
	const up = v >= 0;
	return `<td class="pct ${up ? 'cv-up' : 'cv-down'} ${extraClass}"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${esc(formatPercent(v))}</td>`;
}

/**
 * One market-table row. `sparkline` renders the trailing 7d chart cell; pass
 * false on a table whose header row has no chart column (the /screener table),
 * or the body would carry one more cell than the head declares.
 */
export function coinRow(c, { sparkline: withSparkline = true } = {}) {
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
			${withSparkline ? `<td class="hide-xl">${sparkline(c.sparkline)}</td>` : ''}
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

/**
 * Sortable header cells for a market table. Every column carries aria-sort
 * (the inactive ones as "none") so a screen reader reads the whole row as
 * sortable rather than one column, and the caller binds click/Enter/Space on
 * `th[data-key]`. Shared so /coins and /screener cannot drift apart on the
 * markup a keyboard or screen-reader user depends on.
 */
export function sortableHeaderCells(columns, sortKey, sortDir) {
	return columns
		.map((col) => {
			const active = col.key === sortKey;
			const arrow = active ? (sortDir === 'asc' ? '\u2191' : '\u2193') : '\u2195';
			const sort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
			return `<th scope="col" tabindex="0" data-key="${col.key}" aria-sort="${sort}" class="${col.left ? 'left' : ''} ${col.hide || ''}">${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
		})
		.join('');
}

/**
 * Bind sorting to the header cells of a rendered table. Clicking or pressing
 * Enter/Space on a header sorts by it, and re-activating the active header
 * flips the direction. Text columns open ascending, numeric ones descending,
 * which is the order a reader expects from each.
 */
export function bindSortableHeaders(root, state, rerender) {
	root.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = (viaKeyboard) => {
			const key = th.dataset.key;
			if (key === state.sortKey) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortKey = key;
				state.sortDir = key === 'name' || key === 'rank' ? 'asc' : 'desc';
			}
			rerender();
			// The rerender replaces the header row, so the element that was just
			// activated no longer exists and focus falls back to <body>. A keyboard
			// user would have to tab back in to flip the direction, which makes the
			// second press of a two-press interaction unreachable. Move focus onto
			// the replacement header for the same column.
			if (viaKeyboard) root.querySelector(`th[data-key="${key}"]`)?.focus();
		};
		th.addEventListener('click', () => activate(false));
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate(true);
			}
		});
	});
}

/**
 * Make every rendered row navigate to its coin. The name link inside stays a
 * real anchor so middle-click, keyboard and "open in new tab" keep working;
 * clicking anywhere else on the row follows the same href.
 */
export function bindRowNavigation(root) {
	root.querySelectorAll('tr[data-href]').forEach((tr) => {
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			location.href = tr.dataset.href;
		});
	});
}

// Unranked coins sort last, but the sentinel has to be finite: two of them
// compared as Infinity - Infinity yields NaN, and a comparator that returns NaN
// leaves the engine's sort free to scramble the whole table, not just those two
// rows.
const UNRANKED = Number.MAX_SAFE_INTEGER;

export function coinSortValue(c, key) {
	if (key === 'name') return (c.name || '').toLowerCase();
	if (key === 'rank') return c.rank ?? UNRANKED;
	return c[key] ?? 0;
}
