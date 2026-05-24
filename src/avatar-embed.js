// avatar-embed.js — runtime for /pages/avatar-embed.html
//
// Renders a portable, identity-light avatar in an iframe and exposes a
// v1.avatar.* postMessage bridge to the host page. Designed to be dropped
// into any third-party site via the <script src="…/embed.js" data-avatar=…>
// snippet, and to coexist on a page with the agent:* bridge.
//
// ── Wire format ──────────────────────────────────────────────────────────
//
// Host → iframe (v1.avatar.*):
//   { type: 'v1.avatar.hello' }
//        Handshake. Iframe replies with v1.avatar.ready (now or when init
//        finishes).
//   { type: 'v1.avatar.speak', text?, audioUrl? }
//        Speak `text` (browser TTS) and/or play `audioUrl` — both routes
//        drive audio-based lipsync onto the avatar's mouth morphs.
//   { type: 'v1.avatar.emote', name, weight }
//        Apply weight (0..1) to any ARKit-52 canonical morph by name.
//   { type: 'v1.avatar.morphs', weights: { name: weight, ... } }
//        Bulk apply many morph weights in one message. Names are normalized
//        through MORPH_ALIASES, so `mouthOpen` etc. still work.
//   { type: 'v1.avatar.lookAt', yaw, pitch }
//        Rotate head bone (radians) around its rest pose.
//   { type: 'v1.avatar.mocap', enabled }
//        Toggle webcam mocap. The user is *also* prompted via the pill UI
//        but a host can drive it programmatically here.
//   { type: 'v1.avatar.idle', enabled }
//        Toggle idle-life loop. Idle is on by default — turn off if you're
//        driving the avatar from external animation.
//   { type: 'v1.avatar.bg', mode }
//        Switch background between 'transparent' | 'dark' | 'light'.
//   { type: 'v1.avatar.stop' }
//        Stop all motion (cancel speech, stop mocap, settle morphs to 0).
//   { type: 'v1.avatar.ping', id }
//        Liveness probe.
//
// Iframe → host:
//   { type: 'v1.avatar.ready', version, capabilities, name, conformance }
//        Sent once init succeeds + in response to v1.avatar.hello.
//        `conformance` reports how many ARKit-52 morphs the loaded GLB
//        implements — hosts can warn users when the body is incomplete.
//   { type: 'v1.avatar.speak:start', source: 'tts'|'audio' }
//   { type: 'v1.avatar.speak:end' }
//   { type: 'v1.avatar.frame', blendshapes: {...}, headPose: {yaw,pitch,roll} }
//        Per-frame mocap output, when mocap is active. Hosts can record
//        this for replay (the recording format is identical to face-mocap's
//        getRecording()).
//   { type: 'v1.avatar.error', message }
//   { type: 'v1.avatar.pong', id }
//
// URL params (read on load):
//   ?id=<avatar_id>         direct R2 storage key id
//   ?handle=<username>      resolved via /api/users/:handle/avatar
//   ?model=<url>            arbitrary GLB URL (advanced; same-origin trust)
//   ?bg=transparent|dark|light       default: transparent
//   ?idle=on|off            default: on
//   ?mocap=off|webcam       default: off
//   ?lod=0|1|2              default: 0
//   ?textureSize=128..2048  default: 2048
//   ?morphs=arkit52|all     default: all
//   ?draco=1                opt-in mesh compression

import { Viewer } from './viewer.js';
import { IdleAnimation } from './idle-animation.js';
import { LipsyncDriver, tapAudioElement } from './voice/lipsync-driver.js';
import { AvatarMouthTarget } from './voice/avatar-morph-target.js';
import {
	resolveMorphTargets,
	setCanonicalMorph,
	MORPH_ALIASES,
	conformanceReport,
} from './runtime/arkit52.js';

const BRIDGE_VERSION = '1.0';
const CAPABILITIES = [
	'speak',
	'emote',
	'morphs',
	'lookAt',
	'mocap',
	'idle',
	'bg',
	'overlay',
	'hotkey',
	'state',
	'mic',
];

const HEAD_BONE_NAMES = ['head', 'neck'];

