/**
 * Talk mode overlay — open from /avatars/:id, closes by ✕ or Escape.
 *
 * One self-contained module: builds the DOM, mounts a three.js TalkScene with
 * the avatar's GLB, wires a hold-to-talk button to a TalkController, renders
 * the live transcript. Nothing else in avatar-page needs to know about scenes
 * or audio graphs — call openTalkMode({ avatar }) and the rest happens here.
 *
 * Real wires throughout:
 *   - GLB renders via three.js (TalkScene)
 *   - mic captures via Web Speech API
 *   - replies stream from /api/chat
 *   - voice synthesizes via /api/tts/eleven (cloned voice when avatar has an
 *     agent with voice_id, else /api/tts/edge)
 *   - mouth movement comes from the FFT of the actual TTS audio
 */

import { TalkScene } from './talk-scene.js';
import { AvatarMouthTarget } from './avatar-morph-target.js';
import { TalkController } from './talk-controller.js';
import { openVoiceCloneModal } from './voice-clone-modal.js';
import { nextPreset, PRESET_LABELS } from './camera-presets.js';

let activeSession = null;

/**
 * Open the talk overlay for an avatar record. Returns the session handle so
 * callers can close it programmatically (otherwise the user closes via UI).
 *
 * @param {object} opts
 * @param {object} opts.avatar       Decorated avatar from /api/avatars/:id
 * @param {() => string} [opts.systemPromptFn]
 */
