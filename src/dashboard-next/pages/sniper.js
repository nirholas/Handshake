// dashboard-next — Sniper Strategies.
//
// Strategy management for the autonomous pump.fun sniper worker:
//   1. Overview strip     — aggregate PnL, open positions, win rate.
//   2. Your strategies    — one card per armed agent with enable/kill-switch.
//   3. Strategy editor    — inline config for budget, exits, filters.
//   4. Live positions     — SSE stream of open trades, real-time.
//   5. Arm new strategy   — select an unstrategied agent and configure it.
//
// Endpoints:
//   GET  /api/sniper/strategy   → { strategies: [...] }
//   POST /api/sniper/strategy   → upsert/arm strategy
//   GET  /api/sniper/stream     → SSE: position events

import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime } from '../api.js';
import { StudioAdapter } from '../studio-adapter.js';
import { mountMoneyStudio } from '../../studio/money/money-studio.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';
import { toast } from '../../shared/toast.js';

const SOL = 1_000_000_000n;
const lamportsToSol = (l) => Number(BigInt(l || '0')) / 1e9;
const fmtSol = (sol) => {
	const v = Number(sol) || 0;
	if (Math.abs(v) < 0.001) return `${v.toFixed(4)} ◎`;
	return `${v.toFixed(3)} ◎`;
};
const fmtLamports = (l) => fmtSol(lamportsToSol(l));
const solToLamports = (s) => String(Math.round(Number(s) * 1e9));
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const clr = (n) => (Number(n) > 0 ? 'sn-pos' : Number(n) < 0 ? 'sn-neg' : '');

function fmtHold(sec) {
	if (!sec) return '—';
	const s = Number(sec);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	return `${(s / 3600).toFixed(1)}h`;
}
function fmtDelayMs(ms) {
	const n = Number(ms || 0);
	if (!n) return 'No delay';
	if (n < 1000) return `${n}ms`;
	return `${(n / 1000).toFixed(1)}s`;
}

function pumpUrl(mint) { return `https://pump.fun/coin/${encodeURIComponent(mint)}`; }

// ── Styles ───────────────────────────────────────────────────────────────────

const STYLE = `<style>
.sn-wrap { display: grid; gap: 20px; }

/* overview strip */
.sn-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
.sn-kpi { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 14px 16px; font-family: inherit; color: inherit; text-align: left; display: block; width: 100%; cursor: pointer; transition: border-color .14s, background .14s, transform .14s; }
.sn-kpi:hover { border-color: var(--nxt-stroke-strong); background: var(--nxt-bg-2); transform: translateY(-1px); }
.sn-kpi:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.sn-kpi-label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
.sn-kpi-val { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }

/* strategy card */
.sn-cards { display: grid; gap: 14px; }
.sn-card { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; transition: border-color .14s; }
.sn-card.armed { border-color: color-mix(in srgb, var(--nxt-accent) 40%, var(--nxt-stroke)); }
.sn-card-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; cursor: pointer; user-select: none; }
.sn-card-head:hover { background: var(--nxt-bg-2); }
.sn-av { width: 40px; height: 40px; border-radius: 10px; object-fit: cover; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); flex-shrink: 0; }
.sn-info { flex: 1; min-width: 0; }
.sn-name { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sn-meta { font-size: 12px; color: var(--nxt-ink-faint); margin-top: 2px; display: flex; gap: 10px; flex-wrap: wrap; }
.sn-badges { display: flex; gap: 6px; align-items: center; }
.sn-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); white-space: nowrap; }
.sn-badge.on { color: var(--nxt-success); border-color: color-mix(in srgb, var(--nxt-success) 35%, transparent); background: color-mix(in srgb, var(--nxt-success) 8%, transparent); }
.sn-badge.kill { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 35%, transparent); background: color-mix(in srgb, var(--nxt-danger, #f87171) 8%, transparent); }
.sn-badge.off { color: var(--nxt-ink-faint); }
.sn-badge.sim { color: var(--nxt-warn); border-color: color-mix(in srgb, var(--nxt-warn) 35%, transparent); }
.sn-chevron { color: var(--nxt-ink-faint); font-size: 12px; transition: transform .18s; flex-shrink: 0; }
.sn-card.open .sn-chevron { transform: rotate(180deg); }
.sn-card-body { display: none; border-top: 1px solid var(--nxt-line); padding: 16px; }
.sn-card.open .sn-card-body { display: block; }

/* sub-tab switcher (Strategy ↔ Money Studio) */
.sn-subtabs { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 16px; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); }
.sn-subtab { font-size: 12.5px; font-weight: 600; font-family: inherit; padding: 6px 14px; border-radius: var(--nxt-radius-sm); border: 1px solid transparent; background: transparent; color: var(--nxt-ink-dim); cursor: pointer; transition: color .12s, background .12s; }
.sn-subtab:hover { color: var(--nxt-ink); }
.sn-subtab.active { background: var(--nxt-panel); color: var(--nxt-ink); border-color: var(--nxt-stroke); }
.sn-subtab:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
/* host for the embedded Money Studio; re-scope the panel tokens it expects so the
   wallet accents resolve even though the dashboard theme uses --nxt-* tokens. */
.sn-money-host { --wallet-accent: var(--nxt-accent, #34d399); --wallet-accent-soft: color-mix(in srgb, var(--nxt-accent, #34d399) 14%, transparent); }
.sn-money-loading { padding: 28px 16px; text-align: center; color: var(--nxt-ink-faint); font-size: 13px; }

/* toggles row */
.sn-toggles { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.sn-toggle-btn { font-size: 12px; padding: 6px 14px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; transition: border-color .12s, background .12s, transform .12s; }
.sn-toggle-btn:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
.sn-toggle-btn.active { background: var(--nxt-accent); color: #061018; border-color: transparent; }
.sn-toggle-btn.danger { border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 50%, transparent); color: var(--nxt-danger, #f87171); }
.sn-toggle-btn.danger:hover { background: color-mix(in srgb, var(--nxt-danger, #f87171) 12%, transparent); }

/* summary mini-strip inside card */
.sn-sum { display: flex; gap: 20px; flex-wrap: wrap; padding: 10px 0 16px; border-bottom: 1px solid var(--nxt-line); margin-bottom: 16px; }
.sn-sum-item { display: flex; flex-direction: column; gap: 2px; }
.sn-sum-label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .05em; }
.sn-sum-val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* config form */
.sn-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; }
@media (max-width: 560px) { .sn-form { grid-template-columns: 1fr; } }
.sn-field { display: flex; flex-direction: column; gap: 4px; }
.sn-field label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .04em; }
.sn-field input, .sn-field select { background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); color: var(--nxt-ink); padding: 7px 10px; font-size: 13px; font-family: inherit; width: 100%; transition: border-color .12s; }
.sn-field input:focus, .sn-field select:focus { outline: none; border-color: var(--nxt-accent); }
.sn-field .sn-hint { font-size: 11px; color: var(--nxt-ink-faint); }
.sn-field-full { grid-column: 1 / -1; }
.sn-link { color: var(--nxt-accent); text-decoration: none; }
.sn-link:hover { text-decoration: underline; }
.sn-section-head { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--nxt-ink-dim); margin: 16px 0 8px; grid-column: 1 / -1; }
.sn-save-row { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; margin-top: 6px; }
.sn-btn { font-size: 13px; padding: 8px 18px; border-radius: var(--nxt-radius-sm); border: 1px solid transparent; cursor: pointer; transition: opacity .14s, transform .14s; }
.sn-btn:hover { opacity: .88; transform: translateY(-1px); }
.sn-btn.primary { background: var(--nxt-accent); color: #061018; }
.sn-btn.ghost { background: transparent; border-color: var(--nxt-stroke); color: var(--nxt-ink); }
.sn-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.sn-save-msg { font-size: 12px; color: var(--nxt-ink-faint); }

/* live positions */
.sn-live { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); }
.sn-live-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--nxt-line); }
.sn-live-title { font-size: 14px; font-weight: 600; display: flex; gap: 8px; align-items: center; }
.sn-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--nxt-success); animation: sn-pulse 2s ease infinite; flex-shrink: 0; }
.sn-live-dot.connecting, .sn-live-dot.reconnecting { background: var(--nxt-warn, #f59e0b); }
.sn-live-dot.offline { background: var(--nxt-danger, #f87171); animation: none; }
.sn-conn-status { font-size: 11px; font-weight: 500; color: var(--nxt-ink-faint); letter-spacing: .02em; }
.sn-live-links { display: flex; gap: 8px; align-items: center; }
@keyframes sn-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.sn-pos-list { padding: 0; }
.sn-pos-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 10px; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--nxt-line); }
.sn-pos-row:last-child { border-bottom: 0; }
.sn-pos-info { min-width: 0; }
.sn-pos-sym { font-weight: 600; font-size: 14px; }
.sn-pos-sub { font-size: 11px; color: var(--nxt-ink-faint); margin-top: 2px; }
.sn-pos-pnl { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.sn-pos-link { font-size: 12px; color: var(--nxt-accent); text-decoration: none; padding: 4px 10px; border: 1px solid color-mix(in srgb, var(--nxt-accent) 35%, transparent); border-radius: var(--nxt-radius-sm); white-space: nowrap; transition: background .12s; }
.sn-pos-link:hover { background: color-mix(in srgb, var(--nxt-accent) 12%, transparent); }
.sn-pos-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.sn-pos-sell { font-size: 12px; font-family: inherit; padding: 4px 12px; border-radius: var(--nxt-radius-sm); white-space: nowrap; cursor: pointer; color: var(--nxt-danger, #f87171); border: 1px solid color-mix(in srgb, var(--nxt-danger, #f87171) 45%, transparent); background: color-mix(in srgb, var(--nxt-danger, #f87171) 8%, transparent); transition: background .12s, transform .12s; }
.sn-pos-sell:hover { background: color-mix(in srgb, var(--nxt-danger, #f87171) 16%, transparent); transform: translateY(-1px); }
.sn-pos-sell:focus-visible { outline: 2px solid var(--nxt-danger, #f87171); outline-offset: 2px; }
.sn-pos-sell:disabled { opacity: .5; cursor: progress; transform: none; }
.sn-pos-oracle { display: inline-flex; }
.sn-ob { display: inline-flex; align-items: center; gap: 3px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 3px 7px; text-decoration: none; transition: border-color .12s; }
.sn-ob:hover { border-color: rgba(255,255,255,0.22); }
.sn-ob-score { font: 700 11px/1 var(--nxt-mono, monospace); font-variant-numeric: tabular-nums; }
.sn-ob-tier { font: 600 8px/1 var(--nxt-mono, monospace); text-transform: uppercase; letter-spacing: .06em; opacity: .8; }
.sn-empty { color: var(--nxt-ink-faint); font-size: 13px; padding: 24px 16px; text-align: center; }
/* coin-detail deep link on position/trade symbols */
.sn-coin-link { color: inherit; text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--nxt-ink-faint) 60%, transparent); transition: color .12s, border-color .12s; }
.sn-coin-link:hover { color: var(--nxt-accent); border-bottom-color: var(--nxt-accent); }
.sn-coin-link:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: 3px; }
/* per-card live positions block */
.sn-agent-pos { border: 1px solid var(--nxt-line); border-radius: var(--nxt-radius-sm); margin-bottom: 16px; overflow: hidden; }
.sn-agent-pos .sn-pos-row { padding: 10px 12px; }
.sn-agent-pos-empty { color: var(--nxt-ink-faint); font-size: 12.5px; padding: 12px; text-align: center; }
/* live open-positions chip in the collapsed card head */
.sn-open-chip { font-variant-numeric: tabular-nums; }
/* execution readout — MEV route, tip, time-to-land */
.sn-exec { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 5px; }
.sn-exec-badge { font: 600 9.5px/1 var(--nxt-mono, monospace); text-transform: uppercase; letter-spacing: .05em; padding: 3px 6px; border-radius: 5px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-faint); }
.sn-exec-turbo { color: #c084fc; border-color: color-mix(in srgb, #c084fc 45%, transparent); background: color-mix(in srgb, #c084fc 10%, transparent); }
.sn-exec-jito { color: #34d399; border-color: color-mix(in srgb, #34d399 45%, transparent); background: color-mix(in srgb, #34d399 10%, transparent); }
.sn-exec-prot { color: #60a5fa; border-color: color-mix(in srgb, #60a5fa 40%, transparent); }
.sn-exec-sim { color: var(--nxt-ink-faint); }
.sn-exec-meta { font: 500 10px/1 var(--nxt-mono, monospace); color: var(--nxt-ink-faint); font-variant-numeric: tabular-nums; }

/* trade history */
.sn-hist { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
.sn-hist-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 12px; border-bottom: 1px solid var(--nxt-line); }
.sn-hist-head h3 { font-size: 14px; margin: 0; }
.sn-hist-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.sn-hist-table th { padding: 9px 14px; text-align: left; font: 600 10px/1 var(--nxt-mono, monospace); letter-spacing: .07em; text-transform: uppercase; color: var(--nxt-ink-faint); border-bottom: 1px solid var(--nxt-line); white-space: nowrap; }
.sn-hist-table th.r, .sn-hist-table td.r { text-align: right; }
.sn-hist-row td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; white-space: nowrap; }
.sn-hist-row:last-child td { border-bottom: none; }
.sn-hist-sym { font-weight: 700; font-size: 13px; }
.sn-hist-agent { font-size: 11px; color: var(--nxt-ink-faint); margin-top: 2px; }
.sn-hist-mono { font-family: var(--nxt-mono, monospace); font-variant-numeric: tabular-nums; }
.sn-hist-tag { font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-faint); }
.sn-hist-tag.tp { color: var(--nxt-success); border-color: color-mix(in srgb, var(--nxt-success) 40%, transparent); }
.sn-hist-tag.sl { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 40%, transparent); }
.sn-hist-link { color: var(--nxt-accent); text-decoration: none; font-size: 11px; }
.sn-hist-link:hover { text-decoration: underline; }
.sn-hist-more { display: block; text-align: center; padding: 12px; font-size: 12px; color: var(--nxt-ink-faint); border-top: 1px solid var(--nxt-line); background: none; border-left:0;border-right:0;border-bottom:0; width:100%; cursor:pointer; }
.sn-hist-more:hover { color: var(--nxt-ink); }
@media (max-width: 640px) { .sn-hist-table th.hide-mobile, .sn-hist-row td.hide-mobile { display: none; } }

/* pnl chart */
.sn-chart-wrap { padding: 14px 18px 10px; border-bottom: 1px solid var(--nxt-line); }
.sn-chart-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.sn-chart-label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .07em; font-family: var(--nxt-mono, monospace); }
.sn-chart-val { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; font-family: var(--nxt-mono, monospace); }
.sn-chart-canvas { width: 100%; height: 90px; display: block; }

/* new strategy cta */
.sn-new { background: var(--nxt-panel); border: 1px dashed var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 20px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sn-new-text { font-size: 13px; color: var(--nxt-ink-faint); max-width: 340px; }
.sn-new-text b { color: var(--nxt-ink); }

/* pos/neg colors */
.sn-pos { color: var(--nxt-success); }
.sn-neg { color: var(--nxt-danger, #f87171); }

/* boot skeleton wrapper (shimmer rows come from the shared state-kit) */
.sn-boot-sk { display: grid; gap: 10px; }

/* arm modal overlay */
.sn-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); backdrop-filter: blur(6px); z-index: 900; display: flex; align-items: center; justify-content: center; padding: 16px; }
.sn-modal { background: var(--nxt-bg); border: 1px solid var(--nxt-stroke-strong); border-radius: var(--nxt-radius); padding: 24px; width: 100%; max-width: 480px; }
.sn-modal h2 { font-size: 16px; margin: 0 0 16px; }
.sn-modal-foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

/* focus rings — keyboard operability on every interactive control, incl. the
   safety controls (arm/disarm, kill switch) and the collapsible card head */
.sn-card-head:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: -2px; border-radius: var(--nxt-radius); }
.sn-toggle-btn:focus-visible, .sn-btn:focus-visible, .sn-pos-link:focus-visible,
.sn-hist-link:focus-visible, .sn-hist-more:focus-visible, .sn-link:focus-visible,
.sn-subtab:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }

/* honor reduced-motion — kill pulses, shimmer and hover lifts for users who ask */
@media (prefers-reduced-motion: reduce) {
	.sn-live-dot { animation: none; }
	.sn-chevron { transition: none; }
	.sn-kpi:hover, .sn-btn:hover, .sn-toggle-btn:hover, .sn-pos-sell:hover,
	.sn-pos-link:hover, .sn-card:hover { transform: none; }
}
</style>`;

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();
		ensureStateKitStyles();

		main.innerHTML = `
			<h1 class="dn-h1">Sniper Strategies</h1>
			<p class="dn-h1-sub">Manage your autonomous trading agents — budgets, filters, exits, and live positions.</p>
			<div id="sn-root" class="sn-boot-sk" aria-busy="true">${skeletonHTML(3, 'row')}</div>
		`;
		main.insertAdjacentHTML('beforeend', STYLE);

		await refresh(main.querySelector('#sn-root'));
	} catch (e) {
		const root = document.getElementById('sn-root');
		if (root) {
			root.classList.remove('sn-boot-sk');
			root.removeAttribute('aria-busy');
			root.innerHTML = errorStateHTML({
				title: "Couldn't load your strategies",
				body: esc(e.message || 'The strategy service is unavailable right now. Check your connection and try again.'),
			});
			attachRetry(root, () => location.reload());
		}
	}
})();

