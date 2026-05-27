// dashboard-next — Monetize page.
//
// Agent monetization hub: skill pricing controls, payout wallet config,
// revenue stats, withdrawal interface, subscription plans, and token earnings.
// All data from real /api/* endpoints.

import { mountShell } from '../shell.js';
import { requireUser, get, post, put, del, esc, relTime, formatUsdc, ApiError } from '../api.js';

const USDC_MINTS = {
	solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const MIN_WITHDRAWAL_USDC_ATOMICS = 1_000_000;

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

const RANGES = [
	{ key: '7d',  days: 7,   label: 'Last 7 days',    granularity: 'day' },
	{ key: '30d', days: 30,  label: 'Last 30 days',   granularity: 'day' },
	{ key: '90d', days: 90,  label: 'Last 90 days',   granularity: 'day' },
	{ key: '1y',  days: 365, label: 'Last 12 months', granularity: 'week' },
];

const PAYMENT_FILTERS = [
	{ key: 'all',           label: 'All' },
	{ key: 'subscriptions', label: 'Subscriptions' },
	{ key: 'api',           label: 'API' },
	{ key: 'skills',        label: 'Skills' },
	{ key: 'tips',          label: 'Tips' },
];

let selectedAgentId = null;

(async function boot() {
	try {
		const main = await mountShell();
		const me = await requireUser();

		main.innerHTML = `
			<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px">
				<div>
					<h1 class="dn-h1">Monetize Your Agents</h1>
					<p class="dn-h1-sub">Set skill prices, configure payouts, and track your earnings in USDC.</p>
				</div>
				<div data-slot="agent-selector"></div>
			</div>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:18px"></div>
		`;

		injectStyles();
		const host = main.querySelector('[data-slot="content"]');
		const selectorHost = main.querySelector('[data-slot="agent-selector"]');
		renderSkeleton(host);

		const agentsResp = await safe(() => get('/api/agents'));
		const agents = agentsResp?.agents || [];
		renderAgentSelector(selectorHost, agents, host, me);

		if (agents.length > 0) {
			selectedAgentId = agents[0].id;
		}

		await loadAndRender(host, me, agents);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			const ret = encodeURIComponent(location.pathname + location.search);
			location.href = `/login?return=${ret}`;
			return;
		}
		throw err;
	}
})();

// -- Agent selector dropdown --

