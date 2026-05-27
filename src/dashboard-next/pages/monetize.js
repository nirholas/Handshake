// dashboard-next — Monetize page.
//
// Consolidates revenue, payments, subscriptions, plan & usage, withdrawals,
// and token royalties into a single creator money hub. All data sourced
// from real /api/* endpoints — no mocks.

import { mountShell } from '../shell.js';
import { requireUser, get, post, put, del, esc, relTime, formatUsdc, ApiError } from '../api.js';

const USDC_MINTS = {
	solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const MIN_WITHDRAWAL_USDC_ATOMICS = 1_000_000; // 1 USDC

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const RANGES = [
	{ key: '7d',  days: 7,   label: 'Last 7 days',  granularity: 'day' },
	{ key: '30d', days: 30,  label: 'Last 30 days', granularity: 'day' },
	{ key: '90d', days: 90,  label: 'Last 90 days', granularity: 'day' },
	{ key: '1y',  days: 365, label: 'Last 12 months', granularity: 'week' },
];

const PAYMENT_FILTERS = [
	{ key: 'all',           label: 'All' },
	{ key: 'subscriptions', label: 'Subscriptions' },
	{ key: 'api',           label: 'API' },
	{ key: 'skills',        label: 'Skills' },
	{ key: 'tips',          label: 'Tips' },
];

(async function boot() {
	try {
		const main = await mountShell();
		const me = await requireUser();

		main.innerHTML = `
			<h1 class="dn-h1">Money</h1>
			<p class="dn-h1-sub">Where your agents earn — and where it goes.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:18px"></div>
		`;
		const host = main.querySelector('[data-slot="content"]');
		renderSkeleton(host);
		await loadAndRender(host, me);
	} catch (err) {
		// Session expired mid-load — bounce to login the same way requireUser would.
		if (err instanceof ApiError && err.status === 401) {
			const ret = encodeURIComponent(location.pathname + location.search);
			location.href = `/login?return=${ret}`;
			return;
		}
		throw err;
	}
})();

// ── Data loading ───────────────────────────────────────────────────────────

async function loadAndRender(host, me) {
	const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const creatorParam = me.id && UUID_RE.test(me.id) ? encodeURIComponent(me.id) : null;

	const [revenue, withdrawalsResp, walletsResp, summary, plans, mineSubs, agentsResp, earningsResp] =
		await Promise.all([
			safe(() =>
				get(`/api/billing/revenue?from=${encodeURIComponent(since30)}&granularity=day`),
			),
			safe(() => get('/api/billing/withdrawals?limit=50')),
			safe(() => get('/api/billing/payout-wallets')),
			safe(() => get('/api/billing/summary')),
			creatorParam
				? safe(() => get(`/api/subscriptions/plans?creator_id=${creatorParam}`))
				: Promise.resolve(null),
			safe(() => get('/api/subscriptions/mine')),
			safe(() => get('/api/agents')),
			safe(() => get('/api/users/me/earnings')),
		]);

	const withdrawals = withdrawalsResp?.withdrawals || [];
	const wallets = walletsResp?.wallets || [];
	const agents = agentsResp?.agents || [];
	const creatorPlans = plans?.plans || [];
	const subscribedTo = mineSubs?.subscriptions || [];

	// Compute available to withdraw: net revenue + pending royalties − inflight withdrawals.
	const earned = Number(revenue?.summary?.net_total ?? 0);
	const inflight = withdrawals
		.filter((w) => w.status === 'pending' || w.status === 'processing')
		.reduce((s, w) => s + Number(w.amount), 0);
	const pendingRoyaltyUsd = Number(earningsResp?.pending_usd ?? 0);
	const pendingRoyaltyAtomics = Math.round(pendingRoyaltyUsd * 1_000_000);
	const available = Math.max(0, earned + pendingRoyaltyAtomics - inflight);

	// Pull recent payments across the user's agents (received side).
	const payments = await fetchRecentPayments(agents);

	host.innerHTML = '';
	host.appendChild(renderHero({ available, revenue, creatorPlans, subscribedTo, pendingRoyaltyAtomics }));
	host.appendChild(renderRevenueChart({ initial: revenue, defaultRange: '30d' }));
	host.appendChild(renderPaymentsPanel(payments));
	host.appendChild(renderSubscriptionPlans({ creatorPlans, me }));
	host.appendChild(renderWithdrawals({ withdrawals, wallets, available, host, me }));
	host.appendChild(renderPayoutWallets({ wallets, host, me }));
	host.appendChild(renderPlanUsage(summary));
	host.appendChild(renderTokensPanel(agents));
}

async function safe(fn) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) throw err;
		return null;
	}
}

// ── Hero metrics ───────────────────────────────────────────────────────────

function renderHero({ available, revenue, creatorPlans, subscribedTo, pendingRoyaltyAtomics }) {
	const wrap = document.createElement('div');
	wrap.className = 'dn-hero-grid';
	wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px';

	const revenue30 = Number(revenue?.summary?.net_total ?? 0);
	const paymentCount = Number(revenue?.summary?.payment_count ?? 0);

	const activePlans = creatorPlans.filter((p) => p.active).length;
	const planMrrUsd = creatorPlans
		.filter((p) => p.active && p.interval === 'monthly')
		.reduce((s, p) => s + Number(p.price_usd || 0), 0)
		+ creatorPlans
			.filter((p) => p.active && p.interval === 'weekly')
			.reduce((s, p) => s + Number(p.price_usd || 0) * 4.345, 0);
	const planMrrAtomics = Math.round(planMrrUsd * 1_000_000);
	const youSubscribeTo = subscribedTo.filter((s) => s.status === 'active').length;

	wrap.appendChild(
		card({
			title: 'Available to withdraw',
			value: formatUsdc(available),
			sub: pendingRoyaltyAtomics > 0
				? `Net revenue + ${formatUsdc(pendingRoyaltyAtomics)} pending royalties, minus inflight withdrawals.`
				: `Net revenue, minus inflight withdrawals.`,
			button: { label: 'Withdraw', primary: true, action: 'open-withdraw' },
		}),
	);

	wrap.appendChild(
		card({
			title: '30-day revenue',
			value: formatUsdc(revenue30),
			sub: paymentCount === 1 ? '1 payment in the last 30 days.' : `${paymentCount} payments in the last 30 days.`,
		}),
	);

	wrap.appendChild(
		card({
			title: 'Active subscriptions',
			value: `${activePlans} plan${activePlans === 1 ? '' : 's'}`,
			sub: planMrrAtomics > 0
				? `${formatUsdc(planMrrAtomics)}/mo at full capacity · ${youSubscribeTo} sub${youSubscribeTo === 1 ? '' : 's'} you pay for.`
				: `No active creator plans. ${youSubscribeTo} sub${youSubscribeTo === 1 ? '' : 's'} you pay for.`,
		}),
	);

	return wrap;
}

