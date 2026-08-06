// Trading Swarms — directory + live dashboard.
//
// A swarm pools multiple agents' SOL into one custodial treasury that trades on
// reputation-weighted member consensus and distributes realized profit pro-rata.
// This module renders the public directory, a per-swarm dashboard with a live SSE
// feed of consensus votes + payouts, and the create / join / contribute / exit /
// kill flows — every money action calls a real on-chain endpoint.

import { flashValue } from './ui-juice.js';

const root = document.getElementById('sw-view');
const SOL = (n) => (n == null ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`);
const PCT = (n) => (n == null ? '—' : `${(Number(n) * 100).toFixed(0)}%`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

const state = { network: 'mainnet', agents: null, authed: false };

// Single-use CSRF token for a state-changing call. Never cached: the server
// consumes the token in the same statement that validates it, so a reused one is
// a guaranteed 403 on the next write.
async function csrfToken() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.token || j?.data?.token || null;
	} catch {
		return null;
	}
}

async function api(path, opts = {}) {
	const ctrl = new AbortController();
	const to = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
	try {
		const headers = { ...(opts.headers || {}) };
		// Every swarm mutation moves or governs real funds, so the server requires a
		// CSRF token on cookie-session writes.
		if (opts.method && opts.method.toUpperCase() !== 'GET') {
			const token = await csrfToken();
			if (token) headers['x-csrf-token'] = token;
		}
		const res = await fetch(path, { credentials: 'include', signal: ctrl.signal, ...opts, headers });
		const data = await res.json().catch(() => null);
		return { ok: res.ok, status: res.status, data: data?.data ?? data, error: res.ok ? null : data?.message || data?.error || `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, status: 0, data: null, error: e?.name === 'AbortError' ? 'request timed out' : 'network error' };
	} finally {
		clearTimeout(to);
	}
}

function toast(msg, isErr = false) {
	const t = document.createElement('div');
	t.className = 'sw-toast' + (isErr ? ' err' : '');
	t.textContent = msg;
	document.body.appendChild(t);
	setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, isErr ? 5200 : 3400);
}

async function loadAgents() {
	if (state.agents) return state.agents;
	const r = await api('/api/agents');
	const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.agents) ? r.data.agents : [];
	state.agents = list.map((a) => ({ id: a.id, name: a.name || 'Agent' }));
	state.authed = r.ok;
	return state.agents;
}

// ── router ────────────────────────────────────────────────────────────────────

function currentId() {
	return new URL(location.href).searchParams.get('id');
}
function goto(id) {
	const u = new URL(location.href);
	if (id) u.searchParams.set('id', id); else u.searchParams.delete('id');
	history.pushState({}, '', u);
	render();
}
window.addEventListener('popstate', render);

function render() {
	const id = currentId();
	if (id) renderDashboard(id);
	else renderDirectory();
}

// ── directory ──────────────────────────────────────────────────────────────────

async function renderDirectory() {
	root.innerHTML = `
		<section class="sw-hero">
			<div>
				<h1>Trading Swarms</h1>
				<p>Pool capital with other agents into one auditable on-chain treasury. The swarm only fires when enough of its members' verified track record agrees — and pays realized profit back to every member pro-rata.</p>
			</div>
			<div class="sw-hero-actions">
				<button class="sw-btn sw-btn--primary" id="sw-create">＋ Create a swarm</button>
			</div>
		</section>
		<div class="sw-toolbar">
			<div class="sw-seg" role="tablist" aria-label="Network">
				<button data-net="mainnet" aria-pressed="${state.network === 'mainnet'}">Mainnet</button>
				<button data-net="devnet" aria-pressed="${state.network === 'devnet'}">Devnet</button>
			</div>
			<button class="sw-btn sw-btn--ghost sw-btn--sm" id="sw-mine">My swarms</button>
		</div>
		<div id="sw-list" class="sw-grid" aria-busy="true">${skeletons(6)}</div>`;

	document.getElementById('sw-create').onclick = openCreateModal;
	root.querySelectorAll('[data-net]').forEach((b) => {
		b.onclick = () => { state.network = b.dataset.net; renderDirectory(); };
	});
	document.getElementById('sw-mine').onclick = () => loadList(true);

	loadList(false);
}

function skeletons(n) {
	return Array.from({ length: n }, () => '<div class="sw-skel"></div>').join('');
}

async function loadList(mine) {
	const listEl = document.getElementById('sw-list');
	if (!listEl) return;
	listEl.setAttribute('aria-busy', 'true');
	listEl.innerHTML = skeletons(6);
	const path = mine ? `/api/swarms?mine=1&network=${state.network}` : `/api/swarms?network=${state.network}`;
	const r = await api(path);
	listEl.setAttribute('aria-busy', 'false');
	if (!r.ok && r.status === 401 && mine) {
		listEl.innerHTML = msg('Sign in to see your swarms', 'Your swarms — ones you created or funded — appear here once you sign in.');
		return;
	}
	if (!r.ok) {
		listEl.innerHTML = msg('Couldn’t load swarms', esc(r.error || 'Something went wrong.'), 'Retry', () => loadList(mine));
		return;
	}
	const swarms = Array.isArray(r.data) ? r.data : [];
	if (!swarms.length) {
		listEl.innerHTML = mine
			? msg('No swarms yet', 'You haven’t created or joined a swarm. Start one and invite agents to pool capital.', 'Create a swarm', openCreateModal)
			: msg('No open swarms yet', 'Be the first — create a swarm, set its consensus policy, and invite other agents to fund the treasury.', 'Create a swarm', openCreateModal);
		return;
	}
	listEl.innerHTML = swarms.map(cardHTML).join('');
	listEl.querySelectorAll('[data-swarm]').forEach((c) => {
		c.onclick = () => goto(c.dataset.swarm);
		c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goto(c.dataset.swarm); } };
	});
}

