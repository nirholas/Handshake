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
import { TALK_LANGUAGES, detectTalkLanguage, talkLanguage } from './talk-languages.js';
import { nextPreset, PRESET_LABELS } from './camera-presets.js';
import { WalletIntentController } from './wallet-intent.js';
import { log } from '../shared/log.js';

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
		log.warn('[talk] avatar has no GLB; cannot enter talk mode');
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
	const partialEl = overlay.querySelector('.tws-talk-partial');
	const errEl = overlay.querySelector('.tws-talk-error');
	const nameEl = overlay.querySelector('.tws-talk-name');
	const cloneBtn = overlay.querySelector('.tws-talk-clone');
	const frameBtn = overlay.querySelector('.tws-talk-frame');
	const frameLabel = frameBtn?.querySelector('.tws-talk-frame-label');
	const emoteBar = overlay.querySelector('.tws-talk-emotes');
	const lipsyncNotice = overlay.querySelector('.tws-talk-lipsync-notice');
	const textbar = overlay.querySelector('.tws-talk-textbar');
	const textInput = overlay.querySelector('.tws-talk-input');
	const walletHintBtn = overlay.querySelector('.tws-talk-wallet-hint');
	const langSel = overlay.querySelector('.tws-talk-lang');
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
			const diag = mouthTarget.describe();
			if (!mouthTarget.hasAnyMouthDriver()) {
				log.warn('[talk] avatar has no mouth morphs, jaw bone, or head fallback. Diagnostics:', diag);
				showLipsyncNotice(lipsyncNotice, 'none');
			} else if (!mouthTarget.hasMouthMorphs() && !mouthTarget.hasJawBone() && mouthTarget.hasHeadFallback()) {
				log.info('[talk] mouth binding (head fallback):', diag);
				showLipsyncNotice(lipsyncNotice, 'head');
			} else {
				log.info('[talk] mouth binding:', diag);
			}
			setStatus(statusEl, 'idle');

			const emotes = scene.getEmoteController();
			if (emotes) {
				await emotes.loadManifest();
				renderEmoteBar(emoteBar, emotes, errEl);
			}
		})
		.catch((err) => {
			showError(errEl, `Could not load avatar: ${err.message}`);
		});

	// Live mic-level meter — drives the hold button's ring from real captured audio
	// (Riva path). rAF runs only while listening so it costs nothing at rest.
	let levelRaf = null;
	const stopLevelMeter = () => {
		if (levelRaf) cancelAnimationFrame(levelRaf);
		levelRaf = null;
		holdBtn.style.setProperty('--tws-mic-level', '0');
	};
	const startLevelMeter = () => {
		stopLevelMeter();
		const tick = () => {
			holdBtn.style.setProperty('--tws-mic-level', controller.micLevel.toFixed(3));
			levelRaf = requestAnimationFrame(tick);
		};
		levelRaf = requestAnimationFrame(tick);
	};

	controller = new TalkController({
		avatar,
		systemPromptFn,
		language: readStoredTalkLanguage(),
		mouthTarget,
		onMessage: (m) => appendTranscript(transcriptEl, m),
		onInterim: (t) => setPartial(partialEl, t),
		onStateChange: (s) => {
			setStatus(statusEl, s);
			if (s === 'listening') startLevelMeter();
			else stopLevelMeter();
			// The interim line belongs to an in-flight utterance; clear it once the
			// turn has moved on to the model or back to rest.
			if (s === 'thinking' || s === 'idle') setPartial(partialEl, '');
		},
		onError: (e) => handleTalkError(e),
	});

	// Route recognition failures: a denied mic or an environment with no recognizer
	// at all degrades to the always-present text input rather than a dead end.
	function handleTalkError(e) {
		showError(errEl, e.message);
		if (e?.code === 'permission-denied' || e?.code === 'no-mic') {
			textInput?.focus();
		} else if (e?.code === 'stt-unavailable') {
			holdBtn.classList.add('tws-talk-hold-disabled');
			holdBtn.setAttribute('aria-disabled', 'true');
			textInput?.focus();
		}
	}

	// ── Conversation language ──────────────────────────────────────────
	// The picker drives all three legs of the loop: what the recognizer listens
	// for, what language the agent answers in, and which voice speaks the reply
	// (a cloned voice speaks every language here; the fallback voice switches to
	// a native one). Options are labelled with the recognizer each language will
	// actually get, so a "type only" language is visible before it is chosen.
	function renderLanguageOptions() {
		if (!langSel) return;
		const current = controller.language;
		langSel.innerHTML = TALK_LANGUAGES.map((l) => {
			const mode = controller.sttModeFor(l.tag);
			const suffix = mode === 'none' ? ' (type only)' : '';
			const label = l.native === l.english ? l.native : `${l.native} · ${l.english}`;
			return `<option value="${l.tag}"${l.tag === current ? ' selected' : ''}>${label}${suffix}</option>`;
		}).join('');
		langSel.value = current;
	}

	// Reflect the recognizer available for the chosen language: no recognizer at
	// all retires the mic button and leads with the text input rather than leaving
	// a button that can only fail.
	function applySttMode() {
		const mode = controller.sttMode;
		const name = talkLanguage(controller.language)?.english || 'this language';
		// Before the probe answers, the mapping is a guess, so never retire the mic
		// button or accuse a language of being unusable on a guess.
		if (!controller.probeSettled) {
			holdBtn.title = `Hold to talk in ${name}`;
			return;
		}
		holdBtn.hidden = mode === 'none';
		if (mode === 'none') {
			textInput?.focus();
			showError(errEl, `Speech input isn't available for ${name} in this browser. Type instead and the avatar still answers out loud.`);
		} else {
			holdBtn.title =
				mode === 'riva'
					? `Hold to talk in ${name}, powered by NVIDIA Riva speech-to-text`
					: `Hold to talk in ${name}`;
		}
	}

	renderLanguageOptions();
	applySttMode();

	langSel?.addEventListener('change', () => {
		const tag = controller.setLanguage(langSel.value);
		storeTalkLanguage(tag);
		hideError(errEl);
		renderLanguageOptions();
		applySttMode();
	});

	// Resolve the speech-to-text path up front (probes the free Riva lane): the
	// probe tells us which languages the free server lane can hear, so the labels
	// and the mic button both settle once it answers.
	controller.prepare().then(() => {
		renderLanguageOptions();
		applySttMode();
	});

	// ── Conversational Wallet (owner-only) ──────────────────────────────
	// Only the owner can move funds — `owner_id` survives in the API response only
	// for the owner (stripped for visitors). With an agent_id we can talk-to-trade.
	let walletCtl = null;
	if (isOwner && avatar.agent_id) {
		const network = avatar.wallet_network === 'devnet' ? 'devnet' : 'mainnet';
		let walletBalance = null;
		refreshWalletBalance(avatar.agent_id, network).then((b) => { walletBalance = b; });

		walletCtl = new WalletIntentController({
			agentId: avatar.agent_id,
			network,
			mountEl: overlay,
			getState: () => ({
				balanceSol: walletBalance,
				history: controller.history.slice(-6),
			}),
			speak: (text) => controller.speakText(text),
			appendTranscript: (role, content) => appendTranscript(transcriptEl, { role, content }),
			onFlourish: () => {
				// Real confirmed tx only — fire the avatar's celebrate flourish (task 07).
				try {
					Promise.resolve(scene.getEmoteController?.()?.play('celebrate')).catch(() => {});
				} catch {}
				// Funds just moved — re-read the balance so the next command is grounded.
				refreshWalletBalance(avatar.agent_id, network).then((b) => { walletBalance = b; });
			},
			onManualFallback: () =>
				showError(errEl, 'Voice trading is offline — open the wallet card on this agent to trade manually.'),
		});
		controller.commandInterceptor = (transcript) => walletCtl.handle(transcript);

		// Discoverable affordance: a one-tap example that drops a starter command into
		// the text box so owners learn the capability exists.
		if (walletHintBtn) {
			walletHintBtn.innerHTML =
				'<span aria-hidden="true">◎</span> Try: “sell half my $THREE” · “tip 0.1 SOL to …”';
			walletHintBtn.hidden = false;
			walletHintBtn.addEventListener('click', () => {
				textInput.value = 'tip 0.05 SOL to ';
				textInput.focus();
			});
		}
	}

	// ── Text input (mic-free path — works for chat and wallet commands) ──
	if (textbar) {
		textbar.addEventListener('submit', (e) => {
			e.preventDefault();
			const text = textInput.value.trim();
			if (!text) return;
			if (controller.state !== 'idle' && controller.state !== 'speaking') return;
			controller.stop();
			textInput.value = '';
			controller.say(text).catch((err) => showError(errEl, err.message));
		});
	}

	// ── Hold-to-talk ───────────────────────────────────────────────────
	const startHold = (ev) => {
		ev.preventDefault();
		if (holdBtn.classList.contains('tws-talk-hold-disabled')) return;
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
	// Keyboard: when the mic button is focused, Space/Enter is press-and-hold
	// (down = listen, up = send). preventDefault suppresses the synthetic click a
	// button would otherwise fire so a single keypress isn't a start+stop in one.
	holdBtn.addEventListener('keydown', (e) => {
		if (e.key !== ' ' && e.key !== 'Enter') return;
		e.preventDefault();
		if (e.repeat) return;
		startHold(e);
	});
	holdBtn.addEventListener('keyup', (e) => {
		if (e.key !== ' ' && e.key !== 'Enter') return;
		e.preventDefault();
		endHold(e);
	});

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
			walletCtl?.dispose();
		} catch {}
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
			<label class="tws-talk-lang-wrap" title="Language you speak. The avatar answers in it, in its own voice">
				<span class="tws-talk-lang-icon" aria-hidden="true">🌐</span>
				<select class="tws-talk-lang" aria-label="Conversation language"></select>
			</label>
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
	<div class="tws-talk-lipsync-notice" hidden role="status"></div>
	<div class="tws-talk-emotes" hidden role="toolbar" aria-label="Emote shortcuts"></div>
	<div class="tws-talk-transcript" aria-live="polite"></div>
	<div class="tws-talk-partial" aria-live="polite" hidden></div>
	<div class="tws-talk-controls">
		<button class="tws-talk-wallet-hint" type="button" hidden></button>
		<button class="tws-talk-hold" type="button" aria-label="Hold to talk">
			<span class="tws-talk-hold-dot"></span>
			<span class="tws-talk-hold-label">Hold to talk</span>
		</button>
		<form class="tws-talk-textbar" autocomplete="off">
			<input class="tws-talk-input" type="text" inputmode="text"
				placeholder="Type a message…" aria-label="Type a message or wallet command" />
			<button class="tws-talk-send" type="submit" aria-label="Send message">↑</button>
		</form>
		<div class="tws-talk-status" data-state="idle">Ready</div>
	</div>
	<div class="tws-talk-error" role="alert" hidden></div>