// ── Main render ───────────────────────────────────────────────────────────────

let _strategies = [];
let _agents = [];
let _sseSource = null;
let _sseTimer = null;
let _sseRetry = 0;
let _positionsMap = new Map();

async function refresh(root) {
	// Re-render replaces every card's DOM — tear down any mounted Money Studio first
	// so its 30s balance poll doesn't outlive the node it was rendered into.
	teardownMoney();
	const [stratData, agentData] = await Promise.all([
		get('/api/sniper/strategy').catch(() => ({ strategies: [] })),
		get('/api/agents').catch(() => ({ agents: [] })),
	]);
	_strategies = stratData.strategies || [];
	_agents = agentData.agents || [];

	root.classList.remove('sn-boot-sk');
	root.removeAttribute('aria-busy');
	root.innerHTML = render();
	wireEvents(root);
	startSse();
	loadTradeHistory(root);

	// Auto-open arm modal when arriving from Strategy Lab with a preset
	const qp = new URLSearchParams(location.search);
	if (qp.get('from') === 'strategy-lab' && qp.get('preset_tier')) {
		openArmModal(root);
	}
}

function render() {
	const hasStrats = _strategies.length > 0;
	return `
	<div class="sn-wrap">
		${overviewStrip()}
		<div class="sn-cards" id="sn-cards">
			${hasStrats ? _strategies.map(stratCard).join('') : ''}
		</div>
		${livePositionsSection()}
		<div id="sn-hist-mount"></div>
		${newStrategyCta()}
	</div>`;
}

// ── Overview strip ────────────────────────────────────────────────────────────

function overviewStrip() {
	const totalOpen = _strategies.reduce((s, r) => s + (r.summary?.open_positions || 0), 0);
	const totalClosed = _strategies.reduce((s, r) => s + (r.summary?.closed_positions || 0), 0);
	const totalWins = _strategies.reduce((s, r) => s + (r.summary?.wins || 0), 0);
	const totalPnlLam = _strategies.reduce((s, r) => s + BigInt(r.summary?.realized_pnl_lamports || '0'), 0n);
	const winRate = totalClosed > 0 ? Math.round((totalWins / totalClosed) * 100) : null;
	const armed = _strategies.filter((s) => s.enabled && !s.kill_switch).length;

	// Each KPI is a real button that jumps to the section backing the number —
	// the strip is navigation, not decoration.
	const kpi = (jump, label, valHtml, title) => `
		<button type="button" class="sn-kpi" data-jump="${jump}" title="${esc(title)}" aria-label="${esc(`${label} — ${title}`)}">
			<div class="sn-kpi-label">${label}</div>
			<div class="sn-kpi-val">${valHtml}</div>
		</button>`;

	return `<div class="sn-strip">
		${kpi('#sn-cards', 'Armed agents', String(armed), 'Jump to your strategies')}
		${kpi('#sn-positions', 'Open positions', `<span data-kpi-open>${totalOpen}</span>`, 'Jump to live positions')}
		${kpi('#sn-hist-mount', 'Realized PnL', `<span class="${clr(lamportsToSol(String(totalPnlLam)))}">${fmtLamports(String(totalPnlLam))}</span>`, 'Jump to trade history')}
		${kpi('#sn-hist-mount', 'Win rate', winRate != null ? `${winRate}%` : '—', 'Jump to trade history')}
		${kpi('#sn-hist-mount', 'Closed trades', String(totalClosed), 'Jump to trade history')}
	</div>`;
}

// ── Strategy card ─────────────────────────────────────────────────────────────