export function openTalkMode({ avatar, systemPromptFn }) {
	if (activeSession) return activeSession; // single instance — no overlap

	const glbUrl = avatar.model_url || avatar.url;
	const glbBlob = avatar.glbBlob || null;
	if (!glbUrl && !glbBlob) {
		console.warn('[talk] avatar has no GLB; cannot enter talk mode');
		return null;
	}

	injectStylesOnce();

	const overlay = document.createElement('div');
	overlay.className = 'tws-talk-overlay';
	overlay.innerHTML = TEMPLATE;
	document.body.appendChild(overlay);
	document.body.classList.add('tws-talk-open');

	const stage = overlay.querySelector('.tws-talk-stage');
	const closeBtn = overlay.querySelector('.tws-talk-close');
	const holdBtn = overlay.querySelector('.tws-talk-hold');
	const statusEl = overlay.querySelector('.tws-talk-status');
	const transcriptEl = overlay.querySelector('.tws-talk-transcript');
	const errEl = overlay.querySelector('.tws-talk-error');
	const nameEl = overlay.querySelector('.tws-talk-name');
	const cloneBtn = overlay.querySelector('.tws-talk-clone');
	const frameBtn = overlay.querySelector('.tws-talk-frame');
	const frameLabel = frameBtn?.querySelector('.tws-talk-frame-label');
	const emoteBar = overlay.querySelector('.tws-talk-emotes');
	nameEl.textContent = avatar.name || 'Avatar';

	// Owner-only affordance: `owner_id` is stripped from the API response for
	// non-owners (see api/_lib/avatars.js stripOwnerFor), so its presence
	// is the signal that the current session owns this avatar.
	const isOwner = !!avatar.owner_id;
	if (isOwner && avatar.agent_id) {
		cloneBtn.hidden = false;
	}

	const scene = new TalkScene();
	const mouthTarget = new AvatarMouthTarget();

	let controller = null;
	let unloading = false;

	scene
		.mount({ container: stage, glbUrl: glbBlob ? undefined : glbUrl, glbBlob, cameraPreset: 'half' })
		.then(async (root) => {
			scene.attachMouthTarget(mouthTarget);
			// Log what we found so debugging mismatched rigs in the field is easy.
			const diag = mouthTarget.describe();
			if (!mouthTarget.hasMouthMorphs() && !mouthTarget.hasJawBone()) {
				console.warn('[talk] avatar has no mouth morphs or jaw bone — speech will play but the mouth won\'t move. Diagnostics:', diag);
			} else {
				console.info('[talk] mouth binding:', diag);
			}
			setStatus(statusEl, 'idle');

			// Render the emote bar once the animation manifest is available.
			const emotes = scene.getEmoteController();
			if (emotes) {
				await emotes.loadManifest();
				renderEmoteBar(emoteBar, emotes, errEl);
			}
		})
		.catch((err) => {
			showError(errEl, `Could not load avatar: ${err.message}`);
		});

	controller = new TalkController({
		avatar,
		systemPromptFn,
		mouthTarget,
		onMessage: (m) => appendTranscript(transcriptEl, m),
		onStateChange: (s) => setStatus(statusEl, s),
		onError: (e) => showError(errEl, e.message),
	});

	// ── Hold-to-talk ───────────────────────────────────────────────────
	const startHold = (ev) => {
		ev.preventDefault();
		if (controller.state !== 'idle' && controller.state !== 'speaking') return;
		controller.stop(); // truncate any in-flight speech so the user can interrupt
		controller.startListening();
		holdBtn.classList.add('tws-talk-hold-active');
	};
	const endHold = (ev) => {
		ev.preventDefault();
		controller.stopListening();
		holdBtn.classList.remove('tws-talk-hold-active');
	};
	holdBtn.addEventListener('mousedown', startHold);
	holdBtn.addEventListener('mouseup', endHold);
	holdBtn.addEventListener('mouseleave', endHold);
	holdBtn.addEventListener('touchstart', startHold, { passive: false });
	holdBtn.addEventListener('touchend', endHold);
	holdBtn.addEventListener('touchcancel', endHold);

	// Keyboard: Space = hold-to-talk while overlay is open.
	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
		if (e.code === 'Space' && e.target === document.body) {
			if (e.repeat) return;
			if (e.type === 'keydown') startHold(e);
			else endHold(e);
		}
	};
	window.addEventListener('keydown', onKey);
	window.addEventListener('keyup', onKey);

	closeBtn.addEventListener('click', () => close());

	if (frameBtn) {
		frameBtn.addEventListener('click', () => {
			const next = nextPreset(scene.getCameraPreset?.() || 'half');
			scene.setCameraPreset?.(next);
			if (frameLabel) frameLabel.textContent = PRESET_LABELS[next] || next;
		});
	}

	if (cloneBtn) {
		cloneBtn.addEventListener('click', () => {
			openVoiceCloneModal({
				agentId: avatar.agent_id,
				agentName: avatar.name || 'Avatar',
				onClose: () => {
					// User may have completed a clone — invalidate the cache so the
					// next turn picks up the new voice_id from the agent record.
					controller?.refreshVoice();
				},
			});
		});
	}

	function close() {
		if (unloading) return;
		unloading = true;
		try {
			controller?.stop();
		} catch {}
		try {
			scene.unmount();
		} catch {}
		mouthTarget.dispose();
		window.removeEventListener('keydown', onKey);
		window.removeEventListener('keyup', onKey);
		document.body.classList.remove('tws-talk-open');
		overlay.remove();
		activeSession = null;
	}

	activeSession = { close };
	return activeSession;
}

export function closeTalkMode() {
	activeSession?.close();
}

// ── DOM template + styles ──────────────────────────────────────────────

const TEMPLATE = `
	<button class="tws-talk-close" aria-label="Exit talk mode" title="Exit (Esc)">✕</button>
	<div class="tws-talk-header">
		<div>
			<span class="tws-talk-eyebrow">Talking to</span>
			<span class="tws-talk-name"></span>
		</div>
		<div class="tws-talk-header-actions">
			<button class="tws-talk-frame" type="button" title="Cycle framing: half → headshot → full" aria-label="Cycle camera framing">
				<span aria-hidden="true">⛶</span>
				<span class="tws-talk-frame-label">Half body</span>
			</button>
			<button class="tws-talk-clone" type="button" hidden aria-label="Clone your voice for this avatar">
				<span aria-hidden="true">🎙️</span> Use my voice
			</button>
		</div>
	</div>
	<div class="tws-talk-stage"></div>
	<div class="tws-talk-emotes" hidden role="toolbar" aria-label="Emote shortcuts"></div>
	<div class="tws-talk-transcript" aria-live="polite"></div>
	<div class="tws-talk-controls">
		<button class="tws-talk-hold" type="button" aria-label="Hold to talk">
			<span class="tws-talk-hold-dot"></span>
			<span class="tws-talk-hold-label">Hold to talk</span>
		</button>
		<div class="tws-talk-status" data-state="idle">Ready</div>
	</div>
	<div class="tws-talk-error" role="alert" hidden></div>
`;

