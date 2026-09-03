// three.ws Drive: the agent, in the car.
//
// One page, four panels. On CarPlay and Android Auto the car screen belongs to
// the platform (a voice template, an indicator, four buttons), so this page
// runs on the phone and mirrors its state out through src/drive/bridge.js. On a
// head unit browser or a phone in a cradle this page IS the whole surface.
//
// The loop underneath is the platform's existing one, unchanged: mic → /api/asr
// (NVIDIA Riva, with the browser recognizer as the fallback lane) → /api/chat
// → /api/tts → lipsync on a real rigged avatar. What /drive adds is everything
// that makes it safe and usable at 70 mph: one glanceable line instead of a
// transcript, four controls instead of a UI, a keyboard that disappears when
// the wheels turn, and a local command layer that answers "stop talking"
// without a round trip.
//
// Docs: docs/carplay.md. Native shell: ios/native/App/App/CarPlaySceneDelegate.swift.

import { TalkScene } from '../voice/talk-scene.js';
import { AvatarMouthTarget } from '../voice/avatar-morph-target.js';
import { TalkController } from '../voice/talk-controller.js';
import { detectSurface, surfaceProfile, applySurface } from './surface.js';
import { createBridge } from './bridge.js';
import { createDriveInterceptor } from './commands.js';
import { watchMotion } from './motion.js';
import { log } from '../shared/log.js';

const STORE_COPILOT = 'twx_drive_copilot';
const STORE_LIGHT = 'twx_drive_light';
const STORE_HANDS = 'twx_drive_hands';

const STATUS = {
	idle: 'Ready',
	listening: 'Listening',
	transcribing: 'Hearing you',
	thinking: 'Thinking',
	speaking: 'Speaking',
};

// Hands-free voice activity, on the Riva lane where we own the raw audio.
// Below this level for QUIET_MS after speech has been detected ends the turn;
// TURN_CAP_MS stops a stuck-open mic from streaming the whole commute.
const SPEECH_LEVEL = 0.06;
const QUIET_MS = 1100;
const TURN_CAP_MS = 15000;
const REARM_MS = 650;

const el = (id) => document.getElementById(id);

const ui = {
	root: el('dr'),
	stage: el('dr-stage'),
	name: el('dr-name'),
	status: el('dr-status'),
	motion: el('dr-motion'),
	light: el('dr-light'),
	swap: el('dr-swap'),
	heard: el('dr-heard'),
	said: el('dr-said'),
	fault: el('dr-fault'),
	faultText: el('dr-fault-text'),
	faultFix: el('dr-fault-fix'),
	actHands: el('dr-act-hands'),
	actRepeat: el('dr-act-repeat'),
	actStop: el('dr-act-stop'),
	actType: el('dr-act-type'),
	talk: el('dr-talk'),
	picker: el('dr-picker'),
	pickerClose: el('dr-picker-close'),
	pickerGrid: el('dr-picker-grid'),
	pickerSub: el('dr-picker-sub'),
	type: el('dr-type'),
	typeClose: el('dr-type-close'),
	typeForm: el('dr-type-form'),
	typeInput: el('dr-type-input'),
};

let profile = null;
let bridge = null;
let scene = null;
let mouth = null;
let controller = null;
let motionWatch = null;
let copilot = null;
let lastReply = '';
let handsFree = false;
let moving = true;
let motionSource = 'none';
let holding = false;
let rearmTimer = 0;
let vadRaf = 0;
let levelRaf = 0;
let vadSpokeAt = 0;
let vadQuietSince = 0;
let vadStartedAt = 0;

// ── small helpers ────────────────────────────────────────────────────────────

function readStore(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStore(key, value) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// A locked-down web view without storage still drives fine; it just
		// forgets the choice between trips.
	}
}

