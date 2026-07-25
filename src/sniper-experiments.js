// /sniper/experiments, the strategy A/B scoreboard.
//
// One row per armed sniper strategy: its human label, the entry conditions it
// trades (rule shields or an LLM judge), and its REAL on-chain record over the
// selected window via /api/sniper/experiments. No simulation rows, no mock
// data; when an arm hasn't traded yet it honestly shows zero.

import { escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30_000;
const WINDOWS = [
	{ key: '24h', label: '24h' },
	{ key: '7d', label: '7 days' },
	{ key: '30d', label: '30 days' },
	{ key: 'all', label: 'All time' },
];

let windowKey = '7d';
let timer = null;

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

function sol(n) {
	if (n == null || !Number.isFinite(Number(n))) return '·';
	const v = Number(n);
	const s = v.toFixed(Math.abs(v) < 0.01 && v !== 0 ? 4 : 3);
	return `${v > 0 ? '+' : ''}${s} SOL`;
}

function pct(n, signed = true) {
	if (n == null || !Number.isFinite(Number(n))) return '·';
	const v = Number(n);
	return `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function holdFmt(s) {
	if (s == null || !Number.isFinite(Number(s))) return '·';
	const v = Number(s);
	if (v < 90) return `${Math.round(v)}s`;
	return `${Math.round(v / 60)}m`;
}

function ago(iso) {
	if (!iso) return 'never';
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return 'just now';
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
	return `${Math.round(ms / 86_400_000)}d ago`;
}

function pnlClass(v) {
	if (v == null || Number(v) === 0) return '';
	return Number(v) > 0 ? 'xp-pos' : 'xp-neg';
}

function shortAddr(a) {
	if (!a) return null;
	return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function walletLine(x) {
	if (!x.wallet_address) return '<div class="xp-wallet xp-wallet-none">no wallet</div>';
	const bal = x.balance_sol != null ? `${Number(x.balance_sol).toFixed(3)} SOL` : '· SOL';
	const low = x.balance_sol != null && x.balance_sol < 0.02;
	return `
		<div class="xp-wallet">
			<a href="${esc(x.wallet_explorer_url)}" target="_blank" rel="noopener noreferrer" title="View wallet on Solscan">${esc(shortAddr(x.wallet_address))} ↗</a>
			<span class="${low ? 'xp-neg' : ''}">${esc(bal)}</span>
		</div>`;
}

function modeBadge(x) {
	if (x.decision_mode === 'llm') {
		return `<span class="xp-badge xp-badge-llm" title="No rule shields: an LLM judges each launch">LLM · ${esc((x.llm_model || 'auto').split('/').pop())}</span>`;
	}
	return `<span class="xp-badge xp-badge-rules">rules</span>`;
}

// Earned autonomy: how much rope this arm's own record has bought it. Only shown
// once an arm has moved off the default, so the board stays quiet by default and
// a tier badge always means something happened.
function tierBadge(x) {
	const tier = x.autonomy_tier;
	if (!tier || tier === 'standard') return '';
	const title = `${x.autonomy_reason || ''} ${x.autonomy_grants || ''}`.trim();
	return ` <span class="xp-badge xp-badge-tier xp-tier-${esc(tier)}" title="${esc(title)}">${esc(tier)}</span>`;
}

// The exit shape in one glance. A null ladder is the classic single-shot full
// exit; a set one recovers the stake at Nx and keeps a moon bag riding.
function exitLine(x) {
	const bits = [`SL ${pct(-Math.abs(x.stop_loss_pct ?? 0), false)}`];
	if (x.trailing_stop_pct != null) bits.push(`trail ${pct(x.trailing_stop_pct, false)}`);
	if (x.max_hold_seconds != null) bits.push(`max ${holdFmt(x.max_hold_seconds)}`);
	bits.push(x.initials_out_multiple != null
		? `ladder ${x.initials_out_multiple}x, ${x.moonbag_min_pct ?? 15}% moon bag`
		: 'no ladder');
	return bits.join(' · ');
}

function renderControls() {
	$('xp-controls').innerHTML = `
		<div class="xp-seg" role="group" aria-label="Time window">
			${WINDOWS.map(
				(w) => `
				<button class="xp-seg-btn${w.key === windowKey ? ' on' : ''}" data-window="${w.key}" aria-pressed="${w.key === windowKey}">
					${esc(w.label)}
				</button>`,
			).join('')}
		</div>`;
	$('xp-controls').querySelectorAll('[data-window]').forEach((btn) => {
		btn.addEventListener('click', () => {
			windowKey = btn.dataset.window;
			renderControls();
			refresh();
		});
	});
}

// How much of the fleet has traded its way into extra freedom. An arm at trusted
// or above gets wider tuning bounds, more of the fleet budget, and a richer
// evidence pack in front of its judge; one on probation gets held tighter.
function earnedTile(experiments) {
	const count = (tier) => experiments.filter((x) => x.autonomy_tier === tier).length;
	const earned = count('trusted') + count('autonomous');
	const probation = count('probation');
	return `
		<div class="cv-card xp-tile" title="Tiers are recomputed from each arm's own realized record every optimizer run. Freedom is continuously earned, never granted once.">
			<span>Earned autonomy</span>
			<b class="${earned > 0 ? 'xp-pos' : ''}">${earned} earned</b>
			<i>${probation} on probation · ${experiments.length - earned - probation} standard</i>
		</div>`;
}

function renderSummary(experiments, masterWallet) {
	const active = experiments.filter((x) => x.enabled);
	const traded = experiments.filter((x) => x.closed > 0);
	const totalPnl = experiments.reduce((a, x) => a + (Number(x.realized_pnl_sol) || 0), 0);
	const totalTrades = experiments.reduce((a, x) => a + x.closed, 0);
	const fleetSol = experiments.reduce((a, x) => a + (Number(x.balance_sol) || 0), 0);
	const best = traded.slice().sort((a, b) => (b.realized_pnl_sol || 0) - (a.realized_pnl_sol || 0))[0];
	const masterTile = masterWallet
		? `<div class="cv-card xp-tile">
				<span>Master funding wallet</span>
				<b><a href="${esc(masterWallet.explorer_url)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(masterWallet.address))} ↗</a></b>
				<i>${masterWallet.balance_sol != null ? `${masterWallet.balance_sol.toFixed(3)} SOL, auto-tops-up dry arms` : 'balance unavailable'}</i>
			</div>`
		: '';
	$('xp-summary').innerHTML = `
		<div class="xp-tiles">
			<div class="cv-card xp-tile"><span>Armed strategies</span><b>${active.length}</b><i>${experiments.length - active.length} paused</i></div>
			<div class="cv-card xp-tile"><span>Closed trades</span><b>${totalTrades}</b><i>${experiments.reduce((a, x) => a + x.open, 0)} open now</i></div>
			<div class="cv-card xp-tile"><span>Fleet realized P&amp;L</span><b class="${pnlClass(totalPnl)}">${esc(sol(totalPnl))}</b><i>window: ${esc(windowKey)}</i></div>
			<div class="cv-card xp-tile"><span>Fleet SOL on hand</span><b>${fleetSol.toFixed(3)} SOL</b><i>across ${experiments.filter((x) => x.wallet_address).length} wallets</i></div>
			<div class="cv-card xp-tile"><span>Best arm</span><b>${best ? esc(best.label) : 'no trades yet'}</b><i>${best ? esc(sol(best.realized_pnl_sol)) : 'waiting on fills'}</i></div>
			${earnedTile(experiments)}
			${masterTile}
		</div>`;
}

function renderBoard(experiments) {
	if (!experiments.length) {
		$('xp-board').innerHTML = `
			<div class="cv-card" style="text-align:center;padding:32px">
				<p style="margin:0 0 6px;font-weight:600">No strategies armed on this network yet</p>
				<p style="margin:0;color:var(--cv-text-3)">Arm an agent on <a href="/arm">/arm</a> and its record shows up here automatically.</p>
			</div>`;
		return;
	}
	const rows = experiments
		.map((x) => {
			const record = x.closed > 0 ? `${x.wins}W · ${x.losses}L` : 'no fills';
			const paper = x.paper_closed > 0 || x.paper_open > 0
				? `<div class="xp-paper" title="Simulate-mode record: real quotes, no broadcast">paper: ${x.paper_wins}W · ${x.paper_closed - x.paper_wins}L${x.paper_open ? ` · ${x.paper_open} open` : ''} · ${esc(sol(x.paper_pnl_sol))}</div>`
				: '';
			return `
			<tr class="${x.enabled ? '' : 'xp-off'}">
				<td>
					<div class="xp-label">${esc(x.label)}${x.enabled ? '' : ' <span class="xp-paused">paused</span>'}${tierBadge(x)}</div>
					<div class="xp-agent"><a href="/a/${esc(x.agent_id)}">${esc(x.agent_name || 'agent')}</a> ${modeBadge(x)} · <a href="${esc(x.ledger_url)}" title="Full decision-by-decision reasoning ledger, tamper-evident and on-chain anchored">ledger →</a></div>
					${walletLine(x)}
				</td>
				<td class="xp-cond">${esc(x.conditions)}<div class="xp-cond-sub">${esc(String(x.per_trade_sol ?? '·'))} SOL/trade · ${esc(exitLine(x))}</div></td>
				<td>${esc(record)}${x.open > 0 ? ` <span class="xp-open">+${x.open} open</span>` : ''}${paper}</td>
				<td>${x.win_rate != null ? esc(String(x.win_rate)) + '%' : '·'}</td>
				<td class="${pnlClass(x.realized_pnl_sol)}">${esc(sol(x.realized_pnl_sol))}</td>
				<td class="${pnlClass(x.roi_pct)}">${esc(pct(x.roi_pct))}</td>
				<td class="${pnlClass(x.avg_pnl_pct)}">${esc(pct(x.avg_pnl_pct))}</td>
				<td>${esc(holdFmt(x.avg_hold_seconds))}</td>
				<td>${esc(ago(x.last_closed_at))}</td>
			</tr>`;
		})
		.join('');
	$('xp-board').innerHTML = `
		<div class="cv-card" style="overflow-x:auto">
			<table class="cv-table xp-table">
				<thead>
					<tr>
						<th>Strategy</th><th>Entry conditions</th><th>Record</th><th>Win rate</th>
						<th>Realized</th><th>ROI</th><th>Avg trade</th><th>Avg hold</th><th>Last trade</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

function renderJudgment(judgment) {
	const el = $('xp-judgment');
	if (!el) return;
	if (!judgment || !judgment.length) {
		el.innerHTML = '';
		return;
	}
	const rows = judgment
		.map((j) => `
		<tr>
			<td class="xp-label">${esc(j.model.split('/').pop())}<div class="xp-cond-sub">${esc(j.model)}</div></td>
			<td>${j.verdicts}</td>
			<td>${j.verdicts > 0 ? Math.round((j.buy_calls / j.verdicts) * 100) + '%' : '·'} <span class="xp-cond-sub" style="display:inline">(${j.buy_calls})</span></td>
			<td>${j.avg_confidence != null ? Math.round(j.avg_confidence * 100) + '%' : '·'}</td>
			<td class="${j.buy_precision_pct != null ? (j.buy_precision_pct >= 50 ? 'xp-pos' : 'xp-neg') : ''}">${j.buy_precision_pct != null ? j.buy_precision_pct + '%' : 'awaiting outcomes'} <span class="xp-cond-sub" style="display:inline">${j.buys_scored ? `(${j.buy_hits}/${j.buys_scored})` : ''}</span></td>
			<td>${j.missed_winner_pct != null ? j.missed_winner_pct + '%' : '·'} <span class="xp-cond-sub" style="display:inline">${j.skips_scored ? `(${j.missed_winners}/${j.skips_scored})` : ''}</span></td>
			<td>${j.avg_latency_ms != null ? (j.avg_latency_ms / 1000).toFixed(1) + 's' : '·'}</td>
		</tr>`)
		.join('');
	el.innerHTML = `
		<h2 class="cv-h2">Judgment ledger</h2>
		<p style="margin:4px 0 12px;color:var(--cv-text-3);font-size:13px">
			Every verdict the LLM judges render is recorded, buys and skips alike, then scored
			against what the coin actually did an hour later. This measures each model's calls
			independent of position size: a "hit" is a coin that pumped 3x or graduated.
		</p>
		<div class="cv-card" style="overflow-x:auto">
			<table class="cv-table xp-table" style="min-width:720px">
				<thead>
					<tr>
						<th>Model</th><th>Verdicts</th><th>Buy rate</th><th>Avg conf</th>
						<th>Buy precision</th><th>Missed winners</th><th>Latency</th>
					</tr>
				</thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

async function refresh() {
	try {
		const data = await getJson(`/api/sniper/experiments?network=mainnet&window=${encodeURIComponent(windowKey)}`);
		renderSummary(data.experiments, data.master_wallet);
		renderBoard(data.experiments);
		renderJudgment(data.judgment);
		$('xp-updated').textContent = `Updated ${new Date(data.t).toLocaleTimeString()} · real on-chain fills only`;
	} catch (err) {
		$('xp-board').innerHTML = `
			<div class="cv-card" style="text-align:center;padding:32px">
				<p style="margin:0 0 6px;font-weight:600">Couldn't load the scoreboard</p>
				<p style="margin:0;color:var(--cv-text-3)">${esc(err.message)}. Retrying automatically.</p>
			</div>`;
	}
}

function injectStyles() {
	const css = `
	.xp-seg{display:inline-flex;gap:4px;background:var(--cv-bg-2,rgba(255,255,255,.04));border:1px solid var(--cv-border,rgba(255,255,255,.08));border-radius:10px;padding:3px}
	.xp-seg-btn{appearance:none;border:0;background:transparent;color:var(--cv-text-2,#aaa);font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s}
	.xp-seg-btn:hover{color:var(--cv-text,#eee)}
	.xp-seg-btn:focus-visible{outline:2px solid var(--cv-accent,#7c6cff);outline-offset:1px}
	.xp-seg-btn.on{background:var(--cv-bg-3,rgba(255,255,255,.09));color:var(--cv-text,#fff)}
	.xp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
	.xp-tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px}
	.xp-tile span{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--cv-text-3,#888)}
	.xp-tile b{font-size:19px;font-weight:650}
	.xp-tile i{font-style:normal;font-size:12px;color:var(--cv-text-3,#888)}
	.xp-table{width:100%;border-collapse:collapse;font-size:13px;min-width:860px}
	.xp-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--cv-text-3,#888);padding:8px 10px;border-bottom:1px solid var(--cv-border,rgba(255,255,255,.08))}
	.xp-table td{padding:10px;border-bottom:1px solid var(--cv-border,rgba(255,255,255,.05));vertical-align:top}
	.xp-table tr:last-child td{border-bottom:0}
	.xp-table tr:hover td{background:var(--cv-bg-2,rgba(255,255,255,.03))}
	.xp-label{font-weight:600}
	.xp-agent{font-size:12px;color:var(--cv-text-3,#888);margin-top:2px}
	.xp-agent a{color:inherit}
	.xp-agent a:hover{color:var(--cv-text,#eee)}
	.xp-wallet{font-size:11px;color:var(--cv-text-3,#888);margin-top:3px;display:flex;gap:6px;align-items:baseline;font-variant-numeric:tabular-nums}
	.xp-wallet a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--cv-border,rgba(255,255,255,.25))}
	.xp-wallet a:hover{color:var(--cv-text,#eee)}
	.xp-wallet-none{opacity:.6}
	.xp-cond{max-width:300px;color:var(--cv-text-2,#bbb)}
	.xp-cond-sub{font-size:11.5px;color:var(--cv-text-3,#888);margin-top:3px}
	.xp-badge{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--cv-border,rgba(255,255,255,.12));vertical-align:1px}
	.xp-badge-llm{color:#c9b8ff;border-color:rgba(150,120,255,.4)}
	.xp-badge-rules{color:var(--cv-text-3,#999)}
	.xp-pos{color:#4ade80}
	.xp-neg{color:#f87171}
	.xp-open{font-size:11px;color:#93c5fd}
	.xp-paper{font-size:11px;color:var(--cv-text-3,#888);margin-top:3px}
	.xp-paused{font-size:10.5px;color:var(--cv-text-3,#888);font-weight:400}
	.xp-off td{opacity:.55}
	`;
	const el = document.createElement('style');
	el.textContent = css;
	document.head.appendChild(el);
}

injectStyles();
renderControls();
refresh();
timer = setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		clearInterval(timer);
		timer = null;
	} else if (!timer) {
		refresh();
		timer = setInterval(refresh, REFRESH_MS);
	}
});
