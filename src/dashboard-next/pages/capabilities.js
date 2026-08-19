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
.cp-status-link { color: #60a5fa; text-decoration: none; font-weight: 600; }
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

		await refresh(main.querySelector('#cp-root'));

		setInterval(async () => {
			const root = document.getElementById('cp-root');
			if (root) await refresh(root).catch(() => {});
		}, POLL_MS);
	} catch (e) {
		const root = document.getElementById('cp-root') || main;
		if (root) {
			root.innerHTML = errorStateHTML({
				title: 'Couldn’t load capabilities',
				body: esc(e?.message || 'Something went wrong reaching the capabilities API.'),
			});
			attachRetry(root, () => location.reload());
		}
	}
})();

// ── Data + render ─────────────────────────────────────────────────────────────

async function refresh(root) {
	const [agentsRes, strategiesRes, statusRes] = await Promise.allSettled([
		get('/api/agents?limit=50'),
		get('/api/sniper/strategy'),
		get('/api/sniper/status'),
	]);

	const agents     = agentsRes.status === 'fulfilled'    ? (agentsRes.value?.agents ?? []) : [];
	const strategies = strategiesRes.status === 'fulfilled' ? (strategiesRes.value?.strategies ?? []) : [];
	const workerStatus = statusRes.status === 'fulfilled'  ? statusRes.value : null;
	const agentMap   = new Map(agents.map((a) => [a.id, a]));

	const agentIds = agents.map((a) => a.id);
	const [launcherResults, mmResults] = await Promise.allSettled([
		Promise.all(agentIds.map((id) => get(`/api/agent/launcher?agentId=${id}`).catch(() => null))),
		Promise.all(agentIds.map((id) => get(`/api/agent/market-maker?agentId=${id}`).catch(() => null))),
	]);

	const launcherData = launcherResults.status === 'fulfilled' ? launcherResults.value : [];
	const mmData       = mmResults.status === 'fulfilled'       ? mmResults.value       : [];

	const allLauncherConfigs = [], allCoins = [], allMMConfigs = [], allMMTrades = [];
	agentIds.forEach((id, i) => {
		const ag = agentMap.get(id);
		const ld = launcherData[i];
		if (ld) {
			(ld.configs || []).forEach((c) => allLauncherConfigs.push({ ...c, _agent: ag }));
			(ld.coins   || []).forEach((c) => allCoins.push({ ...c, _agent: ag }));
		}
		const md = mmData[i];
		if (md) {
			(md.configs       || []).forEach((c) => allMMConfigs.push({ ...c, _agent: ag }));
			(md.recent_trades || []).forEach((t) => allMMTrades.push({ ...t, _agent: ag }));
		}
	});

	const alphaStrategies = strategies.filter((s) => s.trigger === 'alpha_hunt');

	root.innerHTML = [
		renderWorkerStatus(workerStatus),
		renderAlphaHunt(alphaStrategies, agentMap),
		renderLauncher(allLauncherConfigs, allCoins),
		renderAutoClaim(allCoins),
		renderMarketMaker(allMMConfigs, allMMTrades),
	].join('');
	root.removeAttribute('aria-busy');
	root.removeAttribute('aria-label');

	wireTabSwitchers(root);
	wireLaunchNow(root, agentIds, agentMap);
	wireClaimNow(root);
}

// ── Worker Status ──────────────────────────────────────────────────────────────