`;

const STATUS_LABEL = {
	idle: 'Ready',
	listening: 'Listening…',
	transcribing: 'Transcribing…',
	thinking: 'Thinking…',
	speaking: 'Speaking',
};

function setStatus(el, state) {
	if (!el) return;
	el.dataset.state = state;
	el.textContent = STATUS_LABEL[state] || state;
}

// Best-effort SOL balance read to ground the wallet parser ("half my SOL", "max").
// Returns null on any failure — the parser then asks for an explicit amount.
async function refreshWalletBalance(agentId, network) {
	try {
		const r = await fetch(
			`/api/agents/${encodeURIComponent(agentId)}/solana?network=${encodeURIComponent(network)}`,
			{ credentials: 'include' },
		);
		if (!r.ok) return null;
		const j = await r.json();
		return typeof j?.data?.sol === 'number' ? j.data.sol : null;
	} catch {
		return null;
	}
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

// Live (non-final) transcript shown while the user is still speaking. Hidden when
// empty; cleared once the utterance is finalized into a real transcript row.
function setPartial(el, text) {
	if (!el) return;
	const t = String(text || '').trim();
	if (!t) {
		el.hidden = true;
		el.textContent = '';
		return;
	}
	el.textContent = t;
	el.hidden = false;
	el.scrollIntoView?.({ block: 'nearest' });
}

function appendTranscript(el, msg) {
	if (!el) return;
	const row = document.createElement('div');
	row.className = `tws-talk-msg tws-talk-msg-${msg.role}`;
	row.textContent = msg.content;
	el.appendChild(row);
	el.scrollTop = el.scrollHeight;
}

function hideError(el) {
	if (!el) return;
	el.hidden = true;
	el.textContent = '';
}

// Conversation-language preference. Per browser, not per avatar: someone who
// talks to their agents in Mandarin does so with all of them, and re-picking the
// language on every avatar page would be the worst part of the feature.
const LANG_STORAGE_KEY = 'tws_talk_language';

function readStoredTalkLanguage() {
	try {
		return localStorage.getItem(LANG_STORAGE_KEY) || '';
	} catch {
		return ''; // private mode / storage blocked, so fall back to detection
	}
}

function storeTalkLanguage(tag) {
	try {
		localStorage.setItem(LANG_STORAGE_KEY, tag);
	} catch {
		// Storage blocked: the choice still applies for this session.
	}
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

function showLipsyncNotice(el, level) {
	if (!el) return;
	if (level === 'head') {
		el.dataset.level = 'limited';
		el.innerHTML =
			'<span class="tws-lipsync-icon" aria-hidden="true">◐</span>' +
			'<span class="tws-lipsync-text">Limited lip sync — this avatar has no mouth blend shapes. Using subtle head motion as a fallback.</span>';
	} else {
		el.dataset.level = 'none';
		el.innerHTML =
			'<span class="tws-lipsync-icon" aria-hidden="true">○</span>' +
			'<span class="tws-lipsync-text">No lip sync — this avatar\'s model doesn\'t include mouth shapes or a jaw bone. Voice will still play normally.</span>';
	}
	el.hidden = false;
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
		radial-gradient(ellipse at 70% 80%, rgba(255,255,255,0.04), transparent 50%),
		#050505;
	color: #fafafa;
	font-family: 'Inter', system-ui, sans-serif;
	display: grid;
	grid-template-rows: auto 1fr auto auto auto auto;
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
.tws-talk-lang-wrap {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.14);
	border-radius: 999px;
	padding: 5px 10px 5px 12px;
	transition: background 0.15s, border-color 0.15s;
	flex-shrink: 0;
}
.tws-talk-lang-wrap:hover, .tws-talk-lang-wrap:focus-within {
	background: rgba(255,255,255,0.10);
	border-color: rgba(255,255,255,0.25);
}
.tws-talk-lang-icon { font-size: 12px; line-height: 1; }
.tws-talk-lang {
	appearance: none;
	background: transparent;
	border: 0;
	color: #fafafa;
	font-family: inherit;
	font-size: 12px;
	font-weight: 600;
	padding: 2px 2px;
	cursor: pointer;
	max-width: 150px;
}
.tws-talk-lang:focus-visible { outline: 2px solid #7c5cff; outline-offset: 3px; border-radius: 4px; }
.tws-talk-lang option { background: #131316; color: #fafafa; }
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
.tws-talk-hold:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.tws-talk-hold-disabled { opacity: 0.4; cursor: not-allowed; }
.tws-talk-hold-disabled:hover { transform: none; }
.tws-talk-hold-dot {
	display: inline-block; width: 10px; height: 10px; border-radius: 999px;
	background: #ef4444;
	transition: transform 0.2s;
}
.tws-talk-hold-active {
	background: #ef4444; color: #fff;
	/* Ring expands with the live captured mic level (--tws-mic-level, 0..1). */
	box-shadow: 0 0 0 calc(5px + var(--tws-mic-level, 0) * 18px) rgba(239,68,68,0.18);
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
.tws-talk-wallet-hint {
	background: rgba(139,92,246,0.1);
	border: 1px solid rgba(139,92,246,0.28);
	color: rgba(196,181,253,0.95);
	font-family: inherit; font-size: 11.5px; font-weight: 600;
	padding: 6px 13px; border-radius: 999px; cursor: pointer;
	max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	transition: background 0.15s, border-color 0.15s, transform 0.1s;
}
.tws-talk-wallet-hint:hover { background: rgba(139,92,246,0.18); border-color: rgba(139,92,246,0.45); transform: translateY(-1px); }
.tws-talk-wallet-hint:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.tws-talk-textbar {
	display: flex; align-items: center; gap: 8px;
	width: min(440px, 100%);
}
.tws-talk-input {
	flex: 1; min-width: 0;
	background: rgba(255,255,255,0.05);
	border: 1px solid rgba(255,255,255,0.14);
	color: #fafafa; font-family: inherit; font-size: 14px;
	padding: 10px 14px; border-radius: 999px;
	transition: border-color 0.15s, background 0.15s;
}
.tws-talk-input::placeholder { color: #71717a; }
.tws-talk-input:focus { outline: none; border-color: rgba(139,92,246,0.5); background: rgba(255,255,255,0.08); }
.tws-talk-send {
	flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
	background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
	color: #fafafa; font-size: 17px; line-height: 1; cursor: pointer;
	transition: background 0.15s, border-color 0.15s, transform 0.1s;
}
.tws-talk-send:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.28); transform: translateY(-1px); }
.tws-talk-send:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.tws-talk-status {
	font-size: 11px;
	letter-spacing: 0.08em; text-transform: uppercase;
	color: #71717a;
	transition: color 0.2s;
}
.tws-talk-status[data-state="listening"]    { color: #f43f5e; }
.tws-talk-status[data-state="transcribing"] { color: #7dd3fc; }
.tws-talk-status[data-state="thinking"]     { color: #ffffff; }
.tws-talk-status[data-state="speaking"]     { color: #34d399; }
.tws-talk-partial {
	padding: 2px 24px 6px;
	font-size: 14px; line-height: 1.45;
	color: #cbd5e1; font-style: italic;
	text-align: right;
	overflow-wrap: anywhere;
	animation: tws-notice-in 160ms ease-out;
}
.tws-talk-error {
	position: absolute; left: 50%; bottom: 100px;
	transform: translateX(-50%);
	background: rgba(244,63,94,0.14);
	border: 1px solid rgba(244,63,94,0.4);
	color: #fda4af;
	padding: 8px 14px; border-radius: 10px;
	font-size: 13px;
}
.tws-talk-lipsync-notice {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0 24px;
	padding: 10px 14px;
	border-radius: 10px;
	font-size: 13px;
	line-height: 1.45;
	animation: tws-notice-in 300ms ease-out;
}
@keyframes tws-notice-in {
	from { opacity: 0; transform: translateY(-4px); }
	to   { opacity: 1; transform: translateY(0); }
}
.tws-talk-lipsync-notice[data-level="limited"] {
	background: rgba(250,204,21,0.08);
	border: 1px solid rgba(250,204,21,0.22);
	color: rgba(253,224,71,0.9);
}
.tws-talk-lipsync-notice[data-level="none"] {
	background: rgba(161,161,170,0.08);
	border: 1px solid rgba(161,161,170,0.18);
	color: rgba(161,161,170,0.9);
}
.tws-lipsync-icon {
	flex-shrink: 0;
	font-size: 16px;
	line-height: 1;
}
.tws-lipsync-text {
	min-width: 0;
}
@media (max-width: 600px) {
	.tws-talk-header { padding: 12px 16px 0; }
	.tws-talk-lipsync-notice { margin: 0 16px; padding: 8px 12px; font-size: 12px; }
	.tws-talk-transcript { padding: 8px 16px; max-height: 120px; }
	.tws-talk-partial { padding: 2px 16px 6px; }
	.tws-talk-controls { padding: 12px 16px 20px; }
	.tws-talk-hold { padding: 12px 22px; font-size: 14px; }
}
`;
