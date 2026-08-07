// Talk to the townsfolk — the conversational layer over the interactive NPCs.
//
// Ambient life (movement, crowd chatter) stays deterministic and code-driven; no
// model runs for that. But when a player walks up and presses E, this opens a
// real conversation: the NPC answers in character, streamed live from the same
// multi-model proxy the chats use (/api/brain/chat). The player can switch the
// model mid-conversation from the picker, exactly like the brain playground.
//
// Each NPC carries a `persona` (its voice) and, for vendors, a `serviceId` that
// links to the paid counter in npc-services.js. The chat knows about the counter
// and surfaces a one-tap button to open it — the NPC talks you toward the sale,
// the counter settles it on-chain. The cast works every coin's town, so the
// prompt is world-aware: the NPC knows which community's plaza it stands in and
// may speak about the local coin factually — but $three stays the only coin it
// ever recommends or promotes.

import { SERVICES, openService, isServicePanelOpen } from './npc-services.js';
import { isHomeTown } from '../home-town.js';
import { log } from '../../shared/log.js';

const THREE = '$three';
const ENDPOINT = '/api/brain/chat';
const PROVIDER_KEY = 'npc-chat:provider'; // remembered model across conversations
const MAX_TOKENS = 512;                   // short, spoken-length replies
const HISTORY_CAP = 24;                    // turns kept in the model context

// ── tiny DOM helper (self-contained; mirrors npc-services.js conventions) ──────
function el(tag, attrs, kids) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === 'class') node.className = v;
			else if (k === 'text') node.textContent = v;
			else if (k === 'html') node.innerHTML = v;
			else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
			else node.setAttribute(k, v === true ? '' : v);
		}
	}
	for (const kid of [].concat(kids || [])) {
		if (kid == null || kid === false) continue;
		node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return node;
}

// ── provider list (fetched once, cached) ──────────────────────────────────────
// The same models the chats expose. We surface every configured one and let the
// player pick; unconfigured providers are shown disabled so the roster reads true.
let providersPromise = null;
function loadProviders() {
	if (!providersPromise) {
		providersPromise = fetch(ENDPOINT, { method: 'GET' })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((j) => (Array.isArray(j.providers) ? j.providers : []))
			.catch((e) => { providersPromise = null; log.warn('[npc-chat] provider list failed:', e?.message); return []; });
	}
	return providersPromise;
}

function preferredProvider(providers) {
	const saved = (() => { try { return localStorage.getItem(PROVIDER_KEY); } catch { return null; } })();
	const isLive = (k) => providers.some((p) => p.key === k && p.available);
	if (saved && isLive(saved)) return saved;
	const firstLive = providers.find((p) => p.available);
	return firstLive ? firstLive.key : (providers[0]?.key || 'gpt-oss-120b');
}

// ── persona → system prompt ───────────────────────────────────────────────────
// The prompt hard-locks the NPC to its character and to $three as the only
// promoted coin, and — for vendors — teaches it about its own counter so it can
// guide the sale. In another coin's town, the NPC knows whose plaza it works and
// may discuss that coin factually; it still only ever recommends $three.
function buildSystemPrompt({ npc, svc, persona, greeting, world }) {
	const localCoin = world && world.mint && !isHomeTown(world.mint)
		? (world.symbol ? '$' + String(world.symbol).toUpperCase() : (world.name || null))
		: null;
	const town = localCoin
		? `the ${localCoin} community's town inside three.ws — a 3D world platform whose own coin is ${THREE}`
		: `a frontier town inside three.ws — a 3D world platform built around ${THREE}, the one and only coin`;
	const parts = [
		`You are ${npc.name}, a character who lives and works in ${town}.`,
		persona,
		`A visitor has just walked up to you in the town square and started talking. Speak out loud, in character, the way this person really talks — voice, mood, and all.`,
		`Keep every reply short and natural: usually one to three sentences, like real spoken dialogue. No lists, no headings, no markdown, no stage directions. Stay curious — ask the visitor things back.`,
	];
	if (svc) {
		parts.push(
			`Your trade is the "${svc.title}" counter you run right here (${svc.price}). ${svc.intro} You cannot run it from conversation — when the visitor wants it, tell them to tap the "${svc.action}" button to open your counter and pay from their wallet.`,
		);
	}
	if (greeting) parts.push(`You already greeted them with: "${greeting}". Continue naturally from there — don't greet again.`);
	parts.push(
		localCoin
			? `Rules you never break: stay fully in character; never say or imply you are an AI, a model, a bot, or a program. ${localCoin} is this town's own coin — you may speak about it factually as the local coin. ${THREE} is the platform's coin and the only coin you ever recommend or promote. Never mention, name, link, or recommend any other coin or token; if asked about one, brush it off.`
			: `Rules you never break: stay fully in character; never say or imply you are an AI, a model, a bot, or a program; never mention, name, link, or recommend any coin or token other than ${THREE}. If asked about any other coin, brush it off and bring it back to ${THREE}.`,
	);
	return parts.filter(Boolean).join('\n\n');
}

