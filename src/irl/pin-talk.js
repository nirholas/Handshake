// src/irl/pin-talk.js: talk to the agent you just walked up to.
//
// Discovery on /irl already delivers the moment: an agent standing at a real
// spot, breathing, turning to look at you. The inspect sheet then offered a bio,
// a pay button and a one-way "leave a message". The thing a person actually
// wants to do when they walk up to an AI in the street is TALK to it, and that
// was the one thing missing. This module adds a live, spoken conversation to the
// pin sheet for ANY discovered agent, yours or a stranger's:
//
//   hold the mic (or type)  ->  /api/chat, in the agent's own persona when the pin
//   carries an agent identity  ->  the reply is spoken through the agent's voice
//   (cloned when it has one, the platform lane otherwise)  ->  the standing 3D
//   model's mouth moves from the FFT of that audio, on top of its running idle.
//
// The whole loop is the same TalkController that powers talk mode on
// /avatars/:id (src/voice/talk-controller.js): mic capture, server or browser
// speech recognition, the streamed chat, TTS routing, and lipsync. Nothing is
// re-implemented here; this file owns only the sheet UI and the pin-specific
// prompt. irl.js supplies the mounted model (for the mouth) and hears about each
// turn (for the interaction log + the ambient reaction other viewers see).
//
// Two pure helpers are exported for tests: talkAvatarRecord() decides which
// identity the chat is keyed on, and pinPersonaPrompt() writes the fallback
// persona for a pin with no stored one.

import { TalkController } from '../voice/talk-controller.js';
import { AvatarMouthTarget } from '../voice/avatar-morph-target.js';
import { log } from '../shared/log.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT = 500;
const MAX_LOG_LINES = 60;

const STATE_COPY = {
	idle: '',
	listening: 'Listening…',
	transcribing: 'Got it…',
	thinking: 'Thinking…',
	speaking: 'Speaking',
};

/**
 * The avatar record TalkController keys the conversation on. A pin bound to an
 * agent identity chats AS that agent: /api/chat loads its published persona and
 * memories by `agentId`, and the voice lookup finds its cloned voice. An anonymous
 * pin (a device-token placement with no identity) gets a deliberately non-UUID id
 * so the controller never sends a bogus `agentId`; the persona then comes from
 * pinPersonaPrompt() via system_prompt.
 * @param {{ id?: string, agent_id?: string|null, avatar_name?: string }} pin
 */
export function talkAvatarRecord(pin) {
	const agentId = typeof pin?.agent_id === 'string' && UUID_RE.test(pin.agent_id) ? pin.agent_id : null;
	const name = (typeof pin?.avatar_name === 'string' && pin.avatar_name.trim()) || 'Agent';
	if (agentId) return { id: agentId, agent_id: agentId, name };
	return { id: `irl-pin:${pin?.id || 'anonymous'}`, name };
}

/**
 * Fallback persona for the chat when the pin has no stored persona (anonymous
 * pins, or an identity whose persona is not published). Grounds the model in the
 * one fact that makes IRL different from every other chat surface: a person is
 * physically standing in front of it. Replies are kept short because they are
 * spoken aloud outdoors. When the server has a real persona for `agentId` it
 * takes precedence over this text (api/chat.js), which is the intended order.
 * @param {{ avatar_name?: string, caption?: string }} pin
 * @param {{ agent?: { name?: string, bio?: string } } | null} [card] /api/irl/agent-card payload
 */
export function pinPersonaPrompt(pin, card = null) {
	const name = (card?.agent?.name || pin?.avatar_name || 'Agent').toString().trim().slice(0, 60);
	const caption = typeof pin?.caption === 'string' ? pin.caption.trim().slice(0, 200) : '';
	const bio = typeof card?.agent?.bio === 'string' ? card.agent.bio.trim().slice(0, 400) : '';
	const lines = [
		`You are ${name}, a 3D AI agent standing at a real place in the physical world through three.ws IRL.`,
		'A person has walked up to you in person and is talking to you through their phone camera, where they can see you standing in front of them.',
	];
	if (caption) lines.push(`The placard next to you reads: "${caption}".`);
	if (bio) lines.push(`About you: ${bio}`);
	lines.push(
		`Speak in first person as ${name}. Keep every reply to one to three short sentences, because it is spoken aloud outdoors.`,
		'Be warm and present: react to being met in person, be curious about where they are standing and what they can see.',
		'Never claim to be a human. If asked what you are, say you are an AI agent a three.ws creator placed here, and that anyone can create and pin their own agent at three.ws/irl.',
	);
	return lines.join('\n');
}

