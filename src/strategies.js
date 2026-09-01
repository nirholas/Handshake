// /strategies: the Strategy Object library, a marketplace of HOW agents trade.
//
// Three real surfaces, one page:
//   • Marketplace: every published strategy, ranked honestly (proven first). Fork
//     into your library or equip on your own agent.
//   • Leaderboard: proven strategies ranked by REAL live ROI from on-chain fills.
//   • My library: your strategies (create, edit, publish, equip, delete).
//
// Every number traces to a real fill (agent_strategy_positions). A strategy with no
// closed trades is honestly "Unproven", never a fabricated backtest curve.

import { apiFetch, noteSession } from './api.js';
import {
	esc, shortAddr, fmtSol, timeAgo, toast, configSummary,
	mountStrategyComposer, openEquipPicker,
} from './shared/strategy-forms.js';

const grid = document.getElementById('sp-grid');
const scopeSeg = document.getElementById('sp-scope');
const searchInput = document.getElementById('sp-search');

// ── full-page builder ──────────────────────────────────────────────────────────
// The "New strategy" / "Edit" flow renders the builder inline as a page (not a
// modal): a multi-section form deserves room. State lives in the URL (?editor=new
// or ?editor=<id>) so it survives reload and works with the back button.
const shell = document.querySelector('.sp-shell');
const heroEl = shell?.querySelector('.sp-hero');
const barEl = shell?.querySelector('.sp-bar');
let composeHost = null;
let composing = false;
let lastStrategy = null; // cache so editing from a card needs no extra fetch

function showLibraryChrome(on) {
	if (heroEl) heroEl.hidden = !on;
	if (barEl) barEl.hidden = !on;
	if (grid) grid.hidden = !on;
}

function enterCompose(existing) {
	composing = true;
	if (!composeHost) {
		composeHost = document.createElement('section');
		composeHost.id = 'sp-compose';
		shell?.appendChild(composeHost);
	}
	showLibraryChrome(false);
	composeHost.hidden = false;
	window.scrollTo({ top: 0 });
	mountStrategyComposer(composeHost, {
		existing,
		onSaved: () => exitCompose({ toScope: 'mine' }),
		onCancel: () => exitCompose({}),
	});
}

function leaveComposeView() {
	composing = false;
	if (composeHost) { composeHost.hidden = true; composeHost.innerHTML = ''; }
	showLibraryChrome(true);
}

// Return to the library, cleaning ?editor from the URL (replaceState, so no junk
// history entry). toScope optionally switches the active tab (e.g. to "mine"
// after a create so the new strategy is visible).
function exitCompose({ toScope } = {}) {
	const u = new URL(location.href);
	u.searchParams.delete('editor');
	if (toScope) u.searchParams.set('scope', toScope);
	history.replaceState(null, '', u);
	leaveComposeView();
	if (toScope) { scope = toScope; syncSeg(); }
	load();
}

async function fetchStrategy(id) {
	try {
		const res = await apiFetch(`/api/strategies/${encodeURIComponent(id)}`, { allowAnonymous: true });
		if (!res.ok) return null;
		return (await res.json()).data;
	} catch { return null; }
}

// Reconcile the view with the URL. Runs on first load and on every back/forward.
async function syncFromUrl() {
	const editor = new URL(location.href).searchParams.get('editor');
	if (!editor) { if (composing) leaveComposeView(); load(); return; }
	if (composing) return; // already on the builder for this URL
	if (!(await ensureAuthed())) { location.href = `/login?next=${encodeURIComponent('/strategies?editor=' + editor)}`; return; }
	let existing = null;
	if (editor !== 'new') {
		existing = lastStrategy && lastStrategy.id === editor ? lastStrategy : await fetchStrategy(editor);
		if (!existing) {
			toast('That strategy is no longer available');
			const u = new URL(location.href); u.searchParams.delete('editor'); history.replaceState(null, '', u);
			leaveComposeView(); load(); return;
		}
	}
	enterCompose(existing);
}

let scope = new URL(location.href).searchParams.get('scope') || 'published';
let query = '';
let authed = null; // resolved lazily
let _seq = 0;

function perfBadge(p) {
	return p?.proven
		? '<span class="sp-badge proven">Proven</span>'
		: '<span class="sp-badge unproven">Unproven</span>';
}
function statsLine(p) {
	if (!p || !p.proven) return '<span>No closed trades yet. Equip it to build a record</span>';
	const roi = p.roi_pct != null ? `<span class="${p.roi_pct >= 0 ? 'pos' : 'neg'}">${p.roi_pct >= 0 ? '+' : ''}${p.roi_pct}% ROI</span>` : '';
	const pnl = `<span class="${p.pnl_sol >= 0 ? 'pos' : 'neg'}">${p.pnl_sol >= 0 ? '+' : ''}◎${fmtSol(p.pnl_sol)}</span>`;
	const win = p.win_rate != null ? `<span>${p.win_rate}% win</span>` : '';
	const dd = p.worst_sol != null && p.worst_sol < 0 ? `<span class="neg">worst ◎${fmtSol(p.worst_sol)}</span>` : '';
	return `${roi}${pnl}${win}<span>${p.trades} trades</span>${dd}`;
}

