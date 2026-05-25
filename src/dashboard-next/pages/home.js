// dashboard-next — Overview / home page.
//
// Hero strip with live 3D avatar previews, KPI row with sparklines,
// recent activity feed (stitched from transcripts + revenue events),
// and a 2x2 quick-actions grid. Polls KPIs + activity every 30s.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, ApiError } from '../api.js';

const POLL_MS = 30_000;
const DAYS_WINDOW = 7;
const REL_TIME_TICK_MS = 60_000;

const STATE = {
	pollHandle: null,
	relTimeHandle: null,
	kpi: { revenue: null, views: null, transcripts: null, avatars: null },
};

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();

	const greeting = me.display_name || me.username || (me.email ? me.email.split('@')[0] : 'creator');
	main.innerHTML = `
		<h1 class="dn-h1">Welcome back, ${esc(greeting)}.</h1>
		<p class="dn-h1-sub">Your live avatars, revenue, widget reach, and the latest visitor activity.</p>

		<div class="dnx-grid">
			<div class="dnx-col-main">
				<section data-slot="hero" class="dnx-hero"></section>
				<section data-slot="kpis"  class="dnx-kpis"></section>
				<section data-slot="quick" class="dnx-quick"></section>
			</div>
			<aside data-slot="activity" class="dnx-activity"></aside>
		</div>
	`;

	injectStyles();
	renderSkeletons(main);

	const slots = {
		hero: main.querySelector('[data-slot="hero"]'),
		kpis: main.querySelector('[data-slot="kpis"]'),
		quick: main.querySelector('[data-slot="quick"]'),
		activity: main.querySelector('[data-slot="activity"]'),
	};

	renderQuickActions(slots.quick);

	const [avatarsRes, widgetsRes] = await Promise.allSettled([
		get('/api/avatars?limit=50'),
		get('/api/widgets'),
	]);

	const avatars = avatarsRes.status === 'fulfilled' ? (avatarsRes.value?.avatars ?? []) : [];
	const widgets = widgetsRes.status === 'fulfilled' ? (widgetsRes.value?.widgets ?? []) : [];

	renderHero(slots.hero, avatars, avatarsRes.status === 'rejected' ? avatarsRes.reason : null);

	const refresh = async () => {
		await Promise.all([
			refreshKpis(slots.kpis, { avatars, widgets }),
			refreshActivity(slots.activity, { widgets }),
		]);
	};

	await refresh();

	STATE.pollHandle = setInterval(refresh, POLL_MS);
	STATE.relTimeHandle = setInterval(() => repaintRelTimes(slots.activity), REL_TIME_TICK_MS);

	window.addEventListener('beforeunload', () => {
		if (STATE.pollHandle) clearInterval(STATE.pollHandle);
		if (STATE.relTimeHandle) clearInterval(STATE.relTimeHandle);
	});
})().catch((err) => {
	if (err?.message === 'redirecting') return;
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `
		<h1 class="dn-h1">Overview</h1>
		<div class="dn-panel" style="border-color:rgba(255,107,138,0.3)">
			<div class="dn-panel-title" style="color:var(--nxt-danger)">Couldn't load this page</div>
			<div class="dn-panel-sub">${(err && err.message ? err.message : 'unknown error').replace(/[<>&]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]))}</div>
			<button class="dn-btn" onclick="location.reload()">Reload</button>
		</div>
	`;
});

// ── Skeletons ─────────────────────────────────────────────────────────────

function renderSkeletons(main) {
	main.querySelector('[data-slot="hero"]').innerHTML = Array.from({ length: 3 }, () =>
		`<div class="dn-skeleton dnx-hero-card" style="min-height:280px"></div>`,
	).join('');
	main.querySelector('[data-slot="kpis"]').innerHTML = Array.from({ length: 4 }, () => `
		<div class="dn-panel"><div class="dn-skeleton" style="height:12px;width:80px;margin-bottom:10px"></div>
		<div class="dn-skeleton" style="height:28px;width:100px;margin-bottom:10px"></div>
		<div class="dn-skeleton" style="height:36px;width:100%"></div></div>
	`).join('');
	main.querySelector('[data-slot="activity"]').innerHTML = `
		<div class="dn-panel">
			<div class="dn-panel-title">Recent activity</div>
			${Array.from({ length: 6 }, () => `<div class="dn-skeleton" style="height:34px;width:100%;margin:8px 0"></div>`).join('')}
		</div>
	`;
}

// ── Hero strip ────────────────────────────────────────────────────────────