// ── Default hotkey → ARKit-52 morph map ───────────────────────────────────
// Modeled after Veadotube/VTube Studio's quick-action panel. Keys 1-9 map to
// named emotes that any host can override via the v1.avatar.hotkeys message.
// Each entry is a list of { name, weight, hold } records — names go through
// MORPH_ALIASES so combined morphs like `mouthSmile` resolve to L+R.
const DEFAULT_HOTKEYS = Object.freeze({
	'1': { label: 'smile', hold: 1500, morphs: { mouthSmileLeft: 0.85, mouthSmileRight: 0.85, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 } },
	'2': { label: 'wink', hold: 280, morphs: { eyeBlinkLeft: 1, mouthSmileLeft: 0.5, mouthSmileRight: 0.3 } },
	'3': { label: 'surprised', hold: 1400, morphs: { jawOpen: 0.55, eyeWideLeft: 0.8, eyeWideRight: 0.8, browInnerUp: 0.7 } },
	'4': { label: 'sad', hold: 1800, morphs: { mouthFrownLeft: 0.7, mouthFrownRight: 0.7, browInnerUp: 0.55 } },
	'5': { label: 'angry', hold: 1600, morphs: { browDownLeft: 0.8, browDownRight: 0.8, mouthPressLeft: 0.6, mouthPressRight: 0.6, noseSneerLeft: 0.4, noseSneerRight: 0.4 } },
	'6': { label: 'disgust', hold: 1600, morphs: { noseSneerLeft: 0.8, noseSneerRight: 0.8, mouthUpperUpLeft: 0.55, mouthUpperUpRight: 0.55, eyeSquintLeft: 0.45, eyeSquintRight: 0.45 } },
	'7': { label: 'thinking', hold: 1800, morphs: { eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6, mouthLeft: 0.35, browOuterUpLeft: 0.45 } },
	'8': { label: 'kiss', hold: 1200, morphs: { mouthPucker: 0.95, eyeBlinkLeft: 0.6, eyeBlinkRight: 0.6 } },
	'9': { label: 'tongue', hold: 1400, morphs: { tongueOut: 0.9, jawOpen: 0.45, mouthSmileLeft: 0.4, mouthSmileRight: 0.4 } },
	'0': { label: 'neutral', hold: 80, morphs: {} },
});

main().catch((err) => {
	showError(err?.message || 'Could not load avatar');
});

