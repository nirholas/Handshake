/**
 * Embodied Finance — the tier "level-up" moment.
 *
 * The aura already makes an agent's wealth ambient and always-on. This adds the
 * one punctuation mark it was missing: the instant a wallet's REAL net worth
 * crosses a presence tier (Spark → Ember → Glow → Radiant → Luminous), the owner
 * gets a tasteful, shareable card — the kind of thing you screenshot and post.
 *
 * Honesty rules carried over from the rest of the system:
 *   - It only ever fires on a GENUINE crossing of a real tier threshold, detected
 *     from the same custody-backed wealth state every surface reads
 *     (agent-wealth-state.js → /api/agents/:id/solana/networth). Never a timer,
 *     never a fabricated number — every figure on the card traces to real chain
 *     data already loaded for the aura.
 *   - Owner-only. A visitor sees the agent's aura brighten (public), but the
 *     celebratory card is the owner's moment. We never surface it for an agent the
 *     viewer doesn't own.
 *   - Once per crossing. A per-agent "last celebrated level" persists in
 *     localStorage so a reload — or a level-up that happened while the owner was
 *     away — celebrates exactly once, then never replays.
 *   - prefers-reduced-motion: the card still appears (it's information), but the
 *     spark burst and scale-in are suppressed for a calm fade.
 *
 * $THREE is the only coin this platform names; tiers are coin-agnostic USD value.
 */

import { NETWORTH_TIERS, computeWalletVisual, formatNetWorth } from './wallet-networth.js';
import { formatMomentum } from './agent-wealth-state.js';

const EVENT = 'tws:wealth-levelup';
const SEEN_PREFIX = 'tws:wealthtier:';
const AUTO_DISMISS_MS = 11_000;

const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Pure detection helpers (unit-tested) ──────────────────────────────────────

/** Tier descriptor for a 0–5 level, clamped to the real ladder. */
export function tierMetaForLevel(level) {
	const i = Math.max(0, Math.min(NETWORTH_TIERS.length - 1, Math.round(Number(level) || 0)));
	return NETWORTH_TIERS[i];
}

/**
 * Should a live poll celebrate? Only when the viewer owns the agent and the real
 * tier level strictly increased from the previously observed one. `prevLevel`
 * being non-finite means "not yet primed" (first read) — handled by the caller.
 */
export function shouldCelebrate(prevLevel, state) {
	if (!state || !state.ok || !state.isOwner) return false;
	if (!Number.isFinite(prevLevel)) return false;
	const level = Number(state.level) || 0;
	return level > prevLevel;
}

function readSeenLevel(agentId) {
	if (!agentId || typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(SEEN_PREFIX + agentId);
		if (raw == null) return null;
		const n = Number(raw);
		return Number.isFinite(n) ? n : null;
	} catch { return null; }
}

function writeSeenLevel(agentId, level) {
	if (!agentId || typeof localStorage === 'undefined') return;
	try { localStorage.setItem(SEEN_PREFIX + agentId, String(Math.max(0, Math.round(Number(level) || 0)))); }
	catch { /* storage full/blocked — celebration just isn't deduped across reloads */ }
}

/**
 * Drive the level-up signal from a live wealth read. Call once per poll with the
 * level you last observed (null/NaN on the first, "priming" read). Returns the
 * level to carry into the next poll. Emits the global `tws:wealth-levelup` event
 * exactly once per genuine owner crossing — including a "while you were away"
 * crossing detected against the persisted last-seen level on the priming read.
 *
 * Kept here (not inline in the poller) so every surface — the avatar hero, IRL —
 * detects a crossing the same way and can never double-fire.
 *
 * @param {string} agentId
 * @param {number} prevLevel   last observed level, or null/NaN to prime
 * @param {object} state       a WealthState from agent-wealth-state.js
 * @returns {number} the level to remember for the next poll
 */
