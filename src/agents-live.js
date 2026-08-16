// /agents-live — the live agent wall.
//
// Shows EVERY agent on the platform (the full public directory + the signed-in
// owner's own agents), each as a card with a live screen. For each agent we open
// an SSE listener to /api/agent-screen-stream:
//   • If a Playwright caster is pushing frames, we paint those frames verbatim.
//   • Otherwise we render the agent's real activity (its agent_actions, streamed
//     from the DB by the endpoint) as a live terminal — so a screen is NEVER
//     blank, for any agent, 24/7, at zero compute cost.
//
// Watching a card also signals intent (/api/agent/watch-intent) so the on-demand
// caster pool can spin a real browser up for agents people are actually looking
// at, and tear it down when they leave. That keeps live pixels available for any
// agent on demand without paying for an idle browser per agent.
//
// Two layers feed those screens, because they answer different questions:
//
//   • Every mounted card gets its real activity from ONE batched request to
//     /api/agents/activity (whole page, one round-trip), refreshed on a slow
//     cadence. That is a poll, and a poll does not need a socket.
//   • Cards near the viewport additionally hold a real SSE listener for live
//     pixels, reactions and market-maker pushes, bounded by a pool sized from
//     the origin's actual transport.
//
// It used to be one SSE stream per card. A browser caps concurrent connections
// per origin (6 on HTTP/1.1, a stream budget on HTTP/2) and an SSE stream never
// releases its slot, so on a 48-card roster the first six connected and the
// other 42 sat on "Connecting" forever while the page's own fetches queued
// behind them.

import { parsePnlDelta, formatSol, formatUsd } from './shared/trade-pnl.js';
import { mountAgentReactions } from './agent-reactions.js';
import { fetchBatchBalances } from './shared/pnl-fetch.js';
import { formatPnl, formatUsd as formatNetWorthUsd } from './shared/pnl-snapshot.js';
import { coalesce, timeline, colorHex } from './activity-cinema.js';
import { connectFeed, loadSnapshot } from './theater-feed.js';
import { TOUR_PREFIX } from './tour-commentary.js';
import { sanitizeMmEvent, fmtPriceSol } from './shared/mm-render.js';
import { parseForgeFrame } from './shared/forge-frames.js';
import { createArena } from './agents-live-arena.js';
import { createShowrunner } from './showrunner.js';
import { apiFetch, noteSession } from './api.js';
import { streamPoolSize } from './shared/stream-pool.js';

// Subtle accent for a card showing a live Coin World Tour walkthrough.
(() => {
	if (document.getElementById('al-tour-style')) return;
	const st = document.createElement('style');
	st.id = 'al-tour-style';
	st.textContent = '.al-card--tour{box-shadow:0 0 0 1px rgba(154,123,255,.45),0 10px 30px rgba(154,123,255,.12)}';
	document.head.appendChild(st);
})();

// Floor Defense badge — surfaces the market-maker floor an agent is defending,
// pulsing on every dip-buy and ambering when the marker touches the floor line.
(() => {
	if (document.getElementById('al-mm-style')) return;
	const st = document.createElement('style');
	st.id = 'al-mm-style';
	st.textContent = `
.al-card-floor{position:absolute;left:10px;bottom:10px;z-index:5;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;font:600 11px/1 var(--font-mono,ui-monospace,monospace);color:#6ee7ff;background:rgba(110,231,255,.1);border:1px solid rgba(110,231,255,.32);backdrop-filter:blur(6px);transition:box-shadow .25s,border-color .25s,color .25s}
.al-card-floor .al-floor-anchor{font-size:11px;opacity:.85}
.al-card-floor.touch{color:#34d399;border-color:rgba(52,211,153,.45);background:rgba(52,211,153,.12)}
.al-card-floor.defend{animation:al-floor-flash .9s ease-out}
.al-card-floor .al-floor-sim{font-weight:700;letter-spacing:.05em;color:#9a7bff;background:rgba(154,123,255,.16);border-radius:4px;padding:1px 4px;font-size:9px}
@keyframes al-floor-flash{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}100%{box-shadow:0 0 0 10px rgba(52,211,153,0)}}
@media (prefers-reduced-motion: reduce){.al-card-floor.defend{animation:none}}`;
	document.head.appendChild(st);
})();

const grid       = document.getElementById('al-grid');
const liveCount  = document.getElementById('al-live-count');
const statsBar   = document.getElementById('al-stats');
const statLive   = document.getElementById('al-stat-live');
const statFps    = document.getElementById('al-stat-fps');       // legacy tile (removed from header)
const statTotal  = document.getElementById('al-stat-total');
const statActive = document.getElementById('al-stat-active');

// Per-agent runtime state. agentId → { es, card, entries, lastFrameAt, live }
const _cards = new Map();
const _fpsMap = new Map();   // agentId → frames since last tick

// Roster pagination. The wall uses the activity-ranked `live` sort, which is
// offset-paginated (its order isn't a created_at keyset). `_rosterTotal` /
// `_activeTotal` are the platform-wide header-stat counts the first page carries.
let   _offset = 0;
let   _hasMore = true;
let   _loading = false;
let   _rosterTotal = null;   // meaningful public agents (the wall's addressable size)
let   _activeTotal = null;   // public agents with any real activity

// Interval handles for the FPS ticker and idle repaint loops.
let   _fpsInterval = null;
let   _idleRepaint = null;

const FRAME_STALE_MS = 6000;       // no frame within this window ⇒ fall back to activity
const WATCH_PING_MS  = 20000;      // re-assert watch intent while a card is on screen
const WATCH_STATUS_MS = 4000;      // refresh the warming/queued handoff while not yet live
const STREAM_CONNECT_GRACE_MS = 8000; // stop claiming "Connecting" if a stream never lands
const STATUS_GRACE_POLLS = 3;      // keep polling this many ticks to cover the intent→status write race

// Cards currently intersecting the viewport. Only these signal watch intent and
// poll handoff status, so the bounded Chromium pool spins up exactly for the
// agents a viewer is actually looking at — and frees the slot the instant they
// scroll away (the worker tears a caster down once its agent leaves the wanted
// window). IntersectionObserver maintains this set.
const _inView = new Set();
let _observer = null;

// ── SSE stream pool ──────────────────────────────────────────────────────────
// A second, wider observer band: cards within STREAM_MARGIN of the viewport are
// "near view" and eligible for a stream, so a card is already tailing by the time
// it scrolls into sight. `_streamed` is insertion-ordered and used as an LRU:
// re-touching an id moves it to the end, and eviction takes from the front.
const STREAM_MARGIN = '400px 0px';
const _nearView = new Set();
const _streamed = new Set();
let _streamObserver = null;

// How many SSE listeners the origin can actually carry at once (see
// shared/stream-pool.js). Read from the real navigation entry rather than
// guessed: prod is served over h2 behind the load balancer, vite dev is
// http/1.1, and the two budgets are nothing alike.
function detectPoolSize() {
	try {
		const nav = performance.getEntriesByType('navigation')[0];
		return streamPoolSize(nav?.nextHopProtocol);
	} catch { return 4; }
}

const MAX_STREAMS = detectPoolSize();

// Showrunner Director — programs the wall like a live TV channel: a rotating
// spotlight stage above the grid + a float-the-active-agents-up grid order.
// Declared here (not in the boot section) so the stream callbacks wired up
// during loadMore() can safely reference them via optional chaining before the
// controller is constructed. See the "showrunner / spotlight" section below.
let _showrunner = null;
let _feedEvents = [];   // latest normalized ticker events, for the no-dead-air mode

// ── cinematic terminal: typed-reveal animation clock ──────────────────────────
// A card's fallback terminal types its newest beat in, character by character,
// driven by a single shared rAF (not per-card timers). Cards mid-reveal live in
// _animating; the loop repaints them off a real frame clock and drops each one
// the moment its reveal + hold window elapses, so an idle wall costs nothing.
const REDUCED_MOTION = typeof matchMedia === 'function'
	&& matchMedia('(prefers-reduced-motion: reduce)').matches;
const _animating = new Set();
let _rafId = null;

// Reputation Arena — stamps each card with its real wallet-trust tier/score and
// reorders the wall so the most-trusted agents rise to the top (see
// agents-live-arena.js). Refreshed after every roster page and on a slow poll.
const _arena = createArena({ grid, cards: _cards, reducedMotion: REDUCED_MOTION });

function ensureRaf() {
	if (_rafId != null) return;
	const tick = () => {
		if (_animating.size === 0) { _rafId = null; return; }
		for (const s of _animating) {
			if (isLiveNow(s)) { _animating.delete(s); continue; }
			paintActivity(s);
		}
		_rafId = _animating.size ? requestAnimationFrame(tick) : null;
	};
	_rafId = requestAnimationFrame(tick);
}

