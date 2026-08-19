// dashboard-next — Transaction History page.
//
// A single, honest ledger of everything the signed-in user has bought (as a
// buyer) and sold (as a creator) across their agents' skills. Reads the real
// /api/users/me/transaction-history endpoint, which is itself backed by the
// skill_purchases ledger the payment-confirm pipeline writes to — there is no
// separate copy of the data to drift out of sync.
//
// Buyers see what they spent; creators see what they earned (net of platform
// fee). Every settled row links to the transaction on a block explorer.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, ApiError } from '../api.js';
import { errorStateHTML, emptyStateHTML, ensureStateKitStyles } from '../../shared/state-kit.js';
import { skillLabel } from '../../shared/skill-label.js';

const FETCH_LIMIT = 200; // endpoint hard cap; we paginate the rest client-side
const PAGE_SIZE = 25;

const FILTERS = [
	{ key: 'all',    label: 'All' },
	{ key: 'buyer',  label: 'Purchases' },
	{ key: 'seller', label: 'Sales' },
];

let allRows = [];      // every transaction returned this load
let activeFilter = 'all';
let visibleCount = PAGE_SIZE;

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();

		injectStyles();
		main.innerHTML = `
			<div class="tx-head">
				<div>
					<h1 class="dn-h1">Transaction History</h1>
					<p class="dn-h1-sub">Every skill you've purchased and every sale your agents have made, in USDC.</p>
				</div>
				<button class="dn-btn" data-action="export" disabled>Download CSV</button>
			</div>
			<div data-slot="summary" class="tx-summary"></div>
			<div class="dn-panel" style="margin-top:18px">
				<div class="tx-toolbar">
					<div class="tx-tabs" role="tablist" aria-label="Filter transactions">
						${FILTERS.map((f, i) => `
							<button class="tx-tab${i === 0 ? ' is-active' : ''}" type="button" role="tab"
								aria-selected="${i === 0 ? 'true' : 'false'}" tabindex="${i === 0 ? '0' : '-1'}"
								data-filter="${f.key}">${esc(f.label)}</button>
						`).join('')}
					</div>
					<div class="tx-toolbar-meta" data-slot="meta" role="status" aria-live="polite"></div>
				</div>
				<div data-slot="body"></div>
			</div>
		`;

		wireTabs(main);
		main.querySelector('[data-action="export"]').addEventListener('click', exportCsv);

		await load(main);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			const ret = encodeURIComponent(location.pathname + location.search);
			location.href = `/login?return=${ret}`;
			return;
		}
		throw err;
	}
})();

// ── Data ────────────────────────────────────────────────────────────────────

async function load(main) {
	const body = main.querySelector('[data-slot="body"]');
	const summary = main.querySelector('[data-slot="summary"]');
	const exportBtn = main.querySelector('[data-action="export"]');

	body.innerHTML = skeletonRows();
	summary.innerHTML = summarySkeleton();

	let data;
	try {
		data = await get(`/api/users/me/transaction-history?role=all&limit=${FETCH_LIMIT}`);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) throw err;
		ensureStateKitStyles();
		summary.innerHTML = '';
		body.innerHTML = errorStateHTML({
			title: "Couldn't load your transactions",
			body: 'We had trouble reaching the ledger. Check your connection and try again.',
		});
		body.querySelector('[data-sk-retry]')?.addEventListener('click', () => load(main));
		return;
	}

	allRows = Array.isArray(data?.transactions) ? data.transactions : [];
	visibleCount = PAGE_SIZE;
	exportBtn.disabled = allRows.length === 0;

	renderSummary(summary);
	renderBody(main);
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function renderSummary(host) {
	const buyer = allRows.filter((r) => r.role === 'buyer');
	const seller = allRows.filter((r) => r.role === 'seller');

	const spent = buyer.reduce((s, r) => s + numUnits(r.amount_display), 0);
	const earned = seller.reduce((s, r) => s + numUnits(r.net_display), 0);

	host.innerHTML = [
		statCard('Total spent', usd(spent), `${buyer.length} purchase${buyer.length === 1 ? '' : 's'}`, 'var(--nxt-ink)'),
		statCard('Net earned', usd(earned), `${seller.length} sale${seller.length === 1 ? '' : 's'}`, 'var(--nxt-success)'),
		statCard('Transactions', String(allRows.length), allRows.length >= FETCH_LIMIT ? 'Most recent 200 shown' : 'All time', 'var(--nxt-accent)'),
	].join('');
}