function card({ title, value, sub, button }) {
	const el = document.createElement('div');
	el.className = 'dn-panel';
	el.innerHTML = `
		<div class="dn-panel-title">${esc(title)}</div>
		<div style="font-size:28px;font-weight:700;color:var(--nxt-ink);margin:6px 0 8px;letter-spacing:-0.02em">
			${esc(value)}
		</div>
		<div class="dn-panel-sub" style="margin-bottom:${button ? '14px' : '0'}">${esc(sub)}</div>
		${button ? `<button class="dn-btn${button.primary ? ' primary' : ''}" data-action="${esc(button.action)}">${esc(button.label)}</button>` : ''}
	`;
	if (button) {
		el.querySelector('[data-action="open-withdraw"]')?.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('dn:monetize:open-withdraw'));
		});
	}
	return el;
}

// ── Revenue chart ──────────────────────────────────────────────────────────

function renderRevenueChart({ initial, defaultRange }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap">
			<div>
				<div class="dn-panel-title">Revenue · last 30 days</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Net earnings after platform fees.</div>
			</div>
			<select data-slot="range" style="
				padding:7px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
				background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px;cursor:pointer">
				${RANGES.map((r) => `<option value="${r.key}"${r.key === defaultRange ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
			</select>
		</div>
		<div data-slot="chart" style="position:relative;width:100%;height:240px"></div>
		<div data-slot="legend" style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px;font-size:12.5px;color:var(--nxt-ink-dim)"></div>
	`;

	const chartHost = panel.querySelector('[data-slot="chart"]');
	const legendHost = panel.querySelector('[data-slot="legend"]');
	const rangeSel = panel.querySelector('[data-slot="range"]');

	function paint(data) {
		const ts = data?.timeseries || [];
		const bySkill = data?.by_skill || [];
		const title = panel.querySelector('.dn-panel-title');
		const rangeMeta = RANGES.find((r) => r.key === rangeSel.value) || RANGES[1];
		title.textContent = `Revenue · ${rangeMeta.label.toLowerCase()}`;
		chartHost.innerHTML = svgBarChart(ts);
		legendHost.innerHTML = renderSkillLegend(bySkill);
	}

	paint(initial);

	rangeSel.addEventListener('change', async () => {
		const meta = RANGES.find((r) => r.key === rangeSel.value);
		chartHost.innerHTML = `<div class="dn-skeleton" style="width:100%;height:100%;border-radius:8px"></div>`;
		const from = new Date(Date.now() - meta.days * 86400_000).toISOString();
		const data = await safe(() =>
			get(`/api/billing/revenue?from=${encodeURIComponent(from)}&granularity=${meta.granularity}`),
		);
		paint(data || { timeseries: [], by_skill: [] });
	});

	return panel;
}

function svgBarChart(timeseries) {
	if (!timeseries.length) {
		return `<div class="dn-empty" style="height:100%;padding:24px"><h3>No revenue yet</h3><p>Payments will appear here as your agents earn.</p></div>`;
	}
	const W = 1000;
	const H = 240;
	const PAD = { top: 14, right: 12, bottom: 28, left: 12 };
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;
	const max = Math.max(...timeseries.map((r) => Number(r.net_total) || 0), 1);
	const gap = 3;
	const slotW = innerW / timeseries.length;
	const barW = Math.max(2, slotW - gap);

	const bars = timeseries
		.map((r, i) => {
			const v = Number(r.net_total) || 0;
			const h = Math.max(1, Math.round((v / max) * innerH));
			const x = PAD.left + i * slotW;
			const y = PAD.top + innerH - h;
			const label = (r.period || '').slice(5);
			const tooltip = `${r.period} · ${formatUsdc(v)}`;
			return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h}"
				fill="var(--nxt-accent)" rx="2"
				data-day="${esc(r.period)}" data-amount="${v}"
				data-tooltip="${esc(tooltip)}"><title>${esc(tooltip)}</title></rect>
				${timeseries.length <= 16 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--nxt-ink-fade)">${esc(label)}</text>` : ''}`;
		})
		.join('');

	const yMaxLabel = `<text x="${PAD.left}" y="${PAD.top + 2}" font-size="10" fill="var(--nxt-ink-fade)">${esc(formatUsdc(max))}</text>`;
	const yZeroLabel = `<text x="${PAD.left}" y="${PAD.top + innerH + 12}" font-size="10" fill="var(--nxt-ink-fade)">$0.00</text>`;

	return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
		style="width:100%;height:100%;display:block">${bars}${yMaxLabel}${yZeroLabel}</svg>`;
}

function renderSkillLegend(bySkill) {
	if (!bySkill.length) {
		return `<span style="color:var(--nxt-ink-fade)">Source breakdown unavailable — no payments yet for this range.</span>`;
	}
	const total = bySkill.reduce((s, r) => s + Number(r.net_total || 0), 0) || 1;
	const swatches = ['var(--nxt-accent)', '#dddfe4', '#c8cad0', '#a8adb5', '#969ba3', '#787d85'];
	return bySkill
		.slice(0, 6)
		.map((r, i) => {
			const pct = ((Number(r.net_total || 0) / total) * 100).toFixed(0);
			return `<span style="display:inline-flex;align-items:center;gap:7px">
				<span style="width:9px;height:9px;border-radius:2px;background:${swatches[i % swatches.length]}"></span>
				<span style="color:var(--nxt-ink)">${esc(humanizeSkill(r.skill))}</span>
				<span style="color:var(--nxt-ink-fade)">${esc(formatUsdc(r.net_total))} · ${pct}%</span>
			</span>`;
		})
		.join('');
}

function humanizeSkill(skill) {
	if (!skill) return 'Other';
	const map = {
		'subscription': 'Subscriptions',
		'api': 'API calls',
		'tip': 'Tips',
		'skill_unlock': 'Skill unlocks',
		'token_royalty': 'Token royalties',
	};
	return map[skill] || skill.replace(/_/g, ' ');
}

// ── Recent payments ────────────────────────────────────────────────────────

async function fetchRecentPayments(agents) {
	if (!agents.length) return [];
	const top = agents.slice(0, 8);
	const lists = await Promise.all(
		top.map((a) =>
			safe(() => get(`/api/agents/${encodeURIComponent(a.id)}/payments?direction=received&limit=10`))
				.then((r) => (r?.payments || []).map((p) => ({ ...p, _agent: a }))),
		),
	);
	const merged = lists.flat().filter(Boolean);
	merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
	return merged.slice(0, 50);
}

function renderPaymentsPanel(allPayments) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Recent payments</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Inbound USDC from skills, subscriptions, and API calls.</div>
			</div>
			<div data-slot="filters" style="display:flex;gap:6px;flex-wrap:wrap">
				${PAYMENT_FILTERS.map((f, i) => `
					<button class="dn-btn ghost" data-filter="${esc(f.key)}" style="padding:4px 12px;font-size:12px${i === 0 ? ';background:var(--nxt-accent-soft);color:var(--nxt-ink)' : ''}">${esc(f.label)}</button>
				`).join('')}
			</div>
		</div>
		<div data-slot="payments"></div>
	`;

	const listHost = panel.querySelector('[data-slot="payments"]');
	let activeFilter = 'all';
	let visibleCount = 20;

	function paint() {
		const filtered = filterPayments(allPayments, activeFilter);
		if (!filtered.length) {
			listHost.innerHTML = `
				<div class="dn-empty">
					<h3>No payments yet</h3>
					<p>Hook a widget into your site or issue an API key to start earning.</p>
				</div>`;
			return;
		}
		const slice = filtered.slice(0, visibleCount);
		listHost.innerHTML = `
			<div style="overflow-x:auto">
				<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
					<thead>
						<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
							<th style="padding:8px 10px;font-weight:500">When</th>
							<th style="padding:8px 10px;font-weight:500">Source</th>
							<th style="padding:8px 10px;font-weight:500;text-align:right">Amount</th>
							<th style="padding:8px 10px;font-weight:500">Status</th>
							<th style="padding:8px 10px;font-weight:500">Tx</th>
						</tr>
					</thead>
					<tbody>${slice.map(paymentRow).join('')}</tbody>
				</table>
			</div>
			${filtered.length > visibleCount
				? `<div style="margin-top:14px;text-align:center"><button class="dn-btn" data-action="load-more">Load more · ${filtered.length - visibleCount} remaining</button></div>`
				: ''}
		`;
		listHost.querySelector('[data-action="load-more"]')?.addEventListener('click', () => {
			visibleCount += 20;
			paint();
		});
	}

	panel.querySelectorAll('[data-filter]').forEach((btn) => {
		btn.addEventListener('click', () => {
			activeFilter = btn.dataset.filter;
			panel.querySelectorAll('[data-filter]').forEach((b) => {
				if (b.dataset.filter === activeFilter) {
					b.style.background = 'var(--nxt-accent-soft)';
					b.style.color = 'var(--nxt-ink)';
				} else {
					b.style.background = '';
					b.style.color = '';
				}
			});
			visibleCount = 20;
			paint();
		});
	});

	paint();
	return panel;
}

function filterPayments(payments, filter) {
	if (filter === 'all') return payments;
	return payments.filter((p) => {
		const memo = (p.memo || '').toLowerCase();
		const slug = (p.skill_slug || '').toLowerCase();
		if (filter === 'subscriptions') return memo.includes('subscription') || slug.includes('subscription');
		if (filter === 'tips') return memo.includes('tip');
		if (filter === 'api') return memo.includes('api') || memo.includes('mcp') || !p.skill_name;
		if (filter === 'skills') return Boolean(p.skill_name);
		return true;
	});
}

function paymentRow(p) {
	const amount = p.amount_wei
		? formatWeiAsEth(p.amount_wei)
		: p.amount
			? formatUsdc(p.amount)
			: '—';
	const status = (p.status || 'pending').toLowerCase();
	const tag =
		status === 'confirmed' || status === 'completed' || status === 'settled'
			? '<span class="dn-tag success">Settled</span>'
			: status === 'failed'
				? '<span class="dn-tag danger">Failed</span>'
				: '<span class="dn-tag warn">Pending</span>';
	const source = paymentSource(p);
	const tx = paymentTxLink(p);
	return `
		<tr style="border-bottom:1px solid var(--nxt-stroke)">
			<td style="padding:10px;color:var(--nxt-ink-dim);white-space:nowrap">${esc(relTime(p.created_at))}</td>
			<td style="padding:10px">${source}</td>
			<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">${esc(amount)}</td>
			<td style="padding:10px">${tag}</td>
			<td style="padding:10px">${tx}</td>
		</tr>
	`;
}

function paymentSource(p) {
	const agentName = p._agent?.name ? esc(p._agent.name) : 'Agent';
	if (p.skill_name) {
		return `<div>${esc(p.skill_name)}</div><div style="color:var(--nxt-ink-fade);font-size:12px">${agentName}</div>`;
	}
	if (p.memo) {
		return `<div>${esc(p.memo.slice(0, 80))}</div><div style="color:var(--nxt-ink-fade);font-size:12px">${agentName}</div>`;
	}
	return `<div>API call</div><div style="color:var(--nxt-ink-fade);font-size:12px">${agentName}</div>`;
}

function paymentTxLink(p) {
	if (!p.tx_hash && !p.tx_signature) return '<span style="color:var(--nxt-ink-fade)">—</span>';
	const hash = p.tx_hash || p.tx_signature;
	const explorer =
		p.chain_id === 8453
			? `https://basescan.org/tx/${encodeURIComponent(hash)}`
			: p.chain_id === 84532
				? `https://sepolia.basescan.org/tx/${encodeURIComponent(hash)}`
				: p.chain === 'solana'
					? `https://solscan.io/tx/${encodeURIComponent(hash)}`
					: `https://etherscan.io/tx/${encodeURIComponent(hash)}`;
	return `<a href="${explorer}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">${esc(hash.slice(0, 10))}…</a>`;
}

function formatWeiAsEth(wei) {
	try {
		const eth = Number(BigInt(wei)) / 1e18;
		if (!Number.isFinite(eth)) return '—';
		if (eth >= 0.0001) return `${eth.toFixed(4)} ETH`;
		if (eth > 0) return `${eth.toExponential(2)} ETH`;
		return '0 ETH';
	} catch {
		return '—';
	}
}

// ── Withdrawals ────────────────────────────────────────────────────────────

function renderWithdrawals({ withdrawals, wallets, available, host, me }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const pending = withdrawals.filter((w) => w.status === 'pending' || w.status === 'processing');
	const past = withdrawals.filter((w) => w.status === 'completed' || w.status === 'failed').slice(0, 10);

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Withdrawals</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Move your earned USDC to a wallet you control.</div>
			</div>
			<button class="dn-btn primary" data-action="open-withdraw">Withdraw now</button>
		</div>

		<div data-slot="pending"></div>
		<div data-slot="past"></div>
	`;

	const pendingHost = panel.querySelector('[data-slot="pending"]');
	const pastHost = panel.querySelector('[data-slot="past"]');

	pendingHost.innerHTML = pending.length
		? withdrawalsTable(pending, { title: 'Pending', showArrival: true })
		: `<div style="padding:12px 0;color:var(--nxt-ink-dim);font-size:13px">No pending withdrawals.</div>`;

	if (past.length) {
		pastHost.innerHTML = `
			<button class="dn-btn ghost" data-action="toggle-past" style="margin-top:14px;font-size:12px">
				Show past withdrawals (${past.length})
			</button>
			<div data-slot="past-list" hidden style="margin-top:12px"></div>
		`;
		pastHost.querySelector('[data-action="toggle-past"]').addEventListener('click', () => {
			const list = pastHost.querySelector('[data-slot="past-list"]');
			const btn = pastHost.querySelector('[data-action="toggle-past"]');
			if (list.hidden) {
				list.hidden = false;
				list.innerHTML = withdrawalsTable(past, { title: '', showArrival: false });
				btn.textContent = 'Hide past withdrawals';
			} else {
				list.hidden = true;
				btn.textContent = `Show past withdrawals (${past.length})`;
			}
		});
	}

	const openModal = () => openWithdrawModal({ available, wallets, host, me });
	panel.querySelector('[data-action="open-withdraw"]').addEventListener('click', openModal);
	document.addEventListener('dn:monetize:open-withdraw', openModal);

	return panel;
}

function withdrawalsTable(rows, { title, showArrival }) {
	const head = title ? `<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--nxt-ink-fade);margin:0 0 8px">${esc(title)}</div>` : '';
	return `
		${head}
		<div style="overflow-x:auto">
			<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
				<thead>
					<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
						<th style="padding:8px 10px;font-weight:500">ID</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">Amount</th>
						<th style="padding:8px 10px;font-weight:500">Chain</th>
						<th style="padding:8px 10px;font-weight:500">Status</th>
						<th style="padding:8px 10px;font-weight:500">${showArrival ? 'Est. arrival' : 'Tx'}</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((w) => `
						<tr style="border-bottom:1px solid var(--nxt-stroke)">
							<td style="padding:10px;font-family:ui-monospace,monospace;font-size:11px;color:var(--nxt-ink-dim)">${esc(String(w.id).slice(0, 8))}…</td>
							<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">${esc(formatUsdc(Number(w.amount)))}</td>
							<td style="padding:10px;color:var(--nxt-ink-dim)">${esc(w.chain)}</td>
							<td style="padding:10px">${statusTag(w.status)}</td>
							<td style="padding:10px;color:var(--nxt-ink-dim)">${showArrival ? estArrival(w) : withdrawalTx(w)}</td>
						</tr>`).join('')}
				</tbody>
			</table>
		</div>
	`;
}