function renderHero(host, avatars, err) {
	if (err && !(err instanceof ApiError && err.status === 401)) {
		host.innerHTML = `<div class="dn-panel" style="grid-column:1/-1">
			<div class="dn-panel-title">Avatars</div>
			<div style="color:var(--nxt-danger);font-size:13px">${esc(err.message || 'failed to load')}</div>
		</div>`;
		return;
	}

	if (!avatars.length) {
		host.innerHTML = `
			<a href="/create" class="dn-panel dnx-create-cta">
				<div class="dnx-create-icon">+</div>
				<div>
					<div class="dn-panel-title" style="margin:0 0 4px;font-size:16px">Create your first avatar</div>
					<div class="dn-panel-sub" style="margin:0">Snap a selfie and we'll spin up a full-body 3D agent in under a minute.</div>
				</div>
			</a>
		`;
		return;
	}

	const top = [...avatars]
		.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
		.slice(0, 3);

	host.innerHTML = top.map((a) => {
		const name = a.name || a.slug || 'Untitled avatar';
		const slug = a.slug || a.id;
		return `
			<article class="dnx-hero-card">
				<threews-avatar avatar-id="${esc(a.id)}" bg="transparent" hide-chrome></threews-avatar>
				<div class="dnx-hero-overlay">
					<a class="dn-btn" href="/a/${esc(slug)}">Open</a>
					<a class="dn-btn" href="/dashboard-next/widgets?avatar=${encodeURIComponent(a.id)}">Embed</a>
					<a class="dn-btn" href="/dashboard-next/avatars?edit=${encodeURIComponent(a.id)}">Edit</a>
				</div>
				<div class="dnx-hero-name">${esc(name)}</div>
			</article>
		`;
	}).join('');
}

// ── KPI row ───────────────────────────────────────────────────────────────

async function refreshKpis(host, ctx) {
	const fromIso = new Date(Date.now() - DAYS_WINDOW * 86400_000).toISOString();
	const toIso = new Date().toISOString();

	const [revenueRes, statsArrRes] = await Promise.allSettled([
		get(`/api/billing/revenue?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&granularity=day`),
		Promise.all(ctx.widgets.map((w) =>
			get(`/api/widgets/${encodeURIComponent(w.id)}/stats`).catch(() => null),
		)),
	]);

	const revenue = revenueRes.status === 'fulfilled' ? revenueRes.value : null;
	const widgetStats = statsArrRes.status === 'fulfilled' ? statsArrRes.value.filter(Boolean) : [];

	const revSeries = padDailySeries(
		(revenue?.timeseries ?? []).map((p) => ({
			day: typeof p.period === 'string' ? p.period.slice(0, 10) : new Date(p.period).toISOString().slice(0, 10),
			value: Number(p.net_total) / 1_000_000,
		})),
		DAYS_WINDOW,
	);
	const revTotal = revenue?.summary?.net_total ? Number(revenue.summary.net_total) / 1_000_000 : 0;
	const revLabel = revTotal.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

	const viewSeries = stackDailySeries(widgetStats.map((s) => s?.stats?.recent_views_7d ?? []));
	const viewTotal = viewSeries.reduce((a, p) => a + p.value, 0);

	const chatSeries = stackDailySeries(widgetStats.map((s) => s?.stats?.recent_chats_7d ?? []));
	const chatTotal = chatSeries.reduce((a, p) => a + p.value, 0);

	const avatarTotal = ctx.avatars.length;
	const avatarSeries = padDailySeries([], DAYS_WINDOW).map((p) => ({ ...p, value: avatarTotal }));

	const cards = [
		{
			key: 'revenue',
			label: 'Revenue · 7d',
			value: revLabel,
			numeric: revTotal,
			series: revSeries,
			empty: revTotal === 0,
			emptyCta: { label: 'Set up monetization', href: '/dashboard-next/monetize' },
		},
		{
			key: 'views',
			label: 'Widget views · 7d',
			value: viewTotal.toLocaleString('en-US'),
			numeric: viewTotal,
			series: viewSeries,
			empty: ctx.widgets.length === 0,
			emptyCta: { label: 'Embed an agent', href: '/dashboard-next/widgets' },
		},
		{
			key: 'transcripts',
			label: 'Chats · 7d',
			value: chatTotal.toLocaleString('en-US'),
			numeric: chatTotal,
			series: chatSeries,
			empty: ctx.widgets.length === 0,
			emptyCta: { label: 'Create a chat widget', href: '/dashboard-next/widgets' },
		},
		{
			key: 'avatars',
			label: 'Active avatars',
			value: avatarTotal.toLocaleString('en-US'),
			numeric: avatarTotal,
			series: avatarSeries,
			empty: avatarTotal === 0,
			emptyCta: { label: 'Create from selfie', href: '/create' },
		},
	];

	host.innerHTML = cards.map(renderKpiCard).join('');

	for (const c of cards) {
		const prev = STATE.kpi[c.key];
		if (prev != null && prev !== c.numeric) {
			tweenNumber(host.querySelector(`[data-kpi="${c.key}"] .dnx-kpi-value`), prev, c.numeric, c.value);
		}
		STATE.kpi[c.key] = c.numeric;
	}
}