function stratCard(s) {
	const armed = s.enabled && !s.kill_switch;
	const pnlSol = lamportsToSol(s.summary?.realized_pnl_lamports || '0');
	const closed = s.summary?.closed_positions || 0;
	const wins = s.summary?.wins || 0;
	const wr = closed > 0 ? Math.round((wins / closed) * 100) : null;
	const img = s.image || '/favicon.ico';
	const triggerLabel = s.trigger === 'first_claim' ? 'First-claim trigger' : s.trigger === 'intel_confirmed' ? 'Intel-confirmed trigger' : s.trigger === 'prelaunch_radar' ? 'Pre-launch radar trigger' : s.trigger === 'alpha_hunt' ? 'Alpha Hunt trigger' : 'New mint trigger';

	const walletBal = s.wallet_sol != null ? s.wallet_sol : null;
	const walletWarn = walletBal != null && walletBal < lamportsToSol(s.per_trade_lamports || '0') + 0.003;

	const label = s.agent_name || s.agent_id;
	return `<div class="sn-card ${armed ? 'armed' : ''}" data-agent="${esc(s.agent_id)}">
		<div class="sn-card-head" data-toggle="card" role="button" tabindex="0" aria-expanded="false" aria-label="Expand ${esc(label)} strategy details">
			<img loading="lazy" decoding="async" class="sn-av" src="${esc(img)}" alt="" data-fallback="invisible" />
			<div class="sn-info">
				<div class="sn-name">${esc(s.agent_name || s.agent_id)}</div>
				<div class="sn-meta">
					<span>${triggerLabel}</span>
					<span>${fmtSol(lamportsToSol(s.per_trade_lamports))} / trade</span>
					<span>Daily budget: ${fmtSol(lamportsToSol(s.daily_budget_lamports))}</span>
					${walletBal != null ? `<span class="${walletWarn ? 'sn-neg' : ''}">Wallet: ${fmtSol(walletBal)}${walletWarn ? ' ⚠ low' : ''}</span>` : ''}
					<span class="sn-open-chip" data-open-chip="${esc(s.agent_id)}" hidden></span>
				</div>
			</div>
			<div class="sn-badges">
				${s.kill_switch ? '<span class="sn-badge kill">Kill switch ON</span>' : s.enabled ? '<span class="sn-badge on">Armed</span>' : '<span class="sn-badge off">Disarmed</span>'}
			</div>
			<span class="sn-chevron">▼</span>
		</div>
		<div class="sn-card-body">
			<div class="sn-subtabs" role="tablist" aria-label="Strategy views">
				<button class="sn-subtab active" role="tab" aria-selected="true" data-subtab="strategy" data-agent="${esc(s.agent_id)}">Strategy</button>
				<button class="sn-subtab" role="tab" aria-selected="false" data-subtab="money" data-agent="${esc(s.agent_id)}">Money Studio</button>
			</div>
			<div class="sn-pane" data-pane="strategy" data-agent="${esc(s.agent_id)}">
				<div class="sn-toggles">
					<button class="sn-toggle-btn ${armed ? 'active' : ''}" data-action="toggle-enabled" data-agent="${esc(s.agent_id)}" aria-label="${s.enabled ? 'Disarm this agent — stop opening new positions' : 'Arm this agent — allow it to trade real SOL from its own wallet'}">
						${s.enabled ? 'Disarm' : 'Arm strategy'}
					</button>
					<button class="sn-toggle-btn ${s.kill_switch ? 'active danger' : 'danger'}" data-action="toggle-kill" data-agent="${esc(s.agent_id)}" aria-label="${s.kill_switch ? 'Clear the kill switch and allow trading to resume' : 'Trip the kill switch — immediately halt all trading for this agent'}">
						${s.kill_switch ? 'Clear kill switch' : 'Kill switch'}
					</button>
					<a class="sn-toggle-btn" href="/trader/${esc(s.agent_id)}" target="_blank" rel="noopener">Track record ↗</a>
					${s.wallet_address ? `<a class="sn-toggle-btn" href="https://solscan.io/account/${esc(s.wallet_address)}" target="_blank" rel="noopener">Wallet ↗</a>` : ''}
				</div>
				${walletWarn ? `<div style="font-size:12px;color:var(--nxt-warn,#f59e0b);padding:4px 0 12px;border-bottom:1px solid var(--nxt-line);margin-bottom:12px;">⚠ Wallet balance (${fmtSol(walletBal)}) may be too low for a trade. Fund ${s.wallet_address ? `<a href="https://solscan.io/account/${esc(s.wallet_address)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">${s.wallet_address.slice(0,8)}…</a>` : 'the agent wallet'} with more SOL before arming. Open <b>Money Studio</b> above to fund it without leaving the dashboard.</div>` : ''}
				<div class="sn-sum">
					<div class="sn-sum-item">
						<span class="sn-sum-label">Open</span>
						<span class="sn-sum-val">${s.summary?.open_positions || 0}</span>
					</div>
					<div class="sn-sum-item">
						<span class="sn-sum-label">Closed</span>
						<span class="sn-sum-val">${closed}</span>
					</div>
					<div class="sn-sum-item">
						<span class="sn-sum-label">Wins</span>
						<span class="sn-sum-val sn-pos">${wins}</span>
					</div>
					<div class="sn-sum-item">
						<span class="sn-sum-label">Win rate</span>
						<span class="sn-sum-val ${wr != null && wr >= 50 ? 'sn-pos' : ''}">${wr != null ? `${wr}%` : '—'}</span>
					</div>
					<div class="sn-sum-item">
						<span class="sn-sum-label">Realized PnL</span>
						<span class="sn-sum-val ${clr(pnlSol)}">${fmtSol(pnlSol)}</span>
					</div>
				</div>
				<div class="sn-section-head" style="margin-top:0">Open positions</div>
				<div class="sn-agent-pos" data-agent-positions="${esc(s.agent_id)}">
					<div class="sn-agent-pos-empty">Loading positions…</div>
				</div>
				${stratForm(s)}
			</div>
			<div class="sn-pane" data-pane="money" data-agent="${esc(s.agent_id)}" hidden>
				<div class="sn-money-host" data-money-host="${esc(s.agent_id)}"></div>
			</div>
		</div>
	</div>`;
}

function stratForm(s) {
	const toLamSol = (l) => (BigInt(l || '0') > 0n ? lamportsToSol(l).toFixed(3) : '');
	const toLamSolNum = (l) => (l != null && BigInt(l || '0') > 0n ? lamportsToSol(l) : '');

	return `<form class="sn-form" data-strat-form="${esc(s.agent_id)}">
		<div class="sn-section-head">Trigger & Sizing</div>
		<div class="sn-field">
			<label>Trigger</label>
			<select name="trigger" aria-label="Trigger">
				<option value="new_mint" ${s.trigger === 'new_mint' || (!s.trigger || (s.trigger !== 'first_claim' && s.trigger !== 'intel_confirmed' && s.trigger !== 'prelaunch_radar' && s.trigger !== 'alpha_hunt')) ? 'selected' : ''}>New mint — snipe every launch</option>
				<option value="first_claim" ${s.trigger === 'first_claim' ? 'selected' : ''}>First claim — creator claims for first time</option>
				<option value="intel_confirmed" ${s.trigger === 'intel_confirmed' ? 'selected' : ''}>Intel confirmed — buy after Coin Intelligence verdict</option>
				<option value="prelaunch_radar" ${s.trigger === 'prelaunch_radar' ? 'selected' : ''}>Pre-launch radar — pre-arm on a proven creator's launch precursor</option>
				<option value="alpha_hunt" ${s.trigger === 'alpha_hunt' ? 'selected' : ''}>Alpha Hunt — buy on smart-money + organic signal score</option>
			</select>
			<span class="sn-hint">Alpha Hunt scores each coin after the observation window using smart-money wallet count, organic score, quality, and narrative match — only buys when the composite score clears the thresholds you set.</span>
			<span class="sn-hint">Pre-launch radar watches proven creator + smart-money wallets on-chain and pre-arms the snipe the instant one funds a fresh deploy wallet or submits a pump.fun create — at block-0, on signal not luck.</span>
			<span class="sn-hint">Intel confirmed waits for the observation window (~60s) and only buys if the coin passes bundle detection and quality analysis.</span>
			<span class="sn-hint">When the agent enters a position.</span>
		</div>
		<div class="sn-field">
			<label>Buy delay (ms)</label>
			<input name="buy_delay_ms" type="number" min="0" max="600000" value="${s.buy_delay_ms || 0}" aria-label="Buy delay in milliseconds" />
			<span class="sn-hint">Pause before buying. Currently ${fmtDelayMs(s.buy_delay_ms)}.</span>
		</div>
		<div class="sn-field">
			<label>Daily budget (SOL)</label>
			<input name="daily_budget_sol" type="number" min="0" step="0.001" value="${toLamSol(s.daily_budget_lamports)}" aria-label="Daily budget in SOL" />
			<span class="sn-hint">Max SOL to spend per calendar day.</span>
		</div>
		<div class="sn-field">
			<label>Per-trade size (SOL)</label>
			<input name="per_trade_sol" type="number" min="0" step="0.001" value="${toLamSol(s.per_trade_lamports)}" aria-label="Per-trade size in SOL" />
			<span class="sn-hint">SOL per snipe. Must be ≤ daily budget.</span>
		</div>
		<div class="sn-field">
			<label>Max concurrent positions</label>
			<input name="max_concurrent_positions" type="number" min="1" max="50" value="${s.max_concurrent_positions || 1}" aria-label="Max concurrent positions" />
		</div>
		<div class="sn-field">
			<label>Slippage (bps)</label>
			<input name="slippage_bps" type="number" min="0" max="5000" value="${s.slippage_bps || 500}" aria-label="Slippage in basis points" />
			<span class="sn-hint">100 bps = 1%.</span>
		</div>

		<div class="sn-section-head">Execution & Safety</div>
		<div class="sn-field">
			<label>MEV tip mode</label>
			<select name="mev_tip_mode" aria-label="MEV tip mode">
				<option value="off" ${(!s.mev_tip_mode || s.mev_tip_mode === 'off') ? 'selected' : ''}>Off — protected single tx, no tip</option>
				<option value="economy" ${s.mev_tip_mode === 'economy' ? 'selected' : ''}>Economy — Jito bundle, small tip near the floor</option>
				<option value="turbo" ${s.mev_tip_mode === 'turbo' ? 'selected' : ''}>Turbo — Jito bundle, aggressive tip for first-block</option>
			</select>
			<span class="sn-hint">A Jito tip is real SOL leaving the wallet — it counts against your daily budget and is recorded in the custody ledger. Off uses the protected route with a dynamic priority fee. Falls back to protected automatically on devnet or when Jito is unreachable.</span>
		</div>
		<div class="sn-field">
			<label>Firewall level</label>
			<select name="firewall_level" aria-label="Rug/honeypot firewall level">
				<option value="block" ${(!s.firewall_level || s.firewall_level === 'block') ? 'selected' : ''}>Block — abort the snipe on a block verdict (recommended)</option>
				<option value="warn" ${s.firewall_level === 'warn' ? 'selected' : ''}>Warn — record the verdict but proceed (raw speed)</option>
				<option value="off" ${s.firewall_level === 'off' ? 'selected' : ''}>Off — skip the safety simulation</option>
			</select>
			<span class="sn-hint">A real on-chain simulated buy→sell round-trip + authority audit before every buy. Block is the safe default.</span>
		</div>

		<div class="sn-section-head">Exit Rules</div>
		<div class="sn-field">
			<label>Take profit (%)</label>
			<input name="take_profit_pct" type="number" min="1" step="1" value="${s.take_profit_pct != null ? s.take_profit_pct : ''}" placeholder="e.g. 50" aria-label="Take profit percent" />
			<span class="sn-hint">Sell when up this %. Leave blank to hold.</span>
		</div>
		<div class="sn-field">
			<label>Stop loss (%) *</label>
			<input name="stop_loss_pct" type="number" min="1" max="99" step="1" value="${s.stop_loss_pct != null ? s.stop_loss_pct : 30}" required aria-label="Stop loss percent" />
		</div>
		<div class="sn-field">
			<label>Trailing stop (%)</label>
			<input name="trailing_stop_pct" type="number" min="1" step="1" value="${s.trailing_stop_pct != null ? s.trailing_stop_pct : ''}" placeholder="e.g. 20" aria-label="Trailing stop percent" />
			<span class="sn-hint">Sell when peak drops by this %. Optional.</span>
		</div>
		<div class="sn-field">
			<label>Max hold time (seconds)</label>
			<input name="max_hold_seconds" type="number" min="30" max="86400" value="${s.max_hold_seconds || 1800}" aria-label="Max hold time in seconds" />
			<span class="sn-hint">Force-exit after this. Currently ${fmtHold(s.max_hold_seconds)}.</span>
		</div>

		<div class="sn-section-head">Entry Filters</div>
		<div class="sn-field">
			<label>Min market cap (USD)</label>
			<input name="min_market_cap_usd" type="number" min="0" value="${s.min_market_cap_usd != null ? s.min_market_cap_usd : ''}" placeholder="any" aria-label="Min market cap in USD" />
		</div>
		<div class="sn-field">
			<label>Max market cap (USD)</label>
			<input name="max_market_cap_usd" type="number" min="0" value="${s.max_market_cap_usd != null ? s.max_market_cap_usd : ''}" placeholder="any" aria-label="Max market cap in USD" />
		</div>
		<div class="sn-field">
			<label>Min creator graduated coins</label>
			<input name="min_creator_graduated" type="number" min="0" value="${s.min_creator_graduated != null ? s.min_creator_graduated : ''}" placeholder="any" aria-label="Min creator graduated coins" />
			<span class="sn-hint">Only launch from creators with this many graduates.</span>
		</div>
		<div class="sn-field">
			<label>Max creator total launches</label>
			<input name="max_creator_launches" type="number" min="1" value="${s.max_creator_launches != null ? s.max_creator_launches : ''}" placeholder="any" aria-label="Max creator total launches" />
			<span class="sn-hint">Skip serial launchers with too many coins.</span>
		</div>
		<div class="sn-field">
			<label>Require social links</label>
			<select name="require_socials" aria-label="Require social links">
				<option value="false" ${!s.require_socials ? 'selected' : ''}>No — any launch</option>
				<option value="true" ${s.require_socials ? 'selected' : ''}>Yes — Twitter/Telegram required</option>
			</select>
		</div>
		<div class="sn-field">
			<label>Require SOL quote</label>
			<select name="require_sol_quote" aria-label="Require SOL quote">
				<option value="true" ${s.require_sol_quote !== false ? 'selected' : ''}>Yes (recommended)</option>
				<option value="false" ${s.require_sol_quote === false ? 'selected' : ''}>No</option>
			</select>
		</div>
		<div class="sn-field">
			<label>Min Oracle conviction (0–100)</label>
			<input name="min_oracle_score" type="number" step="1" min="0" max="100" value="${s.min_oracle_score != null ? s.min_oracle_score : ''}" placeholder="any" aria-label="Min Oracle conviction score, 0 to 100" />
			<span class="sn-hint">Skip the snipe if Oracle conviction is below this. Leave blank to snipe regardless of conviction. New mints without a score are allowed through.</span>
		</div>

		${s.trigger === 'first_claim' ? firstClaimFields(s) : ''}
		${s.trigger === 'intel_confirmed' ? intelFields(s) : ''}
		${s.trigger === 'prelaunch_radar' ? radarFields(s) : ''}
		${s.trigger === 'alpha_hunt' ? alphaHuntFields(s) : ''}

		<div class="sn-section-head">Notifications</div>
		<div class="sn-field sn-field-full">
			<label>Telegram chat ID (optional)</label>
			<input name="telegram_chat_id" type="text" inputmode="numeric" value="${s.telegram_chat_id || ''}" placeholder="e.g. 123456789" autocomplete="off" aria-label="Telegram chat ID (optional)" />
			<span class="sn-hint">Get buy/sell alerts in your own Telegram chat. Message <a class="sn-link" href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> to find your chat ID, then forward its reply here. Leave blank to use the platform ops channel.</span>
		</div>

		<div class="sn-save-row">
			<button type="submit" class="sn-btn primary" data-save="${esc(s.agent_id)}">Save changes</button>
			<span class="sn-save-msg" data-msg="${esc(s.agent_id)}"></span>
		</div>
	</form>`;
}

