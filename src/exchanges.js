// /exchanges — the top crypto exchanges, part of the three.ws Markets surface.
// A sortable table ranked by CoinGecko trust score / 24h volume, with a small
// colored trust-score badge, a USD volume figure (BTC fallback), country, launch
// year, and a link-out to each venue. Real data via /api/coin/exchanges — never
// mocked. Mirrors the /coins market-table pattern (src/coins-index.js).

import { formatUsd, escapeHtml as esc } from './shared/coin-format.js';

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

// ── Header stat cards ─────────────────────────────────────────────────────────

const ICONS = {
	building:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
	bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
};

function statCard({ label, value, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function renderStats() {
	const el = $('ex-stats');
	if (!state.exchanges.length) {
		el.innerHTML = '';
		return;
	}
	const totalUsd = state.exchanges.reduce((s, e) => s + (e.volume_24h_usd ?? 0), 0);
	const totalBtc = state.exchanges.reduce((s, e) => s + (e.volume_24h_btc ?? 0), 0);
	const volValue =
		state.btcUsd != null && totalUsd > 0
			? formatUsd(totalUsd)
			: `${totalBtc.toLocaleString('en-US', { maximumFractionDigits: 0 })} BTC`;
	const cards = [
		statCard({
			label: 'Exchanges Tracked',
			value: state.exchanges.length.toLocaleString('en-US'),
			icon: 'building',
		}),
		statCard({ label: 'Combined 24h Volume', value: volValue, icon: 'bars' }),
	];
	el.innerHTML = `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${cards.join('')}</div>`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, num: true },
	{ key: 'name', label: 'Exchange', left: true },
	{ key: 'trust_score', label: 'Trust Score', num: true },
	{ key: 'volume', label: '24h Volume', num: true },
	{ key: 'country', label: 'Country', hide: 'hide-md', left: true },
	{ key: 'year_established', label: 'Year', hide: 'hide-lg', num: true },
];

const state = { exchanges: [], btcUsd: null, sortKey: 'rank', sortDir: 'asc' };

function trustBadge(score) {
	if (score == null) return '<span class="ex-trust ex-trust-na">n/a</span>';
	const cls = score >= 8 ? 'ex-trust-hi' : score >= 5 ? 'ex-trust-mid' : 'ex-trust-lo';
	return `<span class="ex-trust ${cls}">${esc(score.toFixed(0))}<span class="of">/10</span></span>`;
}

function volumeCell(e) {
	if (e.volume_24h_usd != null) return esc(formatUsd(e.volume_24h_usd));
	if (e.volume_24h_btc != null) {
		return `${e.volume_24h_btc.toLocaleString('en-US', { maximumFractionDigits: 0 })} BTC`;
	}
	return '—';
}

const LINK_ICON =
	'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

function sortValue(e, key) {
	if (key === 'name') return (e.name || '').toLowerCase();
	if (key === 'country') return (e.country || '￿').toLowerCase(); // blanks sort last
	if (key === 'rank') return e.trust_score_rank ?? Infinity;
	if (key === 'volume') return e.volume_24h_usd ?? e.volume_24h_btc ?? -Infinity;
	if (key === 'trust_score') return e.trust_score ?? -Infinity;
	if (key === 'year_established') return e.year_established ?? -Infinity;
	return 0;
}

function sortedExchanges() {
	const copy = [...state.exchanges];
	const { sortKey, sortDir } = state;
	copy.sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return copy;
}

function renderTable() {
	const el = $('ex-market');
	if (!state.exchanges.length) {
		el.innerHTML =
			'<div class="cv-empty">Exchange data is temporarily unavailable. Please try again shortly.</div>';
		return;
	}

	const head = COLUMNS.map((col) => {
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		return `<th scope="col" tabindex="0" data-key="${col.key}" class="${col.left ? 'left' : ''} ${col.hide || ''}"${active ? ` aria-sort="${state.sortDir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const rows = sortedExchanges()
		.map((e) => {
			// The whole row opens the internal /exchange/:id profile; the
			// external website stays a small secondary ↗ affordance.
			const rowAttrs = e.id
				? ` data-href="/exchange/${encodeURIComponent(e.id)}" tabindex="0" role="link" aria-label="Open ${esc(e.name)} exchange profile"`
				: '';
			return `
			<tr${rowAttrs}>
				<td class="rank cv-mono left">${e.trust_score_rank ?? '—'}</td>
				<td class="left name-cell"><span class="inner">
					${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy" width="24" height="24" data-no-dark-filter />` : ''}
					<span class="nm">${esc(e.name)}</span>
				</span></td>
				<td>${trustBadge(e.trust_score)}</td>
				<td class="price">${volumeCell(e)}</td>
				<td class="left dim hide-md">${esc(e.country || '—')}</td>
				<td class="dim hide-lg cv-mono">${e.year_established ?? '—'}</td>
				<td class="ex-link-cell">${
					e.url
						? `<a href="${esc(e.url)}" class="ex-link" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(e.name)} (opens in a new tab)">${LINK_ICON}</a>`
						: ''
				}</td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table ex-table">
				<thead><tr>${head}<th aria-hidden="true"></th></tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;

	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === state.sortKey) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortKey = key;
				// Text columns default A→Z; numeric columns default high→low.
				state.sortDir =
					key === 'name' || key === 'country' || key === 'rank' ? 'asc' : 'desc';
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

	// Whole row opens the exchange's internal /exchange/:id profile; the website
	// icon link inside stays a real anchor to the external venue. Rows are
	// keyboard-focusable (role=link) so Enter / Space navigate too.
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		const go = () => {
			window.location.assign(tr.dataset.href);
		};
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			go();
		});
		tr.addEventListener('keydown', (e) => {
			if (e.target.closest('a')) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				go();
			}
		});
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function renderSkeleton() {
	$('ex-stats').innerHTML =
		'<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">' +
		Array.from({ length: 2 }, () => '<div class="cv-skel" style="height:6rem"></div>').join(
			'',
		) +
		'</div>';
	$('ex-market').innerHTML =
		'<div class="cv-table-wrap" style="padding:0.75rem">' +
		Array.from(
			{ length: 12 },
			() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
		).join('') +
		'</div>';
}

async function load() {
	renderSkeleton();
	try {
		const data = await getJson('/api/coin/exchanges');
		state.exchanges = Array.isArray(data.exchanges) ? data.exchanges : [];
		state.btcUsd = data.btc_usd ?? null;
		$('ex-updated').textContent =
			`Updated ${new Date(data.updated_at || Date.now()).toLocaleTimeString('en-US')} · source: CoinGecko`;
	} catch {
		state.exchanges = [];
		$('ex-updated').textContent = '';
	}
	renderStats();
	renderTable();
}

load();
