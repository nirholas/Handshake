// LobeHub iframe bridge for three.ws.
//
// Primary protocol: v1 spec envelope
//   { v: 1, source: 'agent-host'|'agent-3d', id, inReplyTo?, kind, op, payload }
// The canonical contract is the final-integration campaign's embed-bridges work
// order, retired from prompts/ once shipped; see git history.
//
// Backward-compat layer also accepts the legacy format:
//   { v: 1, ns: '3d-agent', type: 'host:xxx', id?, payload }

const EMBED_VERSION = '1.0.0';
const CAPABILITIES = ['speak', 'gesture', 'emote', 'look', 'setAgent', 'subscribe', 'ping'];

// Hosts that may frame this iframe as a chat plugin, unconditionally trusted.
// LobeChat and SperaxOS (a LobeChat-lineage host) both embed standalone plugins.
const KNOWN_ORIGINS = new Set([
	'https://chat.lobehub.com',
	'https://lobechat.ai',
	'https://chat.sperax.io',
	'https://sperax.io',
	'https://sperax-iota.vercel.app',
	'https://sperax-jam2emun9-moomsi.vercel.app',
]);

function isDev(origin) {
	try {
		const h = new URL(origin).hostname;
		return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local') || h === '0.0.0.0';
	} catch {
		return false;
	}
}

const params = new URL(location.href).searchParams;
const agentId = params.get('agent') || '';
const srcParam = params.get('src') || '';

// ?host=<encoded-origin> restricts accepted parent to one origin.
let allowedOrigin = null;
const hostParam = params.get('host');
if (hostParam) {
	try {
		allowedOrigin = new URL(decodeURIComponent(hostParam)).origin;
	} catch {
		console.warn('[3d-agent] invalid ?host param');
	}
}

// Locked-on origin: once a valid host message arrives, we lock to that origin
// for the rest of the session. Subsequent messages from any other origin are
// ignored, even if they would have been allowed by the policy below.
let lockedOrigin = null;

function isAllowedOrigin(origin) {
	if (!origin || origin === 'null') return false;
	if (lockedOrigin) return origin === lockedOrigin;
	if (allowedOrigin) return origin === allowedOrigin;
	if (KNOWN_ORIGINS.has(origin)) return true;
	if (isDev(origin)) return true;
	// Permit unknown origins with a warning — public agents may embed anywhere.
	console.warn('[3d-agent] message from unlisted origin', origin);
	return true;
}

function newId() {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ── Outgoing ─────────────────────────────────────────────────────────────────

function post(op, payload, inReplyTo) {
	const msg = {
		v: 1,
		source: 'agent-3d',
		id: newId(),
		kind: inReplyTo ? 'response' : 'event',
		op,
		payload: payload ?? {},
	};
	if (inReplyTo) msg.inReplyTo = inReplyTo;
	// Resolve target origin in priority order:
	//   1. lockedOrigin (set after the first authenticated host message)
	//   2. allowedOrigin (?host= URL param)
	//   3. document.referrer (best-effort initial announcement)
	let target = lockedOrigin || allowedOrigin;
	if (!target) {
		try {
			if (document.referrer) target = new URL(document.referrer).origin;
		} catch {}
	}
	if (!target) {
		console.warn('[3d-agent] parent origin unknown; dropping', op);
		return;
	}
	try {
		window.parent.postMessage(msg, target);
	} catch (_) {}
}

// ── Element wiring ────────────────────────────────────────────────────────────

const el = document.getElementById('agent');
const statusEl = document.getElementById('status');

function setStatus(text) {
	if (statusEl) statusEl.textContent = text;
}

// The agent can be specified three ways, in priority order:
//   1. ?src=<glb-url> or ?agent=<id> on the iframe URL (direct embeds, dev harness)
//   2. the host plugin's `settings.agentId` (LobeChat / SperaxOS)
//   3. a `render_agent` tool call from the LLM
// (2) and (3) arrive over postMessage after boot, so an empty start is normal.
let boundAgentId = agentId;
function bindAgent(id) {
	if (!id || typeof id !== 'string') return;
	if (id === boundAgentId && el.getAttribute('agent-id')) return;
	boundAgentId = id;
	el.removeAttribute('src');
	el.setAttribute('agent-id', id);
	setStatus('Loading…');
}

if (srcParam) {
	el.setAttribute('src', decodeURIComponent(srcParam));
} else if (agentId) {
	el.setAttribute('agent-id', agentId);
} else {
	setStatus('Waiting for an agent…');
}

el.addEventListener('agent:ready', (ev) => {
	const { manifest } = ev.detail || {};
	if (statusEl) statusEl.style.display = 'none';
	post('ready', {
		agentId,
		embedVersion: EMBED_VERSION,
		capabilities: CAPABILITIES,
		name: manifest?.meta?.name || manifest?.name || '',
	});
});

el.addEventListener('agent:error', (ev) => {
	const { phase, error: err } = ev.detail || {};
	setStatus(err?.message || 'Error loading agent');
	post('error', {
		code: err?.code || 'load_error',
		message: err?.message || 'Agent failed to load',
		phase: phase || 'boot',
	});
});

// ── ResizeObserver → resize event (debounced 100 ms) ─────────────────────────

if (typeof ResizeObserver !== 'undefined') {
	let resizeTimer;
	const ro = new ResizeObserver(() => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			post('resize', {
				width: el.offsetWidth,
				height: el.offsetHeight,
				contentHeight: el.scrollHeight,
			});
		}, 100);
	});
	ro.observe(el);
}