function statusTag(status) {
	const s = String(status || '').toLowerCase();
	if (s === 'completed') return '<span class="dn-tag success">Completed</span>';
	if (s === 'failed') return '<span class="dn-tag danger">Failed</span>';
	if (s === 'processing') return '<span class="dn-tag warn">Processing</span>';
	return '<span class="dn-tag warn">Pending</span>';
}

function estArrival(w) {
	const minutes = w.status === 'processing' ? 5 : 30;
	const eta = new Date(new Date(w.created_at).getTime() + minutes * 60_000);
	const now = new Date();
	if (eta < now) return 'momentarily';
	const diffMin = Math.max(1, Math.round((eta - now) / 60_000));
	return `~${diffMin}m`;
}

function withdrawalTx(w) {
	if (!w.tx_signature) return '<span style="color:var(--nxt-ink-fade)">—</span>';
	const sig = encodeURIComponent(w.tx_signature);
	const url =
		w.chain === 'solana'
			? `https://solscan.io/tx/${sig}`
			: w.chain === 'base'
				? `https://basescan.org/tx/${sig}`
				: `https://etherscan.io/tx/${sig}`;
	return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">view ↗</a>`;
}

// ── Withdraw modal ─────────────────────────────────────────────────────────

function openWithdrawModal({ available, wallets, host, me }) {
	const existing = document.querySelector('[data-monetize-modal]');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.setAttribute('data-monetize-modal', 'true');
	overlay.style.cssText = `
		position:fixed;inset:0;z-index:1000;
		background:rgba(8,9,14,0.72);backdrop-filter:blur(6px);
		display:grid;place-items:center;padding:20px;
	`;
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Withdraw USDC" style="
			width:min(440px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.95),rgba(16,17,24,0.95));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:22px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
				<div>
					<div style="font-size:16px;font-weight:600;color:var(--nxt-ink)">Withdraw USDC</div>
					<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px">Available: ${esc(formatUsdc(available))}</div>
				</div>
				<button class="dn-btn ghost" data-action="close" aria-label="Close" style="padding:4px 10px">×</button>
			</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Chain</span>
				<select data-slot="chain" style="
					padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px">
					<option value="solana">Solana (USDC)</option>
					<option value="base">Base (USDC)</option>
				</select>
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Destination address</span>
				<input data-slot="address" type="text" placeholder="Wallet address" style="
					padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px;
					font-family:ui-monospace,monospace" />
				<span data-slot="addr-hint" style="font-size:11.5px;color:var(--nxt-ink-fade)"></span>
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Amount (USDC)</span>
				<div style="display:flex;gap:8px">
					<input data-slot="amount" type="number" min="1" step="0.000001" placeholder="0.00" style="
						flex:1;padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
						background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
					<button class="dn-btn" data-action="max" type="button">Max</button>
				</div>
			</label>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:10px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">Request withdrawal</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);

	const chainEl = overlay.querySelector('[data-slot="chain"]');
	const addrEl = overlay.querySelector('[data-slot="address"]');
	const addrHint = overlay.querySelector('[data-slot="addr-hint"]');
	const amountEl = overlay.querySelector('[data-slot="amount"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');

	const solWallet = wallets.find((w) => w.chain === 'solana');
	const baseWallet = wallets.find((w) => w.chain === 'base' || w.chain === 'evm');

	function syncDefaults() {
		const chain = chainEl.value;
		const fallback = chain === 'solana' ? solWallet : baseWallet;
		if (fallback) {
			addrEl.value = fallback.address;
			addrHint.textContent = `Pre-filled from your ${chain === 'solana' ? 'Solana' : 'Base'} payout wallet.`;
		} else {
			addrEl.value = '';
			addrHint.textContent = 'No default payout wallet for this chain. Paste an address.';
		}
	}
	syncDefaults();
	chainEl.addEventListener('change', syncDefaults);

	overlay.querySelector('[data-action="max"]').addEventListener('click', () => {
		amountEl.value = (available / 1_000_000).toString();
	});

	function close() {
		document.removeEventListener('keydown', onKey);
		overlay.remove();
	}
	function onKey(e) {
		if (e.key === 'Escape') close();
	}
	document.addEventListener('keydown', onKey);

	overlay.querySelector('[data-action="close"]').addEventListener('click', close);
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) close();
	});

	submitBtn.addEventListener('click', async () => {
		errorEl.textContent = '';
		const chain = chainEl.value;
		const addr = addrEl.value.trim();
		const human = parseFloat(amountEl.value);

		if (!Number.isFinite(human) || human <= 0) {
			errorEl.textContent = 'Enter a valid amount.';
			return;
		}
		const atomics = Math.round(human * 1_000_000);
		if (atomics < MIN_WITHDRAWAL_USDC_ATOMICS) {
			errorEl.textContent = 'Minimum withdrawal is 1 USDC.';
			return;
		}
		if (atomics > available) {
			errorEl.textContent = `Exceeds available (${formatUsdc(available)}).`;
			return;
		}
		if (!addr) {
			errorEl.textContent = 'Destination address required.';
			return;
		}
		if (chain === 'solana' && !SOLANA_ADDR_RE.test(addr)) {
			errorEl.textContent = 'Invalid Solana address.';
			return;
		}
		if (chain === 'base' && !EVM_ADDR_RE.test(addr)) {
			errorEl.textContent = 'Invalid Base address (expected 0x + 40 hex chars).';
			return;
		}

		submitBtn.disabled = true;
		submitBtn.textContent = 'Submitting…';
		try {
			await post('/api/billing/withdrawals', {
				amount: atomics,
				chain,
				currency_mint: USDC_MINTS[chain],
				to_address: addr,
			});
			close();
			renderSkeleton(host);
			await loadAndRender(host, me);
		} catch (err) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Request withdrawal';
			errorEl.textContent =
				err?.body?.error_description || err?.message || 'Withdrawal request failed.';
		}
	});
}