function statusPill(s) {
	const cls = { active: 'active', paused: 'paused', killed: 'killed', open: 'open', closed: 'killed' }[s] || '';
	const label = { open: 'Funding', active: 'Live', paused: 'Paused', killed: 'Killed', closed: 'Closed' }[s] || s;
	return `<span class="sw-pill sw-pill--${cls}">${esc(label)}</span>`;
}

function cardHTML(s) {
	const pnlCls = s.realized_pnl_sol > 0 ? 'pos' : s.realized_pnl_sol < 0 ? 'neg' : '';
	const wr = s.win_rate == null ? '—' : `${Math.round(s.win_rate * 100)}%`;
	return `
		<a class="sw-card" tabindex="0" role="button" data-swarm="${esc(s.id)}" aria-label="Open ${esc(s.name)}">
			<div class="sw-card-top">
				<h3 class="sw-card-name">${esc(s.name)}</h3>
				${statusPill(s.status)}
			</div>
			${s.description ? `<p class="sw-card-desc">${esc(s.description)}</p>` : ''}
			<div class="sw-stats">
				<div class="sw-stat"><span class="sw-stat-v">${s.members}</span><span class="sw-stat-l">Members</span></div>
				<div class="sw-stat"><span class="sw-stat-v">${SOL(s.contributed_sol)}</span><span class="sw-stat-l">Pooled</span></div>
				<div class="sw-stat"><span class="sw-stat-v ${pnlCls}">${s.realized_pnl_sol >= 0 ? '+' : ''}${SOL(s.realized_pnl_sol)}</span><span class="sw-stat-l">Realized P&amp;L</span></div>
				<div class="sw-stat"><span class="sw-stat-v">${s.closed_trades}</span><span class="sw-stat-l">Closed</span></div>
				<div class="sw-stat"><span class="sw-stat-v">${wr}</span><span class="sw-stat-l">Win rate</span></div>
				<div class="sw-stat"><span class="sw-stat-v">${PCT(s.policy?.min_consensus)}</span><span class="sw-stat-l">Min consensus</span></div>
			</div>
		</a>`;
}

function msg(title, body, action, onAction) {
	const id = 'm' + Math.random().toString(36).slice(2);
	queueMicrotask(() => { const b = document.getElementById(id); if (b && onAction) b.onclick = onAction; });
	return `<div class="sw-msg" style="grid-column:1/-1"><h3>${esc(title)}</h3><p>${body}</p>${action ? `<button class="sw-btn sw-btn--primary" id="${id}">${esc(action)}</button>` : ''}</div>`;
}

// ── dashboard ──────────────────────────────────────────────────────────────────

let activeStream = null;
let pendingMemberAnim = null; // FLIP snapshot captured before a re-render shifts shares
let paintedSwarmId = null;    // so first paint of a swarm animates bars from 0, re-paints don't

function closeStream() {
	if (activeStream) { try { activeStream.close(); } catch {} activeStream = null; }
}

async function renderDashboard(id) {
	closeStream();
	root.innerHTML = `<a class="sw-back" id="sw-back" href="/swarms">← All swarms</a><div id="sw-dash" aria-busy="true">${skeletons(3)}</div>`;
	document.getElementById('sw-back').onclick = (e) => { e.preventDefault(); goto(null); };

	const r = await api(`/api/swarms/${id}`);
	const dash = document.getElementById('sw-dash');
	if (!dash) return;
	dash.setAttribute('aria-busy', 'false');
	if (!r.ok) {
		dash.innerHTML = msg('Swarm not found', esc(r.error || 'This swarm doesn’t exist or was removed.'), 'Back to directory', () => goto(null));
		return;
	}
	paintDashboard(dash, r.data);
	subscribeStream(id);
}

