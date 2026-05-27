// dashboard-next — Analytics page.
//
// Revenue charts, per-agent performance, skill breakdown, conversion funnel.
// All data from real /api/billing/revenue, /api/agents, /api/widgets/:id/stats.

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
		<div class="dn-panel" style="min-height:280px"><div class="dn-skeleton" style="height:12px;width:120px;margin-bottom:16px"></div><div class="dn-skeleton" style="height:200px;width:100%"></div></div>
		<div class="ana-two-col">
			<div class="dn-panel" style="min-height:200px"><div class="dn-skeleton" style="height:12px;width:100px;margin-bottom:12px"></div><div class="dn-skeleton" style="height:150px;width:100%"></div></div>
			<div class="dn-panel" style="min-height:200px"><div class="dn-skeleton" style="height:12px;width:100px;margin-bottom:12px"></div><div class="dn-skeleton" style="height:150px;width:100%"></div></div>
		</div>
	`;
}

async function loadAndRender(root) {
	const from = new Date(Date.now() - range.days * 86400_000).toISOString();
	const to = new Date().toISOString();

	const [revenue, agents, widgets, summary] = await Promise.all([
		safe(() => get(`/api/billing/revenue?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${range.granularity}`)),
		safe(() => get('/api/agents?limit=50')),
		safe(() => get('/api/widgets')),
		safe(() => get('/api/billing/summary')),
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

	root.innerHTML = '';

	root.appendChild(renderRangeBar(root));
	root.appendChild(renderKpis({ revTotal, revPayments, totalViews, totalChats, recentViews, recentChats, agentList, widgetList }));
	root.appendChild(renderRevenueChart(timeseries));
	root.appendChild(renderTwoCol(
		renderSkillBreakdown(bySkill),
		renderAgentTable(agentList, widgetList, widgetStats)
	));
	root.appendChild(renderFunnel({ totalViews: recentViews, totalChats: recentChats, revPayments }));

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

// ── KPIs ──────────────────────────────────────────────────────────────────

function renderKpis({ revTotal, revPayments, recentViews, recentChats, agentList, widgetList }) {
	const el = document.createElement('div');
	el.className = 'ana-kpi-row';
	el.innerHTML = [
		kpiCard('Revenue', formatUsdc(revTotal), `${revPayments} payment${revPayments !== 1 ? 's' : ''}`),
		kpiCard('Widget Views', recentViews.toLocaleString(), `${range.label}`),
		kpiCard('Conversations', recentChats.toLocaleString(), `${range.label}`),
		kpiCard('Active Agents', agentList.length.toLocaleString(), `${widgetList.length} widget${widgetList.length !== 1 ? 's' : ''}`),
	].join('');
	return el;
}

function kpiCard(label, value, sub) {
	return `<div class="dn-panel ana-kpi"><div class="ana-kpi-label">${esc(label)}</div><div class="ana-kpi-value">${esc(value)}</div><div class="ana-kpi-sub">${esc(sub)}</div></div>`;
}

// ── Revenue chart (SVG bar chart) ─────────────────────────────────────────

function renderRevenueChart(timeseries) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel ana-chart-panel';

	if (!timeseries.length) {
		panel.innerHTML = `<div class="dn-panel-title">Revenue Over Time</div><div class="ana-chart-empty">No revenue data for this period. <a href="/dashboard/monetize">Set up monetization</a></div>`;
		return panel;
	}

	const data = timeseries.map(p => ({
		label: formatPeriod(p.period),
		value: Number(p.net_total) / 1_000_000,
		count: Number(p.count ?? 0),
	}));

	const max = Math.max(1, ...data.map(d => d.value));
	const W = 800, H = 200, pad = 40, barGap = 4;
	const barW = Math.max(4, (W - pad * 2) / data.length - barGap);
	const chartH = H - pad;

	let bars = '';
	let labels = '';
	const showEvery = Math.max(1, Math.ceil(data.length / 12));

	data.forEach((d, i) => {
		const x = pad + i * (barW + barGap);
		const h = Math.max(1, (d.value / max) * chartH);
		const y = H - h;
		const usd = d.value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
		bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="var(--nxt-accent, #6c8aff)" opacity="0.8"><title>${d.label}: ${usd} (${d.count} payments)</title></rect>`;
		if (i % showEvery === 0) {
			labels += `<text x="${x + barW / 2}" y="${H + 14}" text-anchor="middle" font-size="10" fill="var(--nxt-ink-dim, #8b8d98)">${d.label}</text>`;
		}
	});

	const gridLines = Array.from({ length: 5 }, (_, i) => {
		const y = Math.round(H - (i / 4) * chartH);
		const val = ((i / 4) * max).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
		return `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--nxt-border, rgba(255,255,255,0.06))" stroke-width="0.5"/><text x="${pad - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--nxt-ink-dim, #8b8d98)">${val}</text>`;
	}).join('');

	panel.innerHTML = `
		<div class="dn-panel-title">Revenue Over Time</div>
		<svg viewBox="0 0 ${W} ${H + 24}" preserveAspectRatio="xMidYMid meet" class="ana-chart-svg">
			${gridLines}
			${bars}
			${labels}
		</svg>
	`;
	return panel;
}

