// dashboard-next — Fleet Command.
//
// A command center for running many autonomous sniper agents at once. The
// per-strategy Sniper page (/dashboard/sniper) is the right surface for tuning a
// single bot; it does not scale to a 30+ agent swarm — you cannot see the whole
// fleet's health, move money in bulk, or hit one emergency stop. This page fills
// that gap:
//   1. Fleet KPIs        — armed count, pooled wallet SOL, low-balance count,
//                          open positions (live), realized PnL, win rate.
//   2. Fleet actions     — Arm all / Disarm all / Emergency Stop, each gated by a
//                          confirm dialog and reporting honest partial results
//                          ("Armed 30/33 · 3 failed · <first error>").
//   3. Roster            — one sortable, multi-select row per agent: status,
//                          wallet balance (low-balance warning), open/closed,
//                          win rate, realized PnL, per-row arm/disarm/kill.
//   4. Live trade feed   — the SSE stream of buys/sells across the whole fleet.
//
// It drives the exact same endpoints as the Sniper page — no new backend:
//   GET  /api/sniper/strategy     → { strategies: [...] }
//   GET  /api/sniper/leaderboard  → seed of open positions
//   GET  /api/sniper/stream       → SSE: buy/update/sell position events
//   POST /api/sniper/strategy     → { agent_id, network, enabled|kill_switch }

import { mountShell } from '../shell.js';
import { requireUser, get, post, esc, relTime } from '../api.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';

const lamportsToSol = (l) => Number(BigInt(l || '0')) / 1e9;
const fmtSol = (sol) => {
	const v = Number(sol) || 0;
	if (Math.abs(v) < 0.001 && v !== 0) return `${v.toFixed(4)} ◎`;
	return `${v.toFixed(3)} ◎`;
};
const clr = (n) => (Number(n) > 0 ? 'fc-pos' : Number(n) < 0 ? 'fc-neg' : '');
const signed = (n, f) => `${Number(n) > 0 ? '+' : ''}${f(n)}`;

// A fleet agent counts as "low balance" when its wallet can't cover one more
// trade plus a little fee headroom — the point at which arming is futile.
function isLowBalance(s) {
	if (s.wallet_sol == null) return false;
	return s.wallet_sol < lamportsToSol(s.per_trade_lamports || '0') + 0.003;
}
function statusOf(s) {
	if (s.kill_switch) return 'kill';
	if (s.enabled) return 'armed';
	return 'disarmed';
}

// ── Styles ──────────────────────────────────────────────────────────────────
// Uses the dashboard's own --nxt-* design tokens so it reads as one product with
// the rest of dashboard-next. `.fc-` prefix keeps it clear of the Sniper page's
// `.sn-` styles. Mono, sign-coloured numbers do the "trading desk" work.