function paintDashboard(dash, s) {
	const sw = s.swarm;
	const pol = s.policy;
	const tr = s.treasury;
	const rec = s.track_record;
	const member = s.viewer_member;
	const pnlCls = rec.realized_pnl_sol > 0 ? 'pos' : rec.realized_pnl_sol < 0 ? 'neg' : '';

	dash.innerHTML = `
		<div class="sw-dash-head">
			<div>
				<h1>${esc(sw.name)} ${statusPill(sw.status)}</h1>
				${sw.description ? `<p class="muted" style="color:var(--ink-dim);max-width:60ch;margin:.2rem 0 0">${esc(sw.description)}</p>` : ''}
				${sw.status === 'killed' && sw.kill_reason ? `<p style="color:var(--danger);font-size:var(--text-sm);margin:.4rem 0 0">Killed: ${esc(sw.kill_reason)}</p>` : ''}
			</div>
			<div class="sw-live" id="sw-livedot" data-state="connecting"><span class="dot"></span><span id="sw-livetxt">connecting</span></div>
		</div>

		<div class="sw-disclose">
			<strong>Real money, real risk.</strong> The treasury holds real SOL and trades autonomously on member consensus — you can lose your entire contribution. Profit on each closed trade is split pro-rata by share${pol.creator_fee_bps ? `, after a ${(pol.creator_fee_bps / 100).toFixed(1)}% creator fee` : ' (no creator fee)'}. Exit policy: <strong>${pol.exit_policy === 'wait_to_close' ? 'wait-to-close' : 'settle-at-mark'}</strong> — ${pol.exit_policy === 'wait_to_close' ? 'you can redeem only when no positions are open.' : 'on exit you redeem your share of the treasury’s liquid SOL at current value.'} No member can hold more than ${(pol.max_member_share_bps / 100).toFixed(0)}% of the treasury.
		</div>

		<div class="sw-tiles">
			<div class="sw-tile"><div class="sw-tile-v" id="sw-bal" data-val="${tr.balance_sol == null ? '' : tr.balance_sol}">${tr.balance_sol == null ? '—' : SOL(tr.balance_sol)}</div><div class="sw-tile-l">Treasury (on-chain)</div><a href="${esc(tr.explorer)}" target="_blank" rel="noopener">${short(tr.address)} ↗</a></div>
			<div class="sw-tile"><div class="sw-tile-v">${SOL(tr.net_contributed_sol)}</div><div class="sw-tile-l">Net contributed</div></div>
			<div class="sw-tile"><div class="sw-tile-v ${pnlCls}" id="sw-pnl" data-val="${rec.realized_pnl_sol}">${rec.realized_pnl_sol >= 0 ? '+' : ''}${SOL(rec.realized_pnl_sol)}</div><div class="sw-tile-l">Realized P&amp;L</div></div>
			<div class="sw-tile"><div class="sw-tile-v" id="sw-open" data-val="${rec.open_positions}">${rec.open_positions}</div><div class="sw-tile-l">Open positions</div></div>
			<div class="sw-tile"><div class="sw-tile-v" id="sw-wr" data-val="${rec.win_rate == null ? '' : rec.win_rate * 100}">${rec.win_rate == null ? '—' : Math.round(rec.win_rate * 100) + '%'}</div><div class="sw-tile-l">Win rate · ${rec.closed_trades} closed</div></div>
		</div>

		<div class="sw-hero-actions" id="sw-actions" style="margin-bottom:var(--space-lg);flex-wrap:wrap"></div>

		<div class="sw-cols">
			<div>
				${panel('Members & shares', s.members.length, membersHTML(s.members))}
				${panel('Open & closed positions', s.positions.length, positionsHTML(s.positions))}
			</div>
			<div>
				${panel('Consensus vote log', s.votes.length, votesHTML(s.votes), 'sw-votes')}
				${panel('Pro-rata payout ledger', s.payouts.length, payoutsHTML(s.payouts), 'sw-payouts')}
			</div>
		</div>`;

	const firstPaint = paintedSwarmId !== sw.id;
	paintedSwarmId = sw.id;
	animateMembers(pendingMemberAnim, firstPaint);
	pendingMemberAnim = null;

	renderActions(s);
}

function panel(title, count, body, bodyId) {
	return `<div class="sw-panel"><div class="sw-panel-h"><h2>${esc(title)}</h2><span class="count">${count}</span></div><div class="sw-panel-body"${bodyId ? ` id="${bodyId}"` : ''}>${body}</div></div>`;
}

// Standings order: biggest stake first (share = standing), ties broken by the
// stronger track record, then name for stability.
function rankMembers(members) {
	return [...members].sort((a, b) =>
		(b.share_bps || 0) - (a.share_bps || 0) ||
		((b.reputation || 0) - (a.reputation || 0)) ||
		String(a.name || '').localeCompare(String(b.name || '')));
}

// Reputation IS vote weight. Bucket it so the chip's prominence reads at a glance.
function repTier(rep) {
	if (rep == null) return 0;
	if (rep >= 75) return 3;
	if (rep >= 50) return 2;
	if (rep >= 25) return 1;
	return 0;
}

function memberRowHTML(m, i) {
	const rep = m.reputation == null ? null : Math.round(m.reputation);
	const sharePct = Math.min(100, (m.share_bps || 0) / 100);
	const power = m.vote_power == null ? null : Math.round(m.vote_power * 100);
	const lead = i === 0;
	const repLabel = rep == null ? 'unrated track record' : `reputation ${rep}/100`;
	const repTitle = power == null
		? `Vote weight — ${repLabel}`
		: `Carries ${power}% of the swarm's vote · ${repLabel} (weight ${m.vote_weight})`;
	return `
		<div class="sw-row sw-member${lead ? ' is-lead' : ''}" data-agent="${esc(m.agent_id)}">
			<div class="sw-rank">#${i + 1}</div>
			<div class="grow">
				<div class="name">${lead ? '<span class="sw-lead-mark" aria-hidden="true">✦</span>' : ''}${esc(m.name)}${m.is_creator ? ' <span class="sw-pill" style="font-size:9px">creator</span>' : ''}</div>
				<div class="sw-bar"><span style="width:${sharePct}%"></span></div>
			</div>
			<div class="sw-member-meta">
				<div class="mono name">${((m.share_bps || 0) / 100).toFixed(1)}%</div>
				<div class="muted mono" style="font-size:var(--text-2xs)">${SOL(m.contribution_sol)}</div>
			</div>
			<div class="sw-rep" data-tier="${repTier(rep)}" style="--rep:${rep == null ? 0 : rep}" title="${esc(repTitle)}" aria-label="${esc(repTitle)}">
				<span class="sw-rep-v mono">${rep == null ? '—' : rep}</span>
				<span class="sw-rep-l mono">${power == null ? 'wt' : power + '%'}</span>
			</div>
		</div>`;
}

function membersHTML(members) {
	if (!members.length) return emptyRow('No members yet.');
	return rankMembers(members).map(memberRowHTML).join('');
}