export function trackLevelUp(agentId, prevLevel, state) {
	if (!state || !state.ok) return prevLevel;
	const level = Number(state.level) || 0;

	// Priming read: compare against what we persisted last session.
	if (!Number.isFinite(prevLevel)) {
		const seen = readSeenLevel(agentId);
		writeSeenLevel(agentId, level);
		if (state.isOwner && seen != null && level > seen) {
			emit(agentId, seen, level, state, { away: true });
		}
		return level;
	}

	if (shouldCelebrate(prevLevel, state)) {
		writeSeenLevel(agentId, level);
		emit(agentId, prevLevel, level, state, { away: false });
	} else if (level !== prevLevel) {
		// A real drawdown re-opens the door to a future re-climb being celebrated.
		writeSeenLevel(agentId, level);
	}
	return level;
}

function emit(agentId, from, to, state, opts = {}) {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent(EVENT, {
		detail: { agentId, from, to, state, away: !!opts.away },
	}));
}

// ── The celebration card ──────────────────────────────────────────────────────

let _installed = false;
let _styled = false;
let _active = null;        // the currently-shown card teardown
const _queue = [];         // pending crossings while one is showing
const _seenAgentTo = new Map(); // agentId → highest `to` we've already shown this session

/**
 * Install the one global listener that turns crossing events into cards. Idempotent
 * — safe to call from every surface that opts into the wealth reaction; only the
 * first call wires up. Returns an uninstall fn.
 */
export function installLevelUpCelebrations() {
	if (_installed || typeof window === 'undefined') return () => {};
	_installed = true;
	const onEvt = (ev) => enqueue(ev.detail);
	window.addEventListener(EVENT, onEvt);
	return () => {
		window.removeEventListener(EVENT, onEvt);
		_installed = false;
	};
}

function enqueue(detail) {
	if (!detail || !detail.agentId) return;
	// Collapse duplicates: never show the same agent→same tier twice in a session.
	const prevHigh = _seenAgentTo.get(detail.agentId);
	if (prevHigh != null && detail.to <= prevHigh) return;
	_seenAgentTo.set(detail.agentId, detail.to);
	if (_active) { _queue.push(detail); return; }
	render(detail);
}

function next() {
	_active = null;
	const d = _queue.shift();
	if (d) render(d);
}

