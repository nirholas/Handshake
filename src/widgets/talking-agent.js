/**
 * Talking Agent Widget — embodied chat panel wired to /api/widgets/:id/chat.
 *
 * The chat endpoint owns brain dispatch (Anthropic / custom proxy / none) plus
 * visitor rate limiting, so the widget never sees an API key. We post the
 * visitor's turn + history, parse the SSE response for { reply, actions }, and
 * surface actions on the SceneController (wave / lookAt / playClip / remember).
 *
 * Action shape from the endpoint (camelCase, single layer):
 *   { type: 'wave' }
 *   { type: 'lookAt', target: 'user'|'camera'|'model' }
 *   { type: 'playClip', name: '<clip-name>' }
 *   { type: 'remember', content: '<note>' }
 */

import { NichAgent } from '../nich-agent.js';
import { ACTION_TYPES } from '../agent-protocol.js';
import { ThoughtBubble } from '../thought-bubble.js';

/**
 * @param {import('../viewer.js').Viewer} viewer
 * @param {object} config  Talking-agent config (see widget-types.js).
 * @param {HTMLElement} container  Root container (usually document.body).
 * @param {{
 *   widgetId: string,
 *   getSceneCtrl: () => (import('../runtime/scene.js').SceneController|null),
 *   protocol?: import('../agent-protocol.js').AgentProtocol,
 *   identity?: import('../agent-identity.js').AgentIdentity,
 *   onMessage?: (turn: { role: 'user'|'assistant', content: string }) => void,
 * }} ctx  `onMessage` fires once per visitor turn and once per assistant
 *   reply; app.js uses it to forward `widget:chat:message` to the host page.
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function mountTalkingAgent(viewer, config, container, ctx) {
	const { widgetId, getSceneCtrl, protocol = null, identity = null } = ctx || {};
	const onMessage = typeof ctx?.onMessage === 'function' ? ctx.onMessage : null;
	const isPreview = !widgetId;

	const history = [];
	let destroyed = false;

	// Cookieless visitor + thread identity (Vercel AI SDK / Intercom pattern):
	//   visitor_id — long-lived UUID in localStorage, lets the creator see
	//                "this is the same visitor returning across sessions"
	//   thread_id  — sessionStorage so a new tab / new visit starts a new
	//                conversation bucket the creator can browse independently
	const ids = isPreview ? { visitorId: null, threadId: null } : ensureVisitorThread(widgetId);

	const bubble = new ThoughtBubble(viewer);

	const agent = new NichAgent(container, protocol, null, identity, null, {
		layout: 'embedded',
		position: config.chatPosition || 'right',
		greeting: config.greeting || 'Hi! Ask me anything.',
		title: config.agentName || undefined,
		theme: { accent: config.accent, background: config.background, caption: config.caption },
		showPoweredBy: config.poweredByBadge !== false,
		voiceInput: config.voiceInput !== false,
		voiceOutput: config.voiceOutput !== false,
		skipDefaultListeners: true,
		thoughtBubble: bubble,
		onSend: async (text) => {
			if (isPreview) {
				return { reply: 'Preview mode — save your widget to enable live chat.' };
			}
			try {
				const result = await dispatchChat(widgetId, text, history.slice(-20), ids);
				if (result.reply) {
					history.push({ role: 'user', content: text });
					history.push({ role: 'assistant', content: result.reply });
					// Surface the turn to whoever mounted us. We emit user + reply
					// together so the host can mirror the conversation in order
					// without having to listen to keystrokes.
					try {
						onMessage?.({ role: 'user', content: text });
						onMessage?.({ role: 'assistant', content: result.reply });
					} catch (cbErr) {
						console.warn('[talking-agent] onMessage callback threw', cbErr?.message);
					}
				}
				queueMicrotask(() => runActions(result.actions, getSceneCtrl, protocol));
				return { reply: result.reply, error: result.error };
			} catch (err) {
				console.warn('[talking-agent] chat dispatch failed', err.message);
				return { error: 'Chat is unavailable right now.' };
			}
		},
	});

	return {
		destroy() {
			if (destroyed) return;
			destroyed = true;
			try {
				bubble.dispose();
				agent.panel?.remove();
				agent.toggleBtn?.remove();
			} catch {}
		},
	};
}

// ── SSE round-trip ─────────────────────────────────────────────────────────

async function dispatchChat(widgetId, message, history, ids) {
	const body = { message, history };
	if (ids?.visitorId) body.visitor_id = ids.visitorId;
	if (ids?.threadId) body.thread_id = ids.threadId;

	const res = await fetch(`/api/widgets/${encodeURIComponent(widgetId)}/chat`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
		body: JSON.stringify(body),
	});

	if (res.status === 429) {
		const data = await res.json().catch(() => ({}));
		const wait = data.retry_after ? ` Try again in ${data.retry_after}s.` : '';
		return { reply: '', actions: [], error: `Slow down a moment.${wait}` };
	}
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		return { reply: '', actions: [], error: data.error_description || 'Chat backend error.' };
	}

	const text = await res.text();
	return parseSse(text);
}

function parseSse(text) {
	let reply = '';
	const actions = [];
	let error = null;
	for (const block of text.split(/\n\n+/)) {
		if (!block.trim()) continue;
		let event = 'message';
		let data = '';
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data += line.slice(5).trim();
		}
		if (!data) continue;
		let payload;
		try {
			payload = JSON.parse(data);
		} catch {
			continue;
		}
		if (event === 'message') {
			if (typeof payload.reply === 'string') reply += payload.reply;
			if (Array.isArray(payload.actions)) actions.push(...payload.actions);
		} else if (event === 'error') {
			error = payload.message || 'Chat backend error.';
		}
	}
	return { reply, actions, error };
}

// ── Visitor + thread identity ──────────────────────────────────────────────
//
// localStorage holds a long-lived per-widget UUID — same visitor across tabs
// and visits. sessionStorage holds the current thread — a fresh tab or a
// browser restart starts a new bucket so the creator can browse conversations
// grouped by visit. Both fail gracefully when storage is blocked (private
// browsing / sandboxed iframes); the server falls back to an anon thread id.
function ensureVisitorThread(widgetId) {
	const safeId = String(widgetId || '').replace(/[^A-Za-z0-9_-]/g, '');
	const vKey = `3dws:visitor:${safeId}`;
	const tKey = `3dws:thread:${safeId}`;

	let visitorId = null;
	let threadId = null;
	try {
		visitorId = localStorage.getItem(vKey);
		if (!visitorId) {
			visitorId = randomId('v_');
			localStorage.setItem(vKey, visitorId);
		}
	} catch {
		/* localStorage blocked */
	}
	try {
		threadId = sessionStorage.getItem(tKey);
		if (!threadId) {
			threadId = randomId('wct_');
			sessionStorage.setItem(tKey, threadId);
		}
	} catch {
		/* sessionStorage blocked */
	}

	return { visitorId, threadId };
}