// A stable signature for the newest beat so we restart the typed reveal only when
// the agent genuinely does something new (not on every idle repaint).
function beatSig(beat) {
	return beat ? `${beat.key}:${beat.ts ?? 0}:${beat.count}` : '';
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

// ── roster ──────────────────────────────────────────────────────────────────

// Pull a page of agents from the public directory using the activity-ranked
// `live` sort — agents that acted most recently lead the wall, and never-used
// placeholder agents (onboarding default name, no activity, no chats, no on-chain
// identity) are suppressed server-side, so the grid reads as alive instead of a
// graveyard of empty test agents. When signed in we also merge the caller's own
// agents (which may be private) so an owner always sees theirs.
// Resolve the viewer's session exactly once. /api/auth/me answers 200 with
// `{ user: null }` for a signed-out visitor, so this costs one clean request and
// buys two things: we skip the owner-roster read (/api/agents) that could only
// 401 for an anonymous viewer, and we tell the shared client to skip the CSRF
// pre-flight on the public batch-balance POST. Both of those 401s used to land
// as red console errors on every signed-out visit to this very public page.
let _sessionPromise = null;
function hasSession() {
	if (!_sessionPromise) {
		_sessionPromise = fetch('/api/auth/me', { credentials: 'include', headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => !!(d && d.user))
			.catch(() => false)
			.then((ok) => { noteSession(ok); return ok; });
	}
	return _sessionPromise;
}

async function fetchRosterPage() {
	const firstPage = _offset === 0;
	const params = new URLSearchParams({ sort: 'live', limit: '48', offset: String(_offset) });
	let agents = [];
	let hasMore = false;
	let failed = false;
	try {
		const res = await fetch(`/api/agents/public?${params}`, { headers: { accept: 'application/json' } });
		if (res.ok) {
			const data = await res.json();
			agents = data.agents || [];
			hasMore = !!data.has_more;
			if (typeof data.next_offset === 'number') _offset = data.next_offset;
			else _offset += agents.length;
			// First page carries the platform-wide header-stat counts.
			if (Number.isFinite(data.total)) _rosterTotal = data.total;
			if (Number.isFinite(data.active_total)) _activeTotal = data.active_total;
		} else {
			failed = true;
		}
	} catch { failed = true; }

	// First page only: merge the owner's own agents so a signed-in user always
	// sees their roster even if some are private / not yet in the public index.
	// Gated on a resolved session: asking anonymously only ever returns 401.
	if (firstPage && await hasSession()) {
		try {
			const res = await fetch('/api/agents', { credentials: 'include', headers: { accept: 'application/json' } });
			if (res.ok) {
				const data = await res.json();
				const own = (data.agents || []).map((a) => ({
					id: a.id,
					name: a.name || a.display_name || 'Agent',
					avatar_thumbnail: a.avatar_thumbnail_url || a.avatar_url || a.avatar_glb_url || '',
					owned: true,
				}));
				const seen = new Set(agents.map((a) => a.id));
				agents = [...own.filter((a) => !seen.has(a.id)), ...agents];
			}
		} catch { /* anonymous — public list only */ }
	}

	// `failed` only stands if we ended up with nothing to show: when the owner's
	// own agents merged in, the wall still has real cards and the public-list
	// outage degrades to a partial roster rather than an error screen.
	return { agents, hasMore, failed: failed && !agents.length };
}

// ── card ──────────────────────────────────────────────────────────────────────

function buildCard(agent) {
	const id     = agent.id || agent.agentId;
	const name   = agent.name || agent.agentName || 'Agent';
	const avatar = agent.avatar_thumbnail || agent.avatarUrl || agent.avatar_url || '';
	const watchHref = `/agent-screen?agentId=${encodeURIComponent(id)}`;

	const el = document.createElement('a');
	el.className = 'al-card';
	el.href = watchHref;
	el.target = '_blank';
	el.rel = 'noopener';
	el.dataset.agentId = id;
	el.innerHTML = `
<div class="al-card-screen">
  <canvas class="al-card-canvas" width="640" height="360"></canvas>
  <div class="al-card-overlay"></div>
  <div class="al-card-warming" data-warming hidden>
    <span class="al-warming-pulse"></span>
    <span class="al-warming-text" data-warming-text></span>
  </div>
  <div class="al-card-live-badge">
    <div class="al-card-live-dot idle" data-dot></div>
    <span data-status>Idle</span>
  </div>
  <div class="al-card-floor" data-mm hidden title="Market-maker floor under defense">
    <span class="al-floor-anchor">⚓</span>
    <span data-mm-floor></span>
    <span class="al-floor-sim" data-mm-sim hidden>SIM</span>
  </div>
  <div class="al-card-networth" data-networth hidden title="24h portfolio change"></div>
  <div class="al-card-expand">⛶</div>
  <div class="al-card-reactions" data-reactions></div>
</div>
<div class="al-card-info">
  ${avatar
		? `<img loading="lazy" decoding="async" class="al-card-avatar" src="${esc(avatar)}" alt="${esc(name)}" data-fallback="hide">`
		: `<div class="al-card-avatar" style="background:rgba(255,255,255,0.06)"></div>`}
  <div class="al-card-meta">
    <div class="al-card-name">${esc(name)}</div>
    <div class="al-card-action" data-action>Standing by</div>
    <div class="al-card-submeta">
      <span class="al-card-age" data-age hidden></span>
      <span class="al-card-pnl" data-pnl hidden></span>
    </div>
  </div>
  <a class="al-card-watch-btn" href="${esc(watchHref)}" target="_blank" rel="noopener" data-stop-propagation>Watch</a>
</div>`;
	return el;
}

// Surface the market-maker floor an agent is defending. `live` flags a real-time
// event (pulse the badge on a dip-buy) vs a backfill draw (just set the line).
// Sanitized through the shared mm-render whitelist so a bad push can't poison it.
function updateMmBadge(state, rawMm, live) {
	const mm = sanitizeMmEvent(rawMm);
	if (!mm) return;
	const badge = state.card.querySelector('[data-mm]');
	if (!badge) return;
	badge.hidden = false;
	const floorEl = badge.querySelector('[data-mm-floor]');
	if (floorEl) floorEl.textContent = fmtPriceSol(mm.floorSol);
	const simEl = badge.querySelector('[data-mm-sim]');
	if (simEl) simEl.hidden = !mm.simulate;
	const touching = mm.floorSol > 0 && mm.priceSol > 0 && mm.priceSol <= mm.floorSol * 1.02;
	badge.classList.toggle('touch', touching);
	if (live && mm.type === 'mm_defend') {
		badge.classList.remove('defend');
		// reflow so the animation restarts on a back-to-back defend
		void badge.offsetWidth;
		badge.classList.add('defend');
		if (state.action) state.action.textContent = `🛡 Defended floor at ${fmtPriceSol(mm.priceSol)}`;
	}
}

// Surface a live agent-to-agent hire on the card. The hire visualizer lives on
// /agent-screen; here we just flash the wall card when one settles and label the
// action line with who got hired, linking the wall to live commerce. `live` gates
// the flash so backfill replays only set the text.
function updateHireFlash(state, meta, live) {
	if (!meta || meta.kind !== 'a2a_hire' || !state.action) return;
	const provider = String(meta.providerName || 'an agent').slice(0, 22);
	const usd = typeof meta.usd === 'number' && Number.isFinite(meta.usd) ? `$${meta.usd.toFixed(2)}` : '';
	if (meta.phase === 'settled' || meta.phase === 'recorded') {
		state.action.textContent = `⇄ hired ${provider}${usd ? ` · ${usd}` : ''}`;
		state.action.classList.remove('al-on-air');
		if (live && meta.phase === 'settled') {
			state.card.classList.remove('al-card--hired');
			void state.card.offsetWidth; // restart the flash keyframe
			state.card.classList.add('al-card--hired');
		}
	} else if (meta.phase === 'over_cap') {
		state.action.textContent = `⚠ hire skipped · over cap`;
	} else if (meta.phase === 'quote' || meta.phase === 'running' || meta.phase === 'reserved') {
		state.action.textContent = `⇄ hiring ${provider}${usd ? ` · ${usd}` : ''}…`;
	}
}

// Format a beat's age into a compact relative stamp.
function fmtAge(ts) {
	const age = Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 1000));
	return age < 5 ? 'now' : age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
}

// A coarser "last active" stamp for the card recency badge — spans up to weeks so
// an agent that acted days ago still reads honestly. Returns null past ~5 weeks so
// long-dormant agents don't wear a misleading "active" chip.
function fmtAgo(ts) {
	if (!ts) return null;
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	const d = Math.round(s / 86400);
	if (d <= 34) return d === 1 ? 'yesterday' : `${d}d ago`;
	return null;
}

// Paint the card's "last active" recency badge from the agent's most-recent real
// action. Hidden while a live caster is streaming (the Live badge dominates) and
// for agents with no recorded activity yet. This is what keeps every non-casting
// card reading as alive — a truthful "active 6m ago", never a faked pulse.
function renderAge(state) {
	if (!state.age) return;
	if (isLiveNow(state)) { state.age.hidden = true; return; }
	const label = fmtAgo(state.lastActionAt);
	if (!label) { state.age.hidden = true; return; }
	state.age.hidden = false;
	const recent = Date.now() - state.lastActionAt < 15 * 60 * 1000; // acted in last 15m
	state.age.classList.toggle('is-recent', recent);
	state.age.textContent = `active ${label}`;
	state.age.title = `Last on-chain / skill action ${label}`;
}