function radarFields(s) {
	return `
		<div class="sn-section-head">Pre-Launch Radar Gates</div>
		<div class="sn-field">
			<label>Min creator graduated</label>
			<input name="min_creator_graduated_radar" type="number" min="0" max="100000" value="${s.min_creator_graduated_radar != null ? s.min_creator_graduated_radar : ''}" placeholder="worker default (2)" aria-label="Min creator graduated coins for the radar" />
			<span class="sn-hint">Only pre-arm when the triggering creator has graduated at least this many coins. Blank uses the worker default.</span>
		</div>
		<div class="sn-field">
			<label>Max precursor age (ms)</label>
			<input name="radar_max_age_ms" type="number" min="1000" max="3600000" value="${s.radar_max_age_ms != null ? s.radar_max_age_ms : ''}" placeholder="120000" aria-label="Max precursor age in milliseconds" />
			<span class="sn-hint">Skip a precursor first seen older than this — never chase a launch the floor already moved past.</span>
		</div>
		<div class="sn-field">
			<label>Require smart-money funder</label>
			<select name="require_smart_money_funder" aria-label="Require a proven smart-money funder">
				<option value="false" ${!s.require_smart_money_funder ? 'selected' : ''}>No — any proven creator</option>
				<option value="true" ${s.require_smart_money_funder ? 'selected' : ''}>Yes — funder must be proven smart money</option>
			</select>
			<span class="sn-hint">Demand the triggering wallet (or the funder of the fresh deploy wallet) be a proven smart-money address before pre-arming.</span>
		</div>`;
}

function firstClaimFields(s) {
	const toLamSolOptional = (l) => (l != null ? lamportsToSol(l).toFixed(4) : '');
	return `
		<div class="sn-section-head">First-Claim Filters</div>
		<div class="sn-field">
			<label>Min claim size (SOL)</label>
			<input name="min_claim_lamports_sol" type="number" min="0" step="0.001" value="${toLamSolOptional(s.min_claim_lamports)}" placeholder="any" aria-label="Min claim size in SOL" />
			<span class="sn-hint">Only trigger if the creator claimed this much SOL.</span>
		</div>
		<div class="sn-field">
			<label>Max claim size (SOL)</label>
			<input name="max_claim_lamports_sol" type="number" min="0" step="0.001" value="${toLamSolOptional(s.max_claim_lamports)}" placeholder="any" aria-label="Max claim size in SOL" />
		</div>
		<div class="sn-field">
			<label>Max claim age (seconds)</label>
			<input name="first_claim_max_age_seconds" type="number" min="1" max="86400" value="${s.first_claim_max_age_seconds != null ? s.first_claim_max_age_seconds : ''}" placeholder="300" aria-label="Max claim age in seconds" />
			<span class="sn-hint">Skip if the claim tx is older than this.</span>
		</div>`;
}

function intelFields(s) {
	const cats = Array.isArray(s.allowed_categories) ? s.allowed_categories.join(', ') : '';
	return `
		<div class="sn-section-head">Coin Intelligence Filters</div>
		<div class="sn-field">
			<label>Min quality score (0–100)</label>
			<input name="min_quality_score" type="number" step="1" min="0" max="100" value="${s.min_quality_score != null ? s.min_quality_score : ''}" placeholder="e.g. 60" aria-label="Min quality score, 0 to 100" />
			<span class="sn-hint">Overall quality composite. 0 = any, 100 = best only. Higher = fewer but cleaner entries.</span>
		</div>
		<div class="sn-field">
			<label>Max bundle score (0–1)</label>
			<input name="max_bundle_score" type="number" step="0.05" min="0" max="1" value="${s.max_bundle_score != null ? s.max_bundle_score : ''}" placeholder="e.g. 0.5" aria-label="Max bundle score, 0 to 1" />
			<span class="sn-hint">Bundle likelihood from wallet graph analysis. 0 = no bundles tolerated, 1 = allow all.</span>
		</div>
		<div class="sn-field">
			<label>Max top-wallet concentration (%)</label>
			<input name="max_concentration_top1" type="number" step="1" min="0" max="100" value="${s.max_concentration_top1 != null ? s.max_concentration_top1 : ''}" placeholder="e.g. 20" aria-label="Max top-wallet concentration percent" />
			<span class="sn-hint">Skip if the single largest holder owns more than this % of supply.</span>
		</div>
		<div class="sn-field">
			<label>Avoid dev dump</label>
			<select name="avoid_dev_dump" aria-label="Avoid dev dump">
				<option value="true" ${s.avoid_dev_dump !== false ? 'selected' : ''}>Yes — skip if dev sold (recommended)</option>
				<option value="false" ${s.avoid_dev_dump === false ? 'selected' : ''}>No — allow dev sells</option>
			</select>
		</div>
		<div class="sn-field">
			<label>Allowed categories (comma-separated)</label>
			<input name="allowed_categories" type="text" value="${esc(cats)}" placeholder="e.g. meme, animal, culture (blank = allow all)" aria-label="Allowed categories, comma-separated" />
			<span class="sn-hint">Only snipe coins classified into these categories. Leave blank to allow all.</span>
		</div>`;
}

