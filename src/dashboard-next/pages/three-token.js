// dashboard-next — $THREE Token Utility page.
//
// The command center for the $THREE protocol economy. Shows real token
// data from Birdeye/Pump.fun, platform revenue metrics, and the four
// utility pillars: agent-to-agent payments, revenue share, deploy burns,
// and index token exposure.
//
// Real endpoints:
//   GET /api/three-token/stats          { token, protocol }
//   GET /api/three-token/revenue-share  { user_id, ... }
//   GET /api/three-token/activity       { events }

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, ApiError } from '../api.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function fmtUsd(n) {
	if (n == null || !Number.isFinite(+n)) return '—';
	const v = +n;
	if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
	if (v >= 1_000) return '$' + (v / 1_000).toFixed(2) + 'K';
	if (v >= 1) return '$' + v.toFixed(2);
	if (v >= 0.0001) return '$' + v.toFixed(6);
	return '$' + v.toExponential(2);
}

function fmtCompact(n) {
	if (n == null) return '—';
	const v = +n;
	if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
	if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
	if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
	return v.toLocaleString();
}

function fmtPct(n) {
	if (n == null || !Number.isFinite(+n)) return '—';
	const v = +n;
	const sign = v >= 0 ? '+' : '';
	return sign + v.toFixed(2) + '%';
}

function pctColor(n) {
	if (n == null || !Number.isFinite(+n)) return 'var(--nxt-ink-dim)';
	return +n >= 0 ? 'var(--nxt-success)' : 'var(--nxt-danger)';
}