// ── Payout wallets ─────────────────────────────────────────────────────────

function renderPayoutWallets({ wallets, host, me }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('data-payout-wallets-panel', '');

	const render = (ws) => {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Payout wallets</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Default addresses used when withdrawing USDC. One per chain.</div>
				</div>
				<button class="dn-btn primary" data-action="add-payout-wallet" style="flex-shrink:0">+ Add wallet</button>
			</div>
			${ws.length ? `
				<div style="display:flex;flex-direction:column;gap:8px">
					${ws.map((w) => `
						<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--nxt-stroke);border-radius:8px;flex-wrap:wrap" data-wallet-id="${esc(w.id)}">
							<div style="min-width:0">
								<div style="font-size:12px;color:var(--nxt-ink-fade);text-transform:capitalize;letter-spacing:0.04em;margin-bottom:2px">${esc(w.chain || 'unknown')}</div>
								<div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12.5px;color:var(--nxt-ink);word-break:break-all">${esc(w.address || '')}</div>
								${w.label ? `<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-top:2px">${esc(w.label)}</div>` : ''}
							</div>
							<button class="dn-btn danger" data-action="remove-payout-wallet" data-id="${esc(w.id)}" style="padding:5px 10px;font-size:12px;flex-shrink:0">Remove</button>
						</div>
					`).join('')}
				</div>
			` : `<div style="color:var(--nxt-ink-dim);font-size:13px">No payout wallets saved. Add one to pre-fill the withdrawal form.</div>`}
		`;

		panel.querySelector('[data-action="add-payout-wallet"]').addEventListener('click', () => {
			openAddPayoutWalletModal({ panel, host, me });
		});

		panel.querySelectorAll('[data-action="remove-payout-wallet"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id;
				btn.disabled = true;
				btn.textContent = 'Removing…';
				try {
					await del(`/api/billing/payout-wallets/${encodeURIComponent(id)}`);
					const updated = ws.filter((w) => w.id !== id);
					render(updated);
				} catch (err) {
					btn.disabled = false;
					btn.textContent = 'Remove';
					toastMonetize(err?.body?.error || err?.message || 'Remove failed', true);
				}
			});
		});
	};

	render(wallets);
	return panel;
}

function openAddPayoutWalletModal({ panel, host, me }) {
	const existing = document.querySelector('[data-add-payout-modal]');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.setAttribute('data-add-payout-modal', '');
	overlay.style.cssText = `
		position:fixed;inset:0;z-index:1000;
		background:rgba(8,9,14,0.72);backdrop-filter:blur(6px);
		display:grid;place-items:center;padding:20px;
	`;
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Add payout wallet" style="
			width:min(420px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:22px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="font-size:16px;font-weight:600;color:var(--nxt-ink);margin-bottom:18px">Add payout wallet</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Chain</span>
				<select data-slot="chain" style="
					padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px">
					<option value="solana">Solana</option>
					<option value="base">Base (EVM)</option>
				</select>
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Wallet address</span>
				<input data-slot="address" type="text" placeholder="Paste address…" style="
					padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px;
					font-family:ui-monospace,monospace" />
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
				<span style="font-size:12px;color:var(--nxt-ink-dim)">Label (optional)</span>
				<input data-slot="label" type="text" maxlength="60" placeholder="e.g. Main treasury" style="
					padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);
					background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:10px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">Save wallet</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const chainEl = overlay.querySelector('[data-slot="chain"]');
	const addrEl = overlay.querySelector('[data-slot="address"]');
	const labelEl = overlay.querySelector('[data-slot="label"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');
	addrEl.focus();

	const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey);
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	submitBtn.addEventListener('click', async () => {
		errorEl.textContent = '';
		const chain = chainEl.value;
		const address = addrEl.value.trim();
		const label = labelEl.value.trim();

		if (!address) { errorEl.textContent = 'Wallet address is required.'; return; }
		if (chain === 'solana' && !SOLANA_ADDR_RE.test(address)) {
			errorEl.textContent = 'Invalid Solana address.';
			return;
		}
		if (chain === 'base' && !EVM_ADDR_RE.test(address)) {
			errorEl.textContent = 'Invalid Base/EVM address (expected 0x + 40 hex chars).';
			return;
		}

		submitBtn.disabled = true;
		submitBtn.textContent = 'Saving…';
		try {
			await post('/api/billing/payout-wallets', { chain, address, label: label || undefined });
			close();
			renderSkeleton(host);
			await loadAndRender(host, me);
		} catch (err) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Save wallet';
			errorEl.textContent = err?.body?.error || err?.message || 'Save failed.';
		}
	});
}

// ── Plan & usage ───────────────────────────────────────────────────────────

function renderPlanUsage(summary) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const plan = summary?.plan || 'free';
	const quotas = summary?.quotas;
	const usage = summary?.usage || {};

	const meter = (label, used, max, fmt = (n) => String(n)) => {
		const pct = max ? Math.min(100, (used / max) * 100) : 0;
		const color = pct > 90 ? 'var(--nxt-danger)' : pct > 70 ? 'var(--nxt-warn)' : 'var(--nxt-accent)';
		return `
			<div style="margin-bottom:14px">
				<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
					<span>${esc(label)}</span>
					<span style="color:var(--nxt-ink-fade)">${esc(fmt(used))} / ${max ? esc(fmt(max)) : '∞'}</span>
				</div>
				<div style="height:6px;border-radius:3px;background:var(--nxt-stroke);overflow:hidden">
					<div style="height:100%;width:${pct.toFixed(1)}%;background:${color};transition:width 400ms ease"></div>
				</div>
			</div>
		`;
	};

	const fmtBytes = (n) => {
		if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
		if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
		if (n >= 1e3) return Math.round(n / 1e3) + ' KB';
		return `${n} B`;
	};

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Plan & usage</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">
					Current plan: <span style="color:var(--nxt-ink);text-transform:capitalize;font-weight:600">${esc(plan)}</span>
				</div>
			</div>
			<a class="dn-btn" href="/pricing">Upgrade plan</a>
		</div>

		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px">
			<div>
				${meter('Avatars', usage.avatar_count ?? 0, quotas?.max_avatars)}
				${meter('Storage', usage.total_bytes ?? 0, quotas?.max_total_bytes, fmtBytes)}
			</div>
			<div>
				${meter('MCP calls (24 h)', usage.mcp_calls_24h ?? 0, quotas?.mcp_calls_per_day)}
				${meter('LLM calls this month', usage.llm_calls_month ?? 0, null)}
			</div>
		</div>
	`;
	return panel;
}

