// overlay-control.js — Stream Deck companion for the OBS overlay.
//
// Two-way control surface for an /embed/avatar runtime mounted in OBS Browser
// Source: emote hotkeys, expression mixer, mic threshold, speech queue. The
// control panel never owns the overlay — it just speaks the v1.avatar.* wire
// over both window.postMessage (to the in-page preview iframe) and
// BroadcastChannel (to the OBS overlay window on the same machine).
//
// Why BroadcastChannel: OBS Browser Source runs in a Chromium instance under
// the same origin as the user's logged-in browser tab when the URL points at
// our site. BroadcastChannel is the cheapest IPC across same-origin windows
// — no server, no WebSocket relay. The avatar embed listens on a channel
// derived from its handle or avatar id; the control panel pushes to the same
// channel.
//
// The companion also opens the overlay as a "real" window via window.open()
// so users can grab the URL from the new tab and drop it into OBS in two
// clicks.

const DEFAULT_HOTKEY_LABELS = ['smile', 'wink', 'surprised', 'sad', 'angry', 'disgust', 'thinking', 'kiss', 'tongue', 'neutral'];

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const handleInput = $('#avatar-handle');
const applyBtn = $('#apply-handle');
const openOverlayBtn = $('#open-overlay');
const copyOverlayBtn = $('#copy-overlay');
const overlayUrlPre = $('#overlay-url');
const statusEl = $('#status');
const hotkeyGrid = $('#hotkey-grid');
const micToggleBtn = $('#mic-toggle');
const micStateEl = $('#mic-state');
const micFloor = $('#mic-floor');
const micCeiling = $('#mic-ceiling');
const micFloorV = $('#mic-floor-v');
const micCeilingV = $('#mic-ceiling-v');
const speakText = $('#speak-text');
const speakGo = $('#speak-go');
const eventLog = $('#event-log');
const preview = $('#preview');

// ── State ──────────────────────────────────────────────────────────────────
const state = {
	handle: localStorage.getItem('overlay:handle') || '',
	bc: null,
	online: false,
	micOn: false,
	hotkeys: null,
};

if (state.handle) handleInput.value = state.handle.replace(/^@/, '');

handleInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		apply();
	}
});
applyBtn.addEventListener('click', () => apply());
openOverlayBtn.addEventListener('click', () => openOverlay());
copyOverlayBtn.addEventListener('click', () => copyOverlay());

micToggleBtn.addEventListener('click', () => {
	if (state.micOn) {
		send({ type: 'v1.avatar.mic', enabled: false });
		setMicUi(false);
	} else {
		send({
			type: 'v1.avatar.mic',
			enabled: true,
			floor: Number(micFloor.value),
			ceiling: Number(micCeiling.value),
		});
		setMicUi(true);
	}
});

micFloor.addEventListener('input', () => {
	micFloorV.textContent = Number(micFloor.value).toFixed(3);
	if (state.micOn) send({ type: 'v1.avatar.mic', enabled: true, floor: Number(micFloor.value), ceiling: Number(micCeiling.value) });
});
micCeiling.addEventListener('input', () => {
	micCeilingV.textContent = Number(micCeiling.value).toFixed(3);
	if (state.micOn) send({ type: 'v1.avatar.mic', enabled: true, floor: Number(micFloor.value), ceiling: Number(micCeiling.value) });
});

speakGo.addEventListener('click', () => {
	const text = speakText.value.trim();
	if (!text) return;
	send({ type: 'v1.avatar.speak', text });
});
speakText.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		speakGo.click();
	}
});

document.querySelectorAll('[data-control]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const ctl = btn.dataset.control;
		if (ctl === 'stop') send({ type: 'v1.avatar.stop' });
		else if (ctl === 'overlay-on') send({ type: 'v1.avatar.overlay', enabled: true });
		else if (ctl === 'overlay-off') send({ type: 'v1.avatar.overlay', enabled: false });
	});
});

// Global key listener — re-fires hotkeys when this tab has focus so the
// streamer can mash keys without clicking the buttons.
window.addEventListener('keydown', (e) => {
	if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
	if (e.key >= '0' && e.key <= '9') {
		fireHotkey(e.key);
		e.preventDefault();
	}
});

renderHotkeys(buildDefaultHotkeys());
micFloorV.textContent = Number(micFloor.value).toFixed(3);
micCeilingV.textContent = Number(micCeiling.value).toFixed(3);

// ── Boot ───────────────────────────────────────────────────────────────────
if (state.handle) apply().catch((err) => log(`apply failed: ${err.message}`, 'warn'));

// ── Functions ──────────────────────────────────────────────────────────────

function buildDefaultHotkeys() {
	const out = {};
	const order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
	order.forEach((k, i) => {
		out[k] = { label: DEFAULT_HOTKEY_LABELS[i] || `emote ${k}`, hold: 1500 };
	});
	return out;
}

function renderHotkeys(map) {
	hotkeyGrid.innerHTML = '';
	const order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
	for (const k of order) {
		const entry = map[k];
		if (!entry) continue;
		const el = document.createElement('button');
		el.className = 'hotkey';
		el.dataset.key = k;
		el.setAttribute('aria-label', entry.label || `Hotkey ${k}`);
		el.innerHTML = `<span class="k">${escapeHtml(k)}</span><span class="l">${escapeHtml(entry.label || '')}</span>`;
		el.addEventListener('click', () => fireHotkey(k));
		hotkeyGrid.appendChild(el);
	}
}