function ensureStyles() {
	if (_styled || typeof document === 'undefined') return;
	_styled = true;
	const css = `
.wlu-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:24px;
	background:rgba(6,7,12,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
	opacity:0;transition:opacity var(--duration-base,220ms) var(--ease-standard,ease);}
.wlu-backdrop.wlu-in{opacity:1;}
.wlu-card{position:relative;width:min(380px,92vw);border-radius:var(--radius-lg,14px);overflow:hidden;
	background:var(--surface-solid-1,#14151c);border:1px solid var(--stroke,rgba(255,255,255,.10));
	box-shadow:var(--shadow-3,0 8px 32px rgba(0,0,0,.5));padding:26px 24px 22px;text-align:center;
	transform:translateY(8px) scale(.96);opacity:0;
	transition:transform var(--duration-base,220ms) var(--ease-standard,ease),opacity var(--duration-base,220ms) var(--ease-standard,ease);}
.wlu-backdrop.wlu-in .wlu-card{transform:none;opacity:1;}
.wlu-glowwash{position:absolute;inset:-40% -10% auto -10%;height:60%;pointer-events:none;
	background:radial-gradient(60% 100% at 50% 0%,var(--wlu-accent,#c4b5fd) 0%,transparent 70%);opacity:.22;}
.wlu-eyebrow{font:600 11px/1 var(--font-mono,ui-monospace,Menlo);letter-spacing:.16em;text-transform:uppercase;
	color:var(--wlu-accent,#c4b5fd);position:relative;}
.wlu-ring{position:relative;width:84px;height:84px;margin:16px auto 12px;border-radius:50%;display:grid;place-items:center;
	background:radial-gradient(closest-side,color-mix(in srgb,var(--wlu-accent,#c4b5fd) 26%,transparent),transparent);
	box-shadow:0 0 0 1px color-mix(in srgb,var(--wlu-accent,#c4b5fd) 55%,transparent),
		0 0 28px color-mix(in srgb,var(--wlu-accent,#c4b5fd) 45%,transparent);}
.wlu-ring img{width:72px;height:72px;border-radius:50%;object-fit:cover;}
.wlu-ring .wlu-lvl{font:800 30px/1 var(--font-display,"Space Grotesk",sans-serif);color:#fff;}
.wlu-tier{font:800 22px/1.1 var(--font-display,"Space Grotesk",sans-serif);color:#fff;position:relative;}
.wlu-name{font:500 13px/1.3 var(--font-body,Inter,sans-serif);color:var(--ink-dim,rgba(255,255,255,.6));margin-top:5px;position:relative;}
.wlu-from{font:600 12px/1 var(--font-mono,ui-monospace,Menlo);color:var(--ink-dim,rgba(255,255,255,.55));margin-top:11px;position:relative;
	display:inline-flex;align-items:center;gap:7px;}
.wlu-from b{color:var(--wlu-accent,#c4b5fd);font-weight:700;}
.wlu-stats{display:flex;gap:8px;justify-content:center;margin-top:16px;position:relative;}
.wlu-stat{flex:1 1 0;min-width:0;padding:9px 8px;border-radius:var(--radius-md,10px);
	background:var(--surface-2,rgba(255,255,255,.05));border:1px solid var(--stroke,rgba(255,255,255,.08));}
.wlu-stat .k{font:600 9px/1 var(--font-mono,ui-monospace,Menlo);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-dim,rgba(255,255,255,.5));}
.wlu-stat .v{font:700 14px/1 var(--font-mono,ui-monospace,Menlo);color:#fff;margin-top:5px;font-feature-settings:"tnum";}
.wlu-stat .v.up{color:var(--success,#4ade80);}
.wlu-actions{display:flex;gap:8px;margin-top:18px;position:relative;}
.wlu-btn{flex:1;appearance:none;cursor:pointer;border-radius:var(--radius-pill,999px);padding:10px 12px;
	font:600 13px/1 var(--font-body,Inter,sans-serif);transition:transform var(--duration-instant,80ms) var(--ease-standard,ease),
	background var(--duration-fast,140ms) var(--ease-standard,ease),border-color var(--duration-fast,140ms) var(--ease-standard,ease);}
.wlu-btn:active{transform:translateY(1px);}
.wlu-btn.primary{border:1px solid transparent;color:#0a0a0a;
	background:var(--wlu-accent,#c4b5fd);}
.wlu-btn.primary:hover{filter:brightness(1.06);}
.wlu-btn.ghost{border:1px solid var(--stroke,rgba(255,255,255,.12));color:var(--ink,rgba(255,255,255,.85));background:transparent;}
.wlu-btn.ghost:hover{background:var(--surface-2,rgba(255,255,255,.06));border-color:var(--stroke-strong,rgba(255,255,255,.2));}
.wlu-btn:focus-visible{outline:2px solid var(--wlu-accent,#c4b5fd);outline-offset:2px;}
.wlu-close{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;
	background:transparent;border:0;color:var(--ink-dim,rgba(255,255,255,.5));cursor:pointer;font-size:18px;line-height:1;
	transition:background var(--duration-fast,140ms) var(--ease-standard,ease),color var(--duration-fast,140ms) var(--ease-standard,ease);}
.wlu-close:hover{background:var(--surface-2,rgba(255,255,255,.06));color:#fff;}
.wlu-close:focus-visible{outline:2px solid var(--wlu-accent,#c4b5fd);outline-offset:2px;}
.wlu-spark{position:absolute;top:46px;left:50%;width:5px;height:5px;border-radius:50%;
	background:var(--wlu-accent,#c4b5fd);pointer-events:none;opacity:0;
	animation:wlu-burst 900ms var(--ease-standard,ease) forwards;}
@keyframes wlu-burst{0%{opacity:0;transform:translate(-50%,0) scale(.4);}
	18%{opacity:1;}100%{opacity:0;transform:translate(calc(-50% + var(--dx,0px)),var(--dy,0px)) scale(1);}}
@media (prefers-reduced-motion: reduce){
	.wlu-backdrop,.wlu-card{transition:opacity var(--duration-fast,140ms) linear;}
	.wlu-card{transform:none;}
	.wlu-spark{display:none;}
}`;
	const el = document.createElement('style');
	el.id = 'wlu-styles';
	el.textContent = css;
	document.head.appendChild(el);
}