// Render the agent's recent activity as a CINEMATIC live terminal onto the card
// canvas — the always-available view shown whenever live pixels aren't arriving.
// Each real action becomes a typed, colour-graded, icon-led line; consecutive
// same-kind actions collapse into one beat ("Defended floor ×3"); the newest
// beat reveals character by character off a real frame clock and the high/
// celebratory ones carry a severity glow. Honors prefers-reduced-motion.
function paintActivity(state) {
	const { card, entries, name } = state;
	const canvas = card.querySelector('canvas');
	const ctx = canvas.getContext('2d');
	const W = canvas.width, H = canvas.height;
	const t = Date.now() / 1000;

	const g = ctx.createLinearGradient(0, 0, 0, H);
	g.addColorStop(0, '#0d0d11');
	g.addColorStop(1, '#070708');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, W, H);
	ctx.shadowBlur = 0;

	// header
	ctx.fillStyle = 'rgba(255,255,255,0.03)';
	ctx.fillRect(0, 0, W, 30);
	ctx.beginPath();
	ctx.arc(16, 15, 3.5, 0, Math.PI * 2);
	ctx.fillStyle = 'rgba(120,120,128,0.6)';
	ctx.fill();
	ctx.font = '600 11px Inter, system-ui, sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.55)';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(`${(name || 'Agent').slice(0, 28)} · activity`, 28, 15);

	// Empty → a designed standby card, not a blank void. Three honest variants:
	// the stream is being opened, the agent has a real history we have not pulled
	// yet (pooled out, or the log is still in flight), or it genuinely never acted.
	if (!entries || !entries.length) {
		const acted = state.actionCount > 0;
		const ago = fmtAgo(state.lastActionAt);
		let head, l1, l2;
		if (state.attaching) {
			head = 'Opening the tail';
			l1 = acted ? `${state.actionCount.toLocaleString('en-US')} actions recorded` : 'Reading this agent\'s activity';
			l2 = ago ? `last active ${ago}` : '';
		} else if (acted) {
			head = 'Standing by';
			l1 = `${state.actionCount.toLocaleString('en-US')} actions recorded`;
			l2 = ago ? `last active ${ago} · scroll here to tail it live` : 'scroll here to tail it live';
		} else {
			head = 'Standing by';
			l1 = 'No actions yet. This agent will narrate';
			l2 = 'here the moment it acts.';
		}
		ctx.font = '500 12px "Courier New", monospace';
		ctx.fillStyle = 'rgba(255,255,255,0.32)';
		ctx.fillText(head, 16, 60);
		const headW = ctx.measureText(head).width;
		ctx.font = '400 11px "Courier New", monospace';
		ctx.fillStyle = 'rgba(255,255,255,0.18)';
		if (l1) ctx.fillText(l1, 16, 84);
		if (l2) ctx.fillText(l2, 16, 102);
		if (!REDUCED_MOTION && Math.sin(t * 4) > 0) {
			ctx.fillStyle = 'rgba(255,255,255,0.22)';
			ctx.fillRect(16 + headW + 4, 53, 7, 13);
		}
		if (state.action) state.action.textContent = state.attaching ? 'Opening the tail…' : 'Standing by';
		return;
	}

	// Beats: oldest-first from coalesce → reverse for newest-first display.
	const beats = coalesce(entries);
	const newest = beats[beats.length - 1];
	const newestSig = beatSig(newest);

	// New beat detected → (re)start the typed reveal on a real frame clock.
	if (newestSig && newestSig !== state.lastBeatSig) {
		state.lastBeatSig = newestSig;
		if (!REDUCED_MOTION) {
			const tl = timeline(newest, beats[beats.length - 2]);
			state.typed = { sig: newestSig, startedAt: performance.now(), charMs: tl.charMs, typeMs: tl.typeMs, holdMs: tl.holdMs };
			_animating.add(state);
			ensureRaf();
		}
	}

	const display = beats.slice().reverse(); // newest-first
	const lH = 26;
	const y = 54;
	const max = Math.floor((H - 50) / lH);

	display.slice(0, max).forEach((beat, i) => {
		const latest = i === 0;
		const lineY = y + i * lH;
		const cls = beat; // coalesce already carries icon/colorToken/severity/label
		const base = colorHex(cls.colorToken);

		// A realized exit tints its line green/red so the terminal reads as a tape,
		// overriding the category colour for that line only.
		const exitDelta = parsePnlDelta(beat.members?.[beat.members.length - 1]?.pnl);
		const exitSign = exitDelta?.phase === 'exit' ? (exitDelta.solDelta ?? exitDelta.realizedUsd ?? 0) : null;
		const lineColor = (exitSign != null && exitSign !== 0)
			? (exitSign > 0 ? '#6ee7a0' : '#f9a8a8')
			: base;

		// timestamp prefix
		ctx.shadowBlur = 0;
		ctx.font = '600 11px "Courier New", monospace';
		ctx.fillStyle = latest ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
		const pfx = `[${fmtAge(beat.ts)}] `;
		ctx.fillText(pfx, 16, lineY);
		let x = 16 + ctx.measureText(pfx).width;

		// icon glyph (graded to the line colour)
		ctx.font = '13px "Apple Color Emoji","Segoe UI Emoji",system-ui,sans-serif';
		ctx.globalAlpha = latest ? 1 : 0.5;
		ctx.fillText(cls.icon, x, lineY);
		ctx.globalAlpha = 1;
		x += 20;

		// severity glow on the newest beat (pulses while animating, static after)
		if (latest && cls.severity !== 'normal') {
			let intensity = 0.7;
			if (!REDUCED_MOTION) intensity = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 5));
			ctx.shadowColor = base;
			ctx.shadowBlur = 14 * intensity;
		}

		// body text — newest beat is typed in; older beats render whole
		const full = (beat.activity || beat.type || 'action');
		let text = full;
		let typing = false;
		if (latest && state.typed && state.typed.sig === newestSig && !REDUCED_MOTION) {
			const elapsed = performance.now() - state.typed.startedAt;
			const n = Math.floor(elapsed / state.typed.charMs);
			if (n < full.length) { text = full.slice(0, n); typing = true; }
		}

		ctx.font = `${latest ? '600' : '400'} 12px "Courier New", monospace`;
		ctx.fillStyle = latest ? lineColor : (cls.severity === 'normal' ? 'rgba(255,255,255,0.4)' : `${base}88`);
		const room = Math.floor((W - x - 30) / 7);
		ctx.fillText(text.slice(0, room), x, lineY);
		ctx.shadowBlur = 0;

		// count badge for a collapsed beat: "×3"
		if (beat.count > 1) {
			const tw = ctx.measureText(text.slice(0, room)).width;
			ctx.font = '700 10px "Courier New", monospace';
			ctx.fillStyle = latest ? base : 'rgba(255,255,255,0.35)';
			ctx.fillText(`×${beat.count}`, Math.min(x + tw + 8, W - 28), lineY);
		}

		// blinking caret at the end of the line while typing
		if (typing && Math.sin(performance.now() / 140) > 0) {
			const tw = ctx.measureText(text.slice(0, room)).width;
			ctx.fillStyle = base;
			ctx.fillRect(x + tw + 2, lineY - 6, 6, 12);
		}
	});

	// Reveal complete (+ hold window) → drop out of the rAF set; idle repaint keeps
	// the relative stamps fresh from here on.
	if (state.typed && !REDUCED_MOTION) {
		const elapsed = performance.now() - state.typed.startedAt;
		if (elapsed >= state.typed.typeMs + state.typed.holdMs) {
			state.typed = null;
			_animating.delete(state);
		}
	}

	if (state.action) state.action.textContent = newest.activity || newest.label || 'active';
}

function isLiveNow(state) {
	return state.lastFrameAt && (Date.now() - state.lastFrameAt) < FRAME_STALE_MS;
}

// Fold one trade frame/log entry's realized exit into the card's running PnL and
// render the colored chip. Deduped by timestamp so the reconnect backfill can't
// double-count. Returns true when a fresh exit moved the number.
function ingestCardPnl(state, entry) {
	const delta = parsePnlDelta(entry?.pnl);
	if (!delta || delta.phase !== 'exit') return false;
	const ts = Number(entry.ts) || 0;
	if (ts && state.seenPnlTs.has(ts)) return false;
	if (ts) state.seenPnlTs.add(ts);
	if (delta.realizedUsd != null) { state.realizedUsd += delta.realizedUsd; state.sawUsd = true; }
	if (delta.solDelta != null) state.realizedSol += delta.solDelta;
	renderCardPnl(state);
	return true;
}

function renderCardPnl(state) {
	const chip = state.card.querySelector('[data-pnl]');
	if (!chip) return;
	const primary = state.sawUsd ? state.realizedUsd : state.realizedSol;
	if (!Number.isFinite(primary)) { chip.hidden = true; return; }
	chip.hidden = false;
	chip.classList.toggle('pos', primary > 1e-9);
	chip.classList.toggle('neg', primary < -1e-9);
	chip.textContent = state.sawUsd ? (formatUsd(primary) ?? formatSol(state.realizedSol)) : formatSol(primary);
	chip.title = `Session realized P&L · ${formatSol(state.realizedSol)}`;
}

// Vanity Grinder ticker: turn a grind frame into a compact card line. The live
// grind pushes `analysis` frames whose activity reads "4.18M attempts · 38.9k/sec
// · expected ~11.3M"; the MATCH frame carries a { kind:'vanity_match', address }
// meta sidecar. Returns a short string for the card's action line, or null when
// the frame isn't a grind frame.
function parseGrindTicker(msg) {
	if (msg?.meta?.kind === 'vanity_match' && typeof msg.meta.address === 'string') {
		const a = msg.meta.address;
		return `🔑 matched ${a.slice(0, 6)}…${a.slice(-4)}`;
	}
	const act = typeof msg?.activity === 'string' ? msg.activity : '';
	if (/\d[\d.,kM]*\s*attempts/i.test(act) && /\/sec/i.test(act)) {
		const rate = act.match(/·\s*([\d.,kM]+\/sec)/i);
		return rate ? `⛏ grinding · ${rate[1]}` : `⛏ ${act}`;
	}
	if (/^MATCH\b/i.test(act)) return '🔑 vanity match found';
	return null;
}