function alphaHuntFields(s) {
	const keywords = Array.isArray(s.alpha_narrative_keywords) ? s.alpha_narrative_keywords.join(', ') : '';
	return `
		<div class="sn-section-head">Alpha Hunt Filters</div>
		<div class="sn-field">
			<label>Min smart-money wallets</label>
			<input name="alpha_min_smart_money" type="number" step="1" min="0" max="20" value="${s.alpha_min_smart_money != null ? s.alpha_min_smart_money : ''}" placeholder="e.g. 2" aria-label="Min smart-money wallet count" />
			<span class="sn-hint">Proven wallets (from the smart-money list) that must be buying. Leave blank to ignore.</span>
		</div>
		<div class="sn-field">
			<label>Min quality score (0–100)</label>
			<input name="alpha_min_quality_score" type="number" step="1" min="0" max="100" value="${s.alpha_min_quality_score != null ? s.alpha_min_quality_score : ''}" placeholder="e.g. 60" aria-label="Alpha hunt min quality score" />
			<span class="sn-hint">Minimum intel quality composite. Score &ge; 70 earns +30 points toward the 40-point pass threshold.</span>
		</div>
		<div class="sn-field">
			<label>Min organic score (0–100)</label>
			<input name="alpha_min_organic_score" type="number" step="1" min="0" max="100" value="${s.alpha_min_organic_score != null ? s.alpha_min_organic_score : ''}" placeholder="e.g. 50" aria-label="Alpha hunt min organic score" />
			<span class="sn-hint">Filters bot/coordinated launches. 0–100 (internally 0–1, multiplied by 100 for display). Score &ge; 0.7 earns +15 points.</span>
		</div>
		<div class="sn-field">
			<label>Max market cap (USD)</label>
			<input name="alpha_max_mcap_usd" type="number" step="100" min="0" value="${s.alpha_max_mcap_usd != null ? s.alpha_max_mcap_usd : ''}" placeholder="e.g. 5000" aria-label="Alpha hunt max market cap USD" />
			<span class="sn-hint">Only enter below this cap. Leave blank for no upper limit.</span>
		</div>
		<div class="sn-field">
			<label>Narrative keywords (comma-separated)</label>
			<input name="alpha_narrative_keywords" type="text" value="${esc(keywords)}" placeholder="e.g. ai, dog, meme, pepe" aria-label="Alpha hunt narrative keywords" />
			<span class="sn-hint">Any match passes the keyword gate. Leave blank to ignore narratives entirely.</span>
		</div>`;
}

// ── Live positions ────────────────────────────────────────────────────────────

function livePositionsSection() {
	const ghostBtn = 'font-size:12px;padding:5px 12px;border-radius:var(--nxt-radius-sm);border:1px solid var(--nxt-stroke);text-decoration:none;color:var(--nxt-ink);';
	return `<div class="sn-live">
		<div class="sn-live-head">
			<div class="sn-live-title">
				<span class="sn-live-dot connecting"></span>
				Your Live Positions
				<span class="sn-conn-status" id="sn-conn-status" role="status" aria-live="polite">Connecting…</span>
			</div>
			<div class="sn-live-links">
				<a class="sn-btn ghost" style="${ghostBtn}" href="/dashboard/portfolio" title="Full wallet holdings across chains">Portfolio</a>
				<a class="sn-btn ghost" style="${ghostBtn}" href="/dashboard/tokens" title="Pump.fun trading desk — watchlists, scanner, charts">Trading desk</a>
				<a class="sn-btn ghost" style="${ghostBtn}" href="/leaderboard" target="_blank" rel="noopener">Leaderboard ↗</a>
				<a class="sn-btn ghost" style="${ghostBtn}" href="/play/arena" target="_blank" rel="noopener">Sniper Arena ↗</a>
			</div>
		</div>
		<div id="sn-positions" class="sn-pos-list">
			<p class="sn-empty">Connecting…</p>
		</div>
	</div>`;
}

function renderPositions(positions) {
	const el = document.getElementById('sn-positions');
	if (!el) return;
	if (!positions.length) {
		el.innerHTML = emptyStateHTML({
			icon: '',
			compact: true,
			live: true,
			title: 'No open positions right now',
			body: 'When an armed agent buys, its position appears here live with real-time PnL — no refresh needed.',
		});
		return;
	}
	el.innerHTML = positions.map(posRow).join('');
}

