// dashboard-next — Overview / home page.
//
// Hero strip with live 3D avatar previews, KPI row with sparklines,
// recent activity feed (stitched from transcripts + revenue events),
// and a 2x2 quick-actions grid. Polls KPIs + activity every 30s.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, relTime, ApiError } from '../api.js';
import { log } from '../../shared/log.js';
import {
	cryptoOptionalBannerHTML,
	injectStyles as injectCryptoOptionalStyles,
} from '../../shared/crypto-optional.js';
import {
	emptyStateHTML,
	errorStateHTML,
	ensureStateKitStyles,
	attachRetry,
} from '../../shared/state-kit.js';

const POLL_MS = 30_000;
const DAYS_WINDOW = 7;
const REL_TIME_TICK_MS = 60_000;
const ONBOARDING_DISMISSED_KEY = 'twx_onboarding_dismissed';
const FORGE_ANNOUNCE_DISMISSED_KEY = 'twx_forge_announce_dismissed';

const STATE = {
	pollHandle: null,
	relTimeHandle: null,
	kpi: { revenue: null, views: null, transcripts: null, avatars: null },
};

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();

	const greeting = me.display_name || me.username || (me.email ? me.email.split('@')[0] : 'creator');
	const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
	const forgeAnnounceDismissed = localStorage.getItem(FORGE_ANNOUNCE_DISMISSED_KEY) === '1';

	main.innerHTML = `
		${!forgeAnnounceDismissed ? `<section data-slot="announce" class="dnx-announce-wrap"></section>` : ''}

		<div class="dnx-welcome-row">
			<div class="dnx-welcome-text">
				<h1 class="dn-h1" style="margin-bottom:4px">Welcome back, ${esc(greeting)}.</h1>
				<p class="dn-h1-sub" style="margin:0">Your 3D agents, revenue, and visitor activity — all in one place.</p>
			</div>
			<div class="dnx-welcome-actions">
				<span class="dnx-welcome-date" aria-hidden="true">${esc(todayLabel())}</span>
				<a class="dn-btn" href="/dashboard/widgets">New widget</a>
				<a class="dn-btn primary dnx-welcome-cta" href="/create">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
					Create avatar
				</a>
			</div>
		</div>

		${!dismissed ? `<section data-slot="onboarding" class="dnx-onboarding-wrap"></section>` : ''}

		<div class="dnx-grid">
			<div class="dnx-col-main">
				<section data-slot="kpis"  class="dnx-kpis"></section>
				<section data-slot="hero" class="dnx-hero"></section>
				<section data-slot="trading" class="dnx-trading-wrap"></section>
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
		announce: main.querySelector('[data-slot="announce"]'),
		onboarding: main.querySelector('[data-slot="onboarding"]'),
		hero: main.querySelector('[data-slot="hero"]'),
		kpis: main.querySelector('[data-slot="kpis"]'),
		trading: main.querySelector('[data-slot="trading"]'),
		health: main.querySelector('[data-slot="health"]'),
		quick: main.querySelector('[data-slot="quick"]'),
		directory: main.querySelector('[data-slot="directory"]'),
		activity: main.querySelector('[data-slot="activity"]'),
	};

	if (slots.announce) renderForgeAnnounce(slots.announce);

	const [avatarsRes, widgetsRes, agentsRes] = await Promise.allSettled([
		get('/api/avatars?limit=50'),
		get('/api/widgets'),
		get('/api/agents?limit=20'),
	]);

	const avatars = avatarsRes.status === 'fulfilled' ? (avatarsRes.value?.avatars ?? []) : [];
	const widgets = widgetsRes.status === 'fulfilled' ? (widgetsRes.value?.widgets ?? []) : [];
	const agents  = agentsRes.status === 'fulfilled'  ? (agentsRes.value?.agents  ?? []) : [];

	// The dashboard holds authoritative server state; the floating guide
	// (getting-started.js) otherwise only infers progress from the current route
	// and drifts. Reconcile it here on every dashboard visit — this is data sync,
	// so it runs even when the onboarding panel is dismissed.
	reconcileGuide({ avatars, agents, widgets });

	renderHero(slots.hero, avatars, avatarsRes.status === 'rejected' ? avatarsRes.reason : null);
	loadTradingOverview(slots.trading);
	renderAgentHealth(slots.health, agents, widgets);
	renderQuickActions(slots.quick, { avatars, agents });
	renderDirectory(slots.directory);

	if (slots.onboarding) {
		renderOnboarding(slots.onboarding, { avatars, agents, widgets });
	}

	// First-run guided tour — fires once after wizard completion (?welcome=1)
	const _welcomeUrl = new URL(location.href);
	const fromWelcome = _welcomeUrl.searchParams.get('welcome') === '1';
	if (fromWelcome && !localStorage.getItem('threews:tour:done')) {
		_welcomeUrl.searchParams.delete('welcome');
		history.replaceState(null, '', _welcomeUrl.toString());

		const newestAgent = [...agents]
			.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] ?? null;

		import('../../first-meet.js').then(({ playFirstMeet }) => {
			playFirstMeet({
				viewer: null,
				agent: newestAgent
					? { id: newestAgent.id, name: newestAgent.name || newestAgent.display_name || 'Your agent' }
					: { id: null, name: 'Your agent' },
				onShare() {
					if (newestAgent?.id) {
						navigator.clipboard?.writeText(`${location.origin}/agent/${newestAgent.id}`).catch(() => {});
					}
				},
				onContinue() {},
			}).catch(log.error);
		}).catch(log.error);
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
	ensureStateKitStyles();
	main.innerHTML = `
		<h1 class="dn-h1">Overview</h1>
		${errorStateHTML({
			title: "Couldn't load this page",
			body: esc(err && err.message ? err.message : 'Something interrupted the dashboard. Retry, or reload the page.'),
		})}
	`;
	attachRetry(main, () => location.reload());
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
	main.querySelector('[data-slot="health"]').innerHTML = `
		<div class="dn-panel dnx-health-panel">
			<div class="dn-skeleton" style="height:14px;width:100px;margin-bottom:8px"></div>
			<div class="dn-skeleton" style="height:11px;width:200px;margin-bottom:12px"></div>
			${Array.from({ length: 3 }, () => `<div class="dn-skeleton" style="height:32px;width:100%;margin:4px 0"></div>`).join('')}
		</div>`;
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
		ensureStateKitStyles();
		host.innerHTML = `<div class="dn-panel" style="grid-column:1/-1;padding:0">${errorStateHTML({
			title: "Couldn't load your avatars",
			body: esc(err.message || "The avatars service didn't respond. Check your connection and try again."),
			scope: 'avatars',
		})}</div>`;
		attachRetry(host, async () => {
			host.innerHTML = Array.from({ length: 3 }, () =>
				`<div class="dn-skeleton dnx-hero-card" style="min-height:280px"></div>`,
			).join('');
			try {
				const res = await get('/api/avatars?limit=50');
				renderHero(host, res?.avatars ?? [], null);
			} catch (retryErr) {
				renderHero(host, [], retryErr);
			}
		});
		return;
	}

	if (!avatars.length) {
		host.innerHTML = `
			<div class="dnx-empty-hero" style="grid-column:1/-1">
				<div class="dnx-empty-hero-flow" aria-label="How three.ws works">
					<div class="dnx-flow-step">
						<div class="dnx-flow-icon" aria-hidden="true">
							<svg viewBox="0 0 48 48" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="32" height="36" rx="4"/><circle cx="24" cy="20" r="7"/><path d="M10 42c0-7.7 6.3-14 14-14s14 6.3 14 14"/><path d="M30 8v6M27 11h6"/></svg>
						</div>
						<div class="dnx-flow-label">Snap a selfie</div>
						<div class="dnx-flow-sub">Any phone photo</div>
					</div>
					<div class="dnx-flow-arrow" aria-hidden="true">→</div>
					<div class="dnx-flow-step">
						<div class="dnx-flow-icon" aria-hidden="true">
							<svg viewBox="0 0 48 48" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="12" y="4" width="24" height="26" rx="5"/><circle cx="19" cy="16" r="2"/><circle cx="29" cy="16" r="2"/><path d="M19 22h10M6 34l6-4h20l6 4v8a2 2 0 01-2 2H8a2 2 0 01-2-2v-8z"/></svg>
						</div>
						<div class="dnx-flow-label">3D AI agent</div>
						<div class="dnx-flow-sub">Animated &amp; intelligent</div>
					</div>
					<div class="dnx-flow-arrow" aria-hidden="true">→</div>
					<div class="dnx-flow-step">
						<div class="dnx-flow-icon" aria-hidden="true">
							<svg viewBox="0 0 48 48" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="40" height="32" rx="4"/><path d="M4 18h40"/><circle cx="11" cy="13" r="1.5" fill="currentColor"/><circle cx="17" cy="13" r="1.5" fill="currentColor"/><path d="M14 26h12M14 31h8"/></svg>
						</div>
						<div class="dnx-flow-label">Live on your site</div>
						<div class="dnx-flow-sub">One HTML tag</div>
					</div>
					<div class="dnx-flow-arrow" aria-hidden="true">→</div>
					<div class="dnx-flow-step">
						<div class="dnx-flow-icon" aria-hidden="true">
							<svg viewBox="0 0 48 48" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><path d="M24 14v20M18 19h9a4 4 0 010 8H20a4 4 0 000 8h10"/></svg>
						</div>
						<div class="dnx-flow-label">Earn from chats</div>
						<div class="dnx-flow-sub">USDC payouts</div>
					</div>
				</div>
				<div class="dnx-empty-hero-cta">
					<a href="/create" class="dn-btn dnx-empty-hero-main-cta">Create your avatar →</a>
					<a href="/create#card-upload-glb" class="dn-btn">Upload .glb</a>
				</div>
			</div>
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
					<a class="dn-btn" href="/agents/${encodeURIComponent(a.id)}">Live page</a>
					<a class="dn-btn" href="/dashboard/widgets?avatar=${encodeURIComponent(a.id)}">Embed</a>
					<a class="dn-btn" href="/avatars/${encodeURIComponent(a.id)}/edit">Edit</a>
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

	for (const c of cards) {
		// Active-avatars is a running total (flat synthetic series), so a momentum
		// read would be meaningless — only chart-backed metrics get a trend chip.
		c.trend = c.key === 'avatars' ? null : trendOf(c.series);
	}

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
	if (c.empty) {
		return `
			<div class="dn-panel dnx-kpi dnx-kpi-is-empty" data-kpi="${esc(c.key)}">
				<div class="dnx-kpi-label">${esc(c.label)}</div>
				<div class="dnx-kpi-empty">
					<div class="dnx-kpi-value">${esc(c.value)}</div>
					<a class="dn-btn" href="${c.emptyCta.href}">${esc(c.emptyCta.label)}</a>
				</div>
			</div>`;
	}
	const t = c.trend;
	const dir = t?.dir || 'flat';
	const trendHtml = t
		? `<span class="dnx-kpi-trend dnx-kpi-trend-${dir}" title="Momentum across the last 7 days">
				${trendArrow(dir)}<span>${t.label ? esc(t.label) : `${Math.abs(t.pct).toFixed(0)}%`}</span>
			</span>`
		: '';
	return `
		<div class="dn-panel dnx-kpi" data-kpi="${esc(c.key)}">
			<div class="dnx-kpi-label">${esc(c.label)}</div>
			<div class="dnx-kpi-value-row">
				<div class="dnx-kpi-value">${esc(c.value)}</div>
				${trendHtml}
			</div>
			<div class="dnx-kpi-spark">${sparkSvg(c.series, dir)}</div>
		</div>
	`;
}

