// Spectator reactions + tips — the two-way layer that sits under a live agent
// stream. A viewer taps an emoji and it floats up over the screen and piles on
// for everyone watching; a viewer tips and real value lands in the agent's
// wallet, the avatar emotes, and (on the screen surface) it says thanks out loud.
//
// This module owns the reaction BAR, the floating-emoji OVERLAY, the live COUNT,
// and the tip → emote/voice ACKNOWLEDGEMENT. Both the live wall (compact, per
// card) and the agent screen (full) mount it; the host only has to forward the
// stream's `reaction` events and (optionally) hand us an AnimationManager +
// AudioContext so the avatar can react.
//
// Real integrations, no mocks:
//   • Reactions POST to /api/agent/watch-intent (allowlist + throttle server-side).
//   • Tips use the existing non-custodial tip modal (shared/agent-tip-modal.js) —
//     viewer-signed Solana transfer straight to the agent's public wallet.
//   • The acknowledgement voice is real TTS from /api/tts/speak.
//   • The only coin referenced is $THREE.

import { mountReactionOverlay, REACTION_EMOJI } from './reaction-overlay.js';
import { openTipModal } from './shared/agent-tip-modal.js';
import { getWalletStatus } from './shared/agent-wallet-chip.js';

const STYLE_ID = 'tws-agent-reactions-styles';
const ACK_COOLDOWN_MS = 6_000;   // at most one voiced thank-you per this window
const SELF_BURST = 4;            // particles spawned locally on your own tap
const TAP_THROTTLE_MS = 600;     // client-side cosmetic guard between taps

// One human thank-you line, picked by tip size. $THREE is the only coin we name.
function ackLine(name) {
	const who = name && name !== 'Agent' ? '' : '';
	void who;
	const lines = [
		'Thanks for the tip — that one goes straight to the $THREE floor fund.',
		'Appreciate you. Every tip stacks the $THREE floor.',
		'Tip received — thank you. Keeping it all in $THREE.',
	];
	// Deterministic-ish rotation without Math.random pulling state around.
	ackLine._i = (ackLine._i || 0) + 1;
	return lines[ackLine._i % lines.length];
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.rx-bar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;}
.rx-emojis{display:flex;align-items:center;gap:4px;}
.rx-btn{appearance:none;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);
	border-radius:999px;cursor:pointer;line-height:1;padding:0;display:inline-flex;align-items:center;
	justify-content:center;transition:transform .1s ease,background .15s ease,border-color .15s ease;
	width:34px;height:34px;font-size:17px;}