// ── SSE streaming (matches the /api/brain/chat protocol used by the brain page) ─
async function streamReply({ provider, messages, system, signal, onChunk, onDone, onError }) {
	let res;
	try {
		res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal,
			body: JSON.stringify({ provider, messages, system, maxTokens: MAX_TOKENS }),
		});
	} catch (err) {
		if (err?.name !== 'AbortError') onError?.(err?.message || 'Network error');
		return;
	}
	if (!res.ok || !res.body) {
		let msg = `HTTP ${res.status}`;
		try { const j = await res.json(); msg = j.message || j.error || msg; } catch { /* non-JSON body */ }
		onError?.(msg);
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let gotDone = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const event = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let evType = 'message', data = '';
				for (const line of event.split('\n')) {
					if (line.startsWith('event:')) evType = line.slice(6).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (evType === 'message' && data && data !== '[DONE]') {
					try { onChunk?.(JSON.parse(data)); } catch { /* malformed chunk */ }
				} else if (evType === 'done') {
					gotDone = true;
					try { onDone?.(JSON.parse(data)); } catch { onDone?.({}); }
				} else if (evType === 'error') {
					try { onError?.(JSON.parse(data).message || 'upstream error'); } catch { onError?.('upstream error'); }
				}
			}
		}
	} catch (err) {
		if (err?.name !== 'AbortError') onError?.(err?.message || 'stream error');
	} finally {
		if (!gotDone) onDone?.({});
	}
}

// ── panel ──────────────────────────────────────────────────────────────────────
let openPanel = null; // single live conversation at a time

export function isChatPanelOpen() { return !!openPanel; }

function closeChat() {
	if (!openPanel) return;
	const { overlay, onKey, opener, abort, onClose } = openPanel;
	abort?.abort();
	document.removeEventListener('keydown', onKey, true);
	overlay.classList.remove('is-in');
	const node = overlay;
	setTimeout(() => node.remove(), 180);
	openPanel = null;
	if (opener && typeof opener.focus === 'function') opener.focus();
	try { onClose?.(); } catch { /* caller cleanup failed; the panel is gone regardless */ }
}