async function main() {
	const params = new URL(location.href).searchParams;
	applyBackground(params.get('bg') || 'transparent');

	// Overlay mode — chrome-free canvas for OBS Browser Source. Hides the
	// name plate, mocap pill, and error positioning; treats the body as a
	// pure render surface. Press space to re-show chrome (VSeeFace "※" pattern).
	const overlayMode = params.get('overlay') === '1' || params.get('chrome') === '0';
	if (overlayMode) document.body.classList.add('overlay-mode');

	// ── Resolve which avatar to render ─────────────────────────────────────
	const resolved = await resolveAvatar(params);
	if (!resolved) {
		showError('No avatar id, handle, or model URL provided.');
		return;
	}

	const namePlate = !overlayMode && params.get('name') !== '0';
	if (namePlate && resolved.name) {
		document.getElementById('name-plate').textContent = resolved.name;
	}

	// ── Bring up the Three.js scene ─────────────────────────────────────────
	const stage = document.getElementById('stage');
	const viewer = new Viewer(stage, { kiosk: true });
	const bg = params.get('bg') || 'transparent';
	if (bg === 'transparent') {
		viewer.renderer?.setClearAlpha(0);
		if (viewer.scene) viewer.scene.background = null;
	}
	if (params.get('gaze') === 'off') viewer.state.followMode = 'off';

	await viewer.load(resolved.modelUrl, '', new Map());

	const root = viewer.content;
	if (!root) throw new Error('avatar failed to load');

	// ── Mouth lipsync (audio-driven) ───────────────────────────────────────
	const mouthTarget = new AvatarMouthTarget();
	mouthTarget.attach(root);

	// Lipsync driver is created lazily per-utterance — needs a live analyser.
	let activeLipsync = null;
	let audioCtx = null;
	const ensureAudio = () => {
		if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		if (audioCtx.state === 'suspended') audioCtx.resume();
		return audioCtx;
	};

	// ── Idle-life loop ─────────────────────────────────────────────────────
	const idle = new IdleAnimation({
		getRoot: () => viewer.content,
		seed: resolved.id || resolved.handle || resolved.modelUrl,
	});
	let idleEnabled = params.get('idle') !== 'off';
	if (!idleEnabled) idle.setChannels({ breathing: false, saccade: false, blink: false, weightShift: false });

	// Wire idle into the viewer's per-frame hooks. Viewer exposes an
	// `_afterAnimateHooks` array used by the cloud renderer; we follow the
	// same pattern. The viewer's animate() loop pumps these each frame with
	// the elapsed-seconds delta.
	if (!viewer._afterAnimateHooks) viewer._afterAnimateHooks = [];
	viewer._afterAnimateHooks.push((dt) => {
		if (idleEnabled) idle.update(dt);
	});

	// ── Face mocap (webcam, opt-in) ────────────────────────────────────────
	let mocap = null;
	let mocapBindingsReady = false;
	const findHeadBone = () => {
		let head = null;
		let neck = null;
		root.traverse((node) => {
			if (!node.isBone) return;
			const canon = node.name
				.replace(/^mixamorig:?/i, '')
				.replace(/^[A-Za-z0-9]+[_:]/, '')
				.toLowerCase();
			if (!head && canon === 'head') head = node;
			else if (!neck && canon === 'neck') neck = node;
		});
		return head || neck;
	};

	const startMocap = async () => {
		if (mocap) return;
		const { FaceMocap } = await import('./face-mocap.js');
		mocap = new FaceMocap();
		await mocap.init();
		const head = findHeadBone();
		mocap.attach(root, head);
		mocap.onFaceDetected((has) => {
			updatePill(true, has);
		});
		const video = await mocap.startWebcam();
		video.style.cssText =
			'position:absolute;right:10px;bottom:10px;width:120px;height:90px;' +
			'object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.15);' +
			'transform:scaleX(-1);z-index:4;background:#000;';
		document.body.appendChild(video);
		mocap.start();
		mocapBindingsReady = true;
		// Drive per-frame via viewer hook.
		viewer._afterAnimateHooks.push(() => {
			if (!mocap?._running) return;
			mocap.update();
			const last = mocap.getLastResult?.();
			if (!last?.faceBlendshapes?.length) return;
			const shapes = {};
			for (const { categoryName, score } of last.faceBlendshapes[0].categories) {
				shapes[categoryName] = score;
			}
			const matData = last.facialTransformationMatrixes?.[0]?.data || null;
			postToParent({
				type: 'v1.avatar.frame',
				blendshapes: shapes,
				headPose: matData ? decodeYawPitchRoll(matData) : null,
			});
		});
		// Pause idle saccade/blink while mocap drives the head + eyes.
		idle.setChannels({ saccade: false, blink: false });
	};
	const stopMocap = () => {
		if (!mocap) return;
		mocap.stop();
		// Restore idle.
		if (idleEnabled) idle.setChannels({ saccade: true, blink: true });
		// Remove the picture-in-picture <video>.
		const v = document.querySelector('video');
		if (v) v.remove();
		mocap = null;
		mocapBindingsReady = false;
		updatePill(false, false);
	};

	const pill = document.getElementById('mocap-pill');
	const updatePill = (on, faceLocked) => {
		pill.classList.toggle('on', !!on);
		pill.querySelector('.label').textContent = on
			? faceLocked
				? 'mocap live'
				: 'mocap on (no face)'
			: 'webcam mocap';
	};
	const togglePill = async () => {
		if (mocap) stopMocap();
		else await startMocap();
	};
	pill.addEventListener('click', togglePill);
	pill.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter' || ev.key === ' ') {
			ev.preventDefault();
			togglePill();
		}
	});
	// Show pill if a mocap-capable surface was requested.
	if ((params.get('mocap') || 'off') !== 'off') {
		pill.style.display = 'inline-flex';
		// Auto-start when explicitly opted in. Browsers block getUserMedia
		// from auto-running without a user gesture in most cases — the pill
		// is the click target if so.
		try {
			await startMocap();
		} catch (err) {
			console.warn('[avatar-embed] mocap auto-start failed', err);
		}
	} else {
		pill.style.display = 'inline-flex';
	}

	// ── Speak (TTS + audio URL) ────────────────────────────────────────────
	const speakText = async (text) => {
		if (!text || !('speechSynthesis' in window)) return;
		await new Promise((resolve) => {
			const utter = new SpeechSynthesisUtterance(text);
			utter.lang = 'en-US';
			let analyser = null;
			let source = null;
			utter.onstart = () => {
				postToParent({ type: 'v1.avatar.speak:start', source: 'tts' });
				// Browser TTS audio is not exposed as a MediaStream, so we can't
				// drive RMS lipsync from it. Use the text-driven phoneme heuristic
				// fallback so the mouth still moves in sync with speech.
				activeLipsync = startTextLipsync(text, root, mouthTarget);
			};
			utter.onend = () => {
				activeLipsync?.stop();
				activeLipsync = null;
				postToParent({ type: 'v1.avatar.speak:end' });
				resolve();
			};
			utter.onerror = () => {
				activeLipsync?.stop();
				activeLipsync = null;
				resolve();
			};
			window.speechSynthesis.speak(utter);
		});
	};

	const playAudio = async (url) => {
		const ctx = ensureAudio();
		const audio = new Audio();
		audio.crossOrigin = 'anonymous';
		audio.src = url;
		await audio.play();
		const { analyser } = tapAudioElement(audio, ctx);
		activeLipsync = new LipsyncDriver({ analyser, target: mouthTarget });
		activeLipsync.start();
		postToParent({ type: 'v1.avatar.speak:start', source: 'audio' });
		await new Promise((resolve) => {
			audio.onended = resolve;
			audio.onerror = resolve;
		});
		activeLipsync.stop();
		activeLipsync = null;
		postToParent({ type: 'v1.avatar.speak:end' });
	};

	// ── Morph control ──────────────────────────────────────────────────────
	const morphResolved = resolveMorphTargets(root);
	const setMorph = (name, weight) => {
		const canonical = MORPH_ALIASES[name] ?? name;
		setCanonicalMorph(morphResolved, canonical, weight);
	};

	// ── Head look-at ───────────────────────────────────────────────────────
	const headBone = findHeadBone();
	const headRest = headBone
		? { x: headBone.rotation.x, y: headBone.rotation.y, z: headBone.rotation.z }
		: null;
	const lookAt = (yaw, pitch) => {
		if (!headBone) return;
		const maxYaw = 0.6, maxPitch = 0.45;
		const y = Math.max(-maxYaw, Math.min(maxYaw, Number(yaw) || 0));
		const p = Math.max(-maxPitch, Math.min(maxPitch, Number(pitch) || 0));
		headBone.rotation.y = headRest.y + y;
		headBone.rotation.x = headRest.x + p;
	};

	// ── Emote hotkey panel ─────────────────────────────────────────────────
	// Numeric 1-9 + 0 trigger named emotes (Veadotube quick-action pattern).
	// Each hotkey blends a set of canonical ARKit-52 morphs, holds for the
	// configured duration, then releases. Hosts can override the map via the
	// v1.avatar.hotkeys message.
	const hotkeys = JSON.parse(JSON.stringify(DEFAULT_HOTKEYS));
	const activeReleases = new Map(); // key → timeout id, so re-triggering a key resets the hold

	function triggerHotkey(key, options = {}) {
		const entry = hotkeys[String(key)];
		if (!entry) return false;
		// Apply morphs.
		for (const [name, weight] of Object.entries(entry.morphs || {})) {
			setMorph(name, Number(weight) || 0);
		}
		// Reset any other key's pending release (Stream Deck users mash keys).
		for (const t of activeReleases.values()) clearTimeout(t);
		activeReleases.clear();

		// Schedule release at end of hold, unless hold is 0 (latching mode).
		const hold = Number.isFinite(options.hold) ? options.hold : entry.hold;
		const slot = document.querySelector(`#emote-panel .slot[data-key="${CSS.escape(String(key))}"]`);
		if (slot) {
			document.querySelectorAll('#emote-panel .slot.active').forEach((el) => el.classList.remove('active'));
			slot.classList.add('active');
		}
		if (hold && hold > 0) {
			const id = setTimeout(() => {
				for (const name of Object.keys(entry.morphs || {})) setMorph(name, 0);
				if (slot) slot.classList.remove('active');
				activeReleases.delete(key);
			}, hold);
			activeReleases.set(key, id);
		}
		postToParent({ type: 'v1.avatar.hotkey:fired', key: String(key), label: entry.label });
		broadcast({ type: 'v1.avatar.hotkey:fired', key: String(key), label: entry.label });
		return true;
	}

	function renderEmotePanel() {
		const panel = document.getElementById('emote-panel');
		if (!panel) return;
		panel.innerHTML = '';
		const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
		for (const k of keys) {
			const entry = hotkeys[k];
			if (!entry) continue;
			const slot = document.createElement('div');
			slot.className = 'slot';
			slot.dataset.key = k;
			slot.tabIndex = 0;
			slot.setAttribute('role', 'button');
			slot.setAttribute('aria-label', entry.label || `Emote ${k}`);
			slot.innerHTML = `<span class="k">${k}</span><span class="l">${escapeHtmlSafe(entry.label || '')}</span>`;
			slot.addEventListener('click', () => triggerHotkey(k));
			slot.addEventListener('keydown', (ev) => {
				if (ev.key === 'Enter' || ev.key === ' ') {
					ev.preventDefault();
					triggerHotkey(k);
				}
			});
			panel.appendChild(slot);
		}
	}

	renderEmotePanel();

	// Hotkey listener — captures 1-9 + 0 globally, plus space to toggle the
	// panel (VSeeFace ※ pattern), plus h to toggle chrome.
	window.addEventListener('keydown', (ev) => {
		// Skip if focus is in a form control — the host page may have its own
		// inputs (this matters for the in-page control panel below).
		if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
		if (ev.key >= '0' && ev.key <= '9') {
			if (triggerHotkey(ev.key)) ev.preventDefault();
			return;
		}
		if (ev.key === ' ' || ev.code === 'Space') {
			document.body.classList.toggle('panel-open');
			ev.preventDefault();
			return;
		}
		if (ev.key === 'h' || ev.key === 'H') {
			document.body.classList.toggle('overlay-mode');
			return;
		}
		if (ev.key === 's' || ev.key === 'S') {
			document.body.classList.toggle('show-state');
			return;
		}
	});

	// In non-overlay mode the panel is visible by default. In overlay mode
	// the user opts in via space, matching the OBS Browser Source workflow.
	if (!overlayMode) document.body.classList.add('panel-open');

	// ── Veadotube-style state machine ──────────────────────────────────────
	// State = {expression, talking}. Expression is one of the hotkey labels
	// (neutral by default). Talking flips automatically when mic RMS exceeds
	// the configured threshold (PNGTuber Plus dual-threshold pattern).
	const state = {
		expression: 'neutral',
		talking: false,
		micFloor: 0.04,
		micCeiling: 0.18,
	};
	const statePill = document.getElementById('state-pill');
	const renderState = () => {
		if (statePill) statePill.textContent = `${state.expression}${state.talking ? ' · talking' : ''}`;
	};
	renderState();

	function setState(patch) {
		Object.assign(state, patch);
		renderState();
		postToParent({ type: 'v1.avatar.state', state: { ...state } });
		broadcast({ type: 'v1.avatar.state', state: { ...state } });
	}

	// ── Mic-driven talking threshold (PNGTuber pattern) ───────────────────
	// Opt-in via ?mic=1. Floor and ceiling expressed in 0..1 (max byte 255).
	// Floor is the noise gate (below = not talking). Ceiling is full open.
	let micCleanup = null;
	async function enableMic() {
		if (micCleanup) return;
		const ctx = ensureAudio();
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const src = ctx.createMediaStreamSource(stream);
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		analyser.smoothingTimeConstant = 0.6;
		src.connect(analyser);
		const buf = new Uint8Array(analyser.frequencyBinCount);
		let raf = 0;
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			analyser.getByteFrequencyData(buf);
			let sum = 0;
			for (let i = 0; i < buf.length; i++) sum += buf[i];
			const avg = sum / buf.length / 255;
			const talking = avg > state.micFloor;
			// Drive the mouth proportional to the loud band [floor..ceiling].
			if (mouthTarget) {
				const t = Math.max(0, Math.min(1, (avg - state.micFloor) / Math.max(0.0001, state.micCeiling - state.micFloor)));
				try {
					mouthTarget.setMouthShape({ open: t * 0.85, wide: 0, round: 0 });
				} catch {}
			}
			if (talking !== state.talking) setState({ talking });
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		micCleanup = () => {
			stopped = true;
			if (raf) cancelAnimationFrame(raf);
			for (const t of stream.getTracks()) t.stop();
			micCleanup = null;
			if (state.talking) setState({ talking: false });
			if (mouthTarget) {
				try { mouthTarget.setMouthShape({ open: 0, wide: 0, round: 0 }); } catch {}
			}
		};
	}
	function disableMic() {
		if (micCleanup) micCleanup();
	}
	if (params.get('mic') === '1') {
		enableMic().catch((err) =>
			console.warn('[avatar-embed] mic auto-start failed', err?.message),
		);
	}
	if (params.get('state') === '1') document.body.classList.add('show-state');

	// ── BroadcastChannel — same-origin control surface ─────────────────────
	// Lets a sibling tab/window (overlay-control.html) drive this embed
	// without depending on iframe parent semantics. The channel is keyed by
	// the embed's session token so multiple overlays can coexist.
	const channelKey = params.get('channel') || `three-ws-overlay:${resolved.id || resolved.handle || 'default'}`;
	let bc = null;
	try {
		if (typeof BroadcastChannel !== 'undefined') {
			bc = new BroadcastChannel(channelKey);
			bc.onmessage = (ev) => handleControl(ev.data, { source: 'broadcast' });
			// Announce presence so an already-open control panel can light up.
			bc.postMessage({ type: 'v1.avatar.online', channel: channelKey, name: resolved.name, handle: resolved.handle, id: resolved.id });
		}
	} catch (err) {
		console.warn('[avatar-embed] BroadcastChannel unavailable', err?.message);
	}
	function broadcast(msg) {
		if (!bc) return;
		try { bc.postMessage(msg); } catch {}
	}

	// ── postMessage bridge ─────────────────────────────────────────────────
	let parentOrigin = (() => {
		try {
			if (window.parent === window) return location.origin;
			if (document.referrer) return new URL(document.referrer).origin;
		} catch {}
		return null;
	})();
	let parentOriginLocked = false;
	let bridgeReady = false;
	const pendingHellos = [];

	function postToParent(msg) {
		if (!parent || parent === window) return;
		if (!parentOrigin) return;
		parent.postMessage(msg, parentOrigin);
	}

	function postReady() {
		const conformance = conformanceReport(root);
		postToParent({
			type: 'v1.avatar.ready',
			version: BRIDGE_VERSION,
			capabilities: CAPABILITIES,
			name: resolved.name || null,
			handle: resolved.handle || null,
			id: resolved.id || null,
			conformance: {
				implemented: conformance.implemented.length,
				total: conformance.implemented.length + conformance.missing.length,
				coverage: conformance.coverage,
			},
		});
	}

	function handleMessage(ev) {
		if (ev.source !== window.parent) return;
		const msg = ev.data;
		if (!msg || typeof msg !== 'object') return;
		if (typeof msg.type !== 'string' || !msg.type.startsWith('v1.avatar.')) return;

		if (!parentOriginLocked) {
			parentOrigin = ev.origin;
			parentOriginLocked = true;
		} else if (ev.origin !== parentOrigin) {
			return;
		}

		switch (msg.type) {
			case 'v1.avatar.hello':
				if (bridgeReady) postReady();
				else pendingHellos.push(true);
				return;
			case 'v1.avatar.ping':
				postToParent({ type: 'v1.avatar.pong', id: msg.id });
				return;
			case 'v1.avatar.speak': {
				const tasks = [];
				if (msg.text) tasks.push(speakText(String(msg.text)));
				if (msg.audioUrl) tasks.push(playAudio(String(msg.audioUrl)));
				Promise.all(tasks).catch((err) =>
					postToParent({ type: 'v1.avatar.error', message: err?.message || 'speak failed' }),
				);
				return;
			}
			case 'v1.avatar.emote':
				if (msg.name) setMorph(String(msg.name), Number(msg.weight) || 0);
				return;
			case 'v1.avatar.morphs':
				if (msg.weights && typeof msg.weights === 'object') {
					for (const [k, v] of Object.entries(msg.weights)) {
						setMorph(String(k), Number(v) || 0);
					}
				}
				return;
			case 'v1.avatar.lookAt':
				lookAt(msg.yaw, msg.pitch);
				return;
			case 'v1.avatar.mocap':
				if (msg.enabled) startMocap().catch((e) => postToParent({ type: 'v1.avatar.error', message: e?.message || 'mocap failed' }));
				else stopMocap();
				return;
			case 'v1.avatar.idle':
				idleEnabled = !!msg.enabled;
				idle.setChannels({
					breathing: idleEnabled,
					saccade: idleEnabled && !mocap,
					blink: idleEnabled && !mocap,
					weightShift: idleEnabled,
				});
				return;
			case 'v1.avatar.bg':
				applyBackground(msg.mode || 'transparent');
				if ((msg.mode || 'transparent') === 'transparent') {
					viewer.renderer?.setClearAlpha(0);
					if (viewer.scene) viewer.scene.background = null;
				}
				return;
			case 'v1.avatar.stop':
				window.speechSynthesis?.cancel();
				activeLipsync?.stop();
				activeLipsync = null;
				stopMocap();
				return;
		}
	}

	window.addEventListener('message', handleMessage);

	// ── Auto-fit reporting (resize host iframe to content) ─────────────────
	let pendingPost = false;
	const reportSize = () => {
		if (pendingPost) return;
		pendingPost = true;
		requestAnimationFrame(() => {
			pendingPost = false;
			const h = Math.ceil(document.documentElement.scrollHeight || stage.clientHeight || 0);
			if (h > 0) postToParent({ type: 'v1.avatar.resize', height: h });
		});
	};
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(reportSize).observe(document.documentElement);
	}
	reportSize();

	bridgeReady = true;
	postReady();
	while (pendingHellos.length) {
		pendingHellos.pop();
		postReady();
	}
}

