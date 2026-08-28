/*
 * A body for the companion, in any web page.
 *
 *   import { createCompanionClient, createCompanionStage } from '@three-ws/companion';
 *
 *   const client = createCompanionClient({ token });
 *   const stage  = createCompanionStage({ client, corner: 'bottom-right' });
 *   stage.listen();   // deliveries now arrive in person, with a voice
 *
 * What it puts on the page: one <agent-3d> element (the published three.ws web
 * component, loaded on demand from the same origin the API lives on) and one
 * speech bubble. When a delivery arrives the stage swaps to whatever body that
 * message should be delivered by (the sender's own avatar when the user gave
 * them one), speaks the line, holds it long enough to read, and gets out.
 *
 * Everything degrades rather than disappears: a page with no WebGL still shows
 * the bubble, a browser that blocks autoplay still shows the text, and a device
 * with no hosted voice available falls back to the browser's own speech.
 */

const STYLE_ID = 'three-ws-companion-stage-style';
const ELEMENT_SRC = '/agent-3d/latest/agent-3d.js';
const DEFAULT_AVATAR = '/avatars/michelle.glb';

const CSS = `
.twsc-stage{position:fixed;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;transition:opacity .35s ease,transform .35s ease;opacity:0;transform:translateY(12px)}
.twsc-stage[data-visible="1"]{opacity:1;transform:translateY(0)}
.twsc-stage[data-corner="bottom-right"]{right:18px;bottom:18px;align-items:flex-end}
.twsc-stage[data-corner="bottom-left"]{left:18px;bottom:18px;align-items:flex-start}
.twsc-stage[data-corner="top-right"]{right:18px;top:18px;align-items:flex-end}
.twsc-stage[data-corner="top-left"]{left:18px;top:18px;align-items:flex-start}
.twsc-bubble{pointer-events:auto;max-width:340px;background:rgba(18,18,20,.94);color:#f2f4f8;border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:14px 16px;font:500 14px/1.5 Inter,system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.45);backdrop-filter:blur(10px)}
.twsc-who{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:rgba(242,244,248,.55);margin-bottom:5px}
.twsc-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.twsc-btn{pointer-events:auto;font:600 12px/1 Inter,system-ui,sans-serif;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:7px 11px;cursor:pointer;transition:background .15s,border-color .15s}
.twsc-btn:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3)}
.twsc-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
.twsc-body{pointer-events:auto;width:220px;height:280px;display:block}
@media (prefers-reduced-motion:reduce){.twsc-stage{transition:none}}
@media (prefers-color-scheme:light){.twsc-bubble{background:rgba(255,255,255,.96);color:#14161a;border-color:rgba(0,0,0,.1);box-shadow:0 18px 50px rgba(0,0,0,.18)}.twsc-who{color:rgba(20,22,26,.55)}.twsc-btn{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.12)}}
`;

function injectStyle(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	doc.head.appendChild(style);
}

function loadElement(doc, apiBase) {
	if (customElements.get('agent-3d')) return Promise.resolve(true);
	const src = `${apiBase}${ELEMENT_SRC}`;
	if (!doc.querySelector(`script[src="${src}"]`)) {
		const script = doc.createElement('script');
		script.type = 'module';
		script.src = src;
		doc.head.appendChild(script);
	}
	return customElements.whenDefined('agent-3d').then(() => true).catch(() => false);
}

/** How long a line stays up, scaled to its length. */
export function holdMsFor(text, { base = 5200, perChar = 55, max = 14_000 } = {}) {
	return Math.min(max, base + String(text || '').length * perChar);
}

/**
 * @param {object} options
 * @param {object} [options.client] a createCompanionClient() instance, for listen().
 * @param {string} [options.apiBase='https://three.ws'] origin for the element and voice.
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [options.corner]
 * @param {string} [options.defaultAvatarUrl] body used when a sender has none.
 * @param {boolean} [options.voice=true] speak the line as well as showing it.
 * @param {Document} [options.document]
 * @param {(delivery:object) => void} [options.onOpen] clicked "Open".
 */