function setFault(message, fix) {
	if (!message) {
		ui.fault.hidden = true;
		ui.faultFix.hidden = true;
		ui.faultFix.onclick = null;
		return;
	}
	ui.faultText.textContent = message;
	ui.fault.hidden = false;
	if (fix?.label && typeof fix.run === 'function') {
		ui.faultFix.textContent = fix.label;
		ui.faultFix.hidden = false;
		ui.faultFix.onclick = fix.run;
	} else {
		ui.faultFix.hidden = true;
		ui.faultFix.onclick = null;
	}
	bridge?.error(fix?.code || 'drive', message);
}

function setStatus(text) {
	ui.status.textContent = text;
}

function setSaid(text) {
	lastReply = String(text || '').trim();
	ui.said.textContent = lastReply;
	ui.actRepeat.disabled = !lastReply;
	pushActions();
	if (lastReply) bridge?.said(lastReply);
}

function setHeard(text) {
	const t = String(text || '').trim();
	ui.heard.textContent = t;
	ui.heard.classList.toggle('is-on', !!t);
	if (t) bridge?.heard(t);
}

// ── the four controls, mirrored to the car screen ────────────────────────────

function pushActions() {
	if (!bridge?.attached) return;
	bridge.actions([
		{ id: 'talk', label: holding || controller?.state === 'listening' ? 'Stop' : 'Talk', enabled: !!controller },
		{ id: 'hands', label: handsFree ? 'Hands free on' : 'Hands free', enabled: !!controller },
		{ id: 'repeat', label: 'Repeat', enabled: !!lastReply },
		{ id: 'hush', label: 'Quiet', enabled: controller?.state === 'speaking' },
	]);
}

// ── day / night ──────────────────────────────────────────────────────────────

function applyLight(on) {
	document.documentElement.setAttribute('data-drive-light', on ? '1' : '0');
	ui.light.textContent = on ? 'Day' : 'Night';
	ui.light.setAttribute('aria-pressed', on ? 'true' : 'false');
	writeStore(STORE_LIGHT, on ? '1' : '0');
}

function lightOn() {
	return document.documentElement.getAttribute('data-drive-light') === '1';
}

// ── parked / driving ─────────────────────────────────────────────────────────

function applyMotion(next) {
	moving = next;
	ui.motion.textContent = moving ? 'Driving' : 'Parked';
	ui.motion.setAttribute('aria-pressed', moving ? 'true' : 'false');
	ui.motion.title = moving
		? 'Driving locks the keyboard. Switch to Parked to type.'
		: 'Parked. The keyboard is available.';
	// Typing is only ever offered on a panel that has a reachable keyboard, and
	// only when the car is not moving.
	const typable = profile?.keyboard && !moving;
	ui.actType.hidden = !profile?.keyboard;
	ui.actType.disabled = !typable;
	if (moving && !ui.type.hidden) closeType();
}

// ── the voice loop ───────────────────────────────────────────────────────────

function systemPrompt() {
	const name = copilot?.name || 'the agent';
	return [
		`You are ${name}, riding in a moving car with the person you are talking to.`,
		'This is a spoken conversation on a car display. Reply in one or two short sentences that sound right out loud.',
		'Never ask them to read anything, tap through a list, or look at the screen.',
		'Never produce markdown, bullet points, code, links, or emoji.',
		'If something genuinely needs a screen, say you will have it waiting when they park.',
		'If you are not sure what they said over road noise, ask one short clarifying question.',
	].join(' ');
}

function stopVad() {
	if (vadRaf) cancelAnimationFrame(vadRaf);
	vadRaf = 0;
	vadSpokeAt = 0;
	vadQuietSince = 0;
	vadStartedAt = 0;
}