function posRow(p) {
	const pnlSol = p.unrealized_pnl_sol;
	const pnlPct = p.unrealized_pct;
	const pnlStr = pnlSol != null
		? `<span class="${clr(pnlSol)}">${pnlSol >= 0 ? '+' : ''}${fmtSol(pnlSol)}${pnlPct != null ? ` · ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}</span>`
		: '—';
	const links = [
		p.buy_url ? `<a class="sn-pos-link" href="${esc(p.buy_url)}" target="_blank" rel="noopener">Solscan ↗</a>` : '',
		p.mint ? `<a class="sn-pos-link" href="${pumpUrl(p.mint)}" target="_blank" rel="noopener">pump.fun ↗</a>` : '',
	].filter(Boolean).join('');
	const sym = p.symbol || p.mint?.slice(0, 8) || 'this position';
	// One-tap manual exit: sell the agent's full holding of this mint now, at a
	// real price, via /api/sniper/close (the same executeSell the worker uses).
	// Only a fully-open position with a known id can be force-closed.
	const sellBtn = (p.id && p.status === 'open')
		? `<button class="sn-pos-sell" data-action="sell-now" data-pos="${esc(p.id)}" data-agent="${esc(p.agent_id || '')}" data-mint="${esc(p.mint || '')}" data-net="${esc(p.network || 'mainnet')}" data-sym="${esc(sym)}" title="Sell this position now from the agent wallet">Sell now</button>`
		: '';
	const mintAttr = p.mint ? ` data-oracle-mint="${esc(p.mint)}"` : '';
	// The symbol itself deep-links to the coin detail page (score, holders, trade
	// tape) — the Oracle badge only renders for scored coins, so it can't be the
	// only way in.
	const symHtml = p.mint
		? `<a class="sn-coin-link" href="/oracle/coin/${encodeURIComponent(p.mint)}" title="Open coin detail — conviction, holders, live trades">${esc(p.symbol || p.mint.slice(0, 8))}</a>`
		: esc(p.symbol || '—');
	return `<div class="sn-pos-row"${mintAttr}>
		<div class="sn-pos-info">
			<div class="sn-pos-sym">${symHtml}</div>
			<div class="sn-pos-sub">${esc(p.agent_name || '')}${p.opened_at ? ` · opened ${relTime(p.opened_at)}` : ''}</div>
			${execReadout(p)}
		</div>
		<div class="sn-pos-pnl">${pnlStr}</div>
		<span class="sn-pos-oracle"></span>
		<div class="sn-pos-actions">${sellBtn}${links}</div>
	</div>`;
}

const SN_TIER_COLOR = { prime: '#c084fc', strong: '#34d399', lean: '#fbbf24', watch: '#94a3b8', avoid: '#f87171' };

async function enrichPositionOracle() {
	// Scan the whole page, not just the global list — per-card position blocks
	// carry data-oracle-mint too. The hasChildNodes guard keeps repeats cheap.
	const el = document.getElementById('sn-root');
	if (!el) return;
	const rows = el.querySelectorAll('[data-oracle-mint]');
	if (!rows.length) return;
	const mints = [...new Set([...rows].map((r) => r.dataset.oracleMint).filter(Boolean))];
	if (!mints.length) return;
	try {
		const r = await fetch(`/api/oracle/batch?mints=${mints.map(encodeURIComponent).join(',')}&network=mainnet`);
		if (!r.ok) return;
		const { results = {} } = await r.json();
		for (const row of rows) {
			const mint = row.dataset.oracleMint;
			const d = results[mint];
			if (!d || d.score == null) continue;
			const badge = row.querySelector('.sn-pos-oracle');
			if (!badge || badge.hasChildNodes()) continue;
			const color = SN_TIER_COLOR[d.tier] || '#94a3b8';
			badge.innerHTML = `<a class="sn-ob" href="/oracle/coin/${encodeURIComponent(mint)}" title="Oracle conviction: ${d.score} (${d.tier})">
				<span class="sn-ob-score" style="color:${color}">${d.score}</span>
				<span class="sn-ob-tier" style="color:${color}">${d.tier}</span>
			</a>`;
		}
	} catch { /* non-fatal */ }
}

// ── Trade history ─────────────────────────────────────────────────────────────

const EXIT_TAG = {
	take_profit: ['tp', 'Take profit'],
	stop_loss:   ['sl', 'Stop loss'],
	trailing_stop: ['sl', 'Trailing stop'],
	timeout:     ['', 'Timeout'],
	kill_switch: ['', 'Kill switch'],
	manual:      ['', 'Manual'],
};

function histRow(t) {
	const pnlCls = t.pnl_sol > 0 ? 'sn-pos' : t.pnl_sol < 0 ? 'sn-neg' : '';
	const pnlStr = t.pnl_sol != null ? `<span class="${pnlCls} sn-hist-mono">${fmtSol(t.pnl_sol)}</span>` : '—';
	const pctStr = t.pnl_pct != null ? `<span class="${pnlCls} sn-hist-mono">${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(1)}%</span>` : '—';
	const [tagCls, tagLabel] = EXIT_TAG[t.exit_reason] || ['', t.exit_reason || '—'];
	const entrySol = t.entry_sol != null ? `<span class="sn-hist-mono">${fmtSol(t.entry_sol)}</span>` : '—';
	const links = [
		t.buy_url ? `<a class="sn-hist-link" href="${esc(t.buy_url)}" target="_blank" rel="noopener">buy ↗</a>` : '',
		t.sell_url ? `<a class="sn-hist-link" href="${esc(t.sell_url)}" target="_blank" rel="noopener">sell ↗</a>` : '',
	].filter(Boolean).join(' · ');
	const holdMs = t.opened_at && t.closed_at
		? new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime()
		: null;
	const holdStr = holdMs != null ? holdDuration(holdMs) : '—';
	const symHtml = t.mint
		? `<a class="sn-coin-link" href="/oracle/coin/${encodeURIComponent(t.mint)}" title="Open coin detail — conviction, holders, live trades">${esc(t.symbol || t.mint.slice(0, 8))}</a>`
		: esc(t.symbol || '—');
	return `<tr class="sn-hist-row">
		<td>
			<div class="sn-hist-sym">${symHtml}</div>
			<div class="sn-hist-agent">${esc(t.agent_name || '')}</div>
		</td>
		<td class="r">${entrySol}</td>
		<td class="r">${pnlStr}</td>
		<td class="r hide-mobile">${pctStr}</td>
		<td class="r hide-mobile"><span class="sn-hist-mono">${holdStr}</span></td>
		<td class="r"><span class="sn-hist-tag ${tagCls}">${esc(tagLabel)}</span></td>
		<td class="r hide-mobile">${links || '—'}</td>
	</tr>`;
}

function holdDuration(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function drawPnlChart(canvas, points) {
	if (!canvas || points.length < 2) return;
	const dpr = window.devicePixelRatio || 1;
	const W = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 400;
	const H = 90;
	canvas.width = W * dpr;
	canvas.height = H * dpr;
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);

	const PAD = { top: 8, right: 12, bottom: 8, left: 4 };
	const cw = W - PAD.left - PAD.right;
	const ch = H - PAD.top - PAD.bottom;

	const vals = points.map((p) => p.v);
	const times = points.map((p) => p.t);
	const minV = Math.min(0, ...vals);
	const maxV = Math.max(0, ...vals);
	const rangeV = maxV - minV || 1;
	const minT = times[0];
	const maxT = times[times.length - 1];
	const rangeT = maxT - minT || 1;

	const toX = (t) => PAD.left + ((t - minT) / rangeT) * cw;
	const toY = (v) => PAD.top + ch - ((v - minV) / rangeV) * ch;

	const finalVal = vals[vals.length - 1];
	const lineColor = finalVal >= 0 ? '#34d399' : '#f87171';
	const fillColor = finalVal >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)';

	// zero line
	const zeroY = toY(0);
	ctx.strokeStyle = 'rgba(255,255,255,0.08)';
	ctx.lineWidth = 1;
	ctx.setLineDash([3, 3]);
	ctx.beginPath();
	ctx.moveTo(PAD.left, zeroY);
	ctx.lineTo(PAD.left + cw, zeroY);
	ctx.stroke();
	ctx.setLineDash([]);

	// fill under curve
	ctx.beginPath();
	ctx.moveTo(toX(times[0]), zeroY);
	ctx.lineTo(toX(times[0]), toY(vals[0]));
	for (let i = 1; i < points.length; i++) {
		const xMid = (toX(times[i - 1]) + toX(times[i])) / 2;
		ctx.bezierCurveTo(xMid, toY(vals[i - 1]), xMid, toY(vals[i]), toX(times[i]), toY(vals[i]));
	}
	ctx.lineTo(toX(times[times.length - 1]), zeroY);
	ctx.closePath();
	ctx.fillStyle = fillColor;
	ctx.fill();

	// line
	ctx.beginPath();
	ctx.moveTo(toX(times[0]), toY(vals[0]));
	for (let i = 1; i < points.length; i++) {
		const xMid = (toX(times[i - 1]) + toX(times[i])) / 2;
		ctx.bezierCurveTo(xMid, toY(vals[i - 1]), xMid, toY(vals[i]), toX(times[i]), toY(vals[i]));
	}
	ctx.strokeStyle = lineColor;
	ctx.lineWidth = 2;
	ctx.lineJoin = 'round';
	ctx.stroke();

	// final dot
	ctx.beginPath();
	ctx.arc(toX(times[times.length - 1]), toY(vals[vals.length - 1]), 3.5, 0, 2 * Math.PI);
	ctx.fillStyle = lineColor;
	ctx.fill();
}

let _histLoading = false;
let _histLimit = 25;

async function loadTradeHistory(root, append = false) {
	if (_histLoading) return;
	const mount = root.querySelector('#sn-hist-mount');
	if (!mount) return;
	_histLoading = true;
	if (!append) {
		mount.innerHTML = `<div class="sn-hist"><div class="sn-hist-head"><h3>Trade History</h3></div><div class="sn-empty" style="padding:24px 18px">Loading…</div></div>`;
	}
	try {
		const data = await get(`/api/sniper/history?limit=${_histLimit}`);
		const trades = data.trades || [];
		if (!trades.length) {
			mount.innerHTML = `<div class="sn-hist"><div class="sn-hist-head"><h3>Trade History</h3></div><div class="sn-empty" style="padding:24px 18px">No closed trades yet. Your completed snipes appear here.</div></div>`;
			return;
		}
		const hasMore = trades.length >= _histLimit;
		const sorted = [...trades].sort((a, b) => new Date(a.closed_at || 0) - new Date(b.closed_at || 0));
		const cumPoints = [];
		let running = 0;
		for (const t of sorted) {
			if (t.pnl_sol != null) { running += t.pnl_sol; cumPoints.push({ t: new Date(t.closed_at).getTime(), v: running }); }
		}
		const totalPnl = running;
		const pnlClass = totalPnl > 0 ? 'sn-pos' : totalPnl < 0 ? 'sn-neg' : '';
		const pnls = trades.map((t) => t.pnl_sol).filter((v) => v != null);
		const best = pnls.length ? Math.max(...pnls) : null;
		const worst = pnls.length ? Math.min(...pnls) : null;
		const bestWorst = pnls.length
			? `<span class="${best >= 0 ? 'sn-pos' : 'sn-neg'}">Best ${best >= 0 ? '+' : ''}${fmtSol(best).trim()}</span> · <span class="${worst >= 0 ? 'sn-pos' : 'sn-neg'}">Worst ${worst >= 0 ? '+' : ''}${fmtSol(worst).trim()}</span>`
			: '';
		const chartHtml = cumPoints.length >= 2
			? `<div class="sn-chart-wrap">
				<div class="sn-chart-head">
					<span class="sn-chart-label">Cumulative PnL</span>
					<span class="sn-chart-val ${pnlClass}">${totalPnl >= 0 ? '+' : ''}${fmtSol(totalPnl)}</span>
				</div>
				<canvas class="sn-chart-canvas" id="sn-pnl-canvas" height="90" role="img" aria-label="Cumulative PnL line chart, ${cumPoints.length} closed trades, current ${totalPnl >= 0 ? '+' : ''}${fmtSol(totalPnl)}"></canvas>
			</div>` : '';
		mount.innerHTML = `
		<div class="sn-hist">
			<div class="sn-hist-head">
				<h3>Trade History</h3>
				<span style="font-size:12px;color:var(--nxt-ink-faint)">${trades.length} closed trade${trades.length !== 1 ? 's' : ''}${bestWorst ? ` · ${bestWorst}` : ''}</span>
			</div>
			${chartHtml}
			<div style="overflow-x:auto">
				<table class="sn-hist-table">
					<thead>
						<tr>
							<th>Coin</th>
							<th class="r">Entry</th>
							<th class="r">PnL</th>
							<th class="r hide-mobile">PnL %</th>
							<th class="r hide-mobile">Hold</th>
							<th class="r">Exit</th>
							<th class="r hide-mobile">Proof</th>
						</tr>
					</thead>
					<tbody>${trades.map(histRow).join('')}</tbody>
				</table>
			</div>
			${hasMore ? `<button class="sn-hist-more" id="sn-hist-more">Load more</button>` : ''}
		</div>`;
		if (cumPoints.length >= 2) drawPnlChart(mount.querySelector('#sn-pnl-canvas'), cumPoints);
		if (hasMore) {
			mount.querySelector('#sn-hist-more')?.addEventListener('click', () => {
				_histLimit += 25;
				loadTradeHistory(root, false);
			});
		}
	} catch {
		mount.innerHTML = `<div class="sn-hist"><div class="sn-hist-head"><h3>Trade History</h3></div>${errorStateHTML({ title: "Couldn't load trade history", body: 'Your closed snipes will show here once the history service responds.' })}</div>`;
		mount.querySelector('[data-sk-retry]')?.addEventListener('click', () => loadTradeHistory(root, false));
	} finally {
		_histLoading = false;
	}
}

// ── New strategy CTA ──────────────────────────────────────────────────────────

function newStrategyCta() {
	const armedIds = new Set(_strategies.map((s) => s.agent_id));
	const unarmed = _agents.filter((a) => !armedIds.has(a.id));
	if (!unarmed.length && _strategies.length > 0) return '';
	return `<div class="sn-new">
		<div class="sn-new-text">
			<b>Arm another agent</b><br>
			Select an agent and set its budget to let it snipe pump.fun launches autonomously. Trades come from the agent's own wallet.
		</div>
		<button class="sn-btn primary" id="sn-arm-btn">Arm an agent +</button>
	</div>`;
}

// ── Wire events ───────────────────────────────────────────────────────────────

function wireEvents(root) {
	// Card expand/collapse
	root.addEventListener('click', (e) => {
		// Sub-tab switch (Strategy ↔ Money Studio). Checked before the card-head
		// toggle so it never collapses the card, and before the action handlers so
		// money-panel clicks (handled by the mounted Money Studio itself) fall through.
		const subtab = e.target.closest('[data-subtab]');
		if (subtab) { switchSubtab(subtab); return; }

		// KPI strip → jump to the section backing the number
		const jump = e.target.closest('[data-jump]');
		if (jump) {
			document.querySelector(jump.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}

		const retryMoney = e.target.closest('[data-action="retry-money"]');
		if (retryMoney) {
			const host = retryMoney.closest('.sn-pane')?.querySelector('[data-money-host]');
			if (host) { host.dataset.mounted = ''; mountAgentMoney(retryMoney.dataset.agent, host); }
			return;
		}

		const head = e.target.closest('[data-toggle="card"]');
		if (head) {
			const open = head.closest('.sn-card')?.classList.toggle('open');
			head.setAttribute('aria-expanded', open ? 'true' : 'false');
			return;
		}

		// Toggle enabled
		const toggleEn = e.target.closest('[data-action="toggle-enabled"]');
		if (toggleEn) { toggleEnabled(toggleEn, root); return; }

		// Toggle kill switch
		const toggleKill = e.target.closest('[data-action="toggle-kill"]');
		if (toggleKill) { toggleKill_(toggleKill, root); return; }

		// One-tap manual sell of an open position
		const sellBtn = e.target.closest('[data-action="sell-now"]');
		if (sellBtn) { sellNow(sellBtn, root); return; }

		// Arm btn
		if (e.target.id === 'sn-arm-btn') { openArmModal(root); return; }
	});

	// Keyboard operability for the collapsible card head (role="button").
	// Enter/Space toggle it; Space is prevented from scrolling the page.
	root.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
		const head = e.target.closest('[data-toggle="card"]');
		if (!head || head !== e.target) return;
		e.preventDefault();
		const open = head.closest('.sn-card')?.classList.toggle('open');
		head.setAttribute('aria-expanded', open ? 'true' : 'false');
	});

	// Form submits
	root.addEventListener('submit', async (e) => {
		const form = e.target.closest('[data-strat-form]');
		if (!form) return;
		e.preventDefault();
		await saveForm(form, root);
	});
}

// ── Embedded Money Studio (Wallet · Trading Brain · Pricing · Earnings) ─────────
//
// The per-agent Money Studio from /agent-studio#money is reused verbatim here:
// each strategy card's "Money Studio" sub-tab lazily mounts the real module against
// a per-agent StudioAdapter. Mounted instances are tracked so we can tear down their
// live balance polls before every re-render (a stale poll would keep hitting the
// wallet API for a card that no longer exists).

const _moneyMounts = new Map(); // agent_id → { adapter, instance, host }

function teardownMoney() {
	for (const { adapter, instance } of _moneyMounts.values()) {
		try { instance?.destroy?.(); } catch { /* noop */ }
		try { adapter?.destroy?.(); } catch { /* noop */ }
	}
	_moneyMounts.clear();
}

function switchSubtab(btn) {
	const agentId = btn.dataset.agent;
	const want = btn.dataset.subtab;
	const body = btn.closest('.sn-card-body');
	if (!body) return;
	body.querySelectorAll('.sn-subtab').forEach((b) => {
		const on = b.dataset.subtab === want;
		b.classList.toggle('active', on);
		b.setAttribute('aria-selected', on ? 'true' : 'false');
	});
	body.querySelectorAll('.sn-pane').forEach((p) => { p.hidden = p.dataset.pane !== want; });
	if (want === 'money') {
		const host = body.querySelector('[data-money-host]');
		if (host && !host.dataset.mounted) mountAgentMoney(agentId, host);
	}
}

async function mountAgentMoney(agentId, host) {
	if (!agentId || !host || host.dataset.mounted) return;
	host.dataset.mounted = '1';
	host.innerHTML = '<div class="sn-money-loading">Loading Money Studio…</div>';
	try {
		// Full record (skills + meta.studio) — the strategy/agents list payloads are
		// trimmed; the Money Studio + Trading Brain read agent.skills and
		// agent.meta.studio.trading, so fetch the decorated record.
		const { agent } = await get(`/api/agents/${encodeURIComponent(agentId)}`);
		if (!agent) throw new Error('Agent not found');
		host.innerHTML = '';
		const adapter = new StudioAdapter(agent);
		const instance = mountMoneyStudio(host, { studio: adapter });
		_moneyMounts.set(agentId, { adapter, instance, host });
	} catch (err) {
		host.dataset.mounted = '';
		host.innerHTML = `<div class="sn-empty" style="padding:24px 16px">Couldn't load Money Studio${err?.message ? ` — ${esc(err.message)}` : ''}. <button class="sn-btn ghost" data-action="retry-money" data-agent="${esc(agentId)}" style="margin-left:8px">Retry</button></div>`;
	}
}

