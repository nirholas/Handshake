// /chains — cross-chain TVL leaderboard. Header stat cards (total TVL, chain
// count, top-chain dominance), and a sortable table of chains by TVL with an
// inline dominance bar. Data comes from /api/defi/chains (DeFiLlama, keyless),
// normalized server-side. Mirrors the /coins markets-table pattern: stat cards,
// sortable cv-table, designed loading / empty / error states.

import { formatUsd, escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);

// A press that travels further than this is a drag, not a click on a row.
const DRAG_SLOP_PX = 6;

// True while the visitor is holding a text selection, so row-click navigation
// can stand down and let them copy.
function isSelecting() {
	const sel = typeof getSelection === 'function' ? getSelection() : null;
	return !!sel && !sel.isCollapsed && String(sel).trim().length > 0;
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

// ── Stat cards ────────────────────────────────────────────────────────────

const ICONS = {
	lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
	link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
	pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
};

function statCard({ label, value, delta, icon }) {
	return `
		<div class="cv-stat-card">
			<div style="min-width:0">
				<p class="label">${esc(label)}</p>
				<p class="value cv-mono">${esc(value)}</p>
				${delta ? `<p class="delta">${esc(delta)}</p>` : ''}
			</div>
			<span class="icon" aria-hidden="true">${ICONS[icon] || ''}</span>
		</div>`;
}

function renderStats() {
	const el = $('chains-stats');
	const top = state.chains[0];
	const cards = [
		statCard({
			label: 'Total Cross-Chain TVL',
			value: formatUsd(state.total_tvl),
			icon: 'lock',
		}),
		statCard({
			label: 'Chains Tracked',
			value: state.chain_count.toLocaleString('en-US'),
			icon: 'link',
		}),
	];
	if (top) {
		cards.push(
			statCard({
				label: `${top.name} Dominance`,
				value: `${top.share_pct.toFixed(1)}%`,
				delta: formatUsd(top.tvl),
				icon: 'pie',
			}),
		);
	}
	el.innerHTML = `<div class="chains-stat-grid">${cards.join('')}</div>`;
}

function statsSkeleton() {
	$('chains-stats').innerHTML =
		'<div class="chains-stat-grid">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:6rem"></div>').join(
			'',
		) +
		'</div>';
}

// ── Table ─────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ key: 'rank', label: '#', left: true, hide: 'hide-sm', num: true },
	{ key: 'name', label: 'Chain', left: true },
	{ key: 'tvl', label: 'TVL', num: true },
	{ key: 'share_pct', label: 'Dominance', num: true },
	{ key: 'bar', label: 'Share', left: true, hide: 'hide-md', sortless: true },
];

const state = {
	chains: [],
	total_tvl: 0,
	chain_count: 0,
	updated_at: 0,
	sortKey: 'tvl',
	sortDir: 'desc',
	loading: true,
	error: false,
};

function sortValue(c, key) {
	if (key === 'name') return (c.name || '').toLowerCase();
	if (key === 'rank') return c.__rank ?? Infinity;
	return c[key] ?? -Infinity;
}

function sortedChains() {
	const ranked = [...state.chains].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
	ranked.forEach((c, i) => (c.__rank = i + 1));
	const { sortKey, sortDir } = state;
	const sorted = [...ranked].sort((a, b) => {
		const va = sortValue(a, sortKey);
		const vb = sortValue(b, sortKey);
		const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
		return sortDir === 'asc' ? cmp : -cmp;
	});
	return sorted;
}