function renderKpiCard(c) {
	const body = c.empty
		? `<div class="dnx-kpi-empty"><div class="dnx-kpi-value">${esc(c.value)}</div>
		   <a class="dn-btn" href="${c.emptyCta.href}">${esc(c.emptyCta.label)}</a></div>`
		: `<div class="dnx-kpi-value">${esc(c.value)}</div>
		   <div class="dnx-kpi-spark">${sparkSvg(c.series)}</div>`;
	return `
		<div class="dn-panel dnx-kpi" data-kpi="${esc(c.key)}">
			<div class="dnx-kpi-label">${esc(c.label)}</div>
			${body}
		</div>
	`;
}

// ── Activity feed ─────────────────────────────────────────────────────────

async function refreshActivity(host, ctx) {
	const events = await collectActivity(ctx.widgets);

	if (!events.length) {
		host.innerHTML = `
			<div class="dn-panel">
				<div class="dn-panel-title">Recent activity</div>
				<div class="dn-empty" style="padding:24px 12px">
					<h3>Nothing here yet</h3>
					<p>Visitor chats, payments, and embed views show up as soon as your agents are live.</p>
				</div>
			</div>
		`;
		return;
	}

	host.innerHTML = `
		<div class="dn-panel">
			<div class="dn-panel-title">Recent activity</div>
			<div class="dn-panel-sub">Last ${events.length} events across your account</div>
			<ul class="dnx-activity-list">
				${events.map((e) => `
					<li>
						<a href="${esc(e.href)}" class="dnx-activity-row">
							<span class="dnx-activity-icon" aria-hidden="true">${e.icon}</span>
							<span class="dnx-activity-text">${esc(e.text)}</span>
							<time class="dnx-activity-time" datetime="${esc(e.iso)}">${esc(relTime(e.iso))}</time>
						</a>
					</li>
				`).join('')}
			</ul>
		</div>
	`;
}

async function collectActivity(widgets) {
	const fromIso = new Date(Date.now() - 14 * 86400_000).toISOString();
	const calls = [
		get(`/api/billing/revenue?from=${encodeURIComponent(fromIso)}&granularity=day`).catch(() => null),
		...widgets.slice(0, 8).map((w) =>
			get(`/api/widgets/${encodeURIComponent(w.id)}/transcripts?limit=3`)
				.then((r) => ({ widget: w, threads: r?.threads ?? [] }))
				.catch(() => null),
		),
	];
	const results = await Promise.all(calls);
	const [revenue, ...threadBundles] = results;

	const out = [];

	for (const bundle of threadBundles) {
		if (!bundle) continue;
		for (const t of bundle.threads) {
			const iso = toIsoSafe(t.last_message_at || t.started_at);
			if (!iso) continue;
			const visitor = t.visitor_label || 'visitor';
			const preview = (t.preview || '').slice(0, 70).trim();
			out.push({
				iso,
				icon: ICON_CHAT,
				text: preview
					? `${visitor} on ${bundle.widget.name}: "${preview}"`
					: `${visitor} chatted with ${bundle.widget.name}`,
				href: `/dashboard-next/widgets?id=${encodeURIComponent(bundle.widget.id)}&thread=${encodeURIComponent(t.id)}`,
			});
		}
	}

	if (revenue?.timeseries?.length) {
		const recent = [...revenue.timeseries]
			.filter((p) => Number(p.net_total) > 0)
			.sort((a, b) => new Date(b.period) - new Date(a.period))
			.slice(0, 3);
		for (const p of recent) {
			const usd = (Number(p.net_total) / 1_000_000).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
			const iso = toIsoSafe(p.period);
			if (!iso) continue;
			out.push({
				iso,
				icon: ICON_COIN,
				text: `${p.count} payment${p.count === 1 ? '' : 's'} · ${usd} earned`,
				href: '/dashboard-next/monetize',
			});
		}
	}

	out.sort((a, b) => new Date(b.iso) - new Date(a.iso));
	return out.slice(0, 8);
}

