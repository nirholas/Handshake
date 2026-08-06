// Arm your agent — standalone automation setup (the trading-bot config surface).
// Reuses the Oracle watch API: /api/agents, /api/oracle/watch, /api/oracle/test-alert.
// Self-contained: no imports from oracle.js so this page stands on its own.

import { ensureRiskAck } from './shared/risk-ack.js';

const NETWORK = 'mainnet';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const CATEGORIES = ['meme', 'tech', 'ai', 'culture', 'community', 'political', 'news', 'animal', 'celebrity', 'utility', 'unknown'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSol = (n) => (n == null ? '—' : `${Number(n) < 0.01 && Number(n) > 0 ? Number(n).toFixed(4) : Number(n).toFixed(2)}◎`);
const tierPill = (t) => `tp-${t || 'avoid'}`;
function ago(ts) {
	if (!ts) return '—';
	const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
	if (s < 60) return `${Math.floor(s)}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

const state = { agents: [], agentId: null, watch: null, minScore: 72, wallet: null, feed: [], feedAt: null, edge: null };
let feedTimer = null;

async function api(path, opts = {}) {
	const ctrl = new AbortController();
	const to = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
	try {
		const res = await fetch(path, { credentials: 'include', signal: ctrl.signal, ...opts });
		const data = await res.json().catch(() => null);
		return { ok: res.ok, status: res.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	} finally {
		clearTimeout(to);
	}
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot() {
	wireStaticControls();
	showSkeletons();
	const { ok, data } = await api('/api/agents');
	const agents = ok && data ? (data.agents || data.items || data || []) : [];
	state.agents = Array.isArray(agents) ? agents : [];

	if (!state.agents.length) {
		$('#setup').style.display = 'none';
		$('#statsStrip').style.display = 'none';
		$('#ledgerCard').style.display = 'none';
		$('.layout').style.display = 'none';
		$('#emptyState').style.display = 'block';
		return;
	}

	const sel = $('#agentSel');
	sel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('');
	sel.addEventListener('change', () => loadWatch(sel.value));
	state.agentId = state.agents[0].id;

	loadEdge();        // 30-day proof-of-edge for the conviction bar (global)
	startFeedLoop();   // live "clearing your bar" preview (global, polls)
	loadWatch(state.agentId);
}

// Skeleton placeholders so nothing renders as a dead "—" while real data loads.
function showSkeletons() {
	['#statWin', '#statPnl', '#statOpen', '#statTotal'].forEach((id) => {
		const el = $(id); el.classList.add('sk'); el.textContent = '00%';
	});
	$('#edgeReadout').innerHTML = '<div class="e-note">Loading 30-day track record for this bar…</div>';
	$('#qualBody').innerHTML = '<div class="qual-empty">Reading the live conviction stream…</div>';
	$('#ledgerBody').innerHTML = skeletonLedger();
}

function skeletonLedger() {
	const row = `<div style="display:flex;gap:10px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
		<span class="sk" style="height:13px;flex:1"></span><span class="sk" style="height:13px;width:42px"></span><span class="sk" style="height:13px;width:50px"></span></div>`;
	return row.repeat(4);
}

// Controls that exist in the static markup (segmented + toggles + chips + buttons).
function wireStaticControls() {
	// narrative chips
	$('#catChips').innerHTML = CATEGORIES.map((c) => `<button type="button" class="cchip" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
	$('#catChips').addEventListener('click', (e) => {
		const b = e.target.closest('.cchip');
		if (b) { b.classList.toggle('on'); markDirty(); renderQualifying(); }
	});

	// min-conviction segmented
	$('#convSeg').addEventListener('click', (e) => {
		const b = e.target.closest('button[data-min]');
		if (!b) return;
		$$('#convSeg button').forEach((x) => x.classList.toggle('on', x === b));
		state.minScore = Number(b.dataset.min);
		markDirty();
		renderEdge();
		renderQualifying();
	});

	// mode segmented (simulate / live)
	$('#modeSeg').addEventListener('click', (e) => {
		const b = e.target.closest('button[data-mode]');
		if (!b) return;
		const live = b.dataset.mode === 'live';
		$$('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
		$('#modeSeg').classList.toggle('live-on', live);
		updateArmStatus();
		markDirty();
	});

	wireSwitch('#smartToggle', renderQualifying);
	wireSwitch('#scaleToggle', () => { renderScaleSub(); renderQualifying(); });
	wireSwitch('#armToggle', updateArmStatus);

	['#fSize', '#fDaily', '#fOpen'].forEach((s) => $(s).addEventListener('input', () => {
		renderScaleSub(); renderRisk(); renderWalletRunway(); renderQualifying(); markDirty();
	}));

	$('#saveBtn').addEventListener('click', saveWatch);
	$('#tgTest').addEventListener('click', sendTelegramTest);
	$('#tgInput').addEventListener('input', markDirty);
}

function wireSwitch(sel, cb) {
	const el = $(sel);
	el.addEventListener('click', () => {
		const on = !el.classList.contains('on');
		el.classList.toggle('on', on);
		el.setAttribute('aria-checked', String(on));
		markDirty();
		if (cb) cb(on);
	});
}
function setSwitch(sel, on) { const el = $(sel); el.classList.toggle('on', !!on); el.setAttribute('aria-checked', String(!!on)); }
function isOn(sel) { return $(sel).classList.contains('on'); }

function markDirty() {
	const btn = $('#saveBtn');
	if (btn.dataset.dirty === '1') return;
	btn.dataset.dirty = '1';
	btn.classList.add('dirty');
	$('#saveNote').textContent = '';
}

// ── derived UI ────────────────────────────────────────────────────────────────
function modeIsLive() { return $('#modeSeg').classList.contains('live-on'); }

function updateArmStatus() {
	const armed = isOn('#armToggle');
	const live = modeIsLive();
	const dot = $('#armStatusDot');
	const lab = $('#armStatusLab');
	const sub = $('#armStatusSub');
	dot.className = 'arm-dot ' + (armed ? (live ? 'live' : 'sim') : 'off');
	if (!armed) {
		lab.textContent = 'Disarmed';
		sub.textContent = 'Your agent is idle. Flip the switch to start watching the conviction stream.';
	} else if (live) {
		lab.textContent = 'Armed · Live';
		sub.textContent = 'Spending real SOL from the agent wallet when a coin clears your bar — capped by your limits.';
	} else {
		lab.textContent = 'Armed · Simulate';
		sub.textContent = 'Logging every play it would take, risk-free. Outcomes get graded so you can trust it before going live.';
	}
}

function renderScaleSub() {
	const base = Number($('#fSize').value) || 0.05;
	$('#scaleSub').textContent = isOn('#scaleToggle')
		? `${base.toFixed(3)} SOL at your floor → up to ${(base * 1.5).toFixed(3)} SOL at score 100`
		: 'Off — every qualifying play uses the same size';
}

function renderRisk() {
	const el = $('#riskSummary');
	const size = Number($('#fSize').value) || 0;
	const daily = Number($('#fDaily').value) || 0;
	const open = Number($('#fOpen').value) || 0;
	if (!(size > 0 && daily > 0)) {
		el.textContent = 'Set a per-trade size and daily cap to see your exposure.';
		return;
	}
	const trades = Math.floor(daily / size);
	let txt = `≈ ${trades} ${trades === 1 ? 'buy' : 'buys'}/day max · up to ${fmtSol(daily)} deployed · ${open} position${open === 1 ? '' : 's'} open at once`;
	const w = state.wallet;
	if (w && w.sol != null) {
		if (w.sol < size) {
			txt += ` · <b style="color:var(--amber)">wallet holds ${fmtSol(w.sol)} — fund it before going live</b>`;
		} else if (w.sol < daily) {
			txt += ` · wallet covers ≈ ${Math.floor(w.sol / size)} ${Math.floor(w.sol / size) === 1 ? 'trade' : 'trades'} before it's dry`;
		}
	}
	el.innerHTML = txt;
}

// ── agent wallet balance + runway ───────────────────────────────────────────────
async function loadWallet(agentId) {
	const pill = $('#walletPill');
	const bal = $('#walletBal');
	pill.hidden = false;
	pill.classList.remove('low');
	$('#walletFund').href = `/agent/${encodeURIComponent(agentId)}/wallet#deposit`;
	$('#walletRun').textContent = '';
	bal.classList.add('sk'); bal.textContent = '0.00◎';
	state.wallet = null;

	const { ok, data } = await api(`/api/agents/${encodeURIComponent(agentId)}/wallet`);
	bal.classList.remove('sk');
	if (ok && data) {
		const sol = data.solana_balance == null ? null : Number(data.solana_balance);
		state.wallet = { sol, address: data.solana_address || null };
		bal.textContent = sol == null ? '—' : fmtSol(sol);
	} else {
		bal.textContent = '—';
	}
	renderWalletRunway();
	renderRisk();
}

function renderWalletRunway() {
	const run = $('#walletRun');
	const pill = $('#walletPill');
	pill.classList.remove('low');
	const w = state.wallet;
	if (!w || w.sol == null) { run.textContent = ''; return; }
	const size = Number($('#fSize').value) || 0.05;
	const trades = size > 0 ? Math.floor(w.sol / size) : 0;
	run.textContent = `· ${trades} ${trades === 1 ? 'trade' : 'trades'} left`;
	if (w.sol < size) pill.classList.add('low');
}

// ── proof of edge: 30-day backtest for the chosen bar ───────────────────────────
async function loadEdge() {
	const { ok, data } = await api(`/api/oracle/backtest?period=30d&network=${NETWORK}`);
	state.edge = ok && data && Array.isArray(data.by_tier) ? data : null;
	renderEdge();
}

function includedTiers(minScore) {
	if (minScore >= 86) return ['prime'];
	if (minScore >= 72) return ['prime', 'strong'];
	return ['prime', 'strong', 'lean'];
}

function renderEdge() {
	const el = $('#edgeReadout');
	const e = state.edge;
	if (!e) {
		el.innerHTML = '<div class="e-note">Edge stats are warming up — historical win rates for this bar will show here.</div>';
		return;
	}
	const inc = new Set(includedTiers(state.minScore));
	const agg = { wins: 0, losses: 0, threeX: 0, athSum: 0, athN: 0 };
	for (const t of e.by_tier) {
		if (!inc.has(t.tier)) continue;
		agg.wins += t.wins || 0;
		agg.losses += t.losses || 0;
		agg.threeX += t.three_x || 0;
		if (t.avg_ath) { agg.athSum += t.avg_ath * (t.total || 0); agg.athN += t.total || 0; }
	}
	const resolved = agg.wins + agg.losses;
	const label = state.minScore >= 86 ? 'Prime' : state.minScore >= 72 ? 'Strong+' : 'Lean+';
	if (!resolved) {
		el.innerHTML = `<div class="e-note">Not enough resolved coins at the <b>${label}</b> bar in the last 30 days to show a win rate yet. Lower the floor for a larger sample.</div>`;
		return;
	}
	const wr = Math.round((agg.wins / resolved) * 100);
	const avgAth = agg.athN ? agg.athSum / agg.athN : null;
	el.innerHTML = `
		<div class="e-stat"><b>${wr}%</b><span>win rate</span></div>
		${avgAth ? `<div class="e-stat"><b>${avgAth.toFixed(1)}×</b><span>avg peak</span></div>` : ''}
		<div class="e-stat"><b>${agg.threeX}</b><span>hit 3×+</span></div>
		<div class="e-stat"><b>${resolved}</b><span>resolved</span></div>
		<div class="e-note">Last 30 days at your <b>${label}</b> bar. A win = graduated or ≥2× from the score. Past results aren't a promise.</div>`;
}

// ── live "clearing your bar" preview ────────────────────────────────────────────
async function startFeedLoop() {
	await loadFeed();
	feedTimer = setInterval(loadFeed, 20000);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) { clearInterval(feedTimer); feedTimer = null; }
		else if (!feedTimer) { loadFeed(); feedTimer = setInterval(loadFeed, 20000); }
	});
}

