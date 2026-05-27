import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime, ApiError } from '../api.js';
import { createChart, AreaSeries, LineSeries } from 'lightweight-charts';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
const REFRESH_MS = 60_000;
const DEBOUNCE_MS = 150;

const CHAIN = {
	solana:   { label: 'Solana',   color: '#9945FF', explorer: (a) => `https://solscan.io/account/${a}`, txUrl: (h) => `https://solscan.io/tx/${h}` },
	evm:      { label: 'Ethereum', color: '#627EEA', explorer: (a) => `https://etherscan.io/address/${a}`, txUrl: (h) => `https://etherscan.io/tx/${h}` },
	base:     { label: 'Base',     color: '#0052FF', explorer: (a) => `https://basescan.org/address/${a}`, txUrl: (h) => `https://basescan.org/tx/${h}` },
	polygon:  { label: 'Polygon',  color: '#8247E5', explorer: (a) => `https://polygonscan.com/address/${a}`, txUrl: (h) => `https://polygonscan.com/tx/${h}` },
};

const STATE = {
	summary: null,
	history: null,
	merged: [],
	sortCol: 'value',
	sortDir: 'desc',
	search: '',
	period: 90,
	refreshHandle: null,
	timeTickHandle: null,
};

let _portfolioChart = null;
let _portfolioSeries = null;
let _assetChart = null;