const STATUS_LABEL = {
	idle: 'Ready',
	listening: 'Listening…',
	thinking: 'Thinking…',
	speaking: 'Speaking',
};

function setStatus(el, state) {
	if (!el) return;
	el.dataset.state = state;
	el.textContent = STATUS_LABEL[state] || state;
}

function renderEmoteBar(barEl, emotes, errEl) {
	if (!barEl || !emotes) return;
	const defs = emotes.getBarDefs();
	if (!defs.length) return; // manifest didn't load or none of the curated set is shipped — keep hidden
	barEl.innerHTML = defs
		.map(
			(d) => `
		<button class="tws-talk-emote" type="button" data-name="${d.name}" title="${d.label}" aria-label="${d.label}">
			<span class="tws-talk-emote-icon" aria-hidden="true">${d.icon}</span>
		</button>
	`,
		)
		.join('');
	barEl.hidden = false;
	barEl.querySelectorAll('.tws-talk-emote').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const ok = await emotes.play(btn.dataset.name);
			if (!ok && errEl) showError(errEl, `Emote "${btn.dataset.name}" could not play.`);
		});
	});
}

function appendTranscript(el, msg) {
	if (!el) return;
	const row = document.createElement('div');
	row.className = `tws-talk-msg tws-talk-msg-${msg.role}`;
	row.textContent = msg.content;
	el.appendChild(row);
	el.scrollTop = el.scrollHeight;
}

function showError(el, message) {
	if (!el) return;
	el.textContent = message;
	el.hidden = false;
	setTimeout(() => {
		el.hidden = true;
		el.textContent = '';
	}, 4000);
}

function injectStylesOnce() {
	if (document.getElementById('tws-talk-mode-css')) return;
	const css = document.createElement('style');
	css.id = 'tws-talk-mode-css';
	css.textContent = TALK_CSS;
	document.head.appendChild(css);
}