function renderAgentSelector(host, agents, contentHost, me) {
	if (!agents.length) {
		host.innerHTML = `<a class="dn-btn primary" href="/dashboard/agents">Create an Agent</a>`;
		return;
	}

	host.innerHTML = `
		<select data-slot="agent-select" class="mon-select" aria-label="Select agent">
			${agents.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.slug || 'Unnamed Agent')}</option>`).join('')}
		</select>
	`;

	host.querySelector('[data-slot="agent-select"]').addEventListener('change', async (e) => {
		selectedAgentId = e.target.value;
		renderSkeleton(contentHost);
		await loadAndRender(contentHost, me, agents);
	});
}

// -- Data loading --

async function loadAndRender(host, me, agents) {
	const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const creatorParam = me.id && UUID_RE.test(me.id) ? encodeURIComponent(me.id) : null;

	const agentParam = selectedAgentId ? `agent_id=${encodeURIComponent(selectedAgentId)}` : '';

	const [
		revenue, withdrawalsResp, walletsResp, summary, plans,
		mineSubs, earningsResp, pricesResp, monWalletResp, monRevenueResp,
	] = await Promise.all([
		safe(() => get(`/api/billing/revenue?from=${encodeURIComponent(since30)}&granularity=day`)),
		safe(() => get('/api/billing/withdrawals?limit=50')),
		safe(() => get('/api/billing/payout-wallets')),
		safe(() => get('/api/billing/summary')),
		creatorParam
			? safe(() => get(`/api/subscriptions/plans?creator_id=${creatorParam}`))
			: Promise.resolve(null),
		safe(() => get('/api/subscriptions/mine')),
		safe(() => get('/api/users/me/earnings')),
		selectedAgentId ? safe(() => get(`/api/monetization/prices?${agentParam}`)) : Promise.resolve(null),
		selectedAgentId ? safe(() => get(`/api/monetization/wallet?${agentParam}`)) : Promise.resolve(null),
		selectedAgentId ? safe(() => get(`/api/monetization/revenue?${agentParam}&period=all`)) : Promise.resolve(null),
	]);

	const withdrawals = withdrawalsResp?.withdrawals || [];
	const wallets = walletsResp?.wallets || [];
	const creatorPlans = plans?.plans || [];
	const subscribedTo = mineSubs?.subscriptions || [];

	const earned = Number(revenue?.summary?.net_total ?? 0);
	const inflight = withdrawals
		.filter((w) => w.status === 'pending' || w.status === 'processing')
		.reduce((s, w) => s + Number(w.amount), 0);
	const pendingRoyaltyUsd = Number(earningsResp?.pending_usd ?? 0);
	const pendingRoyaltyAtomics = Math.round(pendingRoyaltyUsd * 1_000_000);
	const available = Math.max(0, earned + pendingRoyaltyAtomics - inflight);

	const skillPrices = pricesResp?.prices || pricesResp?.data?.prices || [];
	const monWallet = monWalletResp?.wallet || monWalletResp?.data?.wallet || monWalletResp;
	const monRevenue = monRevenueResp?.revenue || monRevenueResp?.data || monRevenueResp;

	const payments = await fetchRecentPayments(agents);

	host.innerHTML = '';
	host.appendChild(renderHero({ available, revenue, creatorPlans, subscribedTo, pendingRoyaltyAtomics, monRevenue }));

	if (selectedAgentId) {
		host.appendChild(renderSkillPricing(skillPrices, selectedAgentId, host, me, agents));
		host.appendChild(renderPayoutWalletPanel(monWallet, selectedAgentId, host, me, agents, wallets));
	}

	host.appendChild(renderRevenueChart({ initial: revenue, defaultRange: '30d' }));
	host.appendChild(renderPaymentsPanel(payments));
	host.appendChild(renderSubscriptionPlans({ creatorPlans, me }));
	host.appendChild(renderWithdrawals({ withdrawals, wallets, available, host, me, agents }));
	host.appendChild(renderLegacyPayoutWallets({ wallets, host, me, agents }));
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

// -- Hero metrics --

function renderHero({ available, revenue, creatorPlans, subscribedTo, pendingRoyaltyAtomics, monRevenue }) {
	const wrap = document.createElement('div');
	wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px';

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

	const monTotal = Number(monRevenue?.total_earned ?? monRevenue?.total ?? 0);
	const monWeek = Number(monRevenue?.earned_this_week ?? monRevenue?.week ?? 0);
	const monFees = Number(monRevenue?.platform_fees ?? monRevenue?.fees ?? 0);
	const monAvailable = Number(monRevenue?.available_for_withdrawal ?? monRevenue?.available ?? 0);

	wrap.appendChild(
		heroCard({
			title: 'Available to withdraw',
			value: formatUsdc(available || monAvailable),
			sub: pendingRoyaltyAtomics > 0
				? `Net revenue + ${formatUsdc(pendingRoyaltyAtomics)} pending royalties, minus inflight withdrawals.`
				: 'Net revenue, minus inflight withdrawals.',
			color: 'var(--nxt-success)',
			button: { label: 'Withdraw', primary: true, action: 'open-withdraw' },
		}),
	);

	wrap.appendChild(
		heroCard({
			title: 'Total earned',
			value: monTotal > 0 ? formatUsdc(monTotal) : formatUsdc(revenue30),
			sub: monTotal > 0
				? `Lifetime earnings across all skills.`
				: `${paymentCount} payment${paymentCount === 1 ? '' : 's'} in the last 30 days.`,
			color: 'var(--nxt-success)',
		}),
	);

	wrap.appendChild(
		heroCard({
			title: 'Earned this week',
			value: monWeek > 0 ? formatUsdc(monWeek) : '$0.00',
			sub: 'Revenue from skill calls in the last 7 days.',
			color: 'var(--nxt-accent)',
		}),
	);

	wrap.appendChild(
		heroCard({
			title: 'Platform fees',
			value: monFees > 0 ? formatUsdc(monFees) : '$0.00',
			sub: 'Fees deducted from earnings.',
			color: 'var(--nxt-warn)',
		}),
	);

	return wrap;
}

function heroCard({ title, value, sub, color, button }) {
	const el = document.createElement('div');
	el.className = 'dn-panel';
	el.innerHTML = `
		<div class="dn-panel-title">${esc(title)}</div>
		<div style="font-size:28px;font-weight:700;color:${color || 'var(--nxt-ink)'};margin:6px 0 8px;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">
			${esc(value)}
		</div>
		<div class="dn-panel-sub" style="margin-bottom:${button ? '14px' : '0'}">${esc(sub)}</div>
		${button ? `<button class="dn-btn${button.primary ? ' primary' : ''}" data-action="${esc(button.action)}">${esc(button.label)}</button>` : ''}
	`;
	if (button) {
		el.querySelector(`[data-action="${button.action}"]`)?.addEventListener('click', () => {
			document.dispatchEvent(new CustomEvent('dn:monetize:open-withdraw'));
		});
	}
	return el;
}

// -- Skill Pricing Panel --

function renderSkillPricing(prices, agentId, host, me, agents) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	let skillPrices = [...prices];

	function paint() {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Skill Pricing</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Set per-call prices for your agent's skills. Callers pay in USDC.</div>
				</div>
				<button class="dn-btn primary" data-action="add-price">+ Add Pricing</button>
			</div>
			<div data-slot="prices-list"></div>
		`;

		const listHost = panel.querySelector('[data-slot="prices-list"]');

		if (!skillPrices.length) {
			listHost.innerHTML = `
				<div class="dn-empty">
					<h3>No skills priced yet</h3>
					<p>Set a price on your agent's skills to start earning USDC on every call.</p>
				</div>`;
		} else {
			listHost.innerHTML = `
				<div style="overflow-x:auto">
					<table class="mon-table">
						<thead>
							<tr>
								<th>Skill</th>
								<th style="text-align:right">Price (USDC)</th>
								<th style="text-align:center">Active</th>
								<th style="text-align:right">Actions</th>
							</tr>
						</thead>
						<tbody>
							${skillPrices.map((p, idx) => {
								const active = p.active !== false;
								return `
									<tr data-idx="${idx}">
										<td style="font-weight:500">${esc(p.skill_name || p.skill || p.name || 'Unnamed')}</td>
										<td style="text-align:right">
											<input type="number" min="0" step="0.000001" class="mon-input mon-input-sm"
												value="${esc(String(p.price_usdc ?? p.price ?? 0))}"
												data-field="price" data-idx="${idx}" aria-label="Price" />
										</td>
										<td style="text-align:center">
											<label class="mon-toggle" title="${active ? 'Active' : 'Inactive'}">
												<input type="checkbox" ${active ? 'checked' : ''} data-field="active" data-idx="${idx}" />
												<span class="mon-toggle-track"></span>
											</label>
										</td>
										<td style="text-align:right">
											<div style="display:flex;gap:6px;justify-content:flex-end">
												<button class="dn-btn" data-action="save-price" data-idx="${idx}" style="padding:5px 10px;font-size:12px">Save</button>
												<button class="dn-btn danger" data-action="delete-price" data-idx="${idx}" style="padding:5px 10px;font-size:12px">Delete</button>
											</div>
										</td>
									</tr>`;
							}).join('')}
						</tbody>
					</table>
				</div>
			`;
		}

		panel.querySelector('[data-action="add-price"]').addEventListener('click', () => {
			openAddPriceModal(agentId, (saved) => {
				skillPrices.push(saved);
				paint();
				toastMonetize('Skill price added');
			});
		});

		panel.querySelectorAll('[data-action="save-price"]').forEach(btn => {
			btn.addEventListener('click', async () => {
				const idx = Number(btn.dataset.idx);
				const row = panel.querySelector(`tr[data-idx="${idx}"]`);
				const priceInput = row.querySelector('input[data-field="price"]');
				const activeInput = row.querySelector('input[data-field="active"]');
				const priceVal = parseFloat(priceInput.value);
				if (!Number.isFinite(priceVal) || priceVal < 0) {
					toastMonetize('Enter a valid price', true);
					return;
				}
				btn.disabled = true;
				btn.textContent = 'Saving...';
				try {
					await put('/api/monetization/prices', {
						agent_id: agentId,
						skill_name: skillPrices[idx].skill_name || skillPrices[idx].skill || skillPrices[idx].name,
						price_usdc: priceVal,
						active: activeInput.checked,
					});
					skillPrices[idx].price_usdc = priceVal;
					skillPrices[idx].price = priceVal;
					skillPrices[idx].active = activeInput.checked;
					toastMonetize('Price updated');
				} catch (err) {
					toastMonetize(err?.message || 'Save failed', true);
				}
				btn.disabled = false;
				btn.textContent = 'Save';
			});
		});

		panel.querySelectorAll('[data-action="delete-price"]').forEach(btn => {
			btn.addEventListener('click', async () => {
				const idx = Number(btn.dataset.idx);
				const skillName = skillPrices[idx].skill_name || skillPrices[idx].skill || skillPrices[idx].name;
				btn.disabled = true;
				btn.textContent = 'Deleting...';
				try {
					await del(`/api/monetization/prices?agent_id=${encodeURIComponent(agentId)}&skill_name=${encodeURIComponent(skillName)}`);
					skillPrices.splice(idx, 1);
					paint();
					toastMonetize('Skill price removed');
				} catch (err) {
					toastMonetize(err?.message || 'Delete failed', true);
					btn.disabled = false;
					btn.textContent = 'Delete';
				}
			});
		});
	}

	paint();
	return panel;
}