const STYLE = `<style>
.fc-wrap { display: grid; gap: 18px; }

/* KPI deck */
.fc-deck { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.fc-kpi { position: relative; background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 14px 16px; overflow: hidden; }
.fc-kpi::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--nxt-accent) 55%, transparent), transparent); opacity: .5; }
.fc-kpi-label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 5px; }
.fc-kpi-val { font-size: 23px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; font-family: var(--nxt-mono, ui-monospace, monospace); }
.fc-kpi-sub { font-size: 11px; color: var(--nxt-ink-faint); margin-top: 4px; }

/* action + filter bar */
.fc-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.fc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.fc-btn { font-size: 12.5px; font-family: inherit; padding: 7px 14px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; transition: border-color .12s, background .12s, transform .12s, opacity .12s; }
.fc-btn:hover:not(:disabled) { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
.fc-btn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.fc-btn:disabled { opacity: .45; cursor: not-allowed; }
.fc-btn.primary { background: var(--nxt-accent); color: #061018; border-color: transparent; font-weight: 600; }
.fc-btn.danger { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 45%, transparent); }
.fc-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--nxt-danger, #f87171) 12%, transparent); }
.fc-spacer { flex: 1; }
.fc-search { flex: 0 1 220px; }
.fc-search input { width: 100%; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-sm); color: var(--nxt-ink); padding: 7px 11px; font-size: 13px; font-family: inherit; transition: border-color .12s; }
.fc-search input:focus { outline: none; border-color: var(--nxt-accent); }
.fc-chips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.fc-chip { font-size: 12px; font-family: inherit; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--nxt-stroke); background: transparent; color: var(--nxt-ink-dim); cursor: pointer; transition: color .12s, border-color .12s, background .12s; }
.fc-chip:hover { color: var(--nxt-ink); }
.fc-chip.active { background: color-mix(in srgb, var(--nxt-accent) 14%, transparent); color: var(--nxt-ink); border-color: color-mix(in srgb, var(--nxt-accent) 45%, transparent); }
.fc-chip:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.fc-selinfo { font-size: 12px; color: var(--nxt-ink-faint); }

/* roster table */
.fc-panel { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
.fc-tablewrap { overflow-x: auto; }
.fc-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 720px; }
.fc-table th { padding: 10px 14px; text-align: left; font: 600 10px/1 var(--nxt-mono, monospace); letter-spacing: .07em; text-transform: uppercase; color: var(--nxt-ink-faint); border-bottom: 1px solid var(--nxt-line); white-space: nowrap; user-select: none; }
.fc-table th.sortable { cursor: pointer; }
.fc-table th.sortable:hover { color: var(--nxt-ink); }
.fc-table th .fc-sort-ind { opacity: .5; font-size: 9px; }
.fc-table th.r, .fc-table td.r { text-align: right; }
.fc-table th.c, .fc-table td.c { text-align: center; }
.fc-row td { padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; white-space: nowrap; }
.fc-row:last-child td { border-bottom: none; }
.fc-row:hover { background: var(--nxt-bg-2); }
.fc-row.sel { background: color-mix(in srgb, var(--nxt-accent) 8%, transparent); }
.fc-mono { font-family: var(--nxt-mono, monospace); font-variant-numeric: tabular-nums; }
.fc-ag { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fc-av { width: 30px; height: 30px; border-radius: 8px; object-fit: cover; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); flex-shrink: 0; }
.fc-agname { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.fc-agsub { font-size: 11px; color: var(--nxt-ink-faint); }
.fc-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); white-space: nowrap; }
.fc-pill .fc-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.fc-pill.armed { color: var(--nxt-success); border-color: color-mix(in srgb, var(--nxt-success) 35%, transparent); background: color-mix(in srgb, var(--nxt-success) 8%, transparent); }
.fc-pill.armed .fc-dot { animation: fc-pulse 2s ease infinite; }
.fc-pill.kill { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 35%, transparent); background: color-mix(in srgb, var(--nxt-danger, #f87171) 8%, transparent); }
.fc-pill.disarmed { color: var(--nxt-ink-faint); }
@keyframes fc-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
.fc-warn { color: var(--nxt-warn, #f59e0b); font-size: 11px; }
.fc-rowbtns { display: inline-flex; gap: 6px; }
.fc-rowbtn { font-size: 11px; font-family: inherit; padding: 4px 9px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; transition: border-color .12s, background .12s; text-decoration: none; }
.fc-rowbtn:hover { border-color: var(--nxt-stroke-strong); }
.fc-rowbtn.danger { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 40%, transparent); }
.fc-rowbtn:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.fc-rowbtn.danger:focus-visible { outline-color: var(--nxt-danger, #f87171); }
.fc-rowbtn:disabled { opacity: .5; cursor: progress; }
.fc-check { width: 15px; height: 15px; accent-color: var(--nxt-accent); cursor: pointer; }
.fc-check:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.fc-pos { color: var(--nxt-success); }
.fc-neg { color: var(--nxt-danger, #f87171); }

/* live feed */
.fc-live-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--nxt-line); }
.fc-live-title { font-size: 13px; font-weight: 600; display: flex; gap: 8px; align-items: center; }
.fc-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--nxt-success); animation: fc-pulse 2s ease infinite; flex-shrink: 0; }
.fc-live-dot.connecting { background: var(--nxt-warn, #f59e0b); }
.fc-live-dot.offline { background: var(--nxt-danger, #f87171); animation: none; }
.fc-conn { font-size: 11px; color: var(--nxt-ink-faint); }
.fc-feed { max-height: 320px; overflow-y: auto; }
.fc-frow { display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--nxt-line); font-size: 13px; }
.fc-frow:last-child { border-bottom: none; }
.fc-fdir { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 5px; }
.fc-fdir.buy { color: var(--nxt-success); background: color-mix(in srgb, var(--nxt-success) 12%, transparent); }
.fc-fdir.sell { color: var(--nxt-danger, #f87171); background: color-mix(in srgb, var(--nxt-danger, #f87171) 12%, transparent); }
.fc-fsym { font-weight: 600; }
.fc-fsub { font-size: 11px; color: var(--nxt-ink-faint); }
.fc-fpnl { font-family: var(--nxt-mono, monospace); font-variant-numeric: tabular-nums; text-align: right; }
.fc-ftime { font-size: 11px; color: var(--nxt-ink-faint); font-variant-numeric: tabular-nums; }

/* states */
.fc-empty { color: var(--nxt-ink-faint); font-size: 13px; padding: 28px 16px; text-align: center; }
.fc-empty b { color: var(--nxt-ink); }
.fc-boot-sk { display: grid; gap: 10px; padding: 4px 0; }

/* confirm dialog */
.fc-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); backdrop-filter: blur(6px); z-index: 950; display: flex; align-items: center; justify-content: center; padding: 16px; animation: fc-fade .14s ease; }
@keyframes fc-fade { from { opacity: 0 } to { opacity: 1 } }
.fc-modal { background: var(--nxt-bg); border: 1px solid var(--nxt-stroke-strong); border-radius: var(--nxt-radius); padding: 22px; width: 100%; max-width: 440px; }
.fc-modal h2 { font-size: 16px; margin: 0 0 10px; }
.fc-modal p { font-size: 13.5px; color: var(--nxt-ink-dim); line-height: 1.5; margin: 0 0 6px; }
.fc-modal-foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }

/* toast */
.fc-toasts { position: fixed; bottom: 20px; right: 20px; z-index: 980; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.fc-toast { background: var(--nxt-bg); border: 1px solid var(--nxt-stroke-strong); border-left: 3px solid var(--nxt-accent); border-radius: var(--nxt-radius-sm); padding: 11px 15px; font-size: 13px; color: var(--nxt-ink); max-width: 360px; box-shadow: 0 8px 26px rgba(0,0,0,.4); animation: fc-slide .18s ease; }
.fc-toast.err { border-left-color: var(--nxt-danger, #f87171); }
@keyframes fc-slide { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@media (prefers-reduced-motion: reduce) {
	.fc-pill.armed .fc-dot, .fc-live-dot { animation: none; }
	.fc-btn:hover:not(:disabled) { transform: none; }
}
</style>`;

