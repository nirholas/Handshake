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
const ONBOARDING_DISMISSED_KEY = 'twx_onboarding_dismissed';

const STATE = {
	pollHandle: null,
	relTimeHandle: null,
	kpi: { revenue: null, views: null, transcripts: null, avatars: null },
};

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();

	const greeting = me.display_name || me.username || (me.email ? me.email.split('@')[0] : 'creator');
	const isNew = !me.created_at || (Date.now() - new Date(me.created_at).getTime()) < 30 * 86400_000;
	const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';

	main.innerHTML = `
		<h1 class="dn-h1">Welcome back, ${esc(greeting)}.</h1>
		<p class="dn-h1-sub">Your live avatars, revenue, widget reach, and the latest visitor activity.</p>

		${!dismissed ? `<section data-slot="onboarding" class="dnx-onboarding-wrap"></section>` : ''}

		<div class="dnx-grid">
			<div class="dnx-col-main">
				<section data-slot="hero" class="dnx-hero"></section>
				<section data-slot="kpis"  class="dnx-kpis"></section>
				<section data-slot="health" class="dnx-health-wrap"></section>
				<section data-slot="quick" class="dnx-quick"></section>
				<section data-slot="directory" class="dnx-directory"></section>
			</div>
			<aside data-slot="activity" class="dnx-activity"></aside>
		</div>
	`;

	injectStyles();
	renderSkeletons(main);

	const slots = {
		onboarding: main.querySelector('[data-slot="onboarding"]'),
		hero: main.querySelector('[data-slot="hero"]'),
		kpis: main.querySelector('[data-slot="kpis"]'),
		health: main.querySelector('[data-slot="health"]'),
		quick: main.querySelector('[data-slot="quick"]'),
		directory: main.querySelector('[data-slot="directory"]'),
		activity: main.querySelector('[data-slot="activity"]'),
	};

	const [avatarsRes, widgetsRes, agentsRes] = await Promise.allSettled([
		get('/api/avatars?limit=50'),
		get('/api/widgets'),
		get('/api/agents?limit=20'),
	]);

	const avatars = avatarsRes.status === 'fulfilled' ? (avatarsRes.value?.avatars ?? []) : [];
	const widgets = widgetsRes.status === 'fulfilled' ? (widgetsRes.value?.widgets ?? []) : [];
	const agents  = agentsRes.status === 'fulfilled'  ? (agentsRes.value?.agents  ?? []) : [];

	renderHero(slots.hero, avatars, avatarsRes.status === 'rejected' ? avatarsRes.reason : null);
	renderAgentHealth(slots.health, agents, widgets);
	renderQuickActions(slots.quick, { avatars, agents });
	renderDirectory(slots.directory);

	if (slots.onboarding) {
		renderOnboarding(slots.onboarding, { avatars, agents, widgets });
	}

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

	main.addEventListener('click', (e) => {
		const link = e.target.closest('a[href]');
		if (!link) return;
		const href = link.getAttribute('href');
		if (href && href.startsWith('/') && !href.startsWith('//')) {
			trackVisit(href.split('?')[0].split('#')[0]);
		}
	});
})().catch((err) => {
	if (err?.message === 'redirecting') return;
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `
		<h1 class="dn-h1">Overview</h1>
		<div class="dn-panel" style="border-color:rgba(150,155,163,0.3)">
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
	main.querySelector('[data-slot="quick"]').innerHTML = `
		<div style="margin-bottom:12px"><div class="dn-skeleton" style="height:14px;width:90px;margin-bottom:6px"></div><div class="dn-skeleton" style="height:11px;width:200px"></div></div>
		<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">${Array.from({ length: 6 }, () => `
			<div class="dn-panel" style="display:flex;align-items:center;gap:12px;padding:14px">
				<div class="dn-skeleton" style="width:36px;height:36px;border-radius:10px;flex-shrink:0"></div>
				<div style="flex:1;min-width:0">
					<div class="dn-skeleton" style="height:13px;width:65%;margin-bottom:5px"></div>
					<div class="dn-skeleton" style="height:11px;width:45%"></div>
				</div>
			</div>
		`).join('')}</div>`;
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
		return `
			<article class="dnx-hero-card">
				<threews-avatar avatar-id="${esc(a.id)}" bg="transparent" hide-chrome></threews-avatar>
				<div class="dnx-hero-overlay">
					<a class="dn-btn" href="/agent-next?id=${encodeURIComponent(a.id)}">Live page</a>
					<a class="dn-btn" href="/dashboard/widgets?avatar=${encodeURIComponent(a.id)}">Embed</a>
					<a class="dn-btn" href="/dashboard/avatars?edit=${encodeURIComponent(a.id)}">Edit</a>
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
			emptyCta: { label: 'Set up monetization', href: '/dashboard/monetize' },
		},
		{
			key: 'views',
			label: 'Widget views · 7d',
			value: viewTotal.toLocaleString('en-US'),
			numeric: viewTotal,
			series: viewSeries,
			empty: ctx.widgets.length === 0,
			emptyCta: { label: 'Embed an agent', href: '/dashboard/widgets' },
		},
		{
			key: 'transcripts',
			label: 'Chats · 7d',
			value: chatTotal.toLocaleString('en-US'),
			numeric: chatTotal,
			series: chatSeries,
			empty: ctx.widgets.length === 0,
			emptyCta: { label: 'Create a chat widget', href: '/dashboard/widgets' },
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
				href: `/dashboard/widgets?id=${encodeURIComponent(bundle.widget.id)}&thread=${encodeURIComponent(t.id)}`,
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
				href: '/dashboard/monetize',
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

// ── Onboarding checklist ──────────────────────────────────────────────────

function renderOnboarding(host, { avatars, agents, widgets }) {
	const steps = [
		{
			id: 'avatar',
			label: 'Create your first avatar',
			sub: 'Snap a selfie — your 3D agent is ready in under 60 seconds.',
			href: avatars.length === 0 ? '/start' : '/create',
			cta: avatars.length === 0 ? 'Start wizard →' : 'Create another',
			done: avatars.length > 0,
		},
		{
			id: 'agent',
			label: 'Build an agent identity',
			sub: 'Give your avatar a name, personality, and on-chain address.',
			href: agents.length === 0 ? '/start' : '/dashboard/agents',
			cta: 'Set up agent',
			done: agents.length > 0,
		},
		{
			id: 'widget',
			label: 'Embed a chat widget',
			sub: 'Drop your agent onto any website with a single HTML tag.',
			href: '/dashboard/widgets',
			cta: 'Create widget',
			done: widgets.length > 0,
		},
		{
			id: 'monetize',
			label: 'Start earning',
			sub: 'Charge per message, set a subscription, or let fans tip.',
			href: '/dashboard/monetize',
			cta: 'Set up monetization',
			done: false,
		},
	];

	const doneCount = steps.filter((s) => s.done).length;
	if (doneCount === steps.length) {
		host.remove();
		return;
	}

	const pct = Math.round((doneCount / steps.length) * 100);

	host.innerHTML = `
		<div class="dn-panel dnx-ob" id="dnx-onboarding">
			<div class="dnx-ob-head">
				<div>
					<div class="dn-panel-title" style="margin:0 0 2px">Getting started</div>
					<div class="dn-panel-sub" style="margin:0">${doneCount} of ${steps.length} steps complete</div>
				</div>
				<button class="dnx-ob-dismiss" aria-label="Dismiss getting started" title="Dismiss">
					<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
				</button>
			</div>
			<div class="dnx-ob-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
				<div class="dnx-ob-fill" style="width:${pct}%"></div>
			</div>
			<ol class="dnx-ob-steps">
				${steps.map((s, i) => `
					<li class="dnx-ob-step ${s.done ? 'is-done' : ''}">
						<span class="dnx-ob-num" aria-hidden="true">
							${s.done
								? `<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7l3.5 3.5L12 3"/></svg>`
								: `${i + 1}`}
						</span>
						<div class="dnx-ob-text">
							<span class="dnx-ob-label">${esc(s.label)}</span>
							<span class="dnx-ob-sub">${esc(s.sub)}</span>
						</div>
						${!s.done ? `<a class="dn-btn dnx-ob-btn" href="${s.href}">${esc(s.cta)} →</a>` : ''}
					</li>
				`).join('')}
			</ol>
		</div>
	`;

	host.querySelector('.dnx-ob-dismiss').addEventListener('click', () => {
		localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
		host.remove();
	});
}

// ── Shortcuts (quick actions) ─────────────────────────────────────────────

function categoryFor(href) {
	for (const s of DIRECTORY) {
		if (s.items.some((i) => i.href === href)) return s.group;
	}
	return 'Account & Settings';
}

function renderQuickActions(host, { avatars = [], agents = [] } = {}) {
	const firstAvatar = avatars[0];
	const firstAgent = agents[0];
	const pins = getPins();

	const defaults = [];
	if (firstAvatar) {
		defaults.push({ href: `/agent-next?id=${encodeURIComponent(firstAvatar.id)}`, title: 'View live agent page', sub: 'See how visitors experience your agent', iconKey: '/dashboard/agents', cat: 'Agents & Identity' });
	} else {
		defaults.push({ href: '/create', title: 'Create avatar from selfie', sub: 'Snap a photo, get a 3D agent in 60 seconds', iconKey: '/create', cat: 'Create & Build' });
	}
	if (firstAgent) {
		defaults.push({ href: `/app?agent=${encodeURIComponent(firstAgent.id)}`, title: 'Open 3D studio', sub: 'Edit, animate, and customize in 3D', iconKey: '/app', cat: '3D & Immersive' });
	} else {
		defaults.push({ href: '/dashboard/agents', title: 'Create an agent', sub: 'On-chain identity with wallet and skills', iconKey: '/dashboard/agents', cat: 'Agents & Identity' });
	}
	const repHref = (firstAvatar?.owner_wallet || firstAvatar?.owner_address)
		? `/reputation?address=${encodeURIComponent(firstAvatar.owner_wallet || firstAvatar.owner_address)}`
		: '/reputation';
	defaults.push(
		{ href: '/gallery-picker', title: 'Browse avatar gallery', sub: 'Explore public 3D avatars', iconKey: '/gallery-picker', cat: 'Create & Build' },
		{ href: '/dashboard/widgets', title: 'Embed an agent', sub: 'Drop-in chat widget for any site', iconKey: '/dashboard/widgets', cat: 'Distribute & Embed' },
		{ href: '/voice', title: 'Voice Lab', sub: 'Clone your voice for avatars', iconKey: '/voice', cat: 'Create & Build' },
		{ href: repHref, title: 'Reputation', sub: 'On-chain reviews and attestations', iconKey: '/reputation', cat: 'Agents & Identity' },
		{ href: '/dashboard/api', title: 'API keys', sub: 'REST + MCP for your agents', iconKey: '/dashboard/api', cat: 'Distribute & Embed' },
		{ href: '/brain', title: 'Brain', sub: 'Persona builder and model playground', iconKey: '/brain', cat: 'Create & Build' },
	);

	const used = new Set();
	const actions = [];
	for (const href of pins) {
		if (actions.length >= 8) break;
		const item = lookupItem(href);
		if (!item) continue;
		actions.push({ href: item.href, title: item.title, sub: item.sub, iconKey: item.href, cat: categoryFor(item.href), pinned: true });
		used.add(item.href);
	}
	for (const d of defaults) {
		if (actions.length >= 8) break;
		const base = d.href.split('?')[0];
		if (used.has(base) || used.has(d.href)) continue;
		actions.push(d);
		used.add(d.href);
	}

	const hasPins = pins.length > 0;

	host.innerHTML = `
		<div class="dnx-shortcuts-head">
			<h2 class="dnx-shortcuts-title">Shortcuts</h2>
			<p class="dnx-shortcuts-sub">${hasPins ? `${pins.length} pinned` : 'Pin pages from the directory below to customize'}</p>
		</div>
		<div class="dnx-shortcuts-grid" role="list">
			${actions.map((a) => {
				const icon = DIR_ICONS[a.iconKey] || DIR_ICONS['/create'] || '';
				const cc = CATEGORY_COLORS[a.cat] || CATEGORY_COLORS['Account & Settings'];
				return `
					<a class="dn-panel dnx-quick-card" href="${a.href}" role="listitem">
						<span class="dnx-quick-icon" style="background:rgba(${cc.accent},0.12);color:${cc.label}" aria-hidden="true">${icon}</span>
						<div class="dnx-quick-text">
							<span class="dnx-quick-title">${esc(a.title)}</span>
							<span class="dnx-quick-sub">${esc(a.sub)}</span>
						</div>
						${a.pinned ? '<span class="dnx-quick-pin-badge" aria-hidden="true"><svg viewBox="0 0 14 14" width="10" height="10" fill="currentColor"><path d="M5 1l1 4-3 2v1h4.5L8 13l.5-5H13v-1l-3-2 1-4z"/></svg></span>' : ''}
					</a>`;
			}).join('')}
		</div>
	`;
}

// ── Feature directory ─────────────────────────────────────────────────────

const DIR_ICONS = {
	'/create':              '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.5"/><path d="M16 18c0-3.3-2.7-6-6-6s-6 2.7-6 6"/><path d="M15 3v4M13 5h4"/></svg>',
	'/avatar-studio':       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="16" height="16" rx="2"/><circle cx="10" cy="8.5" r="2.5"/><path d="M6 15c0-2.2 1.8-4 4-4s4 1.8 4 4"/></svg>',
	'/brain':               '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3C7.5 3 5 5 5 8c0 1.5.5 2.5 1.2 3.3.5.5.8 1.2.8 2V15h6v-1.7c0-.8.3-1.5.8-2C14.5 10.5 15 9.5 15 8c0-3-2.5-5-5-5z"/><path d="M8 15v1a2 2 0 004 0v-1"/><path d="M8.5 8h3M8.5 10.5h3"/></svg>',
	'/voice':               '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="6" height="10" rx="3"/><path d="M4 10a6 6 0 0012 0"/><path d="M10 16v2"/></svg>',
	'/mocap-studio':        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="2"/><path d="M10 6v5M10 11l-3 5M10 11l3 5M7 9h6"/></svg>',
	'/gallery-picker':      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-5 5 6"/></svg>',
	'/import-rpm':          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v12M6 10l4 4 4-4"/><path d="M3 14v3h14v-3"/></svg>',
	'/create/selfie':       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="10" cy="10" r="3"/><path d="M6 3V2M14 3V2"/></svg>',
	'/walk':                '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="2"/><path d="M10 6v4l-2 4M10 10l2 4M7 8l3 2 3-2"/></svg>',
	'/pose':                '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="2"/><path d="M10 6v5M6 8l4 2 4-2M8 11l-2 5M12 11l2 5"/></svg>',
	'/dashboard/agents':    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M8 9h4M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>',
	'/onchain':             '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12a4 4 0 005.7 0l2-2a4 4 0 00-5.7-5.7l-1 1"/><path d="M12 8a4 4 0 00-5.7 0l-2 2a4 4 0 005.7 5.7l1-1"/></svg>',
	'/reputation':          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.7l-4.9 2.5.9-5.5L2 7.8l5.5-.8L10 2z"/></svg>',
	'/strategy-lab':        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2v5l-4 8h14l-4-8V2"/><path d="M5 18h10"/><path d="M7 2h6"/></svg>',
	'/profile':             '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.5"/><path d="M4 18c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>',
	'/dashboard/widgets':   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/></svg>',
	'/dashboard/api':       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l-4 5 4 5M13 5l4 5-4 5"/></svg>',
	'/marketplace':         '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l1.5-4h11L17 7"/><path d="M3 7h14v10H3V7z"/><path d="M8 12h4v5H8v-5z"/></svg>',
	'/discover':            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 2.5c-2 2.5-2 12.5 0 15M10 2.5c2 2.5 2 12.5 0 15M2.5 10h15"/></svg>',
	'/embed':               '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"/><path d="M8 9l-2 1.5L8 12M12 9l2 1.5L12 12"/></svg>',
	'/dashboard/monetize':  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v8M7.5 8h4a1.5 1.5 0 010 3H8.5a1.5 1.5 0 000 3h4"/></svg>',
	'/dashboard/tokens':    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l2.5 5 5.5.8-4 3.9.9 5.5L10 14.7l-4.9 2.5.9-5.5L2 7.8l5.5-.8L10 2z"/></svg>',
	'/dashboard/portfolio': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="11" rx="1.5"/><path d="M6 7V5a4 4 0 018 0v2"/><path d="M2 11h16"/></svg>',
	'/pump-live':           '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2"/><path d="M6 6a5.5 5.5 0 000 8M14 6a5.5 5.5 0 010 8"/><path d="M3.5 3.5a9 9 0 000 13M16.5 3.5a9 9 0 010 13"/></svg>',
	'/launchpad':           '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l-3 10h6L10 2z"/><path d="M7 12l-2 6M13 12l2 6M8 18h4"/></svg>',
	'/pay':                 '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 8h16"/><path d="M6 13h3"/></svg>',
	'/pricing':             '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h3v16H5zM12 6h3v12h-3z"/></svg>',
	'/pumpfun-trending':    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l4-6 3 3 7-11"/><path d="M14 3h3v3"/></svg>',
	'/pumpfun-search':      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8.5" r="5"/><path d="M15 15l2.5 2.5"/></svg>',
	'/demos':               '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M8 7.5v5l4.5-2.5z"/></svg>',
	'/tutorials':           '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h5a3 3 0 013 3v11a2 2 0 00-2-2H2V4z"/><path d="M18 4h-5a3 3 0 00-3 3v11a2 2 0 012-2h6V4z"/></svg>',
	'/community':           '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="2.5"/><circle cx="14" cy="7" r="2"/><path d="M2 16c.8-2.8 2.8-4.2 5-4.2s4.2 1.4 5 4.2"/><path d="M13.5 11.8c1.5 0 3 1.2 3.5 3.2"/></svg>',
	'/features':            '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12v12H4z"/><path d="M4 10h12M10 4v12"/></svg>',
	'/playground':          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4-4 4"/><path d="M10 14h6"/></svg>',
	'/avatar-sdk':          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 8h6M7 11h4"/></svg>',
	'/xr':                  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="18" height="10" rx="3"/><circle cx="7" cy="10" r="2.5"/><circle cx="13" cy="10" r="2.5"/></svg>',
	'/club':                '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l1.5 3.5H16l-3 3 1.5 4L10 10l-4.5 2.5 1.5-4-3-3h4.5z"/><path d="M5 16h10"/><path d="M7 18h6"/></svg>',
	'/app':                 '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h16v12H2V4z"/><path d="M2 8h16"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="7" cy="6" r=".6" fill="currentColor"/></svg>',
	'/dashboard/account':   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.5"/><path d="M4 18c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>',
	'/dashboard/settings':  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>',
	'/dashboard/library':   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h4v12H4zM12 4h4v12h-4z"/><path d="M6 7h0M14 7h0"/></svg>',
	'/dashboard/avatars':   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c1.1-3.4 3.8-5 6.5-5s5.4 1.6 6.5 5"/></svg>',
};

const CATEGORY_COLORS = {
	'Create & Build':     { accent: '139,92,246',  label: '#a78bfa' },
	'Agents & Identity':  { accent: '59,130,246',  label: '#60a5fa' },
	'Distribute & Embed': { accent: '16,185,129',  label: '#34d399' },
	'Monetize & Trade':   { accent: '245,158,11',  label: '#fbbf24' },
	'Learn & Explore':    { accent: '236,72,153',  label: '#f472b6' },
	'Account & Settings': { accent: '148,163,184', label: '#94a3b8' },
	'3D & Immersive':     { accent: '6,182,212',   label: '#22d3ee' },
	'Trading & Pump.fun': { accent: '249,115,22',  label: '#fb923c' },
};

const DIRECTORY = [
	{
		group: 'Create & Build',
		items: [
			{ href: '/create',          title: 'Create Avatar',      sub: 'Snap a selfie — 3D agent in 60 seconds' },
			{ href: '/create/selfie',   title: 'Selfie Capture',     sub: 'Camera-based avatar creation flow' },
			{ href: '/avatar-studio',   title: 'Avatar Studio',      sub: 'Full 3D editor with lighting and poses' },
			{ href: '/brain',           title: 'Brain',              sub: 'Persona builder, model playground, agent voice' },
			{ href: '/voice',           title: 'Voice Lab',          sub: 'Clone your voice for TTS and lip-sync' },
			{ href: '/mocap-studio',    title: 'MoCap Studio',       sub: 'Motion capture for custom animations' },
			{ href: '/gallery-picker',  title: 'Gallery Picker',     sub: 'Browse and pick from public 3D avatars' },
			{ href: '/import-rpm',      title: 'Import RPM',         sub: 'Import a Ready Player Me avatar' },
		],
	},
	{
		group: 'Agents & Identity',
		items: [
			{ href: '/dashboard/agents', title: 'Manage Agents',     sub: 'Agent identity, wallet, personality' },
			{ href: '/onchain',          title: 'On-chain (ERC-8004)', sub: 'Register agents on-chain' },
			{ href: '/reputation',       title: 'Reputation',        sub: 'Reviews, attestations, and trust scores' },
			{ href: '/strategy-lab',     title: 'Strategy Lab',      sub: 'Configure agent trading strategies' },
			{ href: '/profile',          title: 'Profile',           sub: 'Your public creator profile' },
		],
	},
	{
		group: 'Distribute & Embed',
		items: [
			{ href: '/dashboard/widgets', title: 'Widgets',          sub: 'Chat widgets, embed codes, transcripts' },
			{ href: '/dashboard/api',     title: 'API & Embed',      sub: 'REST keys, MCP config, embed policy' },
			{ href: '/marketplace',       title: 'Marketplace',      sub: 'Browse, buy, and sell agents and avatars' },
			{ href: '/discover',          title: 'Discover',         sub: 'Explore the on-chain agent directory' },
			{ href: '/embed',             title: 'Embed Docs',       sub: 'How to embed agents on your site' },
		],
	},
	{
		group: 'Monetize & Trade',
		items: [
			{ href: '/dashboard/monetize',   title: 'Monetize',      sub: 'Revenue, subscriptions, and withdrawals' },
			{ href: '/dashboard/tokens',     title: 'Tokens',        sub: 'Launch tokens on Pump.fun with bonding curves' },
			{ href: '/dashboard/portfolio',  title: 'Portfolio',          sub: 'Live balances, price charts, and market data' },
			{ href: '/launchpad',            title: 'Launchpad',      sub: 'Token and project launchpad creator' },
			{ href: '/pay',                  title: 'Payments (x402)', sub: 'Payment hub and hosted checkout' },
			{ href: '/pricing',              title: 'Pricing',        sub: 'Platform plans and feature comparison' },
		],
	},
	{
		group: 'Trading & Pump.fun',
		items: [
			{ href: '/pump-live',           title: 'Pump.fun Live',   sub: 'Real-time token feed and activity' },
			{ href: '/pumpfun-trending',    title: 'Trending Tokens', sub: 'Top trending tokens right now' },
			{ href: '/pumpfun-search',      title: 'Token Search',    sub: 'Search for any Pump.fun token' },
		],
	},
	{
		group: '3D & Immersive',
		items: [
			{ href: '/app',                title: '3D Viewer',        sub: 'Interactive 3D agent editor and viewer' },
			{ href: '/walk',               title: 'Walk Viewer',      sub: 'Walk and animation preview' },
			{ href: '/pose',               title: 'Pose Editor',      sub: 'Pose and position your avatar' },
			{ href: '/xr',                 title: 'XR / AR',          sub: 'Augmented and extended reality views' },
		],
	},
	{
		group: 'Learn & Explore',
		items: [
			{ href: '/demos',              title: 'Demos',           sub: 'Interactive agent demos and showcases' },
			{ href: '/tutorials',          title: 'Tutorials',       sub: 'Step-by-step guides and walkthroughs' },
			{ href: '/community',          title: 'Community',       sub: 'Connect with other creators' },
			{ href: '/features',           title: 'Features',        sub: 'Platform capabilities overview' },
			{ href: '/playground',         title: 'Playground',      sub: 'Experiment with agents interactively' },
			{ href: '/avatar-sdk',         title: 'Avatar SDK',      sub: 'Developer docs for avatar integration' },
			{ href: '/club',               title: 'Club / VIP',      sub: 'Exclusive membership and perks' },
		],
	},
	{
		group: 'Account & Settings',
		items: [
			{ href: '/dashboard/account',   title: 'Account',       sub: 'Wallets, SNS names, delegation, provider keys' },
			{ href: '/dashboard/settings',  title: 'Settings',      sub: 'Notifications, storage, LLM usage, vanity URLs' },
			{ href: '/dashboard/library',   title: 'Library',       sub: 'Animations, memory, voice clips, strategy' },
			{ href: '/dashboard/avatars',   title: 'Avatars',       sub: 'Manage all your 3D avatar creations' },
		],
	},
];

const RECENTS_KEY = 'twx_recent_pages';
const PINS_KEY = 'twx_pinned_pages';
const MAX_RECENTS = 6;

function getRecents() {
	try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; } catch { return []; }
}

function getPins() {
	try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; }
}