// Hands-free turn end. The browser recognizer ends its own turn on silence, so
// this only runs on the Riva lane, where the raw level is ours to read.
function startVad() {
	stopVad();
	if (controller?.sttMode !== 'riva') return;
	vadStartedAt = performance.now();
	const tick = () => {
		if (!controller || controller.state !== 'listening') {
			stopVad();
			return;
		}
		const now = performance.now();
		const level = controller.micLevel;
		if (level >= SPEECH_LEVEL) {
			vadSpokeAt = now;
			vadQuietSince = 0;
		} else if (vadSpokeAt) {
			if (!vadQuietSince) vadQuietSince = now;
			if (now - vadQuietSince >= QUIET_MS) {
				stopVad();
				controller.stopListening();
				return;
			}
		}
		if (now - vadStartedAt >= TURN_CAP_MS) {
			stopVad();
			controller.stopListening();
			return;
		}
		vadRaf = requestAnimationFrame(tick);
	};
	vadRaf = requestAnimationFrame(tick);
}

function stopLevelMeter() {
	if (levelRaf) cancelAnimationFrame(levelRaf);
	levelRaf = 0;
	ui.talk.style.setProperty('--dr-mic', '0');
}

function startLevelMeter() {
	stopLevelMeter();
	const tick = () => {
		ui.talk.style.setProperty('--dr-mic', controller.micLevel.toFixed(3));
		levelRaf = requestAnimationFrame(tick);
	};
	levelRaf = requestAnimationFrame(tick);
}

function clearRearm() {
	if (rearmTimer) clearTimeout(rearmTimer);
	rearmTimer = 0;
}

function maybeRearm() {
	clearRearm();
	if (!handsFree || !controller) return;
	if (document.hidden || !ui.type.hidden || !ui.picker.hidden) return;
	rearmTimer = setTimeout(() => {
		rearmTimer = 0;
		if (!handsFree || !controller || controller.state !== 'idle') return;
		beginListening();
	}, REARM_MS);
}

function beginListening() {
	if (!controller) return;
	setFault('');
	const started = controller.startListening();
	if (started && handsFree) startVad();
	pushActions();
}

function endListening() {
	stopVad();
	controller?.stopListening();
	pushActions();
}

function setHandsFree(on) {
	handsFree = !!on;
	ui.actHands.setAttribute('aria-pressed', handsFree ? 'true' : 'false');
	ui.actHands.textContent = handsFree ? 'Hands free · on' : 'Hands free';
	if (profile?.remembersHandsFree) writeStore(STORE_HANDS, handsFree ? '1' : '0');
	if (handsFree && controller?.state === 'idle') maybeRearm();
	if (!handsFree) {
		clearRearm();
		stopVad();
	}
	pushActions();
}

function hush() {
	clearRearm();
	stopVad();
	controller?.hush();
	pushActions();
}

function repeat() {
	if (!lastReply || !controller) return;
	controller.speakText(lastReply);
}

function nudgeVolume(delta) {
	if (!controller) return;
	const next = controller.setVolume(controller.volume + delta);
	setStatus(`Volume ${Math.round(next * 100)}%`);
	setTimeout(() => {
		if (controller?.state === 'idle') setStatus(STATUS.idle);
	}, 1400);
}

const interceptor = createDriveInterceptor({
	repeat,
	hush,
	louder: () => nudgeVolume(0.2),
	quieter: () => nudgeVolume(-0.2),
	night: () => applyLight(false),
	day: () => applyLight(true),
	parked: () => applyMotion(false),
	driving: () => applyMotion(true),
});

function onTalkError(err) {
	const code = err?.code || '';
	if (code === 'stt-unavailable' || code === 'mic-denied' || err?.name === 'NotAllowedError') {
		setFault(
			profile?.keyboard
				? 'No microphone here. Park and use the keyboard instead.'
				: 'No microphone here. Grant microphone access to this app and try again.',
			profile?.keyboard ? { label: 'Type', run: openType, code } : null,
		);
		return;
	}
	setFault(err?.message || 'Something went wrong. Hold Talk to try again.', {
		label: 'Retry',
		run: () => {
			setFault('');
			beginListening();
		},
		code: code || 'talk',
	});
}