function attachStream(state) {
	const { card, agentId } = state;
	if (state.es) { try { state.es.close(); } catch { /* */ } }

	const dot      = card.querySelector('[data-dot]');
	const statusEl = card.querySelector('[data-status]');
	const canvas   = card.querySelector('canvas');
	const ctx      = canvas.getContext('2d');

	statusEl.textContent = 'Connecting';
	state.attaching = true;
	// A stream that neither opens nor errors (a stalled proxy, a saturated
	// connection pool) would otherwise leave the badge reading "Connecting"
	// forever. Give it a bounded grace period, then fall back to the card's real
	// resting state; the batch layer has already given it genuine content, so
	// nothing is lost but the false claim. The EventSource stays open in case it
	// still lands.
	clearTimeout(state.connectTimer);
	state.connectTimer = setTimeout(() => {
		if (!state.attaching) return;
		state.attaching = false;
		statusEl.textContent = state.entries?.length ? 'Active' : 'Idle';
		if (!isLiveNow(state)) paintActivity(state);
	}, STREAM_CONNECT_GRACE_MS);

	function setLive(live) {
		state.live = live;
		state.attaching = false;
		clearTimeout(state.connectTimer);
		dot.classList.toggle('idle', !live);
		if (live) {
			statusEl.textContent = 'Live';
			state.reconnecting = false;
			clearTimeout(state.reconnectLabelTimer);
		} else {
			dot.classList.remove('thin');
			state.lowFpsSince = 0;
			// Don't clobber a transient "Reconnecting…" label set by onerror below.
			if (!state.reconnecting) statusEl.textContent = state.entries?.length ? 'Active' : 'Idle';
		}
	}
	state.setLive = setLive;

	const es = new EventSource(`/api/agent-screen-stream?agentId=${encodeURIComponent(agentId)}`);
	state.es = es;

	es.addEventListener('frame', (e) => {
		try {
			const msg = JSON.parse(e.data);
			// Anchor bulletin: surface the on-air headline on the card even when the
			// frame is text-only (no rendered desk image).
			if (msg.type === 'analysis' && msg.activity && state.action) {
				const grind = parseGrindTicker(msg);
				if (grind) {
					state.action.textContent = grind;
					state.action.classList.remove('al-on-air');
				} else if (state.isTour) {
					state.action.textContent = `🎬 ${msg.activity}`;
				} else {
					state.action.textContent = `🔴 ON AIR · ${msg.activity}`;
					state.action.classList.add('al-on-air');
				}
			}
			// Live hire frames may be text/meta-only — handle before the image gate.
			if (msg.meta?.kind === 'a2a_hire') updateHireFlash(state, msg.meta, true);
			// Market-maker frames are text-only (data:null) — drive the floor badge
			// before the image gate, or the live dip-buy pulse would never fire.
			if (msg.mm) updateMmBadge(state, msg.mm, true);
			const src = msg.frame || msg.data;
			if (!src) return;
			const img = new Image();
			img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			img.src = src.startsWith('data:') ? src : 'data:image/png;base64,' + src;
			state.lastFrameAt = Date.now();
			setLive(true);
			// Real pixels are arriving — the handoff is done. Hide the warming overlay
			// and stop polling status; frames are now the source of truth.
			hideWarming(state);
			stopStatusPolling(state);
			_fpsMap.set(agentId, (_fpsMap.get(agentId) || 0) + 1);
			const grindTickerImg = parseGrindTicker(msg);
			if (grindTickerImg && state.action) {
				// Grind frames carry a rendered keyspace image — keep the compact
				// attempts/sec ticker rather than the raw activity string.
				state.action.textContent = grindTickerImg;
				state.action.classList.remove('al-on-air');
			} else if (msg.activity && state.action) {
				if (msg.activity.startsWith(TOUR_PREFIX)) {
					state.isTour = true;
					state.card.classList.add('al-card--tour');
					state.action.classList.remove('al-on-air');
					state.action.textContent = `🎬 TOUR · ${msg.activity.slice(TOUR_PREFIX.length).trim()}`;
				} else {
					state.action.textContent = msg.activity;
				}
			}
			// Live Avatar Forge: a completed forge rides a `meta` sidecar — surface
			// the fresh creation on the card so the wall shows what was just built.
			const forgeHit = parseForgeFrame(msg);
			if (forgeHit && state.action) {
				state.action.textContent = forgeHit.prompt ? `\u2726 forged: ${forgeHit.prompt}` : '\u2726 forged a new avatar';
				state.action.classList.remove('al-on-air');
				state.card.classList.add('al-card--forged');
				_showrunner?.noteCardEvent({ agentId: state.agentId, kind: 'forge', reason: forgeHit.prompt ? `forged ${forgeHit.prompt}` : 'fresh forge', magnitude: 3 });
			}
			if (msg.type === 'trade' && ingestCardPnl(state, msg)) notifyTrade(state, msg);
		} catch { /* malformed */ }
	});

	es.addEventListener('log', (e) => {
		try {
			const { entries } = JSON.parse(e.data);
			if (Array.isArray(entries)) {
				state.entries = entries;
				// Keep the recency badge honest: the newest entry's timestamp is the
				// agent's real last action (live log or DB backfill both carry `ts`).
				const newestTs = entries.reduce((m, en) => Math.max(m, Number(en?.ts) || 0), 0);
				if (newestTs > state.lastActionAt) state.lastActionAt = newestTs;
				// Fold any realized exits in the backfill into the running PnL chip.
				entries.forEach((entry) => ingestCardPnl(state, entry));
				// Draw the floor at the last known MM state (no flash — backfill, not live).
				for (let i = entries.length - 1; i >= 0; i--) {
					if (entries[i]?.mm) { updateMmBadge(state, entries[i].mm, false); break; }
				}
				const lastForge = [...entries].reverse().map(parseForgeFrame).find(Boolean);
				if (lastForge && state.action) {
					state.action.textContent = lastForge.prompt ? `\u2726 forged: ${lastForge.prompt}` : '\u2726 forged a new avatar';
					state.card.classList.add('al-card--forged');
				}
				// Reflect the latest hire phase from backfill (no flash — history).
				const lastHire = [...entries].reverse().find((e) => e?.meta?.kind === 'a2a_hire');
				if (lastHire) updateHireFlash(state, lastHire.meta, false);
			}
			if (!isLiveNow(state)) { paintActivity(state); setLive(false); }
		} catch { /* */ }
	});

	es.addEventListener('open', () => {
		if (statusEl.textContent === 'Connecting') setLive(false);
		state.reactions?.setConnected(true);
	});
	// Live spectator reactions for this card — float them over the screen + tick the count.
	es.addEventListener('reaction', (e) => {
		try { state.reactions?.onReaction(JSON.parse(e.data)); } catch { /* malformed */ }
	});
	es.addEventListener('dark', () => {
		setLive(false);
		paintActivity(state);
		// Still on screen but no caster — resume the warming/queued handoff poll.
		if (_inView.has(agentId)) startStatusPolling(state);
	});
	es.addEventListener('ping', () => { if (statusEl.textContent === 'Connecting') setLive(false); });
	es.onerror = () => {
		// Reclaim pool priority immediately on a drop — don't wait for the slow ping
		// loop — and show a transient "Reconnecting…" (not "Idle") for the first 2s
		// so a brief blip doesn't read as the agent going quiet.
		if (_inView.has(agentId)) signalWatch(agentId);
		state.reconnecting = true;
		setLive(false);
		statusEl.textContent = 'Reconnecting…';
		clearTimeout(state.reconnectLabelTimer);
		state.reconnectLabelTimer = setTimeout(() => {
			state.reconnecting = false;
			if (!isLiveNow(state)) statusEl.textContent = state.entries?.length ? 'Active' : 'Idle';
		}, 2000);
	};
}

// ── watch intent ────────────────────────────────────────────────────────────
// Tell the backend which agents are being actively watched so the caster pool
// can prioritise real browser streams for them. Fire-and-forget; the wall works
// fully (activity view) whether or not a caster ever picks the agent up.
function signalWatch(agentId) {
	try {
		fetch('/api/agent/watch-intent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agentId }),
			keepalive: true,
		}).catch(() => {});
	} catch { /* */ }
}

// ── handoff status overlay (warming / queued) ────────────────────────────────
// While a viewer is looking at a card that isn't live yet, the on-demand pool is
// either spinning a browser up for it (warming) or it's waiting behind others
// (queued). /api/agent/watch-status resolves which, from Redis only, so the card
// shows an honest "warming up" / "#N in line" overlay instead of a dead box.

function showWarming(state, text) {
	const el = state.card.querySelector('[data-warming]');
	if (!el) return;
	const txt = el.querySelector('[data-warming-text]');
	if (txt) txt.textContent = text;
	// Drop the initial display:none gate once, then drive visibility via opacity so
	// the overlay can fade in/out (and never blocks the card link — pointer-events:none).
	el.hidden = false;
	el.classList.add('is-visible');
}

function hideWarming(state) {
	const el = state.card?.querySelector('[data-warming]');
	if (el) el.classList.remove('is-visible');
}

function applyWatchStatus(state, data) {
	if (isLiveNow(state)) { hideWarming(state); return; }
	if (data?.state === 'warming') showWarming(state, 'Warming up a live view…');
	else if (data?.state === 'queued') showWarming(state, `Live view queued · #${data.position || 1} in line`);
	else { hideWarming(state); return; }
	// A browser is genuinely coming up for this card, so hold a stream open to
	// catch its first frame rather than waiting on the next activity batch.
	ensureStream(state);
}

async function pollWatchStatus(state) {
	if (isLiveNow(state)) { hideWarming(state); return; }
	state.statusPolls = (state.statusPolls || 0) + 1;
	try {
		const res = await fetch(`/api/agent/watch-status?agentId=${encodeURIComponent(state.agentId)}`, {
			headers: { accept: 'application/json' },
		});
		if (!res.ok) { hideWarming(state); return; }
		const data = await res.json();
		state.lastStatus = data.state;
		applyWatchStatus(state, data);
	} catch { hideWarming(state); }
}

// Keep refreshing while the card is on screen and not yet live, but only as long
// as the pool is actually working on it (warming/queued) — with a short grace
// window so the watch-intent → watch-status write race can't end polling early.
function shouldKeepPolling(state) {
	if (!_inView.has(state.agentId) || isLiveNow(state)) return false;
	if (state.lastStatus === 'warming' || state.lastStatus === 'queued') return true;
	return (state.statusPolls || 0) < STATUS_GRACE_POLLS;
}

function startStatusPolling(state) {
	stopStatusPolling(state);
	state.statusPolls = 0;
	const tick = async () => {
		await pollWatchStatus(state);
		state.statusTimer = shouldKeepPolling(state) ? setTimeout(tick, WATCH_STATUS_MS) : null;
	};
	tick();
}

function stopStatusPolling(state) {
	if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
}