async function loadFeed() {
	const { ok, data } = await api(`/api/oracle/feed?network=${NETWORK}&limit=80`);
	if (ok && data && Array.isArray(data.items)) {
		state.feed = data.items;
		state.feedAt = Date.now();
	}
	renderQualifying();
}

function currentRules() {
	return {
		minScore: state.minScore,
		cats: new Set($$('#catChips .cchip.on').map((b) => b.dataset.cat)),
		requireSmart: isOn('#smartToggle'),
		size: Number($('#fSize').value) || 0.05,
		scaling: isOn('#scaleToggle'),
	};
}

function scaledSize(base, score) {
	const floor = state.minScore;
	if (score <= floor) return base;
	const t = Math.min(1, (score - floor) / (100 - floor || 1));
	return base * (1 + 0.5 * t);
}

function renderQualifying() {
	const body = $('#qualBody');
	const countEl = $('#qualCount');
	const metaEl = $('#qualMeta');
	if (!Array.isArray(state.feed)) return;
	const r = currentRules();
	const matches = state.feed
		.filter((it) =>
			Number(it.score) >= r.minScore &&
			(r.cats.size === 0 || r.cats.has(it.category)) &&
			(!r.requireSmart || (it.smart_wallet_count || 0) >= 1))
		.sort((a, b) => b.score - a.score);

	countEl.textContent = matches.length
		? `${matches.length} clearing your bar`
		: 'Nothing clears your bar right now';
	metaEl.textContent = state.feed.length ? `live · ${state.feed.length} scored / 12h` : '';

	if (!matches.length) {
		body.innerHTML = `<div class="qual-empty">No live coin meets every rule this moment — normal for a tight bar. Loosen the conviction floor or widen narratives to see more flow, or keep it strict and let your agent wait for the real ones.</div>`;
		return;
	}
	body.innerHTML = matches.slice(0, 8).map((it) => qualRow(it, r)).join('');
}