function card(s, isMine) {
	const lineage = s.forked_from ? `<span title="Forked from ${esc(s.forked_from.name || '')}">🍴 from ${esc(s.forked_from.owner_name || shortAddr(s.forked_from.owner_id))}</span>` : '';
	const rank = s.rank ? `<div class="sp-rank" title="Rank #${s.rank} by live ROI">#${s.rank}</div>` : '';
	let actions;
	if (isMine) {
		actions = `
			<button class="sp-btn sp-btn-primary" data-act="equip" data-id="${esc(s.id)}">Equip</button>
			<button class="sp-btn" data-act="edit" data-id="${esc(s.id)}">Edit</button>
			<button class="sp-btn" data-act="publish" data-id="${esc(s.id)}">${s.published ? 'Unpublish' : 'Publish'}</button>
			<button class="sp-btn" data-act="delete" data-id="${esc(s.id)}" title="Delete strategy" aria-label="Delete strategy">✕</button>`;
	} else {
		actions = `
			<button class="sp-btn sp-btn-primary" data-act="equip" data-id="${esc(s.id)}">Equip</button>
			<button class="sp-btn" data-act="fork" data-id="${esc(s.id)}" title="Copy the rules into your library">🍴 Fork</button>`;
	}
	return `<div class="sp-card" data-id="${esc(s.id)}">
		${rank}
		<div class="sp-card-top">
			<div class="sp-card-name">${esc(s.name)}</div>
			${perfBadge(s.performance)}
		</div>
		${s.description ? `<div class="sp-desc">${esc(s.description)}</div>` : '<div class="sp-desc"></div>'}
		<div class="sp-rules">${configSummary(s.config)}</div>
		<div class="sp-stats">${statsLine(s.performance)}</div>
		<div class="sp-meta">by ${esc(s.owner_name || shortAddr(s.owner_id))}${lineage ? ' · ' + lineage : ''}${s.forks_count ? ` · ${s.forks_count} fork${s.forks_count === 1 ? '' : 's'}` : ''}${s.equips_count ? ` · ${s.equips_count} equipped` : ''}${s.updated_at ? ` · ${timeAgo(s.updated_at)}` : ''}</div>
		<div class="sp-actions">${actions}</div>
	</div>`;
}

function renderEmpty() {
	if (scope === 'mine') {
		grid.innerHTML = `<div class="sp-empty"><strong>No strategies yet</strong>Build your first rule-based plan (entry, sizing, take-profit, stop-loss), then equip it on your agent.<br><br><button class="sp-btn sp-btn-primary" id="sp-empty-new" style="max-width:220px;margin:0 auto">+ Create a strategy</button></div>`;
		document.getElementById('sp-empty-new')?.addEventListener('click', createNew);
	} else if (scope === 'leaderboard') {
		grid.innerHTML = `<div class="sp-empty"><strong>No proven strategies yet</strong>The leaderboard ranks strategies by real, on-chain live performance. As equipped strategies close their first trades, they appear here, ranked by verified ROI, not promises.</div>`;
	} else {
		grid.innerHTML = `<div class="sp-empty"><strong>No published strategies yet</strong>Be the first: build a strategy, prove it on real chain data, and publish it for others to fork and equip.<br><br><button class="sp-btn sp-btn-primary" id="sp-empty-new" style="max-width:220px;margin:0 auto">+ Create a strategy</button></div>`;
		document.getElementById('sp-empty-new')?.addEventListener('click', createNew);
	}
}

// The library tab for a signed-out visitor. Rendered without asking the API:
// /api/strategies?scope=mine can only answer 401 without a session, and every
// such request prints a red network error in the visitor's console.
function renderSignIn() {
	const next = encodeURIComponent('/strategies?scope=mine');
	grid.innerHTML = `<div class="sp-empty"><strong>Sign in to see your library</strong>Your strategies live in your account. Sign in to create, edit, and equip them.<br><br><a class="sp-btn sp-btn-primary" href="/login?next=${next}" style="max-width:200px;margin:0 auto;text-decoration:none;display:block">Sign in</a></div>`;
}

