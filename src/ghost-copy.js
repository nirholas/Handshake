// Ghost-copy page: paper-copy a verified pump.fun leader over their real trades.
//
// Reads /api/pump/ghost-copy (leader universe, then the replay) and renders the
// result with every state designed: loading, empty, error, populated. State lives
// in the URL (?leader&budget&window) so a result is deep-linkable and shareable,
// which is the entire point: the artifact travels, the referral comes back.
//
// The page itself signs and spends nothing: the replay is arithmetic over trades
// that already happened. The one live action is Fork (src/fork-trade.js) on a
// position the leader is STILL holding. That opens the real pump.fun trade
// panel at your ghost size, and your own wallet signs it. Everything else is a
// link out to the leader's verified record or the guardrailed copy surface at
// /vaults.

import { initFork, forkButton } from './fork-trade.js';

const leadersEl = document.getElementById('gcLeaders');
const resultEl = document.getElementById('gcResult');
const budgetEl = document.getElementById('gcBudget');
const windowSeg = document.getElementById('gcWindowSeg');
const toastEl = document.getElementById('gcToast');

const WINDOW_LABEL = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'their whole history' };

const state = {
	leader: null,
	budget: 1,
	window: '7d',
};
let leaders = [];
let runSeq = 0;

// ── helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
	return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}
function sol(n, dp = 4) {
	if (n == null || !Number.isFinite(Number(n))) return '-';
	return Number(n).toFixed(dp).replace(/\.?0+$/, '') || '0';
}
function signed(n, dp = 4) {
	if (n == null || !Number.isFinite(Number(n))) return '-';
	const v = Number(n);
	return `${v > 0 ? '+' : ''}${sol(v, dp)}`;
}
function pct(n, dp = 1) {
	if (n == null || !Number.isFinite(Number(n))) return '-';
	return `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
}
function tone(n) {
	if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return 'flat';
	return Number(n) > 0 ? 'pos' : 'neg';
}
function duration(seconds) {
	if (seconds == null) return '-';
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86400).toFixed(1)}d`;
}
function shortDate(iso) {
	if (!iso) return '-';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function coinCell(mint, symbol, name) {
	const label = symbol ? `$${esc(symbol)}` : `${esc(String(mint || '').slice(0, 6))}…`;
	return `<td class="gc-coin">${label}${name ? `<small>${esc(name)}</small>` : ''}</td>`;
}
function toast(msg) {
	toastEl.textContent = msg;
	toastEl.classList.add('show');
	clearTimeout(toast._t);
	toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// ── URL state ───────────────────────────────────────────────────────────────

function readUrl() {
	const q = new URLSearchParams(location.search);
	const b = Number(q.get('budget'));
	if (Number.isFinite(b) && b > 0) state.budget = b;
	if (['24h', '7d', '30d', 'all'].includes(q.get('window'))) state.window = q.get('window');
	const l = q.get('leader');
	if (l) state.leader = l;
}

function writeUrl() {
	const q = new URLSearchParams();
	if (state.leader) q.set('leader', state.leader);
	q.set('budget', String(state.budget));
	q.set('window', state.window);
	history.replaceState(null, '', `${location.pathname}?${q}`);
}

// ── leader picker ───────────────────────────────────────────────────────────

function renderLeaders() {
	if (!leaders.length) {
		leadersEl.innerHTML = `
			<div class="gc-empty" style="grid-column: 1 / -1;">
				<h3>No settled track records in this window yet</h3>
				<p>Ghost-copy only replays agents with at least one closed on-chain round-trip, so there is nothing to fake. Widen the window to all time, or watch the agents that are trading right now.</p>
				<a href="/leaderboard">Open the trader leaderboard</a>
			</div>`;
		return;
	}
	leadersEl.innerHTML = leaders.map((l) => {
		const selected = l.agent_id === state.leader;
		const avatar = l.avatar
			? `<img class="gc-ava" src="${esc(l.avatar)}" alt="" loading="lazy" width="36" height="36" />`
			: `<span class="gc-ava" aria-hidden="true">${esc(initials(l.name))}</span>`;
		return `
			<button type="button" class="gc-leader" data-id="${esc(l.agent_id)}" aria-pressed="${selected}">
				${avatar}
				<span class="gc-leader-meta">
					<span class="gc-leader-name">${esc(l.name)}</span>
					<span class="gc-leader-stats">${l.settled} closed · ${l.win_rate_pct == null ? '-' : `${l.win_rate_pct.toFixed(0)}% win`} · <b class="${tone(l.pnl_sol)}">${signed(l.pnl_sol, 2)} SOL</b></span>
				</span>
			</button>`;
	}).join('');

	for (const btn of leadersEl.querySelectorAll('.gc-leader')) {
		btn.addEventListener('click', () => {
			state.leader = btn.dataset.id;
			renderLeaders();
			writeUrl();
			runGhost();
		});
	}
}

// ── the equity chart ────────────────────────────────────────────────────────

function chart(curve, startSol) {
	const points = (curve || []).filter((p) => Number.isFinite(Number(p.equity_sol)));
	if (points.length < 2) {
		return `<div class="gc-chart-empty">Not enough closed trades in this window to draw a curve.</div>`;
	}
	const W = 720, H = 168, PAD = 10;
	const vals = points.map((p) => Number(p.equity_sol));
	const lo = Math.min(...vals, startSol), hi = Math.max(...vals, startSol);
	const span = hi - lo || Math.max(hi, 1) * 0.02;
	const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
	const y = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

	const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(p.equity_sol)).toFixed(1)}`).join(' ');
	const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
	const end = vals[vals.length - 1];
	const up = end >= startSol;
	const stroke = up ? 'var(--gc-green)' : 'var(--gc-red)';
	const baseY = y(startSol).toFixed(1);
	const gid = `gcgrad-${up ? 'up' : 'dn'}`;

	return `
		<svg class="gc-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
		     aria-label="Ghost equity curve: started at ${sol(startSol, 3)} SOL, ended at ${sol(end, 3)} SOL across ${points.length - 1} closed trades.">
			<defs>
				<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="${stroke}" stop-opacity="0.28" />
					<stop offset="100%" stop-color="${stroke}" stop-opacity="0" />
				</linearGradient>
			</defs>
			<line x1="${PAD}" y1="${baseY}" x2="${W - PAD}" y2="${baseY}" stroke="var(--gc-line)" stroke-width="1" stroke-dasharray="4 4" />
			<path d="${area}" fill="url(#${gid})" />
			<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
			<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3.5" fill="${stroke}" />
		</svg>`;
}

// ── result rendering ────────────────────────────────────────────────────────

function skeleton() {
	resultEl.innerHTML = `
		<div class="gc-skel" aria-hidden="true">
			<div class="gc-skel-block tall"></div>
			<div class="gc-skel-block short"></div>
		</div>
		<span class="sr-only">Replaying this leader's trades against your budget…</span>`;
}