function qualRow(it, r) {
	const sym = esc(it.symbol || (it.mint || '').slice(0, 6));
	const img = it.image_uri
		? `<img class="coinimg" src="${esc(it.image_uri)}" alt="" loading="lazy" data-fallback="remove">`
		: '';
	const smart = (it.smart_wallet_count || 0) >= 1
		? `<span class="q-smart">${it.smart_wallet_count} smart in</span>`
		: 'no smart money';
	const cat = it.category ? esc(it.category) : '—';
	const size = r.scaling ? scaledSize(r.size, Number(it.score)) : r.size;
	return `<div class="qrow">
		<div class="q-main">
			<div class="q-sym">${img}<a href="https://pump.fun/coin/${esc(it.mint)}" target="_blank" rel="noopener">${sym}</a><span class="tierpill ${tierPill(it.tier)}">${esc(it.tier || '—')}</span></div>
			<div class="q-sub"><span>${cat}</span><span>${smart}</span><span>${ago(it.scored_at)} ago</span></div>
		</div>
		<div class="q-score ${Number(it.score) >= 86 ? 'hi' : ''}">${esc(it.score)}</div>
		<div class="q-size"><span>would buy</span>${fmtSol(size)}</div>
	</div>`;
}

// ── load current config ───────────────────────────────────────────────────────
async function loadWatch(agentId) {
	state.agentId = agentId;
	$('#saveNote').textContent = '';
	const { ok, data } = await api(`/api/oracle/watch?agent_id=${encodeURIComponent(agentId)}&network=${NETWORK}`);
	const w = ok && data ? data.watch : null;
	state.watch = w;

	const min = w ? (w.min_score >= 86 ? 86 : w.min_score >= 72 ? 72 : 56) : 72;
	state.minScore = min;
	$$('#convSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === min));

	$('#fSize').value = w?.per_trade_sol ?? 0.05;
	$('#fDaily').value = w?.max_daily_sol ?? 0.5;
	$('#fOpen').value = w?.max_open ?? 5;

	setSwitch('#smartToggle', w ? w.require_smart_money !== false : true);
	setSwitch('#scaleToggle', !!w?.size_scaling);
	setSwitch('#armToggle', !!w?.armed);

	const live = w?.mode === 'live';
	$$('#modeSeg button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'live') === live));
	$('#modeSeg').classList.toggle('live-on', live);

	const cats = new Set(w?.categories || []);
	$$('#catChips .cchip').forEach((b) => b.classList.toggle('on', cats.has(b.dataset.cat)));
	$('#tgInput').value = w?.telegram_chat_id || '';

	renderScaleSub();
	renderRisk();
	updateArmStatus();
	renderEdge();
	renderQualifying();
	$('#saveBtn').dataset.dirty = '0';
	$('#saveBtn').classList.remove('dirty');

	loadWallet(agentId);
	loadActions(agentId);
}

async function saveWatch() {
	// Arming in live mode commits the agent's real SOL — gate on the risk ack.
	if (modeIsLive() && isOn('#armToggle') && !(await ensureRiskAck({ context: 'oracle-arm' }))) return;
	const btn = $('#saveBtn');
	btn.disabled = true; btn.textContent = 'Saving…';
	const cats = $$('#catChips .cchip.on').map((b) => b.dataset.cat);
	const min = state.minScore;
	const payload = {
		agent_id: state.agentId, network: NETWORK,
		armed: isOn('#armToggle'),
		mode: modeIsLive() ? 'live' : 'simulate',
		min_score: min, min_tier: min >= 86 ? 'prime' : min >= 72 ? 'strong' : 'lean',
		categories: cats,
		per_trade_sol: Number($('#fSize').value) || 0.05,
		max_daily_sol: Number($('#fDaily').value) || 0.5,
		max_open: Number($('#fOpen').value) || 5,
		require_smart_money: isOn('#smartToggle'),
		size_scaling: isOn('#scaleToggle'),
		telegram_chat_id: ($('#tgInput').value || '').trim() || null,
	};
	const { ok, data } = await api('/api/oracle/watch', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
	});
	btn.disabled = false; btn.textContent = 'Save configuration';
	const note = $('#saveNote');
	if (ok && data?.watch) {
		state.watch = data.watch;
		btn.dataset.dirty = '0'; btn.classList.remove('dirty');
		const tg = data.watch.telegram_chat_id ? ' Telegram alerts active.' : '';
		note.className = 'save-note ok';
		note.textContent = data.watch.armed
			? `✓ Armed in ${data.watch.mode} mode — your agent is watching the stream.${tg}`
			: `✓ Saved. Flip “Armed” when you’re ready to start watching.${tg}`;
		// reflect any server-side clamping
		$('#fSize').value = data.watch.per_trade_sol;
		$('#fDaily').value = data.watch.max_daily_sol;
		$('#fOpen').value = data.watch.max_open;
		renderRisk();
		loadActions(state.agentId);
	} else {
		note.className = 'save-note warn';
		note.textContent = data?.error?.message || 'Could not save — sign in and make sure you own this agent.';
	}
}

async function sendTelegramTest() {
	const chatId = ($('#tgInput').value || '').trim();
	const note = $('#tgNote');
	note.style.display = 'block';
	if (!chatId) {
		note.className = 'tg-note warn';
		note.textContent = 'Enter your Telegram chat ID or @channel first.';
		return;
	}
	const btn = $('#tgTest');
	btn.disabled = true; btn.textContent = 'Sending…';
	const { ok, data } = await api('/api/oracle/test-alert', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agent_id: state.agentId, chat_id: chatId }),
	});
	btn.disabled = false; btn.textContent = 'Send test';
	if (ok && data?.ok) {
		note.className = 'tg-note ok';
		note.textContent = '✓ Test message delivered. Check Telegram.';
	} else {
		note.className = 'tg-note warn';
		note.textContent = (data?.error || 'Delivery failed.') + (data?.hint ? ' ' + data.hint : '');
	}
}