function renderWorkerStatus(s) {
	if (!s) {
		return `<div class="cp-status-bar" role="status">
			<div class="cp-status-dot unknown" aria-hidden="true"></div>
			<span class="cp-status-label">Worker status unknown</span>
			<span class="cp-status-meta">Could not reach the sniper status API</span>
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

function renderAlphaHunt(strategies, agentMap) {
	const armed       = strategies.filter((s) => s.enabled && !s.kill_switch);
	const totalBudget = strategies.reduce((sum, s) => sum + (lamportsToSol(s.daily_budget_lamports) || 0), 0);
	const totalPnl    = strategies.reduce((sum, s) => sum + (lamportsToSol(s.summary?.realized_pnl_lamports) || 0), 0);
	const totalWins   = strategies.reduce((sum, s) => sum + (s.summary?.wins || 0), 0);
	const totalClosed = strategies.reduce((sum, s) => sum + (s.summary?.closed_positions || 0), 0);
	const wr          = totalClosed > 0 ? Math.round((totalWins / totalClosed) * 100) : null;

	const badgeClass = armed.length ? 'live' : 'off';
	const badgeLabel = armed.length ? `${armed.length} Armed` : 'Disarmed';

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Alpha Hunt</div>
					<div class="cp-head-sub">Smart-money signal scoring — buys when quality signals converge</div>
				</div>
			</div>
			<div style="display:flex;align-items:center;gap:8px">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
				<a class="cp-link" href="/dashboard/sniper">Configure ↗</a>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Strategies</div><div class="cp-kpi-val">${strategies.length}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Daily Budget</div><div class="cp-kpi-val cp-mono">${fmtSolAbs(totalBudget)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Win Rate</div><div class="cp-kpi-val">${wr != null ? `${wr}%` : '—'}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Realized P&L</div><div class="cp-kpi-val cp-mono ${clr(totalPnl)}">${fmtSol(totalPnl)}</div></div>
		</div>
		<div class="cp-body">
			${strategies.length === 0 ? emptyStateHTML({
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
						const ag     = agentMap.get(s.agent_id);
						const pnl    = lamportsToSol(s.summary?.realized_pnl_lamports);
						const closed = s.summary?.closed_positions || 0;
						const wins   = s.summary?.wins || 0;
						const wr     = closed > 0 ? Math.round((wins / closed) * 100) : null;
						return `<tr>
							<td>
								<div class="cp-agent-chip">
									<img class="cp-av" src="${esc(ag?.image || '/favicon.ico')}" alt="" data-fallback="invisible" loading="lazy" />
									<span>${esc(ag?.name || s.agent_id.slice(0, 8))}</span>
								</div>
							</td>
							<td><span class="cp-badge ${s.enabled && !s.kill_switch ? 'on' : 'off'}">${s.kill_switch ? 'Kill switch' : s.enabled ? 'Armed' : 'Disarmed'}</span></td>
							<td class="hide-sm cp-mono">${s.alpha_min_smart_money != null ? s.alpha_min_smart_money : '—'}</td>
							<td class="hide-sm cp-mono">${s.alpha_min_quality_score != null ? s.alpha_min_quality_score : '—'}</td>
							<td class="hide-sm cp-mono">${s.alpha_max_mcap_usd != null ? `$${Number(s.alpha_max_mcap_usd).toLocaleString()}` : '—'}</td>
							<td class="r cp-mono ${clr(pnl)}">${fmtSol(pnl)}</td>
							<td class="r">${wr != null ? `${wr}%` : '—'}</td>
						</tr>`;
					}).join('')}
				</tbody>
			</table>
			</div>`}
		</div>
	</div>`;
}

// ── Coin Launcher ─────────────────────────────────────────────────────────────

function renderLauncher(configs, coins) {
	const enabled       = configs.filter((c) => c.enabled);
	const totalLaunches = configs.reduce((sum, c) => sum + (Number(c.launches_count) || 0), 0);
	const totalClaimed  = coins.reduce((sum, c)   => sum + (Number(c.total_claimed_lamports) || 0), 0);
	const graduated     = coins.filter((c) => c.is_graduated).length;
	const badgeClass    = enabled.length ? 'live' : 'off';
	const badgeLabel    = enabled.length ? `${enabled.length} Active` : 'Inactive';

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Coin Launcher</div>
					<div class="cp-head-sub">Autonomous pump.fun launches on schedule</div>
				</div>
			</div>
			<div style="display:flex;align-items:center;gap:8px">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
				<a class="cp-link" href="/agents/${configs[0]?.agent_id || ''}/edit#section-launcher" style="display:${configs.length ? 'inline-flex' : 'none'}">Configure ↗</a>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Launchers</div><div class="cp-kpi-val">${configs.length}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Launches</div><div class="cp-kpi-val">${totalLaunches}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Graduated</div><div class="cp-kpi-val">${graduated}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Fees Claimed</div><div class="cp-kpi-val cp-mono">${fmtSolAbs(totalClaimed / 1e9)}</div></div>
		</div>
		${configs.length > 0 ? `
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
							<th scope="col" class="r">Action</th>
						</tr>
					</thead>
					<tbody>
						${configs.map((c) => `<tr>
							<td>${esc(c._agent?.name || c.agent_id?.slice(0, 8) || '—')}</td>
							<td class="cp-mono" style="font-weight:700">$${esc(c.symbol || '—')}</td>
							<td class="hide-sm cp-muted">${c.interval_hours != null ? `Every ${c.interval_hours}h` : 'Manual'}</td>
							<td class="r">${c.launches_count || 0}${c.max_launches ? ` / ${c.max_launches}` : ''}</td>
							<td class="r cp-muted">${c.next_launch_at ? relTime(c.next_launch_at) : c.enabled ? 'Ready' : '—'}</td>
							<td class="r">
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

function renderAutoClaim(coins) {
	const claimable      = coins.filter((c) => c.auto_claim_enabled);
	const totalClaimable = claimable.reduce((sum, c) => sum + (Number(c.claimable_lamports) || 0), 0);
	const totalEarned    = claimable.reduce((sum, c) => sum + (Number(c.total_claimed_lamports) || 0), 0);
	const runners        = claimable.filter((c) => Number(c.claimable_lamports) > 0.1e9);

	const badgeClass = runners.length ? 'warning' : claimable.length ? 'on' : 'off';
	const badgeLabel = runners.length ? `${runners.length} Ready to Claim` : claimable.length ? `${claimable.length} Watching` : 'Inactive';

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Creator Auto-Claim</div>
					<div class="cp-head-sub">Auto-harvests creator fees when coins run — runs every 5 min</div>
				</div>
			</div>
			<div style="display:flex;align-items:center;gap:8px">
				<span class="cp-badge ${badgeClass}">${badgeLabel}</span>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Coins Watching</div><div class="cp-kpi-val">${claimable.length}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Claimable Now</div><div class="cp-kpi-val cp-mono ${totalClaimable > 0 ? 'cp-pos' : ''}">${fmtSolAbs(totalClaimable / 1e9)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Earned</div><div class="cp-kpi-val cp-mono">${fmtSolAbs(totalEarned / 1e9)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Runners</div><div class="cp-kpi-val ${runners.length ? 'cp-pos' : ''}">${runners.length}</div></div>
		</div>
		${claimable.length > 0 ? `
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
						<th scope="col" class="r">Action</th>
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
							<td class="r">
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

function renderMarketMaker(configs, trades) {
	const active     = configs.filter((c) => c.enabled);
	const totalPnl   = configs.reduce((sum, c) => sum + (Number(c.total_pnl_sol)    || 0), 0);
	const totalVol   = configs.reduce((sum, c) => sum + (Number(c.total_volume_sol) || 0), 0);
	const totalBuys  = configs.reduce((sum, c) => sum + (Number(c.total_buys)       || 0), 0);
	const totalSells = configs.reduce((sum, c) => sum + (Number(c.total_sells)      || 0), 0);

	return `<div class="cp-section">
		<div class="cp-head">
			<div class="cp-head-left">
				<div>
					<div class="cp-head-title">Market Maker</div>
					<div class="cp-head-sub">Range-based liquidity with Jito-accelerated execution</div>
				</div>
			</div>
			<div style="display:flex;align-items:center;gap:8px">
				<span class="cp-badge ${active.length ? 'live' : 'off'}">${active.length ? `${active.length} Active` : 'Inactive'}</span>
			</div>
		</div>
		<div class="cp-kpi-row">
			<div class="cp-kpi"><div class="cp-kpi-label">Active Markets</div><div class="cp-kpi-val">${active.length}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Total Volume</div><div class="cp-kpi-val cp-mono">${fmtSolAbs(totalVol)}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Buys / Sells</div><div class="cp-kpi-val">${totalBuys} / ${totalSells}</div></div>
			<div class="cp-kpi"><div class="cp-kpi-label">Net P&L</div><div class="cp-kpi-val cp-mono ${clr(totalPnl)}">${fmtSol(totalPnl)}</div></div>
		</div>
		${active.length > 0 ? `
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

function wireLaunchNow(root, agentIds, agentMap) {
	root.querySelectorAll('[data-launch-now]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const agentId  = btn.dataset.agentId;
			const configId = btn.dataset.configId;
			const network  = btn.dataset.network || 'mainnet';
			btn.disabled = true;
			btn.textContent = 'Launching…';
			try {
				const res = await post('/api/agent/launcher', { action: 'trigger', agentId, configId, network });
				toast(res?.message ?? 'Launch queued — worker will fire within 60s');
			} catch (e) {
				toast(e?.message || 'Launch failed', 'err');
			} finally {
				btn.disabled = false;
				btn.textContent = 'Launch Now';
			}
		});
	});
}

function wireClaimNow(root) {
	root.querySelectorAll('[data-claim-now]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const agentId = btn.dataset.agentId;
			const mint    = btn.dataset.mint;
			const network = btn.dataset.network || 'mainnet';
			btn.disabled = true;
			const orig = btn.textContent;
			btn.textContent = 'Claiming…';
			try {
				const res = await post('/api/pump?action=collect-creator-fee-agent', { agentId, mint, network });
				toast(res?.message ?? `Claimed successfully · tx: ${res?.sig?.slice(0, 8) ?? '?'}…`);
			} catch (e) {
				toast(e?.message || 'Claim failed', 'err');
			} finally {
				btn.disabled = false;
				btn.textContent = orig;
			}
		});
	});
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