function openAddPriceModal(agentId, onSaved) {
	const overlay = document.createElement('div');
	overlay.className = 'mon-overlay';
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Add skill price" class="mon-modal">
			<div style="font-size:16px;font-weight:600;margin-bottom:18px">Add Skill Pricing</div>

			<label class="mon-field">
				<span class="mon-label">Skill name</span>
				<input data-slot="skill" type="text" maxlength="120" placeholder="e.g. generate_report, analyze_data" class="mon-input" />
			</label>

			<label class="mon-field">
				<span class="mon-label">Price per call (USDC)</span>
				<input data-slot="price" type="number" min="0" step="0.000001" placeholder="0.001" class="mon-input" />
			</label>

			<label style="display:flex;align-items:center;gap:10px;margin-bottom:18px;cursor:pointer">
				<input data-slot="active" type="checkbox" checked style="width:16px;height:16px;cursor:pointer;accent-color:var(--nxt-accent)" />
				<span style="font-size:13px;color:var(--nxt-ink)">Active (visible to callers)</span>
			</label>

			<div data-slot="error" class="mon-error"></div>

			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="dn-btn ghost" data-action="cancel">Cancel</button>
				<button class="dn-btn primary" data-action="submit">Add pricing</button>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);
	const skillEl = overlay.querySelector('[data-slot="skill"]');
	const priceEl = overlay.querySelector('[data-slot="price"]');
	const activeEl = overlay.querySelector('[data-slot="active"]');
	const errorEl = overlay.querySelector('[data-slot="error"]');
	const submitBtn = overlay.querySelector('[data-action="submit"]');
	skillEl.focus();

	const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey);
	overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

	submitBtn.addEventListener('click', async () => {
		const name = skillEl.value.trim();
		const price = parseFloat(priceEl.value);
		if (!name) { errorEl.textContent = 'Skill name is required.'; return; }
		if (!Number.isFinite(price) || price < 0) { errorEl.textContent = 'Enter a valid price.'; return; }
		errorEl.textContent = '';
		submitBtn.disabled = true;
		submitBtn.textContent = 'Adding...';
		try {
			const r = await put('/api/monetization/prices', {
				agent_id: agentId,
				skill_name: name,
				price_usdc: price,
				active: activeEl.checked,
			});
			close();
			onSaved(r?.price || { skill_name: name, price_usdc: price, active: activeEl.checked });
		} catch (err) {
			errorEl.textContent = err?.body?.error || err?.message || 'Failed to add price';
			submitBtn.disabled = false;
			submitBtn.textContent = 'Add pricing';
		}
	});
}

// -- Payout Wallet Panel (monetization-specific) --

