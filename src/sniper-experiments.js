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

function modeBadge(x) {
	if (x.decision_mode === 'llm') {
		return `<span class="xp-badge xp-badge-llm" title="No rule shields: an LLM judges each launch">LLM · ${esc((x.llm_model || 'auto').split('/').pop())}</span>`;
	}
	return `<span class="xp-badge xp-badge-rules">rules</span>`;
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

function renderSummary(experiments) {
	const active = experiments.filter((x) => x.enabled);
	const traded = experiments.filter((x) => x.closed > 0);
	const totalPnl = experiments.reduce((a, x) => a + (Number(x.realized_pnl_sol) || 0), 0);
	const totalTrades = experiments.reduce((a, x) => a + x.closed, 0);
	const best = traded.slice().sort((a, b) => (b.realized_pnl_sol || 0) - (a.realized_pnl_sol || 0))[0];
	$('xp-summary').innerHTML = `
		<div class="xp-tiles">
			<div class="cv-card xp-tile"><span>Armed strategies</span><b>${active.length}</b><i>${experiments.length - active.length} paused</i></div>
			<div class="cv-card xp-tile"><span>Closed trades</span><b>${totalTrades}</b><i>${experiments.reduce((a, x) => a + x.open, 0)} open now</i></div>
			<div class="cv-card xp-tile"><span>Fleet realized P&amp;L</span><b class="${pnlClass(totalPnl)}">${esc(sol(totalPnl))}</b><i>window: ${esc(windowKey)}</i></div>
			<div class="cv-card xp-tile"><span>Best arm</span><b>${best ? esc(best.label) : 'no trades yet'}</b><i>${best ? esc(sol(best.realized_pnl_sol)) : 'waiting on fills'}</i></div>
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
					<div class="xp-label">${esc(x.label)}${x.enabled ? '' : ' <span class="xp-paused">paused</span>'}</div>
					<div class="xp-agent"><a href="/a/${esc(x.agent_id)}">${esc(x.agent_name || 'agent')}</a> ${modeBadge(x)}</div>
				</td>
				<td class="xp-cond">${esc(x.conditions)}<div class="xp-cond-sub">${esc(String(x.per_trade_sol ?? '·'))} SOL/trade · SL ${esc(pct(-Math.abs(x.stop_loss_pct ?? 0), false))}${x.trailing_stop_pct != null ? ` · trail ${esc(pct(x.trailing_stop_pct, false))}` : ''}${x.max_hold_seconds != null ? ` · max ${esc(holdFmt(x.max_hold_seconds))}` : ''}</div></td>
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
		renderSummary(data.experiments);
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