// ── Agent health ─────────────────────────────────────────────────────────

// ── Trading overview ──────────────────────────────────────────────────────
// Compact 3-card strip showing live sniper, Oracle, and copy trading status.
// All fetches are fire-and-forget; each card renders independently so a slow
// endpoint doesn't block the others.

async function loadTradingOverview(host) {
	host.innerHTML = `
		<div class="dn-panel dnx-trading-panel">
			<div class="dnx-trading-head">
				<span class="dn-panel-title">Autonomous trading</span>
				<a class="dn-btn dn-btn-sm" href="/activity" style="font-size:11px">Live activity →</a>
			</div>
			<div class="dnx-trading-cards" id="dnx-trading-cards">
				${[0,1,2].map(() => `<div class="dnx-tc dnx-tc-sk"><div class="dn-skeleton" style="height:12px;width:50%;margin-bottom:6px"></div><div class="dn-skeleton" style="height:22px;width:80%;margin-bottom:4px"></div><div class="dn-skeleton" style="height:10px;width:60%"></div></div>`).join('')}
			</div>
		</div>
	`;

	const cards = host.querySelector('#dnx-trading-cards');

	const [sniperRes, copyRes, oracleRes, oFeedRes] = await Promise.allSettled([
		get('/api/sniper/strategy?limit=30'),
		get('/api/copy/subscriptions'),
		get('/api/oracle/stats'),
		fetch('/api/oracle/feed?tier=prime&limit=3&network=mainnet').then((r) => r.ok ? r.json() : null).catch(() => null),
	]);

	const strategies = (sniperRes.status === 'fulfilled' ? sniperRes.value?.strategies : null) || [];
	const subscriptions = (copyRes.status === 'fulfilled' ? copyRes.value?.subscriptions : null) || [];
	const oStats = (oracleRes.status === 'fulfilled' ? oracleRes.value : null) || {};
	const oFeed = (oFeedRes.status === 'fulfilled' ? oFeedRes.value : null);
	const oPrimePick = oFeed?.items?.[0] ?? null;

	const armedStrategies = strategies.filter((s) => s.enabled && !s.kill_switch_engaged);
	const openPositions = strategies.reduce((n, s) => n + (Number(s.open_positions) || 0), 0);
	const totalPnl = strategies.reduce((n, s) => n + (Number(s.realized_pnl_sol) || 0), 0);

	const activeSubs = subscriptions.filter((s) => s.status === 'active');
	const pendingIntents = subscriptions.reduce((n, s) => n + (Number(s.pending_count) || 0), 0);

	const pnlSign = totalPnl >= 0 ? '+' : '';
	const pnlStr = `${pnlSign}${Math.abs(totalPnl) >= 1 ? totalPnl.toFixed(2) : totalPnl.toFixed(3)} ◎`;
	const pnlClass = totalPnl >= 0 ? 'dnx-tc-pos' : 'dnx-tc-neg';

	// Oracle card copy assembly.
	const oScored24h   = Number(oStats.scored_24h)   || 0;
	const oWinRate     = oStats.win_rate != null ? oStats.win_rate : null;
	const oBestAth     = oStats.best_ath != null ? Number(oStats.best_ath) : null;
	const oPrimeCount  = Number(oStats.prime_count)  || 0;
	const oOpenActions = Number(oStats.open_actions) || 0;
	const oStrongCount = Number(oStats.strong_count) || 0;
	const oTotalWins   = Number(oStats.total_wins)   || 0;

	const oValueText = oScored24h > 0
		? `${oScored24h.toLocaleString()} <span class="dnx-tc-unit">scored today</span>`
		: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;vertical-align:text-bottom"><circle cx="7" cy="7" r="5"/><path d="M7 4.5v2.7l1.6 1.6"/></svg> Live`;
	const oMeta1 = oWinRate != null
		? `<span class="dnx-tc-pos">${oWinRate}% win rate</span>`
		: '<span class="dnx-tc-dim">Conviction scoring every coin</span>';
	const oMeta2 = oPrimePick
		? `<span style="color:#c084fc;font-weight:600">🔮 $${esc(oPrimePick.symbol || oPrimePick.name || '')} · ${oPrimePick.score}</span>`
		: oBestAth != null
			? `<span>best ${oBestAth.toFixed(1)}× · ${oPrimeCount} prime</span>`
			: oOpenActions > 0
				? `<span>${oOpenActions} open action${oOpenActions !== 1 ? 's' : ''}</span>`
				: '<span class="dnx-tc-arm-cta">Arm an agent →</span>';
	const oMeta3 = oTotalWins > 0
		? `<span>${oTotalWins} total win${oTotalWins !== 1 ? 's' : ''} · ${oStrongCount} strong</span>`
		: oPrimeCount > 0
			? `<span>${oPrimeCount} prime · ${oStrongCount} strong</span>`
			: '';

	cards.innerHTML = `
		<a class="dnx-tc" href="/dashboard/sniper">
			<div class="dnx-tc-label">Sniper</div>
			<div class="dnx-tc-value">${armedStrategies.length} <span class="dnx-tc-unit">armed</span></div>
			<div class="dnx-tc-meta">
				${openPositions > 0
					? `<span>${openPositions} open position${openPositions !== 1 ? 's' : ''}</span>`
					: '<span class="dnx-tc-dim">No open positions</span>'}
				${strategies.length > 0 ? `<span class="${pnlClass}">${pnlStr}</span>` : ''}
			</div>
		</a>
		<a class="dnx-tc" href="${oPrimePick ? `/oracle/coin/${encodeURIComponent(oPrimePick.mint)}` : '/oracle'}">
			<div class="dnx-tc-label">Oracle</div>
			<div class="dnx-tc-value">${oValueText}</div>
			<div class="dnx-tc-meta">${oMeta1}${oMeta2}${oMeta3 ? oMeta3 : ''}</div>
		</a>
		<a class="dnx-tc" href="/dashboard/copy">
			<div class="dnx-tc-label">Copy trading</div>
			<div class="dnx-tc-value">${activeSubs.length} <span class="dnx-tc-unit">subscription${activeSubs.length !== 1 ? 's' : ''}</span></div>
			<div class="dnx-tc-meta">
				${pendingIntents > 0
					? `<span class="dnx-tc-pos">${pendingIntents} pending intent${pendingIntents !== 1 ? 's' : ''} →</span>`
					: '<span class="dnx-tc-dim">No pending intents</span>'}
			</div>
		</a>
	`;
}

