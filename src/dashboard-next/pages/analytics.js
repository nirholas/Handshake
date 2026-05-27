// dashboard-next — Analytics page.
//
// Revenue charts, per-agent performance, skill breakdown, conversion funnel.
// All data from real /api/billing/revenue, /api/agents, /api/widgets/:id/stats.
// Charts drawn with Canvas 2D API directly — no chart libraries.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, formatUsdc, ApiError } from '../api.js';

const RANGES = [
	{ key: '7d',  days: 7,   label: '7 days',   granularity: 'day' },
	{ key: '30d', days: 30,  label: '30 days',  granularity: 'day' },
	{ key: '90d', days: 90,  label: '90 days',  granularity: 'day' },
	{ key: '1y',  days: 365, label: '12 months', granularity: 'week' },
];

let range = RANGES[1];
let me = null;

(async function boot() {
	const main = await mountShell();
	me = await requireUser();

	main.innerHTML = `
		<h1 class="dn-h1">Analytics</h1>
		<p class="dn-h1-sub">Revenue, engagement, and performance across your agents and skills.</p>
		<div data-slot="content" class="ana-root"></div>
	`;
	injectStyles();
	const root = main.querySelector('[data-slot="content"]');
	renderSkeletons(root);
	await loadAndRender(root);
})().catch(err => {
	if (err instanceof ApiError && err.status === 401) {
		location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		return;
	}
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `<h1 class="dn-h1">Analytics</h1><div class="dn-panel"><div class="dn-panel-title" style="color:var(--nxt-danger)">Failed to load</div><div class="dn-panel-sub">${esc(err?.message || 'unknown')}</div><button class="dn-btn" onclick="location.reload()">Reload</button></div>`;
});

function renderSkeletons(root) {
	root.innerHTML = `
		<div class="ana-range-bar">${RANGES.map(r => `<button class="ana-range-btn${r.key === range.key ? ' is-active' : ''}">${r.label}</button>`).join('')}</div>
		<div class="ana-kpi-row">${Array.from({ length: 4 }, () => `<div class="dn-panel ana-kpi"><div class="dn-skeleton" style="height:12px;width:80px;margin-bottom:8px"></div><div class="dn-skeleton" style="height:28px;width:100px"></div></div>`).join('')}</div>
		<div class="dn-panel" style="min-height:280px"><div class="dn-skeleton" style="height:12px;width:120px;margin-bottom:16px"></div><div class="dn-skeleton" style="height:220px;width:100%"></div></div>
		<div class="ana-two-col">
			<div class="dn-panel" style="min-height:200px"><div class="dn-skeleton" style="height:12px;width:100px;margin-bottom:12px"></div><div class="dn-skeleton" style="height:150px;width:100%"></div></div>
			<div class="dn-panel" style="min-height:200px"><div class="dn-skeleton" style="height:12px;width:100px;margin-bottom:12px"></div><div class="dn-skeleton" style="height:150px;width:100%"></div></div>
		</div>
	`;
}