async function toggleEnabled(btn, root) {
	const agentId = btn.dataset.agent;
	const strat = _strategies.find((s) => s.agent_id === agentId);
	if (!strat) return;
	btn.disabled = true;
	try {
		await post('/api/sniper/strategy', { agent_id: agentId, network: strat.network, enabled: !strat.enabled });
		const sn_root = document.getElementById('sn-root');
		if (sn_root) await refresh(sn_root);
	} catch (err) {
		toast(err.message || 'Failed to update strategy');
	} finally {
		btn.disabled = false;
	}
}

async function toggleKill_(btn, root) {
	const agentId = btn.dataset.agent;
	const strat = _strategies.find((s) => s.agent_id === agentId);
	if (!strat) return;
	btn.disabled = true;
	try {
		await post('/api/sniper/strategy', { agent_id: agentId, network: strat.network, kill_switch: !strat.kill_switch });
		const sn_root = document.getElementById('sn-root');
		if (sn_root) await refresh(sn_root);
	} catch (err) {
		toast(err.message || 'Failed to update kill switch');
	} finally {
		btn.disabled = false;
	}
}

async function sellNow(btn, root) {
	const posId = btn.dataset.pos || null;
	const agentId = btn.dataset.agent || null;
	const mint = btn.dataset.mint || null;
	const network = btn.dataset.net || 'mainnet';
	const sym = btn.dataset.sym || 'this position';
	if (!agentId || (!posId && !mint)) return;
	if (!confirm(`Sell ${sym} now?\n\nThe agent will market-sell its full holding of this coin from its own wallet at the current price. This can't be undone.`)) return;

	btn.disabled = true;
	const orig = btn.textContent;
	btn.textContent = 'Selling…';
	try {
		const body = { agent_id: agentId, network };
		if (posId) body.position_id = posId; else body.mint = mint;
		const res = await post('/api/sniper/close', body);
		const d = (res && res.data) || {};
		const pnlStr = d.pnl_sol != null ? ` · ${d.pnl_sol >= 0 ? '+' : ''}${fmtSol(d.pnl_sol).trim()}` : '';
		toast(`${sym} sold${d.simulated ? ' (paper)' : ''}${pnlStr}`);
		// Optimistically drop it from the live map so it disappears immediately,
		// then refresh so KPIs, the strategy summary, and trade history reconcile.
		if (posId) _positionsMap.delete(posId);
		renderOwnedPositions();
		const sn_root = root || document.getElementById('sn-root');
		if (sn_root) await refresh(sn_root);
	} catch (err) {
		const code = err && err.code;
		// 409s mean the worker (or another tab) is already closing/closed it — refresh
		// to show the truth rather than leaving a stale "Sell now" button.
		if (code === 'position_busy' || code === 'already_closed') {
			toast(err.message || 'This position is already closing');
			const sn_root = root || document.getElementById('sn-root');
			if (sn_root) await refresh(sn_root);
			return;
		}
		toast((err && err.message) || 'Sell failed — the position is still open');
		btn.disabled = false;
		btn.textContent = orig;
	}
}

async function saveForm(form, root) {
	const agentId = form.dataset.stratForm;
	const strat = _strategies.find((s) => s.agent_id === agentId);
	if (!strat) return;
	const btn = form.querySelector(`[data-save="${agentId}"]`);
	const msg = form.querySelector(`[data-msg="${agentId}"]`);
	if (btn) btn.disabled = true;
	if (msg) msg.textContent = 'Saving…';

	try {
		const fd = Object.fromEntries(new FormData(form).entries());
		const body = {
			agent_id: agentId,
			network: strat.network,
			trigger: fd.trigger,
			buy_delay_ms: Number(fd.buy_delay_ms) || 0,
			daily_budget_lamports: solToLamports(fd.daily_budget_sol || '0'),
			per_trade_lamports: solToLamports(fd.per_trade_sol || '0'),
			max_concurrent_positions: Number(fd.max_concurrent_positions) || 1,
			slippage_bps: Number(fd.slippage_bps) || 500,
			mev_tip_mode: ['off', 'economy', 'turbo'].includes(fd.mev_tip_mode) ? fd.mev_tip_mode : 'off',
			firewall_level: ['block', 'warn', 'off'].includes(fd.firewall_level) ? fd.firewall_level : 'block',
			take_profit_pct: fd.take_profit_pct !== '' ? Number(fd.take_profit_pct) : null,
			stop_loss_pct: Number(fd.stop_loss_pct) || 30,
			trailing_stop_pct: fd.trailing_stop_pct !== '' ? Number(fd.trailing_stop_pct) : null,
			max_hold_seconds: Number(fd.max_hold_seconds) || 1800,
			min_market_cap_usd: fd.min_market_cap_usd !== '' ? Number(fd.min_market_cap_usd) : null,
			max_market_cap_usd: fd.max_market_cap_usd !== '' ? Number(fd.max_market_cap_usd) : null,
			min_creator_graduated: fd.min_creator_graduated !== '' ? Number(fd.min_creator_graduated) : null,
			max_creator_launches: fd.max_creator_launches !== '' ? Number(fd.max_creator_launches) : null,
			require_socials: fd.require_socials === 'true',
			require_sol_quote: fd.require_sol_quote !== 'false',
			min_oracle_score: fd.min_oracle_score !== '' ? Math.round(Number(fd.min_oracle_score)) : null,
			telegram_chat_id: fd.telegram_chat_id && /^-?[0-9]+$/.test(fd.telegram_chat_id.trim()) ? fd.telegram_chat_id.trim() : null,
		};
		if (fd.trigger === 'first_claim') {
			body.min_claim_lamports = fd.min_claim_lamports_sol !== '' ? solToLamports(fd.min_claim_lamports_sol) : null;
			body.max_claim_lamports = fd.max_claim_lamports_sol !== '' ? solToLamports(fd.max_claim_lamports_sol) : null;
			body.first_claim_max_age_seconds = fd.first_claim_max_age_seconds !== '' ? Number(fd.first_claim_max_age_seconds) : null;
		}
		if (fd.trigger === 'intel_confirmed') {
			body.min_quality_score = fd.min_quality_score !== '' ? Number(fd.min_quality_score) : null;
			body.max_bundle_score = fd.max_bundle_score !== '' ? Number(fd.max_bundle_score) : null;
			body.max_concentration_top1 = fd.max_concentration_top1 !== '' ? Number(fd.max_concentration_top1) : null;
			body.avoid_dev_dump = fd.avoid_dev_dump !== 'false';
			body.allowed_categories = fd.allowed_categories ? fd.allowed_categories.split(',').map((c) => c.trim()).filter(Boolean) : null;
		}
		if (fd.trigger === 'prelaunch_radar') {
			body.min_creator_graduated_radar = fd.min_creator_graduated_radar !== '' ? Number(fd.min_creator_graduated_radar) : null;
			body.radar_max_age_ms = fd.radar_max_age_ms !== '' ? Number(fd.radar_max_age_ms) : null;
			body.require_smart_money_funder = fd.require_smart_money_funder === 'true';
		}
		if (fd.trigger === 'alpha_hunt') {
			body.alpha_min_smart_money = fd.alpha_min_smart_money !== '' ? Math.round(Number(fd.alpha_min_smart_money)) : null;
			body.alpha_min_quality_score = fd.alpha_min_quality_score !== '' ? Math.round(Number(fd.alpha_min_quality_score)) : null;
			body.alpha_min_organic_score = fd.alpha_min_organic_score !== '' ? Number(fd.alpha_min_organic_score) : null;
			body.alpha_max_mcap_usd = fd.alpha_max_mcap_usd !== '' ? Number(fd.alpha_max_mcap_usd) : null;
			body.alpha_narrative_keywords = fd.alpha_narrative_keywords ? fd.alpha_narrative_keywords.split(',').map((k) => k.trim()).filter(Boolean) : null;
		}

		await post('/api/sniper/strategy', body);
		if (msg) { msg.textContent = 'Saved!'; setTimeout(() => { if (msg) msg.textContent = ''; }, 2000); }
		const sn_root = document.getElementById('sn-root');
		if (sn_root) await refresh(sn_root);
	} catch (err) {
		if (msg) msg.textContent = err.message || 'Save failed';
	} finally {
		if (btn) btn.disabled = false;
	}
}

// ── Arm new agent modal ───────────────────────────────────────────────────────

