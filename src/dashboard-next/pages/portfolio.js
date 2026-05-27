import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime, formatUsdc, ApiError } from '../api.js';
import { createChart, AreaSeries, LineSeries } from 'lightweight-charts';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

const CHAIN_LABELS = { solana: 'Solana', evm: 'Ethereum', base: 'Base', polygon: 'Polygon' };
const CHAIN_EXPLORER = {
	solana: (addr) => `https://solscan.io/account/${addr}`,
	evm: (addr) => `https://etherscan.io/address/${addr}`,
};
const TX_EXPLORER = {
	solana: (hash) => `https://solscan.io/tx/${hash}`,
	evm: (hash) => `https://etherscan.io/tx/${hash}`,
};

let _chartInstance = null;
let _assetChartInstance = null;

(async function boot() {
	try {
		const main = await mountShell();
		const me = await requireUser();

		main.innerHTML = `
			<h1 class="dn-h1">Portfolio</h1>
			<p class="dn-h1-sub">Live balances, holdings, and market data across your agent wallets.</p>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:16px">
				${skel(3)}
			</div>
		`;
		const host = main.querySelector('[data-slot="content"]');

		injectStyles();

		const [summaryRes, historyRes] = await Promise.allSettled([
			get('/api/portfolio/summary?snapshot=1'),
			get('/api/portfolio/history?days=90'),
		]);

		const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
		const history = historyRes.status === 'fulfilled' ? historyRes.value : null;

		host.innerHTML = '';

		if (!summary || !summary.wallets?.length) {
			host.innerHTML = `
				<div class="dn-panel pf-empty-hero">
					<div class="pf-empty-icon">
						<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
							<rect x="4" y="14" width="32" height="22" rx="3"/>
							<path d="M12 14V10a8 8 0 0116 0v4"/>
							<path d="M4 22h32"/>
							<circle cx="28" cy="25" r="2.5"/>
						</svg>
					</div>
					<h3>No agent wallets</h3>
					<p>Create an agent with a wallet to start tracking your portfolio.</p>
					<a class="dn-btn primary" href="/dashboard/agents">Create agent →</a>
				</div>`;
			return;
		}

		host.appendChild(renderHero(summary, history));
		host.appendChild(renderWallets(summary));
		host.appendChild(renderHoldings(summary));

		const detailPanel = document.createElement('div');
		detailPanel.setAttribute('data-slot', 'asset-detail');
		host.appendChild(detailPanel);

	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

function skel(n) {
	return Array.from({ length: n }, () =>
		`<div class="dn-skeleton" style="height:120px;border-radius:12px"></div>`,
	).join('');
}

// ── Hero: total value + portfolio history chart ────────────────────────────

function renderHero(summary, history) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel pf-hero';

	const totalUsd = summary.total_usd || 0;
	const points = history?.points || [];

	const prevUsd = points.length >= 2 ? points[0].usd : totalUsd;
	const changeUsd = totalUsd - prevUsd;
	const changePct = prevUsd > 0 ? (changeUsd / prevUsd) * 100 : 0;
	const changeClass = changeUsd >= 0 ? 'pf-gain' : 'pf-loss';
	const changeSign = changeUsd >= 0 ? '+' : '';

	panel.innerHTML = `
		<div class="pf-hero-top">
			<div class="pf-hero-value-wrap">
				<div class="pf-hero-label">Total portfolio value</div>
				<div class="pf-hero-value">$${fmtUsd(totalUsd)}</div>
				<div class="pf-hero-change ${changeClass}">
					${changeSign}$${fmtUsd(Math.abs(changeUsd))}
					<span>(${changeSign}${changePct.toFixed(2)}%)</span>
					<span class="pf-hero-period">90d</span>
				</div>
			</div>
			<div class="pf-hero-meta">
				<div class="pf-hero-meta-item">
					<span class="pf-hero-meta-label">Wallets</span>
					<span class="pf-hero-meta-val">${summary.wallets.length}</span>
				</div>
				<div class="pf-hero-meta-item">
					<span class="pf-hero-meta-label">Tokens</span>
					<span class="pf-hero-meta-val">${countTokens(summary)}</span>
				</div>
				<div class="pf-hero-meta-item">
					<span class="pf-hero-meta-label">Updated</span>
					<span class="pf-hero-meta-val">${relTime(summary.captured_at)}</span>
				</div>
			</div>
		</div>
		<div class="pf-chart-wrap" data-slot="chart"></div>
	`;

	requestAnimationFrame(() => {
		const chartEl = panel.querySelector('[data-slot="chart"]');
		if (!chartEl || points.length < 2) {
			if (chartEl) chartEl.innerHTML = '<div class="pf-chart-empty">Not enough history for a chart yet. Check back after a day or two.</div>';
			return;
		}
		renderPortfolioChart(chartEl, points);
	});

	return panel;
}

function renderPortfolioChart(container, points) {
	if (_chartInstance) { _chartInstance.remove(); _chartInstance = null; }

	const chart = createChart(container, {
		width: container.clientWidth,
		height: 220,
		layout: {
			background: { color: 'transparent' },
			textColor: '#888888',
			fontFamily: `'JetBrains Mono', monospace`,
			fontSize: 11,
		},
		grid: {
			vertLines: { color: 'rgba(255,255,255,0.04)' },
			horzLines: { color: 'rgba(255,255,255,0.04)' },
		},
		rightPriceScale: {
			borderColor: 'rgba(255,255,255,0.08)',
		},
		timeScale: {
			borderColor: 'rgba(255,255,255,0.08)',
			timeVisible: false,
		},
		crosshair: {
			horzLine: { color: 'rgba(255,255,255,0.15)', style: 2 },
			vertLine: { color: 'rgba(255,255,255,0.15)', style: 2 },
		},
	});
	_chartInstance = chart;

	const isPositive = points.length >= 2 && points[points.length - 1].usd >= points[0].usd;
	const lineColor = isPositive ? '#4ade80' : '#f87171';
	const topColor = isPositive ? 'rgba(74, 222, 128, 0.25)' : 'rgba(248, 113, 113, 0.25)';

	const series = chart.addSeries(AreaSeries, {
		lineColor,
		topColor,
		bottomColor: 'transparent',
		lineWidth: 2,
		priceFormat: { type: 'custom', formatter: (v) => '$' + fmtUsd(v) },
	});

	const data = points.map((p) => ({
		time: p.t.slice(0, 10),
		value: p.usd,
	}));

	const deduped = [];
	const seen = new Set();
	for (const d of data) {
		if (!seen.has(d.time)) { seen.add(d.time); deduped.push(d); }
	}
	series.setData(deduped);
	chart.timeScale().fitContent();

	const ro = new ResizeObserver(() => {
		chart.applyOptions({ width: container.clientWidth });
	});
	ro.observe(container);
}

// ── Wallet cards ──────────────────────────────────────────────────────────

function renderWallets(summary) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.innerHTML = `
		<div class="pf-section-head">
			<div>
				<div class="dn-panel-title">Agent wallets</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">${summary.wallets.length} wallet${summary.wallets.length === 1 ? '' : 's'} across ${new Set(summary.wallets.map(w => w.chain)).size} chain${new Set(summary.wallets.map(w => w.chain)).size === 1 ? '' : 's'}.</div>
			</div>
		</div>
		<div class="pf-wallets" data-slot="wallets"></div>
	`;

	const grid = panel.querySelector('[data-slot="wallets"]');
	for (const w of summary.wallets) {
		const card = document.createElement('div');
		card.className = 'pf-wallet-card';
		const addr = w.address || '';
		const short = addr.slice(0, 6) + '…' + addr.slice(-4);
		const chainLabel = CHAIN_LABELS[w.chain] || w.chain;
		const explorerUrl = (CHAIN_EXPLORER[w.chain] || (() => '#'))(addr);
		const tokenCount = (w.tokens || []).length;
		const snsLabel = w.sns ? `<span class="pf-wallet-sns">${esc(w.sns)}</span>` : '';

		card.innerHTML = `
			<div class="pf-wallet-top">
				<div class="pf-wallet-chain-badge">${chainLabel}</div>
				<a href="${explorerUrl}" target="_blank" rel="noopener" class="pf-wallet-explorer" title="View on explorer">↗</a>
			</div>
			<div class="pf-wallet-name">${esc(w.agent_name)}${snsLabel}</div>
			<div class="pf-wallet-addr" style="font-family:${MONO}">${short}</div>
			<div class="pf-wallet-bal">
				<div class="pf-wallet-bal-main">$${fmtUsd(w.usd)}</div>
				<div class="pf-wallet-bal-sub">${esc(fmtAmount(w.native?.amount))} ${esc(w.native?.symbol || '')} + ${tokenCount} token${tokenCount === 1 ? '' : 's'}</div>
			</div>
			${!w.ok && w.error ? `<div class="pf-wallet-err">${esc(w.error)}</div>` : ''}
		`;
		grid.appendChild(card);
	}
	return panel;
}

// ── Holdings table ────────────────────────────────────────────────────────

function renderHoldings(summary) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	const allTokens = [];
	for (const w of summary.wallets) {
		if (w.native && w.native.amount > 0) {
			allTokens.push({
				chain: w.chain,
				id: 'native',
				symbol: w.native.symbol,
				name: w.native.name || w.native.symbol,
				amount: w.native.amount,
				price: w.native.price || 0,
				change24h: w.native.change24h,
				usd: w.native.usd || 0,
				logo: null,
				agent: w.agent_name,
				address: w.address,
			});
		}
		for (const t of (w.tokens || [])) {
			allTokens.push({
				chain: w.chain,
				id: t.mint || t.contract || '',
				symbol: t.symbol,
				name: t.name || t.symbol,
				amount: t.amount,
				price: t.price || 0,
				change24h: t.change24h,
				usd: t.usd || 0,
				logo: t.logo,
				agent: w.agent_name,
				address: w.address,
			});
		}
	}

	const merged = mergeHoldings(allTokens);
	merged.sort((a, b) => (b.usd || 0) - (a.usd || 0));

	panel.innerHTML = `
		<div class="pf-section-head">
			<div>
				<div class="dn-panel-title">Holdings</div>
				<div class="dn-panel-sub" style="margin:2px 0 0">${merged.length} asset${merged.length === 1 ? '' : 's'} across all wallets.</div>
			</div>
		</div>
		<div data-slot="holdings"></div>
	`;

	const host = panel.querySelector('[data-slot="holdings"]');

	if (!merged.length) {
		host.innerHTML = `
			<div class="dn-empty">
				<h3>No holdings</h3>
				<p>Your agent wallets are empty. Fund a wallet or launch a token to see holdings here.</p>
			</div>`;
		return panel;
	}

	host.innerHTML = `
		<div style="overflow-x:auto">
			<table class="pf-table">
				<thead>
					<tr>
						<th class="pf-th" style="min-width:180px">Asset</th>
						<th class="pf-th right">Price</th>
						<th class="pf-th right">24h</th>
						<th class="pf-th right">Balance</th>
						<th class="pf-th right">Value</th>
						<th class="pf-th right">Allocation</th>
					</tr>
				</thead>
				<tbody data-slot="rows"></tbody>
			</table>
		</div>
	`;

	const totalUsd = merged.reduce((s, t) => s + (t.usd || 0), 0);
	const tbody = host.querySelector('[data-slot="rows"]');

	for (const t of merged) {
		const tr = document.createElement('tr');
		tr.className = 'pf-row';
		tr.style.cursor = 'pointer';
		tr.setAttribute('data-chain', t.chain);
		tr.setAttribute('data-id', t.id);

		const pct = totalUsd > 0 ? ((t.usd / totalUsd) * 100) : 0;
		const changeHtml = renderChange(t.change24h);
		const logoHtml = t.logo
			? `<img src="${esc(t.logo)}" alt="" class="pf-token-logo" loading="lazy" />`
			: `<div class="pf-token-logo pf-token-logo-placeholder">${esc((t.symbol || '?')[0])}</div>`;

		tr.innerHTML = `
			<td class="pf-td">
				<div class="pf-token-cell">
					${logoHtml}
					<div>
						<div class="pf-token-symbol">${esc(t.symbol)}</div>
						<div class="pf-token-name">${esc(t.name)}</div>
					</div>
				</div>
			</td>
			<td class="pf-td right" style="font-variant-numeric:tabular-nums">$${fmtPrice(t.price)}</td>
			<td class="pf-td right">${changeHtml}</td>
			<td class="pf-td right" style="font-variant-numeric:tabular-nums">${esc(fmtAmount(t.amount))}</td>
			<td class="pf-td right" style="font-variant-numeric:tabular-nums;font-weight:600">$${fmtUsd(t.usd)}</td>
			<td class="pf-td right">
				<div class="pf-alloc-bar-wrap">
					<div class="pf-alloc-bar" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
					<span class="pf-alloc-label">${pct.toFixed(1)}%</span>
				</div>
			</td>
		`;

		tr.addEventListener('click', () => openAssetDetail(t));
		tbody.appendChild(tr);
	}

	return panel;
}

