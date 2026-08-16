/**
 * Alpha Co-pilot — client mount.
 *
 * The intelligence + voice layer on top of the wallet program's trade rails:
 * an agent reads a REAL pump.fun launch in character (POST /api/agents/:id/alpha/read),
 * its 3D avatar speaks the verdict aloud (TTS + talk animation), and the owner
 * can act on the call through the SAME guarded path the conversational copilot
 * uses (executeAgentTrade → POST /solana/trade) — clamped to the agent's spend
 * limits and fully audited. The narrator never moves funds.
 *
 * Every number shown comes from the server's grounded `signals` bundle; a
 * fabricated figure is rejected server-side and never reaches the avatar's mouth.
 */

import { agentAvatarGlb } from './shared/agent-3d.js';
import { resolveDevR2Url } from './shared/dev-r2-proxy.js';
import { previewAgentTrade, executeAgentTrade, TradeError } from './agent-solana-wallet.js';
import { countUp, enterStagger, rippleOnce, reducedMotion } from './ui-juice.js';

const NETWORK = 'mainnet';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LS_KEY = 'ac_last_agent';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Copy in the markup carries `data-i18n` keys, and the runtime i18n pass rewrites
// those nodes from the catalog whenever it runs (boot, and again on every locale
// change). Writing straight over such a node loses the new string on the next
// pass: the "Hide ID entry" toggle label flipped back to "Use an agent ID" with
// the row still open. Dropping the key hands ownership of that node to the JS.
function setOwnText(el, text) {
	if (!el) return;
	el.removeAttribute('data-i18n');
	el.removeAttribute('data-i18n-html');
	el.textContent = text;
}

// ── formatting ──────────────────────────────────────────────────────────────
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
function fmtUsd(v) {
	const n = num(v);
	if (n == null) return '—';
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
	return '$' + n.toFixed(0);
}
function fmtSol(v) { const n = num(v); return n == null ? '—' : '◎' + n.toLocaleString(undefined, { maximumFractionDigits: 4 }); }
function fmtPct(v) { const n = num(v); return n == null ? '—' : n.toFixed(n >= 10 ? 0 : 1) + '%'; }
function fmtScore(v) { const n = num(v); return n == null ? '—' : Math.round(n) + ''; }
function ageLabel(seconds) {
	const s = num(seconds);
	if (s == null) return '—';
	if (s < 90) return Math.round(s) + 's';
	const m = Math.round(s / 60);
	if (m < 90) return m + 'm';
	const h = Math.round(m / 60);
	if (h < 48) return h + 'h';
	return Math.round(h / 24) + 'd';
}
function short(s, h = 4, t = 4) { return !s || s.length <= h + t + 1 ? s || '' : `${s.slice(0, h)}…${s.slice(-t)}`; }
function explorerTxUrl(sig) { return `https://solscan.io/tx/${sig}`; }

// ── state ──────────────────────────────────────────────────────────────────
const state = {
	agent: null,        // full GET /api/agents/:id object
	avatarEl: null,     // <agent-3d>
	candidates: [],
	gallery: [],        // public agent directory (the picker)
	read: null,         // last /alpha/read response
	activeMint: null,   // mint currently being / last read
	lastSpoken: '',
	speaking: false,
	loadingRead: false,
};

// ── DOM refs ────────────────────────────────────────────────────────────────
const dom = {};
function cacheDom() {
	dom.gallery = $('#ac-agent-gallery');
	dom.idToggle = $('#ac-id-toggle');
	dom.idRow = $('#ac-id-row');
	dom.agentInput = $('#ac-agent-input');
	dom.agentLoad = $('#ac-agent-load');
	dom.avatarHost = $('#ac-avatar-host');
	dom.avatarPlaceholder = $('#ac-avatar-placeholder');
	dom.eq = $('#ac-eq');
	dom.agentName = $('#ac-agent-name');
	dom.agentRole = $('#ac-agent-role');
	dom.agentLink = $('#ac-agent-link');
	dom.speak = $('#ac-speak');
	dom.speakLine = $('#ac-speak-line');
	dom.replay = $('#ac-replay');
	dom.readEmpty = $('#ac-read-empty');
	dom.readBody = $('#ac-read-body');
	dom.launchesList = $('#ac-launches-list');
	dom.refresh = $('#ac-refresh');
	dom.actDrawer = $('#ac-act-drawer');
	dom.actBody = $('#ac-act-body');
}