// ── Boot ──────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();
		injectStyles();

		main.innerHTML = `
			<h1 class="dn-h1">Portfolio</h1>
			<p class="dn-h1-sub">Live balances, price charts, and market data across your agent wallets.</p>
			<div data-slot="content">${buildSkeleton()}</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		const [summaryRes, historyRes, avatarsRes, agentsRes] = await Promise.allSettled([
			get('/api/portfolio/summary?snapshot=1'),
			get('/api/portfolio/history?days=90'),
			get('/api/avatars?limit=100'),
			get('/api/agents'),
		]);

		STATE.summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
		STATE.history = historyRes.status === 'fulfilled' ? historyRes.value : null;
		const avatars = avatarsRes.status === 'fulfilled' ? (avatarsRes.value?.avatars ?? []) : [];
		const agents = agentsRes.status === 'fulfilled' ? (agentsRes.value?.agents ?? []) : [];

		host.innerHTML = '';

		if (!STATE.summary?.wallets?.length) {
			host.appendChild(renderEmptyState());
			return;
		}

		STATE.merged = mergeHoldings(STATE.summary);

		host.appendChild(renderHero(STATE.summary, STATE.history));
		host.appendChild(renderWallets(STATE.summary));
		host.appendChild(renderHoldings());

		const nftAvatars = avatars.filter((a) => a.nft_mint || a.nft_address || a.token_id);
		if (nftAvatars.length) host.appendChild(renderNftAvatars(nftAvatars));

		const pumpAgents = agents.filter((a) => a.meta?.pumpfun?.mint || a.meta?.token?.mint || a.meta?.token?.ca);
		if (pumpAgents.length) host.appendChild(renderPumpTokens(pumpAgents));

		mountDrawerContainer();
		startAutoRefresh(host);

		window.addEventListener('beforeunload', cleanup);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else {
			throw err;
		}
	}
})();

function cleanup() {
	if (_portfolioChart) { _portfolioChart.remove(); _portfolioChart = null; }
	if (_assetChart) { _assetChart.remove(); _assetChart = null; }
	if (STATE.refreshHandle) clearInterval(STATE.refreshHandle);
	if (STATE.timeTickHandle) clearInterval(STATE.timeTickHandle);
}

// ── Skeleton ──────────────────────────────────────────────────────────────

function buildSkeleton() {
	return `
		<div class="dn-panel" style="padding:24px">
			<div class="dn-skeleton" style="height:14px;width:140px;margin-bottom:12px"></div>
			<div class="dn-skeleton" style="height:40px;width:220px;margin-bottom:8px"></div>
			<div class="dn-skeleton" style="height:14px;width:160px;margin-bottom:20px"></div>
			<div class="dn-skeleton" style="height:200px;width:100%;border-radius:8px"></div>
		</div>
		<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:16px">
			${Array.from({ length: 2 }, () => '<div class="dn-skeleton" style="height:150px;border-radius:12px"></div>').join('')}
		</div>
		<div class="dn-panel" style="margin-top:16px;padding:16px">
			<div class="dn-skeleton" style="height:14px;width:100px;margin-bottom:16px"></div>
			${Array.from({ length: 5 }, () => '<div class="dn-skeleton" style="height:48px;width:100%;margin-bottom:8px;border-radius:8px"></div>').join('')}
		</div>
	`;
}

// ── Empty state ───────────────────────────────────────────────────────────

function renderEmptyState() {
	const el = document.createElement('div');
	el.className = 'dn-panel pf-empty';
	el.innerHTML = `
		<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" class="pf-empty-icon">
			<rect x="6" y="16" width="36" height="26" rx="4"/><path d="M14 16V12a10 10 0 0120 0v4"/><path d="M6 26h36"/><circle cx="32" cy="30" r="3"/>
		</svg>
		<h3>No agent wallets yet</h3>
		<p>Create an agent with a Solana or EVM wallet to start tracking your portfolio, viewing token prices, and sending assets.</p>
		<div class="pf-empty-actions">
			<a class="dn-btn primary" href="/dashboard/agents">Create an agent</a>
			<a class="dn-btn" href="/dashboard/account">Link a wallet</a>
		</div>
	`;
	return el;
}

// ── Hero: total value + chart + period tabs + stats ───────────────────────

function renderHero(summary, history) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel pf-hero';
	panel.id = 'pf-hero';

	const totalUsd = summary.total_usd || 0;
	const points = history?.points || [];
	const { changeUsd, changePct } = calcChange(totalUsd, points);
	const cls = changeUsd >= 0 ? 'pf-gain' : 'pf-loss';
	const sign = changeUsd >= 0 ? '+' : '';
	const chains = new Set(summary.wallets.map((w) => w.chain));

	panel.innerHTML = `
		<div class="pf-hero-top">
			<div class="pf-hero-value-wrap">
				<div class="pf-hero-label">Total portfolio value</div>
				<div class="pf-hero-value" data-slot="total-value">$${fmtUsd(totalUsd)}</div>
				<div class="pf-hero-change ${cls}" data-slot="change">
					${sign}$${fmtUsd(Math.abs(changeUsd))}
					<span>(${sign}${changePct.toFixed(2)}%)</span>
					<span class="pf-hero-period-label" data-slot="period-label">${STATE.period}d</span>
				</div>
			</div>
			<div class="pf-hero-controls">
				<div class="pf-period-tabs" role="tablist" aria-label="Chart period">
					${[7, 30, 90, 365].map((d) => `
						<button role="tab" class="pf-period-btn${d === STATE.period ? ' is-active' : ''}"
							data-days="${d}" aria-selected="${d === STATE.period}">${d === 365 ? '1Y' : d + 'D'}</button>
					`).join('')}
				</div>
			</div>
		</div>
		<div class="pf-chart-wrap" data-slot="chart"></div>
		<div class="pf-hero-stats">
			<div class="pf-hero-stat"><span class="pf-hero-stat-val">${summary.wallets.length}</span><span class="pf-hero-stat-label">Wallet${summary.wallets.length === 1 ? '' : 's'}</span></div>
			<div class="pf-hero-stat"><span class="pf-hero-stat-val">${STATE.merged.length}</span><span class="pf-hero-stat-label">Asset${STATE.merged.length === 1 ? '' : 's'}</span></div>
			<div class="pf-hero-stat"><span class="pf-hero-stat-val">${chains.size}</span><span class="pf-hero-stat-label">Chain${chains.size === 1 ? '' : 's'}</span></div>
			<div class="pf-hero-stat"><span class="pf-hero-stat-val" data-slot="updated-at">${relTime(summary.captured_at)}</span><span class="pf-hero-stat-label">Updated</span></div>
		</div>
	`;

	panel.querySelectorAll('.pf-period-btn').forEach((btn) => {
		btn.addEventListener('click', () => handlePeriodChange(panel, Number(btn.dataset.days)));
	});

	requestAnimationFrame(() => {
		const chartEl = panel.querySelector('[data-slot="chart"]');
		if (!chartEl) return;
		if (points.length < 2) {
			chartEl.innerHTML = '<div class="pf-chart-empty">Portfolio history builds as you visit. Check back in a day or two for your performance chart.</div>';
			return;
		}
		renderPortfolioChart(chartEl, points, totalUsd);
	});

	tweenValue(panel.querySelector('[data-slot="total-value"]'), 0, totalUsd, 600, (v) => '$' + fmtUsd(v));

	STATE.timeTickHandle = setInterval(() => {
		const el = document.querySelector('[data-slot="updated-at"]');
		if (el && STATE.summary) el.textContent = relTime(STATE.summary.captured_at);
	}, 10_000);

	return panel;
}

function calcChange(currentUsd, points) {
	if (!points.length) return { changeUsd: 0, changePct: 0 };
	const first = points[0].usd;
	const changeUsd = currentUsd - first;
	const changePct = first > 0 ? (changeUsd / first) * 100 : 0;
	return { changeUsd, changePct };
}

async function handlePeriodChange(heroPanel, days) {
	STATE.period = days;
	heroPanel.querySelectorAll('.pf-period-btn').forEach((btn) => {
		const active = Number(btn.dataset.days) === days;
		btn.classList.toggle('is-active', active);
		btn.setAttribute('aria-selected', active);
	});

	const chartEl = heroPanel.querySelector('[data-slot="chart"]');
	chartEl.innerHTML = '<div class="pf-chart-loading"><div class="dn-skeleton" style="height:200px;width:100%;border-radius:8px"></div></div>';

	try {
		const history = await get(`/api/portfolio/history?days=${days}`);
		STATE.history = history;
		const points = history?.points || [];
		const totalUsd = STATE.summary?.total_usd || 0;

		if (points.length < 2) {
			chartEl.innerHTML = '<div class="pf-chart-empty">Not enough data for this period yet.</div>';
		} else {
			chartEl.innerHTML = '';
			renderPortfolioChart(chartEl, points, totalUsd);
		}

		const { changeUsd, changePct } = calcChange(totalUsd, points);
		const cls = changeUsd >= 0 ? 'pf-gain' : 'pf-loss';
		const sign = changeUsd >= 0 ? '+' : '';
		const changeEl = heroPanel.querySelector('[data-slot="change"]');
		if (changeEl) {
			changeEl.className = `pf-hero-change ${cls}`;
			changeEl.innerHTML = `${sign}$${fmtUsd(Math.abs(changeUsd))} <span>(${sign}${changePct.toFixed(2)}%)</span> <span class="pf-hero-period-label" data-slot="period-label">${days === 365 ? '1Y' : days + 'd'}</span>`;
		}
	} catch {
		chartEl.innerHTML = '<div class="pf-chart-empty">Failed to load chart data.</div>';
	}
}

// ── Portfolio chart (lightweight-charts area) ─────────────────────────────

function renderPortfolioChart(container, points, currentUsd) {
	if (_portfolioChart) { _portfolioChart.remove(); _portfolioChart = null; _portfolioSeries = null; }

	const chart = createChart(container, {
		width: container.clientWidth,
		height: 220,
		layout: { background: { color: 'transparent' }, textColor: '#666', fontFamily: MONO, fontSize: 11 },
		grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
		rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0.05 } },
		timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: false },
		crosshair: {
			horzLine: { color: 'rgba(255,255,255,0.12)', style: 2, labelBackgroundColor: '#222' },
			vertLine: { color: 'rgba(255,255,255,0.12)', style: 2, labelBackgroundColor: '#222' },
		},
		handleScroll: false,
		handleScale: false,
	});
	_portfolioChart = chart;

	const isUp = points.length >= 2 && points[points.length - 1].usd >= points[0].usd;
	const color = isUp ? '#4ade80' : '#f87171';

	const series = chart.addSeries(AreaSeries, {
		lineColor: color,
		topColor: isUp ? 'rgba(74,222,128,0.18)' : 'rgba(248,113,113,0.18)',
		bottomColor: 'transparent',
		lineWidth: 2,
		crosshairMarkerRadius: 4,
		crosshairMarkerBackgroundColor: color,
		priceFormat: { type: 'custom', formatter: (v) => '$' + fmtUsd(v) },
	});
	_portfolioSeries = series;

	const data = dedupeTimeSeries(points.map((p) => ({ time: p.t.slice(0, 10), value: p.usd })));
	series.setData(data);
	chart.timeScale().fitContent();

	const ro = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
	ro.observe(container);
}

function dedupeTimeSeries(arr) {
	const seen = new Set();
	return arr.filter((d) => {
		if (seen.has(d.time)) return false;
		seen.add(d.time);
		return true;
	});
}

// ── Wallet cards ──────────────────────────────────────────────────────────

function renderWallets(summary) {
	const section = document.createElement('section');
	section.className = 'pf-section';
	section.innerHTML = `
		<div class="pf-section-head">
			<div>
				<h2 class="dn-panel-title">Agent wallets</h2>
				<div class="dn-panel-sub">${summary.wallets.length} wallet${summary.wallets.length === 1 ? '' : 's'} across ${new Set(summary.wallets.map((w) => w.chain)).size} chain${new Set(summary.wallets.map((w) => w.chain)).size === 1 ? '' : 's'}.</div>
			</div>
			<a class="dn-btn" href="/dashboard/account">Manage wallets →</a>
		</div>
		<div class="pf-wallets-grid" data-slot="wallets"></div>
	`;

	const grid = section.querySelector('[data-slot="wallets"]');

	for (const w of summary.wallets) {
		const card = document.createElement('article');
		card.className = 'dn-panel pf-wallet-card';

		const addr = w.address || '';
		const short = addr.slice(0, 6) + '…' + addr.slice(-4);
		const chain = CHAIN[w.chain] || CHAIN.solana;
		const tokenCount = (w.tokens || []).length;
		const sns = w.sns ? `<span class="pf-wallet-sns">${esc(w.sns)}</span>` : '';

		const topTokens = (w.tokens || []).slice(0, 3);
		const barSegments = [];
		if (w.usd > 0) {
			if (w.native?.usd > 0) barSegments.push({ pct: (w.native.usd / w.usd) * 100, color: chain.color });
			for (const t of topTokens) {
				if (t.usd > 0) barSegments.push({ pct: (t.usd / w.usd) * 100, color: 'rgba(255,255,255,0.15)' });
			}
		}
		const compBar = barSegments.length
			? `<div class="pf-comp-bar">${barSegments.map((s) => `<div style="width:${Math.max(2, s.pct).toFixed(1)}%;background:${s.color}"></div>`).join('')}</div>`
			: '';

		card.innerHTML = `
			<div class="pf-wallet-top">
				<span class="pf-chain-badge" style="--chain-color:${chain.color}">${chain.label}</span>
				<a href="${chain.explorer(addr)}" target="_blank" rel="noopener" class="pf-wallet-explorer" aria-label="View on explorer" title="View on block explorer">
					<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 8v3.5a1 1 0 01-1 1H2.5a1 1 0 01-1-1V4a1 1 0 011-1H6"/><path d="M8.5 1.5h4v4"/><path d="M6 8L12.5 1.5"/></svg>
				</a>
			</div>
			<div class="pf-wallet-name">${esc(w.agent_name)}${sns}</div>
			<button class="pf-wallet-addr" style="font-family:${MONO}" data-addr="${esc(addr)}" aria-label="Copy address" title="Click to copy full address">
				${short}
				<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="pf-copy-icon"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M9 5V2.5A1.5 1.5 0 007.5 1h-5A1.5 1.5 0 001 2.5v5A1.5 1.5 0 002.5 9H5"/></svg>
			</button>
			<div class="pf-wallet-value">$${fmtUsd(w.usd)}</div>
			<div class="pf-wallet-sub">${fmtAmount(w.native?.amount)} ${esc(w.native?.symbol || '')} + ${tokenCount} token${tokenCount === 1 ? '' : 's'}</div>
			${compBar}
			${!w.ok && w.error ? `<div class="pf-wallet-err">${esc(w.error)}</div>` : ''}
		`;

		card.querySelector('.pf-wallet-addr').addEventListener('click', function () {
			copyToClipboard(this.dataset.addr, this);
		});

		grid.appendChild(card);
	}

	return section;
}

async function copyToClipboard(text, el) {
	try {
		await navigator.clipboard.writeText(text);
		const orig = el.innerHTML;
		el.innerHTML = '<span style="color:var(--nxt-success)">Copied!</span>';
		setTimeout(() => { el.innerHTML = orig; }, 1500);
	} catch {
		const orig = el.innerHTML;
		el.innerHTML = '<span style="color:var(--nxt-ink-dim)">Failed</span>';
		setTimeout(() => { el.innerHTML = orig; }, 1500);
	}
}

// ── Holdings table (searchable, sortable) ─────────────────────────────────

function renderHoldings() {
	const section = document.createElement('section');
	section.className = 'pf-section';
	section.id = 'pf-holdings-section';

	section.innerHTML = `
		<div class="pf-section-head">
			<div>
				<h2 class="dn-panel-title">Holdings</h2>
				<div class="dn-panel-sub" data-slot="holdings-count">${STATE.merged.length} asset${STATE.merged.length === 1 ? '' : 's'} across all wallets.</div>
			</div>
			<div class="pf-search-wrap">
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="pf-search-icon"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3.5 3.5"/></svg>
				<input type="search" class="pf-search" placeholder="Search tokens…" aria-label="Search tokens" data-slot="search" autocomplete="off" />
			</div>
		</div>
		<div class="dn-panel pf-holdings-panel">
			<div style="overflow-x:auto">
				<table class="pf-table" role="grid">
					<thead><tr data-slot="thead"></tr></thead>
					<tbody data-slot="tbody"></tbody>
				</table>
			</div>
			<div class="pf-no-results" data-slot="no-results" hidden>No tokens match your search.</div>
		</div>
	`;

	renderTableHead(section.querySelector('[data-slot="thead"]'));
	renderTableBody(section);

	let debounceTimer;
	section.querySelector('[data-slot="search"]').addEventListener('input', (e) => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			STATE.search = e.target.value.trim();
			renderTableBody(section);
		}, DEBOUNCE_MS);
	});

	return section;
}

const COLUMNS = [
	{ key: 'symbol', label: 'Asset', align: 'left', sortable: true, minWidth: '180px' },
	{ key: 'price', label: 'Price', align: 'right', sortable: true },
	{ key: 'change', label: '24h', align: 'right', sortable: true },
	{ key: 'balance', label: 'Balance', align: 'right', sortable: true },
	{ key: 'value', label: 'Value', align: 'right', sortable: true },
	{ key: 'alloc', label: 'Allocation', align: 'right', sortable: false, minWidth: '120px' },
];

function renderTableHead(tr) {
	tr.innerHTML = COLUMNS.map((col) => {
		const isActive = STATE.sortCol === col.key;
		const arrow = isActive ? (STATE.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
		const cls = `pf-th${col.align === 'right' ? ' right' : ''}${col.sortable ? ' sortable' : ''}${isActive ? ' is-sorted' : ''}`;
		return `<th class="${cls}" scope="col" ${col.minWidth ? `style="min-width:${col.minWidth}"` : ''}
			${col.sortable ? `role="columnheader" aria-sort="${isActive ? STATE.sortDir + 'ending' : 'none'}" data-col="${col.key}" tabindex="0"` : ''}>
			${col.label}${arrow}</th>`;
	}).join('');

	tr.querySelectorAll('[data-col]').forEach((th) => {
		const handler = () => {
			const col = th.dataset.col;
			if (STATE.sortCol === col) {
				STATE.sortDir = STATE.sortDir === 'desc' ? 'asc' : 'desc';
			} else {
				STATE.sortCol = col;
				STATE.sortDir = col === 'symbol' ? 'asc' : 'desc';
			}
			const section = document.getElementById('pf-holdings-section');
			renderTableHead(section.querySelector('[data-slot="thead"]'));
			renderTableBody(section);
		};
		th.addEventListener('click', handler);
		th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
	});
}

function renderTableBody(section) {
	const tbody = section.querySelector('[data-slot="tbody"]');
	const noResults = section.querySelector('[data-slot="no-results"]');

	let tokens = STATE.merged;
	if (STATE.search) {
		const q = STATE.search.toLowerCase();
		tokens = tokens.filter((t) =>
			t.symbol.toLowerCase().includes(q) ||
			t.name.toLowerCase().includes(q) ||
			(t.id && t.id.toLowerCase().includes(q)),
		);
	}

	tokens = sortTokens(tokens, STATE.sortCol, STATE.sortDir);
	const totalUsd = STATE.merged.reduce((s, t) => s + (t.usd || 0), 0);

	noResults.hidden = tokens.length > 0;
	if (!tokens.length && !STATE.search) {
		tbody.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="pf-td" style="text-align:center;padding:32px;color:var(--nxt-ink-dim)">No holdings found. Fund a wallet to get started.</td></tr>`;
		return;
	}

	tbody.innerHTML = tokens.map((t) => {
		const pct = totalUsd > 0 ? (t.usd / totalUsd) * 100 : 0;
		const logoHtml = t.logo
			? `<img src="${esc(t.logo)}" alt="" class="pf-token-logo" loading="lazy" />`
			: `<div class="pf-token-logo pf-token-logo-ph">${esc((t.symbol || '?')[0])}</div>`;
		const chainMeta = CHAIN[t.chain] || CHAIN.solana;

		return `
			<tr class="pf-row" data-chain="${esc(t.chain)}" data-id="${esc(t.id)}" tabindex="0" role="row">
				<td class="pf-td">
					<div class="pf-token-cell">
						${logoHtml}
						<div>
							<div class="pf-token-symbol">${esc(t.symbol)} <span class="pf-token-chain-dot" style="background:${chainMeta.color}" title="${chainMeta.label}"></span></div>
							<div class="pf-token-name">${esc(t.name)}</div>
						</div>
					</div>
				</td>
				<td class="pf-td right mono">$${fmtPrice(t.price)}</td>
				<td class="pf-td right">${renderChange(t.change24h)}</td>
				<td class="pf-td right mono">${fmtAmount(t.amount)}</td>
				<td class="pf-td right mono bold">$${fmtUsd(t.usd)}</td>
				<td class="pf-td right">
					<div class="pf-alloc">
						<div class="pf-alloc-track"><div class="pf-alloc-fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
						<span class="pf-alloc-pct">${pct.toFixed(1)}%</span>
					</div>
				</td>
			</tr>
		`;
	}).join('');

	tbody.querySelectorAll('.pf-row').forEach((row) => {
		const handler = () => {
			const chain = row.dataset.chain;
			const id = row.dataset.id;
			const token = STATE.merged.find((t) => t.chain === chain && t.id === id);
			if (token) openAssetDrawer(token);
		};
		row.addEventListener('click', handler);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
	});
}