function statCard(title, value, sub, color) {
	return `
		<div class="dn-panel tx-stat">
			<div class="dn-panel-title">${esc(title)}</div>
			<div class="tx-stat-value" style="color:${color}">${esc(value)}</div>
			<div class="dn-panel-sub">${esc(sub)}</div>
		</div>`;
}

// ── Table body ────────────────────────────────────────────────────────────────

function renderBody(main) {
	const body = main.querySelector('[data-slot="body"]');
	const meta = main.querySelector('[data-slot="meta"]');
	const rows = filteredRows();

	meta.textContent = rows.length
		? `${Math.min(visibleCount, rows.length)} of ${rows.length}`
		: '';

	if (!rows.length) {
		ensureStateKitStyles();
		body.innerHTML = emptyStateHTML({
			title: activeFilter === 'seller' ? 'No sales yet' : activeFilter === 'buyer' ? 'No purchases yet' : 'No transactions yet',
			body: activeFilter === 'seller'
				? 'When someone unlocks one of your agents&#39; paid skills, the sale shows up here.'
				: activeFilter === 'buyer'
					? 'Skills you unlock from other agents will appear here with a receipt and explorer link.'
					: 'Buy a skill or sell one of yours and it&#39;ll be recorded here — with a link to the on-chain transaction.',
			actions: activeFilter === 'seller'
				? [{ label: 'Set skill prices', href: '/dashboard/monetize', primary: true }]
				: [{ label: 'Browse the marketplace', href: '/marketplace', primary: true }],
		});
		return;
	}

	const slice = rows.slice(0, visibleCount);
	body.innerHTML = `
		<div class="tx-scroll">
			<table class="tx-table" aria-label="Transaction history">
				<thead>
					<tr>
						<th scope="col">Date</th>
						<th scope="col">Type</th>
						<th scope="col">Details</th>
						<th scope="col" style="text-align:right">Amount</th>
						<th scope="col">Status</th>
						<th scope="col">Tx</th>
					</tr>
				</thead>
				<tbody>${slice.map(rowHtml).join('')}</tbody>
			</table>
		</div>
		${rows.length > visibleCount
			? `<div class="tx-more"><button class="dn-btn" data-action="more">Show more · ${rows.length - visibleCount} remaining</button></div>`
			: ''}
	`;

	body.querySelector('[data-action="more"]')?.addEventListener('click', () => {
		visibleCount += PAGE_SIZE;
		renderBody(main);
	});
}

function rowHtml(r) {
	const when = r.confirmed_at || r.created_at;
	const isSale = r.role === 'seller';

	const typeTag = isSale
		? '<span class="dn-tag success">Sale</span>'
		: '<span class="dn-tag" style="border-color:var(--nxt-accent);color:var(--nxt-accent)">Purchase</span>';

	const agentName = r.agent_name ? esc(r.agent_name) : 'Unknown agent';
	const agentCell = r.agent_id && r.agent_name
		? `<a class="tx-agent" href="/agents/${encodeURIComponent(r.agent_id)}">${agentName}</a>`
		: `<span class="tx-agent tx-agent--muted">${agentName}</span>`;

	// Buyer pays out (−), seller takes home (+). Sellers also see gross + fee.
	const amountCell = isSale
		? `<div class="tx-amt tx-amt--in">+${esc(usd(numUnits(r.net_display)))}</div>
		   ${r.platform_fee_display ? `<div class="tx-amt-sub">gross ${esc(usd(numUnits(r.amount_display)))} · fee ${esc(usd(numUnits(r.platform_fee_display)))}</div>` : ''}`
		: `<div class="tx-amt">−${esc(usd(numUnits(r.amount_display)))}</div>`;

	return `
		<tr>
			<td class="tx-when">
				<div>${esc(formatDate(when))}</div>
				<div class="tx-when-rel">${esc(relTime(when))}</div>
			</td>
			<td>${typeTag}</td>
			<td>
				<div class="tx-skill">${esc(skillLabel(r.skill))}</div>
				<div class="tx-sub">${agentCell}${r.skill_nft_mint ? ' · <span class="tx-nft">NFT</span>' : ''}</div>
			</td>
			<td style="text-align:right;white-space:nowrap">${amountCell}</td>
			<td>${statusTag(r)}</td>
			<td>${txCell(r)}</td>
		</tr>`;
}