function renderAgentHealth(host, agents, widgets) {
	if (!agents.length) {
		host.style.display = 'none';
		return;
	}

	const widgetsByAvatar = new Map();
	for (const w of widgets) {
		const aid = w.avatar_id || w.avatar?.id;
		if (aid) {
			if (!widgetsByAvatar.has(aid)) widgetsByAvatar.set(aid, []);
			widgetsByAvatar.get(aid).push(w);
		}
	}

	const rows = agents.slice(0, 8).map((a) => {
		const name = a.name || a.display_name || 'Unnamed agent';
		const hasWidget = widgetsByAvatar.has(a.avatar_id);
		const updatedAt = a.updated_at || a.created_at;
		const lastActive = updatedAt ? new Date(updatedAt) : null;
		const isRecent = lastActive && (Date.now() - lastActive.getTime()) < 24 * 3600_000;
		const status = hasWidget ? (isRecent ? 'active' : 'idle') : 'no-widget';
		const statusLabel = status === 'active' ? 'Active' : status === 'idle' ? 'Idle' : 'No widget';
		const statusClass = status === 'active' ? 'success' : '';
		const dotColor = status === 'active' ? 'var(--nxt-success)' : status === 'idle' ? 'var(--nxt-ink-fade)' : 'var(--nxt-ink-fade)';

		return `
			<a href="/dashboard/agents" class="dnx-health-row">
				<span class="dnx-health-dot" style="background:${dotColor}" aria-hidden="true"></span>
				<span class="dnx-health-name">${esc(name)}</span>
				<span class="dn-tag ${statusClass}" style="font-size:10.5px">${statusLabel}</span>
				${lastActive ? `<span class="dnx-health-time">${esc(relTime(updatedAt))}</span>` : ''}
			</a>
		`;
	}).join('');

	host.innerHTML = `
		<div class="dn-panel dnx-health-panel">
			<div class="dn-panel-title">Agent health</div>
			<div class="dn-panel-sub">Status of your agents and their widget connections.</div>
			<div class="dnx-health-list">${rows}</div>
		</div>
	`;
}

// ── Activity feed ─────────────────────────────────────────────────────────