// Never leave a rig standing in bind pose. Most avatars here ship no clip of
// their own, so the shared retargeted library (idle, wave, and the rest) is what
// makes the copilot look alive; a rig it genuinely cannot drive simply stays
// still rather than throwing.
async function ensureMotion() {
	const emotes = scene?.getEmoteController();
	if (!emotes) return;
	try {
		await emotes.loadManifest();
		if (!scene.playingClip) await scene.playEmote('idle');
	} catch (err) {
		log.warn('[drive] idle motion unavailable:', err?.message);
	}
}

/** A hello as the trip starts, settling straight back into idle. */
function greet() {
	scene?.playEmoteOnce('wave', { settleTo: 'idle' }).catch(() => {});
}

// ── session ──────────────────────────────────────────────────────────────────

async function startSession(avatar) {
	copilot = avatar;
	ui.name.textContent = avatar.name || 'Your agent';
	setStatus('Loading');
	setFault('');

	if (scene) {
		scene.unmount();
		scene = null;
	}
	if (controller) {
		controller.stop();
		controller = null;
	}
	mouth?.dispose();

	scene = new TalkScene();
	mouth = new AvatarMouthTarget();

	try {
		await scene.mount({ container: ui.stage, glbUrl: avatar.model_url, cameraPreset: 'half' });
		scene.attachMouthTarget(mouth);
		await ensureMotion();
	} catch (err) {
		setStatus('Ready');
		setFault(`Could not load ${avatar.name || 'that agent'}: ${err.message}`, {
			label: 'Choose another',
			run: () => openPicker(true),
			code: 'model',
		});
		return;
	}

	controller = new TalkController({
		avatar: { id: avatar.id, name: avatar.name, agent_id: avatar.agent_id || null, model_url: avatar.model_url },
		systemPromptFn: systemPrompt,
		mouthTarget: mouth,
		commandInterceptor: interceptor,
		onMessage: (m) => {
			if (m.role === 'user') setHeard(m.content);
			else setSaid(m.content);
		},
		onInterim: (t) => setHeard(t),
		onStateChange: (state) => {
			ui.root.dataset.state = state;
			setStatus(STATUS[state] || state);
			ui.actStop.disabled = state !== 'speaking';
			if (state === 'listening') startLevelMeter();
			else stopLevelMeter();
			if (state === 'idle') maybeRearm();
			bridge?.state(state);
			pushActions();
		},
		onError: onTalkError,
	});

	await controller.prepare().catch(() => {});
	ui.talk.disabled = false;
	setStatus(STATUS.idle);
	writeStore(
		STORE_COPILOT,
		JSON.stringify({
			id: avatar.id,
			name: avatar.name,
			model_url: avatar.model_url,
			agent_id: avatar.agent_id || null,
		}),
	);
	bridge?.ready({ id: avatar.id, name: avatar.name });
	greet();
	pushActions();
	if (handsFree) maybeRearm();
}

// ── choosing a copilot ───────────────────────────────────────────────────────

async function fetchAvatar(id) {
	const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
	if (!r.ok) throw new Error(r.status === 404 ? 'That agent no longer exists.' : `Could not load that agent (${r.status}).`);
	const j = await r.json();
	const a = j?.avatar || j;
	const modelUrl = a?.model_url || a?.url;
	if (!modelUrl) throw new Error('That agent has no 3D model yet.');
	return { id: a.id, name: a.name || 'Your agent', model_url: modelUrl, agent_id: a.agent_id || null };
}

async function listChoices() {
	try {
		const mine = await fetch('/api/avatars?limit=24', { credentials: 'include' });
		if (mine.ok) {
			const j = await mine.json();
			if (Array.isArray(j?.avatars) && j.avatars.length) return { avatars: j.avatars, owned: true };
		}
	} catch (err) {
		log.warn('[drive] own avatars unavailable:', err?.message);
	}
	const featured = await fetch('/api/avatars/featured?limit=24');
	if (!featured.ok) throw new Error(`Could not load agents (${featured.status}).`);
	const j = await featured.json();
	return { avatars: j?.avatars || [], owned: false };
}