async function loadAndRender(root) {
	const from = new Date(Date.now() - range.days * 86400_000).toISOString();
	const to = new Date().toISOString();

	const [revenue, agents, widgets, summary, monRevenue] = await Promise.all([
		safe(() => get(`/api/billing/revenue?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${range.granularity}`)),
		safe(() => get('/api/agents?limit=50')),
		safe(() => get('/api/widgets')),
		safe(() => get('/api/billing/summary')),
		safe(() => get(`/api/monetization/revenue?period=${range.key}`)),
	]);

	const agentList = agents?.agents ?? [];
	const widgetList = widgets?.widgets ?? [];

	const widgetStats = await Promise.all(
		widgetList.slice(0, 20).map(w =>
			get(`/api/widgets/${encodeURIComponent(w.id)}/stats`).catch(() => null)
		)
	);

	const totalViews = widgetStats.reduce((s, ws) => s + (ws?.stats?.view_count ?? ws?.stats?.total_views ?? 0), 0);
	const totalChats = widgetStats.reduce((s, ws) => s + (ws?.stats?.chat_count ?? ws?.stats?.total_chats ?? 0), 0);
	const recentViews = widgetStats.reduce((s, ws) => {
		const arr = ws?.stats?.recent_views_7d ?? [];
		return s + arr.reduce((a, p) => a + (p.count ?? p.value ?? 0), 0);
	}, 0);
	const recentChats = widgetStats.reduce((s, ws) => {
		const arr = ws?.stats?.recent_chats_7d ?? [];
		return s + arr.reduce((a, p) => a + (p.count ?? p.value ?? 0), 0);
	}, 0);

	const revTotal = Number(revenue?.summary?.net_total ?? 0);
	const revPayments = Number(revenue?.summary?.payment_count ?? 0);
	const timeseries = revenue?.timeseries ?? [];
	const bySkill = revenue?.by_skill ?? [];

	// Fetch per-agent payments for the activity table
	const recentPayments = await fetchRecentActivity(agentList);

	// Get top agent by revenue
	const topAgent = agentList.length > 0
		? agentList.reduce((best, a) => {
			const rev = Number(a.total_revenue ?? a.revenue ?? 0);
			return rev > (best.rev || 0) ? { name: a.name, rev } : best;
		}, { name: agentList[0].name, rev: 0 })
		: null;

	root.innerHTML = '';

	root.appendChild(renderRangeBar(root));
	root.appendChild(renderKpis({
		revTotal, revPayments, totalViews, totalChats,
		recentViews, recentChats, agentList, widgetList,
		topAgent,
	}));
	root.appendChild(renderRevenueChart(timeseries));
	root.appendChild(renderTwoCol(
		renderSkillBreakdown(bySkill),
		renderAgentTable(agentList, widgetList, widgetStats)
	));
	root.appendChild(renderActivityTable(recentPayments));

	root.querySelector('.ana-range-bar')?.addEventListener('click', e => {
		const btn = e.target.closest('.ana-range-btn');
		if (!btn) return;
		const idx = [...root.querySelector('.ana-range-bar').children].indexOf(btn);
		if (idx >= 0 && RANGES[idx]) {
			range = RANGES[idx];
			renderSkeletons(root);
			loadAndRender(root);
		}
	});
}

function safe(fn) { return fn().catch(() => null); }

// -- KPIs --

function renderKpis({ revTotal, revPayments, recentViews, recentChats, agentList, widgetList, topAgent }) {
	const el = document.createElement('div');
	el.className = 'ana-kpi-row';

	const avgPrice = revPayments > 0 ? (revTotal / 1_000_000) / revPayments : 0;
	const avgPriceStr = avgPrice > 0
		? '$' + avgPrice.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })
		: '$0.00';

	el.innerHTML = [
		kpiCard('Total Revenue', formatUsdc(revTotal), `${revPayments} payment${revPayments !== 1 ? 's' : ''}`, 'var(--nxt-success)'),
		kpiCard('Total Callers', recentChats.toLocaleString(), `${recentViews.toLocaleString()} views`, 'var(--nxt-accent)'),
		kpiCard('Avg Price/Call', avgPriceStr, `${range.label}`, 'var(--nxt-warn)'),
		kpiCard('Top Agent', topAgent?.name || '--', topAgent?.rev > 0 ? formatUsdc(topAgent.rev) : `${agentList.length} agent${agentList.length !== 1 ? 's' : ''}`, 'var(--nxt-accent)'),
	].join('');
	return el;
}

function kpiCard(label, value, sub, accentColor) {
	return `<div class="dn-panel ana-kpi">
		<div class="ana-kpi-label">${esc(label)}</div>
		<div class="ana-kpi-value" style="color:${accentColor || 'var(--nxt-ink)'}">${esc(value)}</div>
		<div class="ana-kpi-sub">${esc(sub)}</div>
	</div>`;
}

// -- Revenue chart (Canvas 2D) --