function mergeHoldings(tokens) {
	const map = new Map();
	for (const t of tokens) {
		const key = `${t.chain}:${t.id}`;
		if (map.has(key)) {
			const existing = map.get(key);
			existing.amount += t.amount;
			existing.usd += t.usd;
			if (!existing.price && t.price) existing.price = t.price;
			if (existing.change24h == null && t.change24h != null) existing.change24h = t.change24h;
			if (!existing.logo && t.logo) existing.logo = t.logo;
		} else {
			map.set(key, { ...t });
		}
	}
	return [...map.values()];
}

// ── Asset detail panel ────────────────────────────────────────────────────

async function openAssetDetail(token) {
	const host = document.querySelector('[data-slot="asset-detail"]');
	if (!host) return;

	host.innerHTML = `
		<div class="dn-panel pf-detail" id="pf-detail">
			<div class="pf-detail-loading">
				<div class="pf-detail-header">
					<button class="pf-detail-close" aria-label="Close" data-action="close-detail">&times;</button>
				</div>
				${skel(1)}
			</div>
		</div>
	`;
	host.querySelector('[data-action="close-detail"]').addEventListener('click', () => { host.innerHTML = ''; });
	host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

	try {
		const data = await get(`/api/portfolio/asset?chain=${encodeURIComponent(token.chain)}&id=${encodeURIComponent(token.id)}&days=30`);
		renderAssetDetail(host, data);
	} catch (err) {
		host.querySelector('.pf-detail-loading').innerHTML = `
			<div class="pf-detail-header">
				<button class="pf-detail-close" data-action="close-detail">&times;</button>
			</div>
			<div style="color:var(--nxt-danger);padding:16px">Failed to load asset data: ${esc(err.message)}</div>
		`;
		host.querySelector('[data-action="close-detail"]').addEventListener('click', () => { host.innerHTML = ''; });
	}
}