function skeletons(n) {
	ui.pickerGrid.replaceChildren();
	for (let i = 0; i < n; i += 1) {
		const s = document.createElement('div');
		s.className = 'dr-skel';
		ui.pickerGrid.append(s);
	}
}

function renderChoices({ avatars, owned }) {
	ui.pickerGrid.replaceChildren();
	ui.pickerSub.textContent = owned
		? 'Pick the agent that rides with you. It keeps its voice, its face, and its memory in the car.'
		: 'These are public agents anyone can ride with. Sign in to bring your own.';

	if (!avatars.length) {
		const empty = document.createElement('div');
		empty.className = 'dr-empty';
		const line = document.createElement('span');
		line.textContent = 'No agents yet. Build one in a couple of minutes and it will be waiting here.';
		const link = document.createElement('a');
		link.className = 'dr-link';
		link.href = '/create';
		link.textContent = 'Create an agent';
		empty.append(line, link);
		ui.pickerGrid.append(empty);
		return;
	}

	for (const a of avatars) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'dr-card';
		const img = document.createElement('img');
		img.src = `/api/avatars/${encodeURIComponent(a.id)}/thumb`;
		img.alt = '';
		img.loading = 'lazy';
		img.decoding = 'async';
		const name = document.createElement('span');
		name.className = 'dr-card-name';
		name.textContent = a.name || 'Untitled agent';
		card.append(img, name);
		card.addEventListener('click', () => void pick(a.id, card));
		ui.pickerGrid.append(card);
	}
}

async function pick(id, card) {
	if (card) card.disabled = true;
	try {
		const avatar = await fetchAvatar(id);
		closePicker();
		await startSession(avatar);
	} catch (err) {
		if (card) card.disabled = false;
		setFault(err.message, null);
		ui.picker.hidden = false;
	}
}

async function openPicker(dismissable) {
	ui.picker.hidden = false;
	ui.pickerClose.hidden = !dismissable && !copilot;
	clearRearm();
	skeletons(8);
	try {
		renderChoices(await listChoices());
	} catch (err) {
		ui.pickerGrid.replaceChildren();
		const empty = document.createElement('div');
		empty.className = 'dr-empty';
		const line = document.createElement('span');
		line.textContent = err.message;
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'dr-pill';
		retry.textContent = 'Try again';
		retry.addEventListener('click', () => void openPicker(dismissable));
		empty.append(line, retry);
		ui.pickerGrid.append(empty);
	}
}

function closePicker() {
	ui.picker.hidden = true;
	if (handsFree) maybeRearm();
}

// ── typing (parked only) ─────────────────────────────────────────────────────

function openType() {
	if (!profile?.keyboard || moving) return;
	clearRearm();
	ui.type.hidden = false;
	ui.typeInput.focus();
}

function closeType() {
	ui.type.hidden = true;
	if (handsFree) maybeRearm();
}

// ── wiring ───────────────────────────────────────────────────────────────────