// ── agent gallery (the picker) ───────────────────────────────────────────────
function initials(name) {
	return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

// Normalize the two real agent sources into one card shape. `/api/agents/public`
// is the rich directory; `/api/agents/featured` always returns at least one real
// public agent, so it guarantees the picker is never empty even if the directory
// query is briefly unavailable.
function normPublic(a) {
	return { id: a.id, name: a.name, avatar: a.avatar_thumbnail || null, skill: (a.skills && a.skills[0]) || null, chats: Number(a.chat_count) || 0, onchain: a.onchain || null };
}
function normFeatured(d) {
	return { id: d.id, name: d.display_name, avatar: d.avatar_url || null, skill: null, chats: 0, onchain: null, featured: true };
}

async function loadGallery() {
	dom.gallery.innerHTML = Array.from({ length: 6 }, () => `<div class="ac-agent-card ac-skel"><div class="ac-skel-orb"></div><div class="ac-skel-line w80"></div><div class="ac-skel-line w60"></div></div>`).join('');
	const [pub, feat] = await Promise.all([
		fetch('/api/agents/public?sort=popular&limit=12', { credentials: 'include' }).then((r) => r.json()).then((j) => (Array.isArray(j.agents) ? j.agents.map(normPublic) : [])).catch(() => []),
		fetch('/api/agents/featured', { credentials: 'include' }).then((r) => r.json()).then((j) => (j?.data?.id ? [normFeatured(j.data)] : [])).catch(() => []),
	]);
	const byId = new Map();
	for (const a of [...feat, ...pub]) if (a?.id && !byId.has(a.id)) byId.set(a.id, a);
	const agents = [...byId.values()];
	state.gallery = agents;
	renderGallery();
	if (!agents.length) revealIdRow(true);
}

function renderGallery() {
	if (!state.gallery.length) {
		dom.gallery.innerHTML = `<div class="ac-gallery-empty">No public agents to feature right now — paste an agent ID to load one.</div>`;
		return;
	}
	dom.gallery.innerHTML = '';
	for (const a of state.gallery) dom.gallery.appendChild(agentCard(a));
	if (state.agent) markActiveCard(state.agent.id);
}

// Make sure the agent on stage always has a card in the rail (an ID-loaded or
// the caller's own agent may not be in the public directory) so it can be
// highlighted and re-selected.
function ensureCardFor(agent) {
	if (!agent?.id || state.gallery.some((a) => a.id === agent.id)) return;
	state.gallery.unshift({ id: agent.id, name: agent.name, avatar: agent.avatar_thumbnail_url || agent.avatar_url || null, skill: null, chats: 0, onchain: null });
	renderGallery();
}

function agentCard(a) {
	const node = document.createElement('button');
	node.type = 'button';
	node.className = 'ac-agent-card';
	node.setAttribute('role', 'option');
	node.setAttribute('aria-selected', 'false');
	node.dataset.id = a.id;
	const meta = a.featured ? 'Featured' : a.onchain ? esc(a.onchain.network || 'on-chain') : a.chats ? `${a.chats.toLocaleString()} chats` : a.skill ? esc(a.skill.replace(/[-_]/g, ' ')) : 'agent';
	const fallback = `<span class="ac-agent-initials">${esc(initials(a.name))}</span>`;
	node.innerHTML = `
		<span class="ac-agent-av">${a.avatar ? `<img src="${esc(a.avatar)}" alt="" loading="lazy" />` : fallback}</span>
		<span class="ac-agent-info">
			<span class="ac-agent-name">${esc(a.name || 'Agent')}</span>
			<span class="ac-agent-meta">${meta}</span>
		</span>`;
	// A broken avatar URL falls back to initials rather than the browser's broken-image glyph.
	const img = node.querySelector('img');
	if (img) img.addEventListener('error', () => { const host = img.parentElement; if (host) host.innerHTML = fallback; }, { once: true });
	node.addEventListener('click', () => loadAgent(a.id));
	return node;
}

// The rail is a listbox, so the highlight has to reach the accessibility tree
// too: a screen reader gets "selected" from aria-selected, never from a class.
function markActiveCard(id) {
	dom.gallery.querySelectorAll('.ac-agent-card[role="option"]').forEach((c) => {
		const on = c.dataset.id === id;
		c.classList.toggle('is-active', on);
		c.setAttribute('aria-selected', String(on));
	});
}

function revealIdRow(open) {
	dom.idRow.hidden = !open;
	dom.idToggle.setAttribute('aria-expanded', String(open));
	setOwnText(dom.idToggle, open ? 'Hide ID entry' : 'Use an agent ID');
	if (open) dom.agentInput.focus();
}

// ── agent loading ───────────────────────────────────────────────────────────
function parseAgentId(raw) {
	if (!raw) return null;
	const m = String(raw).match(UUID_RE);
	return m ? m[0] : null;
}

async function loadAgent(id) {
	if (!id) return;
	markActiveCard(id);
	dom.agentName.textContent = 'Loading…';
	dom.agentRole.textContent = 'Bringing it on stage';
	dom.agentLink.hidden = true;
	let agent;
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(id)}`, { credentials: 'include' });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(j?.error?.message || `Could not load agent (${r.status})`);
		agent = j.agent || j;
	} catch (e) {
		dom.agentName.textContent = 'Not found';
		dom.agentRole.textContent = e.message || 'Could not load that agent';
		state.agent = null;
		clearStage();
		return;
	}
	state.agent = agent;
	try { localStorage.setItem(LS_KEY, agent.id); } catch { /* ignore */ }
	dom.agentName.textContent = agent.name || 'Agent';
	dom.agentRole.textContent = agent.is_owner ? 'Your alpha co-pilot' : 'Alpha co-pilot · public read';
	dom.agentLink.href = agent.home_url || `/agent/${agent.id}`;
	dom.agentLink.hidden = false;
	ensureCardFor(agent);
	markActiveCard(agent.id);
	mountAvatar(agent);
	resetRead();
	loadCandidates();
}

// A failed load must not leave the PREVIOUS agent standing on stage with its
// launch cards still rendered: `requestRead` needs `state.agent`, so every one of
// those "Ask for a read" buttons becomes a silent no-op click. Strip the stage
// back to its first-paint state so the only thing on screen is the real one.
function clearStage() {
	if (state.avatarEl) { try { state.avatarEl.remove(); } catch { /* already detached */ } state.avatarEl = null; }
	if (dom.avatarPlaceholder) dom.avatarPlaceholder.hidden = false;
	dom.agentLink.hidden = true;
	state.candidates = [];
	markActiveCard(null);
	resetRead();
	showLaunchesIdle(IDLE_PICK);
}

async function mountAvatar(agent) {
	// r2.dev only sends CORS headers for the production origins, so on localhost /
	// Codespaces the raw GLB fetch is blocked and the stage shows a network error
	// where the body should be. Every other GLB-mounting surface routes through
	// this helper; it is a no-op in production.
	const glb = resolveDevR2Url(agentAvatarGlb(agent));
	try { await import('./element.js'); } catch { /* element may already be registered */ }
	// Rebuild the avatar element each load so a new agent shows its own body.
	if (state.avatarEl) { try { state.avatarEl.remove(); } catch { /* ignore */ } state.avatarEl = null; }
	if (dom.avatarPlaceholder) dom.avatarPlaceholder.hidden = true;
	const el = document.createElement('agent-3d');
	el.setAttribute('body', glb);
	el.setAttribute('width', '100%');
	el.setAttribute('height', '100%');
	el.setAttribute('autorotate', '');
	el.className = 'ac-avatar';
	// The element renders behind opacity:0 until it boots — reveal on ready so the
	// stage fades the body in instead of popping a half-loaded mesh.
	el.addEventListener('agent:ready', () => el.classList.add('ready'), { once: true });
	dom.avatarHost.appendChild(el);
	state.avatarEl = el;
}

// ── candidate launches ──────────────────────────────────────────────────────
// Resolved on every write rather than cached: this badge sits next to a
// `data-i18n-html` heading, and any element the i18n pass rewrites is a NEW node
// afterwards. A cached ref there goes stale the moment a locale lands, and the
// counter silently stops updating with no error anywhere.
function setCount(n) {
	const el = document.getElementById('ac-launches-count');
	if (!el) return;
	if (n > 0) {
		const from = parseInt(el.textContent, 10) || 0;
		el.hidden = false;
		countUp(el, from, n, { format: (v) => String(Math.round(v)) });
	} else el.hidden = true;
}

// The launches column is the page's call to action, so it must never render as
// an empty box. Before an agent is on stage (first paint, or every agent source
// down) it says what to do next instead of showing nothing at all.
function showLaunchesIdle(message) {
	setCount(0);
	dom.launchesList.innerHTML = `<div class="ac-state"><div class="ac-state-orb" aria-hidden="true"></div><p>${esc(message)}</p></div>`;
}
const IDLE_PICK = 'Pick a co-pilot above and the live launches it can read land here.';
const IDLE_ID = 'Load an agent by ID above and the live launches it can read land here.';

async function loadCandidates() {
	if (!state.agent) { showLaunchesIdle(IDLE_PICK); return; }
	setCount(0);
	dom.launchesList.innerHTML = skeletonLaunches(4);
	let items = [];
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(state.agent.id)}/alpha/candidates?network=${NETWORK}`, { credentials: 'include' });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(j?.error?.message || 'feed unavailable');
		items = Array.isArray(j.items) ? j.items : [];
	} catch (e) {
		dom.launchesList.innerHTML = `<div class="ac-state ac-state-error"><p>Live feed hiccup — ${esc(e.message || 'try again')}.</p><button type="button" class="ac-btn ac-btn-ghost" id="ac-retry-feed">Retry</button></div>`;
		$('#ac-retry-feed')?.addEventListener('click', loadCandidates);
		return;
	}
	state.candidates = items;
	setCount(items.length);
	if (!items.length) {
		dom.launchesList.innerHTML = `<div class="ac-state"><div class="ac-state-orb" aria-hidden="true"></div><p>No live launches on the feed this second. Fresh pump.fun mints appear here the moment they land.</p><button type="button" class="ac-btn ac-btn-ghost" id="ac-retry-feed">Check again</button></div>`;
		$('#ac-retry-feed')?.addEventListener('click', loadCandidates);
		return;
	}
	// Surface a single "top pick" — the highest combined real conviction — so a
	// first-time visitor has an obvious launch to ask about.
	const topMint = pickTopMint(items);
	dom.launchesList.innerHTML = '';
	for (const c of items) dom.launchesList.appendChild(launchCard(c, c.mint === topMint));
	// Fresh feed lands in legible sequence, then each card's score bars grow from 0.
	enterStagger(dom.launchesList.querySelectorAll('.ac-launch'), { step: 36 });
	playBars(dom.launchesList);
	if (state.activeMint) markActiveLaunch(state.activeMint);
}