function randomId(prefix) {
	const bytes = new Uint8Array(9);
	(globalThis.crypto || window.crypto)?.getRandomValues?.(bytes);
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, '0');
	}
	return prefix + s.slice(0, 12);
}

// ── Action dispatch ────────────────────────────────────────────────────────

function runActions(actions, getSceneCtrl, protocol) {
	if (!Array.isArray(actions) || !actions.length) return;
	const sceneCtrl = getSceneCtrl?.();
	for (const action of actions) {
		if (!action || typeof action.type !== 'string') continue;
		try {
			runOne(action, sceneCtrl, protocol);
		} catch (err) {
			console.warn('[talking-agent] action failed', action.type, err.message);
		}
	}
}

function runOne(action, sceneCtrl, protocol) {
	switch (action.type) {
		case 'wave':
			sceneCtrl?.playAnimationByHint?.('wave', { duration: 1500 });
			return;
		case 'lookAt': {
			const target = action.target === 'model' ? 'center' : action.target;
			sceneCtrl?.lookAt?.(target);
			return;
		}
		case 'playClip':
			if (typeof action.name === 'string') sceneCtrl?.playClipByName?.(action.name);
			return;
		case 'remember':
			if (protocol && typeof action.content === 'string') {
				protocol.emit({
					type: ACTION_TYPES.REMEMBER,
					payload: { type: 'user', content: action.content },
				});
			}
			return;
		default:
			console.warn('[talking-agent] unknown action type:', action.type);
	}
}
