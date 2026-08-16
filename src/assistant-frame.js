// /assistant-frame — the assistant widget's iframe surface.
//
// Loaded by public/assistant/v1.js inside a floating panel on third-party
// sites (or standalone for testing). One standing 3D avatar + a composer with
// two modes:
//   • Chat  — messages go to an LLM (free platform chain via /api/chat, or
//             the visitor's own Groq/OpenRouter key straight from the
//             browser) and the reply streams into a speech bubble above the
//             avatar's head, optionally spoken aloud.
//   • Speak — the avatar repeats exactly what you typed: speech bubble +
//             Web Speech API audio + talking animation. No model involved.
//
// Query params (every one validated in src/assistant-widget-core.js):
//   ?avatar=<id|url> | ?agent=<id>   which body to load
//   ?bg=transparent|#hex|<preset>|gradient:#a,#b[,angle]
//   ?mode=chat|speak|both            default both (segmented control)
//   ?accent=#hex  ?name=  ?greeting=  ?context=  ?voice=false  ?badge=false
//   ?targetOrigin=<origin>           pins outbound postMessage
//
// Duplicated stage plumbing from src/walk-embed.js on purpose — embeds evolve
// independently so a fix here can't destabilize /walk-embed (same reasoning
// as the header of that file).

import {
	AmbientLight,
	Box3,
	CircleGeometry,
	Color,
	DirectionalLight,
	HemisphereLight,
	Mesh,
	PCFShadowMap,
	PerspectiveCamera,
	PMREMGenerator,
	Scene,
	ShadowMaterial,
	Timer,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { AnimationManager } from './animation-manager.js';
import { log } from './shared/log.js';
import {
	parseBackground,
	normalizeMode,
	normalizeLane,
	sanitizeAccent,
	estimateSpeechMs,
	BYOK_DEFAULT_MODELS,
	BYOK_ENDPOINTS,
} from './assistant-widget-core.js';

const AVATAR_URL_DEFAULT = '/avatars/default.glb';
const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';
const CLIP_TALK = 'av-vtubing';
const CLIP_GREET = 'wave';
const REQUIRED_CLIPS = new Set([CLIP_IDLE, CLIP_TALK, CLIP_GREET]);

const CHANNEL = 'three-assistant';
const PROTOCOL_VERSION = 1;
const STORAGE_KEY = 'threeAssistant.settings.v1';
const MAX_HISTORY_TURNS = 10; // ×2 messages — matches /api/chat's history max of 20

// ── Params ────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const BG = parseBackground(params.get('bg'));
const MODE = normalizeMode(params.get('mode'));
const ACCENT = sanitizeAccent(params.get('accent'));
const NAME = (params.get('name') || 'Assistant').slice(0, 60);
const GREETING = (params.get('greeting') || '').slice(0, 200);
const CONTEXT = (params.get('context') || '').slice(0, 500);
const VOICE_DEFAULT = params.get('voice') !== 'false' && params.get('voice') !== '0';
const SHOW_BADGE = params.get('badge') !== 'false' && params.get('badge') !== '0';
const TARGET_ORIGIN = params.get('targetOrigin') || '*';
const AGENT_PARAM = params.get('agent');
const PREFERS_REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const HAS_HOVER =
	typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

// ── DOM ───────────────────────────────────────────────────────────────────
const rootEl = document.getElementById('assistant-root');
const stageEl = document.getElementById('assistant-stage');
const canvas = document.getElementById('assistant-canvas');
const posterEl = document.getElementById('assistant-poster');
const bubbleEl = document.getElementById('assistant-bubble');
const bubbleTextEl = bubbleEl.querySelector('.bubble-text');
const badgeEl = document.getElementById('assistant-badge');
const statusEl = document.getElementById('assistant-status');
const titleLabelEl = document.querySelector('#assistant-title .label');
const voiceBtn = document.getElementById('assistant-voice-btn');
const settingsBtn = document.getElementById('assistant-settings-btn');
const closeBtn = document.getElementById('assistant-close-btn');
const modesEl = document.getElementById('assistant-modes');
const inputEl = document.getElementById('assistant-input');
const sendBtn = document.getElementById('assistant-send');
const hintTextEl = document.getElementById('assistant-hint-text');
const lanePillEl = document.getElementById('assistant-lane-pill');
const settingsEl = document.getElementById('assistant-settings');
const settingsCloseBtn = document.getElementById('assistant-settings-close');
const byokFieldsEl = document.getElementById('assistant-byok-fields');
const byokKeyEl = document.getElementById('assistant-byok-key');
const byokModelEl = document.getElementById('assistant-byok-model');
const voiceSelectEl = document.getElementById('assistant-voice-select');

// ── Chrome from params ────────────────────────────────────────────────────
document.documentElement.style.setProperty('--accent', ACCENT);
titleLabelEl.textContent = NAME;
if (BG.css) document.body.style.background = BG.css;
if (!SHOW_BADGE) badgeEl.remove();
rootEl.dataset.modeSwitch = String(MODE === 'both');

let activeMode = MODE === 'speak' ? 'speak' : 'chat';

function applyModeChrome() {
	for (const btn of modesEl.querySelectorAll('.mode-btn')) {
		btn.setAttribute('aria-pressed', String(btn.dataset.mode === activeMode));
	}
	if (activeMode === 'speak') {
		inputEl.placeholder = 'Type something for me to say...';
		hintTextEl.textContent = 'I repeat exactly what you type, out loud.';
	} else {
		inputEl.placeholder = 'Type a question...';
		hintTextEl.textContent = CONTEXT ? `Ask anything about ${NAME}.` : 'Ask anything.';
	}
	lanePillEl.hidden = activeMode === 'speak';
}

// ── Settings (persisted per-browser, never sent to the host page) ─────────
function loadSettings() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function saveSettings() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		/* private mode / storage disabled — settings just don't persist */
	}
}