// Grow every `.ac-bar-fill` / conviction fill inside `scope` from 0 to its real
// width via the token-driven CSS transition. Reduced motion → already at target.
function playBars(scope) {
	if (!scope) return;
	const fills = scope.querySelectorAll('.ac-bar-fill[data-w], .ac-conviction-fill[data-w]');
	fills.forEach((fill) => {
		const target = fill.getAttribute('data-w');
		if (reducedMotion()) { fill.style.width = target; return; }
		fill.style.width = '0%';
		void fill.getBoundingClientRect();
		requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = target; }));
	});
}

// Rank by the real signals we already have: smart-money + quality, lightly
// boosted by visible liquidity, penalised for a sybil-dominated funder graph.
function pickTopMint(items) {
	let best = null, bestScore = -Infinity;
	for (const c of items) {
		const sm = num(c.smart_money_score) ?? 0;
		const q = num(c.quality_score) ?? 0;
		if (sm === 0 && q === 0) continue;
		let score = sm * 1.1 + q;
		if (c.sybil_flag) score -= 40;
		if (score > bestScore) { bestScore = score; best = c.mint; }
	}
	return best;
}

function scoreBar(label, v, title) {
	const n = num(v);
	const pct = n == null ? 0 : Math.max(0, Math.min(100, n));
	const cls = n == null ? 'is-empty' : n >= 60 ? 'is-good' : n >= 35 ? 'is-mid' : 'is-low';
	return `<div class="ac-bar ${cls}" title="${esc(title)}"><span class="ac-bar-k">${label}</span><span class="ac-bar-track"><span class="ac-bar-fill" style="width:${pct}%" data-w="${pct}%"></span></span><span class="ac-bar-v">${n == null ? '—' : Math.round(n)}</span></div>`;
}