function renderRevenueChart(timeseries) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel ana-chart-panel';

	if (!timeseries.length) {
		panel.innerHTML = `<div class="dn-panel-title">Revenue Over Time</div><div class="ana-chart-empty">No revenue data for this period. <a href="/dashboard/monetize">Set up monetization</a></div>`;
		return panel;
	}

	panel.innerHTML = `
		<div class="dn-panel-title">Revenue Over Time</div>
		<div data-slot="chart" style="position:relative;width:100%;height:220px;margin-top:12px"></div>
	`;

	const chartHost = panel.querySelector('[data-slot="chart"]');
	requestAnimationFrame(() => paintCanvasLineChart(chartHost, timeseries));

	return panel;
}

function paintCanvasLineChart(host, timeseries) {
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
	const PAD = { top: 16, right: 16, bottom: 32, left: 52 };
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const data = timeseries.map(p => ({
		label: formatPeriod(p.period),
		value: Number(p.net_total ?? 0) / 1_000_000,
		count: Number(p.count ?? 0),
		raw: p,
	}));

	const max = Math.max(0.01, ...data.map(d => d.value));

	const points = data.map((d, i) => ({
		x: PAD.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
		y: PAD.top + innerH - (d.value / max) * innerH,
	}));

	let progress = 0;
	const duration = 600;
	const startTime = performance.now();

	function draw(now) {
		progress = Math.min(1, (now - startTime) / duration);
		const eased = 1 - Math.pow(1 - progress, 3);
		const visibleCount = Math.max(1, Math.ceil(eased * points.length));

		ctx.clearRect(0, 0, W, H);

		// Grid
		ctx.strokeStyle = 'rgba(255,255,255,0.05)';
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
			ctx.fillText('$' + (val >= 100 ? val.toFixed(0) : val.toFixed(2)), PAD.left - 8, y + 4);
		}

		// X labels
		const showEvery = Math.max(1, Math.ceil(data.length / 10));
		ctx.fillStyle = 'rgba(255,255,255,0.3)';
		ctx.font = '10px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		data.forEach((d, i) => {
			if (i % showEvery === 0 && i < visibleCount) {
				ctx.fillText(d.label, points[i].x, H - 6);
			}
		});

		const visible = points.slice(0, visibleCount);
		if (visible.length >= 2) {
			// Gradient fill
			const gradient = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + innerH);
			gradient.addColorStop(0, 'rgba(74, 222, 128, 0.2)');
			gradient.addColorStop(1, 'rgba(74, 222, 128, 0)');

			ctx.beginPath();
			ctx.moveTo(visible[0].x, PAD.top + innerH);
			visible.forEach(p => ctx.lineTo(p.x, p.y));
			ctx.lineTo(visible[visible.length - 1].x, PAD.top + innerH);
			ctx.closePath();
			ctx.fillStyle = gradient;
			ctx.fill();

			// Smooth line
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

			// End dot
			const last = visible[visible.length - 1];
			ctx.beginPath();
			ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
			ctx.fillStyle = '#4ade80';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0,0,0,0.3)';
			ctx.lineWidth = 1;
			ctx.stroke();
		} else if (visible.length === 1) {
			ctx.beginPath();
			ctx.arc(visible[0].x, visible[0].y, 5, 0, Math.PI * 2);
			ctx.fillStyle = '#4ade80';
			ctx.fill();
		}

		if (progress < 1) requestAnimationFrame(draw);
	}

	requestAnimationFrame(draw);

	// Tooltip
	canvas.addEventListener('mousemove', (e) => {
		const br = canvas.getBoundingClientRect();
		const mx = e.clientX - br.left;
		let closest = 0;
		let closestDist = Infinity;
		points.forEach((p, i) => {
			const d = Math.abs(p.x - mx);
			if (d < closestDist) { closestDist = d; closest = i; }
		});
		const d = data[closest];
		canvas.title = `${d.label}: $${d.value.toFixed(4)} (${d.count} payments)`;
	});
}