function positionsHTML(positions) {
	if (!positions.length) return emptyRow('No trades yet — the treasury fires when member consensus clears.');
	return positions.map((p) => {
		const closed = p.status === 'closed';
		const pnl = p.pnl_sol;
		const cls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
		const link = (closed ? p.sell_url : p.buy_url);
		return `<div class="sw-row">
			<div class="grow"><span class="name">${esc(p.symbol || short(p.mint))}</span> <span class="muted" style="font-size:var(--text-2xs)">${closed ? esc(p.exit_reason || 'closed') : p.status}</span></div>
			<div class="mono" style="text-align:right">${closed ? `<span class="${cls}">${pnl >= 0 ? '+' : ''}${SOL(pnl)}</span>` : `<span class="muted">${SOL(p.current_sol)}</span>`}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener" class="muted">↗</a>` : ''}</div>
		</div>`;
	}).join('');
}

function voteRowHTML(v) {
	const pct = Math.min(100, (v.consensus || 0) * 100);
	const thr = Math.min(100, (v.min_consensus || 0) * 100);
	return `<div class="sw-vote">
		<div class="sw-vote-top">
			<span class="verdict ${v.decision}">${v.decision === 'fire' ? '✓ fire' : 'skip'}</span>
			<span class="name grow">${esc(v.mint ? short(v.mint) : '')}</span>
			<span class="muted mono" style="font-size:var(--text-2xs)">${v.members_long}/${v.members_total} long</span>
		</div>
		<div class="meter">
			<div class="sw-meter-track"><div class="sw-meter-fill${v.decision === 'fire' ? ' fire' : ''}" style="width:${pct}%"></div><div class="sw-meter-thresh" style="left:${thr}%"></div></div>
			<span class="mono muted" style="font-size:var(--text-2xs)">${Math.round(pct)}%</span>
		</div>
		<div class="reason">${esc(v.reason || '')}${v.smart_money_score ? ` · smart-money ${Math.round(v.smart_money_score)}` : ''}${v.size_sol ? ` · sized ${SOL(v.size_sol)}` : ''}</div>
	</div>`;
}

function votesHTML(votes) {
	if (!votes.length) return emptyRow('No consensus decisions yet. Each evaluation — fire or skip — logs here with the full weighted vote.');
	return votes.map(voteRowHTML).join('');
}

function payoutRowHTML(p) {
	const kindLabel = { profit: 'Profit', exit: 'Exit', fee: 'Creator fee' }[p.kind] || p.kind;
	const stCls = p.status === 'confirmed' ? 'pos' : p.status === 'failed' ? 'neg' : 'muted';
	return `<div class="sw-row">
		<div class="grow"><span class="name">${esc(kindLabel)}</span> <span class="muted" style="font-size:var(--text-2xs)">${p.share_bps != null ? (p.share_bps / 100).toFixed(1) + '%' : ''}</span></div>
		<div class="mono" style="text-align:right"><span class="${p.kind === 'fee' ? 'muted' : 'pos'}">${SOL(p.amount_sol)}</span> <span class="${stCls}" style="font-size:var(--text-2xs)">${p.status}</span>${p.tx_url ? ` <a href="${esc(p.tx_url)}" target="_blank" rel="noopener" class="muted">↗</a>` : ''}</div>
	</div>`;
}

function payoutsHTML(payouts) {
	if (!payouts.length) return emptyRow('No payouts yet. When a position closes in profit, each member’s pro-rata share is sent on-chain and listed here.');
	return payouts.map(payoutRowHTML).join('');
}

function emptyRow(text) {
	return `<div class="sw-row" style="color:var(--ink-dim);justify-content:center;padding:var(--space-lg);text-align:center;font-size:var(--text-sm)">${esc(text)}</div>`;
}

// ── actions ────────────────────────────────────────────────────────────────────

async function renderActions(s) {
	const el = document.getElementById('sw-actions');
	if (!el) return;
	await loadAgents();
	const sw = s.swarm;
	const member = s.viewer_member;
	const isOwner = s.is_owner;
	const killable = sw.status !== 'killed' && sw.status !== 'closed';

	const btns = [];
	if (killable && !member) btns.push(`<button class="sw-btn sw-btn--primary" data-act="join">Join & contribute</button>`);
	if (killable && member) {
		btns.push(`<button class="sw-btn sw-btn--primary" data-act="contribute">Add SOL</button>`);
		btns.push(`<button class="sw-btn" data-act="exit">Exit & redeem</button>`);
	}
	if (isOwner && killable) {
		btns.push(`<button class="sw-btn sw-btn--ghost sw-btn--sm" data-act="${sw.status === 'paused' ? 'resume' : 'pause'}">${sw.status === 'paused' ? 'Resume' : 'Pause'}</button>`);
	}
	if (killable) btns.push(`<button class="sw-btn sw-btn--danger sw-btn--sm" data-act="kill">Kill switch</button>`);

	el.innerHTML = btns.join('') || `<span class="muted" style="color:var(--ink-dim);font-size:var(--text-sm)">This swarm is closed.</span>`;
	el.querySelectorAll('[data-act]').forEach((b) => {
		b.onclick = () => handleAction(b.dataset.act, s);
	});
}

function handleAction(act, s) {
	if (!state.authed || !state.agents?.length) {
		toast('Sign in and create an agent first', true);
		return;
	}
	if (act === 'join' || act === 'contribute') return openContributeModal(s, act);
	if (act === 'exit') return openExitModal(s);
	if (act === 'kill') return openKillModal(s);
	if (act === 'pause' || act === 'resume') return doSimpleAction(act, s.swarm.id);
}

async function doSimpleAction(action, swarmId, extra = {}) {
	const r = await api('/api/swarms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, swarm_id: swarmId, ...extra }) });
	if (!r.ok) { toast(r.error || 'Action failed', true); return false; }
	toast(`Done`);
	renderDashboard(swarmId);
	return true;
}

// ── modals ─────────────────────────────────────────────────────────────────────

function modal(html) {
	const scrim = document.createElement('div');
	scrim.className = 'sw-scrim';
	scrim.innerHTML = `<div class="sw-modal" role="dialog" aria-modal="true">${html}</div>`;
	document.body.appendChild(scrim);
	scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
	const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onKey);
	return { scrim, close };
}

function agentOptions() {
	return (state.agents || []).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
}

async function openCreateModal() {
	await loadAgents();
	if (!state.authed) { toast('Sign in to create a swarm', true); return; }
	if (!state.agents.length) { toast('Create an agent first', true); return; }
	const { close } = modal(`
		<h2>Create a trading swarm</h2>
		<p class="sub">A dedicated custodial treasury wallet is provisioned on-chain. You set the consensus threshold and risk policy; members fund it with real SOL.</p>
		<div class="sw-field"><label>Swarm name</label><input id="f-name" maxlength="80" placeholder="e.g. Alpha Hunters" /></div>
		<div class="sw-field"><label>Description <span class="hint">(optional)</span></label><textarea id="f-desc" rows="2" maxlength="1000" placeholder="What does this swarm hunt?"></textarea></div>
		<div class="sw-field"><label>Owner agent</label><select id="f-owner">${agentOptions()}</select></div>
		<div class="sw-grid2">
			<div class="sw-field"><label>Min consensus</label><input id="f-cons" type="number" min="5" max="100" step="5" value="60" /><span class="hint">% of weighted track record that must agree</span></div>
			<div class="sw-field"><label>Network</label><select id="f-net"><option value="mainnet">Mainnet</option><option value="devnet">Devnet</option></select></div>
			<div class="sw-field"><label>Max / trade (SOL)</label><input id="f-mpt" type="number" min="0.001" step="0.01" value="0.05" /></div>
			<div class="sw-field"><label>Daily budget (SOL)</label><input id="f-budget" type="number" min="0.001" step="0.1" value="0.5" /></div>
			<div class="sw-field"><label>Stop loss (%)</label><input id="f-sl" type="number" min="1" max="95" value="35" /></div>
			<div class="sw-field"><label>Take profit (%)</label><input id="f-tp" type="number" min="5" value="80" /></div>
			<div class="sw-field"><label>Creator fee (%)</label><input id="f-fee" type="number" min="0" max="20" step="0.5" value="0" /><span class="hint">on distributed profit</span></div>
			<div class="sw-field"><label>Max member share (%)</label><input id="f-cap" type="number" min="10" max="100" value="50" /></div>
			<div class="sw-field"><label>Exit policy</label><select id="f-exit"><option value="settle_at_mark">Settle at mark</option><option value="wait_to_close">Wait to close</option></select></div>
			<div class="sw-field"><label>Join</label><select id="f-join"><option value="open">Open to anyone</option><option value="invite">Invite-only</option></select></div>
		</div>
		<div class="sw-modal-err" id="f-err"></div>
		<div class="sw-modal-actions">
			<button class="sw-btn sw-btn--ghost" id="f-cancel">Cancel</button>
			<button class="sw-btn sw-btn--primary" id="f-go">Create swarm</button>
		</div>`);

	document.getElementById('f-cancel').onclick = close;
	const errEl = document.getElementById('f-err');
	document.getElementById('f-go').onclick = async (e) => {
		const btn = e.currentTarget;
		const name = document.getElementById('f-name').value.trim();
		if (!name) { errEl.textContent = 'Name is required.'; return; }
		btn.disabled = true; btn.textContent = 'Creating…'; errEl.textContent = '';
		const policy = {
			min_consensus: Number(document.getElementById('f-cons').value) / 100,
			max_per_trade_lamports: Math.round(Number(document.getElementById('f-mpt').value) * 1e9),
			daily_budget_lamports: Math.round(Number(document.getElementById('f-budget').value) * 1e9),
			stop_loss_pct: Number(document.getElementById('f-sl').value),
			take_profit_pct: Number(document.getElementById('f-tp').value),
			creator_fee_bps: Math.round(Number(document.getElementById('f-fee').value) * 100),
			max_member_share_bps: Math.round(Number(document.getElementById('f-cap').value) * 100),
			exit_policy: document.getElementById('f-exit').value,
			join_open: document.getElementById('f-join').value === 'open',
		};
		const r = await api('/api/swarms', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				action: 'create', name,
				description: document.getElementById('f-desc').value.trim() || null,
				owner_agent_id: document.getElementById('f-owner').value,
				network: document.getElementById('f-net').value, policy,
			}),
		});
		if (!r.ok) { errEl.textContent = r.error || 'Could not create swarm.'; btn.disabled = false; btn.textContent = 'Create swarm'; return; }
		close();
		toast('Swarm created — fund the treasury to go live');
		goto(r.data.swarm.id);
	};
}

async function openContributeModal(s, mode) {
	const sw = s.swarm;
	const { close } = modal(`
		<h2>${mode === 'join' ? 'Join' : 'Add to'} ${esc(sw.name)}</h2>
		<p class="sub">Your agent sends real SOL from its custodial wallet to the swarm treasury. Your share is your net contribution ÷ the total pool, capped at ${(s.policy.max_member_share_bps / 100).toFixed(0)}%. You can exit and redeem any time.</p>
		<div class="sw-field"><label>Your agent</label><select id="c-agent">${agentOptions()}</select></div>
		<div class="sw-field"><label>Amount (SOL)</label><input id="c-amt" type="number" min="0.005" step="0.01" value="0.05" /><span class="hint">minimum 0.005 SOL</span></div>
		<div class="sw-modal-err" id="c-err"></div>
		<div class="sw-modal-actions">
			<button class="sw-btn sw-btn--ghost" id="c-cancel">Cancel</button>
			<button class="sw-btn sw-btn--primary" id="c-go">Send ${mode === 'join' ? '& join' : ''}</button>
		</div>`);
	document.getElementById('c-cancel').onclick = close;
	const errEl = document.getElementById('c-err');
	document.getElementById('c-go').onclick = async (e) => {
		const btn = e.currentTarget;
		const agentId = document.getElementById('c-agent').value;
		const sol = Number(document.getElementById('c-amt').value);
		if (!(sol > 0)) { errEl.textContent = 'Enter an amount.'; return; }
		btn.disabled = true; btn.textContent = 'Sending…'; errEl.textContent = '';
		const r = await api('/api/swarms', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'contribute', swarm_id: sw.id, agent_id: agentId, sol }),
			timeout: 60000,
		});
		if (!r.ok) { errEl.textContent = r.error || 'Contribution failed.'; btn.disabled = false; btn.textContent = 'Send'; return; }
		close();
		toast(`Contributed ${SOL(sol)} — share updated`);
		pendingMemberAnim = captureMemberState();
		renderDashboard(sw.id);
	};
}

async function openExitModal(s) {
	const sw = s.swarm;
	const member = s.viewer_member;
	const { close } = modal(`
		<h2>Exit ${esc(sw.name)}</h2>
		<p class="sub">${s.policy.exit_policy === 'wait_to_close'
			? 'This swarm redeems exits only when no positions are open. If positions are live, exit will be refused — wait for them to close or trigger the kill switch.'
			: 'You’ll redeem your share of the treasury’s liquid SOL at current value, sent on-chain to your agent wallet. Open positions stay with the swarm — you forfeit claims on them after exit.'}</p>
		<div class="sw-field"><label>Your member agent</label><select id="x-agent">${(s.members || []).filter((m) => m.status === 'active').map((m) => `<option value="${esc(m.agent_id)}">${esc(m.name)} · ${(m.share_bps / 100).toFixed(1)}%</option>`).join('') || agentOptions()}</select></div>
		<div class="sw-modal-err" id="x-err"></div>
		<div class="sw-modal-actions">
			<button class="sw-btn sw-btn--ghost" id="x-cancel">Stay in</button>
			<button class="sw-btn sw-btn--danger" id="x-go">Exit & redeem</button>
		</div>`);
	document.getElementById('x-cancel').onclick = close;
	const errEl = document.getElementById('x-err');
	document.getElementById('x-go').onclick = async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true; btn.textContent = 'Redeeming…'; errEl.textContent = '';
		const r = await api('/api/swarms', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'exit', swarm_id: sw.id, agent_id: document.getElementById('x-agent').value }),
			timeout: 60000,
		});
		if (!r.ok) { errEl.textContent = r.error || 'Exit failed.'; btn.disabled = false; btn.textContent = 'Exit & redeem'; return; }
		close();
		toast(`Redeemed ${SOL(r.data.redeemed_sol)}${r.data.capped ? ' (capped to liquid SOL)' : ''}`);
		pendingMemberAnim = captureMemberState();
		renderDashboard(sw.id);
	};
}

function openKillModal(s) {
	const sw = s.swarm;
	const { close } = modal(`
		<h2>Trigger the kill switch</h2>
		<p class="sub">This halts all new consensus trades and forces every open position to liquidate on the next sweep. ${s.is_owner ? 'As the creator you can always kill.' : `You need ≥ ${(s.policy.kill_threshold_bps / 100).toFixed(0)}% of the treasury to kill.`} This cannot be undone.</p>
		<div class="sw-field"><label>Reason <span class="hint">(optional)</span></label><input id="k-reason" maxlength="280" placeholder="Why are you killing this swarm?" /></div>
		<div class="sw-modal-err" id="k-err"></div>
		<div class="sw-modal-actions">
			<button class="sw-btn sw-btn--ghost" id="k-cancel">Cancel</button>
			<button class="sw-btn sw-btn--danger" id="k-go">Kill swarm</button>
		</div>`);
	document.getElementById('k-cancel').onclick = close;
	const errEl = document.getElementById('k-err');
	document.getElementById('k-go').onclick = async (e) => {
		const btn = e.currentTarget;
		btn.disabled = true; btn.textContent = 'Killing…'; errEl.textContent = '';
		const r = await api('/api/swarms', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'kill', swarm_id: sw.id, reason: document.getElementById('k-reason').value.trim() || null }),
		});
		if (!r.ok) { errEl.textContent = r.error || 'Kill failed.'; btn.disabled = false; btn.textContent = 'Kill swarm'; return; }
		close();
		toast('Swarm killed — positions liquidating');
		renderDashboard(sw.id);
	};
}

// ── live stream ────────────────────────────────────────────────────────────────

function subscribeStream(id) {
	if (typeof window.EventSource !== 'function') return;
	let fails = 0;
	const dot = () => document.getElementById('sw-livedot');
	const setLive = (state, txt) => { const d = dot(); if (d) { d.dataset.state = state; const t = document.getElementById('sw-livetxt'); if (t) t.textContent = txt; } };

	const connect = () => {
		closeStream();
		let es;
		try { es = new EventSource(`/api/swarms/${id}/stream`); } catch { return; }
		activeStream = es;
		es.addEventListener('hello', () => { fails = 0; setLive('live', 'live'); });
		es.addEventListener('vote', (e) => {
			try {
				const v = JSON.parse(e.data);
				const box = document.getElementById('sw-votes');
				if (box) {
						if (box.querySelector('.sw-msg, .sw-row')) box.innerHTML = '';
						box.insertAdjacentHTML('afterbegin', voteRowHTML(v));
						animateVoteRow(box.firstElementChild, v);
						if (v.decision === 'fire') ripplePanel(box);
					}
					if (v.decision === 'fire') { highlightWinners(v.breakdown); toast(`Consensus fired · ${short(v.mint)}`); }
			} catch {}
		});
		es.addEventListener('payout', (e) => {
			try {
				const p = JSON.parse(e.data);
				const box = document.getElementById('sw-payouts');
				if (box) { if (box.querySelector('.sw-msg, .sw-row[style]')) box.innerHTML = ''; box.insertAdjacentHTML('afterbegin', payoutRowHTML({ ...p, amount_sol: p.amount_sol })); flash(box.firstElementChild); }
				// Money landed — pulse the treasury and P&L tiles so the change registers
				// even before the next tick redraws their values.
				flashTile(document.getElementById('sw-bal'), 1);
				flashTile(document.getElementById('sw-pnl'), 1);
			} catch {}
		});
		es.addEventListener('tick', (e) => {
			try {
				const t = JSON.parse(e.data);
				if (t.balance_sol != null) updateTile(document.getElementById('sw-bal'), t.balance_sol, SOL);
				if (t.open_positions != null) updateTile(document.getElementById('sw-open'), t.open_positions, (v) => String(Math.round(v)));
				const pnl = document.getElementById('sw-pnl');
				if (pnl && t.realized_pnl_sol != null) {
					updateTile(pnl, t.realized_pnl_sol, (v) => `${v >= 0 ? '+' : ''}${SOL(v)}`,
						(v) => { pnl.className = 'sw-tile-v ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : ''); });
				}
				if (t.win_rate != null) updateTile(document.getElementById('sw-wr'), t.win_rate * 100, (v) => `${Math.round(v)}%`);
			} catch {}
		});
		es.onerror = () => { fails++; setLive('connecting', 'reconnecting'); try { es.close(); } catch {} activeStream = null; setTimeout(connect, Math.min(20000, 1000 * 2 ** fails)); };
	};
	connect();
}

// Neutral surface-tint settle on a row that just updated. Delegates to the shared
// ui-juice primitive so the swarms feed speaks the same motion vocabulary as the
// rest of the platform (and inherits its reduced-motion safety) instead of
// hand-rolling a one-off transition.
function flash(el) {
	flashValue(el, 'neutral');
}

// ── treasury tile juice: count between two real values, flash on change ──────────
// Skip the motion for reduced-motion users AND for a backgrounded tab — rAF is
// throttled while hidden, which would otherwise strand a half-finished count and a
// stuck flash class when the user returns. Both cases just snap to the real value.
const motionOff = () => document.hidden || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const countTimers = new WeakMap();

// Animate a tile's number from its previously displayed real value to the new real
// value, preserving the tile's own formatting. Cancels any in-flight count on the
// same element. onValue (optional) fires each frame with the current number so a
// caller can keep dependent styling (e.g. P&L sign/colour) in lockstep with it.
function countTile(el, to, format, onValue) {
	if (!el) return;
	const prevTimer = countTimers.get(el);
	if (prevTimer) { cancelAnimationFrame(prevTimer); countTimers.delete(el); }
	const prevRaw = el.dataset.val;
	const prev = prevRaw == null || prevRaw === '' ? null : Number(prevRaw);
	el.dataset.val = to == null ? '' : String(to);
	if (to == null || prev == null || prev === to || motionOff()) { el.textContent = format(to); if (onValue) onValue(to); return; }
	const dur = 480, start = performance.now(), delta = to - prev;
	const ease = (x) => 1 - Math.pow(1 - x, 3); // easeOutCubic
	const step = (now) => {
		const p = Math.min(1, (now - start) / dur);
		const v = p < 1 ? prev + delta * ease(p) : to;
		el.textContent = format(v);
		if (onValue) onValue(v);
		if (p < 1) { countTimers.set(el, requestAnimationFrame(step)); }
		else { countTimers.delete(el); }
	};
	countTimers.set(el, requestAnimationFrame(step));
}

// Direction-aware tile tint: dir > 0 → green, dir < 0 → red/neutral, then settle.
function flashTile(el, dir) {
	const tile = el && el.closest && el.closest('.sw-tile');
	if (!tile || !dir || motionOff()) return;
	tile.classList.remove('sw-tile--up', 'sw-tile--down');
	void tile.offsetWidth; // restart the animation if it's already mid-flight
	tile.classList.add(dir > 0 ? 'sw-tile--up' : 'sw-tile--down');
	const onEnd = () => { tile.classList.remove('sw-tile--up', 'sw-tile--down'); tile.removeEventListener('animationend', onEnd); };
	tile.addEventListener('animationend', onEnd);
}

// Count to the new value and flash in its direction in one call.
function updateTile(el, to, format, onValue) {
	if (!el) return;
	const prevRaw = el.dataset.val;
	const prev = prevRaw == null || prevRaw === '' ? null : Number(prevRaw);
	if (prev != null && to != null && to !== prev) flashTile(el, to - prev);
	countTile(el, to, format, onValue);
}

const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Keep the live vote log bounded — an active swarm streams indefinitely, so without
// a cap the DOM (and its animation listeners) would grow without limit over a session.
const MAX_VOTE_ROWS = 60;
function trimVoteLog(box) {
	if (!box) return;
	while (box.children.length > MAX_VOTE_ROWS) box.lastElementChild.remove();
}

// Single live region so the firing moment — the most important event on the page —
// reaches screen readers, not just sighted users.
function announce(msg) {
	let region = document.getElementById('sw-aria-live');
	if (!region) {
		region = document.createElement('div');
		region.id = 'sw-aria-live';
		region.className = 'sr-only';
		region.setAttribute('role', 'status');
		region.setAttribute('aria-live', 'assertive');
		document.body.appendChild(region);
	}
	region.textContent = '';
	requestAnimationFrame(() => { region.textContent = msg; }); // reset so identical messages re-announce
}

// Count a percentage readout from 0 → target in lockstep with the meter fill, so the
// number reads as "consensus building" rather than snapping to its final value.
function countPercent(el, to) {
	if (!el) return;
	const dur = 220, start = performance.now();
	const step = (now) => {
		const p = Math.min(1, (now - start) / dur);
		el.textContent = `${Math.round(to * (1 - Math.pow(1 - p, 3)))}%`;
		if (p < 1) requestAnimationFrame(step);
		else el.textContent = `${to}%`;
	};
	requestAnimationFrame(step);
}

// Animate a freshly-streamed vote row: slide in, fill the consensus meter from 0
// toward the real value (the % readout counting alongside), and — on a fire — drive the
// fill across the threshold tick with a hot gradient, a glow at the line, and a verdict
// pulse. Fires are announced to assistive tech and the log trimmed regardless of motion.
function animateVoteRow(row, v) {
	if (!row) return;
	const fire = v.decision === 'fire';
	const fill = row.querySelector('.sw-meter-fill');
	const pctEl = row.querySelector('.meter span.mono');
	const target = fill ? fill.style.width || '0%' : '0%';
	const pct = Math.round(parseFloat(target) || 0);
	if (fire) announce(`Swarm fired at ${pct}% consensus${v.mint ? ` on ${short(v.mint)}` : ''}.`);
	trimVoteLog(row.parentElement);
	if (prefersReducedMotion()) return; // HTML already renders the final state
	row.classList.add('sw-enter');
	if (!fill) return;
	if (fire) fill.classList.remove('fire'); // start cool, shift hot as it crosses
	fill.style.width = '0%';
	countPercent(pctEl, pct);
	void fill.offsetWidth; // commit the 0% start before transitioning
	requestAnimationFrame(() => {
		fill.style.width = target;
		if (fire) {
			fill.classList.add('fire');
			row.querySelector('.sw-meter-thresh')?.classList.add('glow');
			row.querySelector('.verdict.fire')?.classList.add('sw-pulse');
		}
	});
}

// One accent ripple along the top edge of the votes panel header on a fire.
function ripplePanel(box) {
	const header = box?.closest('.sw-panel')?.querySelector('.sw-panel-h');
	if (!header || prefersReducedMotion()) return;
	header.classList.remove('sw-fired');
	void header.offsetWidth; // restart the animation on back-to-back fires
	header.classList.add('sw-fired');
	header.addEventListener('animationend', () => header.classList.remove('sw-fired'), { once: true });
}

// Snapshot each member row's viewport rect + bar width before a re-render, keyed by
// agent, so the next paint can FLIP rows into their new standings and grow bars from
// their previous fill instead of snapping. Returns null when there's nothing to track.
function captureMemberState() {
	const rows = document.querySelectorAll('.sw-member[data-agent]');
	if (!rows.length) return null;
	const map = {};
	rows.forEach((row) => {
		const span = row.querySelector('.sw-bar > span');
		map[row.dataset.agent] = { rect: row.getBoundingClientRect(), width: span ? span.style.width : '0%' };
	});
	return map;
}

// Play the standings transition after a paint: FLIP each row from its old position
// to its new rank, and animate share bars from their prior fill (or from 0 on first
// paint). Reduced-motion → leave the final, correctly-ordered state untouched.
function animateMembers(prev, firstPaint) {
	if (prefersReducedMotion()) return;
	document.querySelectorAll('.sw-member[data-agent]').forEach((row) => {
		const span = row.querySelector('.sw-bar > span');
		if (!span) return;
		const finalW = span.style.width;
		const old = prev && prev[row.dataset.agent];
		if (old) {
			const now = row.getBoundingClientRect();
			const dx = old.rect.left - now.left;
			const dy = old.rect.top - now.top;
			if (dx || dy) {
				row.style.transform = `translate(${dx}px, ${dy}px)`;
				row.style.transition = 'none';
				requestAnimationFrame(() => {
					row.style.transition = 'transform var(--duration-base) var(--ease-emphasized)';
					row.style.transform = '';
				});
				row.addEventListener('transitionend', () => { row.style.transition = ''; row.style.transform = ''; }, { once: true });
			}
		}
		if (old || firstPaint) {
			span.style.width = old ? old.width : '0%';
			requestAnimationFrame(() => { span.style.width = finalW; });
		}
	});
}

// On a fired consensus, briefly pulse the rows of members who were on the winning
// (long) side — straight from the real swarm_votes.breakdown. No breakdown, or no
// long voter present, lights up nothing. Reduced-motion → no pulse.
function highlightWinners(breakdown) {
	if (!Array.isArray(breakdown) || prefersReducedMotion()) return;
	const longIds = new Set(breakdown.filter((b) => b && b.long).map((b) => String(b.agent_id)));
	if (!longIds.size) return;
	document.querySelectorAll('.sw-member[data-agent]').forEach((row) => {
		if (!longIds.has(String(row.dataset.agent))) return;
		row.classList.remove('sw-win');
		void row.offsetWidth; // restart on back-to-back fires
		row.classList.add('sw-win');
		row.addEventListener('animationend', () => row.classList.remove('sw-win'), { once: true });
	});
}

window.addEventListener('beforeunload', closeStream);

// ── boot ────────────────────────────────────────────────────────────────────────

loadAgents().finally(render);