function launchCard(c, isTop) {
	const node = document.createElement('article');
	node.className = 'ac-launch' + (isTop ? ' is-top' : '');
	node.dataset.mint = c.mint;
	const label = c.symbol ? `$${esc(c.symbol)}` : short(c.mint, 4, 4);
	node.innerHTML = `
		${isTop ? '<span class="ac-launch-top">Top pick</span>' : ''}
		<div class="ac-launch-head">
			<div class="ac-launch-id">
				<span class="ac-launch-sym">${label}</span>
				${c.name ? `<span class="ac-launch-name">${esc(c.name)}</span>` : ''}
			</div>
			<div class="ac-launch-num">
				<span class="ac-launch-mc" title="Market cap">${fmtUsd(c.market_cap_usd)}</span>
				<span class="ac-launch-age" title="Age">${ageLabel(c.age_seconds)} old</span>
			</div>
		</div>
		<div class="ac-launch-bars">
			${scoreBar('SM', c.smart_money_score, 'Smart-money score (0–100)')}
			${scoreBar('Q', c.quality_score, 'Quality score (0–100)')}
		</div>
		${c.sybil_flag ? '<span class="ac-flag" title="One funder cluster dominates the holders">sybil cluster</span>' : ''}
		<button type="button" class="ac-btn ac-btn-read" data-mint="${esc(c.mint)}">Ask for a read</button>`;
	node.querySelector('.ac-btn-read').addEventListener('click', () => requestRead(c.mint, label));
	return node;
}

function markActiveLaunch(mint) {
	dom.launchesList.querySelectorAll('.ac-launch').forEach((el) => el.classList.toggle('is-reading', el.dataset.mint === mint));
}