function renderAssetDetail(host, data) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel pf-detail';
	panel.id = 'pf-detail';

	const market = data.market || {};
	const symbol = data.symbol || '?';
	const logoHtml = data.logo
		? `<img src="${esc(data.logo)}" alt="" class="pf-detail-logo" />`
		: `<div class="pf-detail-logo pf-token-logo-placeholder" style="width:40px;height:40px;font-size:18px">${esc(symbol[0])}</div>`;

	const changeHtml = renderChange(market.change_24h_pct);
	const hasChart = data.chart?.points?.length >= 2;

	panel.innerHTML = `
		<div class="pf-detail-header">
			<div class="pf-detail-title-row">
				${logoHtml}
				<div>
					<div class="pf-detail-symbol">${esc(symbol)}</div>
					<div class="pf-detail-name">${esc(market.name || data.name || symbol)}</div>
				</div>
			</div>
			<button class="pf-detail-close" data-action="close-detail">&times;</button>
		</div>

		<div class="pf-detail-price-row">
			<div class="pf-detail-price">$${fmtPrice(data.unit_price_usd)}</div>
			${changeHtml}
		</div>

		${hasChart ? '<div class="pf-asset-chart-wrap" data-slot="asset-chart"></div>' : ''}

		<div class="pf-detail-stats">
			${statItem('Your balance', `${fmtAmount(data.total_amount)} ${esc(symbol)}`)}
			${statItem('Your value', `$${fmtUsd(data.total_usd)}`)}
			${market.market_cap_usd ? statItem('Market cap', `$${fmtCompact(market.market_cap_usd)}`) : ''}
			${market.total_volume_usd ? statItem('24h volume', `$${fmtCompact(market.total_volume_usd)}`) : ''}
			${market.high_24h_usd ? statItem('24h high', `$${fmtPrice(market.high_24h_usd)}`) : ''}
			${market.low_24h_usd ? statItem('24h low', `$${fmtPrice(market.low_24h_usd)}`) : ''}
			${market.change_7d_pct != null ? statItem('7d change', renderChangeText(market.change_7d_pct)) : ''}
			${market.change_30d_pct != null ? statItem('30d change', renderChangeText(market.change_30d_pct)) : ''}
			${market.ath_usd ? statItem('All-time high', `$${fmtPrice(market.ath_usd)}`) : ''}
		</div>

		${data.holdings?.length ? renderHoldingsBreakdown(data) : ''}

		${renderSendForm(data)}

		${market.description ? `<div class="pf-detail-desc">${esc(market.description)}</div>` : ''}
	`;

	host.innerHTML = '';
	host.appendChild(panel);

	host.querySelector('[data-action="close-detail"]').addEventListener('click', () => { host.innerHTML = ''; });

	if (hasChart) {
		requestAnimationFrame(() => {
			const chartEl = panel.querySelector('[data-slot="asset-chart"]');
			if (chartEl) renderAssetChart(chartEl, data.chart.points);
		});
	}

	const form = panel.querySelector('[data-slot="send-form"]');
	if (form) mountSendForm(form, data);
}