// ── State ───────────────────────────────────────────────────────────────────

let _strategies = [];
let _positions = new Map();   // id → normalized open position
let _feed = [];               // rolling recent buy/sell events (newest first)
let _sel = new Set();         // selected agent_ids
let _sort = { key: 'status', dir: 1 };
let _filter = { q: '', status: 'all' };
let _sse = null;
let _sseTimer = null;
let _sseRetry = 0;
let _loadError = null;        // set when the strategy fetch fails and we have no roster

// ── Boot ────────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();
		ensureStateKitStyles();
		main.innerHTML = `
			<h1 class="dn-h1">Fleet Command</h1>
			<p class="dn-h1-sub">Every autonomous sniper agent on one deck — pooled balances, live trades, and fleet-wide controls.</p>
			<div id="fc-root" aria-busy="true">${STYLE}<div class="fc-boot-sk">${skeletonHTML(4, 'row')}</div></div>
		`;
		await refresh();
		window.addEventListener('beforeunload', stopSse);
	} catch (e) {
		const root = document.getElementById('fc-root');
		if (root) {
			root.removeAttribute('aria-busy');
			root.innerHTML = `${STYLE}<div class="fc-panel">${errorStateHTML({ title: "Couldn't load the fleet", body: esc(e.message || 'The fleet service is unavailable right now. Check your connection and try again.') })}</div>`;
			attachRetry(root, () => location.reload());
		}
	}
})();

async function refresh() {
	try {
		const data = await get('/api/sniper/strategy');
		_strategies = data.strategies || [];
		_loadError = null;
	} catch (e) {
		// Keep any last-known roster on screen (never hide a live kill switch behind
		// an error screen); only surface a recoverable error when we have nothing.
		_loadError = e?.message || 'The fleet service did not respond.';
	}
	// Drop selections for agents that no longer exist.
	_sel = new Set([..._sel].filter((id) => _strategies.some((s) => s.agent_id === id)));
	render();
	if (!(_loadError && !_strategies.length)) startSse();
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
	const root = document.getElementById('fc-root');
	if (!root) return;
	root.removeAttribute('aria-busy');
	if (_loadError && !_strategies.length) {
		root.innerHTML = `${STYLE}<div class="fc-panel">${errorStateHTML({ title: "Couldn't load the fleet", body: esc(_loadError) })}</div>`;
		root.querySelector('[data-sk-retry]')?.addEventListener('click', () => refresh());
		return;
	}
	if (!_strategies.length) {
		root.innerHTML = `${STYLE}<div class="fc-panel">${emptyStateHTML({
			title: 'No armed agents yet',
			body: 'Arm your first autonomous trader on the Sniper Strategies page, then command the whole fleet — pooled balances, live trades, and one emergency stop — from here.',
			actions: [{ label: 'Arm a strategy', href: '/dashboard/sniper', primary: true }],
		})}</div>`;
		return;
	}
	root.innerHTML = `${STYLE}
		<div class="fc-wrap">
			${kpiDeck()}
			${actionBar()}
			<div class="fc-panel"><div class="fc-tablewrap">${rosterTable()}</div></div>
			<div class="fc-panel">
				<div class="fc-live-head">
					<div class="fc-live-title"><span class="fc-live-dot connecting" id="fc-live-dot"></span> Live Trade Feed <span class="fc-conn" id="fc-conn" role="status" aria-live="polite">Connecting…</span></div>
					<a class="fc-btn" href="/leaderboard" target="_blank" rel="noopener" style="padding:5px 12px">Leaderboard ↗</a>
				</div>
				<div class="fc-feed" id="fc-feed">${feedRows()}</div>
			</div>
		</div>`;
	wire(root);
}