function openArmModal(root) {
	const armedIds = new Set(_strategies.map((s) => s.agent_id));
	const unarmed = _agents.filter((a) => !armedIds.has(a.id));

	// Read preset params passed from Strategy Lab
	const qp = new URLSearchParams(location.search);
	const presetTier  = qp.get('preset_tier') || '';
	const presetScore = qp.get('preset_score') ? Number(qp.get('preset_score')) : null;
	const fromLab     = qp.get('from') === 'strategy-lab';

	const overlay = document.createElement('div');
	overlay.className = 'sn-overlay';
	overlay.innerHTML = `<div class="sn-modal">
		<h2>Arm an agent</h2>
		${fromLab && presetTier ? `<p style="color:var(--nxt-ink-faint);font-size:13px;margin:0 0 14px">Strategy Lab preset: <strong style="color:var(--nxt-accent)">${esc(presetTier)}</strong> conviction filter (min score ${presetScore ?? '—'}).</p>` : ''}
		${!unarmed.length
			? '<p style="color:var(--nxt-ink-faint);font-size:13px">All your agents already have a strategy. Edit their config in the cards above.</p>'
			: `<div class="sn-field" style="margin-bottom:16px">
				<label>Choose agent</label>
				<select id="sn-arm-agent" aria-label="Choose agent">
					<option value="">— select an agent —</option>
					${unarmed.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('')}
				</select>
			</div>
			<div class="sn-field">
				<label>Daily budget (SOL)</label>
				<input id="sn-arm-budget" type="number" min="0.001" step="0.001" value="0.1" aria-label="Daily budget in SOL" />
				<span class="sn-hint">The agent will spend at most this much per day.</span>
			</div>
			<div class="sn-field" style="margin-top:12px">
				<label>Per-trade size (SOL)</label>
				<input id="sn-arm-per-trade" type="number" min="0.001" step="0.001" value="0.01" aria-label="Per-trade size in SOL" />
			</div>
			<div class="sn-field" style="margin-top:12px">
				<label>Min Oracle conviction score (0–100, blank = no filter)</label>
				<input id="sn-arm-oracle" type="number" min="0" max="100" step="1" value="${presetScore != null ? presetScore : ''}" placeholder="e.g. 55 for strong+" aria-label="Min Oracle conviction score, 0 to 100, blank for no filter" />
				<span class="sn-hint">Only enter coins that clear this conviction threshold. Higher = fewer, higher-quality entries.</span>
			</div>`
		}
		<div class="sn-modal-foot">
			<button class="sn-btn ghost" id="sn-arm-cancel">Cancel</button>
			${unarmed.length ? '<button class="sn-btn primary" id="sn-arm-confirm">Arm</button>' : ''}
		</div>
	</div>`;

	document.body.appendChild(overlay);

	overlay.querySelector('#sn-arm-cancel')?.addEventListener('click', () => overlay.remove());
	overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

	overlay.querySelector('#sn-arm-confirm')?.addEventListener('click', async (e) => {
		const agentId  = overlay.querySelector('#sn-arm-agent')?.value;
		const budget   = overlay.querySelector('#sn-arm-budget')?.value;
		const perTrade = overlay.querySelector('#sn-arm-per-trade')?.value;
		const oracleRaw = overlay.querySelector('#sn-arm-oracle')?.value.trim();
		const minOracle = oracleRaw !== '' ? Math.max(0, Math.min(100, Number(oracleRaw))) : null;
		if (!agentId) { toast('Select an agent first'); return; }
		e.target.disabled = true;
		try {
			await post('/api/sniper/strategy', {
				agent_id: agentId,
				network: 'mainnet',
				enabled: false,
				daily_budget_lamports: solToLamports(budget || '0.1'),
				per_trade_lamports: solToLamports(perTrade || '0.01'),
				stop_loss_pct: 30,
				max_hold_seconds: 1800,
				min_oracle_score: minOracle,
			});
			overlay.remove();
			const sn_root = document.getElementById('sn-root');
			if (sn_root) await refresh(sn_root);
			toast('Strategy created — configure it in the card, then arm it.');
		} catch (err) {
			toast(err.message || 'Failed to arm agent');
			e.target.disabled = false;
		}
	});
}

// ── SSE live positions ────────────────────────────────────────────────────────

// The /api/sniper/stream SSE is network-global and capped at 90s per connection,
// and the worker is a separate process — so we (a) seed the owner's open positions
// from the leaderboard snapshot on load, (b) filter the live stream down to the
// caller's own agents, and (c) drive an explicit backoff reconnect with a visible
// connection state instead of relying on the browser's silent auto-retry.

function ownedAgentIds() {
	return new Set(_strategies.map((s) => s.agent_id));
}

function setConn(state, label) {
	const dot = document.querySelector('.sn-live-dot');
	const txt = document.getElementById('sn-conn-status');
	if (dot) dot.className = `sn-live-dot ${state}`;
	if (txt) txt.textContent = label;
}

// Normalize the SSE event shape and the leaderboard snapshot shape into one
// render shape. SSE gives entry_sol/current_sol/pnl_sol/pnl_pct/buy_url/at;
// leaderboard gives entry_sol/current_sol/unrealized_pct/buy_url/at.
function normPos(p) {
	const entry = p.entry_sol != null ? Number(p.entry_sol) : null;
	const current = p.current_sol != null ? Number(p.current_sol) : entry;
	const pnlSol = entry != null && current != null
		? current - entry
		: (p.pnl_sol != null ? Number(p.pnl_sol) : null);
	const pnlPct = p.pnl_pct != null ? Number(p.pnl_pct)
		: p.unrealized_pct != null ? Number(p.unrealized_pct)
		: (entry ? ((current - entry) / entry) * 100 : null);
	return {
		id: p.id,
		agent_id: p.agent_id,
		agent_name: p.agent_name,
		network: p.network || 'mainnet',
		mint: p.mint,
		symbol: p.symbol || p.name,
		status: p.status || 'open',
		entry_sol: entry,
		current_sol: current,
		unrealized_pnl_sol: pnlSol,
		unrealized_pct: pnlPct,
		buy_url: p.buy_url || null,
		opened_at: p.at || p.opened_at || null,
		exec_route: p.exec_route || null,
		tip_lamports: p.tip_lamports != null ? Number(p.tip_lamports) : null,
		priority_fee_microlamports: p.priority_fee_microlamports != null ? Number(p.priority_fee_microlamports) : null,
		landed_ms: p.landed_ms != null ? Number(p.landed_ms) : null,
	};
}

// Render the MEV execution readout for a position/trade: the route badge, the
// Jito tip paid (if any), and the time-to-land. Returns '' when no telemetry
// exists (a pre-engine position or a paper fill with no broadcast).
const EXEC_ROUTE = {
	jito_turbo: { label: 'Jito turbo', cls: 'sn-exec-turbo', title: 'Landed via a Jito bundle with an aggressive tip' },
	jito_economy: { label: 'Jito', cls: 'sn-exec-jito', title: 'Landed via a Jito bundle with an economy tip' },
	protected: { label: 'Protected', cls: 'sn-exec-prot', title: 'Landed via the protected single-tx route (dynamic fee + retry)' },
	simulated: { label: 'Paper', cls: 'sn-exec-sim', title: 'Simulated fill — no broadcast' },
};

function execReadout(p) {
	const route = p.exec_route;
	if (!route) return '';
	const meta = EXEC_ROUTE[route] || { label: route, cls: 'sn-exec-prot', title: 'Execution route' };
	const parts = [`<span class="sn-exec-badge ${meta.cls}" title="${esc(meta.title)}">${esc(meta.label)}</span>`];
	if (p.tip_lamports != null && p.tip_lamports > 0) {
		parts.push(`<span class="sn-exec-meta" title="Jito tip paid">tip ◎${(p.tip_lamports / 1e9).toFixed(5)}</span>`);
	}
	if (p.landed_ms != null && p.landed_ms >= 0) {
		const s = p.landed_ms >= 1000 ? `${(p.landed_ms / 1000).toFixed(1)}s` : `${p.landed_ms}ms`;
		parts.push(`<span class="sn-exec-meta" title="Time to land">${s}</span>`);
	}
	return `<div class="sn-exec">${parts.join('')}</div>`;
}

function renderOwnedPositions() {
	const owned = ownedAgentIds();
	const list = [..._positionsMap.values()]
		.filter((p) => owned.has(p.agent_id) && ['opening', 'open'].includes(p.status))
		.sort((a, b) => new Date(b.opened_at || 0) - new Date(a.opened_at || 0));
	renderPositions(list);
	renderAgentCardPositions(list);
	const kpiOpen = document.querySelector('[data-kpi-open]');
	if (kpiOpen) kpiOpen.textContent = String(list.length);
}

// Mirror each agent's slice of the live stream into its strategy card: the
// "Open positions" block in the expanded pane and the "n open · ±PnL" chip in
// the collapsed head, so a bot's holdings are visible without leaving the card.
function renderAgentCardPositions(list) {
	for (const host of document.querySelectorAll('[data-agent-positions]')) {
		const agentId = host.dataset.agentPositions;
		const mine = list.filter((p) => p.agent_id === agentId);
		const strat = _strategies.find((s) => s.agent_id === agentId);
		const armed = strat && strat.enabled && !strat.kill_switch;
		host.innerHTML = mine.length
			? mine.map(posRow).join('')
			: `<div class="sn-agent-pos-empty">${armed
				? 'No open positions — armed and watching for the next trigger.'
				: 'No open positions. Arm the strategy to start sniping.'}</div>`;

		const chip = document.querySelector(`[data-open-chip="${CSS.escape(agentId)}"]`);
		if (chip) {
			if (!mine.length) { chip.hidden = true; chip.textContent = ''; }
			else {
				const pnl = mine.reduce((s, p) => s + (p.unrealized_pnl_sol || 0), 0);
				chip.hidden = false;
				chip.className = `sn-open-chip ${clr(pnl)}`;
				chip.textContent = `${mine.length} open · ${pnl >= 0 ? '+' : ''}${fmtSol(pnl)}`;
			}
		}
	}
	if (list.length) enrichPositionOracle();
}

async function seedPositions() {
	try {
		const data = await get('/api/sniper/leaderboard?network=mainnet');
		const owned = ownedAgentIds();
		for (const p of (data.positions || [])) {
			if (owned.has(p.agent_id)) _positionsMap.set(p.id, normPos(p));
		}
	} catch { /* non-fatal — the live stream will populate */ }
	renderOwnedPositions();
}

function stopSse() {
	if (_sseSource) { try { _sseSource.close(); } catch {} _sseSource = null; }
	if (_sseTimer) { clearTimeout(_sseTimer); _sseTimer = null; }
}

function startSse() {
	stopSse();
	_positionsMap = new Map();
	if (!_strategies.length) { renderPositions([]); return; }
	setConn('connecting', 'Connecting…');
	seedPositions();
	connectSse();
}

function connectSse() {
	const src = new EventSource('/api/sniper/stream?network=mainnet');
	_sseSource = src;

	const ingest = (e) => {
		try {
			const p = normPos(JSON.parse(e.data));
			_positionsMap.set(p.id, { ...(_positionsMap.get(p.id) || {}), ...p });
			renderOwnedPositions();
		} catch {}
	};

	src.addEventListener('open', () => { _sseRetry = 0; setConn('live', 'Live'); });
	src.addEventListener('buy', ingest);
	src.addEventListener('update', ingest);
	src.addEventListener('sell', ingest);
	// Server signals end-of-stream (90s duration cap) with a 'close' event; reconnect.
	src.addEventListener('close', () => { try { src.close(); } catch {} scheduleReconnect(); });

	src.onerror = () => {
		// Take control of retry ourselves (close → backoff) so the state is visible
		// and the server's duration cap doesn't read as a permanent outage.
		try { src.close(); } catch {}
		if (_sseSource === src) _sseSource = null;
		scheduleReconnect();
	};
}

function scheduleReconnect() {
	if (!_strategies.length || _sseTimer) return;
	if (!document.getElementById('sn-positions')) return; // page navigated away
	_sseRetry = Math.min(_sseRetry + 1, 6);
	const delay = Math.min(1000 * 2 ** (_sseRetry - 1), 30000);
	setConn('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s…`);
	_sseTimer = setTimeout(() => {
		_sseTimer = null;
		if (document.getElementById('sn-positions')) connectSse();
	}, delay);
}

// ── Toast ─────────────────────────────────────────────────────────────────────