function toIsoSafe(v) {
	if (!v) return null;
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

function repaintRelTimes(host) {
	for (const t of host.querySelectorAll('.dnx-activity-time')) {
		t.textContent = relTime(t.getAttribute('datetime'));
	}
}

const ICON_CHAT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10v7H6l-3 2.5V4z"/></svg>';
const ICON_COIN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v6M6 7h3.2a1.2 1.2 0 010 2.4H7a1.2 1.2 0 000 2.4h3.2"/></svg>';

// ── Quick actions ─────────────────────────────────────────────────────────

function renderQuickActions(host) {
	const actions = [
		{ href: '/create',                  title: 'Create avatar from selfie', sub: 'Snap → 3D agent in 60s',     icon: '+' },
		{ href: '/dashboard-next/widgets',  title: 'Embed an agent',            sub: 'Drop-in widget for any site', icon: '◧' },
		{ href: '/dashboard-next/monetize', title: 'View revenue',              sub: 'Earnings, payouts, plans',    icon: '$' },
		{ href: '/dashboard-next/api',      title: 'Open API keys',             sub: 'REST + MCP for your agents',  icon: '⌘' },
	];
	host.innerHTML = actions.map((a) => `
		<a class="dn-panel dnx-quick-card" href="${a.href}">
			<div class="dnx-quick-icon">${a.icon}</div>
			<div>
				<div class="dn-panel-title" style="margin:0 0 2px">${esc(a.title)}</div>
				<div class="dn-panel-sub" style="margin:0">${esc(a.sub)}</div>
			</div>
		</a>
	`).join('');
}

// ── Sparkline ─────────────────────────────────────────────────────────────

function sparkSvg(series) {
	if (!series.length) return '';
	const w = 220, h = 38, pad = 2;
	const max = Math.max(1, ...series.map((p) => p.value));
	const dx = (w - pad * 2) / Math.max(1, series.length - 1);
	const pts = series.map((p, i) => {
		const x = pad + i * dx;
		const y = h - pad - (p.value / max) * (h - pad * 2);
		return `${x.toFixed(2)},${y.toFixed(2)}`;
	});
	const line = pts.join(' ');
	const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(2)},${h - pad}`;
	return `
		<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">
			<polygon points="${area}" fill="var(--nxt-accent)" fill-opacity="0.12"/>
			<polyline points="${line}" fill="none" stroke="var(--nxt-accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
		</svg>
	`;
}

function padDailySeries(rows, days) {
	const today = startOfUtcDay(new Date());
	const out = [];
	const byDay = new Map(rows.filter((r) => r.day).map((r) => [r.day, Number(r.value || 0)]));
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 86400_000);
		const key = d.toISOString().slice(0, 10);
		out.push({ day: key, value: byDay.get(key) ?? 0 });
	}
	return out;
}

function stackDailySeries(arrays) {
	const acc = new Map();
	for (const arr of arrays) {
		for (const p of arr) {
			const k = p.day;
			acc.set(k, (acc.get(k) ?? 0) + Number(p.count ?? p.value ?? 0));
		}
	}
	const rows = [...acc.entries()].map(([day, value]) => ({ day, value }));
	return padDailySeries(rows, DAYS_WINDOW);
}

function startOfUtcDay(d) {
	const x = new Date(d);
	x.setUTCHours(0, 0, 0, 0);
	return x;
}

// ── Number tween ──────────────────────────────────────────────────────────

function tweenNumber(node, from, to, finalLabel) {
	if (!node) return;
	const start = performance.now();
	const dur = 400;
	const isCurrency = /[$€£]/.test(finalLabel);
	const fmt = (n) => isCurrency
		? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
		: Math.round(n).toLocaleString('en-US');
	function frame(t) {
		const k = Math.min(1, (t - start) / dur);
		const eased = 1 - Math.pow(1 - k, 3);
		const v = from + (to - from) * eased;
		node.textContent = fmt(v);
		if (k < 1) requestAnimationFrame(frame);
		else node.textContent = finalLabel;
	}
	requestAnimationFrame(frame);
}

// ── Styles (page-local) ───────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('dnx-home-styles')) return;
	const css = `
		.dnx-grid {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 340px;
			gap: 18px;
			align-items: start;
		}
		@media (max-width: 1100px) {
			.dnx-grid { grid-template-columns: minmax(0, 1fr); }
		}
		.dnx-col-main { display: flex; flex-direction: column; gap: 18px; min-width: 0; }

		.dnx-hero {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px;
		}
		@media (max-width: 760px) {
			.dnx-hero { grid-template-columns: 1fr; }
		}
		.dnx-hero-card {
			position: relative;
			border-radius: var(--nxt-radius);
			overflow: hidden;
			background: linear-gradient(180deg, rgba(20, 21, 28, 0.7), rgba(14, 15, 22, 0.5));
			border: 1px solid var(--nxt-stroke);
			aspect-ratio: 3 / 4;
			min-height: 280px;
			transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
		}
		.dnx-hero-card threews-avatar {
			position: absolute; inset: 0;
			width: 100%; height: 100%; display: block;
		}
		.dnx-hero-card:hover {
			transform: translateY(-4px);
			border-color: var(--nxt-stroke-strong);
			box-shadow: 0 14px 40px -20px rgba(154, 124, 255, 0.45);
		}
		.dnx-hero-overlay {
			position: absolute;
			left: 0; right: 0; bottom: 44px;
			display: flex;
			gap: 6px;
			justify-content: center;
			opacity: 0;
			transform: translateY(6px);
			transition: opacity 0.18s ease, transform 0.18s ease;
			pointer-events: none;
			z-index: 2;
		}
		.dnx-hero-card:hover .dnx-hero-overlay { opacity: 1; transform: translateY(0); pointer-events: auto; }
		.dnx-hero-overlay .dn-btn { backdrop-filter: blur(6px); background: rgba(20, 21, 28, 0.7); }
		.dnx-hero-name {
			position: absolute;
			left: 0; right: 0; bottom: 0;
			padding: 10px 12px;
			font-size: 12.5px;
			font-weight: 500;
			color: var(--nxt-ink);
			background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.55));
			text-overflow: ellipsis; overflow: hidden; white-space: nowrap;
			z-index: 1;
		}

		.dnx-create-cta {
			grid-column: 1 / -1;
			display: flex;
			align-items: center;
			gap: 18px;
			padding: 28px;
			cursor: pointer;
			transition: border-color 0.18s ease, background 0.18s ease;
		}
		.dnx-create-cta:hover { border-color: var(--nxt-accent); background: var(--nxt-accent-soft); }
		.dnx-create-icon {
			width: 56px; height: 56px; border-radius: 14px;
			background: var(--nxt-accent-soft);
			color: var(--nxt-accent-strong);
			display: grid; place-items: center;
			font-size: 28px; font-weight: 500;
			flex-shrink: 0;
		}

		.dnx-kpis {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 14px;
		}
		@media (max-width: 920px) { .dnx-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
		.dnx-kpi { padding: 14px 16px; }
		.dnx-kpi-label {
			font-size: 11.5px;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--nxt-ink-fade);
			margin-bottom: 8px;
		}
		.dnx-kpi-value {
			font-size: 26px;
			font-weight: 600;
			letter-spacing: -0.02em;
			color: var(--nxt-ink);
			line-height: 1.1;
			margin-bottom: 8px;
			font-variant-numeric: tabular-nums;
		}
		.dnx-kpi-spark { height: 38px; }
		.dnx-kpi-empty { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }

		.dnx-quick {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 14px;
		}
		@media (max-width: 620px) { .dnx-quick { grid-template-columns: 1fr; } }
		.dnx-quick-card {
			display: flex;
			align-items: center;
			gap: 14px;
			padding: 16px;
			cursor: pointer;
			transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
		}
		.dnx-quick-card:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-2px); }
		.dnx-quick-icon {
			width: 40px; height: 40px; border-radius: 10px;
			background: var(--nxt-accent-soft);
			color: var(--nxt-accent-strong);
			display: grid; place-items: center;
			font-size: 18px; font-weight: 600;
			flex-shrink: 0;
		}

		.dnx-activity { min-width: 0; position: sticky; top: calc(var(--dn-topbar-h) + 16px); }
		.dnx-activity-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; }
		.dnx-activity-row {
			display: grid;
			grid-template-columns: 22px minmax(0, 1fr) auto;
			align-items: center;
			gap: 10px;
			padding: 9px 6px;
			border-radius: 8px;
			color: var(--nxt-ink-dim);
			font-size: 13px;
			border-top: 1px solid var(--nxt-stroke);
			transition: background 0.12s ease, color 0.12s ease;
		}
		.dnx-activity-list li:first-child .dnx-activity-row { border-top: none; }
		.dnx-activity-row:hover { background: rgba(255,255,255,0.04); color: var(--nxt-ink); }
		.dnx-activity-icon { color: var(--nxt-ink-fade); display: inline-grid; place-items: center; }
		.dnx-activity-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dnx-activity-time { color: var(--nxt-ink-fade); font-size: 12px; font-variant-numeric: tabular-nums; }
	`;
	const tag = document.createElement('style');
	tag.id = 'dnx-home-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}