export function createCompanionStage({
	client = null,
	apiBase = 'https://three.ws',
	corner = 'bottom-right',
	defaultAvatarUrl = null,
	voice = true,
	document: doc = typeof document !== 'undefined' ? document : null,
	onOpen = null,
} = {}) {
	if (!doc) throw new Error('createCompanionStage needs a document (browser or Electron renderer)');
	const base = String(apiBase).replace(/\/+$/, '');

	injectStyle(doc);

	const root = doc.createElement('div');
	root.className = 'twsc-stage';
	root.dataset.corner = corner;
	root.setAttribute('role', 'status');
	root.setAttribute('aria-live', 'polite');

	const bubble = doc.createElement('div');
	bubble.className = 'twsc-bubble';
	bubble.hidden = true;

	const body = doc.createElement('agent-3d');
	body.className = 'twsc-body';
	body.setAttribute('background', 'transparent');
	body.setAttribute('src', defaultAvatarUrl || `${base}${DEFAULT_AVATAR}`);

	root.append(bubble, body);
	doc.body.appendChild(root);
	loadElement(doc, base);

	let audio = null;
	let hideTimer = null;
	let stopStream = null;
	const queue = [];
	let performing = false;

	function stopAudio() {
		if (audio) {
			audio.pause();
			audio.src = '';
			audio = null;
		}
		try {
			window.speechSynthesis?.cancel();
		} catch {
			/* no speech synthesis here */
		}
	}

	async function say(text, voiceId) {
		if (!voice) return 'muted';
		try {
			const res = await fetch(`${base}/api/tts/speak`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ text, voice: voiceId || 'alloy', format: 'mp3' }),
			});
			if (!res.ok) throw new Error(`tts ${res.status}`);
			const blob = await res.blob();
			if (!blob.size) throw new Error('empty clip');
			audio = new Audio(URL.createObjectURL(blob));
			await audio.play();
			return 'tts';
		} catch {
			try {
				if (!window.speechSynthesis) return 'silent';
				window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
				return 'browser';
			} catch {
				return 'silent';
			}
		}
	}

	function show(delivery) {
		const line = delivery.spoken_line || delivery.title || '';
		bubble.innerHTML = '';
		const who = doc.createElement('div');
		who.className = 'twsc-who';
		who.textContent = delivery.speaker || delivery.sender || 'Your companion';
		const text = doc.createElement('div');
		text.textContent = line;
		bubble.append(who, text);

		const actions = doc.createElement('div');
		actions.className = 'twsc-actions';
		if (delivery.url) {
			const open = doc.createElement('button');
			open.type = 'button';
			open.className = 'twsc-btn';
			open.textContent = 'Open';
			open.addEventListener('click', () => (onOpen ? onOpen(delivery) : window.open(delivery.url, '_blank', 'noopener')));
			actions.appendChild(open);
		}
		const dismiss = doc.createElement('button');
		dismiss.type = 'button';
		dismiss.className = 'twsc-btn';
		dismiss.textContent = 'Got it';
		dismiss.addEventListener('click', () => hide());
		actions.appendChild(dismiss);
		bubble.appendChild(actions);

		bubble.hidden = false;
		root.dataset.visible = '1';
		if (delivery.avatar_glb_url) body.setAttribute('src', delivery.avatar_glb_url);
	}

	function hide() {
		clearTimeout(hideTimer);
		stopAudio();
		root.dataset.visible = '0';
		hideTimer = setTimeout(() => {
			bubble.hidden = true;
			if (defaultAvatarUrl) body.setAttribute('src', defaultAvatarUrl);
		}, 400);
	}

	async function performNext() {
		if (performing) return;
		const delivery = queue.shift();
		if (!delivery) return;
		performing = true;
		show(delivery);
		const line = delivery.spoken_line || delivery.title || '';
		await say(line, delivery.voice);
		await new Promise((resolve) => {
			hideTimer = setTimeout(resolve, holdMsFor(line));
		});
		hide();
		performing = false;
		if (queue.length) setTimeout(performNext, 700);
	}

	return {
		element: root,

		/** Perform one delivery now (or queue it behind the current one). */
		deliver(delivery) {
			queue.push(delivery);
			performNext();
			return this;
		},

		/** Subscribe to the live stream and perform everything that arrives. */
		listen({ onError = null } = {}) {
			if (!client) throw new Error('createCompanionStage({ client }) is required to listen()');
			stopStream = client.stream({
				onDelivery: (delivery) => {
					this.deliver(delivery);
					client.markDelivered(delivery.id).catch(() => {});
				},
				onError,
			});
			return this;
		},

		hide,

		/** Remove the stage and stop everything it owns. */
		destroy() {
			stopStream?.();
			clearTimeout(hideTimer);
			stopAudio();
			root.remove();
		},
	};
}