function sortTokens(tokens, col, dir) {
	return [...tokens].sort((a, b) => {
		let va, vb;
		switch (col) {
			case 'symbol': va = a.symbol.toLowerCase(); vb = b.symbol.toLowerCase(); break;
			case 'price': va = a.price; vb = b.price; break;
			case 'change': va = a.change24h ?? -Infinity; vb = b.change24h ?? -Infinity; break;
			case 'balance': va = a.amount; vb = b.amount; break;
			default: va = a.usd; vb = b.usd;
		}
		if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
		return dir === 'asc' ? va - vb : vb - va;
	});
}

function mergeHoldings(summary) {
	const map = new Map();
	for (const w of summary.wallets) {
		if (w.native && w.native.amount > 0) {
			const key = `${w.chain}:native`;
			const ex = map.get(key);
			if (ex) {
				ex.amount += w.native.amount;
				ex.usd += w.native.usd || 0;
				if (!ex.price && w.native.price) ex.price = w.native.price;
			} else {
				map.set(key, {
					chain: w.chain, id: 'native',
					symbol: w.native.symbol, name: w.native.name || w.native.symbol,
					amount: w.native.amount, price: w.native.price || 0,
					change24h: w.native.change24h, usd: w.native.usd || 0, logo: null,
				});
			}
		}
		for (const t of (w.tokens || [])) {
			const key = `${w.chain}:${(t.mint || t.contract || '').toLowerCase()}`;
			const ex = map.get(key);
			if (ex) {
				ex.amount += t.amount || 0;
				ex.usd += t.usd || 0;
				if (!ex.price && t.price) ex.price = t.price;
				if (ex.change24h == null && t.change24h != null) ex.change24h = t.change24h;
				if (!ex.logo && t.logo) ex.logo = t.logo;
			} else {
				map.set(key, {
					chain: w.chain, id: t.mint || t.contract || '',
					symbol: t.symbol, name: t.name || t.symbol,
					amount: t.amount || 0, price: t.price || 0,
					change24h: t.change24h, usd: t.usd || 0, logo: t.logo || null,
				});
			}
		}
	}
	return [...map.values()].sort((a, b) => (b.usd || 0) - (a.usd || 0));
}