// ── intersection-driven intent ───────────────────────────────────────────────
// Only cards actually on screen signal watch intent + poll status, so the bounded
// pool spins up exactly for what's being looked at and frees the slot the instant
// a viewer scrolls past (the agent falls out of the wanted window; the worker
// tears its caster down).
function getObserver() {
	if (_observer) return _observer;
	_observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const id = entry.target.dataset.agentId;
			const state = _cards.get(id);
			if (!state) continue;
			if (entry.isIntersecting) {
				_inView.add(id);
				signalWatch(id);
				scheduleNetworthFlush();
				if (!isLiveNow(state)) startStatusPolling(state);
			} else {
				_inView.delete(id);
				stopStatusPolling(state);
				hideWarming(state);
			}
		}
	}, { threshold: 0.1 });
	return _observer;
}

// ── pooled stream lifecycle ──────────────────────────────────────────────────
// With the batch layer covering activity, a stream is only worth a connection
// when there is something to PUSH: live caster pixels, spectator reactions, a
// market-maker beat. So a card earns one when it is genuinely casting, when it
// holds the spotlight, when the caster pool says a browser is coming up for it,
// or when a viewer reaches for the card itself (hover or keyboard focus). It
// hands the connection back once it scrolls out of the band, so a wall of 2,000
// agents costs the same handful of connections as a wall of 12.

// Move an id to the LRU tail (a Set re-insert after delete reorders it).
function touchStream(id) {
	if (_streamed.delete(id)) _streamed.add(id);
}

// Give a stream back. Keeps the card's loaded entries so scrolling back shows its
// history instantly, and parks the badge on the honest resting label.
function releaseStream(state) {
	if (!_streamed.delete(state.agentId)) return;
	try { state.es?.close(); } catch { /* already gone */ }
	state.es = null;
	state.attaching = false;
	state.reconnecting = false;
	clearTimeout(state.connectTimer);
	clearTimeout(state.reconnectLabelTimer);
	stopStatusPolling(state);
	hideWarming(state);
	state.lastFrameAt = 0;
	state.live = false;
	state.reactions?.setConnected(false);
	const statusEl = state.card.querySelector('[data-status]');
	if (statusEl) { statusEl.textContent = state.entries?.length ? 'Active' : 'Idle'; statusEl.title = ''; }
	const dot = state.card.querySelector('[data-dot]');
	dot?.classList.add('idle');
	dot?.classList.remove('thin');
	renderAge(state);
}

// Free slots by dropping the least-recently-needed streams. Never evicts the
// spotlit card or anything actually on screen, those are what the viewer is
// looking at; the ones merely inside the pre-warm band go first.
function evictStreams() {
	if (_streamed.size <= MAX_STREAMS) return;
	for (const pass of [0, 1]) {
		for (const id of [..._streamed]) {
			if (_streamed.size <= MAX_STREAMS) return;
			if (id === _spotAgentId) continue;
			if (pass === 0 && _inView.has(id)) continue;
			const s = _cards.get(id);
			if (s) releaseStream(s); else _streamed.delete(id);
		}
	}
}

function ensureStream(state) {
	if (state.es) { touchStream(state.agentId); return; }
	_streamed.add(state.agentId);
	attachStream(state);
	paintActivity(state);
	evictStreams();
}

function getStreamObserver() {
	if (_streamObserver) return _streamObserver;
	_streamObserver = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const id = entry.target.dataset.agentId;
			const state = _cards.get(id);
			if (!state) continue;
			if (entry.isIntersecting) {
				_nearView.add(id);
			} else {
				_nearView.delete(id);
				if (id !== _spotAgentId) releaseStream(state);
			}
		}
	}, { rootMargin: STREAM_MARGIN, threshold: 0 });
	return _streamObserver;
}

// ── batched activity hydration ───────────────────────────────────────────────
// The always-available layer under the stream pool: one request returns the real
// agent_actions tail for every mounted card plus the set that currently has a
// live caster. This is what makes a card meaningful the moment it mounts, no
// matter how far down the wall it sits, and it is how a card outside the stream
// pool keeps a truthful terminal instead of a permanent "Standing by".

const ACTIVITY_BATCH_MAX = 60;      // matches MAX_IDS in api/agents/activity.js
const ACTIVITY_BATCH_MS = 20_000;   // refresh cadence for non-streamed cards
const ACTIVITY_MIN_GAP_MS = 2_500;  // floor between batches, so fast scrolling cannot spam
let _activityTimer = null;
let _activityInFlight = false;
let _activityLastAt = 0;
let _activityPending = null;

// Fold a batch of DB-sourced entries into a card exactly as the SSE `log` event
// would, so a batch row and a streamed row render identically.
function applyActivityEntries(state, entries) {
	if (!Array.isArray(entries) || !entries.length) return;
	// A streaming card owns its own log; the batch must not overwrite fresher
	// caster-pushed history with the DB tail.
	if (state.es && state.entries.length) return;
	state.entries = entries;
	const newestTs = entries.reduce((m, en) => Math.max(m, Number(en?.ts) || 0), 0);
	if (newestTs > state.lastActionAt) state.lastActionAt = newestTs;
	entries.forEach((entry) => ingestCardPnl(state, entry));
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.mm) { updateMmBadge(state, entries[i].mm, false); break; }
	}
	const lastForge = [...entries].reverse().map(parseForgeFrame).find(Boolean);
	if (lastForge && state.action) {
		state.action.textContent = lastForge.prompt ? `✦ forged: ${lastForge.prompt}` : '✦ forged a new avatar';
		state.card.classList.add('al-card--forged');
	}
	const lastHire = [...entries].reverse().find((e) => e?.meta?.kind === 'a2a_hire');
	if (lastHire) updateHireFlash(state, lastHire.meta, false);
	if (!isLiveNow(state)) {
		paintActivity(state);
		renderAge(state);
		const statusEl = state.card.querySelector('[data-status]');
		if (statusEl && !state.es && statusEl.textContent !== 'Paused') statusEl.textContent = 'Active';
	}
}

async function hydrateActivity(ids) {
	if (!ids.length) return;
	// A page mounted while an earlier batch was still in flight must not be
	// dropped, or its cards wait out the whole refresh cadence with nothing to
	// show. Ask again as soon as the floor allows; the next batch covers them.
	if (_activityInFlight) { scheduleActivityFlush(ACTIVITY_MIN_GAP_MS); return; }
	_activityInFlight = true;
	_activityLastAt = Date.now();
	try {
		const res = await apiFetch('/api/agents/activity', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ids }),
			allowAnonymous: true,
		});
		// A throttled or briefly failing batch is not a dead end: the cards keep what
		// they have and the next tick asks again. Come back sooner than the normal
		// cadence so a card that has nothing yet is not left blank for 20s.
		if (!res.ok) { scheduleActivityFlush(ACTIVITY_MIN_GAP_MS * 2); return; }
		const { activity, casting } = await res.json();
		for (const [id, entries] of Object.entries(activity || {})) {
			const state = _cards.get(id);
			if (state) applyActivityEntries(state, entries);
		}
		// An agent with live pixels earns a stream slot even if it sits outside the
		// pre-warm band: that is the whole point of a live wall. Fill only the free
		// slots, nearest the viewport first, so a burst of casters cannot thrash the
		// pool by each attaching and immediately evicting the last.
		const live = (casting || []).filter((id) => _cards.get(id) && !_cards.get(id).es);
		live.sort((a, b) => Number(_nearView.has(b)) - Number(_nearView.has(a)));
		for (const id of live) {
			if (_streamed.size >= MAX_STREAMS) break;
			ensureStream(_cards.get(id));
		}
	} catch { scheduleActivityFlush(ACTIVITY_MIN_GAP_MS * 2); }
	finally { _activityInFlight = false; }
}

// Coalesce flush requests. Scrolling three pages in as many seconds fires three
// loadMore() calls, and one batch per page would burn the endpoint's rate budget
// for no benefit: the next batch covers every card the earlier ones would have.
function scheduleActivityFlush(delay) {
	const wait = Math.max(delay ?? 0, ACTIVITY_MIN_GAP_MS - (Date.now() - _activityLastAt), 0);
	if (_activityPending) return;
	if (!wait) { flushActivity(); return; }
	_activityPending = setTimeout(() => { _activityPending = null; flushActivity(); }, wait);
}

// Hydrate the cards that have no stream of their own. One batch cannot cover an
// endlessly scrolled wall, so it is spent where it shows: what the viewer can
// reach right now first, then anything still holding a blank terminal, then the
// rest of the tail.
function flushActivity() {
	if (document.hidden) return;
	const near = [], blank = [], rest = [];
	for (const [id, state] of _cards) {
		if (state.es) continue;
		if (_nearView.has(id)) near.push(id);
		else if (!state.entries.length) blank.push(id);
		else rest.push(id);
	}
	const ids = [...near, ...blank, ...rest].slice(0, ACTIVITY_BATCH_MAX);
	hydrateActivity(ids);
}

function startActivityHydration() {
	if (_activityTimer) return;
	_activityTimer = setInterval(flushActivity, ACTIVITY_BATCH_MS);
}

// ── lifecycle ──────────────────────────────────────────────────────────────────

