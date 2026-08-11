/**
 * @three-ws/assistant core loader.
 *
 * The launcher button and panel live on the host page; the avatar, chat, and
 * text-to-speech all run inside an iframe on three.ws (`/assistant-frame`), so
 * the host page never sees model keys and the frame never sees the host DOM.
 * This module is just the thin host-side shell: it renders the floating
 * launcher, mounts the iframe, and bridges a small postMessage protocol.
 *
 * Every config value is re-validated inside the frame, so this loader only
 * forwards it. The module has no dependencies and touches the DOM only at call
 * time, so it imports cleanly in Node for unit tests.
 */

/** Config keys forwarded to the frame as query params, in emit order. */
export const CHANNEL = 'three-assistant';

export const PARAM_KEYS = [
	'avatar',
	'agent',
	'bg',
	'mode',
	'accent',
	'name',
	'greeting',
	'context',
	'voice',
	'badge',
	'targetOrigin',
];

const Z = 2147483000; // near-max, below common cookie banners' max int
const DEFAULT_ACCENT = '#f97316';

/** True for a #rgb / #rrggbb / #rrggbbaa hex color. */
export function isHex(value) {
	return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/**
 * Build the `/assistant-frame` URL for a config.
 * @param {object} config
 * @param {string} origin  where the frame is hosted (e.g. https://three.ws)
 * @param {string} [hostOrigin]  the embedding page's origin, pinned as the
 *   frame's postMessage target. Defaults to the live `location.origin`.
 */
export function frameUrl(config, origin, hostOrigin) {
	const params = new URLSearchParams();
	for (const key of PARAM_KEYS) {
		const value = config[key];
		if (value === undefined || value === null || value === '') continue;
		params.set(key, typeof value === 'boolean' ? String(value) : String(value));
	}
	if (!params.has('targetOrigin')) {
		const host = hostOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
		if (host) params.set('targetOrigin', host);
	}
	const qs = params.toString();
	return `${origin}/assistant-frame${qs ? `?${qs}` : ''}`;
}

const SPARK_SVG =
	'<svg class="ta-icon-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
	'<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z"/>' +
	'<path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" opacity=".7"/></svg>';
const CLOSE_SVG =
	'<svg class="ta-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
	'stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function injectStyles(accent) {
	if (document.getElementById('three-assistant-style')) return;
	const css =
		'.three-assistant-launcher{position:fixed;bottom:20px;width:56px;height:56px;' +
		`border-radius:50%;border:0;cursor:pointer;z-index:${Z};` +
		`background:${accent};color:#fff;display:flex;align-items:center;justify-content:center;` +
		'box-shadow:0 6px 24px rgba(0,0,0,.32),0 2px 6px rgba(0,0,0,.24);padding:0;' +
		'transition:transform .18s ease,box-shadow .18s ease,filter .18s ease;}' +
		'.three-assistant-launcher:hover{transform:translateY(-2px);filter:brightness(1.08);' +
		'box-shadow:0 10px 30px rgba(0,0,0,.38),0 3px 8px rgba(0,0,0,.26);}' +
		'.three-assistant-launcher:active{transform:scale(.94);}' +
		'.three-assistant-launcher:focus-visible{outline:3px solid #fff;outline-offset:2px;}' +
		'.three-assistant-launcher svg{width:24px;height:24px;transition:transform .22s ease,opacity .18s ease;position:absolute;}' +
		'.three-assistant-launcher .ta-icon-close{opacity:0;transform:rotate(-45deg) scale(.6);}' +
		'.three-assistant-launcher[data-open="true"] .ta-icon-spark{opacity:0;transform:rotate(45deg) scale(.6);}' +
		'.three-assistant-launcher[data-open="true"] .ta-icon-close{opacity:1;transform:rotate(0) scale(1);}' +
		'.three-assistant-panel{position:fixed;bottom:90px;width:380px;max-width:calc(100vw - 24px);' +
		`height:640px;max-height:calc(100dvh - 110px);z-index:${Z};` +
		'border-radius:20px;overflow:hidden;' +
		// visibility, not opacity alone: an opacity-0 panel still holds its
		// iframe in the tab order, so a keyboard visitor lands inside an
		// invisible widget. It turns visible instantly on open and only after
		// the fade on close.
		'opacity:0;visibility:hidden;transform:translateY(14px) scale(.98);pointer-events:none;' +
		'transition:opacity .22s ease,transform .22s ease,visibility 0s linear .22s;' +
		'transform-origin:bottom right;}' +
		'.three-assistant-panel[data-pos="left"]{transform-origin:bottom left;}' +
		'.three-assistant-panel[data-open="true"]{opacity:1;visibility:visible;' +
		'transform:translateY(0) scale(1);pointer-events:auto;' +
		'transition:opacity .22s ease,transform .22s ease,visibility 0s;}' +
		'.three-assistant-panel[data-chrome="solid"]{background:#0a0a0c;' +
		'border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 64px rgba(0,0,0,.5);}' +
		'.three-assistant-panel iframe{width:100%;height:100%;border:0;display:block;background:transparent;color-scheme:normal;}' +
		'@media (max-width:480px){.three-assistant-panel{width:calc(100vw - 24px);height:calc(100dvh - 110px);}}' +
		'@media (prefers-reduced-motion:reduce){.three-assistant-launcher,.three-assistant-panel,' +
		'.three-assistant-launcher svg{transition:none;}}';
	const style = document.createElement('style');
	style.id = 'three-assistant-style';
	style.textContent = css;
	document.head.appendChild(style);
}