function toast(msg) {
	let el = document.getElementById('dn-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'dn-toast';
		el.style.cssText = `position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);
			background:rgba(20,21,28,0.95);border:1px solid var(--nxt-stroke-strong);
			color:var(--nxt-ink);padding:9px 16px;border-radius:999px;font-size:13px;
			z-index:9999;opacity:0;transition:opacity .18s,transform .18s;
			backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
			box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;`;
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

async function safeGet(url) {
	try { return await get(url); }
	catch { return null; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		const me = await requireUser();

		main.innerHTML = `
			<div style="margin-bottom:6px">
				<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
					<div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#fff 0%,#888 100%);display:grid;place-items:center;font-weight:800;font-size:15px;color:#000;flex-shrink:0">$3</div>
					<div>
						<h1 class="dn-h1" style="margin:0">$THREE</h1>
						<p class="dn-h1-sub" style="margin:0">The protocol token powering the three.ws agent economy</p>
					</div>
				</div>
			</div>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:20px">
				${skeletonGrid(4)}
				${skeletonBlock(280)}
				${skeletonBlock(200)}
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		const [stats, revenueShare, activity] = await Promise.all([
			safeGet('/api/three-token/stats'),
			safeGet('/api/three-token/revenue-share'),
			safeGet('/api/three-token/activity'),
		]);

		host.innerHTML = '';

		host.appendChild(renderHeroMetrics(stats));
		host.appendChild(renderUtilityPillars(stats));
		host.appendChild(renderRevenueShare(stats, revenueShare));
		host.appendChild(renderDeployBurn(stats));
		host.appendChild(renderActivityFeed(activity));
		host.appendChild(renderTokenInfo());

	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else throw err;
	}
})();

// ── Skeletons ─────────────────────────────────────────────────────────────────

function skeletonGrid(n) {
	return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
		${Array.from({ length: n }, () => `<div class="dn-skeleton" style="height:96px;border-radius:12px"></div>`).join('')}
	</div>`;
}

function skeletonBlock(h) {
	return `<div class="dn-skeleton" style="height:${h}px;border-radius:12px"></div>`;
}

// ── Hero metrics ──────────────────────────────────────────────────────────────

function renderHeroMetrics(stats) {
	const t = stats?.token || {};
	const p = stats?.protocol || {};

	const metrics = [
		{
			label: 'Price',
			value: fmtUsd(t.price_usd),
			sub: t.price_change_24h != null
				? `<span style="color:${pctColor(t.price_change_24h)};font-size:12px;font-weight:500">${fmtPct(t.price_change_24h)} 24h</span>`
				: '',
		},
		{
			label: 'Market Cap',
			value: t.market_cap != null ? fmtUsd(t.market_cap) : '—',
			sub: '',
		},
		{
			label: '24h Volume',
			value: t.volume_24h != null ? fmtUsd(t.volume_24h) : '—',
			sub: '',
		},
		{
			label: 'Holders',
			value: t.holders != null ? fmtCompact(t.holders) : '—',
			sub: '',
		},
	];

	const wrap = document.createElement('div');
	wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px';

	metrics.forEach(({ label, value, sub }) => {
		const card = document.createElement('div');
		card.className = 'dn-panel';
		card.style.cssText = 'position:relative;overflow:hidden;';
		card.innerHTML = `
			<div style="position:absolute;top:0;right:0;width:80px;height:80px;background:radial-gradient(circle at top right,rgba(255,255,255,0.03),transparent 70%);pointer-events:none"></div>
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">${esc(label)}</div>
			<div style="font-size:26px;font-weight:700;letter-spacing:-0.03em;font-family:${MONO}">${value}</div>
			${sub ? `<div style="margin-top:4px">${sub}</div>` : ''}
		`;
		wrap.appendChild(card);
	});

	return wrap;
}

// ── Four utility pillars ──────────────────────────────────────────────────────

function renderUtilityPillars(stats) {
	const p = stats?.protocol || {};
	const t = stats?.token || {};

	const pillars = [
		{
			icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
			title: 'Agent Payment Rail',
			desc: 'Every agent-to-agent transaction on three.ws settles in $THREE. More agents working = more $THREE moving.',
			metric: fmtCompact(p.total_payments || 0),
			metricLabel: 'protocol payments',
			color: '#4ade80',
		},
		{
			icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
			title: 'Revenue Share',
			desc: `${p.revenue_share_pool_pct || 10}% of all platform revenue distributes to $THREE holders pro rata. Hold tokens, earn yield from real usage.`,
			metric: fmtUsd(p.total_revenue_usd || 0),
			metricLabel: 'platform revenue',
			color: '#60a5fa',
		},
		{
			icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10"/><path d="M18 16l4 4m0-4l-4 4"/></svg>`,
			title: 'Deploy-to-Burn',
			desc: `Every agent deployed on three.ws burns ${fmtCompact(p.agent_deploy_burn || 1000)} $THREE permanently. More agents = less supply.`,
			metric: fmtCompact(p.total_agents || 0),
			metricLabel: 'agents deployed',
			color: '#f97316',
		},
		{
			icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:28px;height:28px"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 6-6"/><circle cx="21" cy="10" r="1"/></svg>`,
			title: 'Index Token',
			desc: '$THREE is the index across the entire agent economy. Every agent token launched, every skill sold, every subscription created compounds into $THREE value.',
			metric: t.market_cap ? fmtUsd(t.market_cap) : '—',
			metricLabel: 'market cap',
			color: '#a78bfa',
		},
	];

	const section = document.createElement('div');

	const header = document.createElement('div');
	header.style.cssText = 'margin-bottom:16px';
	header.innerHTML = `
		<h2 style="font-size:18px;font-weight:700;margin:0 0 4px">Four Utility Pillars</h2>
		<p style="font-size:13.5px;color:var(--nxt-ink-dim);margin:0">Each mechanism creates real demand from real usage — not speculation.</p>
	`;
	section.appendChild(header);

	const grid = document.createElement('div');
	grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px';

	pillars.forEach(({ icon, title, desc, metric, metricLabel, color }) => {
		const card = document.createElement('div');
		card.className = 'dn-panel';
		card.style.cssText = `position:relative;overflow:hidden;transition:border-color .2s,box-shadow .2s;cursor:default;`;
		card.innerHTML = `
			<div style="position:absolute;top:0;left:0;right:0;height:3px;background:${color};opacity:0.6;border-radius:2px 2px 0 0"></div>
			<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;margin-top:6px">
				<div style="flex-shrink:0;color:${color};opacity:0.9">${icon}</div>
				<div>
					<div style="font-size:15px;font-weight:700;margin-bottom:4px">${esc(title)}</div>
					<div style="font-size:12.5px;color:var(--nxt-ink-dim);line-height:1.5">${esc(desc)}</div>
				</div>
			</div>
			<div style="display:flex;align-items:baseline;gap:8px;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid var(--nxt-stroke)">
				<span style="font-size:20px;font-weight:700;font-family:${MONO};letter-spacing:-0.02em">${metric}</span>
				<span style="font-size:11.5px;color:var(--nxt-ink-fade)">${esc(metricLabel)}</span>
			</div>
		`;
		card.addEventListener('mouseenter', () => {
			card.style.borderColor = color + '33';
			card.style.boxShadow = `0 0 20px ${color}11`;
		});
		card.addEventListener('mouseleave', () => {
			card.style.borderColor = '';
			card.style.boxShadow = '';
		});
		grid.appendChild(card);
	});

	section.appendChild(grid);
	return section;
}

// ── Revenue share calculator ──────────────────────────────────────────────────

function renderRevenueShare(stats, revenueData) {
	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.style.cssText = 'position:relative;overflow:hidden;';

	const p = stats?.protocol || {};
	const rd = revenueData || {};
	const tokenPrice = rd.token_price || stats?.token?.price_usd || 0;
	const totalRevenue = rd.platform_revenue_usd || p.total_revenue_usd || 0;
	const poolPct = rd.revenue_share_pool_pct || p.revenue_share_pool_pct || 10;
	const revenuePool = totalRevenue * (poolPct / 100);
	const totalSupply = rd.total_supply || 1_000_000_000;
	const perToken = totalSupply > 0 ? revenuePool / totalSupply : 0;

	section.innerHTML = `
		<div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#60a5fa,#818cf8);opacity:0.6;border-radius:2px 2px 0 0"></div>
		<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px;margin-top:4px">
			<div>
				<h2 style="font-size:18px;font-weight:700;margin:0 0 4px">Revenue Share Calculator</h2>
				<p style="font-size:13px;color:var(--nxt-ink-dim);margin:0">See what your $THREE position earns from real platform revenue</p>
			</div>
			<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.15);border-radius:999px">
				<div style="width:6px;height:6px;border-radius:50%;background:#60a5fa;animation:pulse-dot 2s ease-in-out infinite"></div>
				<span style="font-size:12px;color:#60a5fa;font-weight:500">${poolPct}% of revenue → holders</span>
			</div>
		</div>

		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;align-items:start" data-slot="calc-grid">
			<div>
				<label style="display:block;font-size:12.5px;color:var(--nxt-ink-dim);margin-bottom:8px">Your $THREE holdings</label>
				<div style="position:relative">
					<input type="text" data-input="holdings" value="10,000" style="
						width:100%;box-sizing:border-box;padding:12px 70px 12px 14px;
						background:rgba(255,255,255,0.04);border:1px solid var(--nxt-stroke);
						border-radius:var(--nxt-radius-sm);color:var(--nxt-ink);font-size:16px;
						font-family:${MONO};font-weight:600;outline:none;transition:border-color .15s;
					" />
					<span style="position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--nxt-ink-fade);pointer-events:none">$THREE</span>
				</div>
				<input type="range" data-input="slider" min="0" max="1000000" value="10000" style="
					width:100%;margin-top:12px;accent-color:#60a5fa;cursor:pointer;
				" />
				<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--nxt-ink-fade);margin-top:4px">
					<span>0</span>
					<span>250K</span>
					<span>500K</span>
					<span>750K</span>
					<span>1M</span>
				</div>
			</div>

			<div data-slot="calc-results" style="display:flex;flex-direction:column;gap:10px">
				${calcResultCards(10000, perToken, tokenPrice, revenuePool, totalSupply)}
			</div>
		</div>

		<div style="margin-top:20px;padding:14px 16px;background:rgba(255,255,255,0.02);border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
			<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px">
				<div>
					<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Total Platform Revenue</div>
					<div style="font-size:14px;font-weight:600;font-family:${MONO}">${fmtUsd(totalRevenue)}</div>
				</div>
				<div>
					<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Revenue Share Pool</div>
					<div style="font-size:14px;font-weight:600;font-family:${MONO};color:#60a5fa">${fmtUsd(revenuePool)}</div>
				</div>
				<div>
					<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Yield Per Token</div>
					<div style="font-size:14px;font-weight:600;font-family:${MONO}">${fmtUsd(perToken)}</div>
				</div>
				<div>
					<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Total Supply</div>
					<div style="font-size:14px;font-weight:600;font-family:${MONO}">${fmtCompact(totalSupply)}</div>
				</div>
			</div>
		</div>
	`;

	const style = document.createElement('style');
	style.textContent = `@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}`;
	section.appendChild(style);

	const input = section.querySelector('[data-input="holdings"]');
	const slider = section.querySelector('[data-input="slider"]');
	const results = section.querySelector('[data-slot="calc-results"]');

	function update(raw) {
		const amount = Math.max(0, parseInt(String(raw).replace(/[^0-9]/g, ''), 10) || 0);
		results.innerHTML = calcResultCards(amount, perToken, tokenPrice, revenuePool, totalSupply);
	}

	input.addEventListener('input', (e) => {
		const raw = e.target.value.replace(/[^0-9]/g, '');
		const num = parseInt(raw, 10) || 0;
		e.target.value = num.toLocaleString();
		slider.value = Math.min(num, 1_000_000);
		update(num);
	});

	input.addEventListener('focus', () => {
		input.style.borderColor = '#60a5fa';
	});
	input.addEventListener('blur', () => {
		input.style.borderColor = '';
	});

	slider.addEventListener('input', (e) => {
		const num = parseInt(e.target.value, 10) || 0;
		input.value = num.toLocaleString();
		update(num);
	});

	return section;
}

function calcResultCards(amount, perToken, tokenPrice, revenuePool, totalSupply) {
	const shareOfSupply = totalSupply > 0 ? amount / totalSupply : 0;
	const yourShare = revenuePool * shareOfSupply;
	const holdingValue = amount * (tokenPrice || 0);
	const apy = holdingValue > 0 ? (yourShare / holdingValue) * 100 : 0;

	return `
		<div style="padding:14px 16px;background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.12);border-radius:var(--nxt-radius-sm)">
			<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-bottom:4px">Your Revenue Share</div>
			<div style="font-size:24px;font-weight:700;font-family:${MONO};color:#60a5fa;letter-spacing:-0.02em">${fmtUsd(yourShare)}</div>
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:2px">${(shareOfSupply * 100).toFixed(6)}% of supply</div>
		</div>
		<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
			<div style="padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid var(--nxt-stroke);border-radius:8px">
				<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Position Value</div>
				<div style="font-size:15px;font-weight:600;font-family:${MONO}">${fmtUsd(holdingValue)}</div>
			</div>
			<div style="padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid var(--nxt-stroke);border-radius:8px">
				<div style="font-size:11px;color:var(--nxt-ink-fade);margin-bottom:3px">Effective APY</div>
				<div style="font-size:15px;font-weight:600;font-family:${MONO};color:${apy > 0 ? 'var(--nxt-success)' : 'var(--nxt-ink-dim)'}">${apy > 0 ? apy.toFixed(1) + '%' : '—'}</div>
			</div>
		</div>
	`;
}

// ── Deploy burn section ───────────────────────────────────────────────────────

function renderDeployBurn(stats) {
	const p = stats?.protocol || {};
	const burnPerAgent = p.agent_deploy_burn || 1000;
	const totalAgents = p.total_agents || 0;
	const totalBurned = totalAgents * burnPerAgent;
	const totalSupply = stats?.token?.supply || 1_000_000_000;
	const burnPct = totalSupply > 0 ? (totalBurned / totalSupply) * 100 : 0;

	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.style.cssText = 'position:relative;overflow:hidden;';

	section.innerHTML = `
		<div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#f97316,#ef4444);opacity:0.6;border-radius:2px 2px 0 0"></div>
		<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:4px;margin-bottom:20px">
			<div>
				<h2 style="font-size:18px;font-weight:700;margin:0 0 4px">Deploy-to-Burn Mechanism</h2>
				<p style="font-size:13px;color:var(--nxt-ink-dim);margin:0">Every agent deployed permanently removes $THREE from circulation</p>
			</div>
		</div>

		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:20px">
			<div style="padding:16px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.12);border-radius:var(--nxt-radius-sm)">
				<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-bottom:4px">Burn Per Deploy</div>
				<div style="font-size:22px;font-weight:700;font-family:${MONO};color:#f97316">${fmtCompact(burnPerAgent)}</div>
				<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:2px">$THREE burned permanently</div>
			</div>
			<div style="padding:16px;background:rgba(255,255,255,0.02);border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
				<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-bottom:4px">Agents Deployed</div>
				<div style="font-size:22px;font-weight:700;font-family:${MONO}">${fmtCompact(totalAgents)}</div>
				<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:2px">on three.ws</div>
			</div>
			<div style="padding:16px;background:rgba(255,255,255,0.02);border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm)">
				<div style="font-size:11.5px;color:var(--nxt-ink-dim);margin-bottom:4px">Total Burned</div>
				<div style="font-size:22px;font-weight:700;font-family:${MONO};color:#ef4444">${fmtCompact(totalBurned)}</div>
				<div style="font-size:11.5px;color:var(--nxt-ink-fade);margin-top:2px">${burnPct.toFixed(4)}% of supply</div>
			</div>
		</div>

		<div style="margin-bottom:8px">
			<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
				<span style="color:var(--nxt-ink-dim)">Supply burned</span>
				<span style="font-family:${MONO}">${burnPct.toFixed(4)}%</span>
			</div>
			<div style="height:8px;border-radius:4px;background:var(--nxt-stroke);overflow:hidden;position:relative">
				<div style="height:100%;width:${Math.min(100, burnPct).toFixed(4)}%;background:linear-gradient(90deg,#f97316,#ef4444);transition:width 600ms ease;min-width:${burnPct > 0 ? '2px' : '0'}"></div>
			</div>
			<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--nxt-ink-fade);margin-top:4px">
				<span>0%</span>
				<span>Circulating supply: ${fmtCompact(totalSupply - totalBurned)}</span>
				<span>100%</span>
			</div>
		</div>

		<div style="margin-top:16px;padding:12px 16px;background:rgba(249,115,22,0.04);border:1px solid rgba(249,115,22,0.08);border-radius:8px;font-size:12.5px;color:var(--nxt-ink-dim);line-height:1.55">
			Every time a creator deploys a new agent on three.ws, <strong style="color:var(--nxt-ink)">${fmtCompact(burnPerAgent)} $THREE</strong> are burned — permanently removed from circulation. This creates a deflationary flywheel: as the platform grows and more agents are deployed, the total supply of $THREE shrinks, concentrating value among remaining holders.
		</div>
	`;

	return section;
}

// ── Activity feed ─────────────────────────────────────────────────────────────

function renderActivityFeed(activityData) {
	const events = activityData?.events || [];

	const section = document.createElement('div');
	section.className = 'dn-panel';

	const sourceLabels = {
		skill: 'Skill Purchase',
		subscription: 'Subscription',
		api: 'API Call',
		tip: 'Tip',
		x402: 'x402 Payment',
	};

	const sourceColors = {
		skill: '#4ade80',
		subscription: '#60a5fa',
		api: '#a78bfa',
		tip: '#fbbf24',
		x402: '#f472b6',
	};

	if (!events.length) {
		section.innerHTML = `
			<h2 style="font-size:18px;font-weight:700;margin:0 0 4px">Protocol Activity</h2>
			<p style="font-size:13px;color:var(--nxt-ink-dim);margin:0 0 20px">Real-time feed of $THREE protocol events</p>
			<div style="text-align:center;padding:32px 16px">
				<div style="font-size:32px;margin-bottom:12px;opacity:0.5">&#9678;</div>
				<p style="font-size:14px;color:var(--nxt-ink-dim);margin:0 0 6px">No protocol activity yet</p>
				<p style="font-size:12.5px;color:var(--nxt-ink-fade);margin:0;max-width:360px;margin-left:auto;margin-right:auto">
					Activity will appear here as agents transact, skills are purchased, and revenue flows through the protocol.
				</p>
			</div>
		`;
		return section;
	}

	section.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
			<div>
				<h2 style="font-size:18px;font-weight:700;margin:0 0 4px">Protocol Activity</h2>
				<p style="font-size:13px;color:var(--nxt-ink-dim);margin:0">Real-time feed of $THREE protocol events</p>
			</div>
			<div style="font-size:12px;color:var(--nxt-ink-fade)">${events.length} recent events</div>
		</div>
		<div data-slot="events" style="display:flex;flex-direction:column;gap:1px;border-radius:var(--nxt-radius-sm);overflow:hidden;border:1px solid var(--nxt-stroke)"></div>
	`;

	const eventsHost = section.querySelector('[data-slot="events"]');

	events.slice(0, 15).forEach((evt) => {
		const row = document.createElement('div');
		const srcColor = sourceColors[evt.type] || 'var(--nxt-ink-dim)';
		const srcLabel = sourceLabels[evt.type] || evt.type || 'Payment';
		row.style.cssText = `display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.015);transition:background .12s;`;
		row.innerHTML = `
			<div style="width:8px;height:8px;border-radius:50%;background:${srcColor};flex-shrink:0;opacity:0.8"></div>
			<div style="flex:1;min-width:0">
				<div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
					<span style="color:${srcColor};font-weight:600">${esc(srcLabel)}</span>
					<span style="color:var(--nxt-ink-fade);margin:0 6px">&middot;</span>
					<span>${esc(evt.agent_name)}</span>
				</div>
			</div>
			<div style="font-size:13px;font-weight:600;font-family:${MONO};flex-shrink:0">
				${evt.amount_cents ? fmtUsd(evt.amount_cents / 100) : '—'}
			</div>
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);flex-shrink:0;min-width:60px;text-align:right">
				${evt.created_at ? relTime(evt.created_at) : ''}
			</div>
		`;
		row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.04)'; });
		row.addEventListener('mouseleave', () => { row.style.background = 'rgba(255,255,255,0.015)'; });
		eventsHost.appendChild(row);
	});

	return section;
}