function formatPeriod(p) {
	const d = new Date(p);
	if (isNaN(d)) return String(p).slice(0, 10);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Skill breakdown ───────────────────────────────────────────────────────

function renderSkillBreakdown(bySkill) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';

	if (!bySkill.length) {
		panel.innerHTML = `<div class="dn-panel-title">Revenue by Skill</div><div class="ana-chart-empty">No skill revenue yet</div>`;
		return panel;
	}

	const sorted = [...bySkill].sort((a, b) => Number(b.net_total) - Number(a.net_total)).slice(0, 10);
	const max = Math.max(1, Number(sorted[0]?.net_total ?? 0));
	const colors = ['#6c8aff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#94a3b8'];

	panel.innerHTML = `
		<div class="dn-panel-title">Revenue by Skill</div>
		<div class="ana-skill-list">
			${sorted.map((s, i) => {
				const pct = Math.round((Number(s.net_total) / max) * 100);
				const color = colors[i % colors.length];
				return `
					<div class="ana-skill-row">
						<div class="ana-skill-name">${esc(s.skill)}</div>
						<div class="ana-skill-bar-wrap">
							<div class="ana-skill-bar" style="width:${pct}%;background:${color}"></div>
						</div>
						<div class="ana-skill-val">${formatUsdc(s.net_total)}</div>
						<div class="ana-skill-count">${Number(s.count).toLocaleString()} tx</div>
					</div>
				`;
			}).join('')}
		</div>
	`;
	return panel;
}

// ── Agent table ───────────────────────────────────────────────────────────

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
		const convRate = wStats.views > 0 ? ((wStats.chats / wStats.views) * 100).toFixed(1) : '—';
		return `
			<tr>
				<td class="ana-tbl-name">${esc(a.name || a.slug || 'Unnamed')}</td>
				<td>${wStats.views.toLocaleString()}</td>
				<td>${wStats.chats.toLocaleString()}</td>
				<td>${convRate}${convRate !== '—' ? '%' : ''}</td>
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

// ── Funnel ────────────────────────────────────────────────────────────────

function renderFunnel({ totalViews, totalChats, revPayments }) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel ana-funnel-panel';

	const steps = [
		{ label: 'Widget Views', value: totalViews, color: '#6c8aff' },
		{ label: 'Conversations', value: totalChats, color: '#a78bfa' },
		{ label: 'Payments', value: revPayments, color: '#34d399' },
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

// ── Range bar ─────────────────────────────────────────────────────────────

function renderRangeBar(root) {
	const bar = document.createElement('div');
	bar.className = 'ana-range-bar';
	bar.innerHTML = RANGES.map(r =>
		`<button class="ana-range-btn${r.key === range.key ? ' is-active' : ''}" data-range="${r.key}">${r.label}</button>`
	).join('');
	return bar;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function renderTwoCol(left, right) {
	const wrap = document.createElement('div');
	wrap.className = 'ana-two-col';
	wrap.appendChild(left);
	wrap.appendChild(right);
	return wrap;
}

// ── Styles ────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('ana-styles')) return;
	const style = document.createElement('style');
	style.id = 'ana-styles';
	style.textContent = `