function renderPayoutWalletPanel(wallet, agentId, host, me, agents, legacyWallets) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	function paint(w) {
		const evmAddr = w?.evm_address || w?.evm || '';
		const solAddr = w?.solana_address || w?.solana || '';
		const preferred = w?.preferred_network || 'base';
		const balance = w?.available_balance ?? w?.balance ?? 0;

		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Payout Wallet</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Configure where earnings from this agent are sent.</div>
				</div>
				${balance > 0 ? `<span class="dn-tag success" style="font-size:13px">Balance: ${esc(formatUsdc(balance))}</span>` : ''}
			</div>

			<div class="mon-form-grid">
				<label class="mon-field">
					<span class="mon-label">EVM address (Base)</span>
					<input data-slot="evm" type="text" placeholder="0x..." class="mon-input mon-mono"
						value="${esc(evmAddr)}" />
					<span data-slot="evm-hint" class="mon-hint"></span>
				</label>
				<label class="mon-field">
					<span class="mon-label">Solana address</span>
					<input data-slot="solana" type="text" placeholder="Base58 address..." class="mon-input mon-mono"
						value="${esc(solAddr)}" />
					<span data-slot="sol-hint" class="mon-hint"></span>
				</label>
			</div>

			<div style="display:flex;align-items:center;gap:14px;margin-top:14px;flex-wrap:wrap">
				<label class="mon-field" style="margin-bottom:0;flex:1;min-width:160px">
					<span class="mon-label">Preferred network</span>
					<select data-slot="network" class="mon-select">
						<option value="base" ${preferred === 'base' ? 'selected' : ''}>Base (EVM)</option>
						<option value="solana" ${preferred === 'solana' ? 'selected' : ''}>Solana</option>
					</select>
				</label>
				<button class="dn-btn primary" data-action="save-wallet" style="align-self:flex-end">Save Wallet</button>
			</div>

			<div data-slot="wallet-error" class="mon-error"></div>
		`;

		const evmInput = panel.querySelector('[data-slot="evm"]');
		const solInput = panel.querySelector('[data-slot="solana"]');
		const evmHint = panel.querySelector('[data-slot="evm-hint"]');
		const solHint = panel.querySelector('[data-slot="sol-hint"]');
		const networkEl = panel.querySelector('[data-slot="network"]');
		const errorEl = panel.querySelector('[data-slot="wallet-error"]');

		evmInput.addEventListener('input', () => {
			const v = evmInput.value.trim();
			if (v && !EVM_ADDR_RE.test(v)) evmHint.textContent = 'Invalid EVM address (0x + 40 hex chars)';
			else evmHint.textContent = '';
		});

		solInput.addEventListener('input', () => {
			const v = solInput.value.trim();
			if (v && !SOLANA_ADDR_RE.test(v)) solHint.textContent = 'Invalid Solana address';
			else solHint.textContent = '';
		});

		panel.querySelector('[data-action="save-wallet"]').addEventListener('click', async () => {
			const evm = evmInput.value.trim();
			const sol = solInput.value.trim();
			const network = networkEl.value;
			errorEl.textContent = '';

			if (evm && !EVM_ADDR_RE.test(evm)) { errorEl.textContent = 'Invalid EVM address.'; return; }
			if (sol && !SOLANA_ADDR_RE.test(sol)) { errorEl.textContent = 'Invalid Solana address.'; return; }
			if (!evm && !sol) { errorEl.textContent = 'Enter at least one wallet address.'; return; }

			const btn = panel.querySelector('[data-action="save-wallet"]');
			btn.disabled = true;
			btn.textContent = 'Saving...';
			try {
				await put('/api/monetization/wallet', {
					agent_id: agentId,
					evm_address: evm || undefined,
					solana_address: sol || undefined,
					preferred_network: network,
				});
				toastMonetize('Payout wallet saved');
			} catch (err) {
				errorEl.textContent = err?.body?.error || err?.message || 'Save failed';
			}
			btn.disabled = false;
			btn.textContent = 'Save Wallet';
		});
	}

	paint(wallet);
	return panel;
}

// -- Revenue chart --

function renderRevenueChart({ initial, defaultRange }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap">
			<div>
				<div class="dn-panel-title">Revenue Over Time</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Net earnings after platform fees.</div>
			</div>
			<select data-slot="range" class="mon-select">
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
		const rangeMeta = RANGES.find((r) => r.key === rangeSel.value) || RANGES[1];
		panel.querySelector('.dn-panel-title').textContent = `Revenue · ${rangeMeta.label.toLowerCase()}`;
		paintCanvasChart(chartHost, ts);
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

function paintCanvasChart(host, timeseries) {
	if (!timeseries.length) {
		host.innerHTML = `<div class="dn-empty" style="height:100%;padding:24px"><h3>No revenue yet</h3><p>Payments will appear here as your agents earn.</p></div>`;
		return;
	}

	host.innerHTML = '';
	const canvas = document.createElement('canvas');
	canvas.style.cssText = 'width:100%;height:100%;display:block';
	host.appendChild(canvas);

	const dpr = window.devicePixelRatio || 1;
	const rect = host.getBoundingClientRect();
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);

	const W = rect.width;
	const H = rect.height;
	const PAD = { top: 20, right: 16, bottom: 32, left: 56 };
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const data = timeseries.map(p => ({
		label: formatChartPeriod(p.period),
		value: Number(p.net_total ?? 0) / 1_000_000,
	}));

	const max = Math.max(0.01, ...data.map(d => d.value));

	const points = data.map((d, i) => ({
		x: PAD.left + (i / Math.max(1, data.length - 1)) * innerW,
		y: PAD.top + innerH - (d.value / max) * innerH,
	}));

	// Animate draw
	let progress = 0;
	const duration = 600;
	const startTime = performance.now();

	function draw(now) {
		progress = Math.min(1, (now - startTime) / duration);
		const eased = 1 - Math.pow(1 - progress, 3);
		const visibleCount = Math.max(1, Math.ceil(eased * points.length));

		ctx.clearRect(0, 0, W, H);

		// Grid lines
		ctx.strokeStyle = 'rgba(255,255,255,0.06)';
		ctx.lineWidth = 0.5;
		for (let i = 0; i <= 4; i++) {
			const y = PAD.top + (i / 4) * innerH;
			ctx.beginPath();
			ctx.moveTo(PAD.left, y);
			ctx.lineTo(W - PAD.right, y);
			ctx.stroke();

			const val = ((4 - i) / 4) * max;
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.font = '10px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText('$' + val.toFixed(val >= 100 ? 0 : 2), PAD.left - 8, y + 4);
		}

		// X labels
		const showEvery = Math.max(1, Math.ceil(data.length / 10));
		ctx.fillStyle = 'rgba(255,255,255,0.3)';
		ctx.font = '10px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		data.forEach((d, i) => {
			if (i % showEvery === 0 && i < visibleCount) {
				ctx.fillText(d.label, points[i].x, H - 8);
			}
		});

		// Gradient fill
		const visible = points.slice(0, visibleCount);
		if (visible.length >= 2) {
			const gradient = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + innerH);
			gradient.addColorStop(0, 'rgba(74, 222, 128, 0.25)');
			gradient.addColorStop(1, 'rgba(74, 222, 128, 0)');

			ctx.beginPath();
			ctx.moveTo(visible[0].x, PAD.top + innerH);
			visible.forEach(p => ctx.lineTo(p.x, p.y));
			ctx.lineTo(visible[visible.length - 1].x, PAD.top + innerH);
			ctx.closePath();
			ctx.fillStyle = gradient;
			ctx.fill();

			// Line
			ctx.beginPath();
			ctx.moveTo(visible[0].x, visible[0].y);
			for (let i = 1; i < visible.length; i++) {
				const prev = visible[i - 1];
				const cur = visible[i];
				const cpx = (prev.x + cur.x) / 2;
				ctx.bezierCurveTo(cpx, prev.y, cpx, cur.y, cur.x, cur.y);
			}
			ctx.strokeStyle = '#4ade80';
			ctx.lineWidth = 2;
			ctx.stroke();

			// Dots at last point
			const last = visible[visible.length - 1];
			ctx.beginPath();
			ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
			ctx.fillStyle = '#4ade80';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0,0,0,0.4)';
			ctx.lineWidth = 1;
			ctx.stroke();
		}

		if (progress < 1) requestAnimationFrame(draw);
	}

	requestAnimationFrame(draw);

	// Tooltip on hover
	canvas.addEventListener('mousemove', (e) => {
		const br = canvas.getBoundingClientRect();
		const mx = e.clientX - br.left;
		let closest = 0;
		let closestDist = Infinity;
		points.forEach((p, i) => {
			const d = Math.abs(p.x - mx);
			if (d < closestDist) { closestDist = d; closest = i; }
		});
		canvas.title = `${data[closest].label}: $${data[closest].value.toFixed(4)}`;
	});
}

function formatChartPeriod(p) {
	const d = new Date(p);
	if (isNaN(d)) return String(p).slice(5, 10);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderSkillLegend(bySkill) {
	if (!bySkill.length) {
		return `<span style="color:var(--nxt-ink-fade)">Source breakdown unavailable for this range.</span>`;
	}
	const total = bySkill.reduce((s, r) => s + Number(r.net_total || 0), 0) || 1;
	const swatches = ['#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c'];
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

// -- Recent payments --

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
				<div class="dn-panel-title">Recent Payments</div>
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
				<table class="mon-table">
					<thead>
						<tr>
							<th>When</th>
							<th>Source</th>
							<th style="text-align:right">Amount</th>
							<th>Status</th>
							<th>Tx</th>
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
			: '--';
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
		<tr>
			<td style="color:var(--nxt-ink-dim);white-space:nowrap">${esc(relTime(p.created_at))}</td>
			<td>${source}</td>
			<td style="text-align:right;font-variant-numeric:tabular-nums">${esc(amount)}</td>
			<td>${tag}</td>
			<td>${tx}</td>
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
	if (!p.tx_hash && !p.tx_signature) return '<span style="color:var(--nxt-ink-fade)">--</span>';
	const hash = p.tx_hash || p.tx_signature;
	const explorer =
		p.chain_id === 8453
			? `https://basescan.org/tx/${encodeURIComponent(hash)}`
			: p.chain_id === 84532
				? `https://sepolia.basescan.org/tx/${encodeURIComponent(hash)}`
				: p.chain === 'solana'
					? `https://solscan.io/tx/${encodeURIComponent(hash)}`
					: `https://etherscan.io/tx/${encodeURIComponent(hash)}`;
	return `<a href="${explorer}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">${esc(hash.slice(0, 10))}...</a>`;
}