.rx-btn:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.22);transform:translateY(-1px);}
.rx-btn:active{transform:scale(.9);}
.rx-btn:focus-visible{outline:2px solid #a78bfa;outline-offset:2px;}
.rx-btn:disabled{opacity:.5;cursor:not-allowed;}
.rx-tip{appearance:none;border:1px solid rgba(167,139,250,.45);
	background:linear-gradient(180deg,rgba(167,139,250,.22),rgba(124,58,237,.22));color:#ddd6fe;
	border-radius:999px;cursor:pointer;font:inherit;font-weight:700;font-size:12.5px;line-height:1;
	padding:0 13px;height:34px;display:inline-flex;align-items:center;gap:6px;
	transition:filter .15s ease,transform .1s ease,border-color .15s ease;white-space:nowrap;}
.rx-tip:hover{filter:brightness(1.12);border-color:rgba(167,139,250,.75);transform:translateY(-1px);}
.rx-tip:active{transform:translateY(1px);}
.rx-tip:focus-visible{outline:2px solid #a78bfa;outline-offset:2px;}
.rx-tip:disabled{opacity:.55;cursor:not-allowed;filter:grayscale(.4);}
.rx-count{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;
	color:rgba(255,255,255,.62);margin-left:2px;white-space:nowrap;}
.rx-count .rx-dot{width:6px;height:6px;border-radius:50%;background:#f97316;box-shadow:0 0 8px #f97316;
	opacity:0;transition:opacity .25s ease;}
.rx-count.live .rx-dot{opacity:1;}
.rx-count .rx-num{font-variant-numeric:tabular-nums;color:#fff;transition:transform .12s ease;}
.rx-count.bump .rx-num{transform:scale(1.25);}
.rx-hint{font-size:11.5px;color:rgba(255,255,255,.4);white-space:nowrap;}
.rx-cue{font-size:11.5px;color:#fca5a5;white-space:nowrap;opacity:0;transition:opacity .2s ease;}
.rx-cue.show{opacity:1;}
.rx-bar.connecting .rx-btn,.rx-bar.connecting .rx-tip{animation:rx-pulse 1.4s ease-in-out infinite;}
.rx-bar.compact .rx-btn{width:28px;height:28px;font-size:14px;}
.rx-bar.compact .rx-tip{height:28px;padding:0 10px;font-size:11.5px;}
.rx-bar.compact .rx-count,.rx-bar.compact .rx-hint{font-size:11px;}
/* The compact bar rides inside a card, so it has to live within the card's
   width instead of running off both edges. On a 320px viewport the emoji row +
   tip + hint no longer fit on one line: wrap, and drop the hint (the count and
   the buttons carry the meaning) rather than clipping a real control. */
.rx-bar.compact{max-width:100%;min-width:0;flex-wrap:wrap;justify-content:center;row-gap:4px;}
.rx-bar.compact .rx-emojis{flex-wrap:wrap;justify-content:center;}
.rx-bar.compact .rx-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;}
@media (max-width:420px){.rx-bar.compact .rx-hint{display:none;}}
@keyframes rx-pulse{0%,100%{opacity:.65;}50%{opacity:1;}}
@media (prefers-reduced-motion:reduce){.rx-btn,.rx-tip,.rx-count .rx-num,.rx-bar.connecting .rx-btn,.rx-bar.connecting .rx-tip{transition:none;animation:none;}}
`;
	(document.head || document.documentElement).appendChild(s);
}

/**
 * Mount the reactions experience for one agent.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {HTMLElement} opts.barHost        where the reaction bar is appended
 * @param {HTMLElement} opts.overlayHost    positioned element the overlay paints over
 * @param {() => object|null} [opts.getAgent]  returns the freshest agent record (for tip wallet)
 * @param {() => object|null} [opts.getAnimManager]  returns the avatar AnimationManager (emote on tip)
 * @param {() => (AudioContext|null)} [opts.getAudioContext]  resumed AudioContext for the thank-you voice
 * @param {boolean} [opts.compact]          tighter sizing for wall cards
 * @param {boolean} [opts.voice=true]       speak a thank-you on tip
 * @param {string} [opts.voiceId]           TTS voice id for the thank-you
 * @param {boolean} [opts.subscribe=false]  open the controller's own SSE stream for reaction events
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @returns {{
 *   onReaction(payload:object):void, onTip(detail?:object):void,
 *   setConnected(b:boolean):void, destroy():void
 * }}
 */
export function mountAgentReactions(opts = {}) {
	const {
		agentId,
		barHost,
		overlayHost,
		getAgent = () => null,
		getAnimManager = () => null,
		getAudioContext = () => null,
		compact = false,
		voice = true,
		voiceId = null,
		subscribe = false,
		network = 'mainnet',
	} = opts;
	if (typeof document === 'undefined' || !agentId || !barHost) {
		return { onReaction() {}, onTip() {}, setConnected() {}, destroy() {} };
	}
	ensureStyles();

	const overlay = mountReactionOverlay(overlayHost || barHost, {
		baseFontPx: compact ? 22 : 34,
		max: compact ? 36 : 64,
		perBurst: compact ? 8 : 12,
	});

	const bar = document.createElement('div');
	bar.className = `rx-bar connecting${compact ? ' compact' : ''}`;
	bar.innerHTML = `
		<div class="rx-emojis" role="group" aria-label="React to ${escAttr(agentNameFromAgent(getAgent()))}">
			${REACTION_EMOJI.map(
				(e) => `<button type="button" class="rx-btn" data-react="${escAttr(e)}" aria-label="React ${escAttr(e)}">${e}</button>`,
			).join('')}
		</div>
		<button type="button" class="rx-tip" data-tip aria-label="Tip this agent">◎ Tip</button>
		<span class="rx-count" data-count aria-live="polite" title="Reactions in the last couple of minutes">
			<span class="rx-dot"></span><span class="rx-num" data-num>0</span>
		</span>
		<span class="rx-hint" data-hint>Be the first to react</span>
		<span class="rx-cue" data-cue role="alert"></span>`;
	// Cards on the wall are wrapped in an <a>; stop taps from navigating away.
	bar.addEventListener('click', (e) => {
		if (e.target.closest('[data-react],[data-tip]')) {
			e.preventDefault();
			e.stopPropagation();
		}
	});
	barHost.appendChild(bar);

	const numEl = bar.querySelector('[data-num]');
	const countEl = bar.querySelector('[data-count]');
	const hintEl = bar.querySelector('[data-hint]');
	const cueEl = bar.querySelector('[data-cue]');
	const tipBtn = bar.querySelector('[data-tip]');

	let total = 0;
	let lastTapAt = 0;
	let lastAckAt = 0;
	let cueTimer = null;
	let destroyed = false;

	function setCount(n) {
		if (!Number.isFinite(n) || n <= total) return;
		total = n;
		numEl.textContent = String(total);
		if (hintEl) hintEl.style.display = 'none';
		countEl.classList.add('live', 'bump');
		setTimeout(() => countEl.classList.remove('bump'), 140);
	}

	function showCue(msg) {
		if (!cueEl) return;
		cueEl.textContent = msg;
		cueEl.classList.add('show');
		clearTimeout(cueTimer);
		cueTimer = setTimeout(() => cueEl.classList.remove('show'), 1500);
	}

	async function sendReaction(emoji) {
		const now = Date.now();
		if (now - lastTapAt < TAP_THROTTLE_MS) { showCue('easy — give it a sec'); return; }
		lastTapAt = now;
		// Optimistic: your tap lands instantly even if Redis is cold.
		overlay.burst(emoji, SELF_BURST);
		try {
			const res = await fetch('/api/agent/watch-intent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId, reaction: emoji }),
				keepalive: true,
			});
			const j = await res.json().catch(() => ({}));
			if (res.status === 429 || j.throttled) { showCue('easy — give it a sec'); return; }
			if (Number.isFinite(j?.reaction?.total)) setCount(j.reaction.total);
		} catch { /* network — the optimistic burst already acknowledged the tap */ }
	}

	// Resolve a tippable agent record. The wall card only holds {id,name,avatar},
	// so when no wallet is visible we fetch the full agent once before tipping —
	// the tip is always real, never a dead button.
	let cachedTippable = null;
	async function resolveTippable() {
		if (cachedTippable && getWalletStatus(cachedTippable)) return cachedTippable;
		const local = getAgent();
		if (local && getWalletStatus(local)) { cachedTippable = local; return local; }
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
			if (res.ok) {
				const j = await res.json();
				const agent = j.agent || j;
				if (getWalletStatus(agent)) { cachedTippable = agent; return agent; }
			}
		} catch { /* fall through to the null case */ }
		return null;
	}

	async function openTip() {
		tipBtn.disabled = true;
		const prev = tipBtn.textContent;
		tipBtn.textContent = '◎ …';
		const agent = await resolveTippable();
		tipBtn.disabled = false;
		tipBtn.textContent = prev;
		if (!agent) { showCue('this agent has no wallet yet'); return; }
		openTipModal(agent, {
			network,
			onSent: (res) => {
				// Drive the local acknowledgement immediately; the patron-support event
				// the modal also fires keeps any other open surface in sync.
				onTip({ agentId, signature: res?.signature, local: true });
			},
		});
	}

	// A confirmed tip for THIS agent: celebrate on the overlay, emote the avatar,
	// and (on a surface with audio) say thanks in the agent's voice.
	function onTip(detail = {}) {
		if (destroyed) return;
		if (detail.agentId && detail.agentId !== agentId) return;
		overlay.burst('🎉', 8);
		overlay.burst('❤️', 5);
		playEmote();
		if (voice) speakThanks();
	}

	function playEmote() {
		try {
			const am = getAnimManager?.();
			if (!am) return;
			if (typeof am.supportsCanonicalClips === 'function' && am.supportsCanonicalClips()) {
				am.playOnce('cheer', { settleTo: 'idle' }).catch(() => {
					am.playOnce('wave', { settleTo: 'idle' }).catch(() => {});
				});
			} else if (typeof am.playOverlay === 'function') {
				am.playOverlay('wave', { upperBodyOnly: true, loop: false }).catch(() => {});
			}
		} catch { /* emote is best-effort and never blocks the value path */ }
	}

	async function speakThanks() {
		const now = Date.now();
		if (now - lastAckAt < ACK_COOLDOWN_MS) return; // don't talk over a flood of tips
		lastAckAt = now;
		const ctx = getAudioContext?.();
		if (!ctx) return; // no resumed audio context on this surface → emote-only ack
		try {
			const body = { text: ackLine(agentNameFromAgent(getAgent())), format: 'mp3' };
			if (voiceId) body.voice = voiceId;
			const res = await fetch('/api/tts/speak', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) return;
			const buf = await res.arrayBuffer();
			const audio = await ctx.decodeAudioData(buf.slice(0));
			const src = ctx.createBufferSource();
			src.buffer = audio;
			src.connect(ctx.destination);
			src.start();
		} catch { /* voice is best-effort — the tip already landed and the avatar emoted */ }
	}

	// ── wiring ──────────────────────────────────────────────────────────────
	for (const btn of bar.querySelectorAll('[data-react]')) {
		btn.addEventListener('click', () => sendReaction(btn.dataset.react));
	}
	tipBtn.addEventListener('click', openTip);

	// Keep every open surface for this agent in sync when a tip is confirmed
	// anywhere (the tip modal dispatches this on the window after recording).
	const onPatron = (e) => {
		const d = e?.detail || {};
		if (d.agentId === agentId && !d.local) onTip(d);
	};
	window.addEventListener('three:patron-support', onPatron);

	// Forward a stream `reaction` event: { bursts:[{emoji,ts}], total }.
	function onReaction(payload) {
		if (destroyed || !payload) return;
		const bursts = Array.isArray(payload.bursts) ? payload.bursts : [];
		for (const b of bursts) if (b?.emoji) overlay.burst(b.emoji, 1);
		if (Number.isFinite(payload.total)) setCount(payload.total);
	}

	// Optional self-managed SSE: surfaces that don't already own a stream client
	// (the single-agent screen) let the controller subscribe to reaction events
	// directly. Surfaces that already have a per-agent EventSource (the wall) pass
	// subscribe:false and forward events into onReaction() instead — no second
	// connection per card.
	let es = null;
	if (subscribe && typeof EventSource !== 'undefined') {
		try {
			es = new EventSource(`/api/agent-screen-stream?agentId=${encodeURIComponent(agentId)}`);
			es.addEventListener('open', () => setConnectedState(true));
			es.addEventListener('reaction', (e) => { try { onReaction(JSON.parse(e.data)); } catch { /* malformed */ } });
			es.onerror = () => setConnectedState(false);
		} catch { /* no stream — the bar still posts reactions and tips work */ }
	}

	function setConnectedState(connected) {
		bar.classList.toggle('connecting', !connected);
	}

	const onPageHide = () => { try { es?.close(); } catch { /* */ } };
	if (es) window.addEventListener('pagehide', onPageHide);

	return {
		onReaction,
		onTip,
		setConnected: setConnectedState,
		destroy() {
			destroyed = true;
			window.removeEventListener('three:patron-support', onPatron);
			window.removeEventListener('pagehide', onPageHide);
			try { es?.close(); } catch { /* */ }
			clearTimeout(cueTimer);
			overlay.destroy();
			bar.remove();
		},
	};
}

function agentNameFromAgent(agent) {
	return (agent && (agent.name || agent.agentName)) || 'Agent';
}
function escAttr(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