function mountAgent(agent) {
	const id = agent.id || agent.agentId;
	if (!id || _cards.has(id)) return;
	const card = buildCard(agent);
	grid.querySelectorAll('.al-skeleton').forEach((s) => s.remove());
	grid.querySelector('.al-empty')?.remove();
	grid.appendChild(card);
	const lastActionAt = Number(new Date(agent.last_action_at || 0).getTime()) || 0;
	const state = {
		agentId: id,
		card,
		name: agent.name || agent.agentName || 'Agent',
		action: card.querySelector('[data-action]'),
		age: card.querySelector('[data-age]'),
		lastActionAt,
		// The roster already knows how much this agent has actually done. Holding it
		// on the card lets the pre-stream canvas say something true ("28 actions
		// recorded") instead of the flat "no actions yet" that used to greet every
		// card the pool had not reached.
		actionCount: Number(agent.action_count) || 0,
		entries: [],
		lastFrameAt: 0,
		live: false,
		es: null,
		// running realized PnL for the card chip
		realizedSol: 0,
		realizedUsd: 0,
		sawUsd: false,
		seenPnlTs: new Set(),
		reactions: null,
	};
	_cards.set(id, state);
	// Spectator reactions + tips on the card. The bar posts reactions and opens the
	// real tip flow; floating emojis rise over the screen and the count ticks the
	// watch-intent signal. We feed it the card's existing stream (subscribe:false),
	// so a flood of cards never doubles SSE connections.
	const reactHost = card.querySelector('[data-reactions]');
	const screenHost = card.querySelector('.al-card-screen');
	if (reactHost && screenHost) {
		state.reactions = mountAgentReactions({
			agentId: id,
			barHost: reactHost,
			overlayHost: screenHost,
			getAgent: () => agent,
			compact: true,
			voice: false, // wall cards have no avatar cam / audio surface — overlay + count only
			subscribe: false,
		});
	}
	renderAge(state);
	paintActivity(state);
	// Reaching for a card is real intent: go live on it so reactions, frames and
	// market-maker beats push instead of waiting for the next batch. Bounded by
	// the pool, and released again when the card leaves the band.
	const goLive = () => { if (!document.hidden) ensureStream(state); };
	card.addEventListener('pointerenter', goLive);
	card.addEventListener('focusin', goLive);
	// Intent + status polling are intersection-driven (getObserver), so the caster
	// pool only spins up for cards actually on screen and frees the slot on
	// scroll-away. The wider band (getStreamObserver) owns stream release.
	getObserver().observe(card);
	getStreamObserver().observe(card);
}

function renderEmpty() {
	grid.innerHTML = `
<div class="al-empty">
	<div class="al-empty-icon">🖥</div>
	<h2>No agents yet</h2>
	<p>Agents appear here the moment they're created. Spin one up and watch it work in real time.</p>
	<a href="/create-agent" class="al-empty-cta">Create an agent →</a>
</div>`;
}

// ── roster error state ───────────────────────────────────────────────────────
// The roster request failing is NOT the same thing as the platform having no
// agents, and rendering "No agents yet" for an outage tells the viewer a lie.
// This panel says what actually happened, retries on its own with backoff, and
// offers both a manual retry and a route to the full directory.

const RETRY_BACKOFF_MS = [8000, 16000, 30000, 60000];
let _retryAttempt = 0;
let _retryTimer = null;
// While the error panel owns the wall, scroll must not re-fire the failing
// request on every wheel tick. The backoff timer and the button are the only
// retry paths.
let _rosterErrored = false;

function clearRosterError() {
	if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
	_retryAttempt = 0;
	_rosterErrored = false;
	document.getElementById('al-roster-error')?.remove();
}

async function retryRoster(box) {
	const btn = box.querySelector('.al-error-retry');
	const next = box.querySelector('.al-error-next');
	btn.disabled = true;
	btn.textContent = 'Retrying…';
	if (next) next.textContent = '';
	_hasMore = true;       // a failed page must not permanently end pagination
	_rosterErrored = false; // this call IS the retry, so let it through
	await loadMore();
	// Still on screen ⇒ the retry failed too; hand control back and re-arm.
	if (document.getElementById('al-roster-error') === box) {
		btn.disabled = false;
		btn.textContent = 'Try again';
		scheduleRosterRetry(box);
	}
}

function scheduleRosterRetry(box) {
	if (_retryTimer) clearTimeout(_retryTimer);
	const wait = RETRY_BACKOFF_MS[Math.min(_retryAttempt, RETRY_BACKOFF_MS.length - 1)];
	_retryAttempt++;
	const next = box.querySelector('.al-error-next');
	if (next) next.textContent = `Retrying automatically in ${Math.round(wait / 1000)}s`;
	_retryTimer = setTimeout(() => {
		_retryTimer = null;
		if (document.getElementById('al-roster-error') !== box) return;
		if (document.hidden) { scheduleRosterRetry(box); return; }
		retryRoster(box);
	}, wait);
}

function renderRosterError() {
	_rosterErrored = true;
	if (document.getElementById('al-roster-error')) return;
	const firstLoad = _cards.size === 0;
	if (firstLoad) grid.querySelectorAll('.al-skeleton').forEach((s) => s.remove());
	const box = document.createElement('div');
	box.id = 'al-roster-error';
	box.className = 'al-error';
	box.setAttribute('role', 'alert');
	box.innerHTML = `
<div class="al-error-icon" aria-hidden="true">⚠</div>
<h2>${firstLoad ? "Couldn't load the agent wall" : "Couldn't load more agents"}</h2>
<p>The live roster request didn't come back. Your connection or the roster API is briefly unavailable.${firstLoad ? '' : ' The agents already on the wall keep streaming.'}</p>
<div class="al-error-actions">
	<button type="button" class="al-error-retry">Try again</button>
	<a class="al-error-alt" href="/agents">Browse the agent directory</a>
</div>
<div class="al-error-next" aria-live="polite"></div>`;
	grid.appendChild(box);
	box.querySelector('.al-error-retry').addEventListener('click', () => retryRoster(box));
	scheduleRosterRetry(box);
}

async function loadMore() {
	if (_loading || !_hasMore || _rosterErrored) return;
	_loading = true;
	const { agents, hasMore, failed } = await fetchRosterPage();

	if (failed) {
		// Leave `_hasMore` alone so infinite scroll and the retry can try again.
		renderRosterError();
		_loading = false;
		return;
	}
	_hasMore = hasMore;
	clearRosterError();

	if (!_cards.size && !agents.length) {
		renderEmpty();
		_loading = false;
		return;
	}
	agents.forEach(mountAgent);
	// One request gives the whole new page a real terminal straight away, before
	// the stream pool has reached any of it.
	scheduleActivityFlush();
	updateStats();
	_arena.schedule();
	_showrunner?.refreshLive(); // fold the new page into the program
	_loading = false;
}

function fmtCount(n) {
	return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

function updateStats() {
	const mounted = _cards.size;
	let live = 0;
	for (const s of _cards.values()) if (isLiveNow(s)) live++;
	if (liveCount) liveCount.textContent = live;
	if (statLive) statLive.textContent = live;
	// "On the wall" is the platform-wide addressable roster (from the first page's
	// meta), not just how many cards are mounted right now — falls back to the
	// mounted count until the count lands. "With activity" is the honest number of
	// agents that have ever acted, so the header carries real pulse even when no
	// browser caster is streaming (Live now = 0).
	if (statTotal) statTotal.textContent = fmtCount(_rosterTotal != null ? Math.max(_rosterTotal, mounted) : mounted);
	if (statActive) statActive.textContent = fmtCount(_activeTotal);
	if (statsBar) statsBar.hidden = mounted === 0;
}

// FPS + live-count ticker. Also surfaces per-card FPS in the live badge tooltip
// and downgrades the dot to a "thin" amber state when a casting agent's own feed
// stutters below ~1 fps for >3s — a stalled caster, distinct from a full dark.
function startFpsTicker() {
	_fpsInterval = setInterval(() => {
		let total = 0;
		// Only a streamed card can have frames to count; the rest carry no badge
		// state worth touching every second.
		for (const id of _streamed) {
			const s = _cards.get(id);
			if (!s) continue;
			const c = _fpsMap.get(id) || 0;
			total += c;
			s.fps = c;
			const live = isLiveNow(s);
			const statusEl = s.card.querySelector('[data-status]');
			const dot = s.card.querySelector('[data-dot]');
			if (statusEl) statusEl.title = live ? (c > 0 ? `${c} fps` : 'stalled — no frames this second') : '';
			if (live && c < 1) { if (!s.lowFpsSince) s.lowFpsSince = Date.now(); }
			else s.lowFpsSince = 0;
			if (dot) dot.classList.toggle('thin', !!(live && s.lowFpsSince && Date.now() - s.lowFpsSince > 3000));
		}
		_fpsMap.clear();
		if (statFps) statFps.textContent = total > 0 ? `${total}/s` : '—';
		updateStats();
		// Live truth shifts every second (casters come and go) — re-rank the program
		// off it without a network round-trip so the spotlight tracks who's live now.
		_showrunner?.refreshLive();
	}, 1000);
}

// Repaint idle cards so relative timestamps + the cursor stay alive, and a card
// that just lost its live feed falls back to the activity terminal.
function startIdleRepaint() {
	_idleRepaint = setInterval(() => {
		if (document.hidden) return;
		// Only repaint what a viewer can actually see (plus the spotlit hero). A
		// canvas redraw per mounted card was burning frames on a wall the visitor
		// had long scrolled past; an off-screen card keeps its last painted state
		// and repaints the moment it re-enters the band.
		for (const s of _cards.values()) {
			if (!_nearView.has(s.agentId) && s.agentId !== _spotAgentId) continue;
			if (!isLiveNow(s)) {
				paintActivity(s);
				renderAge(s);
				if (s.live) s.setLive?.(false);
			} else if (s.age && !s.age.hidden) {
				s.age.hidden = true; // went live — Live badge takes over from the recency chip
			}
		}
	}, 2500);
}

// Re-assert watch intent on a slow cadence — but only for cards currently on
// screen, so the pool keeps a slot for what a viewer is actually watching and
// lets it expire for everything they've scrolled past.
function startWatchPings() {
	setInterval(() => {
		if (document.hidden) return;
		for (const id of _inView) signalWatch(id);
	}, WATCH_PING_MS);
}

// Infinite scroll: load the next page as the user nears the bottom.
function startInfiniteScroll() {
	window.addEventListener('scroll', () => {
		if (_loading || !_hasMore) return;
		if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) loadMore();
	}, { passive: true });
}

function suspendStreams() {
	for (const id of [..._streamed]) {
		const s = _cards.get(id);
		if (s) releaseStream(s); else _streamed.delete(id);
	}
	for (const s of _cards.values()) {
		const statusEl = s.card.querySelector('[data-status]');
		if (statusEl) { statusEl.textContent = 'Paused'; statusEl.title = ''; }
	}
}