function renderTable() {
	const el = $('chains-table');

	if (state.loading) {
		el.innerHTML =
			'<div class="cv-table-wrap" style="padding:0.75rem">' +
			Array.from(
				{ length: 12 },
				() => '<div class="cv-skel" style="height:2.5rem;margin:0.375rem 0"></div>',
			).join('') +
			'</div>';
		return;
	}
	if (state.error) {
		el.innerHTML =
			'<div class="cv-empty">Chain TVL data is temporarily unavailable. The upstream provider did not answer. <button type="button" class="cv-linkbtn" data-act="retry">Try again</button>.</div>';
		el.querySelector('[data-act="retry"]')?.addEventListener('click', () => load());
		return;
	}
	if (!state.chains.length) {
		el.innerHTML =
			'<div class="cv-empty">No chain TVL is being reported right now. <button type="button" class="cv-linkbtn" data-act="retry">Refresh</button> to check again.</div>';
		el.querySelector('[data-act="retry"]')?.addEventListener('click', () => load());
		return;
	}

	// The dominance bar scales to the leader so the top chain fills the cell and
	// the rest read as a fraction of it — a clearer visual than raw share %.
	const maxShare = Math.max(...state.chains.map((c) => c.share_pct || 0), 0.0001);

	const head = COLUMNS.map((col) => {
		if (col.sortless) {
			return `<th scope="col" class="${col.left ? 'left' : ''} ${col.hide || ''}">${esc(col.label)}</th>`;
		}
		const active = col.key === state.sortKey;
		const arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
		const sort = active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
		return `<th scope="col" tabindex="0" data-key="${col.key}" aria-sort="${sort}" class="${col.left ? 'left' : ''} ${col.hide || ''}">${esc(col.label)}<span class="arrow" aria-hidden="true">${arrow}</span></th>`;
	}).join('');

	const body = sortedChains()
		.map((c) => {
			const barPct = Math.max(2, ((c.share_pct || 0) / maxShare) * 100);
			// The chain name is a real anchor so the /chain/:name detail page is
			// crawlable, middle-clickable, and reachable by keyboard as a link. The
			// row keeps data-href purely as a click convenience, which is why the
			// <tr> stays a plain table row instead of claiming role="link".
			const href = c.name ? `/chain/${encodeURIComponent(c.name)}` : '';
			const inner = `<span class="inner">
					<span class="nm">${esc(c.name)}</span>
					${c.token_symbol ? `<span class="sym">${esc(c.token_symbol)}</span>` : ''}
				</span>`;
			return `
			<tr${href ? ` data-href="${esc(href)}"` : ''}>
				<td class="rank hide-sm cv-mono">${c.__rank}</td>
				<td class="left name-cell">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</td>
				<td class="price">${esc(formatUsd(c.tvl))}</td>
				<td class="pct cv-mono">${(c.share_pct || 0).toFixed(2)}%</td>
				<td class="left hide-md chains-bar-cell">
					<span class="chains-bar" aria-hidden="true">
						<span class="chains-bar-fill" style="width:${barPct.toFixed(1)}%"></span>
					</span>
				</td>
			</tr>`;
		})
		.join('');

	el.innerHTML = `
		<div class="cv-table-wrap">
			<table class="cv-table">
				<thead><tr>${head}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;

	el.querySelectorAll('th[data-key]').forEach((th) => {
		const activate = () => {
			const key = th.dataset.key;
			if (key === state.sortKey) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortKey = key;
				state.sortDir = key === 'name' ? 'asc' : 'desc';
			}
			renderTable();
			// The header this came from is a fresh node after the re-render, so
			// keyboard users would otherwise be dropped back to the document.
			$('chains-table')?.querySelector(`th[data-key="${key}"]`)?.focus();
		};
		th.addEventListener('click', activate);
		th.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				activate();
			}
		});
	});

	// Clicking anywhere in the row follows the name cell's link. The anchor
	// handles its own click (and the whole keyboard path), so bail out on it
	// rather than navigating twice.
	el.querySelectorAll('tr[data-href]').forEach((tr) => {
		// Where the press started, so a drag that merely ends inside the row is
		// not mistaken for a click on it.
		let downX = 0;
		let downY = 0;
		tr.addEventListener('pointerdown', (e) => {
			downX = e.clientX;
			downY = e.clientY;
		});
		tr.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			// Copying a TVL figure or a chain name means dragging across a cell,
			// and that drag ends in a click on the row. Navigating would throw
			// the selection away before the visitor can copy it.
			if (isSelecting()) return;
			if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP_PX) return;
			location.assign(tr.dataset.href);
		});
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function load() {
	// A retry re-enters here from the error state, so reset to loading before
	// painting or the skeleton would be replaced by the stale error message.
	state.loading = true;
	state.error = false;
	statsSkeleton();
	renderTable();
	try {
		const data = await getJson('/api/defi/chains');
		state.chains = Array.isArray(data.chains) ? data.chains : [];
		state.total_tvl = data.total_tvl || 0;
		state.chain_count = data.chain_count || state.chains.length;
		state.updated_at = data.updated_at || Date.now();
		state.loading = false;
		state.error = false;
		// An empty payload has no totals worth showing: a "$0.00" card would read
		// as a claim that cross-chain TVL is zero rather than as missing data.
		if (state.chains.length) {
			renderStats();
			$('chains-updated').textContent =
				`Top ${state.chains.length} chains by TVL · Data: DeFiLlama · updated ${new Date(state.updated_at).toLocaleTimeString('en-US')}`;
		} else {
			$('chains-stats').innerHTML = '';
			$('chains-updated').textContent = '';
		}
		renderTable();
	} catch {
		state.loading = false;
		state.error = true;
		state.chains = [];
		$('chains-stats').innerHTML = '';
		$('chains-updated').textContent = 'Data: DeFiLlama';
		renderTable();
	}
}

load();