function kpiDeck() {
	const armed = _strategies.filter((s) => statusOf(s) === 'armed').length;
	const killed = _strategies.filter((s) => s.kill_switch).length;
	const low = _strategies.filter(isLowBalance).length;
	const walletSol = _strategies.reduce((a, s) => a + (Number(s.wallet_sol) || 0), 0);
	const funded = _strategies.filter((s) => (Number(s.wallet_sol) || 0) > 0).length;
	const openLive = [..._positions.values()].filter((p) => ['opening', 'open'].includes(p.status)).length;
	const pnlLam = _strategies.reduce((a, s) => a + BigInt(s.summary?.realized_pnl_lamports || '0'), 0n);
	const pnlSol = lamportsToSol(String(pnlLam));
	const closed = _strategies.reduce((a, s) => a + (s.summary?.closed_positions || 0), 0);
	const wins = _strategies.reduce((a, s) => a + (s.summary?.wins || 0), 0);
	const wr = closed > 0 ? Math.round((wins / closed) * 100) : null;

	const kpi = (label, val, sub = '', cls = '') =>
		`<div class="fc-kpi"><div class="fc-kpi-label">${label}</div><div class="fc-kpi-val ${cls}">${val}</div>${sub ? `<div class="fc-kpi-sub">${sub}</div>` : ''}</div>`;

	return `<div class="fc-deck">
		${kpi('Armed', `${armed}<span style="font-size:14px;color:var(--nxt-ink-faint)"> / ${_strategies.length}</span>`, killed ? `${killed} kill-switched` : 'agents on the deck')}
		${kpi('Pooled wallet', fmtSol(walletSol), `${funded}/${_strategies.length} funded${low ? ` · <span class="fc-warn">${low} low</span>` : ''}`)}
		${kpi('Open positions', `<span data-kpi-open>${openLive}</span>`, 'live across the fleet')}
		${kpi('Realized PnL', signed(pnlSol, fmtSol), `${closed} closed trades`, clr(pnlSol))}
		${kpi('Win rate', wr != null ? `${wr}%` : '—', `${wins} wins`)}
	</div>`;
}

function actionBar() {
	const n = _sel.size;
	const target = n ? `${n} selected` : `all ${visibleRows().length}`;
	const chip = (key, label) => `<button class="fc-chip ${_filter.status === key ? 'active' : ''}" data-chip="${key}" role="tab" aria-selected="${_filter.status === key}">${label}</button>`;
	return `<div class="fc-bar">
		<div class="fc-actions">
			<button class="fc-btn primary" data-act="arm-all">Arm ${target}</button>
			<button class="fc-btn" data-act="disarm-all">Disarm ${target}</button>
			<button class="fc-btn danger" data-act="stop-all">■ Emergency stop</button>
		</div>
		<span class="fc-selinfo">${n ? `${n} selected` : 'Acting on all filtered agents'}</span>
		<div class="fc-spacer"></div>
		<div class="fc-chips" role="tablist" aria-label="Filter by status">
			${chip('all', 'All')}${chip('armed', 'Armed')}${chip('disarmed', 'Disarmed')}${chip('kill', 'Kill switch')}${chip('low', 'Low balance')}
		</div>
		<div class="fc-search"><input type="search" id="fc-q" placeholder="Search agents…" value="${esc(_filter.q)}" aria-label="Search agents" /></div>
	</div>`;
}

// The set of agents matching the active search + status filter.
function visibleRows() {
	const q = _filter.q.trim().toLowerCase();
	return _strategies.filter((s) => {
		if (q && !(`${s.agent_name || ''} ${s.agent_id}`.toLowerCase().includes(q))) return false;
		if (_filter.status === 'all') return true;
		if (_filter.status === 'low') return isLowBalance(s);
		return statusOf(s) === _filter.status;
	});
}