const settings = loadSettings();
settings.lane = normalizeLane(settings.lane);
settings.keys = settings.keys && typeof settings.keys === 'object' ? settings.keys : {};
settings.models = settings.models && typeof settings.models === 'object' ? settings.models : {};

let voiceEnabled = typeof settings.voiceEnabled === 'boolean' ? settings.voiceEnabled : VOICE_DEFAULT;

function laneReady(lane) {
	return lane === 'free' || Boolean(settings.keys[lane]);
}

function effectiveLane() {
	return laneReady(settings.lane) ? settings.lane : 'free';
}

function applyLaneChrome() {
	const lane = effectiveLane();
	lanePillEl.textContent = lane === 'free' ? 'free' : `byok:${lane}`;
	for (const radio of settingsEl.querySelectorAll('input[name="assistant-lane"]')) {
		radio.checked = radio.value === settings.lane;
	}
	const byok = settings.lane !== 'free';
	byokFieldsEl.classList.toggle('is-visible', byok);
	if (byok) {
		byokKeyEl.value = settings.keys[settings.lane] || '';
		byokModelEl.value = settings.models[settings.lane] || BYOK_DEFAULT_MODELS[settings.lane];
		byokKeyEl.placeholder = settings.lane === 'groq' ? 'gsk_...' : 'sk-or-...';
	}
}

function applyVoiceChrome() {
	voiceBtn.setAttribute('aria-pressed', String(voiceEnabled));
	voiceBtn.title = voiceEnabled ? 'Voice on' : 'Voice off';
}

// ── Status pill ───────────────────────────────────────────────────────────
function setStatus(text, { error = false, sticky = false } = {}) {
	statusEl.textContent = text;
	statusEl.classList.toggle('is-error', error);
	statusEl.classList.remove('is-hidden');
	clearTimeout(setStatus._t);
	if (!sticky) setStatus._t = setTimeout(() => statusEl.classList.add('is-hidden'), 2600);
}