// ── Token info footer ─────────────────────────────────────────────────────────

function renderTokenInfo() {
	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.style.cssText = 'position:relative;overflow:hidden;';

	section.innerHTML = `
		<h2 style="font-size:18px;font-weight:700;margin:0 0 16px">Token Info</h2>
		<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">
			<div>
				<table style="width:100%;border-collapse:collapse">
					<tbody>
						${infoRow('Token', '$THREE')}
						${infoRow('Network', 'Solana')}
						${infoRow('Standard', 'SPL Token')}
						${infoRow('Decimals', '6')}
					</tbody>
				</table>
			</div>
			<div>
				<table style="width:100%;border-collapse:collapse">
					<tbody>
						${infoRow('Contract', shortAddr(THREE_MINT))}
						${infoRow('Launched on', 'Pump.fun')}
						${infoRow('Revenue share', '10% of platform revenue')}
						${infoRow('Burn per deploy', '1,000 $THREE')}
					</tbody>
				</table>
			</div>
		</div>
		<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
			<a class="dn-btn" href="https://pump.fun/coin/${THREE_MINT}" target="_blank" rel="noopener" style="font-size:12.5px">
				View on Pump.fun &#8599;
			</a>
			<a class="dn-btn" href="https://solscan.io/token/${THREE_MINT}" target="_blank" rel="noopener" style="font-size:12.5px">
				Solscan &#8599;
			</a>
			<a class="dn-btn" href="https://birdeye.so/token/${THREE_MINT}?chain=solana" target="_blank" rel="noopener" style="font-size:12.5px">
				Birdeye &#8599;
			</a>
			<button class="dn-btn ghost" data-action="copy-ca" style="font-size:12.5px">
				Copy Contract Address
			</button>
		</div>
	`;

	section.querySelector('[data-action="copy-ca"]').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(THREE_MINT);
			toast('Contract address copied');
		} catch {
			toast('Copy failed');
		}
	});

	return section;
}

function infoRow(label, value) {
	return `<tr>
		<td style="padding:6px 12px 6px 0;font-size:12.5px;color:var(--nxt-ink-fade);white-space:nowrap">${esc(label)}</td>
		<td style="padding:6px 0;font-size:13px;font-weight:500;font-family:${MONO}">${value}</td>
	</tr>`;
}

function shortAddr(addr) {
	if (!addr || addr.length < 12) return esc(addr || '');
	return `<span title="${esc(addr)}" style="cursor:help">${esc(addr.slice(0, 6))}...${esc(addr.slice(-4))}</span>`;
}