function formatPeriod(p) {
	const d = new Date(p);
	if (isNaN(d)) return String(p).slice(0, 10);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// -- Skill breakdown (horizontal bar chart with Canvas) --

function renderSkillBreakdown(bySkill) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	if (!bySkill.length) {
		panel.innerHTML = `<div class="dn-panel-title">Revenue by Skill</div><div class="ana-chart-empty">No skill revenue yet</div>`;
		return panel;
	}

	panel.innerHTML = `
		<div class="dn-panel-title">Revenue by Skill</div>
		<div data-slot="bars" style="position:relative;width:100%;height:200px;margin-top:12px"></div>
	`;

	const host = panel.querySelector('[data-slot="bars"]');
	requestAnimationFrame(() => paintHorizontalBarChart(host, bySkill));

	return panel;
}

function paintHorizontalBarChart(host, bySkill) {
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

	const sorted = [...bySkill].sort((a, b) => Number(b.net_total) - Number(a.net_total)).slice(0, 8);
	const max = Math.max(1, Number(sorted[0]?.net_total ?? 0));
	const colors = ['#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#94a3b8'];

	const labelW = 100;
	const valueW = 70;
	const barPad = 8;
	const barAreaW = W - labelW - valueW - barPad * 2;
	const rowH = Math.min(28, (H - 8) / sorted.length);
	const gap = 4;

	let progress = 0;
	const duration = 600;
	const startTime = performance.now();

	function draw(now) {
		progress = Math.min(1, (now - startTime) / duration);
		const eased = 1 - Math.pow(1 - progress, 3);

		ctx.clearRect(0, 0, W, H);

		sorted.forEach((s, i) => {
			const y = i * (rowH + gap) + 4;
			const val = Number(s.net_total);
			const pct = val / max;
			const barW = Math.max(2, pct * barAreaW * eased);
			const color = colors[i % colors.length];

			// Label
			ctx.fillStyle = 'rgba(255,255,255,0.7)';
			ctx.font = '12px Inter, system-ui, sans-serif';
			ctx.textAlign = 'left';
			const label = (s.skill || 'Other').replace(/_/g, ' ');
			ctx.fillText(label.length > 14 ? label.slice(0, 13) + '...' : label, 0, y + rowH / 2 + 4);

			// Bar
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.roundRect(labelW + barPad, y, barW, rowH, 4);
			ctx.fill();

			// Value
			ctx.fillStyle = 'rgba(255,255,255,0.5)';
			ctx.font = '11px Inter, system-ui, sans-serif';
			ctx.textAlign = 'left';
			ctx.fillText(formatUsdc(val), labelW + barPad + barW + 8, y + rowH / 2 + 4);
		});

		if (progress < 1) requestAnimationFrame(draw);
	}

	requestAnimationFrame(draw);
}

// -- Agent table --

function renderAgentTable(agents, widgets, widgetStats) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	if (!agents.length) {
		panel.innerHTML = `<div class="dn-panel-title">Agent Performance</div><div class="ana-chart-empty">No agents yet. <a href="/dashboard/agents">Create one</a></div>`;
		return panel;
	}

	const widgetMap = new Map();
	widgets.forEach((w, i) => {
		const stats = widgetStats[i];
		if (!stats) return;
		const key = w.avatar_id;
		if (key) {
			const prev = widgetMap.get(key) || { views: 0, chats: 0 };
			widgetMap.set(key, {
				views: prev.views + (stats.stats?.view_count ?? stats.stats?.total_views ?? 0),
				chats: prev.chats + (stats.stats?.chat_count ?? stats.stats?.total_chats ?? 0),
			});
		}
	});

	const rows = agents.slice(0, 10).map(a => {
		const wStats = widgetMap.get(a.avatar_id) || widgetMap.get(a.id) || { views: 0, chats: 0 };
		const convRate = wStats.views > 0 ? ((wStats.chats / wStats.views) * 100).toFixed(1) : '--';
		return `
			<tr>
				<td class="ana-tbl-name">${esc(a.name || a.slug || 'Unnamed')}</td>
				<td>${wStats.views.toLocaleString()}</td>
				<td>${wStats.chats.toLocaleString()}</td>
				<td>${convRate}${convRate !== '--' ? '%' : ''}</td>
			</tr>
		`;
	});

	panel.innerHTML = `
		<div class="dn-panel-title">Agent Performance</div>
		<div class="ana-tbl-wrap">
			<table class="ana-tbl">
				<thead><tr><th>Agent</th><th>Views</th><th>Chats</th><th>Conv.</th></tr></thead>
				<tbody>${rows.join('')}</tbody>
			</table>
		</div>
	`;
	return panel;
}