// ── Token earnings ─────────────────────────────────────────────────────────

function renderTokensPanel(agents) {
	const launched = agents.filter((a) => {
		const m = a?.meta?.pumpfun || a?.meta?.token;
		return Boolean(m?.mint || m?.address || m?.ca);
	});

	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	if (!launched.length) {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Token earnings</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Royalties from Pump.fun tokens your agents launched.</div>
				</div>
				<a class="dn-btn" href="/dashboard/tokens">Token dashboard →</a>
			</div>
			<div class="dn-empty">
				<h3>No tokens launched</h3>
				<p>Launch a Pump.fun token from any agent to earn royalties on every trade.</p>
				<a class="dn-btn primary" href="/dashboard/agents">Go to Agents →</a>
			</div>
		`;
		return panel;
	}

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Token earnings</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Royalties from Pump.fun tokens your agents launched.</div>
			</div>
			<a class="dn-btn" href="/dashboard/tokens">Full token dashboard →</a>
		</div>
		<div style="overflow-x:auto">
			<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:520px">
				<thead>
					<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
						<th style="padding:8px 10px;font-weight:500">Ticker</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">Holders</th>
						<th style="padding:8px 10px;font-weight:500;text-align:right">Royalties</th>
						<th style="padding:8px 10px;font-weight:500"></th>
					</tr>
				</thead>
				<tbody>
					${launched.map((a) => {
						const meta = a.meta?.pumpfun || a.meta?.token || {};
						const mint = meta.mint || meta.address || meta.ca || '';
						const ticker = meta.symbol || meta.ticker || a.name || 'TOKEN';
						const holders = meta.holders ?? '—';
						const royalties = meta.royalties_atomics ? formatUsdc(meta.royalties_atomics) : '—';
						return `
							<tr style="border-bottom:1px solid var(--nxt-stroke)">
								<td style="padding:10px;font-weight:600">$${esc(String(ticker).toUpperCase())}</td>
								<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--nxt-ink-dim)">${esc(String(holders))}</td>
								<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">${esc(royalties)}</td>
								<td style="padding:10px">
									${mint
										? `<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">View token ↗</a>`
										: ''}
								</td>
							</tr>
						`;
					}).join('')}
				</tbody>
			</table>
		</div>
	`;
	return panel;
}