// ── NFT avatars ───────────────────────────────────────────────────────────

function renderNftAvatars(nftAvatars) {
	const section = document.createElement('section');
	section.className = 'pf-section';
	section.innerHTML = `
		<div class="pf-section-head">
			<div>
				<h2 class="dn-panel-title">Avatar NFTs</h2>
				<div class="dn-panel-sub">${nftAvatars.length} avatar${nftAvatars.length === 1 ? '' : 's'} minted on-chain.</div>
			</div>
			<a class="dn-btn" href="/dashboard/avatars">All avatars →</a>
		</div>
		<div class="pf-nft-grid">
			${nftAvatars.map((av) => `
				<a href="/avatar-artifact?id=${encodeURIComponent(av.id)}" target="_blank" rel="noopener" class="dn-panel pf-nft-card">
					${av.thumbnail_url
						? `<img src="${esc(av.thumbnail_url)}" alt="${esc(av.name || '')}" class="pf-nft-img" loading="lazy" />`
						: `<div class="pf-nft-img pf-nft-ph">NFT</div>`}
					<div class="pf-nft-info">
						<div class="pf-nft-name">${esc(av.name || 'Untitled')}</div>
						<div class="pf-nft-mint" style="font-family:${MONO}">${esc((av.nft_mint || av.nft_address || av.token_id || '').slice(0, 14))}…</div>
					</div>
				</a>
			`).join('')}
		</div>
	`;
	return section;
}

// ── Pump.fun tokens ───────────────────────────────────────────────────────

function renderPumpTokens(pumpAgents) {
	const section = document.createElement('section');
	section.className = 'pf-section';
	section.innerHTML = `
		<div class="pf-section-head">
			<div>
				<h2 class="dn-panel-title">Pump.fun tokens</h2>
				<div class="dn-panel-sub">${pumpAgents.length} token${pumpAgents.length === 1 ? '' : 's'} launched by your agents.</div>
			</div>
			<a class="dn-btn" href="/dashboard/tokens">Token dashboard →</a>
		</div>
		<div class="dn-panel" style="overflow-x:auto">
			<table class="pf-table">
				<thead><tr>
					<th class="pf-th">Agent / Token</th>
					<th class="pf-th right">Holders</th>
					<th class="pf-th right"></th>
				</tr></thead>
				<tbody>
					${pumpAgents.map((a) => {
						const meta = a.meta?.pumpfun || a.meta?.token || {};
						const mint = meta.mint || meta.address || meta.ca || '';
						const ticker = meta.symbol || meta.ticker || a.name || 'TOKEN';
						const holders = meta.holders ?? '—';
						return `
							<tr class="pf-row">
								<td class="pf-td"><div class="pf-token-symbol" style="font-size:14px">$${esc(String(ticker).toUpperCase())}</div><div class="pf-token-name">${esc(a.name || a.display_name || '')}</div></td>
								<td class="pf-td right mono">${esc(String(holders))}</td>
								<td class="pf-td right">${mint ? `<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" class="pf-link">View ↗</a>` : ''}</td>
							</tr>
						`;
					}).join('')}
				</tbody>
			</table>
		</div>
	`;
	return section;
}

// ── Asset detail drawer ───────────────────────────────────────────────────

function mountDrawerContainer() {
	if (document.getElementById('pf-drawer-backdrop')) return;
	const backdrop = document.createElement('div');
	backdrop.id = 'pf-drawer-backdrop';
	backdrop.className = 'pf-drawer-backdrop';
	backdrop.setAttribute('role', 'presentation');
	backdrop.innerHTML = `<aside class="pf-drawer" role="dialog" aria-modal="true" aria-label="Asset details"><div class="pf-drawer-inner" data-slot="drawer"></div></aside>`;
	document.body.appendChild(backdrop);

	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeDrawer(); });
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && backdrop.classList.contains('is-open')) closeDrawer();
	});
}

function openDrawer() {
	const el = document.getElementById('pf-drawer-backdrop');
	el.classList.add('is-open');
	document.body.style.overflow = 'hidden';
	requestAnimationFrame(() => el.querySelector('.pf-drawer').focus());
}

function closeDrawer() {
	const el = document.getElementById('pf-drawer-backdrop');
	if (!el) return;
	el.classList.remove('is-open');
	document.body.style.overflow = '';
	if (_assetChart) { _assetChart.remove(); _assetChart = null; }
}