async function refreshActivity(host, ctx) {
	const events = await collectActivity(ctx.widgets);

	if (!events.length) {
		ensureStateKitStyles();
		// If the user has no live embed yet, point them at the step that unlocks
		// activity; otherwise the feed is simply waiting for real visitor events.
		const hasWidgets = (ctx.widgets?.length ?? 0) > 0;
		host.innerHTML = `
			<div class="dn-panel">
				<div class="dn-panel-title">Recent activity</div>
				${emptyStateHTML({
					icon: '',
					title: 'Nothing here yet',
					body: hasWidgets
						? 'Visitor chats, payments, and embed views appear here the moment someone interacts with your agents.'
						: 'Embed an agent on your site and visitor chats, payments, and views will stream in here in real time.',
					actions: hasWidgets ? [] : [{ label: 'Embed an agent', href: '/dashboard/widgets', primary: true }],
					compact: true,
				})}
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

// ── Launch announcement: text-to-3D ───────────────────────────────────────
//
// Not a passive notice — a working launchpad. The bar embeds a real prompt
// composer that deep-links into the Forge (/forge?prompt=…, which pre-fills
// and focuses the field), a typewriter that teaches by cycling the Forge's
// own example prompts, and one-tap example chips. The animated mesh visual
// (a CSS wireframe cube under a sweeping scan ring) signals "generation"
// without a single image asset.

const FORGE_PROMPT_CAP = 300;

// The Forge's own example prompts (pages/forge.html #examples). Kept in sync
// so the launchpad teaches the same vocabulary the destination uses.
const FORGE_EXAMPLES = [
	'a low-poly red fox, sitting',
	'a sci-fi combat helmet, brushed metal',
	'a potted monstera plant',
	'a vintage film camera',
	'a glazed ceramic teapot',
];

function forgeHref(prompt) {
	const p = (prompt || '').trim().slice(0, FORGE_PROMPT_CAP);
	return p ? `/forge?prompt=${encodeURIComponent(p)}` : '/forge';
}

function renderForgeAnnounce(host) {
	const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

	host.innerHTML = `
		<div class="dnx-forge${reduceMotion ? ' is-still' : ''}" role="region" aria-label="New: Text to 3D">
			<div class="dnx-forge-visual" aria-hidden="true">
				<span class="dnx-forge-ring"></span>
				<span class="dnx-forge-stage">
					<span class="dnx-forge-cube">
						<i></i><i></i><i></i><i></i><i></i><i></i>
					</span>
				</span>
				<span class="dnx-forge-scan"></span>
			</div>
			<div class="dnx-forge-body">
				<div class="dnx-forge-head">
					<span class="dnx-forge-badge">New</span>
					<span class="dnx-forge-title">Text&nbsp;to&nbsp;3D is live</span>
					<span class="dnx-forge-sub">Describe any object — get a downloadable, textured GLB in seconds.</span>
				</div>
				<form class="dnx-forge-form" novalidate>
					<label class="dnx-forge-field">
						<input
							class="dnx-forge-input"
							type="text"
							name="prompt"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							enterkeyhint="go"
							maxlength="${FORGE_PROMPT_CAP}"
							aria-label="Describe an object to forge into 3D"
						/>
					</label>
					<button class="dnx-forge-go" type="submit">
						Forge
						<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9M9 4l4 4-4 4"/></svg>
					</button>
				</form>
				<div class="dnx-forge-chips" aria-label="Example prompts">
					<span class="dnx-forge-chips-label">Try</span>
					${FORGE_EXAMPLES.slice(0, 3).map((ex) => {
						const short = ex.replace(/^a\s+/i, '').split(',')[0];
						return `<a class="dnx-forge-chip" href="${forgeHref(ex)}" title="${esc(ex)}">${esc(short)}</a>`;
					}).join('')}
				</div>
			</div>
			<button class="dnx-forge-dismiss" aria-label="Dismiss announcement" title="Dismiss">
				<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11"/></svg>
			</button>
		</div>
	`;

	const root = host.querySelector('.dnx-forge');
	const input = host.querySelector('.dnx-forge-input');
	const form = host.querySelector('.dnx-forge-form');

	// Submit → deep-link into the Forge with whatever the user typed. Empty
	// field falls back to the example currently on display, so the button is
	// never a dead end. Record the visit so Forge surfaces in "recents" just
	// like every other navigation on this page.
	let currentExample = FORGE_EXAMPLES[0];
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		stopTypewriter();
		trackVisit('/forge');
		location.href = forgeHref(input.value || currentExample);
	});

	// Example chips navigate as plain links; tag the visit before they do.
	host.querySelector('.dnx-forge-chips').addEventListener('click', (e) => {
		if (e.target.closest('.dnx-forge-chip')) trackVisit('/forge');
	});

	// Dismiss — persist so it stays gone, and tear down timers.
	host.querySelector('.dnx-forge-dismiss').addEventListener('click', () => {
		localStorage.setItem(FORGE_ANNOUNCE_DISMISSED_KEY, '1');
		stopTypewriter();
		host.remove();
	});

	// Typewriter: types each example into the placeholder, holds, erases, and
	// advances. Pauses while the field is focused or non-empty so it never
	// fights the user. Reduced-motion swaps the whole phrase on a slow timer.
	let twTimer = null;
	let exampleIdx = 0;
	const paused = () => document.activeElement === input || input.value.length > 0;

	function setExample(text) {
		currentExample = text;
		input.placeholder = text;
	}

	function stopTypewriter() {
		if (twTimer) { clearTimeout(twTimer); twTimer = null; }
	}

	if (reduceMotion) {
		setExample(currentExample);
		const rotate = () => {
			twTimer = setTimeout(() => {
				exampleIdx = (exampleIdx + 1) % FORGE_EXAMPLES.length;
				if (!paused()) setExample(FORGE_EXAMPLES[exampleIdx]);
				rotate();
			}, 3800);
		};
		rotate();
	} else {
		let charIdx = 0;
		let erasing = false;
		const step = () => {
			if (paused()) {
				input.placeholder = '';
				twTimer = setTimeout(step, 600);
				return;
			}
			const target = FORGE_EXAMPLES[exampleIdx];
			if (!erasing) {
				charIdx++;
				currentExample = target;
				input.placeholder = target.slice(0, charIdx);
				if (charIdx >= target.length) {
					erasing = true;
					twTimer = setTimeout(step, 1900); // hold full phrase
					return;
				}
				twTimer = setTimeout(step, 42 + Math.floor(charIdx % 3) * 14);
			} else {
				charIdx--;
				input.placeholder = target.slice(0, charIdx);
				if (charIdx <= 0) {
					erasing = false;
					exampleIdx = (exampleIdx + 1) % FORGE_EXAMPLES.length;
					twTimer = setTimeout(step, 320);
					return;
				}
				twTimer = setTimeout(step, 22);
			}
		};
		step();
		// Resume cleanly when the user blurs an empty field.
		input.addEventListener('blur', () => {
			if (!input.value && !twTimer) step();
		});
		input.addEventListener('focus', () => { input.placeholder = ''; });
	}
}

// ── Onboarding checklist ──────────────────────────────────────────────────

// Sync the floating getting-started guide to authoritative server state. The
// guide exposes window.__twsGuide.complete(id) and is idempotent — completing an
// already-done step is a no-op, so this is safe to call on every dashboard load.
function reconcileGuide({ avatars = [], agents = [], widgets = [] }) {
	const guide = window.__twsGuide;
	if (!guide || typeof guide.complete !== 'function') return;
	try {
		if (avatars.length > 0) guide.complete('create', { silent: true });
		if (agents.length > 0) guide.complete('brain', { silent: true });
		if (widgets.length > 0) guide.complete('embed', { silent: true });
	} catch (_) {}
}

// Has the user completed the optional monetize step on any surface? The guide is
// the cross-page record of record for it.
function guideStepDone(id) {
	try { return !!window.__twsGuide?.progress?.()[id]; } catch (_) { return false; }
}

// Step icons as inline SVG so no external assets are needed.
const OB_ICONS = {
	avatar: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><path d="M17 3v4M15 5h4"/></svg>`,
	agent:  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="13" rx="3"/><circle cx="9.5" cy="8" r="1"/><circle cx="14.5" cy="8" r="1"/><path d="M9 11.5h6M4 17l3-2h10l3 2v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4z"/></svg>`,
	widget: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20"/><circle cx="6" cy="6.5" r=".8" fill="currentColor"/><circle cx="9" cy="6.5" r=".8" fill="currentColor"/><path d="M7 13h4M7 16h7"/></svg>`,
	monetize: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a2 2 0 010 4H10a2 2 0 000 4h5"/></svg>`,
};

function renderOnboarding(host, { avatars, agents, widgets }) {
	const steps = [
		{
			id: 'avatar',
			icon: OB_ICONS.avatar,
			label: 'Create your first avatar',
			outcome: 'Your selfie becomes a 3D character ready to talk to visitors',
			detail: 'We turn a single photo into a full-body animated 3D agent in under 60 seconds. No design tools, no uploads — just a selfie.',
			href: avatars.length === 0 ? '/start' : '/create',
			cta: avatars.length === 0 ? 'Take a selfie' : 'Create another avatar',
			done: avatars.length > 0,
		},
		{
			id: 'agent',
			icon: OB_ICONS.agent,
			label: 'Give your avatar a brain',
			outcome: 'It learns your personality and answers in your style — not a generic bot',
			detail: 'Set its name, persona, and knowledge base. Upload docs, link URLs, or just write a prompt. This is what makes it distinctly yours.',
			href: agents.length === 0 ? '/start' : '/dashboard/agents',
			cta: 'Set up agent',
			done: agents.length > 0,
		},
		{
			id: 'widget',
			icon: OB_ICONS.widget,
			label: 'Put it on your website',
			outcome: 'One line of HTML — visitors chat with your 3D agent in 2 minutes',
			detail: 'Copy a single script tag. Drop it anywhere — WordPress, Shopify, Webflow, raw HTML. Visitors see your agent immediately, no account required on their end.',
			href: '/dashboard/widgets',
			cta: 'Create embed widget',
			done: widgets.length > 0,
		},
		{
			id: 'monetize',
			icon: OB_ICONS.monetize,
			label: 'Start earning from chats',
			outcome: 'Charge per message, set a subscription, or let fans tip — you keep 90%',
			detail: 'Your agent becomes a revenue stream. Choose your pricing: per-message, monthly subscription, or tip jar. Payouts in USDC, directly to your wallet.',
			href: '/dashboard/monetize',
			cta: 'Set up monetization',
			done: guideStepDone('monetize'),
			optional: true,
			optionalTip: 'Earning and payouts settle in USDC and need a wallet. It is entirely opt-in — your agent works exactly the same without it.',
		},
	];

	const doneCount = steps.filter((s) => s.done).length;
	if (doneCount === steps.length) {
		host.remove();
		return;
	}

	const pct = Math.round((doneCount / steps.length) * 100);

	injectCryptoOptionalStyles();

	const doneStepsHtml = steps
		.filter((s) => s.done)
		.map((s) => `
			<li class="dnx-ob-done-row" aria-label="${esc(s.label)} — complete">
				<span class="dnx-ob-done-check" aria-hidden="true">
					<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7l3.5 3.5L12 3"/></svg>
				</span>
				<span class="dnx-ob-done-label">${esc(s.label)}</span>
			</li>
		`).join('');

	const pendingSteps = steps.filter((s) => !s.done);
	const [activeStep, ...futureSteps] = pendingSteps;

	const futureHtml = futureSteps.map((s) => `
		<li class="dnx-ob-future-row">
			<span class="dnx-ob-future-num" aria-hidden="true">${steps.indexOf(s) + 1}</span>
			<span class="dnx-ob-future-label">${esc(s.label)}</span>
			${s.optional ? `<span class="dnx-ob-future-opt">Optional</span>` : ''}
		</li>
	`).join('');

	host.innerHTML = `
		<div class="dn-panel dnx-ob" id="dnx-onboarding">
			<div class="dnx-ob-head">
				<div>
					<div class="dn-panel-title" style="margin:0 0 2px">Get your agent live</div>
					<div class="dn-panel-sub" style="margin:0">${doneCount} of ${steps.length} steps complete</div>
				</div>
				<button class="dnx-ob-dismiss" aria-label="Dismiss getting started" title="Dismiss">
					<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
				</button>
			</div>
			<div class="dnx-ob-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
				<div class="dnx-ob-fill" style="width:${pct}%"></div>
			</div>

			${doneCount > 0 ? `<ul class="dnx-ob-done-list" aria-label="Completed steps">${doneStepsHtml}</ul>` : ''}

			<div class="dnx-ob-active" aria-current="step">
				<div class="dnx-ob-active-icon" aria-hidden="true">${activeStep.icon}</div>
				<div class="dnx-ob-active-body">
					<div class="dnx-ob-active-step-label">Step ${steps.indexOf(activeStep) + 1} of ${steps.length}${activeStep.optional ? ` <span class="dnx-ob-active-opt">Optional</span>` : ''}</div>
					<div class="dnx-ob-active-title">${esc(activeStep.label)}</div>
					<div class="dnx-ob-active-outcome">${esc(activeStep.outcome)}</div>
					<div class="dnx-ob-active-detail">${esc(activeStep.detail)}</div>
					<div class="dnx-ob-active-actions">
						<a class="dn-btn dnx-ob-active-cta" href="${activeStep.href}">${esc(activeStep.cta)} →</a>
						${activeStep.optional ? `<span class="dnx-ob-active-skip">or <a href="#" data-ob-skip>skip for now</a></span>` : ''}
					</div>
				</div>
			</div>

			${futureSteps.length ? `
				<ul class="dnx-ob-future-list" aria-label="Upcoming steps">
					${futureHtml}
				</ul>
			` : ''}

			<div class="dnx-ob-reassure">${cryptoOptionalBannerHTML('compact')}</div>
		</div>
	`;

	host.querySelector('.dnx-ob-dismiss').addEventListener('click', () => {
		localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
		host.remove();
	});

	const skipLink = host.querySelector('[data-ob-skip]');
	if (skipLink) {
		skipLink.addEventListener('click', (e) => {
			e.preventDefault();
			localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
			host.remove();
		});
	}
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
		defaults.push({ href: `/avatars/${encodeURIComponent(firstAvatar.id)}`, title: 'View live avatar page', sub: 'See how visitors experience your avatar', iconKey: '/dashboard/agents', cat: 'Agents & Identity' });
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
		{ href: '/dashboard/creator', title: 'Creator Studio', sub: 'Price skills, track earnings, get paid', iconKey: '/dashboard/creator', cat: 'Monetize & Trade' },
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
	'/temporary':                '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="2"/><path d="M10 6v4l-2 4M10 10l2 4M7 8l3 2 3-2"/></svg>',
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
	'/dashboard/creator':   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l2.5-7 3 4 2.5-6 3 9"/><path d="M3 16h13"/><circle cx="15.5" cy="5" r="2"/></svg>',
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
	'Create & Build':     { accent: '136,136,136',  label: '#888888' },
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
			{ href: '/dashboard/creator',    title: 'Creator Studio', sub: 'Price skills, track earnings, get paid' },
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
			{ href: '/temporary',               title: 'Walk Viewer',      sub: 'Walk and animation preview' },
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

const SPARK_COLOR = {
	up: 'var(--nxt-success)',
	down: 'var(--nxt-danger)',
	flat: 'var(--nxt-ink-dim)',
};

function sparkSvg(series, dir = 'flat') {
	if (!series.length) return '';
	const w = 220, h = 38, pad = 2;
	const color = SPARK_COLOR[dir] || SPARK_COLOR.flat;
	const max = Math.max(1, ...series.map((p) => p.value));
	const dx = (w - pad * 2) / Math.max(1, series.length - 1);
	const coords = series.map((p, i) => {
		const x = pad + i * dx;
		const y = h - pad - (p.value / max) * (h - pad * 2);
		return [x, y];
	});
	const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
	const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(2)},${h - pad}`;
	const [lx, ly] = coords[coords.length - 1];
	return `
		<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" style="color:${color}">
			<polygon points="${area}" fill="currentColor" fill-opacity="0.12"/>
			<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
			<circle cx="${lx.toFixed(2)}" cy="${ly.toFixed(2)}" r="2.4" fill="currentColor" vector-effect="non-scaling-stroke"/>
		</svg>
	`;
}

// Momentum across the available window: sum of the latest third vs the earliest
// third of the daily series. Honest read computed from real data only — null
// when there's nothing to compare (flat or empty series).
function trendOf(series) {
	if (!series || series.length < 4) return null;
	const vals = series.map((p) => Number(p.value) || 0);
	const span = Math.max(1, Math.floor(vals.length / 3));
	const first = vals.slice(0, span).reduce((a, b) => a + b, 0);
	const second = vals.slice(vals.length - span).reduce((a, b) => a + b, 0);
	if (first === 0 && second === 0) return null;
	if (first === 0) return { dir: 'up', pct: null, label: 'New' };
	const pct = ((second - first) / first) * 100;
	if (Math.abs(pct) < 1) return { dir: 'flat', pct: 0 };
	return { dir: pct > 0 ? 'up' : 'down', pct };
}

function trendArrow(dir) {
	if (dir === 'up') return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5L6 4l3.5 3.5"/></svg>';
	if (dir === 'down') return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
	return '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2.5 6h7"/></svg>';
}

// "Thu, Jun 26" — calm context for the header, no live ticking.
function todayLabel() {
	try {
		return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
	} catch {
		return '';
	}
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
		.dnx-kpi {
			padding: 14px 16px;
			transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
		}
		.dnx-kpi:hover {
			border-color: var(--nxt-stroke-strong);
			transform: translateY(-2px);
			box-shadow: 0 10px 30px -18px rgba(0,0,0,0.6);
		}
		.dnx-kpi-label {
			font-size: 11.5px;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--nxt-ink-fade);
			margin-bottom: 8px;
		}
		.dnx-kpi-value-row {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 8px;
		}
		.dnx-kpi-value {
			font-size: 26px;
			font-weight: 600;
			letter-spacing: -0.02em;
			color: var(--nxt-ink);
			line-height: 1.1;
			font-variant-numeric: tabular-nums;
		}
		.dnx-kpi-value-row .dnx-kpi-value { margin-bottom: 0; }
		.dnx-kpi-trend {
			display: inline-flex;
			align-items: center;
			gap: 2px;
			flex-shrink: 0;
			font-size: 11.5px;
			font-weight: 600;
			font-variant-numeric: tabular-nums;
			padding: 2px 6px 2px 4px;
			border-radius: var(--nxt-radius-pill);
			line-height: 1;
		}
		.dnx-kpi-trend svg { display: block; }
		.dnx-kpi-trend-up   { color: var(--nxt-success); background: rgba(184, 188, 196, 0.1); }
		.dnx-kpi-trend-down { color: var(--nxt-danger);  background: rgba(150, 155, 163, 0.1); }
		.dnx-kpi-trend-flat { color: var(--nxt-ink-fade); background: rgba(255,255,255,0.04); }
		.dnx-kpi-spark { height: 38px; }
		.dnx-kpi-empty { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
		.dnx-kpi-empty .dnx-kpi-value { margin-bottom: 0; }

		/* ── Welcome header ── */
		.dnx-welcome-row {
			display: flex;
			align-items: flex-end;
			justify-content: space-between;
			gap: 18px;
			flex-wrap: wrap;
			margin-bottom: 20px;
		}
		.dnx-welcome-text { min-width: 0; }
		.dnx-welcome-actions {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-shrink: 0;
		}
		.dnx-welcome-date {
			font-size: 12.5px;
			color: var(--nxt-ink-fade);
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
			margin-right: 2px;
		}
		.dnx-welcome-cta svg { margin-right: -1px; }
		@media (max-width: 620px) {
			.dnx-welcome-actions { width: 100%; }
			.dnx-welcome-date { display: none; }
			.dnx-welcome-cta { margin-left: auto; }
		}

		/* ── Agent health ── */
		.dnx-health-wrap { min-width: 0; }
		.dnx-health-panel { padding: 16px 18px; }
		.dnx-health-list {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.dnx-health-row {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 8px 8px;
			border-radius: 8px;
			font-size: 13px;
			color: var(--nxt-ink-dim);
			transition: background 0.12s ease, color 0.12s ease;
			cursor: pointer;
		}
		.dnx-health-row:hover { background: rgba(255,255,255,0.04); color: var(--nxt-ink); }
		.dnx-health-row:focus-visible { outline: 2px solid var(--nxt-ink-dim); outline-offset: -2px; }
		.dnx-health-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			flex-shrink: 0;
		}
		.dnx-health-name {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 500;
			color: var(--nxt-ink);
		}
		.dnx-health-time {
			font-size: 12px;
			color: var(--nxt-ink-fade);
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
		}

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

		/* ── Launch launchpad: text-to-3D ── */
		.dnx-announce-wrap { margin-bottom: 18px; }
		.dnx-forge {
			position: relative;
			display: flex;
			align-items: center;
			gap: 18px;
			padding: 16px 18px;
			border-radius: var(--nxt-radius);
			border: 1px solid var(--nxt-stroke-strong);
			background:
				radial-gradient(120% 140% at 0% 0%, rgba(255,255,255,0.07), transparent 60%),
				linear-gradient(180deg, rgba(20,21,28,0.72), rgba(12,13,18,0.55));
			overflow: hidden;
			isolation: isolate;
		}
		/* Top hairline shimmer — a slow light sweep that draws the eye to "new". */
		.dnx-forge::before {
			content: '';
			position: absolute; inset: 0 0 auto 0; height: 1px;
			background: linear-gradient(90deg, transparent, rgba(255,255,255,0.65), transparent);
			background-size: 40% 100%;
			background-repeat: no-repeat;
			animation: dnx-forge-sweep 5.5s ease-in-out infinite;
			z-index: 2;
		}
		@keyframes dnx-forge-sweep {
			0% { background-position: -45% 0; }
			55%, 100% { background-position: 145% 0; }
		}

		/* ── Animated mesh visual: wireframe cube + scan ring ── */
		.dnx-forge-visual {
			position: relative;
			flex-shrink: 0;
			width: 64px; height: 64px;
			display: grid; place-items: center;
			perspective: 340px;
		}
		.dnx-forge-ring {
			position: absolute; inset: -2px;
			border-radius: 50%;
			background: conic-gradient(from 0deg, transparent 0 62%, rgba(255,255,255,0.55) 84%, rgba(255,255,255,0.9) 92%, transparent 100%);
			-webkit-mask: radial-gradient(closest-side, transparent 76%, #000 78%);
			mask: radial-gradient(closest-side, transparent 76%, #000 78%);
			animation: dnx-forge-ring 4.2s linear infinite;
			opacity: 0.9;
		}
		@keyframes dnx-forge-ring { to { transform: rotate(360deg); } }
		.dnx-forge-stage {
			width: 34px; height: 34px;
			transform-style: preserve-3d;
			animation: dnx-forge-spin 9s linear infinite;
		}
		@keyframes dnx-forge-spin {
			from { transform: rotateX(-22deg) rotateY(0deg); }
			to   { transform: rotateX(-22deg) rotateY(360deg); }
		}
		.dnx-forge-cube {
			position: relative;
			width: 34px; height: 34px;
			transform-style: preserve-3d;
		}
		.dnx-forge-cube i {
			position: absolute; inset: 0;
			border: 1px solid rgba(255,255,255,0.55);
			background: rgba(255,255,255,0.018);
			box-shadow: inset 0 0 12px rgba(255,255,255,0.06);
		}
		.dnx-forge-cube i:nth-child(1) { transform: rotateY(0deg)   translateZ(17px); }
		.dnx-forge-cube i:nth-child(2) { transform: rotateY(90deg)  translateZ(17px); }
		.dnx-forge-cube i:nth-child(3) { transform: rotateY(180deg) translateZ(17px); }
		.dnx-forge-cube i:nth-child(4) { transform: rotateY(270deg) translateZ(17px); }
		.dnx-forge-cube i:nth-child(5) { transform: rotateX(90deg)  translateZ(17px); }
		.dnx-forge-cube i:nth-child(6) { transform: rotateX(-90deg) translateZ(17px); }
		.dnx-forge-scan {
			position: absolute; left: 8px; right: 8px; height: 1px;
			background: linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent);
			filter: blur(0.3px);
			animation: dnx-forge-scan 2.8s ease-in-out infinite;
			z-index: 1;
		}
		@keyframes dnx-forge-scan {
			0% { top: 14%; opacity: 0; }
			18% { opacity: 1; }
			82% { opacity: 1; }
			100% { top: 86%; opacity: 0; }
		}
		.dnx-forge:hover .dnx-forge-stage { animation-duration: 5s; }
		.dnx-forge:hover .dnx-forge-ring  { animation-duration: 2.6s; }
		/* Engaging the composer primes the mesh — the visual reacts to the
		   action it's attached to. */
		.dnx-forge:focus-within {
			border-color: rgba(255,255,255,0.28);
			box-shadow: 0 0 0 1px rgba(255,255,255,0.05), 0 18px 50px -28px rgba(255,255,255,0.3);
		}
		.dnx-forge:focus-within .dnx-forge-stage { animation-duration: 3.4s; }
		.dnx-forge:focus-within .dnx-forge-ring  { animation-duration: 1.9s; opacity: 1; }
		.dnx-forge:focus-within .dnx-forge-scan  { animation-duration: 1.6s; }

		/* ── Body: head + composer + chips ── */
		.dnx-forge-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
		.dnx-forge-head { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
		.dnx-forge-badge {
			flex-shrink: 0;
			padding: 2px 8px;
			border-radius: var(--nxt-radius-pill);
			border: 1px solid var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.1);
			font-size: 10px; font-weight: 700;
			letter-spacing: 0.09em; text-transform: uppercase;
			color: var(--nxt-ink);
		}
		.dnx-forge-title { font-size: 15px; font-weight: 600; color: var(--nxt-ink); }
		.dnx-forge-sub { font-size: 12.5px; color: var(--nxt-ink-dim); }
		.dnx-forge-form { display: flex; gap: 8px; align-items: stretch; max-width: 560px; }
		.dnx-forge-field { flex: 1; min-width: 0; display: block; }
		.dnx-forge-input {
			width: 100%; height: 36px;
			padding: 0 13px;
			border-radius: var(--nxt-radius-sm);
			border: 1px solid var(--nxt-stroke-strong);
			background: rgba(0,0,0,0.35);
			color: var(--nxt-ink);
			font: inherit; font-size: 13.5px;
			transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
		}
		.dnx-forge-input::placeholder { color: var(--nxt-ink-fade); }
		.dnx-forge-input:hover { border-color: rgba(255,255,255,0.22); }
		.dnx-forge-input:focus {
			outline: none;
			border-color: rgba(255,255,255,0.4);
			background: rgba(0,0,0,0.5);
			box-shadow: 0 0 0 3px rgba(255,255,255,0.07);
		}
		.dnx-forge-go {
			flex-shrink: 0;
			display: inline-flex; align-items: center; gap: 6px;
			height: 36px; padding: 0 15px;
			border-radius: var(--nxt-radius-sm);
			border: 1px solid transparent;
			background: var(--nxt-accent); color: #000;
			font: inherit; font-size: 13px; font-weight: 600;
			cursor: pointer;
			transition: transform 0.12s ease, background 0.15s ease, box-shadow 0.15s ease;
		}
		.dnx-forge-go:hover { background: #fff; box-shadow: 0 4px 18px -6px rgba(255,255,255,0.4); }
		.dnx-forge-go:active { transform: translateY(1px); }
		.dnx-forge-go svg { transition: transform 0.15s ease; }
		.dnx-forge-go:hover svg { transform: translateX(2px); }
		.dnx-forge-chips { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
		.dnx-forge-chips-label { font-size: 11.5px; color: var(--nxt-ink-fade); }
		.dnx-forge-chip {
			padding: 3px 10px;
			border-radius: var(--nxt-radius-pill);
			border: 1px solid var(--nxt-stroke);
			background: rgba(255,255,255,0.03);
			color: var(--nxt-ink-dim);
			font-size: 11.5px; text-decoration: none;
			transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
		}
		.dnx-forge-chip:hover {
			color: var(--nxt-ink);
			border-color: var(--nxt-stroke-strong);
			background: rgba(255,255,255,0.07);
			transform: translateY(-1px);
		}
		.dnx-forge-chip:focus-visible,
		.dnx-forge-go:focus-visible,
		.dnx-forge-dismiss:focus-visible {
			outline: 2px solid var(--nxt-ink);
			outline-offset: 2px;
		}
		.dnx-forge-dismiss {
			position: absolute; top: 10px; right: 10px;
			background: none; border: none; cursor: pointer;
			color: var(--nxt-ink-fade); padding: 4px; border-radius: 6px;
			display: grid; place-items: center;
			transition: color 0.12s ease, background 0.12s ease;
			z-index: 3;
		}
		.dnx-forge-dismiss:hover { color: var(--nxt-ink); background: rgba(255,255,255,0.06); }

		/* Reduced motion — kill every loop, keep the layout intact. */
		.dnx-forge.is-still::before,
		.dnx-forge.is-still .dnx-forge-ring,
		.dnx-forge.is-still .dnx-forge-stage,
		.dnx-forge.is-still .dnx-forge-scan { animation: none; }
		.dnx-forge.is-still .dnx-forge-stage { transform: rotateX(-22deg) rotateY(32deg); }
		.dnx-forge.is-still .dnx-forge-scan { opacity: 0; }
		@media (prefers-reduced-motion: reduce) {
			.dnx-forge::before,
			.dnx-forge .dnx-forge-ring,
			.dnx-forge .dnx-forge-stage,
			.dnx-forge .dnx-forge-scan { animation: none; }
			.dnx-forge .dnx-forge-stage { transform: rotateX(-22deg) rotateY(32deg); }
			.dnx-forge .dnx-forge-scan { opacity: 0; }
		}
		@media (max-width: 680px) {
			.dnx-forge { gap: 14px; padding: 14px; }
			.dnx-forge-visual { width: 52px; height: 52px; align-self: flex-start; }
			.dnx-forge-form { flex-wrap: wrap; }
			.dnx-forge-field { flex-basis: 100%; }
			.dnx-forge-go { flex: 1; justify-content: center; }
		}
		@media (max-width: 460px) {
			.dnx-forge-visual { display: none; }
		}

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
			background: linear-gradient(90deg, rgba(255,255,255,0.5), rgba(255,255,255,0.8));
			transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
		}

		/* Completed steps — compact strip */
		.dnx-ob-done-list {
			list-style: none; padding: 0; margin: 0 0 14px;
			display: flex; flex-direction: column; gap: 4px;
		}
		.dnx-ob-done-row {
			display: flex; align-items: center; gap: 8px;
			font-size: 12.5px; color: var(--nxt-ink-fade);
		}
		.dnx-ob-done-check {
			width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
			display: grid; place-items: center;
			background: rgba(52, 211, 153, 0.12);
			color: #34d399;
		}
		.dnx-ob-done-label { text-decoration: line-through; opacity: 0.7; }

		/* Active (next) step — full card, accent border */
		.dnx-ob-active {
			display: flex; gap: 16px; align-items: flex-start;
			padding: 16px;
			border-radius: 10px;
			border: 1px solid rgba(255,255,255,0.14);
			background: rgba(255,255,255,0.04);
			margin-bottom: 12px;
			position: relative;
			overflow: hidden;
		}
		.dnx-ob-active::before {
			content: '';
			position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
			background: linear-gradient(180deg, rgba(255,255,255,0.6), rgba(255,255,255,0.2));
			border-radius: 3px 0 0 3px;
		}
		.dnx-ob-active-icon {
			width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
			display: grid; place-items: center;
			background: rgba(255,255,255,0.08);
			color: var(--nxt-ink);
		}
		.dnx-ob-active-body { flex: 1; min-width: 0; }
		.dnx-ob-active-step-label {
			font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em;
			text-transform: uppercase; color: var(--nxt-ink-fade);
			margin-bottom: 4px;
			display: flex; align-items: center; gap: 6px;
		}
		.dnx-ob-active-opt {
			font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
			padding: 1px 7px; border-radius: 99px;
			background: rgba(251,191,36,0.15); color: #fbbf24;
			text-transform: uppercase;
		}
		.dnx-ob-active-title {
			font-size: 15px; font-weight: 600; color: var(--nxt-ink);
			margin-bottom: 3px; line-height: 1.3;
		}
		.dnx-ob-active-outcome {
			font-size: 12.5px; font-weight: 500;
			color: rgba(255,255,255,0.65);
			margin-bottom: 8px;
		}
		.dnx-ob-active-detail {
			font-size: 12px; color: var(--nxt-ink-fade);
			line-height: 1.5; margin-bottom: 14px;
		}
		.dnx-ob-active-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
		.dnx-ob-active-cta {
			background: var(--nxt-accent, rgba(255,255,255,0.9)); color: #000;
			font-weight: 600; font-size: 13px; padding: 8px 16px;
			border-radius: 8px; border: none;
			transition: transform 0.12s ease, box-shadow 0.15s ease;
		}
		.dnx-ob-active-cta:hover {
			transform: translateY(-1px);
			box-shadow: 0 4px 18px -6px rgba(255,255,255,0.4);
		}
		.dnx-ob-active-skip { font-size: 12px; color: var(--nxt-ink-fade); }
		.dnx-ob-active-skip a { color: var(--nxt-ink-fade); text-decoration: underline; }
		.dnx-ob-active-skip a:hover { color: var(--nxt-ink); }

		/* Future (upcoming) steps — minimal */
		.dnx-ob-future-list {
			list-style: none; padding: 0; margin: 0 0 12px;
			border-top: 1px solid var(--nxt-stroke);
			padding-top: 10px;
			display: flex; flex-direction: column; gap: 6px;
		}
		.dnx-ob-future-row {
			display: flex; align-items: center; gap: 10px;
			font-size: 12.5px; color: var(--nxt-ink-fade);
			padding: 2px 0;
		}
		.dnx-ob-future-num {
			width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
			display: grid; place-items: center;
			font-size: 10px; font-weight: 600;
			background: rgba(255,255,255,0.05);
			border: 1px solid var(--nxt-stroke);
			color: var(--nxt-ink-fade);
		}
		.dnx-ob-future-label { flex: 1; }
		.dnx-ob-future-opt {
			font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
			padding: 1px 7px; border-radius: 99px;
			background: rgba(251,191,36,0.1); color: #fbbf24;
			text-transform: uppercase;
		}

		.dnx-ob-reassure { margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--nxt-line, rgba(255,255,255,0.08)); }

		/* ── Empty hero: platform flow ── */
		.dnx-empty-hero {
			display: flex; flex-direction: column; align-items: center;
			gap: 24px; padding: 40px 28px 36px;
			border-radius: var(--nxt-radius);
			border: 1px solid var(--nxt-stroke);
			background: linear-gradient(180deg, rgba(255,255,255,0.025), transparent);
			text-align: center;
		}
		.dnx-empty-hero-flow {
			display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center;
		}
		.dnx-flow-step {
			display: flex; flex-direction: column; align-items: center; gap: 6px;
			min-width: 80px;
		}
		.dnx-flow-icon {
			width: 58px; height: 58px; border-radius: 16px;
			display: grid; place-items: center;
			background: rgba(255,255,255,0.05);
			border: 1px solid var(--nxt-stroke);
			color: var(--nxt-ink-dim);
			transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
		}
		.dnx-flow-step:hover .dnx-flow-icon {
			background: rgba(255,255,255,0.09); border-color: var(--nxt-stroke-strong); color: var(--nxt-ink);
		}
		.dnx-flow-label { font-size: 13px; font-weight: 600; color: var(--nxt-ink); }
		.dnx-flow-sub { font-size: 11.5px; color: var(--nxt-ink-fade); }
		.dnx-flow-arrow {
			font-size: 18px; color: var(--nxt-ink-fade); flex-shrink: 0;
			margin-top: -18px;
		}
		.dnx-empty-hero-cta { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
		.dnx-empty-hero-main-cta {
			background: var(--nxt-accent, rgba(255,255,255,0.88)); color: #000;
			font-weight: 600; font-size: 14px; padding: 10px 22px;
			border-radius: 9px; border: none;
			transition: transform 0.12s ease, box-shadow 0.15s ease;
		}
		.dnx-empty-hero-main-cta:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 24px -8px rgba(255,255,255,0.35);
		}
		@media (max-width: 580px) {
			.dnx-flow-arrow { display: none; }
			.dnx-empty-hero-flow { gap: 8px; }
			.dnx-flow-step { min-width: 70px; }
			.dnx-flow-icon { width: 48px; height: 48px; border-radius: 13px; }
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

		/* ── Trading overview ─────────────────────────────────────────── */
		.dnx-trading-panel { padding: 16px; margin-bottom: 12px; }
		.dnx-trading-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
		.dnx-trading-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
		.dnx-tc {
			display: flex; flex-direction: column; gap: 4px;
			background: var(--nxt-surface-2, rgba(255,255,255,0.04));
			border: 1px solid var(--nxt-line, rgba(255,255,255,0.08));
			border-radius: 10px; padding: 14px 15px;
			text-decoration: none; color: inherit;
			transition: border-color 0.14s, background 0.14s;
		}
		.dnx-tc:hover { border-color: var(--nxt-accent, #7c83ff); background: rgba(124,131,255,0.06); }
		.dnx-tc-sk { pointer-events: none; }
		.dnx-tc-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--nxt-ink-fade); margin-bottom: 2px; }
		.dnx-tc-value { font-size: 20px; font-weight: 700; line-height: 1.1; color: var(--nxt-ink); display: flex; align-items: center; }
		.dnx-tc-unit { font-size: 12px; font-weight: 400; color: var(--nxt-ink-fade); margin-left: 4px; align-self: flex-end; padding-bottom: 1px; }
		.dnx-tc-meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--nxt-ink-fade); margin-top: 2px; }
		.dnx-tc-pos { color: var(--nxt-success, #34d399); }
		.dnx-tc-neg { color: var(--nxt-danger, #f87171); }
		.dnx-tc-dim { color: var(--nxt-ink-faint, #5c6273); }
		.dnx-tc-arm-cta { color: var(--nxt-accent, #7c83ff); }
		@media (max-width: 600px) {
			.dnx-trading-cards { grid-template-columns: 1fr; }
		}
	`;
	const tag = document.createElement('style');
	tag.id = 'dnx-home-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}