async function load() {
	const seq = ++_seq;
	grid.innerHTML = '<div class="sp-sk"></div><div class="sp-sk"></div><div class="sp-sk"></div>';
	let strategies = [];
	try {
		if (scope === 'mine' && !(await ensureAuthed())) {
			if (seq === _seq) renderSignIn();
			return;
		}
		let path;
		if (scope === 'leaderboard') path = '/api/strategies/leaderboard?limit=30';
		else path = `/api/strategies?scope=${scope}&limit=40${query ? `&q=${encodeURIComponent(query)}` : ''}`;
		const res = await apiFetch(path, { allowAnonymous: true });
		if (res.status === 401 && scope === 'mine') {
			authed = false;
			noteSession(false);
			if (seq === _seq) renderSignIn();
			return;
		}
		if (!res.ok) throw new Error('load failed');
		const data = (await res.json()).data;
		strategies = scope === 'leaderboard' ? data.leaders || [] : data.strategies || [];
	} catch (e) {
		if (e?.redirected) return;
		if (seq !== _seq) return;
		grid.innerHTML = `<div class="sp-empty"><strong>Couldn't load strategies</strong>Something went wrong reaching the strategy library.<br><br><button class="sp-btn" id="sp-retry" style="max-width:160px;margin:0 auto">Retry</button></div>`;
		document.getElementById('sp-retry')?.addEventListener('click', load);
		return;
	}
	if (seq !== _seq) return;
	if (!strategies.length) { renderEmpty(); return; }
	const isMine = scope === 'mine';
	grid.innerHTML = strategies.map((s) => card(s, isMine || s.is_owner)).join('');
	wireCards(strategies);
}

function wireCards(strategies) {
	grid.querySelectorAll('[data-act]').forEach((btn) => {
		btn.addEventListener('click', async (e) => {
			e.preventDefault();
			const id = btn.dataset.id;
			const s = strategies.find((x) => x.id === id);
			if (!s) return;
			const act = btn.dataset.act;
			if (act === 'equip') return doEquip(s);
			if (act === 'fork') return doFork(s, btn);
			if (act === 'edit') return doEdit(s);
			if (act === 'publish') return doPublish(s, btn);
			if (act === 'delete') return doDelete(s);
		});
	});
}

async function doEquip(s) {
	if (!(await ensureAuthed())) { location.href = `/login?next=${encodeURIComponent('/strategies')}`; return; }
	await openEquipPicker({ strategy: s });
}

async function doFork(s, btn) {
	if (!(await ensureAuthed())) { location.href = `/login?next=${encodeURIComponent('/strategies')}`; return; }
	btn.disabled = true; btn.textContent = 'Forking…';
	try {
		const res = await apiFetch(`/api/strategies/${s.id}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j?.error?.message || 'Fork failed');
		toast(`Forked “${s.name}” into your library. Yours to tweak and equip`);
	} catch (e) { if (!e?.redirected) toast(e.message || 'Fork failed'); }
	finally { btn.disabled = false; btn.textContent = '🍴 Fork'; }
}

function doEdit(s) {
	lastStrategy = s;
	const u = new URL(location.href); u.searchParams.set('editor', s.id); history.pushState(null, '', u);
	enterCompose(s);
}

async function doPublish(s, btn) {
	btn.disabled = true;
	try {
		const res = await apiFetch(`/api/strategies/${s.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ published: !s.published }) });
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j?.error?.message || 'Could not update');
		toast(j.data?.published ? 'Published. Others can fork & equip it' : 'Unpublished');
		load();
	} catch (e) { if (!e?.redirected) toast(e.message || 'Could not update'); btn.disabled = false; }
}

async function doDelete(s) {
	if (!confirm(`Delete “${s.name}”? Equipped agents stop running it; open positions stay yours to manage. This can't be undone.`)) return;
	try {
		const res = await apiFetch(`/api/strategies/${s.id}`, { method: 'DELETE' });
		if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error?.message || 'Delete failed'); }
		toast('Strategy deleted');
		load();
	} catch (e) { if (!e?.redirected) toast(e.message || 'Delete failed'); }
}

async function createNew() {
	if (!(await ensureAuthed())) { location.href = `/login?next=${encodeURIComponent('/strategies?editor=new')}`; return; }
	const u = new URL(location.href); u.searchParams.set('editor', 'new'); history.pushState(null, '', u);
	enterCompose(null);
}

// /api/auth/me answers 200 for everyone and puts the answer in the body:
// { user: {...} } with a session, { user: null } without one. Reading res.ok
// here called every anonymous visitor signed in, which opened the equip picker
// and the builder for them and let Fork fire a request that could only 401.
async function ensureAuthed() {
	if (authed != null) return authed;
	try {
		const res = await apiFetch('/api/auth/me', { allowAnonymous: true });
		const body = res.ok ? await res.json().catch(() => null) : null;
		authed = !!body?.user;
	} catch { authed = false; }
	noteSession(authed);
	return authed;
}

function syncSeg() {
	scopeSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));
}

scopeSeg.addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-scope]');
	if (!btn) return;
	scope = btn.dataset.scope;
	syncSeg();
	const u = new URL(location.href); u.searchParams.set('scope', scope); history.replaceState(null, '', u);
	load();
});

let _searchTimer = null;
searchInput?.addEventListener('input', () => {
	clearTimeout(_searchTimer);
	_searchTimer = setTimeout(() => { query = searchInput.value.trim(); load(); }, 250);
});

document.getElementById('sp-new')?.addEventListener('click', createNew);

window.addEventListener('popstate', () => { syncFromUrl(); });

syncSeg();
syncFromUrl();