// ── the read ────────────────────────────────────────────────────────────────
function resetRead() {
	state.read = null;
	state.activeMint = null;
	state.lastSpoken = '';
	markActiveLaunch(null);
	dom.readEmpty.hidden = false;
	dom.readBody.hidden = true;
	dom.readBody.innerHTML = '';
	dom.speak.hidden = true;
	dom.speakLine.textContent = '';
}

async function requestRead(mint, label) {
	if (!state.agent || state.loadingRead) return;
	state.loadingRead = true;
	state.activeMint = mint;
	markActiveLaunch(mint);
	dom.readEmpty.hidden = true;
	dom.readBody.hidden = false;
	dom.readBody.innerHTML = `<div class="ac-read-loading"><div class="ac-thinking"><span></span><span></span><span></span></div><p>${esc(state.agent.name || 'The agent')} is reading ${esc(label || 'this launch')}…</p><p class="ac-read-loading-fine">Pulling live liquidity, holders, and smart-money signals.</p></div>`;
	setSpeaking(false);

	let data;
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(state.agent.id)}/alpha/read`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mint, network: NETWORK }),
		});
		data = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(data?.error_description || (typeof data?.error === 'object' ? data.error?.message : null) || `Read failed (${r.status})`);
	} catch (e) {
		dom.readBody.innerHTML = `<div class="ac-state ac-state-error"><p>${esc(e.message || 'The read failed.')}</p><button type="button" class="ac-btn ac-btn-ghost" id="ac-read-retry">Try again</button></div>`;
		$('#ac-read-retry')?.addEventListener('click', () => requestRead(mint, label));
		state.loadingRead = false;
		return;
	}
	state.read = data;
	state.loadingRead = false;
	renderRead(data);
	speakAloud(data.agent, data.read?.spoken_line || '');
}

function verdictMeta(v) {
	if (v === 'snipe') return { label: 'Snipe', cls: 'is-snipe' };
	if (v === 'pass') return { label: 'Pass', cls: 'is-pass' };
	return { label: 'Watch', cls: 'is-watch' };
}

// Which signal rows the agent actually name-checked — matched loosely so a cited
// "smart money" lights up the "Smart money" row regardless of exact phrasing.
function citedSet(cited) {
	const set = new Set();
	for (const raw of cited || []) {
		const k = String(raw).toLowerCase();
		if (/liquid/.test(k)) set.add('Liquidity');
		if (/market\s*cap|mcap|mc\b/.test(k)) set.add('Market cap');
		if (/age|minute|old|new/.test(k)) set.add('Age');
		if (/impact|slippage/.test(k)) set.add('Buy impact (◎0.1)');
		if (/curve|bonding|graduat/.test(k)) set.add('Curve filled');
		if (/quality/.test(k)) set.add('Quality');
		if (/smart|wallet|whale/.test(k)) set.add('Smart money');
		if (/organic|volume|buyer|holder/.test(k)) set.add('Organic');
	}
	return set;
}

function renderRead(data) {
	const read = data.read || {};
	const sig = data.signals || {};
	const vm = verdictMeta(read.verdict);
	const conviction = num(read.conviction) ?? 0;
	const sym = sig.symbol ? `$${esc(sig.symbol)}` : short(data.mint, 4, 4);
	const cited = citedSet(read.cited_signals);

	const signalRows = [
		['Liquidity', fmtSol(sig.liquidity_sol)],
		['Market cap', fmtUsd(sig.market_cap_usd)],
		['Age', sig.age_minutes != null ? `${sig.age_minutes}m` : '—'],
		['Buy impact (◎0.1)', fmtPct(sig.reference_buy_price_impact_pct)],
		['Curve filled', sig.bonding_curve_progress_pct != null ? `${sig.bonding_curve_progress_pct}%` : '—'],
		['Quality', fmtScore(sig.quality_score)],
		['Smart money', sig.smart_money_score != null ? `${fmtScore(sig.smart_money_score)} · ${sig.smart_money_wallets ?? 0} wallet${sig.smart_money_wallets === 1 ? '' : 's'}` : '—'],
		['Organic', fmtScore(sig.organic_score)],
	];

	const ownerWallet = data.owner && sig.wallet_balance_sol != null
		? `<div class="ac-read-wallet"><span class="ac-read-wallet-k">Wallet</span> ${fmtSol(sig.wallet_balance_sol)} · per-trade ${sig.per_trade_limit_sol != null ? fmtSol(sig.per_trade_limit_sol) : '∞'} · daily ${sig.daily_budget_sol != null ? fmtSol(sig.daily_budget_sol) : '∞'}${sig.trading_paused ? ' · <span class="ac-flag">paused</span>' : ''}</div>`
		: '';

	const guard = read.hallucination_guard || {};
	const guardNote = guard.line_replaced
		? `<p class="ac-guard"><span class="ac-guard-dot"></span> A figure in the draft didn't match the live data, so the co-pilot spoke a grounded line instead. The signals below are the ground truth.</p>`
		: '';

	dom.readBody.innerHTML = `
		<div class="ac-read-top">
			<div class="ac-verdict ${vm.cls}">${vm.label}</div>
			<div class="ac-read-target">${sym}${sig.name ? ` · <span class="ac-read-coinname">${esc(sig.name)}</span>` : ''}</div>
		</div>
		<div class="ac-conviction ${vm.cls}" title="How convinced the agent is">
			<div class="ac-conviction-bar"><span class="ac-conviction-fill" style="width:${Math.max(2, conviction)}%" data-w="${Math.max(2, conviction)}%"></span></div>
			<span class="ac-conviction-val"><span class="ac-conviction-num" data-to="${conviction}">${conviction}</span><small>/100 conviction</small></span>
		</div>
		${read.spoken_line ? `<blockquote class="ac-read-quote">“${esc(read.spoken_line)}”</blockquote>` : ''}
		${guardNote}
		${read.risks?.length ? `<div class="ac-risks-wrap"><div class="ac-risks-head">What could go wrong</div><ul class="ac-risks">${read.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
		<div class="ac-read-signals">
			<div class="ac-read-signals-head">Signals it used <span>(live, on-chain)</span></div>
			<dl>${signalRows.map(([k, v]) => `<div class="${cited.has(k) ? 'is-cited' : ''}"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
		</div>
		${ownerWallet}
		<div class="ac-action" id="ac-action"></div>`;

	renderAction(data);
	playRead();
}

// When a real read lands: the conviction bar fills from 0 and counts up, the
// signals it cited stagger in, and the verdict gets one accent ripple — a beat
// that says "the call arrived". All token-driven; reduced motion → final state.
function playRead() {
	playBars(dom.readBody);
	const num = dom.readBody.querySelector('.ac-conviction-num');
	if (num) countUp(num, 0, Number(num.dataset.to) || 0, { format: (v) => String(Math.round(v)) });
	enterStagger(dom.readBody.querySelectorAll('.ac-read-signals dl > div'), { step: 26 });
	rippleOnce(dom.readBody.querySelector('.ac-verdict'));
}

function renderAction(data) {
	const host = $('#ac-action');
	if (!host) return;
	const gate = data.gate || {};
	if (gate.can_act) {
		// fmtSol already prefixes the SOL glyph, so no unit suffix here: appending
		// one renders the amount with a doubled unit ("◎0.01 SOL").
		host.innerHTML = `<button type="button" class="ac-btn ac-btn-act" id="ac-act-go">Act: buy ${fmtSol(gate.size_sol)}</button>
			<p class="ac-action-note">${esc(gate.message || '')}</p>`;
		$('#ac-act-go')?.addEventListener('click', () => openActDrawer(data));
	} else {
		const cls = data.owner ? 'ac-action-blocked' : 'ac-action-public';
		host.innerHTML = `<p class="${cls}">${esc(gate.message || 'No action available.')}</p>`;
	}
}

// ── voice ───────────────────────────────────────────────────────────────────
let currentAudio = null;
function setSpeaking(on) {
	state.speaking = on;
	dom.speak?.classList.toggle('is-speaking', on);
	dom.eq?.classList.toggle('is-on', on);
	$('.ac-stage')?.classList.toggle('is-speaking', on);
}

async function fetchTtsBlob(agent, text) {
	const provider = agent?.voice_provider || 'browser';
	const body = JSON.stringify({ text: text.slice(0, 800), voice: agent?.voice_id || 'nova' });
	const headers = { 'content-type': 'application/json' };
	try {
		if (provider === 'elevenlabs' && agent?.voice_id) {
			// agentId lets the proxy serve the clip on the agent owner's saved
			// ElevenLabs key (BYOK); without it an owner-cloned voice is
			// unreachable on this surface.
			const r = await fetch('/api/tts/eleven', { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ voiceId: agent.voice_id, text: text.slice(0, 500), agentId: agent.id }) });
			if (r.ok) return await r.blob();
		}
		// Default + cloned-but-non-eleven providers: the server's free TTS lane.
		const r = await fetch('/api/tts/speak', { method: 'POST', credentials: 'include', headers, body });
		if (r.ok) return await r.blob();
	} catch { /* fall through to browser TTS */ }
	return null;
}

