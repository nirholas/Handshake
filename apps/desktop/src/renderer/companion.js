// The desktop companion's renderer: a character that lives on your screen.
//
// Three jobs:
//   1. Wander. Every so often the character strolls to a new spot along the
//      bottom of the display, facing the way it is going, and idles there. The
//      motion is a CSS transform on the whole stage (cheap, compositor-only)
//      while the avatar itself plays its walk cycle inside the embed.
//   2. Deliver. When the main process pushes a delivery, the character turns
//      to the middle of the screen, swaps to the sender's own body when they
//      have one, shows the line, says it out loud, then goes back to wandering.
//   3. Stay out of the way. The window is click-through; the moment the pointer
//      is over the character or the bubble we ask the main process for input,
//      and give it straight back when the pointer leaves.
//
// The body is the published three.ws walk embed, driven over its documented
// postMessage contract (https://three.ws/docs/walk-embed-api), so this app owns
// no 3D code of its own and inherits every avatar, rig and animation the
// platform ships.

const stage = document.getElementById('stage');
const body = document.getElementById('body');
const bubble = document.getElementById('bubble');
const whoEl = document.getElementById('who');
const lineEl = document.getElementById('line');
const whyEl = document.getElementById('why');
const actionsEl = document.getElementById('actions');
const hintEl = document.getElementById('hint');

const STAGE_WIDTH = 260;
const WANDER_MIN_MS = 22_000;
const WANDER_MAX_MS = 55_000;
const WALK_MS = 6000; // matches the CSS transition on #stage

let apiBase = 'https://three.ws';
let defaultAvatarUrl = null;
let currentAvatarUrl = null;
let embedReady = false;
let paused = false;
let holdTimer = null;
let wanderTimer = null;
let audio = null;
let position = 40;

// ── The embed ────────────────────────────────────────────────────────────────

function embedUrl(base) {
	const params = new URLSearchParams({
		bg: 'transparent',
		ground: 'false',
		controls: 'none',
		badge: 'false',
		orbit: 'false',
		click: 'false',
		env: 'studio',
	});
	return `${base}/walk-embed?${params}`;
}

// The embed's typed envelope (src/walk-embed-events.js): channel + version +
// type + payload, targeted at the embed's own origin so nothing else on the
// machine can drive the character.
function toEmbed(type, payload = {}) {
	if (!embedReady && type !== 'walk:ping') return;
	body.contentWindow?.postMessage({ channel: 'three-walk', v: 1, type, ...payload }, apiBase);
}

// A host that attaches after the embed already loaded would otherwise wait
// forever for a handshake that has been and gone: ask for it again on load.
body.addEventListener('load', () => {
	body.contentWindow?.postMessage({ channel: 'three-walk', v: 1, type: 'walk:ping' }, apiBase);
});

window.addEventListener('message', (event) => {
	if (!event.data || typeof event.data !== 'object') return;
	// Only the embed origin may drive the character.
	if (apiBase && event.origin !== new URL(apiBase).origin) return;
	if (event.data.type === 'walk:ready') {
		embedReady = true;
		if (currentAvatarUrl) toEmbed('walk:avatar', { avatarId: currentAvatarUrl });
		scheduleWander(4000);
	}
});

// ── Wandering ────────────────────────────────────────────────────────────────

function maxX() {
	return Math.max(0, window.innerWidth - STAGE_WIDTH - 40);
}

function walkTo(x) {
	const target = Math.min(maxX(), Math.max(0, x));
	stage.dataset.facing = target < position ? 'left' : 'right';
	position = target;
	stage.style.transform = `translateX(${target}px)`;
	// Legs move while the stage slides; the embed recentres itself afterwards so
	// the character never drifts out of its own frame.
	toEmbed('walk:move', { x: 0.7, y: 0 });
	setTimeout(() => toEmbed('walk:reset', {}), WALK_MS);
}

function scheduleWander(delay = null) {
	clearTimeout(wanderTimer);
	const wait = delay ?? (WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS));
	wanderTimer = setTimeout(() => {
		if (!paused && !bubble.dataset.visible) walkTo(Math.random() * maxX());
		scheduleWander();
	}, wait);
}

// ── Voice ────────────────────────────────────────────────────────────────────

function stopAudio() {
	if (audio) {
		audio.pause();
		audio.src = '';
		audio = null;
	}
	try {
		window.speechSynthesis?.cancel();
	} catch {
		/* no speech synthesis available */
	}
}