function renderAssetChart(container, points) {
	if (_assetChartInstance) { _assetChartInstance.remove(); _assetChartInstance = null; }

	const chart = createChart(container, {
		width: container.clientWidth,
		height: 180,
		layout: {
			background: { color: 'transparent' },
			textColor: '#888888',
			fontFamily: `'JetBrains Mono', monospace`,
			fontSize: 10,
		},
		grid: {
			vertLines: { color: 'rgba(255,255,255,0.03)' },
			horzLines: { color: 'rgba(255,255,255,0.03)' },
		},
		rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
		timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true },
		crosshair: {
			horzLine: { color: 'rgba(255,255,255,0.12)', style: 2 },
			vertLine: { color: 'rgba(255,255,255,0.12)', style: 2 },
		},
	});
	_assetChartInstance = chart;

	const isPositive = points.length >= 2 && points[points.length - 1].price >= points[0].price;
	const lineColor = isPositive ? '#4ade80' : '#f87171';

	const series = chart.addSeries(LineSeries, {
		color: lineColor,
		lineWidth: 2,
		priceFormat: { type: 'custom', formatter: (v) => '$' + fmtPrice(v) },
	});

	const data = points.map((p) => {
		const d = new Date(p.t);
		return { time: Math.floor(d.getTime() / 1000), value: p.price };
	});
	series.setData(data);
	chart.timeScale().fitContent();

	const ro = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
	ro.observe(container);
}