const COLS = [
	{ key: 'sel', label: '', sortable: false, cls: 'c' },
	{ key: 'agent_name', label: 'Agent', sortable: true },
	{ key: 'status', label: 'Status', sortable: true },
	{ key: 'wallet_sol', label: 'Wallet', sortable: true, cls: 'r' },
	{ key: 'open', label: 'Open', sortable: true, cls: 'r' },
	{ key: 'closed', label: 'Closed', sortable: true, cls: 'r' },
	{ key: 'wr', label: 'Win%', sortable: true, cls: 'r' },
	{ key: 'pnl', label: 'Realized PnL', sortable: true, cls: 'r' },
	{ key: 'act', label: '', sortable: false, cls: 'r' },
];

function sortVal(s, key) {
	switch (key) {
		case 'agent_name': return (s.agent_name || s.agent_id || '').toLowerCase();
		case 'status': return { armed: 0, disarmed: 1, kill: 2 }[statusOf(s)];
		case 'wallet_sol': return Number(s.wallet_sol) || 0;
		case 'open': return openCountFor(s.agent_id);
		case 'closed': return s.summary?.closed_positions || 0;
		case 'wr': { const c = s.summary?.closed_positions || 0; return c ? (s.summary?.wins || 0) / c : -1; }
		case 'pnl': return Number(lamportsToSol(s.summary?.realized_pnl_lamports || '0'));
		default: return 0;
	}
}

function rosterTable() {
	const rows = visibleRows().slice().sort((a, b) => {
		const va = sortVal(a, _sort.key), vb = sortVal(b, _sort.key);
		if (va < vb) return -1 * _sort.dir;
		if (va > vb) return 1 * _sort.dir;
		return 0;
	});
	const allSel = rows.length > 0 && rows.every((s) => _sel.has(s.agent_id));
	const head = COLS.map((c) => {
		if (c.key === 'sel') return `<th class="c"><input type="checkbox" class="fc-check" id="fc-all" ${allSel ? 'checked' : ''} aria-label="Select all" /></th>`;
		const ind = _sort.key === c.key ? `<span class="fc-sort-ind">${_sort.dir > 0 ? '▲' : '▼'}</span>` : '';
		return `<th class="${c.cls || ''} ${c.sortable ? 'sortable' : ''}" ${c.sortable ? `data-sort="${c.key}"` : ''}>${esc(c.label)} ${ind}</th>`;
	}).join('');
	const body = rows.length
		? rows.map(rosterRow).join('')
		: `<tr><td colspan="${COLS.length}"><div class="fc-empty">No agents match this filter.</div></td></tr>`;
	return `<table class="fc-table"><thead><tr>${head}</tr></thead><tbody id="fc-tbody">${body}</tbody></table>`;
}

function openCountFor(agentId) {
	let n = 0;
	for (const p of _positions.values()) if (p.agent_id === agentId && ['opening', 'open'].includes(p.status)) n++;
	return n;
}

function rosterRow(s) {
	const st = statusOf(s);
	const pill = st === 'armed' ? '<span class="fc-pill armed"><span class="fc-dot"></span>Armed</span>'
		: st === 'kill' ? '<span class="fc-pill kill"><span class="fc-dot"></span>Kill switch</span>'
		: '<span class="fc-pill disarmed"><span class="fc-dot"></span>Disarmed</span>';
	const bal = s.wallet_sol != null ? fmtSol(s.wallet_sol) : '—';
	const low = isLowBalance(s) ? ' <span class="fc-warn" title="Balance too low for a trade">⚠</span>' : '';
	const closed = s.summary?.closed_positions || 0;
	const wins = s.summary?.wins || 0;
	const wr = closed ? Math.round((wins / closed) * 100) : null;
	const pnlSol = lamportsToSol(s.summary?.realized_pnl_lamports || '0');
	const open = openCountFor(s.agent_id);
	const armLabel = s.enabled ? 'Disarm' : 'Arm';
	return `<tr class="fc-row ${_sel.has(s.agent_id) ? 'sel' : ''}" data-agent="${esc(s.agent_id)}">
		<td class="c"><input type="checkbox" class="fc-check" data-check="${esc(s.agent_id)}" ${_sel.has(s.agent_id) ? 'checked' : ''} aria-label="Select ${esc(s.agent_name || s.agent_id)}" /></td>
		<td><div class="fc-ag">
			<img class="fc-av" loading="lazy" decoding="async" src="${esc(s.image || '/favicon.ico')}" alt="" data-fallback="invisible" />
			<div style="min-width:0"><div class="fc-agname">${esc(s.agent_name || s.agent_id)}</div><div class="fc-agsub fc-mono">${esc(String(s.agent_id).slice(0, 8))}</div></div>
		</div></td>
		<td>${pill}</td>
		<td class="r fc-mono">${bal}${low}</td>
		<td class="r fc-mono">${open || '—'}</td>
		<td class="r fc-mono">${closed || '—'}</td>
		<td class="r fc-mono ${wr != null && wr >= 50 ? 'fc-pos' : ''}">${wr != null ? `${wr}%` : '—'}</td>
		<td class="r fc-mono ${clr(pnlSol)}">${pnlSol !== 0 ? signed(pnlSol, fmtSol) : fmtSol(0)}</td>
		<td class="r"><div class="fc-rowbtns">
			<button class="fc-rowbtn" data-row-act="toggle" data-agent="${esc(s.agent_id)}">${armLabel}</button>
			<button class="fc-rowbtn danger" data-row-act="kill" data-agent="${esc(s.agent_id)}" title="${s.kill_switch ? 'Clear kill switch' : 'Kill switch'}">${s.kill_switch ? 'Clear' : 'Kill'}</button>
			<a class="fc-rowbtn" href="/dashboard/sniper" title="Tune this strategy">Tune ↗</a>
		</div></td>
	</tr>`;
}