function resumeStreams() {
	// Only the pre-warm band comes back, not every mounted card: a backgrounded tab
	// must not return by reopening one connection per agent on the wall.
	for (const id of _nearView) {
		const s = _cards.get(id);
		if (s) ensureStream(s);
	}
	for (const s of _cards.values()) {
		if (s.es) continue;
		const statusEl = s.card.querySelector('[data-status]');
		if (statusEl?.textContent === 'Paused') statusEl.textContent = s.entries?.length ? 'Active' : 'Idle';
	}
	// IntersectionObserver doesn't re-fire on tab focus, so re-assert intent and
	// restart the handoff poll for cards that are still on screen.
	for (const id of _inView) {
		const s = _cards.get(id);
		if (!s) continue;
		signalWatch(id);
		if (!isLiveNow(s)) startStatusPolling(s);
	}
}

// ── platform-wide ticker ──────────────────────────────────────────────────────
// A thin strip under the nav tailing the real site-wide feed (api/feed-stream via
// theater-feed.js). It cross-links activity across every agent/coin so even an
// idle wall has a pulse — clicking an event routes to its agent or coin where a
// link exists. Pause on hover, resume on leave; honors prefers-reduced-motion.

const TICKER_MAX = 30;
const KIND_TOKEN = { buy: 'green', launch: 'gold', verify: 'cyan', pay: 'violet', win: 'gold', loss: 'red', misc: 'neutral' };

function tickerItemHTML(ev) {
	const token = KIND_TOKEN[ev.kind] || 'neutral';
	const dot = `<span class="al-ticker-dot" style="background:${colorHex(token)}"></span>`;
	const title = esc(ev.title || ev.type || 'Event');
	const sub = ev.sub ? `<span class="al-ticker-sub">${esc(ev.sub)}</span>` : '';
	const inner = `${dot}<span class="al-ticker-title">${title}</span>${sub}`;
	return ev.href
		? `<a class="al-ticker-item" href="${esc(ev.href)}">${inner}</a>`
		: `<span class="al-ticker-item">${inner}</span>`;
}

function startTicker() {
	const strip = document.getElementById('al-ticker');
	if (!strip) return;
	const track = strip.querySelector('.al-ticker-track');
	const statusEl = strip.querySelector('[data-ticker-status]');
	let events = [];

	function render() {
		if (!events.length) {
			track.classList.remove('is-scrolling');
			track.innerHTML = `<span class="al-ticker-item al-ticker-quiet">All quiet — activity across the platform will scroll here.</span>`;
			return;
		}
		const items = events.map(tickerItemHTML).join('');
		// Two copies → a seamless CSS marquee (animates 0 → -50%). Reduced motion
		// drops the animation and lets the strip scroll on overflow instead.
		track.innerHTML = REDUCED_MOTION ? items : items + items;
		track.classList.toggle('is-scrolling', !REDUCED_MOTION);
		if (!REDUCED_MOTION) {
			const dur = Math.max(24, events.length * 4);
			track.style.animationDuration = `${dur}s`;
		}
	}

	function addEvent(ev) {
		if (!ev || !ev.id) return;
		if (events.some((e) => e.id === ev.id)) return;
		events = [ev, ...events].slice(0, TICKER_MAX);
		render();
		// Feed the showrunner + the no-dead-air fallback off the same stream — one
		// SSE connection drives both the ticker and the spotlight's program.
		_feedEvents = events;
		_showrunner?.onFeedEvent(ev);
		renderSpotFallback();
	}

	// Prime with a real snapshot for first paint, then live-tail the stream.
	strip.classList.add('is-loading');
	loadSnapshot(TICKER_MAX).then((snap) => {
		strip.classList.remove('is-loading');
		events = (snap || []).slice(0, TICKER_MAX);
		render();
		_feedEvents = events;
		// Seed the showrunner with the snapshot's attributable events so the program
		// reflects recent forges/verifications on first paint, not only live ones.
		for (let i = events.length - 1; i >= 0; i--) _showrunner?.onFeedEvent(events[i]);
		renderSpotFallback();
	}).catch(() => { strip.classList.remove('is-loading'); render(); });

	connectFeed({
		onEvent: addEvent,
		onStatus: (s) => {
			strip.dataset.status = s;
			if (statusEl) statusEl.textContent = s === 'reconnecting' ? 'reconnecting…' : '';
		},
	});

	// Pause on hover / focus within, resume on leave.
	strip.addEventListener('pointerenter', () => track.classList.add('is-paused'));
	strip.addEventListener('pointerleave', () => track.classList.remove('is-paused'));
	strip.addEventListener('focusin', () => track.classList.add('is-paused'));
	strip.addEventListener('focusout', () => track.classList.remove('is-paused'));
}

// ── boot ──────────────────────────────────────────────────────────────────────

// ── live net-worth badges ─────────────────────────────────────────────────────
// Each on-screen card carries a compact 24h portfolio-change badge in its top
// corner — the wall-scale view of the same scoreboard the agent-screen HUD shows.
// Real on-chain valuation, batched: one POST /api/agents/balances for every
// visible card (the endpoint exists precisely to avoid an N× request storm),
// refreshed on a slow cadence and only while the tab is visible. Hidden when a
// wallet has no value or no 24h history yet — never zeroed, never faked.
const NETWORTH_POLL_MS = 60_000;
let _networthFlushTimer = null;

function scheduleNetworthFlush() {
	if (_networthFlushTimer) return;
	_networthFlushTimer = setTimeout(() => { _networthFlushTimer = null; hydrateNetworth(); }, 150);
}

async function hydrateNetworth() {
	if (document.hidden) return;
	const ids = [..._inView].filter((id) => _cards.has(id));
	if (!ids.length) return;
	let map;
	try { map = await fetchBatchBalances(ids); } catch { return; }
	for (const id of ids) {
		const state = _cards.get(id);
		if (state) applyNetworthBadge(state, map.get(id));
	}
}

function applyNetworthBadge(state, snap) {
	const badge = state.card.querySelector('[data-networth]');
	if (!badge) return;
	if (!snap || !snap.priced || snap.change24hPct == null) { badge.hidden = true; return; }
	const d = formatPnl(snap.change24hPct);
	badge.hidden = false;
	badge.dataset.tone = d.tone;
	badge.innerHTML = `<span class="al-nw-arrow">${d.arrow}</span>${esc(d.text)}`;
	const win = snap.windowHours != null && snap.windowHours > 0 ? `${Math.round(snap.windowHours)}h` : '24h';
	badge.title = `Net worth ${formatNetWorthUsd(snap.netWorthUsd, { compact: false })} · ${d.text} ${win}`;
}

function startNetworthHydration() {
	scheduleNetworthFlush();
	setInterval(() => {
		if (!document.hidden && _inView.size) hydrateNetworth();
	}, NETWORTH_POLL_MS);
}

// Reaction-bar chrome for wall cards: a slim, hover-revealed strip pinned to the
// bottom of each card's screen, above the floating-emoji overlay. Injected once.
if (!document.getElementById('al-reactions-style')) {
	const st = document.createElement('style');
	st.id = 'al-reactions-style';
	st.textContent = `
.al-card-reactions{position:absolute;left:8px;right:8px;bottom:8px;z-index:7;display:flex;justify-content:center;
	padding:4px 6px;border-radius:12px;background:linear-gradient(180deg,rgba(8,8,12,.18),rgba(8,8,12,.72));
	backdrop-filter:blur(6px);opacity:0;transform:translateY(6px);pointer-events:none;
	transition:opacity .18s ease,transform .18s ease;}
.al-card:hover .al-card-reactions,.al-card:focus-within .al-card-reactions{opacity:1;transform:none;pointer-events:auto;}
@media (hover:none){.al-card-reactions{opacity:1;transform:none;pointer-events:auto;}}
@media (prefers-reduced-motion:reduce){.al-card-reactions{transition:none;}}`;
	document.head.appendChild(st);
}

// ── showrunner / spotlight stage ──────────────────────────────────────────────
// A broadcast "director" above the grid: it cuts between the most interesting
// agent right now — biggest trade, newest forge, top live caster — captioned by
// the real signal that earned it the slot, and reorders the grid so genuinely
// active agents float up. When no caster is casting, it pivots to the platform
// activity feed so the wall is never dark. The ranking is the unit-tested
// rankCandidates() merged with the wall's own live truth (see src/showrunner.js).

const spotlight    = document.getElementById('al-spotlight');
const spotScreen   = document.getElementById('al-spot-screen');
const spotSkeleton = spotlight?.querySelector('[data-spot-skeleton]');
const spotFallback = spotlight?.querySelector('[data-spot-fallback]');
const spotReason   = spotlight?.querySelector('[data-spot-reason]');
const spotName     = spotlight?.querySelector('[data-spot-name]');
const spotDots     = spotlight?.querySelector('[data-spot-dots]');
const spotPrev     = spotlight?.querySelector('[data-spot-prev]');
const spotNext     = spotlight?.querySelector('[data-spot-next]');

const NOTABLE_FLOAT = new Set(['trade', 'forge', 'verify', 'milestone']);
const SPOT_DWELL_MS = 13_000;   // how long the spotlight holds before cutting
const FLOAT_MAX = 12;           // cap on cards floated above the reputation tail

let _spotNode = null;           // the promoted card node (lives inside spotScreen)
let _spotAgentId = null;
let _spotPaused = false;
let _rotTimer = null;
let _fadeGuard = null;
let _floated = new Set();        // agentIds currently floated up via CSS order
let _programCache = [];          // last program list (drives the queue dots)

// Live truth the showrunner merges with the server program: which cards are
// genuinely casting right now, and each mounted card's display name.
function liveAgentIds() {
	const s = new Set();
	for (const [id, st] of _cards) if (isLiveNow(st)) s.add(id);
	return s;
}