function renderHoldingsBreakdown(data) {
	if (!data.holdings?.length) return '';
	return `
		<div class="pf-detail-section-label">Held in</div>
		<div class="pf-detail-holdings">
			${data.holdings.map((h) => `
				<div class="pf-detail-holding-row">
					<div>
						<span class="pf-detail-holding-agent">${esc(h.agent_name)}</span>
						<span class="pf-detail-holding-addr" style="font-family:${MONO}">${h.address.slice(0, 6)}…${h.address.slice(-4)}</span>
					</div>
					<div class="pf-detail-holding-val">
						<span>${fmtAmount(h.amount)}</span>
						<span style="color:var(--nxt-ink-dim)">$${fmtUsd(h.usd)}</span>
					</div>
				</div>
			`).join('')}
		</div>
	`;
}

function renderSendForm(data) {
	if (!data.holdings?.length) return '';
	return `
		<div class="pf-detail-section-label">Send ${esc(data.symbol)}</div>
		<form class="pf-send-form" data-slot="send-form">
			<select name="agent_id" class="pf-input">
				${data.holdings.map((h) => `
					<option value="${esc(h.agent_id)}" data-chain="${esc(data.chain)}" data-max="${h.amount}">
						${esc(h.agent_name)} (${fmtAmount(h.amount)} ${esc(data.symbol)})
					</option>
				`).join('')}
			</select>
			<input type="text" name="recipient" class="pf-input" placeholder="Recipient address or .sol name" required autocomplete="off" />
			<div class="pf-send-amount-row">
				<input type="text" name="amount" class="pf-input" placeholder="Amount" required pattern="^(\\d+(\\.\\d*)?|\\.\\d+)$" inputmode="decimal" />
				<button type="button" class="dn-btn pf-max-btn" data-action="max">MAX</button>
			</div>
			<div class="pf-send-actions">
				<button type="submit" class="dn-btn primary">Send</button>
				<div class="pf-send-status" data-slot="send-status"></div>
			</div>
		</form>
	`;
}