function feedRows() {
	if (!_feed.length) return '<div class="fc-empty">No trades yet — armed agents post their buys and sells here the moment they fire.</div>';
	return _feed.slice(0, 40).map((f) => {
		const pnl = f.kind === 'sell' && f.pnl_sol != null
			? `<span class="fc-fpnl ${clr(f.pnl_sol)}">${signed(f.pnl_sol, fmtSol)}</span>`
			: f.entry_sol != null ? `<span class="fc-fpnl">${fmtSol(f.entry_sol)}</span>` : '<span class="fc-fpnl">—</span>';
		return `<div class="fc-frow">
			<span class="fc-fdir ${f.kind}">${f.kind === 'sell' ? 'Sell' : 'Buy'}</span>
			<div style="min-width:0"><span class="fc-fsym">${esc(f.symbol || '—')}</span> <span class="fc-fsub">${esc(f.agent_name || '')}</span></div>
			${pnl}
			<span class="fc-ftime">${f.at ? relTime(f.at) : 'now'}</span>
		</div>`;
	}).join('');
}

// ── Events ──────────────────────────────────────────────────────────────────

function wire(root) {
	// Sort headers
	root.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
		const key = th.dataset.sort;
		if (_sort.key === key) _sort.dir *= -1; else { _sort.key = key; _sort.dir = 1; }
		refreshTable();
	}));
	// Select-all + per-row checkboxes
	root.querySelector('#fc-all')?.addEventListener('change', (e) => {
		const on = e.target.checked;
		for (const s of visibleRows()) { if (on) _sel.add(s.agent_id); else _sel.delete(s.agent_id); }
		refreshTable(); refreshBar();
	});
	root.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', (e) => {
		const id = cb.dataset.check;
		if (e.target.checked) _sel.add(id); else _sel.delete(id);
		root.querySelector(`.fc-row[data-agent="${CSS.escape(id)}"]`)?.classList.toggle('sel', e.target.checked);
		refreshBar();
	}));
	// Filter chips + search
	root.querySelectorAll('[data-chip]').forEach((c) => c.addEventListener('click', () => {
		_filter.status = c.dataset.chip; refreshTable(); refreshBar();
	}));
	root.querySelector('#fc-q')?.addEventListener('input', (e) => {
		_filter.q = e.target.value; refreshTable(); refreshBar();
	});
	// Fleet actions
	root.querySelector('[data-act="arm-all"]')?.addEventListener('click', () => bulkAction('arm'));
	root.querySelector('[data-act="disarm-all"]')?.addEventListener('click', () => bulkAction('disarm'));
	root.querySelector('[data-act="stop-all"]')?.addEventListener('click', () => bulkAction('stop'));
	// Per-row actions
	root.querySelectorAll('[data-row-act]').forEach((b) => b.addEventListener('click', () => rowAction(b)));
}