// ── activity ledger ───────────────────────────────────────────────────────────
async function loadActions(agentId) {
	const body = $('#ledgerBody');
	const { ok, data } = await api(`/api/oracle/watch?agent_id=${encodeURIComponent(agentId)}&network=${NETWORK}`);
	const actions = ok && data ? (data.actions || []) : [];
	const s = (ok && data && data.summary) || null;

	// top stat strip
	const setStat = (id, val, cls) => { const el = $(id); el.textContent = val; el.className = 'stat-val' + (cls ? ' ' + cls : ''); };
	if (s && s.total) {
		setStat('#statWin', s.win_rate == null ? '—' : s.win_rate + '%');
		setStat('#statPnl', `${s.realized_pnl_sol >= 0 ? '+' : ''}${fmtSol(s.realized_pnl_sol)}`, s.realized_pnl_sol >= 0 ? 'up' : 'dn');
		setStat('#statOpen', String(s.open ?? 0));
		setStat('#statTotal', String(s.total));
	} else {
		['#statWin', '#statPnl', '#statOpen', '#statTotal'].forEach((id) => setStat(id, '—'));
	}

	if (!actions.length) {
		body.innerHTML = `<div class="ledger-empty">No actions yet — once armed, every buy lands here and gets graded against the outcome in real time.</div>`;
		return;
	}
	const rows = actions.map(actionRow).join('');
	body.innerHTML = `
		<div class="act-wrap">
			<table class="act-table">
				<thead><tr>
					<th scope="col">Coin</th><th scope="col">Tier</th><th scope="col">Conv.</th>
					<th scope="col">Size</th><th scope="col">Outcome</th><th scope="col">PnL</th><th scope="col">When</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>`;
}