function mountSendForm(form, data) {
	const maxBtn = form.querySelector('[data-action="max"]');
	const amountInput = form.querySelector('[name="amount"]');
	const agentSelect = form.querySelector('[name="agent_id"]');
	const statusEl = form.querySelector('[data-slot="send-status"]');

	maxBtn.addEventListener('click', () => {
		const opt = agentSelect.selectedOptions[0];
		amountInput.value = opt?.dataset.max || '0';
	});

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const submitBtn = form.querySelector('[type="submit"]');
		submitBtn.disabled = true;
		submitBtn.textContent = 'Sending…';
		statusEl.innerHTML = '';

		const agentId = agentSelect.value;
		const recipient = form.querySelector('[name="recipient"]').value.trim();
		const amount = amountInput.value.trim();
		const chain = agentSelect.selectedOptions[0]?.dataset.chain || data.chain;
		const asset = data.is_native ? 'native' : data.id;

		try {
			const result = await post('/api/portfolio/send', {
				agent_id: agentId,
				chain,
				asset,
				recipient,
				amount,
			});
			const explorerUrl = (TX_EXPLORER[chain] || (() => '#'))(result.tx_hash);
			statusEl.innerHTML = `<span class="pf-send-ok">Sent. <a href="${explorerUrl}" target="_blank" rel="noopener">View tx ↗</a></span>`;
		} catch (err) {
			statusEl.innerHTML = `<span class="pf-send-err">${esc(err.message)}</span>`;
		} finally {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Send';
		}
	});
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtUsd(n) {
	n = Number(n) || 0;
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return n.toFixed(2);
}

function fmtPrice(n) {
	n = Number(n) || 0;
	if (n === 0) return '0.00';
	if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	if (n >= 0.01) return n.toFixed(4);
	if (n >= 0.0001) return n.toFixed(6);
	return n.toExponential(2);
}

function fmtAmount(n) {
	n = Number(n) || 0;
	if (n === 0) return '0';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
	if (n < 0.0001) return n.toExponential(2);
	return n.toFixed(n < 0.01 ? 6 : 4);
}

function fmtCompact(n) {
	n = Number(n) || 0;
	if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
	if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toFixed(2);
}

function renderChange(pct) {
	if (pct == null) return '<span class="pf-change pf-neutral">—</span>';
	const n = Number(pct);
	const cls = n > 0 ? 'pf-gain' : n < 0 ? 'pf-loss' : 'pf-neutral';
	const sign = n > 0 ? '+' : '';
	return `<span class="pf-change ${cls}">${sign}${n.toFixed(2)}%</span>`;
}

function renderChangeText(pct) {
	if (pct == null) return '—';
	const n = Number(pct);
	const sign = n > 0 ? '+' : '';
	return `${sign}${n.toFixed(2)}%`;
}

function statItem(label, value) {
	return `
		<div class="pf-stat">
			<span class="pf-stat-label">${label}</span>
			<span class="pf-stat-value">${value}</span>
		</div>
	`;
}

function countTokens(summary) {
	let n = 0;
	for (const w of summary.wallets) {
		if (w.native?.amount > 0) n++;
		n += (w.tokens || []).length;
	}
	return n;
}