function formatWeiAsEth(wei) {
	try {
		const eth = Number(BigInt(wei)) / 1e18;
		if (!Number.isFinite(eth)) return '--';
		if (eth >= 0.0001) return `${eth.toFixed(4)} ETH`;
		if (eth > 0) return `${eth.toExponential(2)} ETH`;
		return '0 ETH';
	} catch {
		return '--';
	}
}

// -- Withdrawals --

function renderWithdrawals({ withdrawals, wallets, available, host, me, agents }) {
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

	const openModal = () => openWithdrawModal({ available, wallets, host, me, agents });
	panel.querySelector('[data-action="open-withdraw"]').addEventListener('click', openModal);
	document.addEventListener('dn:monetize:open-withdraw', openModal);

	return panel;
}

function withdrawalsTable(rows, { title, showArrival }) {
	const head = title ? `<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--nxt-ink-fade);margin:0 0 8px">${esc(title)}</div>` : '';
	return `
		${head}
		<div style="overflow-x:auto">
			<table class="mon-table">
				<thead>
					<tr>
						<th>ID</th>
						<th style="text-align:right">Amount</th>
						<th>Chain</th>
						<th>Status</th>
						<th>${showArrival ? 'Est. arrival' : 'Tx'}</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((w) => `
						<tr>
							<td style="font-family:ui-monospace,monospace;font-size:11px;color:var(--nxt-ink-dim)">${esc(String(w.id).slice(0, 8))}...</td>
							<td style="text-align:right;font-variant-numeric:tabular-nums">${esc(formatUsdc(Number(w.amount)))}</td>
							<td style="color:var(--nxt-ink-dim)">${esc(w.chain)}</td>
							<td>${statusTag(w.status)}</td>
							<td style="color:var(--nxt-ink-dim)">${showArrival ? estArrival(w) : withdrawalTx(w)}</td>
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
	if (!w.tx_signature) return '<span style="color:var(--nxt-ink-fade)">--</span>';
	const sig = encodeURIComponent(w.tx_signature);
	const url =
		w.chain === 'solana'
			? `https://solscan.io/tx/${sig}`
			: w.chain === 'base'
				? `https://basescan.org/tx/${sig}`
				: `https://etherscan.io/tx/${sig}`;
	return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">view</a>`;
}