function statusTag(r) {
	if (r.kind === 'trial' || r.status === 'trial') return '<span class="dn-tag">Trial</span>';
	if (r.status === 'tipped') {
		return `<span class="dn-tag warn" title="Settled for a different amount than quoted — the amount shown is what moved on-chain">Adjusted</span>`;
	}
	return '<span class="dn-tag success">Settled</span>';
}

function txCell(r) {
	if (!r.explorer_url || !r.tx_signature) {
		return '<span class="tx-muted">—</span>';
	}
	const short = `${String(r.tx_signature).slice(0, 6)}…${String(r.tx_signature).slice(-4)}`;
	return `<a class="tx-link" href="${esc(r.explorer_url)}" target="_blank" rel="noopener" title="View on block explorer">${esc(short)} ↗</a>`;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function wireTabs(main) {
	const tabs = [...main.querySelectorAll('[data-filter]')];

	const select = (btn, { focus = false } = {}) => {
		if (focus) btn.focus();
		if (activeFilter === btn.dataset.filter) return;
		activeFilter = btn.dataset.filter;
		visibleCount = PAGE_SIZE;
		tabs.forEach((b) => {
			const on = b.dataset.filter === activeFilter;
			b.classList.toggle('is-active', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			b.tabIndex = on ? 0 : -1;
		});
		renderBody(main);
	};

	tabs.forEach((btn, i) => {
		btn.addEventListener('click', () => select(btn));
		// Roving-tabindex arrow-key navigation, per WAI-ARIA tablist pattern.
		btn.addEventListener('keydown', (e) => {
			let next = null;
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
			else if (e.key === 'Home') next = tabs[0];
			else if (e.key === 'End') next = tabs[tabs.length - 1];
			if (!next) return;
			e.preventDefault();
			select(next, { focus: true });
		});
	});
}

function filteredRows() {
	if (activeFilter === 'all') return allRows;
	return allRows.filter((r) => r.role === activeFilter);
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCsv() {
	const rows = filteredRows();
	if (!rows.length) return;

	const header = ['Date', 'Type', 'Skill', 'Agent', 'Amount (USDC)', 'Platform fee (USDC)', 'Status', 'Chain', 'Signature', 'Explorer'];
	const lines = rows.map((r) => [
		(r.confirmed_at || r.created_at || ''),
		r.role === 'seller' ? 'Sale' : 'Purchase',
		r.skill || '',
		r.agent_name || '',
		r.role === 'seller' ? (r.net_display ?? r.amount_display ?? '') : (r.amount_display ?? ''),
		r.platform_fee_display ?? '',
		r.kind === 'trial' || r.status === 'trial' ? 'Trial' : r.status === 'tipped' ? 'Adjusted' : 'Settled',
		r.chain || '',
		r.tx_signature || '',
		r.explorer_url || '',
	].map(csvCell).join(','));

	const csv = [header.map(csvCell).join(','), ...lines].join('\r\n');
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `three-ws-transactions-${activeFilter}.csv`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(v) {
	const s = String(v ?? '');
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function numUnits(displayStr) {
	const n = parseFloat(displayStr);
	return Number.isFinite(n) ? n : 0;
}

function usd(n) {
	return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(iso) {
	const d = new Date(iso);
	if (isNaN(d)) return '—';
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function summarySkeleton() {
	return Array.from({ length: 3 }).map(() => `
		<div class="dn-panel tx-stat">
			<div class="dn-skeleton" style="height:12px;width:55%;margin-bottom:12px"></div>
			<div class="dn-skeleton" style="height:28px;width:70%;margin-bottom:8px"></div>
			<div class="dn-skeleton" style="height:11px;width:45%"></div>
		</div>`).join('');
}

function skeletonRows() {
	return `
		<div class="tx-scroll" aria-hidden="true">
			<table class="tx-table">
				<tbody>
					${Array.from({ length: 6 }).map(() => `
						<tr>
							<td><div class="dn-skeleton" style="height:12px;width:80px"></div></td>
							<td><div class="dn-skeleton" style="height:18px;width:64px;border-radius:999px"></div></td>
							<td><div class="dn-skeleton" style="height:12px;width:60%;margin-bottom:6px"></div><div class="dn-skeleton" style="height:10px;width:40%"></div></td>
							<td><div class="dn-skeleton" style="height:12px;width:70px;margin-left:auto"></div></td>
							<td><div class="dn-skeleton" style="height:18px;width:60px;border-radius:999px"></div></td>
							<td><div class="dn-skeleton" style="height:12px;width:72px"></div></td>
						</tr>`).join('')}
				</tbody>
			</table>
		</div>`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('tx-styles')) return;
	const style = document.createElement('style');
	style.id = 'tx-styles';
	style.textContent = `
.tx-head {
	display:flex; align-items:flex-start; justify-content:space-between;
	gap:16px; flex-wrap:wrap; margin-bottom:6px;
}
.tx-summary {
	display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin-top:14px;
}
.tx-stat { padding:16px 18px; }
.tx-stat-value {
	font-size:26px; font-weight:700; letter-spacing:-0.02em;
	margin:6px 0 4px; font-variant-numeric:tabular-nums;
}
.tx-toolbar {
	display:flex; align-items:center; justify-content:space-between;
	gap:12px; flex-wrap:wrap; margin-bottom:12px;
}
.tx-tabs { display:inline-flex; gap:4px; background:rgba(255,255,255,0.04); padding:3px; border-radius:10px; }
.tx-tab {
	appearance:none; border:0; background:transparent; cursor:pointer;
	padding:6px 14px; border-radius:8px; font:inherit; font-size:13px;
	color:var(--nxt-ink-dim); transition:background 0.15s, color 0.15s;
}
.tx-tab:hover { color:var(--nxt-ink); }
.tx-tab.is-active { background:var(--nxt-accent-soft,rgba(255,255,255,0.1)); color:var(--nxt-ink); font-weight:600; }
.tx-tab:focus-visible { outline:2px solid var(--nxt-accent); outline-offset:2px; }
.tx-toolbar-meta { font-size:12px; color:var(--nxt-ink-fade); font-variant-numeric:tabular-nums; }

.tx-scroll { overflow-x:auto; }
.tx-table { width:100%; border-collapse:collapse; font-size:13px; min-width:640px; }
.tx-table th {
	text-align:left; font-weight:500; color:var(--nxt-ink-fade);
	font-size:11px; text-transform:uppercase; letter-spacing:0.06em;
	padding:8px 10px; border-bottom:1px solid var(--nxt-stroke);
}
.tx-table td { padding:11px 10px; border-bottom:1px solid var(--nxt-stroke); vertical-align:top; }
.tx-table tbody tr { transition:background 0.1s; }
.tx-table tbody tr:hover { background:rgba(255,255,255,0.02); }

.tx-when { white-space:nowrap; }
.tx-when-rel { font-size:11.5px; color:var(--nxt-ink-fade); margin-top:2px; }
.tx-skill { font-weight:600; color:var(--nxt-ink); }
.tx-sub { font-size:12px; color:var(--nxt-ink-fade); margin-top:2px; }
.tx-agent { color:var(--nxt-ink-dim); text-decoration:none; }
.tx-agent:hover { color:var(--nxt-accent); text-decoration:underline; }
.tx-agent--muted { color:var(--nxt-ink-fade); }
.tx-nft {
	display:inline-block; font-size:10px; font-weight:600; letter-spacing:0.04em;
	color:var(--nxt-accent); border:1px solid var(--nxt-accent); border-radius:4px; padding:0 4px;
}
.tx-amt { font-variant-numeric:tabular-nums; font-weight:600; }
.tx-amt--in { color:var(--nxt-success); }
.tx-amt-sub { font-size:11px; color:var(--nxt-ink-fade); margin-top:2px; font-variant-numeric:tabular-nums; }
.tx-link { color:var(--nxt-accent); text-decoration:none; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; white-space:nowrap; }
.tx-link:hover { text-decoration:underline; }
.tx-muted { color:var(--nxt-ink-fade); }

.tx-more { margin-top:14px; text-align:center; }

@media (max-width:640px) {
	.tx-table { min-width:560px; }
	.tx-stat-value { font-size:22px; }
}
`;
	document.head.appendChild(style);
}