// ── Subscription plans (creator) ───────────────────────────────────────────

function renderSubscriptionPlans({ creatorPlans, me }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	let plans = [...creatorPlans];

	function paint() {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Subscription plans</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Plans you offer — users can subscribe to unlock premium access to your agents.</div>
				</div>
				<button class="dn-btn primary" data-action="create-plan">+ New plan</button>
			</div>
			<div data-slot="plans-list"></div>
		`;

		const listHost = panel.querySelector('[data-slot="plans-list"]');

		if (!plans.length) {
			listHost.innerHTML = `
				<div class="dn-empty">
					<h3>No subscription plans</h3>
					<p>Create a plan to let users subscribe to your agents and unlock premium skills.</p>
				</div>`;
		} else {
			listHost.innerHTML = `
				<div style="overflow-x:auto">
					<table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px">
						<thead>
							<tr style="text-align:left;color:var(--nxt-ink-fade);border-bottom:1px solid var(--nxt-stroke)">
								<th style="padding:8px 10px;font-weight:500">Plan</th>
								<th style="padding:8px 10px;font-weight:500;text-align:right">Price</th>
								<th style="padding:8px 10px;font-weight:500">Interval</th>
								<th style="padding:8px 10px;font-weight:500">Status</th>
								<th style="padding:8px 10px;font-weight:500"></th>
							</tr>
						</thead>
						<tbody>
							${plans.map((p) => `
								<tr style="border-bottom:1px solid var(--nxt-stroke)">
									<td style="padding:10px">
										<div style="font-weight:600">${esc(p.name || 'Unnamed plan')}</div>
										${p.description ? `<div style="font-size:12px;color:var(--nxt-ink-dim)">${esc(p.description.slice(0, 80))}</div>` : ''}
									</td>
									<td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">
										$${esc(Number(p.price_usd || 0).toFixed(2))}
									</td>
									<td style="padding:10px;color:var(--nxt-ink-dim)">${esc(p.interval || 'monthly')}</td>
									<td style="padding:10px">
										${p.active
											? `<span class="dn-tag success">Active</span>`
											: `<span class="dn-tag">Inactive</span>`
										}
									</td>
									<td style="padding:10px;text-align:right">
										<div style="display:inline-flex;gap:6px">
											<button class="dn-btn" data-action="edit-plan" data-id="${esc(p.id)}" style="padding:5px 10px;font-size:12px">Edit</button>
											<button class="dn-btn danger" data-action="delete-plan" data-id="${esc(p.id)}" style="padding:5px 10px;font-size:12px">Delete</button>
										</div>
									</td>
								</tr>
							`).join('')}
						</tbody>
					</table>
				</div>
			`;
		}

		panel.querySelector('[data-action="create-plan"]').addEventListener('click', () => {
			openPlanModal(null, (saved) => {
				plans.unshift(saved);
				paint();
			});
		});

		panel.querySelectorAll('[data-action="edit-plan"]').forEach((btn) => {
			btn.addEventListener('click', () => {
				const plan = plans.find((p) => p.id === btn.dataset.id);
				if (!plan) return;
				openPlanModal(plan, (updated) => {
					const idx = plans.findIndex((p) => p.id === updated.id);
					if (idx >= 0) plans[idx] = updated;
					paint();
				});
			});
		});

		panel.querySelectorAll('[data-action="delete-plan"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id;
				const plan = plans.find((p) => p.id === id);
				if (!confirm(`Delete plan "${plan?.name || id}"?`)) return;
				btn.disabled = true;
				btn.textContent = 'Deleting…';
				try {
					await del(`/api/subscriptions/plans/${encodeURIComponent(id)}`);
					plans = plans.filter((p) => p.id !== id);
					paint();
					toastMonetize('Plan deleted');
				} catch (err) {
					toastMonetize(err?.message || 'Delete failed');
					btn.disabled = false;
					btn.textContent = 'Delete';
				}
			});
		});
	}

	paint();
	return panel;
}

function openPlanModal(existing, onSaved) {
	const overlay = document.createElement('div');
	overlay.style.cssText = `
		position:fixed;inset:0;z-index:1000;
		background:rgba(8,9,14,0.72);backdrop-filter:blur(6px);
		display:grid;place-items:center;padding:20px;
	`;
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" style="
			width:min(460px,100%);
			background:linear-gradient(180deg,rgba(22,24,32,0.97),rgba(16,17,24,0.97));
			border:1px solid var(--nxt-stroke-strong);border-radius:14px;padding:24px;
			box-shadow:0 20px 60px rgba(0,0,0,0.6);
		">
			<div style="font-size:16px;font-weight:600;margin-bottom:18px">${existing ? 'Edit plan' : 'Create plan'}</div>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Plan name</span>
				<input data-slot="name" type="text" maxlength="80" value="${esc(existing?.name || '')}"
					placeholder="e.g. Pro access, VIP, Founder…"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
			</label>

			<label style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
				<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Description (optional)</span>
				<textarea data-slot="description" maxlength="300" rows="2"
					placeholder="What does this plan unlock?"
					style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px;resize:vertical">${esc(existing?.description || '')}</textarea>
			</label>

			<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
				<label style="display:flex;flex-direction:column;gap:6px">
					<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Price (USD)</span>
					<input data-slot="price" type="number" min="0.5" step="0.01" value="${esc(String(existing?.price_usd || ''))}"
						placeholder="9.99"
						style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px" />
				</label>
				<label style="display:flex;flex-direction:column;gap:6px">
					<span style="font-size:12.5px;color:var(--nxt-ink-dim)">Interval</span>
					<select data-slot="interval"
						style="padding:9px 12px;border-radius:8px;border:1px solid var(--nxt-stroke);background:rgba(255,255,255,0.04);color:var(--nxt-ink);font:inherit;font-size:13px">
						<option value="monthly"${(!existing || existing.interval === 'monthly') ? ' selected' : ''}>Monthly</option>
						<option value="weekly"${existing?.interval === 'weekly' ? ' selected' : ''}>Weekly</option>
						<option value="yearly"${existing?.interval === 'yearly' ? ' selected' : ''}>Yearly</option>
					</select>
				</label>
			</div>

			<label style="display:flex;align-items:center;gap:10px;margin-bottom:18px;cursor:pointer">
				<input data-slot="active" type="checkbox" ${(!existing || existing.active) ? 'checked' : ''}
					style="width:16px;height:16px;cursor:pointer;accent-color:var(--nxt-accent)" />
				<span style="font-size:13px;color:var(--nxt-ink)">Plan is active (visible to subscribers)</span>
			</label>

			<div data-slot="error" style="font-size:12.5px;color:var(--nxt-danger);min-height:18px;margin-bottom:10px"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">${existing ? 'Save changes' : 'Create plan'}</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	const nameEl = overlay.querySelector('[data-slot="name"]');
	const descEl = overlay.querySelector('[data-slot="description"]');
	const priceEl = overlay.querySelector('[data-slot="price"]');
	const intervalEl = overlay.querySelector('[data-slot="interval"]');
	const activeEl = overlay.querySelector('[data-slot="active"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');
	nameEl.focus();

	const close = () => overlay.remove();
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', function onKey(e) {
		if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
	});

	submitBtn.addEventListener('click', async () => {
		const name = nameEl.value.trim();
		const price = parseFloat(priceEl.value);
		if (!name) { errorEl.textContent = 'Plan name is required.'; return; }
		if (!Number.isFinite(price) || price < 0.5) { errorEl.textContent = 'Price must be at least $0.50.'; return; }
		errorEl.textContent = '';
		submitBtn.disabled = true;
		submitBtn.textContent = existing ? 'Saving…' : 'Creating…';
		const body = {
			name,
			description: descEl.value.trim() || undefined,
			price_usd: price,
			interval: intervalEl.value,
			active: activeEl.checked,
		};
		try {
			let saved;
			if (existing) {
				const r = await put(`/api/subscriptions/plans/${encodeURIComponent(existing.id)}`, body);
				saved = r?.plan || { ...existing, ...body };
			} else {
				const r = await post('/api/subscriptions/plans', body);
				saved = r?.plan || body;
			}
			toastMonetize(existing ? 'Plan updated' : 'Plan created');
			close();
			onSaved(saved);
		} catch (err) {
			errorEl.textContent = err?.body?.error || err?.message || 'Save failed';
			submitBtn.disabled = false;
			submitBtn.textContent = existing ? 'Save changes' : 'Create plan';
		}
	});
}

function toastMonetize(msg) {
	let el = document.getElementById('dn-monetize-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'dn-monetize-toast';
		el.style.cssText = `
			position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);
			background:rgba(20,21,28,0.95);border:1px solid var(--nxt-stroke-strong);
			color:var(--nxt-ink);padding:9px 16px;border-radius:999px;font-size:13px;
			z-index:9999;opacity:0;transition:opacity .18s,transform .18s;
			backdrop-filter:blur(20px);box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;`;
		document.body.appendChild(el);
	}
	el.textContent = msg;
	requestAnimationFrame(() => {
		el.style.opacity = '1';
		el.style.transform = 'translateX(-50%) translateY(0)';
	});
	clearTimeout(el._t);
	el._t = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transform = 'translateX(-50%) translateY(20px)';
	}, 1800);
}

// ── Skeleton ───────────────────────────────────────────────────────────────

function renderSkeleton(host) {
	host.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
			${Array.from({ length: 3 }).map(() => `
				<div class="dn-panel">
					<div class="dn-skeleton" style="height:14px;width:60%;margin-bottom:14px"></div>
					<div class="dn-skeleton" style="height:32px;width:80%;margin-bottom:10px"></div>
					<div class="dn-skeleton" style="height:12px;width:90%"></div>
				</div>`).join('')}
		</div>
		<div class="dn-panel" style="margin-top:18px">
			<div class="dn-skeleton" style="height:14px;width:30%;margin-bottom:14px"></div>
			<div class="dn-skeleton" style="height:240px;width:100%;border-radius:8px"></div>
		</div>
	`;
}