function playBlob(blob) {
	return new Promise((resolve) => {
		try {
			if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } }
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			currentAudio = audio;
			audio.addEventListener('ended', () => { URL.revokeObjectURL(url); resolve(true); }, { once: true });
			audio.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(false); }, { once: true });
			audio.play().catch(() => resolve(false));
		} catch { resolve(false); }
	});
}

function browserSpeak(text) {
	return new Promise((resolve) => {
		if (typeof speechSynthesis === 'undefined' || !window.SpeechSynthesisUtterance) return resolve(false);
		try {
			speechSynthesis.cancel();
			const u = new SpeechSynthesisUtterance(text);
			u.rate = 1.02; u.pitch = 1;
			u.onend = () => resolve(true);
			u.onerror = () => resolve(false);
			speechSynthesis.speak(u);
		} catch { resolve(false); }
	});
}

async function speakAloud(agent, text) {
	const line = (text || '').trim();
	if (!line) return;
	state.lastSpoken = line;
	dom.speak.hidden = false;
	dom.speakLine.textContent = line;
	setSpeaking(true);
	// Gesture: the avatar plays a talk animation for the line's length.
	try { state.avatarEl?.speak?.(line); } catch { /* avatar still mounting */ }
	let played = false;
	const blob = await fetchTtsBlob(agent, line);
	if (blob) played = await playBlob(blob);
	if (!played) played = await browserSpeak(line);
	setSpeaking(false);
}