function renderError(msg) {
	resultEl.innerHTML = `
		<div class="gc-error">
			<h3>Could not run the replay</h3>
			<p>${esc(msg || 'The ghost-copy service is unreachable right now.')}</p>
			<button type="button" id="gcRetry">Try again</button>
		</div>`;
	document.getElementById('gcRetry')?.addEventListener('click', runGhost);
}

function renderNoTrades(data) {
	resultEl.innerHTML = `
		<div class="gc-empty">
			<h3>${esc(data.leader.name)} has no closed trades in ${esc(WINDOW_LABEL[data.window] || data.window)}</h3>
			<p>There is nothing to replay, and we will not invent a curve. Try a longer window, or pick another leader.</p>
			<a href="${esc(data.leader.profile_url)}">See their verified record</a>
		</div>`;
}

function tile(label, value, toneClass, sub) {
	return `<div class="gc-tile"><dt>${esc(label)}</dt><dd class="${toneClass || ''}">${value}${sub ? `<small>${esc(sub)}</small>` : ''}</dd></div>`;
}

function renderResult(data) {
	const s = data.summary;
	if (!s.copied && !s.still_open_count) return renderNoTrades(data);

	const t = tone(s.realized_pnl_sol);
	const verdict = `${signed(s.realized_pnl_sol, 4)} SOL`;
	const windowText = WINDOW_LABEL[data.window] || data.window;

	const head = `
		<section class="gc-head">
			<div class="gc-head-top">
				<h2 class="gc-head-name"><a href="${esc(data.leader.profile_url)}">${esc(data.leader.name)}</a></h2>
				<span class="gc-badge paper">paper</span>
				<span class="gc-badge">no custody</span>
				<span class="gc-badge">${esc(data.network)}</span>
			</div>
			<p class="gc-verdict ${t}">${verdict}</p>
			<p class="gc-verdict-sub">
				If you had ghost-copied <b>${esc(data.leader.name)}</b> over ${esc(windowText)} with
				<b>${sol(s.start_sol, 3)} SOL</b>, you would be holding <b>${sol(s.end_sol, 3)} SOL</b> realized
				(${pct(s.realized_pnl_pct)}) across ${s.copied} copied trade${s.copied === 1 ? '' : 's'}.
				${s.still_open_count ? `${s.still_open_count} position${s.still_open_count === 1 ? ' is' : 's are'} still open, marked at the leader's last quote for ${signed(s.unrealized_pnl_sol, 4)} SOL unrealized.` : ''}
			</p>
			${chart(data.equity_curve, s.start_sol)}
			<dl class="gc-tiles">
				${tile('Win rate', s.win_rate_pct == null ? '-' : `${s.win_rate_pct.toFixed(0)}%`, '', `${s.wins}W / ${s.losses}L`)}
				${tile('Best', s.best ? pct(s.best.pnl_pct) : '-', s.best ? tone(s.best.pnl_pct) : '', s.best ? (s.best.symbol ? `$${s.best.symbol}` : 'unnamed coin') : '')}
				${tile('Worst', s.worst ? pct(s.worst.pnl_pct) : '-', s.worst ? tone(s.worst.pnl_pct) : '', s.worst ? (s.worst.symbol ? `$${s.worst.symbol}` : 'unnamed coin') : '')}
				${tile('Max drawdown', s.max_drawdown_pct == null ? '-' : `${s.max_drawdown_pct.toFixed(1)}%`, s.max_drawdown_pct > 0 ? 'neg' : '', 'peak to trough')}
				${tile('Avg hold', duration(s.avg_hold_seconds), '', 'per copied trade')}
				${tile('Skipped', String(s.skipped_count), s.skipped_count ? 'flat' : '', `of ${s.leader_trades} leader trades`)}
			</dl>
			<div class="gc-actions">
				<a class="gc-btn primary" href="/vaults">Go live with a real budget</a>
				<a class="gc-btn" href="${esc(data.leader.profile_url)}">Verify this record on-chain</a>
				<button type="button" class="gc-btn" id="gcShare">Share this result</button>
			</div>
		</section>`;

	const fills = s.copied ? `
		<section class="gc-section">
			<h2>Your ghost trades <span>· ${s.copied} closed round-trip${s.copied === 1 ? '' : 's'}</span></h2>
			<div class="gc-tablewrap">
				<table class="gc-table">
					<thead><tr>
						<th scope="col">Coin</th><th scope="col">Your size</th><th scope="col">Result</th>
						<th scope="col">P&amp;L</th><th scope="col">Held</th><th scope="col">Closed</th><th scope="col">Proof</th>
					</tr></thead>
					<tbody>
						${data.fills.slice().reverse().map((f) => `
							<tr>
								${coinCell(f.mint, f.symbol, f.name)}
								<td class="num">${sol(f.order_sol, 4)} SOL</td>
								<td class="num ${tone(f.pnl_pct)}">${f.multiple != null ? `${f.multiple.toFixed(2)}x` : '-'} <small>${pct(f.pnl_pct)}</small></td>
								<td class="num ${tone(f.pnl_sol)}">${signed(f.pnl_sol, 4)}</td>
								<td class="num">${duration(f.hold_seconds)}</td>
								<td>${esc(shortDate(f.closed_at))}</td>
								<td>${f.sell_sig ? `<a href="https://solscan.io/tx/${esc(f.sell_sig)}" target="_blank" rel="noopener noreferrer">tx</a>` : '-'}</td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
		</section>` : '';

	const stillOpen = s.still_open_count ? `
		<section class="gc-section">
			<h2>Still open <span>· marked at the leader's last on-chain quote, not realized. Fork opens the real trade at your ghost size; your wallet signs it.</span></h2>
			<div class="gc-tablewrap">
				<table class="gc-table">
					<thead><tr><th scope="col">Coin</th><th scope="col">Your size</th><th scope="col">Mark</th><th scope="col">Unrealized</th><th scope="col">Opened</th><th scope="col">For real</th></tr></thead>
					<tbody>
						${data.still_open.map((o) => `
							<tr>
								${coinCell(o.mint, o.symbol, o.name)}
								<td class="num">${sol(o.order_sol, 4)} SOL</td>
								<td class="num ${tone(o.mark_pct)}">${o.mark_pct == null ? 'at cost' : pct(o.mark_pct)}</td>
								<td class="num ${tone(o.unrealized_sol)}">${signed(o.unrealized_sol, 4)}</td>
								<td>${esc(shortDate(o.opened_at))}</td>
								<td>${forkButton({ mint: o.mint, symbol: o.symbol, name: o.name, size: o.order_sol }, { className: 'gc-fork' })}</td>
							</tr>`).join('')}
					</tbody>
				</table>
			</div>
		</section>` : '';

	const skipped = s.skipped_count ? `
		<section class="gc-section">
			<details class="gc-details">
				<summary>${s.skipped_count} trade${s.skipped_count === 1 ? '' : 's'} your budget could not copy, and why</summary>
				<ul class="gc-skips">
					${data.skipped.slice(0, 60).map((k) => `
						<li><b>${k.symbol ? `$${esc(k.symbol)}` : esc(String(k.mint || '').slice(0, 8))}</b> · ${esc(k.reason.replace(/_/g, ' '))}: ${esc(k.detail || 'blocked by your ghost settings')}</li>`).join('')}
				</ul>
				${data.skipped.length > 60 ? `<p class="gc-leader-stats" style="padding-bottom:12px">Showing the first 60 of ${data.skipped.length}.</p>` : ''}
			</details>
		</section>` : '';

	const honesty = `
		<section class="gc-honesty">
			<h2>What this number is, and is not</h2>
			<ul>${data.honesty.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
		</section>`;

	resultEl.innerHTML = head + fills + stillOpen + skipped + honesty;
	document.getElementById('gcShare')?.addEventListener('click', () => share(data));
}

async function share(data) {
	const s = data.summary;
	const url = location.href;
	const text = `Ghost-copied ${data.leader.name} for ${WINDOW_LABEL[data.window] || data.window} with ${sol(s.start_sol, 3)} SOL: ${signed(s.realized_pnl_sol, 4)} SOL (${pct(s.realized_pnl_pct)}) over ${s.copied} trades. Paper, replayed over their real on-chain record.`;
	if (navigator.share) {
		try { await navigator.share({ title: 'Ghost-copy · three.ws', text, url }); return; } catch { /* user dismissed; fall through to copy */ }
	}
	try {
		await navigator.clipboard.writeText(`${text}\n${url}`);
		toast('Result copied to your clipboard');
	} catch {
		toast('Copy the address bar to share this result');
	}
}

// ── data ────────────────────────────────────────────────────────────────────

async function loadLeaders() {
	leadersEl.innerHTML = `<div class="gc-skel-block short" aria-hidden="true"></div><div class="gc-skel-block short" aria-hidden="true"></div><div class="gc-skel-block short" aria-hidden="true"></div>`;
	try {
		const r = await fetch(`/api/pump/ghost-copy?window=${encodeURIComponent(state.window)}&limit=24`, { headers: { accept: 'application/json' } });
		const body = await r.json();
		if (!r.ok) throw new Error(body?.message || `HTTP ${r.status}`);
		leaders = Array.isArray(body.leaders) ? body.leaders : [];
	} catch {
		leaders = [];
	}
	// A deep-linked leader outside the current window's top list still replays;
	// only an empty selection falls back to the board's best performer.
	if (!state.leader && leaders.length) state.leader = leaders[0].agent_id;
	renderLeaders();
}

async function runGhost() {
	if (!state.leader) {
		resultEl.innerHTML = `
			<div class="gc-empty">
				<h3>Pick a leader to replay</h3>
				<p>Choose any agent above. We replay their real closed trades against your budget and show you the curve you would have had.</p>
			</div>`;
		return;
	}
	const seq = ++runSeq;
	skeleton();
	try {
		const q = new URLSearchParams({ leader: state.leader, budget: String(state.budget), window: state.window });
		const r = await fetch(`/api/pump/ghost-copy?${q}`, { headers: { accept: 'application/json' } });
		const body = await r.json();
		if (seq !== runSeq) return;
		if (!r.ok) return renderError(body?.message || `HTTP ${r.status}`);
		renderResult(body);
	} catch (err) {
		if (seq !== runSeq) return;
		renderError(err?.message);
	}
}

// ── wiring ──────────────────────────────────────────────────────────────────

let budgetTimer;
budgetEl.addEventListener('input', () => {
	const v = Number(budgetEl.value);
	if (!Number.isFinite(v) || v <= 0) return;
	state.budget = v;
	clearTimeout(budgetTimer);
	budgetTimer = setTimeout(() => { writeUrl(); runGhost(); }, 350);
});

windowSeg.addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-window]');
	if (!btn || btn.dataset.window === state.window) return;
	state.window = btn.dataset.window;
	for (const b of windowSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
	writeUrl();
	loadLeaders().then(runGhost);
});

readUrl();
// Before writeUrl() rewrites the query string: an inbound ?fork=<mint> link
// opens the real trade panel on arrival.
initFork();
budgetEl.value = String(state.budget);
for (const b of windowSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.window === state.window));
writeUrl();
loadLeaders().then(runGhost);