async function openAssetDrawer(token) {
	const content = document.querySelector('[data-slot="drawer"]');
	content.innerHTML = `
		<div class="pf-drawer-head">
			<div></div>
			<button class="pf-drawer-close" aria-label="Close" data-action="close">&times;</button>
		</div>
		<div style="padding:0 24px 24px">${buildSkeleton()}</div>
	`;
	content.querySelector('[data-action="close"]').addEventListener('click', closeDrawer);
	openDrawer();

	try {
		const data = await get(`/api/portfolio/asset?chain=${encodeURIComponent(token.chain)}&id=${encodeURIComponent(token.id)}&days=30`);
		renderDrawerContent(content, data);
	} catch (err) {
		content.innerHTML = `
			<div class="pf-drawer-head">
				<div></div>
				<button class="pf-drawer-close" data-action="close">&times;</button>
			</div>
			<div class="pf-drawer-error">
				<p>Failed to load asset data</p>
				<p style="font-size:12px;color:var(--nxt-ink-fade)">${esc(err.message)}</p>
				<button class="dn-btn" onclick="this.closest('.pf-drawer-backdrop')?.classList.remove('is-open')">Close</button>
			</div>
		`;
		content.querySelector('[data-action="close"]').addEventListener('click', closeDrawer);
	}
}

function renderDrawerContent(host, data) {
	const market = data.market || {};
	const symbol = data.symbol || '?';
	const chain = CHAIN[data.chain] || CHAIN.solana;
	const logoHtml = data.logo
		? `<img src="${esc(data.logo)}" alt="" class="pf-drawer-logo" />`
		: `<div class="pf-drawer-logo pf-token-logo-ph" style="width:44px;height:44px;font-size:20px">${esc(symbol[0])}</div>`;
	const hasChart = data.chart?.points?.length >= 2;

	host.innerHTML = `
		<div class="pf-drawer-head">
			<div class="pf-drawer-title">
				${logoHtml}
				<div>
					<div class="pf-drawer-symbol">${esc(symbol)}</div>
					<div class="pf-drawer-name">${esc(market.name || data.name || symbol)}</div>
				</div>
			</div>
			<button class="pf-drawer-close" aria-label="Close" data-action="close">&times;</button>
		</div>

		<div class="pf-drawer-body">
			<div class="pf-drawer-price-row">
				<span class="pf-drawer-price">$${fmtPrice(data.unit_price_usd)}</span>
				${renderChange(market.change_24h_pct)}
			</div>

			${hasChart ? '<div class="pf-drawer-chart" data-slot="asset-chart"></div>' : ''}

			<div class="pf-drawer-your">
				<div class="pf-drawer-your-item">
					<span class="pf-drawer-your-label">Your balance</span>
					<span class="pf-drawer-your-val">${fmtAmount(data.total_amount)} ${esc(symbol)}</span>
				</div>
				<div class="pf-drawer-your-item">
					<span class="pf-drawer-your-label">Your value</span>
					<span class="pf-drawer-your-val pf-gain-text">$${fmtUsd(data.total_usd)}</span>
				</div>
			</div>

			${Object.keys(market).length ? `
			<div class="pf-drawer-label">Market data</div>
			<div class="pf-drawer-stats">
				${market.market_cap_usd ? stat('Market cap', '$' + fmtCompact(market.market_cap_usd)) : ''}
				${market.total_volume_usd ? stat('24h volume', '$' + fmtCompact(market.total_volume_usd)) : ''}
				${market.high_24h_usd ? stat('24h high', '$' + fmtPrice(market.high_24h_usd)) : ''}
				${market.low_24h_usd ? stat('24h low', '$' + fmtPrice(market.low_24h_usd)) : ''}
				${market.change_7d_pct != null ? stat('7d', renderChangeText(market.change_7d_pct)) : ''}
				${market.change_30d_pct != null ? stat('30d', renderChangeText(market.change_30d_pct)) : ''}
				${market.ath_usd ? stat('ATH', '$' + fmtPrice(market.ath_usd)) : ''}
				${market.ath_change_pct != null ? stat('From ATH', renderChangeText(market.ath_change_pct)) : ''}
			</div>
			` : ''}

			${data.holdings?.length ? `
			<div class="pf-drawer-label">Held in</div>
			<div class="pf-drawer-holdings">
				${data.holdings.map((h) => `
					<div class="pf-drawer-holding">
						<div>
							<span class="pf-drawer-holding-agent">${esc(h.agent_name)}</span>
							<span class="pf-drawer-holding-addr" style="font-family:${MONO}">${h.address.slice(0, 6)}…${h.address.slice(-4)}</span>
						</div>
						<div class="pf-drawer-holding-vals">
							<span class="mono">${fmtAmount(h.amount)}</span>
							<span style="color:var(--nxt-ink-dim)">$${fmtUsd(h.usd)}</span>
						</div>
					</div>
				`).join('')}
			</div>` : ''}

			${data.holdings?.length ? `
			<div class="pf-drawer-label">Send ${esc(symbol)}</div>
			<form class="pf-send" data-slot="send-form" novalidate>
				<label class="pf-send-label">From
					<select name="agent_id" class="pf-input" required>
						${data.holdings.map((h) => `
							<option value="${esc(h.agent_id)}" data-chain="${esc(data.chain)}" data-max="${h.amount}">
								${esc(h.agent_name)} (${fmtAmount(h.amount)} ${esc(symbol)})
							</option>
						`).join('')}
					</select>
				</label>
				<label class="pf-send-label">To
					<input type="text" name="recipient" class="pf-input" placeholder="${data.chain === 'solana' ? 'Address or .sol name' : '0x address'}" required autocomplete="off" spellcheck="false" />
				</label>
				<label class="pf-send-label">Amount
					<div class="pf-send-amount">
						<input type="text" name="amount" class="pf-input" placeholder="0.00" required inputmode="decimal" pattern="^(\\d+(\\.\\d*)?|\\.\\d+)$" autocomplete="off" />
						<button type="button" class="pf-max-btn" data-action="max">MAX</button>
					</div>
				</label>
				<div class="pf-send-foot">
					<button type="submit" class="dn-btn primary pf-send-btn">Send ${esc(symbol)}</button>
					<div class="pf-send-status" data-slot="send-status"></div>
				</div>
			</form>` : ''}

			${market.description ? `<div class="pf-drawer-desc">${esc(market.description)}</div>` : ''}
			${market.homepage ? `<a href="${esc(market.homepage)}" target="_blank" rel="noopener" class="pf-link" style="display:inline-block;margin-top:8px">Project website ↗</a>` : ''}
		</div>
	`;

	host.querySelector('[data-action="close"]').addEventListener('click', closeDrawer);

	if (hasChart) {
		requestAnimationFrame(() => {
			const chartEl = host.querySelector('[data-slot="asset-chart"]');
			if (chartEl) renderAssetChart(chartEl, data.chart.points);
		});
	}

	const form = host.querySelector('[data-slot="send-form"]');
	if (form) mountSendForm(form, data);
}

// ── Asset price chart ─────────────────────────────────────────────────────