const TALK_CSS = `
.tws-talk-open { overflow: hidden; }
.tws-talk-overlay {
	position: fixed; inset: 0; z-index: 9999;
	background:
		radial-gradient(ellipse at 50% 30%, rgba(125,211,252,0.10), transparent 60%),
		radial-gradient(ellipse at 70% 80%, rgba(167,139,250,0.08), transparent 50%),
		#050505;
	color: #fafafa;
	font-family: 'Inter', system-ui, sans-serif;
	display: grid;
	grid-template-rows: auto 1fr auto auto;
	animation: tws-talk-in 200ms ease-out;
}
@keyframes tws-talk-in { from { opacity: 0; } to { opacity: 1; } }
.tws-talk-close {
	position: absolute; top: 14px; right: 16px;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.12);
	color: #fafafa;
	width: 36px; height: 36px;
	border-radius: 999px;
	font-size: 14px;
	font-family: inherit;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s;
}
.tws-talk-close:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.25); }
.tws-talk-header {
	padding: 16px 24px 0;
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
}
.tws-talk-header > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tws-talk-header-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-shrink: 0;
}
.tws-talk-clone, .tws-talk-frame {
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.14);
	color: #fafafa;
	font-family: inherit;
	font-size: 12px;
	font-weight: 600;
	padding: 7px 12px;
	border-radius: 999px;
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s, transform 0.1s;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}
.tws-talk-clone:hover, .tws-talk-frame:hover {
	background: rgba(255,255,255,0.10);
	border-color: rgba(255,255,255,0.25);
	transform: translateY(-1px);
}
.tws-talk-eyebrow {
	font-family: 'Space Grotesk', sans-serif;
	font-size: 10px; letter-spacing: 0.18em;
	text-transform: uppercase;
	color: #a1a1aa;
}
.tws-talk-name {
	font-family: 'Space Grotesk', sans-serif;
	font-size: 20px; font-weight: 700;
	letter-spacing: -0.01em;
}
.tws-talk-stage {
	min-height: 0; position: relative;
}
.tws-talk-stage canvas {
	width: 100% !important; height: 100% !important; display: block;
}
.tws-talk-emotes {
	display: flex;
	gap: 6px;
	padding: 8px 24px;
	overflow-x: auto;
	border-top: 1px solid rgba(255,255,255,0.06);
	background: rgba(255,255,255,0.02);
}
.tws-talk-emote {
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.12);
	color: #fafafa;
	font-family: inherit;
	font-size: 18px;
	line-height: 1;
	width: 38px;
	height: 38px;
	border-radius: 999px;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	transition: background 0.15s, border-color 0.15s, transform 0.1s;
	flex-shrink: 0;
}
.tws-talk-emote:hover {
	background: rgba(255,255,255,0.12);
	border-color: rgba(255,255,255,0.25);
	transform: translateY(-1px);
}
.tws-talk-transcript {
	max-height: 160px;
	overflow-y: auto;
	padding: 8px 24px;
	display: flex; flex-direction: column; gap: 6px;
	border-top: 1px solid rgba(255,255,255,0.06);
}
.tws-talk-msg {
	font-size: 14px; line-height: 1.5;
	padding: 8px 12px; border-radius: 10px;
	max-width: 75%;
	word-wrap: break-word; white-space: pre-wrap;
}
.tws-talk-msg-user {
	align-self: flex-end;
	background: rgba(125,211,252,0.12);
	border: 1px solid rgba(125,211,252,0.25);
}
.tws-talk-msg-assistant {
	align-self: flex-start;
	background: rgba(255,255,255,0.04);
	border: 1px solid rgba(255,255,255,0.08);
}
.tws-talk-controls {
	padding: 16px 24px 28px;
	display: flex; flex-direction: column;
	align-items: center; gap: 8px;
	border-top: 1px solid rgba(255,255,255,0.06);
}
.tws-talk-hold {
	display: inline-flex; align-items: center; gap: 12px;
	background: #fafafa; color: #000;
	border: 0; border-radius: 999px;
	padding: 14px 28px;
	font-family: inherit; font-size: 15px; font-weight: 600;
	cursor: pointer;
	user-select: none;
	-webkit-user-select: none;
	transition: transform 0.1s, box-shadow 0.15s;
}
.tws-talk-hold:hover { transform: translateY(-1px); }
.tws-talk-hold-dot {
	display: inline-block; width: 10px; height: 10px; border-radius: 999px;
	background: #ef4444;
	transition: transform 0.2s;
}
.tws-talk-hold-active {
	background: #ef4444; color: #fff;
	box-shadow: 0 0 0 6px rgba(239,68,68,0.18);
}
.tws-talk-hold-active .tws-talk-hold-dot {
	background: #fff;
	transform: scale(1.4);
	animation: tws-talk-pulse 0.9s ease-in-out infinite;
}
@keyframes tws-talk-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
.tws-talk-status {
	font-size: 11px;
	letter-spacing: 0.08em; text-transform: uppercase;
	color: #71717a;
	transition: color 0.2s;
}
.tws-talk-status[data-state="listening"] { color: #f43f5e; }
.tws-talk-status[data-state="thinking"]  { color: #a78bfa; }
.tws-talk-status[data-state="speaking"]  { color: #34d399; }
.tws-talk-error {
	position: absolute; left: 50%; bottom: 100px;
	transform: translateX(-50%);
	background: rgba(244,63,94,0.14);
	border: 1px solid rgba(244,63,94,0.4);
	color: #fda4af;
	padding: 8px 14px; border-radius: 10px;
	font-size: 13px;
}
@media (max-width: 600px) {
	.tws-talk-header { padding: 12px 16px 0; }
	.tws-talk-transcript { padding: 8px 16px; max-height: 120px; }
	.tws-talk-controls { padding: 12px 16px 20px; }
	.tws-talk-hold { padding: 12px 22px; font-size: 14px; }
}
`;