function togglePin(href) {
	const pins = getPins();
	const idx = pins.indexOf(href);
	if (idx >= 0) pins.splice(idx, 1);
	else pins.unshift(href);
	localStorage.setItem(PINS_KEY, JSON.stringify(pins.slice(0, 12)));
	return pins;
}

function allItems() {
	return DIRECTORY.flatMap((s) => s.items);
}

function lookupItem(href) {
	return allItems().find((i) => i.href === href);
}

function trackVisit(href) {
	const base = href.split('?')[0].split('#')[0];
	const recents = getRecents().filter((r) => r !== base);
	recents.unshift(base);
	localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, 20)));
}

function debounce(fn, ms) {
	let id;
	return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}

function renderDirectory(host) {
	const DIR_COLLAPSED_KEY = 'twx_dir_collapsed';
	const collapsed = localStorage.getItem(DIR_COLLAPSED_KEY) === '1';
	const pins = getPins();
	const recents = getRecents().filter((r) => !pins.includes(r)).slice(0, MAX_RECENTS);
	const hasPersonalized = pins.length > 0 || recents.length > 0;

	const dirItemHtml = (item, section) => {
		const icon = DIR_ICONS[item.href] || '';
		const cc = CATEGORY_COLORS[section.group] || CATEGORY_COLORS['Account & Settings'];
		const isPinned = getPins().includes(item.href);
		return `
			<a href="${item.href}" class="dnx-dir-item" data-href="${esc(item.href)}" data-title="${esc(item.title)}" data-sub="${esc(item.sub)}">
				<div class="dnx-dir-item-row">
					<span class="dnx-dir-item-icon" style="background:rgba(${cc.accent},0.1);color:${cc.label}">${icon}</span>
					<div class="dnx-dir-item-text">
						<div class="dnx-dir-item-title">${esc(item.title)}</div>
						<div class="dnx-dir-item-sub">${esc(item.sub)}</div>
					</div>
					<button class="dnx-dir-pin${isPinned ? ' is-pinned' : ''}" data-pin="${esc(item.href)}" title="${isPinned ? 'Unpin' : 'Pin to shortcuts'}" aria-label="${isPinned ? 'Unpin' : 'Pin'}">
						<svg viewBox="0 0 14 14" width="12" height="12" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 1l1 4-3 2v1h4.5L8 13l.5-5H13v-1l-3-2 1-4z"/></svg>
					</button>
				</div>
			</a>
		`;
	};

	const personalizedHtml = hasPersonalized ? `
		${pins.length ? `
			<div class="dnx-dir-section">
				<div class="dnx-dir-group-label" style="color:#fbbf24">Pinned</div>
				<div class="dnx-dir-items">
					${pins.map((href) => {
						const item = lookupItem(href);
						if (!item) return '';
						const section = DIRECTORY.find((s) => s.items.includes(item)) || DIRECTORY[0];
						return dirItemHtml(item, section);
					}).join('')}
				</div>
			</div>
		` : ''}
		${recents.length ? `
			<div class="dnx-dir-section">
				<div class="dnx-dir-group-label" style="color:#94a3b8">Recently Visited</div>
				<div class="dnx-dir-items">
					${recents.map((href) => {
						const item = lookupItem(href);
						if (!item) return '';
						const section = DIRECTORY.find((s) => s.items.includes(item)) || DIRECTORY[0];
						return dirItemHtml(item, section);
					}).join('')}
				</div>
			</div>
		` : ''}
		<div class="dnx-dir-divider"></div>
	` : '';

	host.innerHTML = `
		<div class="dn-panel dnx-dir">
			<div class="dnx-dir-head-bar">
				<button class="dnx-dir-head-toggle" aria-expanded="${!collapsed}" data-action="dir-toggle">
					<div>
						<div class="dn-panel-title" style="margin:0 0 2px">All Features & Pages</div>
						<div class="dn-panel-sub" style="margin:0">Every tool, page, and feature on three.ws — all in one place.</div>
					</div>
					<span class="dnx-dir-chevron" aria-hidden="true">
						<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
					</span>
				</button>
				<div class="dnx-dir-search-wrap" role="search" aria-label="Filter pages">
					<svg class="dnx-dir-search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M13 13l-3-3"/></svg>
					<input type="text" class="dnx-dir-search" placeholder="Filter pages..." data-action="dir-search" autocomplete="off" spellcheck="false" aria-label="Filter pages" aria-controls="dnx-dir-body" />
					<span class="dnx-dir-search-count" aria-live="polite" data-slot="search-count"></span>
				</div>
			</div>
			<div class="dnx-dir-body${collapsed ? ' is-collapsed' : ''}" data-slot="dir-body">
				${personalizedHtml}
				${DIRECTORY.map((section) => {
					const cc = CATEGORY_COLORS[section.group] || CATEGORY_COLORS['Account & Settings'];
					return `
						<div class="dnx-dir-section" data-group="${esc(section.group)}">
							<div class="dnx-dir-group-label" style="color:${cc.label}">${esc(section.group)}</div>
							<div class="dnx-dir-items">
								${section.items.map((item) => dirItemHtml(item, section)).join('')}
							</div>
						</div>
					`;
				}).join('')}
				<div class="dnx-dir-no-results" style="display:none">No pages match your search.</div>
			</div>
		</div>
	`;

	host.querySelector('[data-action="dir-toggle"]').addEventListener('click', () => {
		const body = host.querySelector('.dnx-dir-body');
		const btn = host.querySelector('[data-action="dir-toggle"]');
		const isCollapsed = body.classList.toggle('is-collapsed');
		btn.setAttribute('aria-expanded', !isCollapsed);
		localStorage.setItem(DIR_COLLAPSED_KEY, isCollapsed ? '1' : '0');
	});

	const searchInput = host.querySelector('[data-action="dir-search"]');
	const searchCount = host.querySelector('[data-slot="search-count"]');

	function runFilter() {
		const q = searchInput.value.trim().toLowerCase();
		const body = host.querySelector('[data-slot="dir-body"]');
		const items = body.querySelectorAll('.dnx-dir-item');
		const sections = body.querySelectorAll('.dnx-dir-section');
		const noResults = body.querySelector('.dnx-dir-no-results');
		let visibleCount = 0;

		if (!q) {
			items.forEach((el) => { el.style.display = ''; el.style.opacity = ''; });
			sections.forEach((el) => el.style.display = '');
			noResults.style.display = 'none';
			searchCount.textContent = '';
			if (body.classList.contains('is-collapsed')) {
				body.classList.remove('is-collapsed');
				host.querySelector('[data-action="dir-toggle"]').setAttribute('aria-expanded', 'true');
			}
			return;
		}

		if (body.classList.contains('is-collapsed')) {
			body.classList.remove('is-collapsed');
			host.querySelector('[data-action="dir-toggle"]').setAttribute('aria-expanded', 'true');
		}

		items.forEach((el) => {
			const title = (el.dataset.title || '').toLowerCase();
			const sub = (el.dataset.sub || '').toLowerCase();
			const href = (el.dataset.href || '').toLowerCase();
			const match = title.includes(q) || sub.includes(q) || href.includes(q);
			el.style.display = match ? '' : 'none';
			if (match) visibleCount++;
		});

		sections.forEach((el) => {
			const hasVisible = [...el.querySelectorAll('.dnx-dir-item')].some((i) => i.style.display !== 'none');
			el.style.display = hasVisible ? '' : 'none';
		});

		noResults.style.display = visibleCount === 0 ? '' : 'none';
		searchCount.textContent = q ? `${visibleCount} result${visibleCount !== 1 ? 's' : ''}` : '';
	}

	const debouncedFilter = debounce(runFilter, 120);
	searchInput.addEventListener('input', debouncedFilter);

	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			searchInput.value = '';
			runFilter();
			searchInput.blur();
		}
	});

	host.addEventListener('click', (e) => {
		const pinBtn = e.target.closest('.dnx-dir-pin');
		if (pinBtn) {
			e.preventDefault();
			e.stopPropagation();
			const href = pinBtn.dataset.pin;
			togglePin(href);
			renderDirectory(host);
			return;
		}
		const link = e.target.closest('.dnx-dir-item');
		if (link && link.dataset.href) {
			trackVisit(link.dataset.href);
		}
	});
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
			<polygon points="${area}" fill="var(--nxt-ink-dim)" fill-opacity="0.10"/>
			<polyline points="${line}" fill="none" stroke="var(--nxt-ink-dim)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
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
			box-shadow: 0 14px 40px -20px rgba(200, 202, 208, 0.25);
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
		.dnx-create-cta:hover { border-color: var(--nxt-stroke-strong); background: rgba(255,255,255,0.03); }
		.dnx-create-icon {
			width: 56px; height: 56px; border-radius: 14px;
			background: rgba(255,255,255,0.05);
			border: 1px solid var(--nxt-stroke);
			color: var(--nxt-ink-dim);
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

		/* ── Shortcuts ── */
		.dnx-quick { display: flex; flex-direction: column; }
		.dnx-shortcuts-head { margin-bottom: 12px; }
		.dnx-shortcuts-title {
			font-size: 15px; font-weight: 600; color: var(--nxt-ink);
			margin: 0 0 2px; line-height: 1.3;
		}
		.dnx-shortcuts-sub {
			font-size: 12.5px; color: var(--nxt-ink-fade); margin: 0;
		}
		.dnx-shortcuts-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
		}
		@media (max-width: 620px) { .dnx-shortcuts-grid { grid-template-columns: 1fr; } }
		.dnx-quick-card {
			display: flex; align-items: center; gap: 12px;
			padding: 13px 14px; cursor: pointer; position: relative;
			transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
		}
		.dnx-quick-card:hover {
			border-color: var(--nxt-stroke-strong);
			transform: translateY(-2px);
			box-shadow: 0 6px 20px -8px rgba(0,0,0,0.3);
		}
		.dnx-quick-card:focus-visible {
			outline: 2px solid var(--nxt-ink-dim);
			outline-offset: 2px;
		}
		.dnx-quick-icon {
			width: 36px; height: 36px; border-radius: 10px;
			display: grid; place-items: center; flex-shrink: 0;
			transition: transform 0.14s ease;
		}
		.dnx-quick-icon svg { width: 18px; height: 18px; }
		.dnx-quick-card:hover .dnx-quick-icon { transform: scale(1.1); }
		.dnx-quick-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
		.dnx-quick-title {
			font-size: 13.5px; font-weight: 550; color: var(--nxt-ink);
			line-height: 1.3;
		}
		.dnx-quick-sub {
			font-size: 12px; color: var(--nxt-ink-fade);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.dnx-quick-pin-badge {
			position: absolute; top: 7px; right: 7px;
			color: #fbbf24; opacity: 0.5;
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
		.dnx-activity-row:focus-visible { outline: 2px solid var(--nxt-ink-dim); outline-offset: -2px; border-radius: 8px; }
		.dnx-activity-icon { color: var(--nxt-ink-fade); display: inline-grid; place-items: center; }
		.dnx-activity-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dnx-activity-time { color: var(--nxt-ink-fade); font-size: 12px; font-variant-numeric: tabular-nums; }

		/* ── Onboarding checklist ── */
		.dnx-onboarding-wrap { margin-bottom: 4px; }
		.dnx-ob { padding: 18px 20px; }
		.dnx-ob-head {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			margin-bottom: 12px;
		}
		.dnx-ob-dismiss {
			background: none; border: none; cursor: pointer;
			color: var(--nxt-ink-fade); padding: 4px; border-radius: 6px;
			display: grid; place-items: center; flex-shrink: 0;
			transition: color 0.12s ease, background 0.12s ease;
		}
		.dnx-ob-dismiss:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.06); }
		.dnx-ob-bar {
			height: 4px; border-radius: 4px;
			background: var(--nxt-stroke);
			margin-bottom: 16px; overflow: hidden;
		}
		.dnx-ob-fill {
			height: 100%; border-radius: 4px;
			background: var(--nxt-ink-dim);
			transition: width 0.4s ease;
		}
		.dnx-ob-steps {
			list-style: none; padding: 0; margin: 0;
			display: flex; flex-direction: column; gap: 2px;
		}
		.dnx-ob-step {
			display: flex; align-items: center; gap: 12px;
			padding: 9px 8px; border-radius: 8px;
			transition: background 0.12s ease;
		}
		.dnx-ob-step:hover { background: rgba(255,255,255,0.04); }
		.dnx-ob-step.is-done { opacity: 0.5; }
		.dnx-ob-num {
			width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
			display: grid; place-items: center;
			font-size: 11px; font-weight: 600;
			background: rgba(255,255,255,0.06);
			color: var(--nxt-ink-dim);
			border: 1px solid var(--nxt-stroke);
		}
		.dnx-ob-step.is-done .dnx-ob-num {
			background: rgba(255,255,255,0.08);
			color: var(--nxt-ink);
			border-color: var(--nxt-stroke-strong);
		}
		.dnx-ob-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
		.dnx-ob-label { font-size: 13.5px; font-weight: 500; color: var(--nxt-ink); }
		.dnx-ob-sub { font-size: 12px; color: var(--nxt-ink-fade); }
		.dnx-ob-btn { flex-shrink: 0; font-size: 12px; padding: 5px 10px; white-space: nowrap; }
		@media (max-width: 600px) {
			.dnx-ob-step { flex-wrap: wrap; }
			.dnx-ob-btn { margin-left: 36px; }
		}

		/* ── Feature directory ── */
		.dnx-dir { padding: 0; overflow: hidden; }
		.dnx-dir-head-bar {
			display: flex; flex-direction: column; gap: 0;
		}
		.dnx-dir-head-toggle {
			display: flex; justify-content: space-between; align-items: center;
			width: 100%; padding: 18px 20px 10px;
			background: none; border: none; cursor: pointer;
			text-align: left; color: inherit;
			transition: background 0.12s ease;
		}
		.dnx-dir-head-toggle:hover { background: rgba(255,255,255,0.03); }
		.dnx-dir-chevron {
			color: var(--nxt-ink-fade);
			transition: transform 0.2s ease;
			display: grid; place-items: center;
			flex-shrink: 0;
		}
		.dnx-dir-head-toggle[aria-expanded="false"] .dnx-dir-chevron { transform: rotate(-90deg); }
		.dnx-dir-search-wrap {
			position: relative; padding: 0 20px 12px;
		}
		.dnx-dir-search-icon {
			position: absolute; left: 32px; top: 50%; transform: translateY(calc(-50% - 6px));
			color: var(--nxt-ink-fade); pointer-events: none;
		}
		.dnx-dir-search {
			width: 100%; padding: 9px 12px 9px 34px;
			background: rgba(255,255,255,0.04); border: 1px solid var(--nxt-stroke);
			border-radius: 8px; color: var(--nxt-ink); font-size: 13px;
			outline: none; transition: border-color 0.14s ease, background 0.14s ease;
		}
		.dnx-dir-search::placeholder { color: var(--nxt-ink-fade); }
		.dnx-dir-search:focus {
			border-color: var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.06);
		}
		.dnx-dir-search-count {
			position: absolute; right: 32px; top: 50%; transform: translateY(calc(-50% - 6px));
			font-size: 11px; color: var(--nxt-ink-fade);
			pointer-events: none; font-variant-numeric: tabular-nums;
		}
		.dnx-dir-body {
			padding: 0 20px 20px;
			display: flex; flex-direction: column; gap: 20px;
			transition: max-height 0.35s ease, opacity 0.2s ease, padding 0.3s ease;
			max-height: 5000px; opacity: 1; overflow: hidden;
		}
		.dnx-dir-body.is-collapsed {
			max-height: 0; opacity: 0;
			padding-top: 0; padding-bottom: 0;
		}
		.dnx-dir-divider {
			height: 1px; background: var(--nxt-stroke); margin: 4px 0;
		}
		.dnx-dir-section {}
		.dnx-dir-group-label {
			font-size: 11px; font-weight: 700;
			letter-spacing: 0.08em; text-transform: uppercase;
			margin-bottom: 8px; padding-left: 2px;
		}
		.dnx-dir-items {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 8px;
		}
		@media (max-width: 920px) { .dnx-dir-items { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
		@media (max-width: 560px) { .dnx-dir-items { grid-template-columns: 1fr; } }
		.dnx-dir-item {
			display: block; padding: 10px 12px;
			border-radius: 10px; border: 1px solid var(--nxt-stroke);
			background: rgba(255,255,255,0.015);
			transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
			cursor: pointer; position: relative;
		}
		.dnx-dir-item:hover {
			border-color: var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.04);
			transform: translateY(-1px);
		}
		.dnx-dir-item:focus-visible {
			outline: 2px solid var(--nxt-ink-dim);
			outline-offset: 2px;
		}
		.dnx-dir-item-row {
			display: flex; align-items: flex-start; gap: 10px;
		}
		.dnx-dir-item-icon {
			width: 32px; height: 32px; border-radius: 8px;
			display: grid; place-items: center; flex-shrink: 0;
			transition: transform 0.14s ease;
		}
		.dnx-dir-item-icon svg { width: 16px; height: 16px; }
		.dnx-dir-item:hover .dnx-dir-item-icon { transform: scale(1.08); }
		.dnx-dir-item-text { flex: 1; min-width: 0; }
		.dnx-dir-item-title {
			font-size: 13px; font-weight: 550;
			color: var(--nxt-ink); margin-bottom: 1px;
			line-height: 1.3;
		}
		.dnx-dir-item-sub {
			font-size: 11.5px; color: var(--nxt-ink-fade);
			line-height: 1.35;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.dnx-dir-pin {
			background: none; border: none; cursor: pointer;
			color: var(--nxt-ink-fade); padding: 4px;
			border-radius: 6px; flex-shrink: 0;
			opacity: 0; transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
			display: grid; place-items: center;
			margin-top: 2px;
		}
		.dnx-dir-item:hover .dnx-dir-pin,
		.dnx-dir-pin.is-pinned { opacity: 1; }
		.dnx-dir-pin.is-pinned { color: #fbbf24; }
		.dnx-dir-pin:hover { background: rgba(255,255,255,0.08); color: var(--nxt-ink); }
		.dnx-dir-pin.is-pinned:hover { color: #fbbf24; }
		.dnx-dir-no-results {
			text-align: center; padding: 32px 16px;
			color: var(--nxt-ink-fade); font-size: 13px;
		}
		@media (max-width: 560px) {
			.dnx-dir-item-icon { width: 28px; height: 28px; border-radius: 7px; }
			.dnx-dir-item-icon svg { width: 14px; height: 14px; }
			.dnx-dir-search-wrap { padding: 0 14px 10px; }
			.dnx-dir-head-toggle { padding: 14px 14px 8px; }
			.dnx-dir-body { padding: 0 14px 14px; }
		}
	`;
	const tag = document.createElement('style');
	tag.id = 'dnx-home-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}
