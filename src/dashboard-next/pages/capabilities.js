// dashboard-next — Capabilities command center.
//
// Live status + interactive controls for all 4 autonomous agent capabilities:
//   1. Alpha Hunt   — smart-money signal scoring, armed strategies
//   2. Coin Launcher— scheduled pump.fun launches with "Launch Now" trigger
//   3. Auto-Claim   — per-coin creator fee harvesting with "Claim Now"
//   4. Market Maker — range-based Jito liquidity provision
//
// Polls every 30s. Buttons are fire-and-forget with toast feedback.

import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime } from '../api.js';
import { emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';

const POLL_MS = 30_000;

// Placeholder for a value the page could not read. Matches the dash this file
// already renders in every other empty cell.
const EMPTY = '\u2014';

// Poll-loop guards: a re-render must never land on top of an in-flight refresh
// or replace a button whose request has not come back yet.
let refreshing = false;
let actionsInFlight = 0;
let retryWired = false;
const fmtSol    = (n) => (n == null || isNaN(Number(n)) ? '—' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(4)} ◎`);
const fmtSolAbs = (n) => (n == null || isNaN(Number(n)) ? '—' : `${Number(n).toFixed(4)} ◎`);
const clr       = (n) => (Number(n) >= 0 ? 'cp-pos' : 'cp-neg');

const STYLE = `<style>
.cp-page { display: flex; flex-direction: column; gap: 24px; }

/* Worker status bar */
.cp-status-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: var(--nxt-radius); background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); font-size: 12.5px; }
.cp-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cp-status-dot.alive  { background: #34d399; box-shadow: 0 0 6px #34d39980; animation: cpblink 2s ease infinite; }
.cp-status-dot.dead   { background: #f87171; }
.cp-status-dot.degraded { background: #fbbf24; box-shadow: 0 0 6px #fbbf2480; animation: cpblink 1.2s ease infinite; }
.cp-status-dot.unknown { background: var(--nxt-ink-faint); }
.cp-status-label { font-weight: 600; }
.cp-status-meta  { color: var(--nxt-ink-dim); }
.cp-status-spacer { flex: 1; }
.cp-status-link { color: #60a5fa; text-decoration: none; font-weight: 600; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; cursor: pointer; }
.cp-status-link:hover { text-decoration: underline; }

/* Sections */
.cp-section { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
.cp-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--nxt-line); }
.cp-head-left { display: flex; align-items: center; gap: 10px; }
.cp-head-title { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
.cp-head-sub { font-size: 12px; color: var(--nxt-ink-dim); }
.cp-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; border: 1px solid; }
.cp-badge.on      { color: #34d399; border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.08); }
.cp-badge.off     { color: var(--nxt-ink-dim); border-color: var(--nxt-stroke); background: transparent; }
.cp-badge.live    { color: #60a5fa; border-color: rgba(96,165,250,.4); background: rgba(96,165,250,.07); animation: cpblink 2s ease infinite; }
.cp-badge.warning { color: #fbbf24; border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.07); }
@keyframes cpblink { 0%,100%{opacity:1} 50%{opacity:.6} }

/* KPIs */
.cp-kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 0; }
.cp-kpi { padding: 12px 18px; border-right: 1px solid var(--nxt-line); }
.cp-kpi:last-child { border-right: none; }
.cp-kpi-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--nxt-ink-faint); margin-bottom: 5px; }
.cp-kpi-val { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }

/* Table */
.cp-body { padding: 0; }
.cp-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cp-table th { padding: 8px 14px; text-align: left; font: 600 10px/1 monospace; letter-spacing: .06em; text-transform: uppercase; color: var(--nxt-ink-faint); border-bottom: 1px solid var(--nxt-line); white-space: nowrap; }
.cp-table th.r, .cp-table td.r { text-align: right; }
.cp-table td { padding: 10px 14px; border-bottom: 1px solid var(--nxt-line); vertical-align: middle; }
.cp-table tr:last-child td { border-bottom: none; }
.cp-table tr:hover td { background: rgba(255,255,255,.025); }
.cp-mono  { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.cp-pos   { color: #34d399; }
.cp-neg   { color: #f87171; }
.cp-muted { color: var(--nxt-ink-dim); }

/* Skeleton — shimmer sweep, layout-matched to the section blocks it replaces */
.cp-sk { position: relative; overflow: hidden; height: 52px; border-radius: var(--nxt-radius-sm); background: var(--nxt-bg-2); margin: 10px 14px; }
.cp-sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-150%); background: linear-gradient(90deg, transparent, var(--nxt-accent-soft), transparent); animation: cp-sk-sweep 1.5s ease-in-out infinite; }
@keyframes cp-sk-sweep { to { transform: translateX(150%); } }

/* Misc */
.cp-agent-chip { display: inline-flex; align-items: center; gap: 6px; }
.cp-av { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; background: var(--nxt-bg-2); }
.cp-score-bar { display: inline-flex; align-items: center; gap: 6px; }
.cp-score-fill { height: 4px; border-radius: 2px; background: linear-gradient(90deg, #3b82f6, #34d399); }
.cp-inv-bar  { display: flex; align-items: center; gap: 6px; }
.cp-inv-fill { height: 6px; border-radius: 3px; background: #60a5fa; }
.cp-inv-track { height: 6px; border-radius: 3px; background: var(--nxt-bg-2); flex: 1; overflow: hidden; }

/* Tabs */
.cp-tabs { display: flex; gap: 2px; padding: 10px 14px 0; border-bottom: 1px solid var(--nxt-line); }
.cp-tab { padding: 6px 12px; border-radius: 6px 6px 0 0; font-size: 12px; font-weight: 600; color: var(--nxt-ink-dim); cursor: pointer; border: none; background: none; transition: color .12s, background .12s; }
.cp-tab:hover { color: var(--nxt-ink); background: rgba(255,255,255,.04); }
.cp-tab.active { color: var(--nxt-ink); background: var(--nxt-bg-2); }
.cp-tab-panel { display: none; }
.cp-tab-panel.active { display: block; }

/* Links + action buttons */
.cp-link { font-size: 12px; color: #60a5fa; text-decoration: none; padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(96,165,250,.3); transition: background .12s; }
.cp-link:hover { background: rgba(96,165,250,.1); }
.cp-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 6px; font-size: 11.5px; font-weight: 700; cursor: pointer; border: 1px solid; transition: all .12s; white-space: nowrap; }
.cp-btn-go { color: #34d399; border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.07); }
.cp-btn-go:hover { background: rgba(52,211,153,.16); }
.cp-btn-claim { color: #fbbf24; border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.07); }
.cp-btn-claim:hover { background: rgba(251,191,36,.14); }
.cp-btn:disabled { opacity: .4; cursor: default; pointer-events: none; }

/* Toast */
.cp-toast-wrap { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 9999; pointer-events: none; }
.cp-toast { padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; backdrop-filter: blur(8px); border: 1px solid; animation: cptoast .2s ease; pointer-events: none; max-width: 320px; }
.cp-toast.ok  { color: #34d399; border-color: rgba(52,211,153,.4); background: rgba(12,18,14,.9); }
.cp-toast.err { color: #f87171; border-color: rgba(248,113,113,.4); background: rgba(18,10,10,.9); }
@keyframes cptoast { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }

/* Horizontal scroll container — wide tables scroll inside their own box,
   never forcing page-level horizontal overflow. */
.cp-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.cp-scroll:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: -2px; }

/* Below 640px the section header's badge and link squeeze the title into a
   four-line column. Stack instead: title gets the full width, controls sit
   under it on one row. */
@media (max-width: 640px) {
  .cp-head { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; }
  .cp-head-actions { display: flex; align-items: center; gap: 8px; }
  .cp-kpi { padding: 10px 14px; }
}

/* On a phone the table still scrolls sideways, but the row's primary action
   must not scroll out of reach with it: pin the action column to the right
   edge so Launch Now / Claim are always one tap away. */
@media (max-width: 640px) {
  .cp-table th.cp-act, .cp-table td.cp-act {
    position: sticky; right: 0; z-index: 1;
    background: var(--nxt-panel);
    box-shadow: -8px 0 8px -8px rgba(0,0,0,.55);
  }
  .cp-table tr:hover td.cp-act { background: var(--nxt-bg-2); }
}

/* Keyboard focus rings on every interactive element */
.cp-tab:focus-visible,
.cp-btn:focus-visible,
.cp-link:focus-visible,
.cp-status-link:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: var(--nxt-radius-sm); }
.cp-btn:active:not(:disabled) { transform: translateY(1px); }
.cp-link:active { transform: translateY(1px); }

/* Screen-reader-only text (accessible table captions) */
.cp-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (max-width: 600px) {
  .cp-kpi-row { grid-template-columns: 1fr 1fr; }
  .cp-table th.hide-sm, .cp-table td.hide-sm { display: none; }
  .cp-status-bar { flex-wrap: wrap; }
}

@media (prefers-reduced-motion: reduce) {
  .cp-status-dot, .cp-badge.live, .cp-sk::after, .cp-toast { animation: none !important; }
  .cp-btn, .cp-tab, .cp-link, .cp-status-link { transition: none; }
  .cp-btn:active:not(:disabled), .cp-link:active { transform: none; }
}
</style>`;

// ── Toast system ──────────────────────────────────────────────────────────────

function ensureToastContainer() {
	let wrap = document.querySelector('.cp-toast-wrap');
	if (!wrap) {
		wrap = document.createElement('div');
		wrap.className = 'cp-toast-wrap';
		wrap.setAttribute('aria-live', 'polite');
		wrap.setAttribute('aria-atomic', 'false');
		document.body.appendChild(wrap);
	}
	return wrap;
}

function toast(msg, type = 'ok') {
	const wrap = ensureToastContainer();
	const el = document.createElement('div');
	el.className = `cp-toast ${type}`;
	el.setAttribute('role', type === 'err' ? 'alert' : 'status');
	el.textContent = msg;
	wrap.appendChild(el);
	setTimeout(() => el.remove(), 4000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
	let main;
	try {
		main = await mountShell();
		await requireUser();

		ensureStateKitStyles();
		main.innerHTML = `
			<h1 class="dn-h1">Capabilities</h1>
			<p class="dn-h1-sub">Live command center for all 4 autonomous capabilities — Alpha Hunt, Launcher, Auto-Claim, and Market Maker.</p>
			<div id="cp-root" class="cp-page" aria-busy="true" aria-label="Loading capabilities">
				<div class="cp-sk" style="height:44px;margin:0"></div>
				<div class="cp-sk" style="height:180px;margin:0"></div>
				<div class="cp-sk" style="height:180px;margin:0"></div>
				<div class="cp-sk" style="height:180px;margin:0"></div>
				<div class="cp-sk" style="height:180px;margin:0"></div>
			</div>
		`;
		main.insertAdjacentHTML('beforeend', STYLE);

		const root = main.querySelector('#cp-root');
		// Delegated, so it survives every innerHTML re-render: one listener serves
		// the whole-page error state and each section's own retry button.
		attachRetry(root, () => { refresh(root).catch(showBootError); });
		retryWired = true;

		await refresh(root);

		setInterval(() => { poll(root); }, POLL_MS);
		// A tab returning to the foreground has stale numbers on screen; refresh
		// immediately rather than making the user wait out the interval.
		document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(root); });
	} catch (e) {
		showBootError(e, main);
	}
})();

/** Poll tick. Skips work that would be wasted or destructive: a hidden tab, a
 *  refresh still in flight, or a button mid-request whose DOM node we would
 *  otherwise replace. */
async function poll(root) {
	if (document.hidden || refreshing || actionsInFlight > 0) return;
	if (!document.body.contains(root)) return;
	refreshing = true;
	try {
		await refresh(root);
	} catch (e) {
		// A poll failure never blanks data already on screen; refresh() renders
		// its own per-section notices, so this only catches a render-time throw.
		console.warn('[capabilities] refresh failed:', e?.message || e);
	} finally {
		refreshing = false;
	}
}

function showBootError(e, fallback) {
	const root = document.getElementById('cp-root') || fallback;
	if (!root) return;
	root.innerHTML = errorStateHTML({
		title: 'Couldn’t load capabilities',
		body: esc(e?.message || 'Something went wrong reaching the capabilities API.'),
		scope: 'capabilities',
	});
	root.removeAttribute('aria-busy');
	root.removeAttribute('aria-label');
	// Only when boot died before the delegated handler was wired; otherwise that
	// handler already re-runs refresh() and a second listener would double-fire.
	if (!retryWired) attachRetry(root, () => location.reload());
}

// ── Data + render ─────────────────────────────────────────────────────────────

// Four requests, whatever the roster size. This used to fan out one request per
// agent per capability (3 + 2N per refresh, every 30s), which on a real account
// tripped the per-IP rate limit mid-load: the failed calls were swallowed and
// the page rendered a confident all-zero dashboard for an account that had data.
// The `all=1` mode on both agent endpoints answers for the whole account in one
// query each, and every failure below is now surfaced instead of coerced to [].
const ENDPOINTS = [
	{ key: 'status',    url: '/api/sniper/status' },
	{ key: 'strategy',  url: '/api/sniper/strategy' },
	{ key: 'launcher',  url: '/api/agent/launcher?all=1' },
	{ key: 'mm',        url: '/api/agent/market-maker?all=1' },
];

/** Human-readable reason for a failed section fetch. */
function failureText(err) {
	if (err?.status === 429) return 'Rate limited. The data below is not available right now.';
	if (err?.status === 401 || err?.status === 403) return 'Your session no longer covers this data. Sign in again to load it.';
	if (err?.status >= 500) return 'The API returned an error. This is on our side, not yours.';
	// A fetch that never reached a server has no status, and its raw message is
	// browser-speak ("Failed to fetch"). Say something the reader can act on.
	if (err?.status == null) return 'No response from the network. Check your connection, then retry.';
	return err?.message || 'Could not reach the API.';
}

async function refresh(root) {
	const settled = await Promise.allSettled(ENDPOINTS.map((e) => get(e.url)));
	const data = {}, errs = {};
	ENDPOINTS.forEach((e, i) => {
		const r = settled[i];
		if (r.status === 'fulfilled') data[e.key] = r.value;
		else errs[e.key] = failureText(r.reason);
	});

	// Every lane down means the API is unreachable, not that the account is
	// empty. Say so once, loudly, rather than four times as a fake zero.
	if (Object.keys(errs).length === ENDPOINTS.length) {
		root.innerHTML = errorStateHTML({
			title: 'Couldn’t reach the capabilities API',
			body: esc(errs.status || 'No capability endpoint responded.'),
			scope: 'capabilities',
		});
		root.removeAttribute('aria-busy');
		root.removeAttribute('aria-label');
		return;
	}

	const strategies = data.strategy?.strategies ?? [];
	const launcherConfigs = withAgent(data.launcher?.configs);
	const coins           = withAgent(data.launcher?.coins);
	const mmConfigs       = withAgent(data.mm?.configs);
	const mmTrades        = withAgent(data.mm?.recent_trades);

	const ui = captureUiState(root);
	root.innerHTML = [
		renderWorkerStatus(data.status ?? null, errs.status),
		renderAlphaHunt(strategies.filter((s) => s.trigger === 'alpha_hunt'), errs.strategy),
		renderLauncher(launcherConfigs, coins, errs.launcher),
		renderAutoClaim(coins, errs.launcher),
		renderMarketMaker(mmConfigs, mmTrades, errs.mm),
	].join('');
	root.removeAttribute('aria-busy');
	root.removeAttribute('aria-label');

	wireTabSwitchers(root);
	wireLaunchNow(root);
	wireClaimNow(root);
	restoreUiState(root, ui);
}

/** The `all=1` responses carry the owning agent inline, so shape it once here. */
function withAgent(rows) {
	return (rows || []).map((r) => ({ ...r, _agent: { name: r.agent_name, image: r.agent_image } }));
}

/** Section-level failure block: never a fake empty state. */
function sectionErrorHTML(message) {
	return errorStateHTML({ title: 'Couldn’t load this capability', body: esc(message), scope: 'capabilities' });
}

// ── Re-render continuity ──────────────────────────────────────────────────────
//
// The 30s poll replaces the whole subtree, which would otherwise snap an open
// tab back to its default and drop keyboard focus mid-read. Capture the bits a
// user can move, then put them back.

function captureUiState(root) {
	const tabs = {};
	root.querySelectorAll('.cp-tab[aria-selected="true"]').forEach((t) => { tabs[t.dataset.tabGroup] = t.dataset.tab; });
	const active = document.activeElement;
	const focus = active && root.contains(active) && active.dataset?.tab
		? { group: active.dataset.tabGroup, tab: active.dataset.tab }
		: null;
	const scrolls = {};
	root.querySelectorAll('.cp-scroll[aria-label]').forEach((el) => { scrolls[el.getAttribute('aria-label')] = el.scrollTop; });
	return { tabs, focus, scrolls };
}

function restoreUiState(root, ui) {
	if (!ui) return;
	for (const [group, tab] of Object.entries(ui.tabs)) {
		const btn = root.querySelector(`.cp-tab[data-tab-group="${CSS.escape(group)}"][data-tab="${CSS.escape(tab)}"]`);
		if (btn && btn.getAttribute('aria-selected') !== 'true') btn.click();
	}
	for (const [label, top] of Object.entries(ui.scrolls)) {
		if (!top) continue;
		const el = root.querySelector(`.cp-scroll[aria-label="${CSS.escape(label)}"]`);
		if (el) el.scrollTop = top;
	}
	if (ui.focus) {
		root.querySelector(`.cp-tab[data-tab-group="${CSS.escape(ui.focus.group)}"][data-tab="${CSS.escape(ui.focus.tab)}"]`)?.focus();
	}
}

// ── Worker Status ──────────────────────────────────────────────────────────────

function renderWorkerStatus(s, err) {
	if (!s) {
		return `<div class="cp-status-bar" role="status">
			<div class="cp-status-dot unknown" aria-hidden="true"></div>
			<span class="cp-status-label">Worker status unavailable</span>
			<span class="cp-status-meta">${esc(err || 'The sniper status API did not answer.')}</span>
			<div class="cp-status-spacer"></div>
			<button type="button" class="cp-status-link" data-sk-retry data-sk-scope="capabilities">Retry</button>
		</div>`;
	}

	const state = s.state ?? 'unknown';
	const dotClass = state === 'alive' ? 'alive' : state === 'degraded' ? 'degraded' : state === 'dead' ? 'dead' : 'unknown';
	const label = {
		alive:    '● Worker online',
		degraded: '● Feed degraded',
		dead:     '● Worker offline',
		unknown:  '○ Not yet started',
	}[state] ?? '○ Unknown';
	const detail = {
		alive:    `Sniper worker is live${s.feedLive ? ' · feed connected' : ' · feed reconnecting'}`,
		degraded: 'Worker alive but pump.fun feed is stale — possible connection issue',
		dead:     'No heartbeat within 90s — worker may be down or not deployed yet',
		unknown:  'Worker has never started. Deploy workers/agent-sniper to begin.',
	}[state] ?? '';

	const strats  = s.activeStrategies ?? 0;
	const pos     = s.openPositions    ?? 0;
	const mode    = s.mode ? ` · ${s.mode}` : '';

	// Treasury → agent funding flow: shown only once the auto-funder has actually
	// moved SOL, so it reads as proof the money pump is working rather than a zero.
	const f = s.funding;
	const fundedToday = Number(f?.fundedTodaySol) || 0;
	const fundedTotal = Number(f?.fundedTotalSol) || 0;
	const fundingMeta = fundedTotal > 0
		? `<span class="cp-muted" style="font-size:12px" title="SOL the treasury has auto-funded into sniper agents">⛽ ${fundedToday.toFixed(3)} SOL today · ${fundedTotal.toFixed(3)} SOL total</span>`
		: '';

	return `<div class="cp-status-bar" role="status" aria-live="polite">
		<div class="cp-status-dot ${dotClass}" aria-hidden="true"></div>
		<span class="cp-status-label">${esc(label)}</span>
		<span class="cp-status-meta">${esc(detail)}</span>
		<div class="cp-status-spacer"></div>
		${fundingMeta}
		${strats ? `<span class="cp-muted" style="font-size:12px">${strats} strategies · ${pos} positions open${esc(mode)}</span>` : ''}
		<a class="cp-status-link" href="/dashboard/sniper" aria-label="Open Sniper dashboard">Sniper ↗</a>
	</div>`;
}

// ── Alpha Hunt ────────────────────────────────────────────────────────────────

function renderAlphaHunt(strategies, err) {
	const armed       = strategies.filter((s) => s.enabled && !s.kill_switch);
	const totalBudget = strategies.reduce((sum, s) => sum + (lamportsToSol(s.daily_budget_lamports) || 0), 0);
	const totalPnl    = strategies.reduce((sum, s) => sum + (lamportsToSol(s.summary?.realized_pnl_lamports) || 0), 0);
	const totalWins   = strategies.reduce((sum, s) => sum + (s.summary?.wins || 0), 0);
	const totalClosed = strategies.reduce((sum, s) => sum + (s.summary?.closed_positions || 0), 0);
	const wr          = totalClosed > 0 ? Math.round((totalWins / totalClosed) * 100) : null;

	const badgeClass = err ? 'warning' : armed.length ? 'live' : 'off';
	const badgeLabel = err ? 'Unavailable' : armed.length ? `${armed.length} Armed` : 'Disarmed';
	const kpi = (v) => (err ? EMPTY : v);

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Alpha Hunt</div>
					<div class="cp-head-sub">Smart-money signal scoring — buys when quality signals converge</div>
				</div>
			</div>
			<div class="cp-head-actions">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
				<a class="cp-link" href="/dashboard/sniper">Configure ↗</a>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Strategies</div><div class="cp-kpi-val">${kpi(strategies.length)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Daily Budget</div><div class="cp-kpi-val cp-mono">${kpi(fmtSolAbs(totalBudget))}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Win Rate</div><div class="cp-kpi-val">${kpi(wr != null ? `${wr}%` : EMPTY)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Realized P&L</div><div class="cp-kpi-val cp-mono ${err ? '' : clr(totalPnl)}">${kpi(fmtSol(totalPnl))}</div></div>
		</div>
		<div class="cp-body">
			${err ? sectionErrorHTML(err) : strategies.length === 0 ? emptyStateHTML({
				icon: '🎯',
				title: 'No Alpha Hunt strategies yet',
				body: 'Arm an agent to score smart-money signals and auto-buy when quality converges.',
				actions: [{ label: 'Create a strategy', href: '/dashboard/sniper', primary: true }],
			}) : `
			<div class="cp-scroll" tabindex="0" role="region" aria-label="Alpha Hunt strategies (scrollable)">
			<table class="cp-table">
				<caption class="cp-sr">Alpha Hunt strategies</caption>
				<thead>
					<tr>
						<th scope="col">Agent</th>
						<th scope="col">Status</th>
						<th scope="col" class="hide-sm">Min Smart-Money</th>
						<th scope="col" class="hide-sm">Min Quality</th>
						<th scope="col" class="hide-sm">Max MCap</th>
						<th scope="col" class="r">P&L</th>
						<th scope="col" class="r">Win Rate</th>
					</tr>
				</thead>
				<tbody>
					${strategies.map((s) => {
						const pnl    = lamportsToSol(s.summary?.realized_pnl_lamports);
						const closed = s.summary?.closed_positions || 0;
						const wins   = s.summary?.wins || 0;
						const wr     = closed > 0 ? Math.round((wins / closed) * 100) : null;
						return `<tr>
							<td>
								<div class="cp-agent-chip">
									<img class="cp-av" src="${esc(s.image || '/favicon.ico')}" alt="" data-fallback="invisible" loading="lazy" />
									<span>${esc(s.agent_name || s.agent_id.slice(0, 8))}</span>
								</div>
							</td>
							<td><span class="cp-badge ${s.enabled && !s.kill_switch ? 'on' : 'off'}">${s.kill_switch ? 'Kill switch' : s.enabled ? 'Armed' : 'Disarmed'}</span></td>
							<td class="hide-sm cp-mono">${s.alpha_min_smart_money != null ? s.alpha_min_smart_money : '—'}</td>
							<td class="hide-sm cp-mono">${s.alpha_min_quality_score != null ? s.alpha_min_quality_score : '—'}</td>
							<td class="hide-sm cp-mono">${s.alpha_max_mcap_usd != null ? `$${Number(s.alpha_max_mcap_usd).toLocaleString()}` : '—'}</td>
							<td class="r cp-mono ${clr(pnl)}">${fmtSol(pnl)}</td>
							<td class="r">${wr != null ? `${wr}%` : EMPTY}</td>
						</tr>`;
					}).join('')}
				</tbody>
			</table>
			</div>`}
		</div>
	</div>`;
}

// ── Coin Launcher ─────────────────────────────────────────────────────────────

function renderLauncher(configs, coins, err) {
	const enabled       = configs.filter((c) => c.enabled);
	const totalLaunches = configs.reduce((sum, c) => sum + (Number(c.launches_count) || 0), 0);
	const totalClaimed  = coins.reduce((sum, c)   => sum + (Number(c.total_claimed_lamports) || 0), 0);
	const graduated     = coins.filter((c) => c.is_graduated).length;
	const badgeClass    = err ? 'warning' : enabled.length ? 'live' : 'off';
	const badgeLabel    = err ? 'Unavailable' : enabled.length ? `${enabled.length} Active` : 'Inactive';
	const kpi           = (v) => (err ? EMPTY : v);
	// One launcher per agent, so a single "Configure" target only makes sense
	// when exactly one is set up. With several, the per-row agent column is the
	// way in; an arbitrary configs[0] link was a coin flip, and with none it
	// rendered a dead /agents//edit href.
	const soleAgentId   = !err && configs.length === 1 ? configs[0].agent_id : null;

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Coin Launcher</div>
					<div class="cp-head-sub">Autonomous pump.fun launches on schedule</div>
				</div>
			</div>
			<div class="cp-head-actions">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
				${soleAgentId ? `<a class="cp-link" href="/agents/${esc(soleAgentId)}/edit#section-launcher">Configure ↗</a>` : '<a class="cp-link" href="/dashboard/agents">Agents ↗</a>'}
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Launchers</div><div class="cp-kpi-val">${kpi(configs.length)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Launches</div><div class="cp-kpi-val">${kpi(totalLaunches)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Graduated</div><div class="cp-kpi-val">${kpi(graduated)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Fees Claimed</div><div class="cp-kpi-val cp-mono">${kpi(fmtSolAbs(totalClaimed / 1e9))}</div></div>
		</div>
		${err ? `<div class="cp-body">${sectionErrorHTML(err)}</div>` : configs.length > 0 ? `
		<div class="cp-body">
			<div class="cp-tabs" role="tablist" aria-label="Coin Launcher views">
				<button class="cp-tab active" role="tab" id="cptab-launcher-schedule" aria-controls="cppanel-launcher-schedule" aria-selected="true" data-tab-group="launcher" data-tab="schedule">Schedule</button>
				<button class="cp-tab" role="tab" id="cptab-launcher-coins" aria-controls="cppanel-launcher-coins" aria-selected="false" tabindex="-1" data-tab-group="launcher" data-tab="coins">Launched Coins (${coins.length})</button>
			</div>
			<div class="cp-tab-panel active" role="tabpanel" id="cppanel-launcher-schedule" aria-labelledby="cptab-launcher-schedule" tabindex="0" data-tab-group="launcher" data-panel="schedule">
				<div class="cp-scroll" tabindex="0" role="region" aria-label="Launch schedule (scrollable)">
				<table class="cp-table">
					<caption class="cp-sr">Scheduled launches</caption>
					<thead>
						<tr>
							<th scope="col">Agent</th>
							<th scope="col">Symbol</th>
							<th scope="col" class="hide-sm">Interval</th>
							<th scope="col" class="r">Launches</th>
							<th scope="col" class="r">Next Launch</th>
							<th scope="col" class="r cp-act">Action</th>
						</tr>
					</thead>
					<tbody>
						${configs.map((c) => `<tr>
							<td>${esc(c._agent?.name || c.agent_id?.slice(0, 8) || '—')}</td>
							<td class="cp-mono" style="font-weight:700">$${esc(c.symbol || '—')}</td>
							<td class="hide-sm cp-muted">${c.interval_hours != null ? `Every ${c.interval_hours}h` : 'Manual'}</td>
							<td class="r">${c.launches_count || 0}${c.max_launches ? ` / ${c.max_launches}` : ''}</td>
							<td class="r cp-muted">${c.next_launch_at ? relTime(c.next_launch_at) : c.enabled ? 'Ready' : '—'}</td>
							<td class="r cp-act">
								${c.enabled ? `<button type="button" class="cp-btn cp-btn-go" data-launch-now data-agent-id="${esc(c.agent_id)}" data-config-id="${esc(c.id)}" data-network="${esc(c.network || 'mainnet')}" aria-label="Launch $${esc(c.symbol || 'coin')} now">Launch Now</button>` : '<span class="cp-muted">—</span>'}
							</td>
						</tr>`).join('')}
					</tbody>
				</table>
				</div>
			</div>
			<div class="cp-tab-panel" role="tabpanel" id="cppanel-launcher-coins" aria-labelledby="cptab-launcher-coins" tabindex="0" hidden data-tab-group="launcher" data-panel="coins">
				${coins.length === 0 ? emptyStateHTML({
					compact: true,
					icon: '🪙',
					title: 'No coins launched yet',
					body: 'Use Launch Now or wait for the next scheduled slot.',
				}) : `
				<div class="cp-scroll" tabindex="0" role="region" aria-label="Launched coins (scrollable)">
				<table class="cp-table">
					<caption class="cp-sr">Launched coins</caption>
					<thead>
						<tr>
							<th scope="col">Symbol</th>
							<th scope="col">Name</th>
							<th scope="col" class="hide-sm">Agent</th>
							<th scope="col" class="hide-sm">Network</th>
							<th scope="col" class="r">Claimed</th>
							<th scope="col" class="r">Graduated</th>
						</tr>
					</thead>
					<tbody>
						${coins.slice(0, 30).map((c) => `<tr>
							<td class="cp-mono" style="font-weight:700">$${esc(c.symbol || '—')}</td>
							<td class="cp-muted">${esc(c.name || '—')}</td>
							<td class="hide-sm">${esc(c._agent?.name || c.agent_id?.slice(0, 8) || '—')}</td>
							<td class="hide-sm cp-muted">${esc(c.network || 'mainnet')}</td>
							<td class="r cp-mono">${fmtSolAbs(Number(c.total_claimed_lamports || 0) / 1e9)}</td>
							<td class="r">${c.is_graduated ? '<span class="cp-pos">Yes</span>' : '<span class="cp-muted">No</span>'}</td>
						</tr>`).join('')}
					</tbody>
				</table>
				</div>`}
			</div>
		</div>` : emptyStateHTML({
			icon: '🚀',
			title: 'No launchers configured',
			body: 'Set up a launcher on an agent to schedule autonomous pump.fun launches.',
			actions: [{ label: 'Set up a launcher', href: '/dashboard/agents', primary: true }],
		})}
	</div>`;
}

// ── Auto-Claim ────────────────────────────────────────────────────────────────

function renderAutoClaim(coins, err) {
	const claimable      = coins.filter((c) => c.auto_claim_enabled);
	const totalClaimable = claimable.reduce((sum, c) => sum + (Number(c.claimable_lamports) || 0), 0);
	const totalEarned    = claimable.reduce((sum, c) => sum + (Number(c.total_claimed_lamports) || 0), 0);
	const runners        = claimable.filter((c) => Number(c.claimable_lamports) > 0.1e9);

	const badgeClass = err || runners.length ? 'warning' : claimable.length ? 'on' : 'off';
	const badgeLabel = err ? 'Unavailable' : runners.length ? `${runners.length} Ready to Claim` : claimable.length ? `${claimable.length} Watching` : 'Inactive';
	const kpi        = (v) => (err ? EMPTY : v);

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Creator Auto-Claim</div>
					<div class="cp-head-sub">Auto-harvests creator fees when coins run — runs every 5 min</div>
				</div>
			</div>
			<div class="cp-head-actions">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Coins Watching</div><div class="cp-kpi-val">${kpi(claimable.length)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Claimable Now</div><div class="cp-kpi-val cp-mono ${!err && totalClaimable > 0 ? 'cp-pos' : ''}">${kpi(fmtSolAbs(totalClaimable / 1e9))}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Earned</div><div class="cp-kpi-val cp-mono">${kpi(fmtSolAbs(totalEarned / 1e9))}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Runners</div><div class="cp-kpi-val ${!err && runners.length ? 'cp-pos' : ''}">${kpi(runners.length)}</div></div>
		</div>
		${err ? `<div class="cp-body">${sectionErrorHTML(err)}</div>` : claimable.length > 0 ? `
		<div class="cp-body">
			<div class="cp-scroll" tabindex="0" role="region" aria-label="Auto-claim coins (scrollable)">
			<table class="cp-table">
				<caption class="cp-sr">Coins watched for creator fees</caption>
				<thead>
					<tr>
						<th scope="col">Symbol</th>
						<th scope="col" class="hide-sm">Agent</th>
						<th scope="col" class="r">Claimable</th>
						<th scope="col" class="r">Total Claimed</th>
						<th scope="col" class="r hide-sm">Last Checked</th>
						<th scope="col" class="r cp-act">Action</th>
					</tr>
				</thead>
				<tbody>
					${claimable.map((c) => {
						const claimSol  = Number(c.claimable_lamports || 0) / 1e9;
						const earnedSol = Number(c.total_claimed_lamports || 0) / 1e9;
						const canClaim  = claimSol >= Number(c.auto_claim_threshold_sol || 0);
						return `<tr>
							<td class="cp-mono" style="font-weight:700">$${esc(c.symbol || '—')}</td>
							<td class="hide-sm">${esc(c._agent?.name || c.agent_id?.slice(0, 8) || '—')}</td>
							<td class="r cp-mono ${claimSol > 0 ? 'cp-pos' : 'cp-muted'}">${fmtSolAbs(claimSol)}</td>
							<td class="r cp-mono">${fmtSolAbs(earnedSol)}</td>
							<td class="r hide-sm cp-muted">${c.last_fee_check_at ? relTime(c.last_fee_check_at) : 'Never'}</td>
							<td class="r cp-act">
								${canClaim && claimSol > 0 ? `<button type="button" class="cp-btn cp-btn-claim" data-claim-now data-agent-id="${esc(c.agent_id)}" data-mint="${esc(c.mint)}" data-network="${esc(c.network || 'mainnet')}" aria-label="Claim ${fmtSolAbs(claimSol)} from $${esc(c.symbol || 'coin')}">Claim ${fmtSolAbs(claimSol)}</button>` : '<span class="cp-muted">Below threshold</span>'}
							</td>
						</tr>`;
					}).join('')}
				</tbody>
			</table>
			</div>
		</div>` : emptyStateHTML({
			icon: '💰',
			title: 'No coins watched for fees yet',
			body: 'Launch a coin and enable Auto-Claim to start harvesting creator rewards.',
			actions: [{ label: 'Go to launcher', href: '/dashboard/agents', primary: true }],
		})}
	</div>`;
}

// ── Market Maker ──────────────────────────────────────────────────────────────

function renderMarketMaker(configs, trades, err) {
	const active     = configs.filter((c) => c.enabled);
	const totalPnl   = configs.reduce((sum, c) => sum + (Number(c.total_pnl_sol)    || 0), 0);
	const totalVol   = configs.reduce((sum, c) => sum + (Number(c.total_volume_sol) || 0), 0);
	const totalBuys  = configs.reduce((sum, c) => sum + (Number(c.total_buys)       || 0), 0);
	const totalSells = configs.reduce((sum, c) => sum + (Number(c.total_sells)      || 0), 0);
	const kpi        = (v) => (err ? EMPTY : v);

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Market Maker</div>
					<div class="cp-head-sub">Range-based liquidity with Jito-accelerated execution</div>
				</div>
			</div>
			<div class="cp-head-actions">
				<span class="cp-badge ${err ? 'warning' : active.length ? 'live' : 'off'}">${err ? 'Unavailable' : active.length ? `${active.length} Active` : 'Inactive'}</span>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Active Markets</div><div class="cp-kpi-val">${kpi(active.length)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Volume</div><div class="cp-kpi-val cp-mono">${kpi(fmtSolAbs(totalVol))}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Buys / Sells</div><div class="cp-kpi-val">${kpi(`${totalBuys} / ${totalSells}`)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Net P&L</div><div class="cp-kpi-val cp-mono ${err ? '' : clr(totalPnl)}">${kpi(fmtSol(totalPnl))}</div></div>
		</div>
		${err ? `<div class="cp-body">${sectionErrorHTML(err)}</div>` : active.length > 0 ? `
		<div class="cp-body">
			<div class="cp-tabs" role="tablist" aria-label="Market Maker views">
				<button class="cp-tab active" role="tab" id="cptab-mm-markets" aria-controls="cppanel-mm-markets" aria-selected="true" data-tab-group="mm" data-tab="markets">Active Markets</button>
				<button class="cp-tab" role="tab" id="cptab-mm-trades" aria-controls="cppanel-mm-trades" aria-selected="false" tabindex="-1" data-tab-group="mm" data-tab="trades">Recent Trades (${trades.length})</button>
			</div>
			<div class="cp-tab-panel active" role="tabpanel" id="cppanel-mm-markets" aria-labelledby="cptab-mm-markets" tabindex="0" data-tab-group="mm" data-panel="markets">
				<div class="cp-scroll" tabindex="0" role="region" aria-label="Active markets (scrollable)">
				<table class="cp-table">
					<caption class="cp-sr">Active markets</caption>
					<thead>
						<tr>
							<th scope="col">Symbol</th>
							<th scope="col" class="hide-sm">Agent</th>
							<th scope="col">Spread</th>
							<th scope="col" class="hide-sm">Order Size</th>
							<th scope="col">Inventory</th>
							<th scope="col" class="r">P&L</th>
							<th scope="col" class="r hide-sm">MEV</th>
						</tr>
					</thead>
					<tbody>
						${active.map((c) => {
							const inv    = Number(c.current_inventory_sol) || 0;
							const maxInv = Number(c.max_inventory_sol) || 1;
							const invPct = Math.min(100, Math.round((inv / maxInv) * 100));
							return `<tr>
								<td class="cp-mono" style="font-weight:700">${esc(c.symbol || c.mint?.slice(0, 6) || '—')}</td>
								<td class="hide-sm">${esc(c._agent?.name || c.agent_id?.slice(0, 8) || '—')}</td>
								<td class="cp-mono">${(Number(c.spread_bps) / 100).toFixed(2)}%</td>
								<td class="hide-sm cp-mono">${fmtSolAbs(Number(c.order_size_sol))}</td>
								<td>
									<div class="cp-inv-bar" role="img" aria-label="Inventory ${fmtSolAbs(inv)} of ${fmtSolAbs(maxInv)} (${invPct}%)">
										<div class="cp-inv-track"><div class="cp-inv-fill" style="width:${invPct}%"></div></div>
										<span class="cp-mono" style="font-size:11px;min-width:2.5rem;text-align:right">${fmtSolAbs(inv)}</span>
									</div>
								</td>
								<td class="r cp-mono ${clr(Number(c.total_pnl_sol) || 0)}">${fmtSol(Number(c.total_pnl_sol) || 0)}</td>
								<td class="r hide-sm cp-muted">${esc(c.mev_tip_mode || 'off')}</td>
							</tr>`;
						}).join('')}
					</tbody>
				</table>
				</div>
			</div>
			<div class="cp-tab-panel" role="tabpanel" id="cppanel-mm-trades" aria-labelledby="cptab-mm-trades" tabindex="0" hidden data-tab-group="mm" data-panel="trades">
				${trades.length === 0 ? emptyStateHTML({
					compact: true,
					icon: '📈',
					title: 'No trades yet',
					body: 'The market maker trades when price enters the configured spread.',
				}) : `
				<div class="cp-scroll" tabindex="0" role="region" aria-label="Recent trades (scrollable)">
				<table class="cp-table">
					<caption class="cp-sr">Recent market-maker trades</caption>
					<thead>
						<tr>
							<th scope="col">Side</th>
							<th scope="col">Token</th>
							<th scope="col" class="hide-sm">Agent</th>
							<th scope="col" class="r">Size (SOL)</th>
							<th scope="col" class="r">P&L</th>
							<th scope="col" class="r hide-sm">Tx</th>
						</tr>
					</thead>
					<tbody>
						${trades.slice(0, 30).map((t) => {
							const pnl = Number(t.realized_pnl_lamports || 0) / 1e9;
							return `<tr>
								<td><span class="cp-badge ${t.side === 'buy' ? 'on' : 'off'}" style="font-size:10px">${esc((t.side || '—').toUpperCase())}</span></td>
								<td class="cp-mono" style="font-weight:600">${esc(t.symbol || t.mint?.slice(0, 6) || '—')}</td>
								<td class="hide-sm cp-muted">${esc(t._agent?.name || t.agent_id?.slice(0, 8) || '—')}</td>
								<td class="r cp-mono">${fmtSolAbs(Number(t.quote_lamports || 0) / 1e9)}</td>
								<td class="r cp-mono ${clr(pnl)}">${t.side === 'sell' ? fmtSol(pnl) : '—'}</td>
								<td class="r hide-sm">${t.sig ? `<a class="cp-muted" href="https://solscan.io/tx/${esc(t.sig)}" target="_blank" rel="noopener" style="font-size:10px;font-family:monospace">${t.sig.slice(0, 8)}…</a>` : '—'}</td>
							</tr>`;
						}).join('')}
					</tbody>
				</table>
				</div>`}
			</div>
		</div>` : emptyStateHTML({
			icon: '📊',
			title: 'No active markets',
			body: 'Add a market in Agent Edit → Market Maker to start providing liquidity.',
			actions: [{ label: 'Configure an agent', href: '/dashboard/agents', primary: true }],
		})}
	</div>`;
}

// ── Interactive buttons ───────────────────────────────────────────────────────

function wireLaunchNow(root) {
	root.querySelectorAll('[data-launch-now]').forEach((btn) => {
		btn.addEventListener('click', () => runAction(btn, 'Launching…', 'Launch failed', () =>
			post('/api/agent/launcher', {
				action:   'trigger',
				agentId:  btn.dataset.agentId,
				configId: btn.dataset.configId,
				network:  btn.dataset.network || 'mainnet',
			}).then((res) => res?.message ?? 'Launch queued. The worker fires within 60s.')));
	});
}

function wireClaimNow(root) {
	root.querySelectorAll('[data-claim-now]').forEach((btn) => {
		btn.addEventListener('click', () => runAction(btn, 'Claiming…', 'Claim failed', () =>
			post('/api/pump?action=collect-creator-fee-agent', {
				agentId: btn.dataset.agentId,
				mint:    btn.dataset.mint,
				network: btn.dataset.network || 'mainnet',
			}).then((res) => res?.message ?? `Claimed successfully · tx: ${res?.sig?.slice(0, 8) ?? '?'}…`)));
	});
}

/** Shared button lifecycle: pending label, toast, and a poll hold so the 30s
 *  re-render cannot replace the button out from under an in-flight request. */
async function runAction(btn, pendingLabel, failLabel, run) {
	const orig = btn.textContent;
	btn.disabled = true;
	btn.textContent = pendingLabel;
	actionsInFlight += 1;
	try {
		toast(await run());
	} catch (e) {
		toast(e?.message || failLabel, 'err');
	} finally {
		actionsInFlight -= 1;
		btn.disabled = false;
		btn.textContent = orig;
	}
}

// ── Tab switchers ─────────────────────────────────────────────────────────────

function wireTabSwitchers(root) {
	function activate(btn) {
		const group = btn.dataset.tabGroup;
		const panel = btn.dataset.tab;
		root.querySelectorAll(`[data-tab-group="${group}"].cp-tab`).forEach((t) => {
			const on = t === btn;
			t.classList.toggle('active', on);
			t.setAttribute('aria-selected', on ? 'true' : 'false');
			t.tabIndex = on ? 0 : -1;
		});
		root.querySelectorAll(`[data-tab-group="${group}"].cp-tab-panel`).forEach((p) => {
			const on = p.dataset.panel === panel;
			p.classList.toggle('active', on);
			p.hidden = !on;
		});
	}

	root.querySelectorAll('.cp-tab').forEach((btn) => {
		btn.addEventListener('click', () => activate(btn));
		btn.addEventListener('keydown', (e) => {
			if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
			e.preventDefault();
			const group = btn.dataset.tabGroup;
			const tabs = [...root.querySelectorAll(`[data-tab-group="${group}"].cp-tab`)];
			const i = tabs.indexOf(btn);
			let next;
			if (e.key === 'Home') next = tabs[0];
			else if (e.key === 'End') next = tabs[tabs.length - 1];
			else if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
			else next = tabs[(i - 1 + tabs.length) % tabs.length];
			activate(next);
			next.focus();
		});
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lamportsToSol(l) {
	if (l == null) return 0;
	try { return Number(BigInt(l)) / 1e9; } catch { return Number(l) / 1e9; }
}