/**
 * Wire the talk panel inside the pin sheet.
 *
 * @param {object} deps
 * @param {(pin: object) => import('three').Object3D|null} deps.getModel  The pin's
 *   mounted skinned model (null while it is still a dot/impostor); polled again
 *   before each reply so a model that streams in mid-conversation still gets lips.
 * @param {(pin: object, info: { first: boolean }) => void} [deps.onTurn]  Fired for
 *   every user turn; `first` marks the opening line of a conversation.
 * @param {(pin: object, open: boolean) => void} [deps.onOpenChange]  Fired when the
 *   panel opens for a pin or closes, so the host can keep that pin's full model
 *   resident while the conversation lasts.
 */
export function initPinTalk({ getModel, onTurn, onOpenChange } = {}) {
	const $ = (id) => document.getElementById(id);
	const panel = $('irl-talk');
	const toggleBtn = $('irl-sheet-talk');
	const logEl = $('irl-talk-log');
	const partialEl = $('irl-talk-partial');
	const holdBtn = $('irl-talk-hold');
	const form = $('irl-talk-form');
	const input = $('irl-talk-input');
	const sendBtn = $('irl-talk-send');
	const stateEl = $('irl-talk-state');

	// The sheet shell is static HTML; a page that lacks it (an embed, a test
	// fixture) gets an inert API rather than a crash on every tap.
	const inert = { open() {}, toggle() {}, close() {}, setCard() {}, isOpen: () => false, isOpenFor: () => false };
	if (!panel || !toggleBtn || !logEl || !holdBtn || !form || !input || !stateEl) return inert;

	let pin = null;          // the pin the live conversation belongs to
	let card = null;         // its /api/irl/agent-card payload, once loaded
	let cardPinId = null;    // which pin `card` describes (it can arrive before open)
	let controller = null;   // TalkController for `pin`
	let mouth = null;        // AvatarMouthTarget bound to the pin's model
	let turns = 0;           // user turns in this conversation
	let holding = false;
	let levelRaf = 0;
	let voiceUnavailable = false;

	const reducedMotion = () => {
		try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
	};

	function pinName() {
		return card?.agent?.name || pin?.avatar_name || 'this agent';
	}

	function setState(text, { error = false } = {}) {
		stateEl.textContent = text || '';
		stateEl.classList.toggle('is-error', !!error && !!text);
		stateEl.hidden = !text;
	}

	function renderEmpty() {
		logEl.innerHTML = '';
		const empty = document.createElement('p');
		empty.className = 'irl-talk-empty';
		empty.textContent = voiceUnavailable
			? `${pinName()} is listening. Type something to start.`
			: `${pinName()} is listening. Hold the mic and speak, or type.`;
		logEl.appendChild(empty);
	}

	function appendLine(role, text) {
		logEl.querySelector('.irl-talk-empty')?.remove();
		const line = document.createElement('div');
		line.className = `irl-talk-msg ${role === 'user' ? 'is-user' : 'is-agent'}`;
		if (role !== 'user') {
			const who = document.createElement('span');
			who.className = 'irl-talk-who';
			who.textContent = pinName();
			line.appendChild(who);
		}
		const body = document.createElement('span');
		body.className = 'irl-talk-text';
		body.textContent = text;
		line.appendChild(body);
		logEl.appendChild(line);
		while (logEl.children.length > MAX_LOG_LINES) logEl.firstElementChild.remove();
		logEl.scrollTo({ top: logEl.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
	}

	// Lips: bind the pin's mounted model when we have it. A far pin is a dot or an
	// impostor until the host promotes it, so this is retried right before each
	// reply instead of assumed at open.
	function attachMouth() {
		if (!mouth || !pin) return;
		const model = typeof getModel === 'function' ? getModel(pin) : null;
		if (!model || mouth._irlBoundTo === model) return;
		mouth.attach(model);
		mouth._irlBoundTo = model;
	}

	function stopLevelMeter() {
		if (levelRaf) cancelAnimationFrame(levelRaf);
		levelRaf = 0;
		holdBtn.style.setProperty('--irl-mic-level', '0');
	}

	function startLevelMeter() {
		stopLevelMeter();
		const tick = () => {
			if (!controller) return;
			holdBtn.style.setProperty('--irl-mic-level', controller.micLevel.toFixed(3));
			levelRaf = requestAnimationFrame(tick);
		};
		levelRaf = requestAnimationFrame(tick);
	}

	function onControllerState(state) {
		setState(STATE_COPY[state] ?? '');
		panel.dataset.state = state;
		const busy = state === 'thinking' || state === 'transcribing' || state === 'speaking';
		if (sendBtn) sendBtn.disabled = busy;
		holdBtn.classList.toggle('is-busy', busy);
		if (state === 'thinking') attachMouth();
		if (state !== 'listening') {
			holdBtn.classList.remove('is-active');
			stopLevelMeter();
		}
	}

	function onControllerError(err) {
		const code = err?.code;
		if (code === 'stt-unavailable' || code === 'permission-denied' || code === 'capture-failed') {
			voiceUnavailable = true;
			holdBtn.hidden = true;
			setState(err.message || 'Voice input is not available here. Type your message instead.', { error: true });
			if (!logEl.querySelector('.irl-talk-msg')) renderEmpty();
			input.focus();
			return;
		}
		if (code === 'no-speech') { setState(err.message, { error: true }); return; }
		log.warn('[irl-talk]', err?.message || err);
		setState(err?.message ? `Couldn't reach ${pinName()}: ${err.message}` : `Couldn't reach ${pinName()}. Try again.`, { error: true });
	}

	function onControllerMessage(msg) {
		if (!msg?.content) return;
		if (msg.role === 'user') {
			appendLine('user', msg.content);
			const first = turns === 0;
			turns += 1;
			try { onTurn?.(pin, { first }); } catch (e) { log.warn('[irl-talk] onTurn', e?.message || e); }
			return;
		}
		appendLine('agent', msg.content);
	}

	function teardownController() {
		stopLevelMeter();
		holding = false;
		holdBtn.classList.remove('is-active', 'is-busy');
		if (controller) {
			try { controller.stop(); } catch (e) { log.warn('[irl-talk] stop', e?.message || e); }
			controller = null;
		}
		if (mouth) {
			try { mouth.dispose(); } catch { /* already detached */ }
			mouth = null;
		}
		partialEl.textContent = '';
		partialEl.hidden = true;
		panel.dataset.state = 'idle';
		setState('');
	}

	function buildController() {
		mouth = new AvatarMouthTarget();
		attachMouth();
		controller = new TalkController({
			avatar: talkAvatarRecord(pin),
			systemPromptFn: () => pinPersonaPrompt(pin, card),
			mouthTarget: mouth,
			onMessage: onControllerMessage,
			onStateChange: onControllerState,
			onInterim: (partial) => {
				partialEl.textContent = partial || '';
				partialEl.hidden = !partial;
			},
			onError: onControllerError,
		});
		// Probe which recognizer this browser + language can use; hide the mic
		// only when neither the server lane nor the browser can hear anything.
		controller.prepare().then((mode) => {
			if (controller && mode === 'none') {
				voiceUnavailable = true;
				holdBtn.hidden = true;
				if (!logEl.querySelector('.irl-talk-msg')) renderEmpty();
			}
		}).catch(() => { /* prepare() never rejects in practice; the mic falls back per turn */ });
	}

	function open(nextPin) {
		if (!nextPin) return;
		const samePin = pin && nextPin.id === pin.id && controller;
		if (!samePin) {
			teardownController();
			pin = nextPin;
			if (cardPinId !== pin.id) { card = null; cardPinId = null; }
			turns = 0;
			voiceUnavailable = false;
			holdBtn.hidden = false;
			renderEmpty();
			buildController();
		}
		panel.hidden = false;
		toggleBtn.setAttribute('aria-expanded', 'true');
		toggleBtn.classList.add('is-active');
		try { onOpenChange?.(pin, true); } catch (e) { log.warn('[irl-talk] onOpenChange', e?.message || e); }
		// Voice-first on a phone: the mic is the primary control, so focus lands
		// there for keyboard users; the input stays one tab away.
		if (voiceUnavailable) input.focus({ preventScroll: true });
		else holdBtn.focus({ preventScroll: true });
		requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
	}

	// Hide the panel and stop the audio, keeping the pin so a re-open within the
	// same sheet visit resumes the same conversation (history intact).
	function collapse() {
		panel.hidden = true;
		toggleBtn.setAttribute('aria-expanded', 'false');
		toggleBtn.classList.remove('is-active');
		if (controller) {
			try { controller.hush(); } catch { /* nothing playing */ }
			if (holding) { holding = false; controller.stopListening(); }
			stopLevelMeter();
			holdBtn.classList.remove('is-active');
		}
	}

	// Full close: the sheet went away or a different pin was tapped.
	function close() {
		const hadPin = pin;
		collapse();
		teardownController();
		if (hadPin) {
			try { onOpenChange?.(hadPin, false); } catch (e) { log.warn('[irl-talk] onOpenChange', e?.message || e); }
		}
		pin = null;
		card = null;
		cardPinId = null;
		turns = 0;
		logEl.innerHTML = '';
	}

	function toggle(nextPin) {
		if (!panel.hidden && pin && nextPin?.id === pin.id) { collapse(); return; }
		open(nextPin);
	}

	// ── Hold to talk ────────────────────────────────────────────────────────────
	function startHold(e) {
		if (holdBtn.hidden || !controller || holding) return;
		if (e?.type === 'touchstart') e.preventDefault();
		if (controller.state !== 'idle') {
			// Barge-in: pressing the mic while the agent is speaking cuts it off and
			// starts listening, the way a real conversation interrupts.
			if (controller.state === 'speaking') controller.hush();
			else return;
		}
		holding = true;
		partialEl.textContent = '';
		partialEl.hidden = true;
		const started = controller.startListening();
		if (!started) { holding = false; return; }
		holdBtn.classList.add('is-active');
		startLevelMeter();
	}

	function endHold() {
		if (!holding || !controller) return;
		holding = false;
		holdBtn.classList.remove('is-active');
		stopLevelMeter();
		controller.stopListening();
	}

	holdBtn.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.pointerType !== 'mouse') startHold(e); });
	holdBtn.addEventListener('pointerup', endHold);
	holdBtn.addEventListener('pointercancel', endHold);
	holdBtn.addEventListener('pointerleave', endHold);
	// iOS Safari fires a synthetic long-press callout on a held button; owning
	// touchstart (with the CSS touch-action/callout guards) keeps the hold clean.
	holdBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
	holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
	holdBtn.addEventListener('keydown', (e) => {
		if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(e); }
	});
	holdBtn.addEventListener('keyup', (e) => {
		if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endHold(); }
	});

	// ── Typed turn ──────────────────────────────────────────────────────────────
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		if (!controller) return;
		const text = input.value.trim().slice(0, MAX_INPUT);
		if (!text) return;
		if (controller.state === 'speaking') controller.hush();
		if (controller.state !== 'idle') return;
		input.value = '';
		controller.say(text).catch((err) => onControllerError(err));
	});

	return {
		open,
		toggle,
		close,
		/** Feed the loaded agent card so the persona + display name are richer than the pin row. */
		setCard(nextCard, forPin) {
			if (forPin && pin && forPin.id !== pin.id) return;
			card = nextCard || null;
			cardPinId = forPin?.id ?? pin?.id ?? null;
			const who = logEl.querySelectorAll('.irl-talk-who');
			who.forEach((el) => { el.textContent = pinName(); });
			const empty = logEl.querySelector('.irl-talk-empty');
			if (empty) renderEmpty();
		},
		isOpen: () => !panel.hidden,
		isOpenFor: (p) => !panel.hidden && !!pin && !!p && p.id === pin.id,
	};
}