function fireHotkey(key) {
	const k = String(key);
	send({ type: 'v1.avatar.hotkey', key: k });
	const el = hotkeyGrid.querySelector(`.hotkey[data-key="${CSS.escape(k)}"]`);
	if (el) {
		el.classList.add('fired');
		setTimeout(() => el.classList.remove('fired'), 220);
	}
}

async function apply() {
	const raw = (handleInput.value || '').trim().replace(/^@/, '').toLowerCase();
	if (!/^[a-z0-9_-]{3,30}$/.test(raw)) {
		log(`invalid handle: ${raw || '(empty)'}`, 'warn');
		return;
	}
	state.handle = raw;
	localStorage.setItem('overlay:handle', raw);
	const url = buildOverlayUrl(raw);
	overlayUrlPre.textContent = url;
	preview.src = url;
	setStatus(false);

	// Open / reset the BroadcastChannel.
	if (state.bc) {
		try { state.bc.close(); } catch {}
	}
	const channelKey = `three-ws-overlay:${raw}`;
	state.bc = new BroadcastChannel(channelKey);
	state.bc.onmessage = (ev) => onBroadcast(ev.data);
	// Ping every avatar listening on the channel.
	state.bc.postMessage({ type: 'v1.avatar.hello' });
	log(`Tracking @${raw} on ${channelKey}`);
}

function openOverlay() {
	if (!state.handle) {
		log('Set a handle first.', 'warn');
		return;
	}
	const url = buildOverlayUrl(state.handle);
	window.open(url, '_blank', 'noopener,popup,width=720,height=900');
}

async function copyOverlay() {
	if (!state.handle) {
		log('Set a handle first.', 'warn');
		return;
	}
	const url = buildOverlayUrl(state.handle);
	try {
		await navigator.clipboard.writeText(url);
		copyOverlayBtn.textContent = 'Copied';
		setTimeout(() => (copyOverlayBtn.textContent = 'Copy overlay URL'), 1400);
	} catch (err) {
		log(`clipboard failed: ${err?.message}`, 'warn');
	}
}

function buildOverlayUrl(handle) {
	const u = new URL(`${location.origin}/embed/avatar/${encodeURIComponent(handle)}`);
	u.searchParams.set('overlay', '1');
	u.searchParams.set('idle', 'on');
	u.searchParams.set('bg', 'transparent');
	return u.toString();
}

function send(msg) {
	// Send to both surfaces — preview iframe (window.postMessage) and OBS
	// overlay (BroadcastChannel). Either may be absent; both being missing
	// just means nothing is listening yet.
	try {
		if (preview && preview.contentWindow) {
			preview.contentWindow.postMessage(msg, location.origin);
		}
	} catch {}
	try {
		if (state.bc) state.bc.postMessage(msg);
	} catch {}
	log(`→ ${msg.type}${msg.key ? ' key=' + msg.key : ''}${msg.text ? ' "' + msg.text + '"' : ''}`);
}

function onBroadcast(msg) {
	if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
	switch (msg.type) {
		case 'v1.avatar.ready':
		case 'v1.avatar.online':
			setStatus(true);
			if (msg.hotkeys) {
				state.hotkeys = msg.hotkeys;
				renderHotkeys(msg.hotkeys);
			}
			log(`← ready · ${msg.name || msg.handle || msg.id || ''}${msg.conformance ? ` · ${Math.round(msg.conformance.coverage * 100)}% morphs` : ''}`);
			return;
		case 'v1.avatar.hotkey:fired':
			log(`← hotkey ${msg.key} (${msg.label || ''})`);
			return;
		case 'v1.avatar.state':
			log(`← state · ${msg.state?.expression || '?'}${msg.state?.talking ? ' · talking' : ''}`);
			return;
		case 'v1.avatar.error':
			log(`← error · ${msg.message || ''}`, 'warn');
			return;
		case 'v1.avatar.pong':
			// Heartbeat acknowledged.
			return;
	}
}

window.addEventListener('message', (ev) => {
	if (preview && ev.source !== preview.contentWindow) return;
	onBroadcast(ev.data);
});

function setStatus(online) {
	state.online = online;
	statusEl.classList.toggle('online', online);
	statusEl.querySelector('.label').textContent = online ? 'live' : 'waiting';
}

function setMicUi(on) {
	state.micOn = on;
	micToggleBtn.textContent = on ? 'Disable mic' : 'Enable mic';
	micStateEl.classList.toggle('online', on);
	micStateEl.querySelector('.label').textContent = on ? 'on' : 'off';
}

function log(message, level = 'info') {
	const ts = new Date().toTimeString().slice(0, 8);
	const line = document.createElement('span');
	line.className = `e ${level}`;
	line.textContent = `${ts}  ${message}\n`;
	eventLog.prepend(line);
	// Cap event-log entries so a long session doesn't grow unbounded.
	while (eventLog.children.length > 120) eventLog.removeChild(eventLog.lastChild);
}

function escapeHtml(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