// -- Recent activity table --

async function fetchRecentActivity(agents) {
	if (!agents.length) return [];
	const top = agents.slice(0, 5);
	const lists = await Promise.all(
		top.map(a =>
			get(`/api/agents/${encodeURIComponent(a.id)}/payments?direction=received&limit=5`)
				.then(r => (r?.payments || []).map(p => ({ ...p, _agent: a })))
				.catch(() => [])
		)
	);
	const merged = lists.flat();
	merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
	return merged.slice(0, 20);
}

function renderActivityTable(payments) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	if (!payments.length) {
		panel.innerHTML = `
			<div class="dn-panel-title">Recent Activity</div>
			<div class="ana-chart-empty">No revenue events yet. Earnings will appear here as callers use your agents' skills.</div>
		`;
		return panel;
	}

	panel.innerHTML = `
		<div class="dn-panel-title">Recent Activity</div>
		<div class="dn-panel-sub" style="margin:2px 0 14px">Latest revenue events from skill calls and API usage.</div>
		<div style="overflow-x:auto">
			<table class="ana-tbl" style="min-width:560px">
				<thead>
					<tr>
						<th>Time</th>
						<th>Skill</th>
						<th style="text-align:right">Amount</th>
						<th>Agent</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					${payments.map(p => {
						const amount = p.amount ? formatUsdc(p.amount) : '--';
						const skill = p.skill_name || p.memo?.slice(0, 40) || 'API call';
						const agent = p._agent?.name || 'Agent';
						const status = (p.status || 'pending').toLowerCase();
						const tag = status === 'confirmed' || status === 'completed' || status === 'settled'
							? '<span class="dn-tag success">Settled</span>'
							: status === 'failed'
								? '<span class="dn-tag danger">Failed</span>'
								: '<span class="dn-tag warn">Pending</span>';
						return `
							<tr>
								<td style="color:var(--nxt-ink-dim);white-space:nowrap">${esc(relTime(p.created_at))}</td>
								<td style="font-weight:500">${esc(skill)}</td>
								<td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--nxt-success)">${esc(amount)}</td>
								<td style="color:var(--nxt-ink-dim)">${esc(agent)}</td>
								<td>${tag}</td>
							</tr>`;
					}).join('')}
				</tbody>
			</table>
		</div>
	`;
	return panel;
}

// -- Funnel --

function renderFunnel({ totalViews, totalChats, revPayments }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel ana-funnel-panel';

	const steps = [
		{ label: 'Widget Views', value: totalViews, color: '#60a5fa' },
		{ label: 'Conversations', value: totalChats, color: '#a78bfa' },
		{ label: 'Payments', value: revPayments, color: '#4ade80' },
	];
	const max = Math.max(1, steps[0].value);

	panel.innerHTML = `
		<div class="dn-panel-title">Conversion Funnel</div>
		<div class="dn-panel-sub">How visitors convert from views to payments (${range.label})</div>
		<div class="ana-funnel">
			${steps.map((s, i) => {
				const pct = Math.round((s.value / max) * 100);
				const dropoff = i > 0 && steps[i - 1].value > 0
					? ((1 - s.value / steps[i - 1].value) * 100).toFixed(1) + '% drop'
					: '';
				return `
					<div class="ana-funnel-step">
						<div class="ana-funnel-label">${esc(s.label)}</div>
						<div class="ana-funnel-bar-wrap">
							<div class="ana-funnel-bar" style="width:${Math.max(2, pct)}%;background:${s.color}"></div>
						</div>
						<div class="ana-funnel-val">${s.value.toLocaleString()}</div>
						${dropoff ? `<div class="ana-funnel-drop">${dropoff}</div>` : ''}
					</div>
				`;
			}).join('')}
		</div>
	`;
	return panel;
}