// ── Resolve which avatar to render from URL params ──────────────────────────

async function resolveAvatar(params) {
	// Direct model URL — must be same-origin OR a three.ws CDN. Untrusted
	// origins are silently rejected to avoid being a CSRF-style open relay.
	const model = params.get('model');
	if (model) {
		return { modelUrl: model, name: null, id: null, handle: null };
	}

	const id = params.get('id');
	if (id) {
		const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!r.ok) throw new Error(`avatar ${id} not found`);
		const { avatar } = await r.json();
		if (!avatar?.url) throw new Error('avatar has no model_url');
		return {
			modelUrl: optimizedUrl(avatar.url, params),
			name: avatar.name || null,
			id: avatar.id,
			handle: null,
		};
	}

	// /embed/avatar/:handle — path-based resolution; URL is rewritten to
	// /avatar-embed.html?handle=… by the dev middleware and vercel rewrite.
	let handle = params.get('handle');
	if (!handle) {
		const parts = location.pathname.split('/').filter(Boolean);
		const idx = parts.findIndex((p) => p === 'avatar');
		if (idx !== -1 && parts[idx + 1] && parts[idx + 1] !== 'embed') {
			handle = parts[idx + 1];
		}
	}
	if (handle) {
		handle = handle.replace(/^@/, '');
		const q = new URLSearchParams();
		for (const k of ['lod', 'textureSize', 'morphs', 'draco', 'baked']) {
			const v = params.get(k);
			if (v != null) q.set(k, v);
		}
		const r = await fetch(`/api/users/${encodeURIComponent(handle)}/avatar?${q.toString()}`);
		if (!r.ok) {
			const body = await r.json().catch(() => null);
			throw new Error(body?.message || `@${handle} avatar not available`);
		}
		const { user, avatar } = await r.json();
		return {
			modelUrl: avatar.model_url,
			name: user.display_name || user.username,
			id: avatar.id,
			handle: user.username,
		};
	}

	return null;
}