// ── Action dispatch ───────────────────────────────────────────────────────────

let subscribed = false;

async function dispatchAction(op, payload, replyId) {
	try {
		switch (op) {
			case 'speak':
				el.speak?.(payload.text || '', { sentiment: payload.sentiment ?? 0 });
				break;
			case 'gesture':
				if (payload.name === 'wave') {
					await el.wave?.();
				} else {
					await el.play?.(payload.name, { duration: payload.duration });
				}
				break;
			case 'emote':
				// <agent-3d> has no public emote() method; dispatch as a CustomEvent
				// for the runtime's empathy-layer listener (src/agent-avatar.js).
				el.dispatchEvent(
					new CustomEvent('agent:action', { detail: { type: 'emote', payload } }),
				);
				break;
			case 'look':
				el.dispatchEvent(
					new CustomEvent('agent:action', { detail: { type: 'look', payload } }),
				);
				break;
			case 'setAgent':
				if (payload.agentId && payload.agentId !== agentId) {
					const url = new URL(location.href);
					url.searchParams.set('agent', payload.agentId);
					location.replace(url.toString());
				}
				break;
		}
		if (replyId) post('pong', { ok: true }, replyId);
		if (subscribed) {
			post('action', { op, payload, timestamp: Date.now(), agentId });
		}
	} catch (err) {
		console.warn('[3d-agent] action dispatch failed', err);
		if (replyId) post('error', { code: 'dispatch_error', message: String(err) }, replyId);
	}
}

// ── LobeChat / SperaxOS standalone-plugin protocol ────────────────────────────
// Both platforms are LobeChat-lineage and speak an identical message contract,
// differing only in the channel prefix: 'lobe-chat:' vs 'speraxos:'. We announce
// readiness on both and accept tool calls from either.
//   host → iframe: { type:'<ns>:init-standalone-plugin', payload:{ apiName, arguments }, settings, state }
//   iframe → host: { type:'<ns>:plugin-ready-for-render' }
const CHAT_PLUGIN_PREFIXES = ['lobe-chat:', 'speraxos:'];

function chatPluginChannel(type) {
	if (typeof type !== 'string') return null;
	for (const prefix of CHAT_PLUGIN_PREFIXES) {
		if (type.startsWith(prefix)) return type.slice(prefix.length);
	}
	return null;
}

// Normalise the function-call payload. The wire carries `payload.apiName` and a
// JSON-string `payload.arguments`; older builds nest it under `props`. We also
// accept an already-parsed arguments object for robustness across host versions.
function readChatPluginCall(data) {
	const p = data.payload || data.props || {};
	const apiName = p.apiName || p.name || data.apiName || data.name || '';
	const raw = p.arguments ?? data.arguments;
	let args = {};
	if (typeof raw === 'string') {
		try {
			args = JSON.parse(raw || '{}');
		} catch {
			args = {};
		}
	} else if (raw && typeof raw === 'object') {
		args = raw;
	}
	const settings = data.settings || p.settings || {};
	return { apiName, args, settings };
}