function renderAssetChart(container, points) {
	if (_assetChart) { _assetChart.remove(); _assetChart = null; }

	const chart = createChart(container, {
		width: container.clientWidth,
		height: 180,
		layout: { background: { color: 'transparent' }, textColor: '#666', fontFamily: MONO, fontSize: 10 },
		grid: { vertLines: { color: 'rgba(255,255,255,0.02)' }, horzLines: { color: 'rgba(255,255,255,0.02)' } },
		rightPriceScale: { borderColor: 'rgba(255,255,255,0.05)' },
		timeScale: { borderColor: 'rgba(255,255,255,0.05)', timeVisible: true },
		crosshair: {
			horzLine: { color: 'rgba(255,255,255,0.10)', style: 2, labelBackgroundColor: '#222' },
			vertLine: { color: 'rgba(255,255,255,0.10)', style: 2, labelBackgroundColor: '#222' },
		},
		handleScroll: false,
		handleScale: false,
	});
	_assetChart = chart;

	const isUp = points.length >= 2 && points[points.length - 1].price >= points[0].price;
	const color = isUp ? '#4ade80' : '#f87171';

	const series = chart.addSeries(LineSeries, {
		color,
		lineWidth: 2,
		crosshairMarkerRadius: 3,
		crosshairMarkerBackgroundColor: color,
		priceFormat: { type: 'custom', formatter: (v) => '$' + fmtPrice(v) },
	});

	const data = points.map((p) => ({ time: Math.floor(new Date(p.t).getTime() / 1000), value: p.price }));
	series.setData(data);
	chart.timeScale().fitContent();

	const ro = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
	ro.observe(container);
}

// ── Send form ─────────────────────────────────────────────────────────────

function mountSendForm(form, data) {
	const agentSelect = form.querySelector('[name="agent_id"]');
	const amountInput = form.querySelector('[name="amount"]');
	const statusEl = form.querySelector('[data-slot="send-status"]');
	const submitBtn = form.querySelector('.pf-send-btn');

	form.querySelector('[data-action="max"]').addEventListener('click', () => {
		const opt = agentSelect.selectedOptions[0];
		amountInput.value = opt?.dataset.max || '0';
		amountInput.focus();
	});

	form.addEventListener('submit', async (e) => {
		e.preventDefault();

		const recipient = form.querySelector('[name="recipient"]').value.trim();
		const amount = amountInput.value.trim();
		if (!recipient || !amount) return;

		submitBtn.disabled = true;
		submitBtn.textContent = 'Sending…';
		submitBtn.setAttribute('aria-busy', 'true');
		statusEl.innerHTML = '';

		const chain = agentSelect.selectedOptions[0]?.dataset.chain || data.chain;
		const asset = data.is_native ? 'native' : data.id;

		try {
			const result = await post('/api/portfolio/send', {
				agent_id: agentSelect.value,
				chain,
				asset,
				recipient,
				amount,
			});
			const txUrl = (CHAIN[chain] || CHAIN.solana).txUrl(result.tx_hash);
			statusEl.innerHTML = `<span class="pf-send-ok">Sent successfully. <a href="${txUrl}" target="_blank" rel="noopener">View transaction ↗</a></span>`;
			amountInput.value = '';
		} catch (err) {
			statusEl.innerHTML = `<span class="pf-send-err">${esc(err.message)}</span>`;
		} finally {
			submitBtn.disabled = false;
			submitBtn.textContent = `Send ${data.symbol}`;
			submitBtn.removeAttribute('aria-busy');
		}
	});
}

// ── Auto-refresh ──────────────────────────────────────────────────────────

function startAutoRefresh(host) {
	STATE.refreshHandle = setInterval(async () => {
		try {
			const summary = await get('/api/portfolio/summary');
			STATE.summary = summary;
			STATE.merged = mergeHoldings(summary);

			const valueEl = document.querySelector('[data-slot="total-value"]');
			if (valueEl) valueEl.textContent = '$' + fmtUsd(summary.total_usd || 0);

			const updEl = document.querySelector('[data-slot="updated-at"]');
			if (updEl) updEl.textContent = relTime(summary.captured_at);

			const section = document.getElementById('pf-holdings-section');
			if (section) renderTableBody(section);
		} catch {
			// silent — next tick will retry
		}
	}, REFRESH_MS);
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
	const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '';
	return `<span class="pf-change ${cls}">${arrow} ${sign}${n.toFixed(2)}%</span>`;
}

function renderChangeText(pct) {
	if (pct == null) return '—';
	const n = Number(pct);
	const sign = n > 0 ? '+' : '';
	return `<span class="${n > 0 ? 'pf-gain' : n < 0 ? 'pf-loss' : ''}">${sign}${n.toFixed(2)}%</span>`;
}

function stat(label, value) {
	return `<div class="pf-stat"><span class="pf-stat-label">${label}</span><span class="pf-stat-value">${value}</span></div>`;
}

function tweenValue(el, from, to, ms, fmt) {
	if (!el) return;
	const start = performance.now();
	(function frame(now) {
		const t = Math.min(1, (now - start) / ms);
		const eased = 1 - Math.pow(1 - t, 3);
		el.textContent = fmt(from + (to - from) * eased);
		if (t < 1) requestAnimationFrame(frame);
		else el.textContent = fmt(to);
	})(start);
}