/**
 * One mounted widget: launcher + panel + iframe + the postMessage bridge.
 * Not constructed directly; use the API returned by {@link createAssistant}.
 */
export class Assistant {
	/**
	 * @param {object} config
	 * @param {{ origin: string, onDestroy?: (a: Assistant) => void }} ctx
	 */
	constructor(config, ctx) {
		this.config = config || {};
		this.origin = ctx.origin;
		this._onDestroy = ctx.onDestroy;
		this.isOpen = false;
		this._queuedSays = [];
		this._ready = false;

		const accent = isHex(this.config.accent) ? this.config.accent : DEFAULT_ACCENT;
		const pos = this.config.position === 'left' ? 'left' : 'right';
		injectStyles(accent);

		const launcher = document.createElement('button');
		launcher.type = 'button';
		launcher.className = 'three-assistant-launcher';
		launcher.style[pos] = '20px';
		launcher.dataset.open = 'false';
		launcher.setAttribute('aria-label', `Open ${this.config.name || 'assistant'}`);
		launcher.setAttribute('aria-expanded', 'false');
		launcher.setAttribute('aria-haspopup', 'dialog');
		launcher.innerHTML = SPARK_SVG + CLOSE_SVG;

		const panel = document.createElement('div');
		panel.className = 'three-assistant-panel';
		panel.style[pos] = '12px';
		panel.dataset.open = 'false';
		panel.dataset.pos = pos;
		// Transparent background lets the avatar float straight over the page; any
		// solid or gradient background gets a real panel chrome around the frame.
		const bg = String(this.config.bg == null ? '' : this.config.bg).toLowerCase();
		panel.dataset.chrome = !bg || bg === 'transparent' ? 'clear' : 'solid';
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', this.config.name || 'Assistant');
		// Belt and braces with the CSS above on browsers that support it: a
		// closed panel is inert, so nothing inside it is focusable or announced.
		panel.inert = true;

		const iframe = document.createElement('iframe');
		iframe.title = `${this.config.name || 'Assistant'} 3D avatar assistant`;
		iframe.allow = 'autoplay';
		iframe.setAttribute('allowtransparency', 'true');
		iframe.loading = 'lazy';
		iframe.src = frameUrl(this.config, this.origin);
		panel.appendChild(iframe);

		launcher.addEventListener('click', () => this.toggle());

		this._onMessage = (event) => {
			if (event.origin !== this.origin) return;
			if (event.source !== iframe.contentWindow) return;
			const msg = event.data;
			if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return;
			if (msg.type === 'close') {
				this.close();
				return;
			}
			if (msg.type === 'ready') {
				this._ready = true;
				for (const say of this._queuedSays) this._post('say', say);
				this._queuedSays.length = 0;
			}
			this._emit(msg.type, msg.payload);
		};
		window.addEventListener('message', this._onMessage);

		this._onKeydown = (e) => {
			if (e.key === 'Escape' && this.isOpen) this.close();
		};
		window.addEventListener('keydown', this._onKeydown);

		this.launcher = launcher;
		this.panel = panel;
		this.iframe = iframe;

		document.body.appendChild(panel);
		document.body.appendChild(launcher);

		if (this.config.open) this.open();
	}