// ── act (owner) ─────────────────────────────────────────────────────────────
function openActDrawer(data) {
	const gate = data.gate || {};
	const sig = data.signals || {};
	const sym = sig.symbol ? `$${esc(sig.symbol)}` : short(data.mint, 4, 4);
	dom.actBody.innerHTML = `
		<p class="ac-act-lead">${esc(state.agent?.name || 'Your agent')} wants to buy <strong>${fmtSol(gate.size_sol)}</strong> of ${sym}.</p>
		<div class="ac-act-quote" id="ac-act-quote">Fetching a fresh live quote…</div>
		<div class="ac-act-controls">
			<button type="button" class="ac-btn ac-btn-act" id="ac-act-confirm" disabled>Confirm buy</button>
			<button type="button" class="ac-btn ac-btn-ghost" data-close>Cancel</button>
		</div>
		<p class="ac-act-fine">Executes through the agent's guarded wallet — re-checked against the firewall and your spend limits at submit, and written to the custody audit.</p>`;
	showDrawer(true);

	const confirmBtn = $('#ac-act-confirm');
	const quoteHost = $('#ac-act-quote');
	let quote = null;
	previewAgentTrade({ agentId: state.agent.id, side: 'buy', mint: data.mint, solAmount: gate.size_sol, slippageBps: 300, network: NETWORK })
		.then((q) => {
			quote = q;
			const impact = num(q?.price_impact_pct ?? q?.priceImpactPct);
			const expected = q?.expected_out ?? q?.out?.amount ?? q?.outUi;
			const warn = q?.warning || q?.blocked_reason;
			quoteHost.innerHTML = `
				<div class="ac-act-qrow"><span>You pay</span><strong>${fmtSol(gate.size_sol)}</strong></div>
				${expected != null ? `<div class="ac-act-qrow"><span>Expected</span><strong>${Number(expected).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(sig.symbol || 'tokens')}</strong></div>` : ''}
				<div class="ac-act-qrow"><span>Price impact</span><strong>${fmtPct(impact)}</strong></div>
				${warn ? `<p class="ac-act-warn">${esc(warn)}</p>` : ''}`;
			confirmBtn.disabled = false;
		})
		.catch((e) => {
			quoteHost.innerHTML = `<p class="ac-act-warn">Couldn't fetch a live quote: ${esc(e.message || 'try again')}.</p>`;
		});

	confirmBtn?.addEventListener('click', async () => {
		confirmBtn.disabled = true;
		confirmBtn.textContent = 'Submitting…';
		try {
			const res = await executeAgentTrade({
				agentId: state.agent.id, side: 'buy', mint: data.mint,
				solAmount: gate.size_sol, slippageBps: 300, network: NETWORK,
				idempotencyKey: (crypto?.randomUUID?.() || `ac-${Date.now()}-${Math.random().toString(16).slice(2)}`),
			});
			const sig2 = res?.signature;
			const spent = res?.sol_spent ?? gate.size_sol;
			dom.actBody.innerHTML = `
				<div class="ac-act-done">
					<div class="ac-act-done-mark">✓</div>
					<p>Bought into ${sym} for ${fmtSol(spent)}.</p>
					${sig2 ? `<a class="ac-btn ac-btn-ghost" href="${esc(res.explorer || explorerTxUrl(sig2))}" target="_blank" rel="noopener">View transaction</a>` : ''}
					${res?.new_balance_sol != null ? `<p class="ac-act-fine">Wallet now ${fmtSol(res.new_balance_sol)}.</p>` : ''}
					<a class="ac-act-audit" href="/agent/${esc(state.agent.id)}" target="_blank" rel="noopener">See it in the custody trail →</a>
				</div>`;
		} catch (e) {
			const msg = e instanceof TradeError ? e.message : (e?.message || 'Trade failed.');
			dom.actBody.querySelector('.ac-act-controls')?.insertAdjacentHTML('beforebegin', `<p class="ac-act-warn">${esc(msg)}</p>`);
			confirmBtn.disabled = false;
			confirmBtn.textContent = 'Confirm buy';
		}
	});
}