// ── Styles ────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('pf-styles')) return;
	const css = `
		.pf-hero { padding: 0; overflow: hidden; }
		.pf-hero-top { padding: 24px 24px 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
		.pf-hero-label { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--nxt-ink-fade); margin-bottom: 6px; }
		.pf-hero-value { font-size: 36px; font-weight: 700; letter-spacing: -0.03em; color: var(--nxt-ink); line-height: 1.1; }
		.pf-hero-change { font-size: 14px; font-weight: 500; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
		.pf-hero-change span { font-size: 12px; color: var(--nxt-ink-dim); }
		.pf-hero-period { font-size: 11px; color: var(--nxt-ink-fade); }
		.pf-gain { color: var(--nxt-success); }
		.pf-loss { color: var(--nxt-danger); }
		.pf-neutral { color: var(--nxt-ink-dim); }
		.pf-hero-meta { display: flex; gap: 20px; }
		.pf-hero-meta-item { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
		.pf-hero-meta-label { font-size: 11px; color: var(--nxt-ink-fade); text-transform: uppercase; letter-spacing: 0.05em; }
		.pf-hero-meta-val { font-size: 14px; font-weight: 600; color: var(--nxt-ink-dim); font-variant-numeric: tabular-nums; }
		.pf-chart-wrap { padding: 16px 8px 8px; }
		.pf-chart-empty { padding: 24px; text-align: center; color: var(--nxt-ink-fade); font-size: 13px; }

		.pf-empty-hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 48px 24px; gap: 12px; }
		.pf-empty-icon { color: var(--nxt-ink-fade); margin-bottom: 8px; }
		.pf-empty-hero h3 { font-size: 18px; font-weight: 600; margin: 0; }
		.pf-empty-hero p { font-size: 14px; color: var(--nxt-ink-dim); margin: 0; max-width: 360px; }

		.pf-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }

		.pf-wallets { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
		.pf-wallet-card {
			border: 1px solid var(--nxt-stroke);
			border-radius: var(--nxt-radius-sm);
			padding: 16px;
			background: rgba(255,255,255,0.015);
			transition: border-color 0.14s ease, transform 0.14s ease;
		}
		.pf-wallet-card:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-2px); }
		.pf-wallet-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
		.pf-wallet-chain-badge {
			font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
			padding: 3px 8px; border-radius: 6px;
			background: rgba(255,255,255,0.06); color: var(--nxt-ink-dim);
		}
		.pf-wallet-explorer { font-size: 13px; color: var(--nxt-ink-fade); text-decoration: none; }
		.pf-wallet-explorer:hover { color: var(--nxt-ink); }
		.pf-wallet-name { font-size: 14px; font-weight: 600; color: var(--nxt-ink); margin-bottom: 2px; }
		.pf-wallet-sns { font-size: 12px; font-weight: 400; color: var(--nxt-ink-dim); margin-left: 6px; }
		.pf-wallet-addr { font-size: 12px; color: var(--nxt-ink-fade); margin-bottom: 10px; }
		.pf-wallet-bal-main { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
		.pf-wallet-bal-sub { font-size: 12px; color: var(--nxt-ink-dim); margin-top: 2px; }
		.pf-wallet-err { font-size: 12px; color: var(--nxt-danger); margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: rgba(248,113,113,0.08); }

		.pf-table { width: 100%; border-collapse: collapse; font-size: 13px; }
		.pf-th {
			padding: 10px 12px;
			font-weight: 600;
			font-size: 11.5px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--nxt-ink-fade);
			border-bottom: 1px solid var(--nxt-stroke);
			text-align: left;
		}
		.pf-th.right { text-align: right; }
		.pf-td { padding: 12px; border-bottom: 1px solid var(--nxt-stroke); vertical-align: middle; }
		.pf-td.right { text-align: right; }
		.pf-row { transition: background 0.1s ease; }
		.pf-row:hover { background: rgba(255,255,255,0.03); }
		.pf-token-cell { display: flex; align-items: center; gap: 10px; }
		.pf-token-logo {
			width: 32px; height: 32px; border-radius: 50%;
			object-fit: cover; flex-shrink: 0;
			background: rgba(255,255,255,0.05);
			border: 1px solid var(--nxt-stroke);
		}
		.pf-token-logo-placeholder {
			display: grid; place-items: center;
			font-size: 14px; font-weight: 700;
			color: var(--nxt-ink-dim);
		}
		.pf-token-symbol { font-weight: 600; font-size: 14px; color: var(--nxt-ink); }
		.pf-token-name { font-size: 12px; color: var(--nxt-ink-fade); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.pf-change { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
		.pf-alloc-bar-wrap { display: flex; align-items: center; gap: 8px; min-width: 100px; }
		.pf-alloc-bar {
			height: 6px; border-radius: 3px;
			background: var(--nxt-ink-dim);
			flex: 1; max-width: 60px;
		}
		.pf-alloc-label { font-size: 12px; color: var(--nxt-ink-dim); font-variant-numeric: tabular-nums; min-width: 42px; text-align: right; }

		/* ── Asset detail panel ── */
		.pf-detail { margin-top: 8px; padding: 20px 24px; position: relative; }
		.pf-detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
		.pf-detail-title-row { display: flex; align-items: center; gap: 12px; }
		.pf-detail-logo { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
		.pf-detail-symbol { font-size: 18px; font-weight: 700; color: var(--nxt-ink); }
		.pf-detail-name { font-size: 13px; color: var(--nxt-ink-dim); }
		.pf-detail-close {
			background: none; border: none; cursor: pointer;
			font-size: 24px; color: var(--nxt-ink-fade); padding: 4px 8px;
			line-height: 1; border-radius: 6px;
			transition: color 0.12s ease, background 0.12s ease;
		}
		.pf-detail-close:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.06); }
		.pf-detail-price-row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 16px; }
		.pf-detail-price { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
		.pf-asset-chart-wrap { margin: 0 -8px 16px; }
		.pf-detail-stats {
			display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
			gap: 2px; margin-bottom: 20px;
		}
		.pf-stat {
			display: flex; flex-direction: column; gap: 2px;
			padding: 10px 12px; border-radius: 8px;
			background: rgba(255,255,255,0.02);
		}
		.pf-stat-label { font-size: 11px; color: var(--nxt-ink-fade); text-transform: uppercase; letter-spacing: 0.05em; }
		.pf-stat-value { font-size: 14px; font-weight: 600; color: var(--nxt-ink); font-variant-numeric: tabular-nums; }
		.pf-detail-section-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nxt-ink-fade); margin: 16px 0 8px; }
		.pf-detail-holdings { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
		.pf-detail-holding-row {
			display: flex; justify-content: space-between; align-items: center;
			padding: 8px 12px; border-radius: 8px;
			background: rgba(255,255,255,0.02); border: 1px solid var(--nxt-stroke);
		}
		.pf-detail-holding-agent { font-weight: 600; font-size: 13px; }
		.pf-detail-holding-addr { font-size: 12px; color: var(--nxt-ink-fade); margin-left: 8px; }
		.pf-detail-holding-val { display: flex; gap: 12px; font-size: 13px; font-variant-numeric: tabular-nums; }
		.pf-detail-desc { font-size: 13px; color: var(--nxt-ink-dim); line-height: 1.5; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--nxt-stroke); }

		/* ── Send form ── */
		.pf-send-form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
		.pf-input {
			width: 100%; padding: 10px 12px;
			font-size: 13px; font-family: inherit;
			background: rgba(255,255,255,0.04);
			border: 1px solid var(--nxt-stroke);
			border-radius: 8px; color: var(--nxt-ink);
			outline: none;
			transition: border-color 0.14s ease;
		}
		.pf-input:focus { border-color: var(--nxt-stroke-strong); }
		.pf-input option { background: #111; color: var(--nxt-ink); }
		.pf-send-amount-row { display: flex; gap: 8px; align-items: stretch; }
		.pf-send-amount-row .pf-input { flex: 1; }
		.pf-max-btn { padding: 8px 14px; font-size: 11px; letter-spacing: 0.05em; }
		.pf-send-actions { display: flex; align-items: center; gap: 12px; }
		.pf-send-ok { font-size: 13px; color: var(--nxt-success); }
		.pf-send-ok a { color: var(--nxt-success); }
		.pf-send-err { font-size: 13px; color: var(--nxt-danger); }
		.pf-send-status { flex: 1; }

		@media (max-width: 640px) {
			.pf-hero-top { flex-direction: column; }
			.pf-hero-meta { flex-wrap: wrap; }
			.pf-hero-value { font-size: 28px; }
			.pf-detail-stats { grid-template-columns: 1fr 1fr; }
		}
	`;
	const tag = document.createElement('style');
	tag.id = 'pf-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}