	_emit(type, payload) {
		try {
			window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { type, payload: payload || {} } }));
		} catch {
			/* CustomEvent unavailable */
		}
	}

	_post(type, payload) {
		try {
			this.iframe.contentWindow.postMessage(
				{ channel: CHANNEL, v: 1, type, payload: payload || {} },
				this.origin,
			);
		} catch {
			/* frame gone mid-navigation */
		}
	}

	open() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.panel.inert = false;
		this.panel.dataset.open = 'true';
		this.launcher.dataset.open = 'true';
		this.launcher.setAttribute('aria-expanded', 'true');
		this.launcher.setAttribute('aria-label', `Close ${this.config.name || 'assistant'}`);
		const iframe = this.iframe;
		setTimeout(() => {
			try {
				iframe.focus();
			} catch {
				/* focus can throw across a not-yet-loaded frame */
			}
		}, 240);
		this._emit('open', {});
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.panel.inert = true;
		this.panel.dataset.open = 'false';
		this.launcher.dataset.open = 'false';
		this.launcher.setAttribute('aria-expanded', 'false');
		this.launcher.setAttribute('aria-label', `Open ${this.config.name || 'assistant'}`);
		try {
			this.launcher.focus();
		} catch {
			/* launcher already removed */
		}
		this._emit('close', {});
	}

	toggle() {
		if (this.isOpen) this.close();
		else this.open();
	}

	/** Open the widget and speak `text` aloud in the avatar's voice. */
	say(text) {
		const clean = String(text == null ? '' : text).slice(0, 600);
		if (!clean) return;
		this.open();
		if (this._ready) this._post('say', { text: clean });
		else this._queuedSays.push({ text: clean });
	}

	/** Switch mode ('chat' | 'speak'); only applies when mounted with mode 'both'. */
	setMode(mode) {
		this._post('setMode', { mode });
	}

	destroy() {
		window.removeEventListener('message', this._onMessage);
		window.removeEventListener('keydown', this._onKeydown);
		this.panel.remove();
		this.launcher.remove();
		this._onDestroy?.(this);
	}
}

/**
 * Create an assistant API bound to a frame `origin`. There is one live instance
 * per API; `init()` replaces any previous one. `say()` before the frame is
 * ready is queued and flushed on ready.
 *
 * @param {{ origin?: string }} [opts]  where the frame is hosted; defaults to
 *   https://three.ws. A config passed to `init` may override it per call.
 */
export function createAssistant(opts = {}) {
	const defaultOrigin = opts.origin || 'https://three.ws';
	let instance = null;

	const api = {
		version: '1.0.0',
		get origin() {
			return defaultOrigin;
		},
		get instance() {
			return instance;
		},
		init(config = {}) {
			if (instance) instance.destroy();
			const origin = config.origin || defaultOrigin;
			instance = new Assistant(config, {
				origin,
				onDestroy: (a) => {
					if (instance === a) instance = null;
				},
			});
			return instance;
		},
		open() {
			instance?.open();
		},
		close() {
			instance?.close();
		},
		toggle() {
			instance?.toggle();
		},
		say(text) {
			instance?.say(text);
		},
		setMode(mode) {
			instance?.setMode(mode);
		},
		destroy() {
			instance?.destroy();
		},
	};
	return api;
}

/**
 * Read a `<script data-*>` tag's assistant config into a plain object.
 * Used by the CDN auto-mount; exported so hosts can reuse it.
 */
export function configFromScript(script) {
	const config = {};
	if (!script) return config;
	for (const key of PARAM_KEYS) {
		const v = script.getAttribute(`data-${key.toLowerCase()}`);
		if (v !== null) config[key] = v;
	}
	const position = script.getAttribute('data-position');
	if (position) config.position = position;
	if (script.hasAttribute('data-open')) config.open = true;
	return config;
}