async function say(text, voice) {
	stopAudio();
	// 1: the platform voice lanes, in the voice this contact was given.
	try {
		const res = await fetch(`${apiBase}/api/tts/speak`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, voice: voice || 'alloy', format: 'mp3' }),
		});
		if (res.ok) {
			const blob = await res.blob();
			if (blob.size) {
				audio = new Audio(URL.createObjectURL(blob));
				await audio.play();
				return;
			}
		}
	} catch {
		/* fall through to the local voices */
	}
	// 2: the browser engine inside Electron.
	try {
		if (window.speechSynthesis) {
			window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
			return;
		}
	} catch {
		/* fall through to the OS voice */
	}
	// 3: the machine's own voice (macOS `say`).
	window.companion?.sayNative(text);
}

// ── Delivering ───────────────────────────────────────────────────────────────

function holdMsFor(text) {
	return Math.min(15_000, 5200 + String(text || '').length * 55);
}

function clearBubble() {
	clearTimeout(holdTimer);
	bubble.removeAttribute('data-visible');
	stopAudio();
	if (defaultAvatarUrl && currentAvatarUrl !== defaultAvatarUrl) {
		currentAvatarUrl = defaultAvatarUrl;
		toEmbed('walk:avatar', { avatarId: defaultAvatarUrl });
	}
	scheduleWander();
}

function deliver(delivery) {
	if (paused) return;
	const line = delivery.spoken_line || delivery.title || '';

	// Walk into the middle of the screen to say something: a companion that
	// delivers from the far corner reads as a toast, not as a person.
	clearTimeout(wanderTimer);
	walkTo(maxX() / 2);

	if (delivery.avatar_glb_url && delivery.avatar_glb_url !== currentAvatarUrl) {
		currentAvatarUrl = delivery.avatar_glb_url;
		toEmbed('walk:avatar', { avatarId: delivery.avatar_glb_url });
	}

	whoEl.textContent = delivery.speaker || delivery.sender || 'Your companion';
	lineEl.textContent = line;
	whyEl.textContent = delivery.reason ? `${delivery.importance}/100 · ${delivery.reason}` : '';

	actionsEl.innerHTML = '';
	if (delivery.url) {
		const open = document.createElement('button');
		open.textContent = 'Open';
		open.addEventListener('click', () => window.companion?.openExternal(delivery.url));
		actionsEl.appendChild(open);
	}
	const dismiss = document.createElement('button');
	dismiss.textContent = 'Got it';
	dismiss.addEventListener('click', clearBubble);
	actionsEl.appendChild(dismiss);

	bubble.dataset.visible = '1';
	setTimeout(() => toEmbed('walk:gesture', { gesture: 'wave' }), 400);
	say(line, delivery.voice);

	clearTimeout(holdTimer);
	holdTimer = setTimeout(clearBubble, holdMsFor(line));
}

// ── Hit testing: hand the mouse back and forth ───────────────────────────────

let interactive = false;
function setInteractive(next) {
	if (next === interactive) return;
	interactive = next;
	window.companion?.setInteractive(next);
}

window.addEventListener('mousemove', (event) => {
	const overBubble = bubble.dataset.visible === '1' && hits(bubble, event);
	const overBody = hits(body, event);
	setInteractive(overBubble || overBody);
});

function hits(element, event) {
	const rect = element.getBoundingClientRect();
	return event.clientX >= rect.left && event.clientX <= rect.right
		&& event.clientY >= rect.top && event.clientY <= rect.bottom;
}

// Clicking the character opens the control room: the one gesture people try.
body.addEventListener('click', () => window.companion?.openExternal(`${apiBase}/companion`));

// ── Wiring ───────────────────────────────────────────────────────────────────

async function boot() {
	const creds = await window.companion.credentials();
	apiBase = creds.apiBase || apiBase;
	paused = Boolean(creds.paused);
	body.src = embedUrl(apiBase);
	hintEl.dataset.visible = creds.signedIn ? '0' : '1';
	if (!creds.signedIn) stage.dataset.hidden = '1';

	window.companion.onStatus((status) => {
		if (typeof status?.paused === 'boolean') paused = status.paused;
		if (status?.apiBase) apiBase = status.apiBase;
		if (typeof status?.signedIn === 'boolean') {
			hintEl.dataset.visible = status.signedIn ? '0' : '1';
			stage.dataset.hidden = status.signedIn ? '0' : '1';
		}
		if (status?.default_avatar_glb_url) {
			defaultAvatarUrl = status.default_avatar_glb_url;
			if (!currentAvatarUrl) {
				currentAvatarUrl = defaultAvatarUrl;
				toEmbed('walk:avatar', { avatarId: defaultAvatarUrl });
			}
		}
		if (paused) clearBubble();
	});

	window.companion.onDelivery(deliver);
	window.addEventListener('resize', () => walkTo(Math.min(position, maxX())));
}

boot();