// Focus follows the dialog: opening it moves the caret inside (otherwise a
// keyboard user keeps tabbing the page behind an aria-modal overlay) and closing
// it hands focus back to whatever opened it.
let drawerReturnFocus = null;
function showDrawer(open) {
	dom.actDrawer.hidden = !open;
	document.body.style.overflow = open ? 'hidden' : '';
	if (open) {
		drawerReturnFocus = document.activeElement;
		dom.actDrawer.querySelector('.ac-modal-x')?.focus();
	} else if (drawerReturnFocus) {
		try { drawerReturnFocus.focus(); } catch { /* the trigger left the DOM */ }
		drawerReturnFocus = null;
	}
}
function wireDrawer() {
	dom.actDrawer.addEventListener('click', (e) => {
		if (e.target.matches('[data-close]')) showDrawer(false);
	});
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dom.actDrawer.hidden) showDrawer(false); });
}

// ── skeletons ───────────────────────────────────────────────────────────────
function skeletonLaunches(n) {
	return Array.from({ length: n }, () => `<div class="ac-launch ac-skel"><div class="ac-skel-line w60"></div><div class="ac-skel-line w40"></div><div class="ac-skel-line w80"></div></div>`).join('');
}

// ── boot ────────────────────────────────────────────────────────────────────
// Resolve a concrete agent id to open with, in priority order: an explicit
// ?agent=, the last one this browser used, the signed-in caller's own agent,
// then a featured public agent — so the page is always live, never a blank void.
async function resolveInitialAgent() {
	const url = new URL(location.href);
	const fromUrl = parseAgentId(url.searchParams.get('agent'));
	if (fromUrl) return fromUrl;
	const stored = (() => { try { return localStorage.getItem(LS_KEY); } catch { return null; } })();
	if (stored && UUID_RE.test(stored)) return stored;
	try {
		const r = await fetch('/api/agents/me', { credentials: 'include' });
		if (r.ok) { const j = await r.json().catch(() => ({})); const a = j.agent || j; if (a?.id) return a.id; }
	} catch { /* logged out — fall through to a featured agent */ }
	try {
		const r = await fetch('/api/agents/featured', { credentials: 'include' });
		if (r.ok) { const j = await r.json().catch(() => ({})); const fid = j?.data?.id; if (fid && UUID_RE.test(fid)) return fid; }
	} catch { /* no featured agent — wait for the gallery */ }
	return null;
}

async function init() {
	cacheDom();
	wireDrawer();
	showLaunchesIdle(IDLE_PICK);
	dom.idToggle.addEventListener('click', () => revealIdRow(dom.idRow.hidden));
	dom.agentLoad.addEventListener('click', () => {
		const id = parseAgentId(dom.agentInput.value);
		if (id) loadAgent(id);
		else { dom.agentInput.focus(); dom.agentInput.classList.add('is-invalid'); setTimeout(() => dom.agentInput.classList.remove('is-invalid'), 1200); }
	});
	dom.agentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.agentLoad.click(); });
	dom.refresh.addEventListener('click', loadCandidates);
	dom.replay.addEventListener('click', () => { if (state.lastSpoken) speakAloud(state.read?.agent || state.agent, state.lastSpoken); });
	const mintFromUrl = new URL(location.href).searchParams.get('mint');

	// Fire the gallery and the initial-agent resolution together; whichever the
	// resolver returns gets highlighted in the rail once it renders.
	const galleryP = loadGallery();
	const id = await resolveInitialAgent();
	if (id) {
		await loadAgent(id);
		dom.agentInput.value = id;
		if (mintFromUrl && UUID_RE.test(id)) requestRead(mintFromUrl, null);
	} else {
		// No agent anywhere — let the gallery be the call to action; open the ID row
		// as a fallback only if the gallery also came up empty.
		await galleryP;
		if (!state.gallery.length) {
			setOwnText(dom.avatarPlaceholder.querySelector('span:last-child'), 'Enter an agent ID (or paste a profile URL) to begin.');
			showLaunchesIdle(IDLE_ID);
		}
	}
	await galleryP;
	if (state.agent) markActiveCard(state.agent.id);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