// Open a conversation with `npc`. Opts:
//   serviceId  links to a SERVICES counter (vendors)
//   persona    the character voice baked into the system prompt
//   greeting   the line already spoken in-world (seeds the log + prompt)
//   role       header sub-label override (defaults to the townsperson label)
//   onClose    called once when the panel closes, however it closes
export function openChat(npc, { ui, serviceId, persona, greeting, world, role, onClose } = {}) {
	closeChat();
	const svc = serviceId ? SERVICES[serviceId] : null;

	// model context: real user/assistant turns only (the greeting is display-only,
	// kept out of the payload so the history always opens on a user turn).
	const history = [];
	const system = buildSystemPrompt({ npc, svc, persona, greeting, world });
	let provider = 'gpt-oss-120b';
	let streaming = false;
	const abort = new AbortController();

	const titleId = `npc-chat-title-${npc.id}`;
	const card = el('div', { class: 'npc-chat-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
	const overlay = el('div', { class: 'npc-chat-overlay' }, [card]);
	overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeChat(); });

	// Header — who you're talking to + the model driving them.
	const roleLabel = svc ? `${svc.merchant}` : (role || 'Townsperson · three.ws');
	const modelSelect = el('select', { class: 'npc-chat-model', 'aria-label': 'Model' }, [
		el('option', { value: provider }, ['Loading models…']),
	]);
	const close = el('button', { class: 'npc-chat-close', type: 'button', 'aria-label': 'Close', text: '✕', onclick: closeChat });
	card.appendChild(el('header', { class: 'npc-chat-head' }, [
		el('div', { class: 'npc-chat-id' }, [
			el('div', { id: titleId, class: 'npc-chat-who', text: npc.name }),
			el('div', { class: 'npc-chat-sub', text: roleLabel }),
		]),
		el('div', { class: 'npc-chat-tools' }, [modelSelect, close]),
	]));

	// Vendor: a one-tap chip to open the paid counter mid-conversation.
	if (svc) {
		card.appendChild(el('div', { class: 'npc-chat-offer' }, [
			el('button', {
				class: 'npc-chat-offer-btn', type: 'button',
				onclick: () => { closeChat(); openService(serviceId, { npc, ui }); },
			}, [
				el('span', { class: 'npc-chat-offer-label', text: svc.action }),
				el('span', { class: 'npc-chat-offer-price', text: svc.price }),
			]),
		]));
	}

	const logEl = el('div', { class: 'npc-chat-log', role: 'log', 'aria-live': 'polite' });
	card.appendChild(logEl);

	// Composer.
	const input = el('textarea', {
		class: 'npc-chat-input', rows: '1', maxlength: '600',
		placeholder: `Say something to ${npc.name.split(/[·.]/)[0].trim()}…`, 'aria-label': 'Your message',
	});
	const sendBtn = el('button', { class: 'npc-chat-send', type: 'submit', 'aria-label': 'Send', text: 'Send' });
	const form = el('form', { class: 'npc-chat-composer' }, [input, sendBtn]);
	card.appendChild(form);

	// Keep typing out of the world's movement / interaction handlers.
	const swallow = (e) => e.stopPropagation();
	input.addEventListener('keydown', swallow);
	input.addEventListener('keyup', swallow);
	input.addEventListener('input', () => {
		input.style.height = 'auto';
		input.style.height = Math.min(input.scrollHeight, 120) + 'px';
	});

	function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

	function addBubble(role, text) {
		const bubble = el('div', { class: `npc-chat-msg is-${role}` }, [
			el('div', { class: 'npc-chat-text', text: text || '' }),
		]);
		logEl.appendChild(bubble);
		scrollDown();
		return bubble.querySelector('.npc-chat-text');
	}

	// Seed the conversation with what the NPC already said in-world.
	if (greeting) addBubble('npc', greeting);
	else addBubble('npc', `…`);

	function setBusy(busy) {
		streaming = busy;
		sendBtn.disabled = busy;
		sendBtn.textContent = busy ? '…' : 'Send';
		input.disabled = busy;
	}

	async function send() {
		const text = input.value.trim();
		if (!text || streaming) return;
		input.value = '';
		input.style.height = 'auto';
		addBubble('me', text);
		history.push({ role: 'user', content: text });
		// Keep the context bounded, and always opening on a user turn (Anthropic
		// rejects histories that start with an assistant message).
		while (history.length > HISTORY_CAP) history.shift();
		if (history[0]?.role === 'assistant') history.shift();

		setBusy(true);
		const target = addBubble('npc', '');
		target.parentElement.classList.add('is-typing');
		let acc = '';
		await streamReply({
			provider,
			messages: history.slice(),
			system,
			signal: abort.signal,
			onChunk: (chunk) => {
				acc += chunk;
				target.textContent = acc;
				target.parentElement.classList.remove('is-typing');
				scrollDown();
			},
			onDone: () => {
				target.parentElement.classList.remove('is-typing');
				const reply = acc.trim();
				if (reply) {
					history.push({ role: 'assistant', content: reply });
					npc.say?.(reply.length > 140 ? reply.slice(0, 137) + '…' : reply);
				} else {
					target.parentElement.classList.add('is-error');
					target.textContent = 'They went quiet. Try again.';
				}
				setBusy(false);
				input.focus();
			},
			onError: (msg) => {
				target.parentElement.classList.remove('is-typing');
				target.parentElement.classList.add('is-error');
				target.textContent = /not configured|HTTP 503|api key/i.test(msg)
					? 'That model isn’t available — pick another from the menu.'
					: `Couldn’t reach them: ${msg}`;
				setBusy(false);
				input.focus();
			},
		});
	}

	form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
	});

	// Populate the model picker from the live roster.
	loadProviders().then((providers) => {
		if (openPanel?.overlay !== overlay) return; // panel closed before list arrived
		provider = preferredProvider(providers);
		modelSelect.textContent = '';
		const opts = providers.length ? providers : [{ key: provider, label: provider, network: '', available: true }];
		for (const p of opts) {
			modelSelect.appendChild(el('option', {
				value: p.key, selected: p.key === provider, disabled: !p.available,
			}, [p.available ? p.label : `${p.label} (add key)`]));
		}
		modelSelect.value = provider;
	});
	modelSelect.addEventListener('change', () => {
		provider = modelSelect.value;
		try { localStorage.setItem(PROVIDER_KEY, provider); } catch { /* storage blocked */ }
	});

	// Mount + ESC + focus.
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const onKey = (e) => {
		if (e.key === 'Escape' && !isServicePanelOpen()) { e.stopPropagation(); e.preventDefault(); closeChat(); }
	};
	document.addEventListener('keydown', onKey, true);
	document.body.appendChild(overlay);
	openPanel = { overlay, onKey, opener, abort, onClose };
	requestAnimationFrame(() => {
		overlay.classList.add('is-in');
		input.focus();
	});
}