function refreshTable() {
	const wrap = document.querySelector('.fc-tablewrap');
	if (wrap) { wrap.innerHTML = rosterTable(); wireTable(wrap); }
}
function wireTable(scope) {
	scope.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
		const key = th.dataset.sort;
		if (_sort.key === key) _sort.dir *= -1; else { _sort.key = key; _sort.dir = 1; }
		refreshTable();
	}));
	scope.querySelector('#fc-all')?.addEventListener('change', (e) => {
		const on = e.target.checked;
		for (const s of visibleRows()) { if (on) _sel.add(s.agent_id); else _sel.delete(s.agent_id); }
		refreshTable(); refreshBar();
	});
	scope.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', (e) => {
		const id = cb.dataset.check;
		if (e.target.checked) _sel.add(id); else _sel.delete(id);
		scope.querySelector(`.fc-row[data-agent="${CSS.escape(id)}"]`)?.classList.toggle('sel', e.target.checked);
		refreshBar();
	}));
	scope.querySelectorAll('[data-row-act]').forEach((b) => b.addEventListener('click', () => rowAction(b)));
}
function refreshBar() {
	const bar = document.querySelector('.fc-bar');
	if (!bar) return;
	const tmp = document.createElement('div');
	tmp.innerHTML = actionBar();
	bar.replaceWith(tmp.firstElementChild);
	// re-wire the fresh bar
	const nb = document.querySelector('.fc-bar');
	nb.querySelector('[data-act="arm-all"]')?.addEventListener('click', () => bulkAction('arm'));
	nb.querySelector('[data-act="disarm-all"]')?.addEventListener('click', () => bulkAction('disarm'));
	nb.querySelector('[data-act="stop-all"]')?.addEventListener('click', () => bulkAction('stop'));
	nb.querySelectorAll('[data-chip]').forEach((c) => c.addEventListener('click', () => { _filter.status = c.dataset.chip; refreshTable(); refreshBar(); }));
	const q = nb.querySelector('#fc-q');
	if (q) { q.addEventListener('input', (e) => { _filter.q = e.target.value; refreshTable(); refreshBar(); }); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// The agents a bulk action targets: the current selection, or every filtered row
// when nothing is selected.
function bulkTargets() {
	if (_sel.size) return _strategies.filter((s) => _sel.has(s.agent_id));
	return visibleRows();
}

async function bulkAction(kind) {
	const targets = bulkTargets();
	if (!targets.length) { toast('No agents to act on', true); return; }
	const verb = kind === 'arm' ? 'Arm' : kind === 'disarm' ? 'Disarm' : 'Emergency-stop';
	const body = kind === 'stop'
		? `Trip the kill switch on <b>${targets.length}</b> agent${targets.length > 1 ? 's' : ''}. Each stops trading immediately and holds its open positions. This does not sell — clear the kill switch to resume.`
		: `${verb} <b>${targets.length}</b> agent${targets.length > 1 ? 's' : ''}. ${kind === 'arm' ? 'Armed agents trade real SOL from their own wallets the moment a trigger fires.' : 'Disarmed agents stop opening new positions.'}`;
	const ok = await confirmDialog(`${verb} ${targets.length} agent${targets.length > 1 ? 's' : ''}?`, body, kind === 'stop' ? 'Emergency stop' : verb, kind !== 'arm');
	if (!ok) return;

	const patch = kind === 'arm' ? { enabled: true, kill_switch: false }
		: kind === 'disarm' ? { enabled: false }
		: { kill_switch: true, enabled: false };

	setActionsBusy(true);
	const res = await mapLimit(targets, 6, async (s) => {
		try { await post('/api/sniper/strategy', { agent_id: s.agent_id, network: s.network || 'mainnet', ...patch }); return { ok: true }; }
		catch (e) { return { ok: false, err: e?.message || 'failed' }; }
	});
	const okN = res.filter((r) => r.ok).length;
	const failN = res.length - okN;
	const firstErr = res.find((r) => !r.ok)?.err;
	toast(`${verb}ed ${okN}/${res.length}${failN ? ` · ${failN} failed${firstErr ? ` · ${esc(firstErr)}` : ''}` : ''}`, failN > 0);
	setActionsBusy(false);
	await refresh();
}

async function rowAction(btn) {
	const id = btn.dataset.agent;
	const s = _strategies.find((x) => x.agent_id === id);
	if (!s) return;
	btn.disabled = true;
	try {
		if (btn.dataset.rowAct === 'toggle') {
			await post('/api/sniper/strategy', { agent_id: id, network: s.network || 'mainnet', enabled: !s.enabled, ...(!s.enabled ? { kill_switch: false } : {}) });
		} else {
			await post('/api/sniper/strategy', { agent_id: id, network: s.network || 'mainnet', kill_switch: !s.kill_switch, ...(!s.kill_switch ? { enabled: false } : {}) });
		}
		await refresh();
	} catch (e) {
		toast(e?.message || 'Update failed', true);
		btn.disabled = false;
	}
}

function setActionsBusy(busy) {
	document.querySelectorAll('.fc-actions .fc-btn').forEach((b) => { b.disabled = busy; });
}

// Order-preserving bounded-concurrency map — never fire N writes at once.
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	async function worker() {
		while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

function confirmDialog(title, bodyHtml, confirmLabel, danger) {
	return new Promise((resolve) => {
		const ov = document.createElement('div');
		ov.className = 'fc-overlay';
		ov.innerHTML = `<div class="fc-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
			<h2>${esc(title)}</h2><p>${bodyHtml}</p>
			<div class="fc-modal-foot">
				<button class="fc-btn" data-x="cancel">Cancel</button>
				<button class="fc-btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(confirmLabel)}</button>
			</div>
		</div>`;
		const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
		const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
		ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
		ov.querySelector('[data-x="cancel"]').addEventListener('click', () => done(false));
		ov.querySelector('[data-x="ok"]').addEventListener('click', () => done(true));
		document.addEventListener('keydown', onKey);
		document.body.appendChild(ov);
		ov.querySelector('[data-x="ok"]').focus();
	});
}

// ── Toast ───────────────────────────────────────────────────────────────────

function toast(msg, isErr = false) {
	let host = document.querySelector('.fc-toasts');
	if (!host) { host = document.createElement('div'); host.className = 'fc-toasts'; document.body.appendChild(host); }
	const t = document.createElement('div');
	t.className = `fc-toast ${isErr ? 'err' : ''}`;
	t.innerHTML = msg;
	host.appendChild(t);
	setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 4200);
}

// ── Live stream ─────────────────────────────────────────────────────────────

function normPos(p) {
	const entry = p.entry_sol != null ? Number(p.entry_sol) : null;
	const current = p.current_sol != null ? Number(p.current_sol) : entry;
	const pnlSol = p.pnl_sol != null ? Number(p.pnl_sol) : (entry != null && current != null ? current - entry : null);
	return {
		id: p.id, agent_id: p.agent_id, agent_name: p.agent_name, network: p.network || 'mainnet',
		mint: p.mint, symbol: p.symbol || p.name, status: p.status || 'open',
		entry_sol: entry, current_sol: current, pnl_sol: pnlSol,
		at: p.at || p.opened_at || p.closed_at || null,
	};
}

function ownedIds() { return new Set(_strategies.map((s) => s.agent_id)); }

function setConn(state, label) {
	const dot = document.getElementById('fc-live-dot');
	const txt = document.getElementById('fc-conn');
	if (dot) dot.className = `fc-live-dot ${state}`;
	if (txt) txt.textContent = label;
}

function renderLive() {
	const feed = document.getElementById('fc-feed');
	if (feed) feed.innerHTML = feedRows();
	const openKpi = document.querySelector('[data-kpi-open]');
	if (openKpi) openKpi.textContent = String([..._positions.values()].filter((p) => ['opening', 'open'].includes(p.status)).length);
	// keep the roster's Open column live without a full re-render
	document.querySelectorAll('.fc-row[data-agent]').forEach((tr) => {
		const cell = tr.children[4];
		if (cell) { const n = openCountFor(tr.dataset.agent); cell.textContent = n || '—'; }
	});
}

async function seed() {
	try {
		const data = await get('/api/sniper/leaderboard?network=mainnet');
		const owned = ownedIds();
		for (const p of (data.positions || [])) if (owned.has(p.agent_id)) _positions.set(p.id, normPos(p));
	} catch { /* the live stream will populate */ }
	renderLive();
}

function stopSse() {
	if (_sse) { try { _sse.close(); } catch { /* already closed */ } _sse = null; }
	if (_sseTimer) { clearTimeout(_sseTimer); _sseTimer = null; }
}

function startSse() {
	stopSse();
	_positions = new Map();
	if (!_strategies.length) return;
	setConn('connecting', 'Connecting…');
	seed();
	connectSse();
}

function connectSse() {
	const owned = ownedIds();
	const src = new EventSource('/api/sniper/stream?network=mainnet');
	_sse = src;
	const ingest = (kind) => (e) => {
		try {
			const p = normPos(JSON.parse(e.data));
			if (!owned.has(p.agent_id)) return;
			if (kind === 'sell') p.status = 'closed';
			_positions.set(p.id, { ...(_positions.get(p.id) || {}), ...p });
			if (kind !== 'update') {
				_feed.unshift({ kind, symbol: p.symbol, agent_name: p.agent_name, pnl_sol: p.pnl_sol, entry_sol: p.entry_sol, at: p.at || new Date().toISOString() });
				_feed = _feed.slice(0, 60);
			}
			renderLive();
		} catch { /* ignore malformed frame */ }
	};
	src.addEventListener('open', () => { _sseRetry = 0; setConn('live', 'Live'); });
	src.addEventListener('buy', ingest('buy'));
	src.addEventListener('update', ingest('update'));
	src.addEventListener('sell', ingest('sell'));
	src.addEventListener('close', () => { try { src.close(); } catch { /* noop */ } scheduleReconnect(); });
	src.onerror = () => { try { src.close(); } catch { /* noop */ } setConn('offline', 'Reconnecting…'); scheduleReconnect(); };
}

function scheduleReconnect() {
	if (_sseTimer) return;
	const delay = Math.min(1000 * 2 ** _sseRetry, 15000);
	_sseRetry++;
	_sseTimer = setTimeout(() => { _sseTimer = null; if (_strategies.length) connectSse(); }, delay);
}