// -- Withdraw modal --

function openWithdrawModal({ available, wallets, host, me, agents }) {
	const existing = document.querySelector('[data-monetize-modal]');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.setAttribute('data-monetize-modal', 'true');
	overlay.className = 'mon-overlay';
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Withdraw USDC" class="mon-modal">
			<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
				<div>
					<div style="font-size:16px;font-weight:600;color:var(--nxt-ink)">Withdraw USDC</div>
					<div style="font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px">Available: ${esc(formatUsdc(available))}</div>
				</div>
				<button class="dn-btn ghost" data-action="close" aria-label="Close" style="padding:4px 10px;font-size:18px">x</button>
			</div>

			<label class="mon-field">
				<span class="mon-label">Chain</span>
				<select data-slot="chain" class="mon-select">
					<option value="solana">Solana (USDC)</option>
					<option value="base">Base (USDC)</option>
				</select>
			</label>

			<label class="mon-field">
				<span class="mon-label">Destination address</span>
				<input data-slot="address" type="text" placeholder="Wallet address" class="mon-input mon-mono" />
				<span data-slot="addr-hint" class="mon-hint"></span>
			</label>

			<label class="mon-field">
				<span class="mon-label">Amount (USDC)</span>
				<div style="display:flex;gap:8px">
					<input data-slot="amount" type="number" min="1" step="0.000001" placeholder="0.00" class="mon-input" style="flex:1" />
					<button class="dn-btn" data-action="max" type="button">Max</button>
				</div>
			</label>

			<div data-slot="error" class="mon-error"></div>

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
		submitBtn.textContent = 'Submitting...';
		try {
			// Try both endpoints
			try {
				await post('/api/monetization/withdrawals', {
					amount: atomics,
					chain,
					to_address: addr,
				});
			} catch {
				await post('/api/billing/withdrawals', {
					amount: atomics,
					chain,
					currency_mint: USDC_MINTS[chain],
					to_address: addr,
				});
			}
			close();
			toastMonetize('Withdrawal submitted');
			renderSkeleton(host);
			await loadAndRender(host, me, agents);
		} catch (err) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Request withdrawal';
			errorEl.textContent =
				err?.body?.error_description || err?.message || 'Withdrawal request failed.';
		}
	});
}

// -- Legacy Payout wallets --

function renderLegacyPayoutWallets({ wallets, host, me, agents }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.setAttribute('data-payout-wallets-panel', '');

	const render = (ws) => {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Saved Payout Wallets</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Default addresses for withdrawals. One per chain.</div>
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
			openAddPayoutWalletModal({ panel, host, me, agents });
		});

		panel.querySelectorAll('[data-action="remove-payout-wallet"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const id = btn.dataset.id;
				btn.disabled = true;
				btn.textContent = 'Removing...';
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

function openAddPayoutWalletModal({ panel, host, me, agents }) {
	const existing = document.querySelector('[data-add-payout-modal]');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.setAttribute('data-add-payout-modal', '');
	overlay.className = 'mon-overlay';
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" aria-label="Add payout wallet" class="mon-modal">
			<div style="font-size:16px;font-weight:600;color:var(--nxt-ink);margin-bottom:18px">Add payout wallet</div>

			<label class="mon-field">
				<span class="mon-label">Chain</span>
				<select data-slot="chain" class="mon-select">
					<option value="solana">Solana</option>
					<option value="base">Base (EVM)</option>
				</select>
			</label>

			<label class="mon-field">
				<span class="mon-label">Wallet address</span>
				<input data-slot="address" type="text" placeholder="Paste address..." class="mon-input mon-mono" />
			</label>

			<label class="mon-field">
				<span class="mon-label">Label (optional)</span>
				<input data-slot="label" type="text" maxlength="60" placeholder="e.g. Main treasury" class="mon-input" />
			</label>

			<div data-slot="error" class="mon-error"></div>

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
		submitBtn.textContent = 'Saving...';
		try {
			await post('/api/billing/payout-wallets', { chain, address, label: label || undefined });
			close();
			toastMonetize('Wallet saved');
			renderSkeleton(host);
			await loadAndRender(host, me, agents);
		} catch (err) {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Save wallet';
			errorEl.textContent = err?.body?.error || err?.message || 'Save failed.';
		}
	});
}