.ana-root { display: flex; flex-direction: column; gap: 18px; }

.ana-range-bar { display: flex; gap: 6px; margin-bottom: 2px; }
.ana-range-btn { padding: 6px 16px; border: 1px solid var(--nxt-border, rgba(255,255,255,0.07)); border-radius: 8px; background: none; color: var(--nxt-ink-dim, #8b8d98); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; }
.ana-range-btn:hover { background: var(--nxt-bg-2, #1a1b22); color: var(--nxt-ink, #e4e5ea); }
.ana-range-btn.is-active { background: rgba(108,138,255,0.12); color: #6c8aff; border-color: rgba(108,138,255,0.3); }

.ana-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.ana-kpi { padding: 18px 20px; }
.ana-kpi-label { font-size: 12px; color: var(--nxt-ink-dim, #8b8d98); margin-bottom: 4px; }
.ana-kpi-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
.ana-kpi-sub { font-size: 12px; color: var(--nxt-ink-faint, #5a5c68); margin-top: 2px; }

.ana-chart-panel { padding: 20px; }
.ana-chart-svg { width: 100%; height: auto; margin-top: 12px; }
.ana-chart-empty { padding: 40px 0; text-align: center; color: var(--nxt-ink-dim, #8b8d98); font-size: 13px; }
.ana-chart-empty a { color: #6c8aff; }

.ana-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

.ana-skill-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.ana-skill-row { display: grid; grid-template-columns: 120px 1fr 70px 60px; gap: 10px; align-items: center; font-size: 13px; }
.ana-skill-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ana-skill-bar-wrap { height: 8px; background: var(--nxt-bg-2, #1a1b22); border-radius: 4px; overflow: hidden; }
.ana-skill-bar { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
.ana-skill-val { text-align: right; font-weight: 600; }
.ana-skill-count { text-align: right; color: var(--nxt-ink-dim, #8b8d98); font-size: 12px; }

.ana-tbl-wrap { overflow-x: auto; margin-top: 12px; }
.ana-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.ana-tbl th { text-align: left; font-weight: 500; color: var(--nxt-ink-dim, #8b8d98); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 10px; border-bottom: 1px solid var(--nxt-border, rgba(255,255,255,0.07)); }
.ana-tbl td { padding: 10px; border-bottom: 1px solid var(--nxt-border, rgba(255,255,255,0.04)); }
.ana-tbl-name { font-weight: 500; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ana-tbl tbody tr:hover { background: var(--nxt-bg-2, rgba(255,255,255,0.02)); }

.ana-funnel-panel { padding: 20px; }
.ana-funnel { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
.ana-funnel-step { display: grid; grid-template-columns: 120px 1fr 70px 80px; gap: 10px; align-items: center; }
.ana-funnel-label { font-size: 13px; font-weight: 500; }
.ana-funnel-bar-wrap { height: 24px; background: var(--nxt-bg-2, #1a1b22); border-radius: 6px; overflow: hidden; }
.ana-funnel-bar { height: 100%; border-radius: 6px; transition: width 0.4s ease; }
.ana-funnel-val { text-align: right; font-weight: 600; font-size: 15px; }
.ana-funnel-drop { font-size: 11px; color: rgba(244,114,182,0.8); text-align: right; }

@media (max-width: 900px) {
	.ana-kpi-row { grid-template-columns: repeat(2, 1fr); }
	.ana-two-col { grid-template-columns: 1fr; }
	.ana-skill-row { grid-template-columns: 100px 1fr 60px; }
	.ana-skill-count { display: none; }
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