function handleChatPluginMessage(channel, data) {
	const { apiName, args, settings } = readChatPluginCall(data);

	// Bind the avatar to the configured agent whenever the host sends settings.
	if (settings && typeof settings.agentId === 'string') bindAgent(settings.agentId);

	// Only the render/init channels carry a function call; the state/settings
	// channels are not used by this plugin.
	if (channel !== 'init-standalone-plugin' && channel !== 'render-plugin') return;
	if (!apiName) return;

	switch (apiName) {
		case 'render_agent':
		case 'render-agent':
			if (typeof args.agentId === 'string') bindAgent(args.agentId);
			break;
		case 'speak':
			dispatchAction(
				'speak',
				{
					text: typeof args.text === 'string' ? args.text : '',
					sentiment: typeof args.sentiment === 'number' ? args.sentiment : 0,
				},
				null,
			);
			break;
		case 'gesture':
			dispatchAction('gesture', { name: args.name, duration: args.duration }, null);
			break;
		case 'emote':
			dispatchAction(
				'emote',
				{
					trigger: args.trigger,
					weight: typeof args.weight === 'number' ? args.weight : 1,
				},
				null,
			);
			break;
	}
}

// ── postMessage handler ───────────────────────────────────────────────────────

function onMessage(ev) {
	const { origin, data } = ev;
	if (!data || typeof data !== 'object') return;
	if (ev.source !== window.parent) return;

	// Dev-harness handshake shortcut. Reply only to allowed, non-null origins.
	if (data.type === 'handshake') {
		if (!origin || origin === 'null') return;
		if (!isAllowedOrigin(origin)) return;
		if (!lockedOrigin) lockedOrigin = origin;
		try {
			window.parent.postMessage({ type: 'ready', agentId }, origin);
		} catch (_) {}
		return;
	}

	if (!isAllowedOrigin(origin)) return;
	if (!lockedOrigin) lockedOrigin = origin;

	// ── LobeChat / SperaxOS standalone-plugin channels ──────────────────────────
	const chatChannel = chatPluginChannel(data.type);
	if (chatChannel) {
		handleChatPluginMessage(chatChannel, data);
		return;
	}

	// ── v1 spec envelope ──────────────────────────────────────────────────────
	if (data.v === 1 && data.source === 'agent-host' && data.kind && data.op) {
		const { id, kind, op, payload = {} } = data;
		if (kind !== 'request') return;

		switch (op) {
			case 'ping':
				post('pong', { agentId }, id);
				break;
			case 'subscribe':
				subscribed = true;
				post('pong', { ok: true }, id);
				break;
			case 'speak':
			case 'gesture':
			case 'emote':
			case 'look':
			case 'setAgent':
				dispatchAction(op, payload, id);
				break;
			default:
				post('error', { code: 'unknown_op', op }, id);
		}
		return;
	}

	// ── Legacy envelope: { v:1, ns:'3d-agent', type:'host:xxx', ... } ─────────
	if (data.v === 1 && data.ns === '3d-agent' && typeof data.type === 'string') {
		const { type, id, payload = {} } = data;
		switch (type) {
			case 'host:hello':
				post(
					'ready',
					{ agentId, embedVersion: EMBED_VERSION, capabilities: CAPABILITIES },
					id,
				);
				break;
			case 'host:ping':
				post('pong', {}, id);
				break;
			case 'host:action':
				if (payload.action) {
					const a = payload.action;
					dispatchAction(a.type, a.payload || {}, null);
				}
				break;
			case 'host:pause':
				el.pause?.();
				break;
			case 'host:resume':
				el.resume?.();
				break;
			case 'host:theme':
				applyTheme(payload);
				break;
			case 'host:set-agent':
				dispatchAction('setAgent', payload, null);
				break;
		}
	}
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme({ mode, accent } = {}) {
	if (mode === 'dark') document.body.style.background = '#0d0d0d';
	else if (mode === 'light') document.body.style.background = '#f5f5f5';
	else if (mode === 'transparent') document.body.style.background = 'transparent';
	if (accent) document.documentElement.style.setProperty('--agent-accent', accent);
}

window.addEventListener('message', onMessage);

// Fire initial ready event so the host knows the iframe is alive.
// The host should respond with a ping to complete the handshake.
post('ready', {
	agentId,
	embedVersion: EMBED_VERSION,
	capabilities: CAPABILITIES,
});

// Announce readiness on the LobeChat / SperaxOS channels so those hosts deliver
// the standalone-plugin init payload (settings + the triggering tool call). The
// ready signal carries no sensitive data, so we broadcast it to the parent
// regardless of which host framed us; all subsequent exchange is origin-locked.
for (const prefix of CHAT_PLUGIN_PREFIXES) {
	try {
		window.parent.postMessage({ type: `${prefix}plugin-ready-for-render` }, '*');
	} catch (_) {}
}