function sparks(card, accent) {
	if (REDUCED_MOTION) return;
	const N = 10;
	for (let i = 0; i < N; i++) {
		const s = document.createElement('span');
		s.className = 'wlu-spark';
		const ang = (i / N) * Math.PI * 2;
		const dist = 38 + (i % 3) * 14;
		s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
		s.style.setProperty('--dy', `${Math.sin(ang) * dist - 10}px`);
		s.style.background = accent;
		s.style.animationDelay = `${i * 18}ms`;
		card.appendChild(s);
	}
}

async function fetchAgentBrief(agentId) {
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
			headers: { accept: 'application/json' }, credentials: 'include',
		});
		if (!r.ok) return {};
		const body = await r.json().catch(() => ({}));
		const a = body?.data || body || {};
		return {
			name: a.name || a.display_name || null,
			image: a.image_url || a.thumbnail_url || a.preview_url || null,
		};
	} catch { return {}; }
}

function render(detail) {
	if (typeof document === 'undefined') { next(); return; }
	ensureStyles();
	const { agentId, from, to, state, away } = detail;
	const toTier = tierMetaForLevel(to);
	const fromTier = tierMetaForLevel(from);
	const vis = computeWalletVisual({ usdTotal: Number(state?.balanceUsd) || 0, mix: { sol: 1 }, hasThree: false });
	const accent = vis.accent || 'var(--wallet-accent,#c4b5fd)';
	const balance = formatNetWorth({ usdTotal: Number(state?.balanceUsd) || 0 });
	const momentum = formatMomentum(state);
	const momentumUp = (Number(state?.momentumUsd24h) || 0) > 0;

	const backdrop = document.createElement('div');
	backdrop.className = 'wlu-backdrop';
	backdrop.style.setProperty('--wlu-accent', accent);

	const titleId = `wlu-title-${agentId}`;
	backdrop.innerHTML = `
		<div class="wlu-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
			<div class="wlu-glowwash"></div>
			<button class="wlu-close" type="button" aria-label="Dismiss">×</button>
			<div class="wlu-eyebrow">${away ? 'Tier reached' : 'Wealth tier up'}</div>
			<div class="wlu-ring" aria-hidden="true"><span class="wlu-lvl">${esc(String(to))}</span></div>
			<div class="wlu-tier" id="${titleId}">${esc(toTier.label)}</div>
			<div class="wlu-name" data-name>Your agent reached a new presence tier</div>
			<div class="wlu-from">${esc(fromTier.label)} <b>→ ${esc(toTier.label)}</b></div>
			<div class="wlu-stats">
				<div class="wlu-stat"><div class="k">Net worth</div><div class="v">${esc(balance)}</div></div>
				<div class="wlu-stat"><div class="k">24h flow</div><div class="v${momentumUp ? ' up' : ''}">${esc(momentum)}</div></div>
			</div>
			<div class="wlu-actions">
				<button class="wlu-btn primary" type="button" data-share>Share</button>
				<a class="wlu-btn ghost" data-wallet href="/agents/${encodeURIComponent(agentId)}/wallet">View wallet</a>
			</div>
		</div>`;

	document.body.appendChild(backdrop);
	const card = backdrop.querySelector('.wlu-card');
	const closeBtn = backdrop.querySelector('.wlu-close');
	const shareBtn = backdrop.querySelector('[data-share]');
	let _brief = {};

	// Real agent name + thumbnail, fetched once (graceful if it fails).
	fetchAgentBrief(agentId).then((brief) => {
		if (!backdrop.isConnected) return;
		if (brief.name) {
			const n = backdrop.querySelector('[data-name]');
			if (n) n.textContent = `${brief.name} reached ${toTier.label}`;
		}
		if (brief.image) {
			const ring = backdrop.querySelector('.wlu-ring');
			if (ring) {
				ring.innerHTML = '';
				const img = document.createElement('img');
				img.src = brief.image; img.alt = '';
				img.addEventListener('error', () => {
					ring.innerHTML = `<span class="wlu-lvl">${esc(String(to))}</span>`;
				});
				ring.appendChild(img);
			}
		}
		_brief = brief;
	});

	let autoTimer = 0;
	let disposed = false;
	const prevFocus = document.activeElement;

	function teardown() {
		if (disposed) return;
		disposed = true;
		clearTimeout(autoTimer);
		backdrop.classList.remove('wlu-in');
		document.removeEventListener('keydown', onKey, true);
		const done = () => { backdrop.remove(); try { prevFocus?.focus?.(); } catch {} next(); };
		if (REDUCED_MOTION) done();
		else { backdrop.addEventListener('transitionend', done, { once: true }); setTimeout(done, 320); }
	}
	function onKey(e) {
		if (e.key === 'Escape') { e.stopPropagation(); teardown(); }
		else if (e.key === 'Tab') trapFocus(e, backdrop);
	}

	closeBtn.addEventListener('click', teardown);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) teardown(); });
	shareBtn.addEventListener('click', () => shareLevelUp(agentId, toTier, _brief, shareBtn));
	backdrop.querySelector('[data-wallet]').addEventListener('click', teardown);
	document.addEventListener('keydown', onKey, true);

	// Pause the auto-dismiss while the owner is reading/hovering.
	const arm = () => { clearTimeout(autoTimer); autoTimer = setTimeout(teardown, AUTO_DISMISS_MS); };
	const disarm = () => clearTimeout(autoTimer);
	backdrop.addEventListener('mouseenter', disarm);
	backdrop.addEventListener('mouseleave', arm);
	backdrop.addEventListener('focusin', disarm);
	backdrop.addEventListener('focusout', arm);

	_active = { teardown };

	requestAnimationFrame(() => {
		backdrop.classList.add('wlu-in');
		sparks(card, accent);
		closeBtn.focus();
		arm();
	});
}