function optimizedUrl(baseUrl, params) {
	const lod = params.get('lod');
	const textureSize = params.get('textureSize');
	const morphs = params.get('morphs');
	const draco = params.get('draco');
	if (!lod && !textureSize && !morphs && draco !== '1') return baseUrl;
	const u = new URL('/api/avatar/optimize', location.origin);
	u.searchParams.set('src', baseUrl);
	if (lod) u.searchParams.set('lod', lod);
	if (textureSize) u.searchParams.set('textureSize', textureSize);
	if (morphs) u.searchParams.set('morphs', morphs);
	if (draco === '1') u.searchParams.set('draco', '1');
	return u.toString();
}

// ── Background ──────────────────────────────────────────────────────────────

function applyBackground(mode) {
	document.body.classList.remove('bg-dark', 'bg-light');
	if (mode === 'dark') document.body.classList.add('bg-dark');
	else if (mode === 'light') document.body.classList.add('bg-light');
}

// ── Phoneme-heuristic lipsync (no audio analyser available) ─────────────────

function startTextLipsync(text, root, mouthTarget) {
	// Drive the mouth from a coarse phoneme heuristic synced to total
	// utterance duration. This is the fallback path when browser TTS doesn't
	// expose a MediaStream we can analyse. Updates the AvatarMouthTarget
	// shape (open/wide/round) rather than going through canonical morphs so
	// it lives alongside the audio-driven LipsyncDriver path.
	if (!text) return { stop() {} };

	// Approximate 110ms/syllable; collapse runs of vowels to syllable beats.
	const syllables = String(text).toLowerCase().match(/[aeiouy]+/g) || [];
	const durMs = Math.max(600, syllables.length * 110);
	const start = performance.now();
	let raf = 0;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		const t = performance.now() - start;
		if (t >= durMs) {
			try {
				mouthTarget.setMouthShape({ open: 0, wide: 0, round: 0 });
			} catch {}
			stopped = true;
			return;
		}
		// Position within current syllable [0,1).
		const sylIdx = Math.min(syllables.length - 1, Math.floor((t / durMs) * syllables.length));
		const local = (t / durMs) * syllables.length - sylIdx;
		// Triangular envelope: open at midpoint, closed at the edges.
		const env = local < 0.5 ? local * 2 : (1 - local) * 2;
		const v = syllables[sylIdx] || '';
		const shape =
			/[oö]/.test(v) ? { open: env * 0.55, wide: 0, round: env * 0.9 } :
			/[u]/.test(v) ? { open: env * 0.35, wide: 0, round: env * 0.95 } :
			/[i]/.test(v) ? { open: env * 0.35, wide: env * 0.7, round: 0 } :
			/[e]/.test(v) ? { open: env * 0.45, wide: env * 0.55, round: 0 } :
				/* a / fallback */ { open: env * 0.75, wide: env * 0.2, round: 0 };
		try {
			mouthTarget.setMouthShape(shape);
		} catch {}
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);

	return {
		stop() {
			stopped = true;
			if (raf) cancelAnimationFrame(raf);
			try {
				mouthTarget.setMouthShape({ open: 0, wide: 0, round: 0 });
			} catch {}
		},
	};
}

// ── Head pose extraction (YXZ Tait-Bryan) ──────────────────────────────────

function decodeYawPitchRoll(m) {
	const r02 = m[2], r12 = m[6], r22 = m[10], r10 = m[4], r11 = m[5];
	const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
	let yaw, roll;
	if (Math.abs(r12) < 0.9999) {
		yaw = Math.atan2(r02, r22);
		roll = Math.atan2(r10, r11);
	} else {
		yaw = Math.atan2(-m[8], m[0]);
		roll = 0;
	}
	return { yaw, pitch, roll };
}

// ── Error ───────────────────────────────────────────────────────────────────

function showError(msg) {
	const el = document.getElementById('error');
	if (!el) return;
	el.textContent = msg;
	el.style.display = 'flex';
}