function wire() {
	// Hold to talk. Pointer events cover mouse, touch, and a resistive head unit
	// panel in one path; the capture keeps the release ours even if the finger
	// slides off the button on a bump.
	ui.talk.addEventListener('pointerdown', (e) => {
		if (ui.talk.disabled) return;
		holding = true;
		ui.talk.setPointerCapture?.(e.pointerId);
		beginListening();
	});
	const release = () => {
		if (!holding) return;
		holding = false;
		if (!handsFree) endListening();
		else pushActions();
	};
	ui.talk.addEventListener('pointerup', release);
	ui.talk.addEventListener('pointercancel', release);
	ui.talk.addEventListener('lostpointercapture', release);

	// Keyboard parity: space is push to talk, escape is barge-in.
	window.addEventListener('keydown', (e) => {
		if (e.repeat || e.target instanceof HTMLInputElement) return;
		if (e.code === 'Space') {
			e.preventDefault();
			if (!holding && controller?.state === 'idle') {
				holding = true;
				beginListening();
			}
		} else if (e.key === 'Escape') {
			if (!ui.type.hidden) closeType();
			else if (!ui.picker.hidden && copilot) closePicker();
			else hush();
		}
	});
	window.addEventListener('keyup', (e) => {
		if (e.code === 'Space' && holding) {
			e.preventDefault();
			release();
		}
	});

	ui.actHands.addEventListener('click', () => setHandsFree(!handsFree));
	ui.actRepeat.addEventListener('click', repeat);
	ui.actStop.addEventListener('click', hush);
	ui.actType.addEventListener('click', openType);
	ui.swap.addEventListener('click', () => void openPicker(true));
	ui.light.addEventListener('click', () => applyLight(!lightOn()));
	ui.motion.addEventListener('click', () => {
		// A live speed signal outranks the button: the driver cannot declare
		// themselves parked while the wheels are turning.
		if (motionSource === 'gps' && moving) {
			setStatus('Moving');
			setTimeout(() => setStatus(STATUS[controller?.state || 'idle'] || 'Ready'), 1400);
			return;
		}
		applyMotion(!moving);
	});
	ui.pickerClose.addEventListener('click', closePicker);
	ui.typeClose.addEventListener('click', closeType);
	ui.typeForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = ui.typeInput.value.trim();
		if (!text || !controller) return;
		ui.typeInput.value = '';
		closeType();
		controller.say(text).catch(onTalkError);
	});

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			clearRearm();
			stopVad();
		} else if (handsFree) {
			maybeRearm();
		}
	});

	window.addEventListener('pagehide', () => {
		motionWatch?.stop();
		controller?.stop();
		scene?.unmount();
		bridge?.dispose();
	});
}

function onNativeCommand(cmd) {
	switch (cmd.type) {
		case 'talk-start':
			beginListening();
			break;
		case 'talk-stop':
			endListening();
			break;
		case 'talk':
			if (controller?.state === 'listening') endListening();
			else beginListening();
			break;
		case 'hands':
			setHandsFree(!handsFree);
			break;
		case 'repeat':
			repeat();
			break;
		case 'hush':
			hush();
			break;
		case 'say':
			if (typeof cmd.value === 'string') controller?.say(cmd.value).catch(onTalkError);
			break;
		default:
			log.warn('[drive] unknown native command:', cmd.type);
	}
}

async function boot() {
	profile = surfaceProfile(detectSurface());
	applySurface(profile);
	bridge = createBridge(onNativeCommand);

	applyLight(readStore(STORE_LIGHT) === '1');
	applyMotion(true);
	if (profile.remembersHandsFree) setHandsFree(readStore(STORE_HANDS) === '1');
	else setHandsFree(false);

	wire();
	ui.talk.disabled = true;

	motionWatch = watchMotion(({ moving: isMoving, source }) => {
		motionSource = source;
		if (source === 'gps') applyMotion(isMoving);
	});

	const params = new URLSearchParams(location.search);
	const asked = params.get('avatar') || params.get('agent');
	if (asked) {
		try {
			await startSession(await fetchAvatar(asked));
			return;
		} catch (err) {
			setFault(err.message, { label: 'Choose an agent', run: () => void openPicker(false), code: 'avatar' });
		}
	}

	const saved = readStore(STORE_COPILOT);
	if (saved) {
		try {
			const parsed = JSON.parse(saved);
			if (parsed?.id && parsed?.model_url) {
				await startSession(parsed);
				return;
			}
		} catch {
			writeStore(STORE_COPILOT, null);
		}
	}

	await openPicker(false);
}

boot().catch((err) => {
	log.error('[drive] boot failed:', err);
	setStatus('Offline');
	setFault(`Drive could not start: ${err.message}`, { label: 'Reload', run: () => location.reload(), code: 'boot' });
});