// ── Styles ────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('pf-styles')) return;
	const s = document.createElement('style');
	s.id = 'pf-styles';
	s.textContent = `

/* ── Layout ── */
.pf-section { display:flex; flex-direction:column; gap:0; margin-top:20px; }
.pf-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; padding:0 2px; }

/* ── Empty state ── */
.pf-empty { display:flex; flex-direction:column; align-items:center; text-align:center; padding:56px 28px; gap:14px; }
.pf-empty-icon { color:var(--nxt-ink-fade); margin-bottom:4px; }
.pf-empty h3 { font-size:18px; font-weight:700; margin:0; }
.pf-empty p { font-size:14px; color:var(--nxt-ink-dim); margin:0; max-width:380px; line-height:1.5; }
.pf-empty-actions { display:flex; gap:10px; margin-top:8px; flex-wrap:wrap; }

/* ── Hero ── */
.pf-hero { padding:0; overflow:hidden; }
.pf-hero-top { padding:28px 28px 0; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.pf-hero-label { font-size:12px; font-weight:700; letter-spacing:0.07em; text-transform:uppercase; color:var(--nxt-ink-fade); margin-bottom:8px; }
.pf-hero-value { font-size:40px; font-weight:800; letter-spacing:-0.035em; color:var(--nxt-ink); line-height:1; font-variant-numeric:tabular-nums; }
.pf-hero-change { font-size:14px; font-weight:600; margin-top:8px; display:flex; align-items:center; gap:6px; }
.pf-hero-change span { font-size:13px; font-weight:500; }
.pf-hero-period-label { font-size:11px; color:var(--nxt-ink-fade); font-weight:400; }
.pf-gain { color:var(--nxt-success); }
.pf-loss { color:var(--nxt-danger); }
.pf-neutral { color:var(--nxt-ink-dim); }
.pf-gain-text { color:var(--nxt-success); }
.pf-hero-controls { display:flex; align-items:flex-start; }
.pf-period-tabs { display:flex; gap:2px; background:rgba(255,255,255,0.04); border-radius:8px; padding:2px; }
.pf-period-btn {
	background:none; border:none; cursor:pointer; padding:6px 12px; font-size:12px;
	font-weight:600; letter-spacing:0.03em; color:var(--nxt-ink-fade); border-radius:6px;
	transition:background 0.12s ease, color 0.12s ease;
	font-family:inherit;
}
.pf-period-btn:hover { color:var(--nxt-ink-dim); background:rgba(255,255,255,0.04); }
.pf-period-btn.is-active { color:var(--nxt-ink); background:rgba(255,255,255,0.08); }
.pf-period-btn:focus-visible { outline:2px solid var(--nxt-ink-dim); outline-offset:1px; }
.pf-chart-wrap { padding:20px 10px 10px; }
.pf-chart-empty { padding:40px 24px; text-align:center; color:var(--nxt-ink-fade); font-size:13px; line-height:1.5; }
.pf-chart-loading { padding:0; }
.pf-hero-stats {
	display:flex; gap:0; border-top:1px solid var(--nxt-stroke); padding:0;
}
.pf-hero-stat {
	flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
	padding:14px 12px; border-right:1px solid var(--nxt-stroke);
}
.pf-hero-stat:last-child { border-right:none; }
.pf-hero-stat-val { font-size:16px; font-weight:700; color:var(--nxt-ink); font-variant-numeric:tabular-nums; }
.pf-hero-stat-label { font-size:11px; color:var(--nxt-ink-fade); text-transform:uppercase; letter-spacing:0.05em; }

/* ── Wallet cards ── */
.pf-wallets-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; }
.pf-wallet-card { padding:18px 20px; transition:border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease; }
.pf-wallet-card:hover { border-color:var(--nxt-stroke-strong); transform:translateY(-2px); box-shadow:0 8px 24px -12px rgba(0,0,0,0.4); }
.pf-wallet-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.pf-chain-badge {
	font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;
	padding:3px 9px; border-radius:6px;
	background:color-mix(in srgb, var(--chain-color) 15%, transparent);
	color:var(--chain-color);
	border:1px solid color-mix(in srgb, var(--chain-color) 25%, transparent);
}
.pf-wallet-explorer { color:var(--nxt-ink-fade); transition:color 0.12s ease; display:grid; place-items:center; padding:4px; border-radius:6px; }
.pf-wallet-explorer:hover { color:var(--nxt-ink); background:rgba(255,255,255,0.04); }
.pf-wallet-name { font-size:15px; font-weight:700; color:var(--nxt-ink); margin-bottom:2px; }
.pf-wallet-sns { font-size:12px; font-weight:400; color:var(--nxt-ink-dim); margin-left:6px; }
.pf-wallet-addr {
	display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--nxt-ink-fade);
	margin-bottom:12px; background:none; border:none; cursor:pointer; padding:2px 0;
	transition:color 0.12s ease; font-family:inherit;
}
.pf-wallet-addr:hover { color:var(--nxt-ink-dim); }
.pf-copy-icon { opacity:0.5; transition:opacity 0.12s ease; }
.pf-wallet-addr:hover .pf-copy-icon { opacity:1; }
.pf-wallet-value { font-size:24px; font-weight:800; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; color:var(--nxt-ink); }
.pf-wallet-sub { font-size:12px; color:var(--nxt-ink-dim); margin-top:4px; }
.pf-comp-bar { display:flex; height:4px; border-radius:2px; overflow:hidden; margin-top:12px; background:rgba(255,255,255,0.04); }
.pf-comp-bar > div { min-width:2px; }
.pf-wallet-err { font-size:12px; color:var(--nxt-danger); margin-top:10px; padding:7px 10px; border-radius:6px; background:rgba(248,113,113,0.06); border:1px solid rgba(248,113,113,0.1); }

/* ── Holdings table ── */
.pf-search-wrap { position:relative; }
.pf-search-icon { position:absolute; left:10px; top:50%; transform:translateY(-50%); color:var(--nxt-ink-fade); pointer-events:none; }
.pf-search {
	width:220px; padding:8px 10px 8px 32px; font-size:13px; font-family:inherit;
	background:rgba(255,255,255,0.04); border:1px solid var(--nxt-stroke);
	border-radius:8px; color:var(--nxt-ink); outline:none;
	transition:border-color 0.14s ease, width 0.2s ease;
}
.pf-search:focus { border-color:var(--nxt-stroke-strong); width:280px; }
.pf-search::placeholder { color:var(--nxt-ink-fade); }
.pf-holdings-panel { padding:0; overflow:hidden; }
.pf-table { width:100%; border-collapse:collapse; font-size:13px; }
.pf-th {
	padding:12px 14px; font-weight:700; font-size:11px; text-transform:uppercase;
	letter-spacing:0.06em; color:var(--nxt-ink-fade);
	border-bottom:1px solid var(--nxt-stroke); text-align:left; white-space:nowrap;
	user-select:none;
}
.pf-th.right { text-align:right; }
.pf-th.sortable { cursor:pointer; transition:color 0.12s ease; }
.pf-th.sortable:hover { color:var(--nxt-ink-dim); }
.pf-th.is-sorted { color:var(--nxt-ink); }
.pf-th:focus-visible { outline:2px solid var(--nxt-ink-dim); outline-offset:-2px; }
.pf-td { padding:14px; border-bottom:1px solid var(--nxt-stroke); vertical-align:middle; }
.pf-td.right { text-align:right; }
.pf-row { transition:background 0.1s ease; cursor:pointer; }
.pf-row:hover { background:rgba(255,255,255,0.025); }
.pf-row:focus-visible { outline:2px solid var(--nxt-ink-dim); outline-offset:-2px; }
.pf-row:last-child .pf-td { border-bottom:none; }
.pf-token-cell { display:flex; align-items:center; gap:12px; }
.pf-token-logo {
	width:34px; height:34px; border-radius:50%; object-fit:cover; flex-shrink:0;
	background:rgba(255,255,255,0.04); border:1px solid var(--nxt-stroke);
}
.pf-token-logo-ph { display:grid; place-items:center; font-size:14px; font-weight:800; color:var(--nxt-ink-dim); }
.pf-token-symbol { font-weight:700; font-size:14px; color:var(--nxt-ink); display:flex; align-items:center; gap:5px; }
.pf-token-chain-dot { width:7px; height:7px; border-radius:50%; display:inline-block; flex-shrink:0; }
.pf-token-name { font-size:12px; color:var(--nxt-ink-fade); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pf-change { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
.mono { font-family:${MONO}; font-variant-numeric:tabular-nums; }
.bold { font-weight:700; }
.pf-alloc { display:flex; align-items:center; gap:8px; justify-content:flex-end; }
.pf-alloc-track { width:50px; height:5px; border-radius:3px; background:rgba(255,255,255,0.06); overflow:hidden; }
.pf-alloc-fill { height:100%; border-radius:3px; background:var(--nxt-ink-dim); transition:width 0.3s ease; }
.pf-alloc-pct { font-size:12px; color:var(--nxt-ink-dim); font-variant-numeric:tabular-nums; min-width:38px; text-align:right; }
.pf-no-results { padding:28px; text-align:center; color:var(--nxt-ink-fade); font-size:13px; }
.pf-link { color:var(--nxt-accent); font-size:12px; text-decoration:none; }
.pf-link:hover { text-decoration:underline; }

/* ── NFT grid ── */
.pf-nft-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px; }
.pf-nft-card {
	overflow:hidden; transition:border-color 0.14s ease, transform 0.14s ease;
	cursor:pointer; text-decoration:none; padding:0;
}
.pf-nft-card:hover { border-color:var(--nxt-stroke-strong); transform:translateY(-2px); }
.pf-nft-img { width:100%; aspect-ratio:1; object-fit:cover; display:block; }
.pf-nft-ph { background:rgba(255,255,255,0.04); display:grid; place-items:center; font-size:16px; font-weight:700; color:var(--nxt-ink-fade); }
.pf-nft-info { padding:10px 12px; }
.pf-nft-name { font-weight:600; font-size:13px; color:var(--nxt-ink); margin-bottom:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pf-nft-mint { font-size:11px; color:var(--nxt-ink-fade); }

/* ── Drawer ── */
.pf-drawer-backdrop {
	position:fixed; inset:0; z-index:1000;
	background:rgba(0,0,0,0.55); backdrop-filter:blur(2px);
	opacity:0; pointer-events:none;
	transition:opacity 0.2s ease;
}
.pf-drawer-backdrop.is-open { opacity:1; pointer-events:auto; }
.pf-drawer {
	position:fixed; top:0; right:0; bottom:0;
	width:min(480px, 100vw); z-index:1001;
	background:var(--nxt-bg-1);
	border-left:1px solid var(--nxt-stroke);
	transform:translateX(100%);
	transition:transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
	overflow-y:auto; overflow-x:hidden;
	outline:none;
	scrollbar-width:thin; scrollbar-color:var(--nxt-stroke-strong) transparent;
}
.pf-drawer-backdrop.is-open .pf-drawer { transform:translateX(0); }
.pf-drawer-inner { min-height:100%; }
.pf-drawer-head {
	display:flex; justify-content:space-between; align-items:flex-start;
	padding:24px 24px 0; position:sticky; top:0;
	background:linear-gradient(180deg, var(--nxt-bg-1) 80%, transparent);
	z-index:2; padding-bottom:16px;
}
.pf-drawer-title { display:flex; align-items:center; gap:14px; }
.pf-drawer-logo { width:44px; height:44px; border-radius:50%; object-fit:cover; flex-shrink:0; }
.pf-drawer-symbol { font-size:20px; font-weight:800; color:var(--nxt-ink); }
.pf-drawer-name { font-size:13px; color:var(--nxt-ink-dim); }
.pf-drawer-close {
	background:none; border:none; cursor:pointer; font-size:28px; color:var(--nxt-ink-fade);
	width:36px; height:36px; display:grid; place-items:center; border-radius:8px;
	transition:color 0.12s ease, background 0.12s ease; line-height:1; flex-shrink:0;
}
.pf-drawer-close:hover { color:var(--nxt-ink); background:rgba(255,255,255,0.06); }
.pf-drawer-close:focus-visible { outline:2px solid var(--nxt-ink-dim); }
.pf-drawer-body { padding:0 24px 32px; }
.pf-drawer-price-row { display:flex; align-items:baseline; gap:12px; margin-bottom:16px; }
.pf-drawer-price { font-size:32px; font-weight:800; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; color:var(--nxt-ink); }
.pf-drawer-chart { margin:0 -12px 20px; }
.pf-drawer-your { display:flex; gap:12px; margin-bottom:20px; }
.pf-drawer-your-item {
	flex:1; display:flex; flex-direction:column; gap:4px;
	padding:14px 16px; border-radius:10px;
	background:rgba(255,255,255,0.03); border:1px solid var(--nxt-stroke);
}
.pf-drawer-your-label { font-size:11px; color:var(--nxt-ink-fade); text-transform:uppercase; letter-spacing:0.05em; font-weight:600; }
.pf-drawer-your-val { font-size:16px; font-weight:700; color:var(--nxt-ink); font-variant-numeric:tabular-nums; }
.pf-drawer-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:var(--nxt-ink-fade); margin:20px 0 10px; }
.pf-drawer-stats { display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.pf-stat { display:flex; flex-direction:column; gap:2px; padding:10px 12px; border-radius:8px; background:rgba(255,255,255,0.02); }
.pf-stat-label { font-size:11px; color:var(--nxt-ink-fade); text-transform:uppercase; letter-spacing:0.04em; }
.pf-stat-value { font-size:14px; font-weight:600; color:var(--nxt-ink); font-variant-numeric:tabular-nums; }
.pf-drawer-holdings { display:flex; flex-direction:column; gap:6px; }
.pf-drawer-holding {
	display:flex; justify-content:space-between; align-items:center;
	padding:10px 14px; border-radius:8px;
	background:rgba(255,255,255,0.02); border:1px solid var(--nxt-stroke);
}
.pf-drawer-holding-agent { font-weight:600; font-size:13px; color:var(--nxt-ink); }
.pf-drawer-holding-addr { font-size:11px; color:var(--nxt-ink-fade); margin-left:6px; }
.pf-drawer-holding-vals { display:flex; gap:14px; font-size:13px; font-variant-numeric:tabular-nums; }
.pf-drawer-desc { font-size:13px; color:var(--nxt-ink-dim); line-height:1.5; margin-top:16px; padding-top:16px; border-top:1px solid var(--nxt-stroke); }
.pf-drawer-error { padding:32px 24px; text-align:center; color:var(--nxt-danger); }

/* ── Send form ── */
.pf-send { display:flex; flex-direction:column; gap:12px; }
.pf-send-label { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--nxt-ink-dim); font-weight:600; }
.pf-input {
	width:100%; padding:10px 12px; font-size:13px; font-family:${MONO};
	background:rgba(255,255,255,0.04); border:1px solid var(--nxt-stroke);
	border-radius:8px; color:var(--nxt-ink); outline:none;
	transition:border-color 0.14s ease, box-shadow 0.14s ease;
}
.pf-input:focus { border-color:var(--nxt-stroke-strong); box-shadow:0 0 0 2px rgba(255,255,255,0.04); }
.pf-input option { background:var(--nxt-bg-2); color:var(--nxt-ink); }
.pf-send-amount { display:flex; gap:6px; align-items:stretch; }
.pf-send-amount .pf-input { flex:1; }
.pf-max-btn {
	padding:8px 14px; font-size:11px; font-weight:700; letter-spacing:0.06em;
	background:rgba(255,255,255,0.06); border:1px solid var(--nxt-stroke);
	border-radius:8px; color:var(--nxt-ink-dim); cursor:pointer;
	transition:background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
	font-family:inherit;
}
.pf-max-btn:hover { background:rgba(255,255,255,0.10); color:var(--nxt-ink); border-color:var(--nxt-stroke-strong); }
.pf-send-foot { display:flex; align-items:center; gap:14px; margin-top:4px; }
.pf-send-btn { white-space:nowrap; }
.pf-send-status { flex:1; font-size:13px; line-height:1.4; }
.pf-send-ok { color:var(--nxt-success); }
.pf-send-ok a { color:var(--nxt-success); }
.pf-send-err { color:var(--nxt-danger); }

/* ── Responsive ── */
@media (max-width: 760px) {
	.pf-hero-top { flex-direction:column; }
	.pf-hero-value { font-size:32px; }
	.pf-hero-stats { flex-wrap:wrap; }
	.pf-hero-stat { min-width:calc(50% - 1px); }
	.pf-wallets-grid { grid-template-columns:1fr; }
	.pf-search { width:160px; }
	.pf-search:focus { width:200px; }
	.pf-nft-grid { grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); }
	.pf-drawer-stats { grid-template-columns:1fr; }
}
@media (max-width: 480px) {
	.pf-hero-value { font-size:28px; }
	.pf-period-btn { padding:5px 8px; font-size:11px; }
	.pf-section-head { flex-direction:column; align-items:flex-start; }
	.pf-drawer-price { font-size:26px; }
}
	`;
	document.head.appendChild(s);
}