// Fold a card's realized trade exit into the program as a "biggest trade" beat —
// magnitude is the absolute realized move so a bigger bank ranks higher.
function notifyTrade(state, msg) {
	const delta = parsePnlDelta(msg?.pnl);
	if (!delta || delta.phase !== 'exit') return;
	const usd = delta.realizedUsd;
	const sol = delta.solDelta;
	const primary = usd != null ? usd : (sol != null ? sol : 0);
	const mag = Math.abs(Number(primary)) || 0;
	let reason = 'banked a trade';
	if (usd != null) { const f = formatUsd(usd); if (f) reason = `banked ${usd >= 0 ? '+' : ''}${f}`; }
	else if (sol != null) { const f = formatSol(sol); if (f) reason = `banked ${f}`; }
	_showrunner?.noteCardEvent({ agentId: state.agentId, kind: 'trade', reason, magnitude: mag });
}

function ensureSpotVisible() { if (spotlight) spotlight.hidden = false; }
function hideSpotSkeleton() { if (spotSkeleton) spotSkeleton.hidden = true; }
function hideSpotFallback() { if (spotFallback) spotFallback.hidden = true; }

// No dead air: render the live platform feed inside the stage when there's no
// caster to promote. Driven off the SAME feed the ticker tails (one connection).
function renderSpotFallback() {
	if (!spotFallback || spotFallback.hidden) return;
	const rows = _feedEvents.slice(0, 7).map((ev) => {
		const sub = ev.sub ? `<span class="al-spot-feed-sub">${esc(ev.sub)}</span>` : '';
		const title = esc(ev.title || ev.type || 'Event');
		const inner = `<span class="al-spot-feed-dot"></span><span class="al-spot-feed-title">${title}</span>${sub}`;
		return ev.href
			? `<a class="al-spot-feed-row" href="${esc(ev.href)}">${inner}</a>`
			: `<span class="al-spot-feed-row">${inner}</span>`;
	}).join('');
	spotFallback.innerHTML = `<div class="al-spot-fallback-title">Live on three.ws</div>${rows ||
		'<span class="al-spot-feed-row">All quiet — platform activity will surface here.</span>'}`;
}

function showSpotFallback() {
	// Only claim the stage with the feed when there's genuinely nothing to promote.
	// With real feed motion we show it; with neither cards nor feed we hold the
	// skeleton rather than flashing an empty panel.
	if (!spotlight || !spotFallback) return;
	ensureSpotVisible();
	restoreSpotNode();
	hideSpotSkeleton();
	if (spotReason) spotReason.textContent = 'Live on three.ws';
	if (spotName) { spotName.textContent = 'platform activity'; spotName.removeAttribute('href'); }
	spotFallback.hidden = false;
	renderSpotFallback();
	renderDots();
}

// Move the promoted card node back into the grid (CSS order repositions it).
function restoreSpotNode() {
	if (!_spotNode) return;
	_spotNode.classList.remove('al-card--spotlit');
	grid.appendChild(_spotNode);
	const leaving = _spotAgentId;
	_spotNode = null;
	_spotAgentId = null;
	// The outgoing hero loses its pinned slot. If its grid position is off the
	// pool's band it hands the connection straight back to the next candidate.
	if (leaving && !_nearView.has(leaving)) {
		const s = _cards.get(leaving);
		if (s) releaseStream(s);
	}
}

function updateCaption(candidate) {
	if (!candidate) return;
	if (spotReason) spotReason.textContent = candidate.reason || 'live now';
	if (spotName) {
		spotName.textContent = candidate.name || _cards.get(candidate.agentId)?.name || 'Agent';
		spotName.href = `/agent-screen?agentId=${encodeURIComponent(candidate.agentId)}`;
	}
	renderDots();
}

// Promote a real grid card node into the spotlight stage — reusing its live SSE
// stream, canvas and reactions verbatim (we MOVE the node, never re-stream it),
// so the hero shows real frames or the card's own activity terminal.
function promote(state, candidate) {
	ensureSpotVisible();
	restoreSpotNode();
	hideSpotSkeleton();
	hideSpotFallback();
	state.card.classList.add('al-card--spotlit');
	spotScreen.appendChild(state.card);
	_spotNode = state.card;
	_spotAgentId = candidate.agentId;
	// Prioritise a real caster for the spotlit agent (same intent path the grid
	// cards use), and never leave a frozen frame on the hero. The hero holds a
	// stream slot for as long as it holds the stage, even once its grid position
	// has scrolled out of the pool's band.
	_inView.add(candidate.agentId);
	ensureStream(state);
	signalWatch(candidate.agentId);
	if (!isLiveNow(state)) { startStatusPolling(state); paintActivity(state); }
	updateCaption(candidate);
	applyGridFloat(_programCache);
	_arena.schedule(); // let the reputation tail re-rank now this card rejoined
}

// Display a candidate on the stage. `animate` cross-fades (rotation only); a mere
// program reshuffle swaps instantly so the stage never strobes.
function display(candidate, animate) {
	if (!candidate || !spotlight) { showSpotFallback(); return; }
	const state = _cards.get(candidate.agentId);
	if (!state) { showSpotFallback(); return; }
	if (_spotNode === state.card) { updateCaption(candidate); return; }

	const swap = () => promote(state, candidate);
	if (animate && !REDUCED_MOTION && _spotNode) {
		spotScreen.classList.add('is-fading');
		clearTimeout(_fadeGuard);
		const onEnd = () => {
			clearTimeout(_fadeGuard);
			swap();
			requestAnimationFrame(() => spotScreen.classList.remove('is-fading'));
		};
		spotScreen.addEventListener('transitionend', onEnd, { once: true });
		// Guard: if the opacity transition never reports end (reflow swallowed it),
		// still complete the swap so the stage can't stick faded. Animation timing,
		// not a fake loader.
		_fadeGuard = setTimeout(() => { spotScreen.removeEventListener('transitionend', onEnd); onEnd(); }, 400);
	} else {
		swap();
	}
}

// Queue dots — one per program head (capped). Current is highlighted; clicking
// jumps the spotlight straight to that agent.
function renderDots() {
	if (!spotDots) return;
	const list = _programCache.slice(0, 8);
	const curId = _showrunner?.getCurrent()?.agentId;
	spotDots.innerHTML = '';
	for (const c of list) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'al-spot-dot' + (c.agentId === curId ? ' is-active' : '');
		b.setAttribute('role', 'tab');
		b.setAttribute('aria-selected', c.agentId === curId ? 'true' : 'false');
		b.setAttribute('aria-label', `Spotlight ${c.name || 'agent'} — ${c.reason || 'live'}`);
		b.addEventListener('click', () => { _showrunner.setCurrent(c.agentId); display(_showrunner.getCurrent(), true); });
		spotDots.appendChild(b);
	}
}

// Float the genuinely-active agents above the reputation-sorted tail using CSS
// `order` only — no DOM reshuffle, so this layers cleanly over the arena (which
// owns DOM order for the calm tail) instead of fighting it.
function applyGridFloat(program) {
	for (const id of _floated) { const s = _cards.get(id); if (s) s.card.style.order = ''; }
	_floated.clear();
	let n = 0;
	for (const c of program || []) {
		if (n >= FLOAT_MAX) break;
		if (!(c.live || NOTABLE_FLOAT.has(c.kind))) continue; // popular baseline stays with the arena
		const s = _cards.get(c.agentId);
		if (!s || s.card === _spotNode) continue;
		s.card.style.order = String(-1000 + n);
		_floated.add(c.agentId);
		n++;
	}
}

// The showrunner calls this whenever the ranked program changes.
function onProgramChange(program, current) {
	_programCache = program || [];
	if (!spotlight) return;
	applyGridFloat(_programCache);
	renderDots();
	if (!current) { showSpotFallback(); return; }
	hideSpotFallback();
	display(current, false);
}

function startRotation() {
	stopRotation();
	_rotTimer = setInterval(() => {
		if (document.hidden || _spotPaused) return;
		const prog = _showrunner?.getProgram() || [];
		if (prog.length < 2) return; // a single agent holds the stage — no forced churn
		display(_showrunner.next(), true);
	}, SPOT_DWELL_MS);
}
function stopRotation() { if (_rotTimer) { clearInterval(_rotTimer); _rotTimer = null; } }

function wireSpotControls() {
	if (!spotlight) return;
	spotPrev?.addEventListener('click', () => display(_showrunner.prev(), true));
	spotNext?.addEventListener('click', () => display(_showrunner.next(), true));
	// Pause rotation while a viewer lingers so they can read / click.
	spotlight.addEventListener('pointerenter', () => { _spotPaused = true; });
	spotlight.addEventListener('pointerleave', () => { _spotPaused = false; });
	spotlight.addEventListener('focusin', () => { _spotPaused = true; });
	spotlight.addEventListener('focusout', () => { _spotPaused = false; });
	spotlight.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowLeft') { e.preventDefault(); display(_showrunner.prev(), true); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); display(_showrunner.next(), true); }
	});
}

_showrunner = createShowrunner({
	getLiveIds: liveAgentIds,
	getCardName: (id) => _cards.get(id)?.name || null,
	onChange: onProgramChange,
});

await loadMore();
startTicker();
startFpsTicker();
startIdleRepaint();
startWatchPings();
startInfiniteScroll();
startNetworthHydration();
startActivityHydration();
_arena.start();

// Boot the director once the first roster page is mounted: show the skeleton
// stage immediately, then let the program resolve and promote a real card.
if (spotlight && _cards.size) {
	spotlight.hidden = false;
	wireSpotControls();
	_showrunner.start();
	startRotation();
}

document.addEventListener('visibilitychange', () => {
	if (document.hidden) { suspendStreams(); stopRotation(); }
	else { resumeStreams(); scheduleActivityFlush(); _showrunner?.refreshLive(); if (spotlight && _cards.size) startRotation(); }
});