function actionRow(a) {
	const outcome = a.outcome || 'open';
	const outCls = outcome === 'win' ? 'up' : outcome === 'loss' ? 'dn' : '';
	const outLabel = outcome === 'win' ? `✓ Win${a.peak_multiple ? ` · ${Number(a.peak_multiple).toFixed(1)}×` : ''}` : outcome === 'loss' ? '✗ Loss' : 'Open';
	const pnl = a.realized_pnl_sol != null ? `${Number(a.realized_pnl_sol) >= 0 ? '+' : ''}${fmtSol(a.realized_pnl_sol)}` : '—';
	const pnlCls = a.realized_pnl_sol != null ? (Number(a.realized_pnl_sol) >= 0 ? 'up' : 'dn') : '';
	const modeBadge = a.mode === 'live' ? '<span class="act-live">live</span>' : '<span class="act-sim">sim</span>';

	let convCell;
	if (outcome === 'open' && a.current_score != null) {
		const entry = Number(a.conviction) || 0;
		const cur = Number(a.current_score);
		const delta = cur - entry;
		const deltaCls = delta > 0 ? 'up' : delta < 0 ? 'dn' : '';
		const deltaStr = delta !== 0 ? `<span class="act-delta ${deltaCls}">${delta > 0 ? '+' : ''}${delta}</span>` : '';
		convCell = `<span class="${tierPill(a.current_tier)}" style="padding:1px 4px;font-size:11px">${cur}</span>${deltaStr}`;
	} else {
		convCell = a.conviction ?? '—';
	}

	return `<tr class="act-row" data-outcome="${esc(outcome)}">
		<td class="act-coin"><a href="https://pump.fun/coin/${esc(a.mint)}" target="_blank" rel="noopener">${esc(a.symbol || (a.mint || '').slice(0, 6))}</a> ${modeBadge}</td>
		<td><span class="tierpill ${tierPill(a.tier)}">${esc(a.tier || '—')}</span></td>
		<td class="act-mono">${convCell}</td>
		<td class="act-mono">${fmtSol(a.size_sol)}</td>
		<td class="act-mono ${outCls}">${outLabel}</td>
		<td class="act-mono ${pnlCls}">${pnl}</td>
		<td class="act-when" title="${esc(a.acted_at || '')}">${ago(a.acted_at)} ago</td>
	</tr>`;
}

document.addEventListener('DOMContentLoaded', boot);