// ── postMessage bridge ────────────────────────────────────────────────────
function post(type, payload = {}) {
	if (window.parent === window) return;
	try {
		window.parent.postMessage({ channel: CHANNEL, v: PROTOCOL_VERSION, type, payload }, TARGET_ORIGIN);
	} catch {
		/* host gone mid-navigation */
	}
}

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return;
	if (msg.type === 'say') {
		const text = String(msg.payload?.text || '').slice(0, 600);
		if (text) speakLine(text);
	} else if (msg.type === 'setMode') {
		const mode = normalizeMode(msg.payload?.mode);
		if (MODE === 'both' && (mode === 'chat' || mode === 'speak')) {
			activeMode = mode;
			applyModeChrome();
		}
	}
});

// ── Avatar resolution (same allowlist contract as walk-embed) ─────────────
const AVATAR_HOST_ALLOWLIST = [
	/^([a-z0-9-]+\.)*three\.ws$/i,
	/^([a-z0-9-]+\.)*r2\.cloudflarestorage\.com$/i,
	/^([a-z0-9-]+\.)*r2\.dev$/i,
	/(^|\.)readyplayer\.me$/i,
	/(^|\.)models\.readyplayer\.me$/i,
];
const GLB_PATH_RE = /\.(glb|gltf|vrm)(\?|#|$)/i;

function validateAvatarUrl(raw) {
	if (raw.startsWith('/')) return raw;
	let u;
	try {
		u = new URL(raw, location.origin);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	if (u.origin === location.origin) return u.href;
	if (!AVATAR_HOST_ALLOWLIST.some((re) => re.test(u.hostname))) return null;
	if (!GLB_PATH_RE.test(u.pathname)) return null;
	return u.href;
}

async function resolveAgentAvatarUrl(agentId) {
	const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
		headers: { accept: 'application/json' },
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} resolving agent avatar`);
	const body = await r.json();
	const rec = body?.agent || body;
	const direct = rec?.avatar_model_url || rec?.avatar_glb_url || rec?.glb_url;
	if (typeof direct === 'string' && GLB_PATH_RE.test(direct)) {
		return validateAvatarUrl(direct) || `/api/avatars/${encodeURIComponent(rec.avatar_id)}/glb`;
	}
	if (rec?.avatar_id) return `/api/avatars/${encodeURIComponent(rec.avatar_id)}/glb`;
	return AVATAR_URL_DEFAULT;
}

async function resolveAvatarUrl() {
	const id = params.get('avatar');
	if (id) {
		if (/^https?:\/\//i.test(id) || id.startsWith('/')) {
			const safe = validateAvatarUrl(id);
			if (safe) return safe;
			log.warn('[assistant-frame] rejected ?avatar= URL (origin/host not allowed):', id);
			return AVATAR_URL_DEFAULT;
		}
		return `/api/avatars/${encodeURIComponent(id)}/glb`;
	}
	if (AGENT_PARAM) {
		try {
			return await resolveAgentAvatarUrl(AGENT_PARAM);
		} catch (err) {
			log.warn('[assistant-frame] agent avatar resolve failed, using default:', err?.message || err);
			return AVATAR_URL_DEFAULT;
		}
	}
	return AVATAR_URL_DEFAULT;
}

// ── Renderer / scene ──────────────────────────────────────────────────────
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
if (BG.kind === 'solid') renderer.setClearColor(new Color(BG.css), 1);
else renderer.setClearColor(0x000000, 0); // transparent + gradient: body paints, canvas stays clear
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new AmbientLight(0xffffff, 0.55));
const hemi = new HemisphereLight(0xbcd6ff, 0x202830, 0.6);
hemi.position.set(0, 5, 0);
scene.add(hemi);
const sun = new DirectionalLight(0xffffff, 1.35);
sun.position.set(3, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 25;
sun.shadow.camera.left = -4;
sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4;
sun.shadow.camera.bottom = -4;
sun.shadow.bias = -0.0005;
scene.add(sun);

// Soft shadow blob grounds the avatar on any host background (look2.png).
const shadowCatcher = new Mesh(new CircleGeometry(1.6, 48), new ShadowMaterial({ opacity: 0.3 }));
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

const camera = new PerspectiveCamera(38, 1, 0.05, 100);

function sizeToStage() {
	const w = stageEl.clientWidth || 1;
	const h = stageEl.clientHeight || 1;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}
new ResizeObserver(sizeToStage).observe(stageEl);
sizeToStage();

// ── Avatar + animation ────────────────────────────────────────────────────
const animationManager = new AnimationManager();
let avatar = null;
let avatarHeight = 1.7;
let avatarYaw = 0;
let glance = { active: false, targetYaw: 0 };
const headAnchor = new Vector3();
const GLANCE_MAX_RAD = 0.35;
const GLANCE_LERP = 0.045;

let _loaderPromise = null;
function getAvatarLoader() {
	if (!_loaderPromise) {
		_loaderPromise = getMeshoptDecoder().then((decoder) => {
			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(decoder);
			return loader;
		});
	}
	return _loaderPromise;
}

function frameAvatar() {
	camera.position.set(0, avatarHeight * 0.92, avatarHeight * 2.05);
	camera.lookAt(0, avatarHeight * 0.55, 0);
}

async function loadAvatar() {
	const requestedUrl = await resolveAvatarUrl();
	const loader = await getAvatarLoader();

	let gltf;
	let usedFallback = false;
	try {
		gltf = await loader.loadAsync(requestedUrl);
	} catch (err) {
		if (requestedUrl === AVATAR_URL_DEFAULT) throw err;
		log.warn('[assistant-frame] avatar load failed, falling back to default:', err?.message || err);
		usedFallback = true;
		gltf = await loader.loadAsync(AVATAR_URL_DEFAULT);
	}

	avatar = gltf.scene;
	avatar.traverse((n) => {
		if (n.isMesh) {
			n.castShadow = true;
			n.receiveShadow = false;
			if (n.material && 'envMapIntensity' in n.material) n.material.envMapIntensity = 0.85;
		}
	});
	const box = new Box3().setFromObject(avatar);
	avatar.position.y -= box.min.y;
	avatarHeight = Math.max(0.5, box.max.y - box.min.y);
	scene.add(avatar);
	frameAvatar();

	animationManager.attach(avatar);
	const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
		if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
		return r.json();
	});
	const needed = manifest.filter((d) => REQUIRED_CLIPS.has(d.name));
	if (!needed.some((d) => d.name === CLIP_IDLE)) {
		throw new Error('Animation manifest missing idle clip');
	}
	animationManager.setAnimationDefs(needed);
	await animationManager.loadAll();
	await animationManager.crossfadeTo(CLIP_IDLE, 0.0);

	if (!PREFERS_REDUCED_MOTION && animationManager.supportsCanonicalClips?.() !== false) {
		animationManager.playOnce(CLIP_GREET, { settleTo: CLIP_IDLE, fade: 0.2 });
	}
	if (usedFallback) setStatus("couldn't load that avatar — showing the default", { sticky: true });
	return usedFallback;
}

let talking = false;
function setTalking(on) {
	if (talking === on || !avatar) return;
	talking = on;
	if (animationManager.supportsCanonicalClips?.() === false) return;
	animationManager.crossfadeTo(on ? CLIP_TALK : CLIP_IDLE, 0.3);
}

// Idle cursor-glance so the avatar notices the visitor (desktop only).
if (HAS_HOVER && !PREFERS_REDUCED_MOTION) {
	canvas.addEventListener('pointermove', (e) => {
		if (e.pointerType && e.pointerType !== 'mouse') return;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width) return;
		const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		glance.targetYaw = -ndcX * GLANCE_MAX_RAD;
		glance.active = true;
	});
	canvas.addEventListener('pointerleave', () => {
		glance.active = false;
	});
}

// ── Speech bubble ─────────────────────────────────────────────────────────
let bubbleHideTimer = 0;

function showBubble(text, { streaming = false, thinking = false, error = false, holdMs = 0 } = {}) {
	clearTimeout(bubbleHideTimer);
	bubbleTextEl.textContent = text;
	bubbleEl.classList.toggle('is-streaming', streaming && !thinking);
	bubbleEl.classList.toggle('is-thinking', thinking);
	bubbleEl.classList.toggle('is-error', error);
	bubbleEl.classList.add('is-visible');
	if (holdMs > 0) bubbleHideTimer = setTimeout(hideBubble, holdMs);
}

function hideBubble() {
	clearTimeout(bubbleHideTimer);
	bubbleEl.classList.remove('is-visible', 'is-streaming', 'is-thinking');
}

function positionBubble() {
	if (!avatar || !bubbleEl.classList.contains('is-visible')) return;
	headAnchor.set(0, avatarHeight + 0.12, 0).applyMatrix4(avatar.matrixWorld);
	headAnchor.project(camera);
	const w = stageEl.clientWidth;
	const h = stageEl.clientHeight;
	const x = ((headAnchor.x + 1) / 2) * w;
	const y = ((1 - headAnchor.y) / 2) * h;
	const half = bubbleEl.offsetWidth / 2 + 8;
	bubbleEl.style.left = `${Math.min(Math.max(x, half), w - half)}px`;
	bubbleEl.style.top = `${Math.max(y - 14, bubbleEl.offsetHeight + 10)}px`;
}

// ── Web Speech TTS ────────────────────────────────────────────────────────
const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;
let voices = [];
let currentUtterance = null;
let speechGuardTimer = 0;

function loadVoices() {
	if (!hasTTS) return;
	voices = window.speechSynthesis.getVoices() || [];
	const previous = settings.voiceName || '';
	while (voiceSelectEl.options.length > 1) voiceSelectEl.remove(1);
	for (const v of voices) {
		const opt = document.createElement('option');
		opt.value = v.name;
		opt.textContent = `${v.name} (${v.lang})`;
		voiceSelectEl.appendChild(opt);
	}
	voiceSelectEl.value = previous && voices.some((v) => v.name === previous) ? previous : '';
}
if (hasTTS) {
	loadVoices();
	window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

function pickVoice() {
	if (!voices.length) loadVoices();
	if (settings.voiceName) {
		const v = voices.find((x) => x.name === settings.voiceName);
		if (v) return v;
	}
	return voices.find((v) => v.localService && v.lang?.startsWith('en')) || voices[0] || null;
}

function stopSpeaking() {
	clearTimeout(speechGuardTimer);
	if (hasTTS) window.speechSynthesis.cancel();
	currentUtterance = null;
	setTalking(false);
}

/**
 * Speak `text` aloud (bubble is managed by the caller). Resolves when audio
 * ends. Muted or TTS-less browsers resolve after the estimated read time so
 * the talking animation and bubble still track the "speech".
 */
function speakAloud(text) {
	stopSpeaking();
	setTalking(true);
	post('speak:start', { text });
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(speechGuardTimer);
			if (currentUtterance === utter) currentUtterance = null;
			setTalking(false);
			post('speak:end', {});
			resolve();
		};
		let utter = null;
		if (hasTTS && voiceEnabled) {
			utter = new SpeechSynthesisUtterance(text);
			const v = pickVoice();
			if (v) {
				utter.voice = v;
				utter.lang = v.lang;
			}
			utter.onend = finish;
			utter.onerror = (e) => {
				if (e?.error && !/interrupt|cancel/i.test(e.error)) {
					log.warn('[assistant-frame] speech synthesis error:', e.error);
				}
				finish();
			};
			currentUtterance = utter;
			// Safety net for engines that never fire onend (flaky on mobile).
			speechGuardTimer = setTimeout(finish, estimateSpeechMs(text) + 2500);
			try {
				window.speechSynthesis.speak(utter);
				return;
			} catch (err) {
				log.warn('[assistant-frame] speechSynthesis.speak failed:', err?.message || err);
			}
		}
		// No TTS / muted: hold the talking animation for the estimated duration.
		speechGuardTimer = setTimeout(finish, estimateSpeechMs(text));
	});
}

/** Speak-mode line (also the postMessage `say` handler): bubble + audio. */
async function speakLine(text) {
	showBubble(text);
	await speakAloud(text);
	bubbleHideTimer = setTimeout(hideBubble, 1200);
}

// ── Chat ──────────────────────────────────────────────────────────────────
const history = [];
let busy = false;

function systemPrompt() {
	const lines = [
		`You are ${NAME}, a friendly 3D avatar assistant embedded on a website.`,
		'Answer in plain conversational text — no markdown, no lists, no code blocks.',
		'Keep replies under 80 words unless the visitor asks for depth.',
	];
	if (CONTEXT) lines.push(`About this website: ${CONTEXT}`);
	return lines.join('\n');
}

function pushHistory(role, content) {
	history.push({ role, content });
	while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
}

/**
 * Turn an /api/chat failure into a line the visitor can act on.
 *
 * The route already explains itself (`error_description`, plus `retry_after`
 * seconds when the free provider chain is saturated), so surface that instead
 * of a bare status code, and name the escape hatch the widget actually has:
 * the visitor's own Groq or OpenRouter key, set in the settings panel.
 */
async function chatErrorMessage(res) {
	let description = '';
	let retryAfter = 0;
	try {
		const body = await res.json();
		description = String(body?.error_description || '').trim();
		retryAfter = Number(body?.retry_after) || 0;
	} catch {
		description = '';
	}
	if (res.status === 429 || res.status === 503) {
		const wait = retryAfter ? `Try again in ${retryAfter}s` : 'Try again in a moment';
		return `${description || 'The free chat lane is busy right now.'} ${wait}, or add your own Groq or OpenRouter key under Settings.`;
	}
	return description || `Chat failed (HTTP ${res.status}).`;
}

/** Stream a reply from /api/chat (platform free chain). */
async function chatFree(message, onChunk) {
	const res = await fetch('/api/chat', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message, history: history.slice(0, -1), system_prompt: systemPrompt() }),
	});
	if (!res.ok || !res.body) throw new Error(await chatErrorMessage(res));
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let accumulated = '';
	let finalReply = '';
	let streamError = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep;
		while ((sep = buffer.indexOf('\n\n')) !== -1) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const line = frame.split('\n').find((l) => l.startsWith('data:'));
			if (!line) continue;
			let evt;
			try {
				evt = JSON.parse(line.slice(5).trim());
			} catch {
				continue;
			}
			if (evt.type === 'chunk' && typeof evt.text === 'string') {
				accumulated += evt.text;
				onChunk(accumulated);
			} else if (evt.type === 'done') {
				finalReply = (evt.reply || accumulated || '').trim();
			} else if (evt.type === 'error') {
				streamError = evt.message || 'stream error';
			}
		}
	}
	if (streamError && !finalReply && !accumulated) throw new Error(streamError);
	return (finalReply || accumulated).trim();
}

/** Stream a reply straight from the visitor's own provider (BYOK). */
async function chatByok(lane, message, onChunk) {
	const key = settings.keys[lane];
	const model = settings.models[lane] || BYOK_DEFAULT_MODELS[lane];
	const messages = [
		{ role: 'system', content: systemPrompt() },
		...history.slice(0, -1),
		{ role: 'user', content: message },
	];
	const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
	if (lane === 'openrouter') {
		headers['HTTP-Referer'] = 'https://three.ws';
		headers['X-Title'] = 'three.ws assistant widget';
	}
	const res = await fetch(BYOK_ENDPOINTS[lane], {
		method: 'POST',
		headers,
		body: JSON.stringify({ model, messages, stream: true, max_tokens: 1024 }),
	});
	if (!res.ok || !res.body) {
		if (res.status === 401 || res.status === 403) {
			throw new Error(`Your ${lane} key was rejected — check it in settings.`);
		}
		if (res.status === 429) throw new Error(`${lane} rate limit hit — give it a moment.`);
		throw new Error(`Chat failed (HTTP ${res.status}).`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let accumulated = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') continue;
			let evt;
			try {
				evt = JSON.parse(payload);
			} catch {
				continue;
			}
			const delta = evt?.choices?.[0]?.delta?.content;
			if (typeof delta === 'string' && delta) {
				accumulated += delta;
				onChunk(accumulated);
			}
		}
	}
	return accumulated.trim();
}

async function handleChat(message) {
	pushHistory('user', message);
	showBubble('', { thinking: true });
	setTalking(true);
	const lane = effectiveLane();
	try {
		const onChunk = (text) => showBubble(text, { streaming: true });
		const reply = lane === 'free' ? await chatFree(message, onChunk) : await chatByok(lane, message, onChunk);
		if (!reply) throw new Error('The model returned an empty reply — try again.');
		pushHistory('assistant', reply);
		post('message', { role: 'assistant', content: reply });
		showBubble(reply);
		if (voiceEnabled) {
			await speakAloud(reply);
			bubbleHideTimer = setTimeout(hideBubble, 6000);
		} else {
			setTalking(false);
			bubbleHideTimer = setTimeout(hideBubble, Math.max(6000, estimateSpeechMs(reply)));
		}
	} catch (err) {
		history.pop(); // failed turn doesn't poison the next one
		setTalking(false);
		// Hold an error as long as it takes to read: the at-capacity line names a
		// wait and a settings escape hatch, and blinking away at 6s loses both.
		const text = err?.message || 'Something went wrong, try again.';
		showBubble(text, { error: true, holdMs: Math.max(6000, estimateSpeechMs(text)) });
	}
}

// ── Composer wiring ───────────────────────────────────────────────────────
function autoGrow() {
	inputEl.style.height = 'auto';
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
}
inputEl.addEventListener('input', autoGrow);

async function submit() {
	const text = inputEl.value.trim();
	if (!text || busy) return;
	inputEl.value = '';
	autoGrow();
	busy = true;
	sendBtn.disabled = true;
	try {
		post('message', { role: 'user', content: text, mode: activeMode });
		if (activeMode === 'speak') await speakLine(text);
		else await handleChat(text);
	} finally {
		busy = false;
		sendBtn.disabled = false;
		inputEl.focus();
	}
}

sendBtn.addEventListener('click', submit);
inputEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
});

for (const btn of modesEl.querySelectorAll('.mode-btn')) {
	btn.addEventListener('click', () => {
		if (activeMode === btn.dataset.mode) return;
		activeMode = btn.dataset.mode;
		stopSpeaking();
		hideBubble();
		applyModeChrome();
		inputEl.focus();
	});
}

voiceBtn.addEventListener('click', () => {
	voiceEnabled = !voiceEnabled;
	if (!voiceEnabled) stopSpeaking();
	settings.voiceEnabled = voiceEnabled;
	saveSettings();
	applyVoiceChrome();
	setStatus(voiceEnabled ? 'voice on' : 'voice off');
});

closeBtn.addEventListener('click', () => post('close', {}));
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		if (settingsEl.classList.contains('is-open')) toggleSettings(false);
		else post('close', {});
	}
});

// ── Settings wiring ───────────────────────────────────────────────────────
function toggleSettings(open) {
	const willOpen = open ?? !settingsEl.classList.contains('is-open');
	settingsEl.classList.toggle('is-open', willOpen);
	settingsBtn.setAttribute('aria-expanded', String(willOpen));
	if (willOpen) applyLaneChrome();
}
settingsBtn.addEventListener('click', () => toggleSettings());
settingsCloseBtn.addEventListener('click', () => toggleSettings(false));

for (const radio of settingsEl.querySelectorAll('input[name="assistant-lane"]')) {
	radio.addEventListener('change', () => {
		settings.lane = normalizeLane(radio.value);
		saveSettings();
		applyLaneChrome();
	});
}

byokKeyEl.addEventListener('input', () => {
	if (settings.lane === 'free') return;
	settings.keys[settings.lane] = byokKeyEl.value.trim();
	saveSettings();
	lanePillEl.textContent = effectiveLane() === 'free' ? 'free' : `byok:${effectiveLane()}`;
});

byokModelEl.addEventListener('input', () => {
	if (settings.lane === 'free') return;
	settings.models[settings.lane] = byokModelEl.value.trim();
	saveSettings();
});

voiceSelectEl.addEventListener('change', () => {
	settings.voiceName = voiceSelectEl.value;
	saveSettings();
});

// ── Render loop with visibility gating ────────────────────────────────────
const clock = new Timer();
let loopRunning = false;
let rafHandle = 0;
let canRender = false;
let onScreen = true;

function tick() {
	clock.update();
	const dt = Math.min(clock.getDelta(), 0.05);
	if (avatar && HAS_HOVER && !PREFERS_REDUCED_MOTION) {
		const targetYaw = glance.active ? glance.targetYaw : 0;
		let diff = ((targetYaw - avatarYaw + Math.PI) % (Math.PI * 2)) - Math.PI;
		if (diff < -Math.PI) diff += Math.PI * 2;
		avatarYaw += diff * GLANCE_LERP;
		avatar.rotation.y = avatarYaw;
	}
	animationManager.update(dt);
	positionBubble();
	renderer.render(scene, camera);
	if (loopRunning) rafHandle = requestAnimationFrame(tick);
}

function startLoop() {
	if (loopRunning || !canRender) return;
	loopRunning = true;
	clock.update();
	rafHandle = requestAnimationFrame(tick);
}
function stopLoop() {
	loopRunning = false;
	if (rafHandle) {
		cancelAnimationFrame(rafHandle);
		rafHandle = 0;
	}
}
function syncLoop() {
	if (canRender && onScreen && !document.hidden) startLoop();
	else stopLoop();
}
document.addEventListener('visibilitychange', syncLoop);
if (typeof IntersectionObserver === 'function') {
	const io = new IntersectionObserver((entries) => {
		onScreen = entries.some((en) => en.isIntersecting);
		syncLoop();
	}, { threshold: 0 });
	io.observe(stageEl);
}

function hidePoster() {
	posterEl.classList.add('is-hidden');
	setTimeout(() => posterEl.remove(), 500);
}

// ── Boot ──────────────────────────────────────────────────────────────────
applyModeChrome();
applyLaneChrome();
applyVoiceChrome();

loadAvatar()
	.then((usedFallback) => {
		canRender = true;
		syncLoop();
		hidePoster();
		post('ready', { mode: activeMode, fallback: usedFallback });
		const greeting =
			GREETING ||
			(MODE === 'speak'
				? "Type below and I'll say it out loud."
				: `Hi! I'm ${NAME} — ask me anything.`);
		showBubble(greeting, { holdMs: 7000 });
		inputEl.focus();
	})
	.catch((err) => {
		log.error('[assistant-frame] failed to load avatar:', err);
		hidePoster();
		canRender = true;
		syncLoop();
		setStatus(`failed to load avatar: ${err?.message ?? err}`, { error: true, sticky: true });
		post('error', { code: 'avatar_load_failed', message: String(err?.message || err) });
	});