// -- Range bar --

function renderRangeBar(root) {
	const bar = document.createElement('div');
	bar.className = 'ana-range-bar';
	bar.innerHTML = RANGES.map(r =>
		`<button class="ana-range-btn${r.key === range.key ? ' is-active' : ''}" data-range="${r.key}">${r.label}</button>`
	).join('');
	return bar;
}

// -- Helpers --

function renderTwoCol(left, right) {
	const wrap = document.createElement('div');
	wrap.className = 'ana-two-col';
	wrap.appendChild(left);
	wrap.appendChild(right);
	return wrap;
}

// -- Styles --

function injectStyles() {
	if (document.getElementById('ana-styles')) return;
	const style = document.createElement('style');
	style.id = 'ana-styles';
	style.textContent = `
.ana-root { display: flex; flex-direction: column; gap: 18px; }

.ana-range-bar { display: flex; gap: 6px; margin-bottom: 2px; }
.ana-range-btn { padding: 6px 16px; border: 1px solid var(--nxt-stroke); border-radius: 8px; background: none; color: var(--nxt-ink-dim); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; }
.ana-range-btn:hover { background: rgba(255,255,255,0.04); color: var(--nxt-ink); }
.ana-range-btn.is-active { background: rgba(74,222,128,0.12); color: #4ade80; border-color: rgba(74,222,128,0.3); }

.ana-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.ana-kpi { padding: 18px 20px; }
.ana-kpi-label { font-size: 12px; color: var(--nxt-ink-dim); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; }
.ana-kpi-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.ana-kpi-sub { font-size: 12px; color: var(--nxt-ink-fade); margin-top: 2px; }

.ana-chart-panel { padding: 20px; }
.ana-chart-empty { padding: 40px 0; text-align: center; color: var(--nxt-ink-dim); font-size: 13px; }
.ana-chart-empty a { color: var(--nxt-success); }

.ana-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.ana-tbl-wrap { overflow-x: auto; margin-top: 12px; }
.ana-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.ana-tbl th { text-align: left; font-weight: 500; color: var(--nxt-ink-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--nxt-stroke); }
.ana-tbl td { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.ana-tbl-name { font-weight: 500; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ana-tbl tbody tr:hover { background: rgba(255,255,255,0.02); }

.ana-funnel-panel { padding: 20px; }
.ana-funnel { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
.ana-funnel-step { display: grid; grid-template-columns: 120px 1fr 70px 80px; gap: 10px; align-items: center; }
.ana-funnel-label { font-size: 13px; font-weight: 500; }
.ana-funnel-bar-wrap { height: 24px; background: rgba(255,255,255,0.03); border-radius: 6px; overflow: hidden; }
.ana-funnel-bar { height: 100%; border-radius: 6px; transition: width 0.4s ease; }
.ana-funnel-val { text-align: right; font-weight: 600; font-size: 15px; }
.ana-funnel-drop { font-size: 11px; color: rgba(248,113,113,0.8); text-align: right; }

@media (max-width: 900px) {
	.ana-kpi-row { grid-template-columns: repeat(2, 1fr); }
	.ana-two-col { grid-template-columns: 1fr; }
	.ana-funnel-step { grid-template-columns: 100px 1fr 60px; }
	.ana-funnel-drop { display: none; }
}
@media (max-width: 600px) {
	.ana-kpi-row { grid-template-columns: 1fr; }
	.ana-kpi-value { font-size: 22px; }
}
`;
	document.head.appendChild(style);
}