async function shareLevelUp(agentId, toTier, brief, btn) {
	const url = `${location.origin}/agents/${encodeURIComponent(agentId)}`;
	const who = brief?.name || 'My agent';
	const text = `${who} just reached ${toTier.label} on @three_ws — its wallet glows brighter the more it earns.`;
	try {
		if (navigator.share) {
			await navigator.share({ title: 'Wealth tier up', text, url });
			return;
		}
	} catch { /* user cancelled the native sheet — fall through to copy */ }
	try {
		await navigator.clipboard.writeText(`${text} ${url}`);
		flash(btn, 'Link copied');
	} catch {
		flash(btn, url);
	}
}

function flash(btn, msg) {
	if (!btn) return;
	const prev = btn.textContent;
	btn.textContent = msg;
	btn.disabled = true;
	setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1600);
}

function trapFocus(e, root) {
	const focusables = root.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
	if (!focusables.length) return;
	const first = focusables[0];
	const last = focusables[focusables.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const _internals = { readSeenLevel, writeSeenLevel, SEEN_PREFIX, EVENT, AUTO_DISMISS_MS };

if (typeof window !== 'undefined') {
	window.twsWealthLevelUp = { installLevelUpCelebrations, trackLevelUp, shouldCelebrate, tierMetaForLevel };
}