// -- Plan & usage --

function renderPlanUsage(summary) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const plan = summary?.plan || 'free';
	const quotas = summary?.quotas;
	const usage = summary?.usage || {};

	const meter = (label, used, max, fmt = (n) => String(n)) => {
		const pct = max ? Math.min(100, (used / max) * 100) : 0;
		const color = pct > 90 ? 'var(--nxt-danger)' : pct > 70 ? 'var(--nxt-warn)' : 'var(--nxt-success)';
		return `
			<div style="margin-bottom:14px">
				<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
					<span>${esc(label)}</span>
					<span style="color:var(--nxt-ink-fade)">${esc(fmt(used))} / ${max ? esc(fmt(max)) : 'unlimited'}</span>
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
				<div class="dn-panel-title">Plan & Usage</div>
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

// -- Token earnings --

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
					<div class="dn-panel-title">Token Earnings</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Royalties from Pump.fun tokens your agents launched.</div>
				</div>
				<a class="dn-btn" href="/dashboard/tokens">Token dashboard</a>
			</div>
			<div class="dn-empty">
				<h3>No tokens launched</h3>
				<p>Launch a Pump.fun token from any agent to earn royalties on every trade.</p>
				<a class="dn-btn primary" href="/dashboard/agents">Go to Agents</a>
			</div>
		`;
		return panel;
	}

	panel.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
			<div>
				<div class="dn-panel-title">Token Earnings</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">Royalties from Pump.fun tokens your agents launched.</div>
			</div>
			<a class="dn-btn" href="/dashboard/tokens">Full token dashboard</a>
		</div>
		<div style="overflow-x:auto">
			<table class="mon-table">
				<thead>
					<tr>
						<th>Ticker</th>
						<th style="text-align:right">Holders</th>
						<th style="text-align:right">Royalties</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					${launched.map((a) => {
						const meta = a.meta?.pumpfun || a.meta?.token || {};
						const mint = meta.mint || meta.address || meta.ca || '';
						const ticker = meta.symbol || meta.ticker || a.name || 'TOKEN';
						const holders = meta.holders ?? '--';
						const royalties = meta.royalties_atomics ? formatUsdc(meta.royalties_atomics) : '--';
						return `
							<tr>
								<td style="font-weight:600">$${esc(String(ticker).toUpperCase())}</td>
								<td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--nxt-ink-dim)">${esc(String(holders))}</td>
								<td style="text-align:right;font-variant-numeric:tabular-nums">${esc(royalties)}</td>
								<td>
									${mint
										? `<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="color:var(--nxt-accent);font-size:12px">View token</a>`
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

// -- Subscription plans (creator) --

function renderSubscriptionPlans({ creatorPlans, me }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	let plans = [...creatorPlans];

	function paint() {
		panel.innerHTML = `
			<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
				<div>
					<div class="dn-panel-title">Subscription Plans</div>
					<div class="dn-panel-sub" style="margin:2px 0 0">Plans you offer. Users can subscribe to unlock premium access to your agents.</div>
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
					<table class="mon-table">
						<thead>
							<tr>
								<th>Plan</th>
								<th style="text-align:right">Price</th>
								<th>Interval</th>
								<th>Status</th>
								<th style="text-align:right"></th>
							</tr>
						</thead>
						<tbody>
							${plans.map((p) => `
								<tr>
									<td>
										<div style="font-weight:600">${esc(p.name || 'Unnamed plan')}</div>
										${p.description ? `<div style="font-size:12px;color:var(--nxt-ink-dim)">${esc(p.description.slice(0, 80))}</div>` : ''}
									</td>
									<td style="text-align:right;font-variant-numeric:tabular-nums">
										$${esc(Number(p.price_usd || 0).toFixed(2))}
									</td>
									<td style="color:var(--nxt-ink-dim)">${esc(p.interval || 'monthly')}</td>
									<td>
										${p.active
											? `<span class="dn-tag success">Active</span>`
											: `<span class="dn-tag">Inactive</span>`
										}
									</td>
									<td style="text-align:right">
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
				btn.textContent = 'Deleting...';
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
	overlay.className = 'mon-overlay';
	overlay.innerHTML = `
		<div role="dialog" aria-modal="true" class="mon-modal" style="width:min(460px,100%)">
			<div style="font-size:16px;font-weight:600;margin-bottom:18px">${existing ? 'Edit plan' : 'Create plan'}</div>

			<label class="mon-field">
				<span class="mon-label">Plan name</span>
				<input data-slot="name" type="text" maxlength="80" value="${esc(existing?.name || '')}"
					placeholder="e.g. Pro access, VIP, Founder..." class="mon-input" />
			</label>

			<label class="mon-field">
				<span class="mon-label">Description (optional)</span>
				<textarea data-slot="description" maxlength="300" rows="2"
					placeholder="What does this plan unlock?" class="mon-input" style="resize:vertical">${esc(existing?.description || '')}</textarea>
			</label>

			<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
				<label class="mon-field">
					<span class="mon-label">Price (USD)</span>
					<input data-slot="price" type="number" min="0.5" step="0.01" value="${esc(String(existing?.price_usd || ''))}"
						placeholder="9.99" class="mon-input" />
				</label>
				<label class="mon-field">
					<span class="mon-label">Interval</span>
					<select data-slot="interval" class="mon-select">
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

			<div data-slot="error" class="mon-error"></div>

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
		submitBtn.textContent = existing ? 'Saving...' : 'Creating...';
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

// -- Toast --

function toastMonetize(msg, isError) {
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
	if (isError) el.style.borderColor = 'var(--nxt-danger)';
	else el.style.borderColor = 'var(--nxt-stroke-strong)';
	requestAnimationFrame(() => {
		el.style.opacity = '1';
		el.style.transform = 'translateX(-50%) translateY(0)';
	});
	clearTimeout(el._t);
	el._t = setTimeout(() => {
		el.style.opacity = '0';
		el.style.transform = 'translateX(-50%) translateY(20px)';
	}, 2400);
}

// -- Skeleton --

function renderSkeleton(host) {
	host.innerHTML = `
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
			${Array.from({ length: 4 }).map(() => `
				<div class="dn-panel">
					<div class="dn-skeleton" style="height:14px;width:60%;margin-bottom:14px"></div>
					<div class="dn-skeleton" style="height:32px;width:80%;margin-bottom:10px"></div>
					<div class="dn-skeleton" style="height:12px;width:90%"></div>
				</div>`).join('')}
		</div>
		<div class="dn-panel" style="margin-top:18px">
			<div class="dn-skeleton" style="height:14px;width:30%;margin-bottom:14px"></div>
			<div class="dn-skeleton" style="height:180px;width:100%;border-radius:8px"></div>
		</div>
		<div class="dn-panel" style="margin-top:18px">
			<div class="dn-skeleton" style="height:14px;width:25%;margin-bottom:14px"></div>
			<div class="dn-skeleton" style="height:240px;width:100%;border-radius:8px"></div>
		</div>
	`;
}

// -- Styles --

function injectStyles() {
	if (document.getElementById('mon-styles')) return;
	const style = document.createElement('style');
	style.id = 'mon-styles';
	style.textContent = `
/* Monetize page styles */
.mon-select {
	padding: 8px 14px;
	border-radius: 8px;
	border: 1px solid var(--nxt-stroke);
	background: rgba(255,255,255,0.04);
	color: var(--nxt-ink);
	font: inherit;
	font-size: 13px;
	cursor: pointer;
	transition: border-color 0.12s;
}
.mon-select:hover { border-color: var(--nxt-stroke-strong); }
.mon-select:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }

.mon-input {
	padding: 9px 12px;
	border-radius: 8px;
	border: 1px solid var(--nxt-stroke);
	background: rgba(255,255,255,0.04);
	color: var(--nxt-ink);
	font: inherit;
	font-size: 13px;
	transition: border-color 0.12s, box-shadow 0.12s;
	width: 100%;
}
.mon-input:hover { border-color: var(--nxt-stroke-strong); }
.mon-input:focus { border-color: var(--nxt-accent); box-shadow: 0 0 0 2px rgba(255,255,255,0.06); outline: none; }
.mon-input-sm { width: 120px; text-align: right; }
.mon-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }

.mon-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.mon-label { font-size: 12px; color: var(--nxt-ink-dim); font-weight: 500; }
.mon-hint { font-size: 11.5px; color: var(--nxt-ink-fade); }
.mon-error { font-size: 12.5px; color: var(--nxt-danger); min-height: 18px; margin-bottom: 10px; }
.mon-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.mon-overlay {
	position: fixed; inset: 0; z-index: 1000;
	background: rgba(8,9,14,0.72); backdrop-filter: blur(6px);
	display: grid; place-items: center; padding: 20px;
}
.mon-modal {
	width: min(440px, 100%);
	background: linear-gradient(180deg, rgba(22,24,32,0.97), rgba(16,17,24,0.97));
	border: 1px solid var(--nxt-stroke-strong);
	border-radius: 14px;
	padding: 24px;
	box-shadow: 0 20px 60px rgba(0,0,0,0.6);
}

.mon-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
	min-width: 560px;
}
.mon-table th {
	text-align: left;
	font-weight: 500;
	color: var(--nxt-ink-fade);
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	padding: 8px 10px;
	border-bottom: 1px solid var(--nxt-stroke);
}
.mon-table td {
	padding: 10px;
	border-bottom: 1px solid var(--nxt-stroke);
}
.mon-table tbody tr {
	transition: background 0.1s;
}
.mon-table tbody tr:hover {
	background: rgba(255,255,255,0.02);
}

/* Toggle switch */
.mon-toggle {
	position: relative;
	display: inline-block;
	width: 36px;
	height: 20px;
	cursor: pointer;
}
.mon-toggle input {
	opacity: 0;
	width: 0;
	height: 0;
	position: absolute;
}
.mon-toggle-track {
	position: absolute;
	inset: 0;
	background: var(--nxt-stroke-strong);
	border-radius: 10px;
	transition: background 0.2s;
}
.mon-toggle-track::before {
	content: '';
	position: absolute;
	top: 2px;
	left: 2px;
	width: 16px;
	height: 16px;
	background: var(--nxt-ink);
	border-radius: 50%;
	transition: transform 0.2s;
}
.mon-toggle input:checked + .mon-toggle-track {
	background: var(--nxt-success);
}
.mon-toggle input:checked + .mon-toggle-track::before {
	transform: translateX(16px);
}
.mon-toggle input:focus-visible + .mon-toggle-track {
	outline: 2px solid var(--nxt-accent);
	outline-offset: 2px;
}

@media (max-width: 640px) {
	.mon-form-grid { grid-template-columns: 1fr; }
	.mon-input-sm { width: 80px; }
	.mon-table { min-width: 480px; }
}
`;
	document.head.appendChild(style);
}
