/**
 * three.ws — assistant widget v1
 *
 * A 3D avatar assistant on any website, in one script tag:
 *
 *   <script src="https://three.ws/assistant/v1.js" async></script>
 *
 * Configured entirely via data attributes:
 *
 *   <script src="https://three.ws/assistant/v1.js" async
 *     data-avatar="selfie-girl"        (avatar id or GLB URL)
 *     data-bg="transparent"            (transparent | #hex | ember|ocean|violet|forest|dusk|slate | gradient:#a,#b,angle)
 *     data-mode="both"                 (chat | speak | both)
 *     data-accent="#f97316"
 *     data-name="Atelier AI"
 *     data-greeting="Ask anything about Atelier."
 *     data-context="Atelier is a design studio for ..."
 *     data-position="right"            (right | left)
 *     data-open                        (start open)
 *   ></script>
 *
 * Or programmatic:
 *
 *   ThreeAssistant.init({ avatar: 'selfie-girl', name: 'Atelier AI' });
 *   ThreeAssistant.open(); ThreeAssistant.close(); ThreeAssistant.toggle();
 *   ThreeAssistant.say('Welcome!');   // avatar speaks it out loud
 *   ThreeAssistant.setMode('speak');
 *   ThreeAssistant.destroy();
 *
 * The launcher button + panel live on the host page; the avatar, chat, and
 * speech run inside an iframe on three.ws (/assistant-frame), so the host
 * page never sees API keys and the frame never sees the host DOM. All config
 * params are re-validated inside the frame — this loader just forwards them.
 *
 * Events (host side):  window.addEventListener('three-assistant', (e) => ...)
 *   e.detail = { type: 'ready'|'open'|'close'|'message'|'speak:start'|'speak:end'|'error', payload }
 */

(function () {
	'use strict';

	if (window.__threeWsAssistantV1) return; // idempotent — multiple includes are safe
	window.__threeWsAssistantV1 = true;

	var ORIGIN = (function () {
		try {
			return new URL(document.currentScript.src).origin;
		} catch (_) {
			return 'https://three.ws';
		}
	})();

	var CHANNEL = 'three-assistant';
	var PARAM_KEYS = [
		'avatar', 'agent', 'bg', 'mode', 'accent', 'name',
		'greeting', 'context', 'voice', 'badge', 'targetOrigin',
	];

	var Z = 2147483000; // near-max, below common cookie banners' max int

	var instance = null;

	function isHex(v) {
		return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
	}

	function frameUrl(config) {
		var params = new URLSearchParams();
		for (var i = 0; i < PARAM_KEYS.length; i++) {
			var key = PARAM_KEYS[i];
			var value = config[key];
			if (value === undefined || value === null || value === '') continue;
			params.set(key, typeof value === 'boolean' ? String(value) : String(value));
		}
		// Pin outbound frame messages to this page unless the caller overrode it.
		if (!params.has('targetOrigin')) params.set('targetOrigin', location.origin);
		var qs = params.toString();
		return ORIGIN + '/assistant-frame' + (qs ? '?' + qs : '');
	}

	function emit(type, payload) {
		try {
			window.dispatchEvent(new CustomEvent(CHANNEL, { detail: { type: type, payload: payload || {} } }));
		} catch (_) {}
	}

	// ── Styles (injected once) ─────────────────────────────────────────────
	function injectStyles(accent) {
		if (document.getElementById('three-assistant-style')) return;
		var css = ''
			+ '.three-assistant-launcher{position:fixed;bottom:20px;width:56px;height:56px;'
			+ 'border-radius:50%;border:0;cursor:pointer;z-index:' + Z + ';'
			+ 'background:' + accent + ';color:#fff;display:flex;align-items:center;justify-content:center;'
			+ 'box-shadow:0 6px 24px rgba(0,0,0,.32),0 2px 6px rgba(0,0,0,.24);padding:0;'
			+ 'transition:transform .18s ease,box-shadow .18s ease,filter .18s ease;}'
			+ '.three-assistant-launcher:hover{transform:translateY(-2px);filter:brightness(1.08);'
			+ 'box-shadow:0 10px 30px rgba(0,0,0,.38),0 3px 8px rgba(0,0,0,.26);}'
			+ '.three-assistant-launcher:active{transform:scale(.94);}'
			+ '.three-assistant-launcher:focus-visible{outline:3px solid #fff;outline-offset:2px;}'
			+ '.three-assistant-launcher svg{width:24px;height:24px;transition:transform .22s ease,opacity .18s ease;position:absolute;}'
			+ '.three-assistant-launcher .ta-icon-close{opacity:0;transform:rotate(-45deg) scale(.6);}'
			+ '.three-assistant-launcher[data-open="true"] .ta-icon-spark{opacity:0;transform:rotate(45deg) scale(.6);}'
			+ '.three-assistant-launcher[data-open="true"] .ta-icon-close{opacity:1;transform:rotate(0) scale(1);}'
			+ '.three-assistant-panel{position:fixed;bottom:90px;width:380px;max-width:calc(100vw - 24px);'
			+ 'height:640px;max-height:calc(100dvh - 110px);z-index:' + Z + ';'
			+ 'border-radius:20px;overflow:hidden;'
			+ 'opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;'
			+ 'transition:opacity .22s ease,transform .22s ease;transform-origin:bottom right;}'
			+ '.three-assistant-panel[data-pos="left"]{transform-origin:bottom left;}'
			+ '.three-assistant-panel[data-open="true"]{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}'
			+ '.three-assistant-panel[data-chrome="solid"]{background:#0a0a0c;'
			+ 'border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 64px rgba(0,0,0,.5);}'
			+ '.three-assistant-panel iframe{width:100%;height:100%;border:0;display:block;background:transparent;color-scheme:normal;}'
			+ '@media (max-width:480px){.three-assistant-panel{width:calc(100vw - 24px);height:calc(100dvh - 110px);}}'
			+ '@media (prefers-reduced-motion:reduce){.three-assistant-launcher,.three-assistant-panel,'
			+ '.three-assistant-launcher svg{transition:none;}}';
		var style = document.createElement('style');
		style.id = 'three-assistant-style';
		style.textContent = css;
		document.head.appendChild(style);
	}

	var SPARK_SVG =
		'<svg class="ta-icon-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
		+ '<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z"/>'
		+ '<path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" opacity=".7"/></svg>';
	var CLOSE_SVG =
		'<svg class="ta-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" '
		+ 'stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';

	// ── Instance ───────────────────────────────────────────────────────────
	function Assistant(config) {
		this.config = config;
		this.isOpen = false;
		this._queuedSays = [];
		this._ready = false;

		var accent = isHex(config.accent) ? config.accent : '#f97316';
		var pos = config.position === 'left' ? 'left' : 'right';
		injectStyles(accent);

		var launcher = document.createElement('button');
		launcher.type = 'button';
		launcher.className = 'three-assistant-launcher';
		launcher.style[pos] = '20px';
		launcher.dataset.open = 'false';
		launcher.setAttribute('aria-label', 'Open ' + (config.name || 'assistant'));
		launcher.setAttribute('aria-expanded', 'false');
		launcher.setAttribute('aria-haspopup', 'dialog');
		launcher.innerHTML = SPARK_SVG + CLOSE_SVG;

		var panel = document.createElement('div');
		panel.className = 'three-assistant-panel';
		panel.style[pos] = '12px';
		panel.dataset.open = 'false';
		panel.dataset.pos = pos;
		// Transparent background → the avatar floats straight over the page;
		// any solid/gradient bg gets a real panel chrome around the frame.
		var bg = String(config.bg == null ? '' : config.bg).toLowerCase();
		panel.dataset.chrome = !bg || bg === 'transparent' ? 'clear' : 'solid';
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', config.name || 'Assistant');

		var iframe = document.createElement('iframe');
		iframe.title = (config.name || 'Assistant') + ' — 3D avatar assistant';
		iframe.allow = 'autoplay';
		iframe.setAttribute('allowtransparency', 'true');
		iframe.loading = 'lazy';
		iframe.src = frameUrl(config);
		panel.appendChild(iframe);

		var self = this;
		launcher.addEventListener('click', function () {
			self.toggle();
		});

		this._onMessage = function (event) {
			if (event.origin !== ORIGIN) return;
			if (event.source !== iframe.contentWindow) return;
			var msg = event.data;
			if (!msg || typeof msg !== 'object' || msg.channel !== CHANNEL) return;
			if (msg.type === 'close') {
				self.close();
				return;
			}
			if (msg.type === 'ready') {
				self._ready = true;
				for (var i = 0; i < self._queuedSays.length; i++) self._post('say', self._queuedSays[i]);
				self._queuedSays.length = 0;
			}
			emit(msg.type, msg.payload);
		};
		window.addEventListener('message', this._onMessage);

		this._onKeydown = function (e) {
			if (e.key === 'Escape' && self.isOpen) self.close();
		};
		window.addEventListener('keydown', this._onKeydown);

		this.launcher = launcher;
		this.panel = panel;
		this.iframe = iframe;

		document.body.appendChild(panel);
		document.body.appendChild(launcher);

		if (config.open) this.open();
	}

	Assistant.prototype._post = function (type, payload) {
		try {
			this.iframe.contentWindow.postMessage(
				{ channel: CHANNEL, v: 1, type: type, payload: payload || {} },
				ORIGIN,
			);
		} catch (_) {}
	};

	Assistant.prototype.open = function () {
		if (this.isOpen) return;
		this.isOpen = true;
		this.panel.dataset.open = 'true';
		this.launcher.dataset.open = 'true';
		this.launcher.setAttribute('aria-expanded', 'true');
		this.launcher.setAttribute('aria-label', 'Close ' + (this.config.name || 'assistant'));
		var iframe = this.iframe;
		setTimeout(function () {
			try {
				iframe.focus();
			} catch (_) {}
		}, 240);
		emit('open', {});
	};

	Assistant.prototype.close = function () {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.panel.dataset.open = 'false';
		this.launcher.dataset.open = 'false';
		this.launcher.setAttribute('aria-expanded', 'false');
		this.launcher.setAttribute('aria-label', 'Open ' + (this.config.name || 'assistant'));
		try {
			this.launcher.focus();
		} catch (_) {}
		emit('close', {});
	};

	Assistant.prototype.toggle = function () {
		if (this.isOpen) this.close();
		else this.open();
	};

	Assistant.prototype.say = function (text) {
		text = String(text == null ? '' : text).slice(0, 600);
		if (!text) return;
		this.open();
		if (this._ready) this._post('say', { text: text });
		else this._queuedSays.push({ text: text });
	};

	Assistant.prototype.setMode = function (mode) {
		this._post('setMode', { mode: mode });
	};

	Assistant.prototype.destroy = function () {
		window.removeEventListener('message', this._onMessage);
		window.removeEventListener('keydown', this._onKeydown);
		this.panel.remove();
		this.launcher.remove();
		if (instance === this) instance = null;
	};

	// ── Public API ─────────────────────────────────────────────────────────
	var api = {
		version: '1.0.0',
		origin: ORIGIN,
		init: function (config) {
			if (instance) instance.destroy();
			instance = new Assistant(config || {});
			return instance;
		},
		open: function () { if (instance) instance.open(); },
		close: function () { if (instance) instance.close(); },
		toggle: function () { if (instance) instance.toggle(); },
		say: function (text) { if (instance) instance.say(text); },
		setMode: function (mode) { if (instance) instance.setMode(mode); },
		destroy: function () { if (instance) instance.destroy(); },
		get instance() { return instance; },
	};
	window.ThreeAssistant = api;

	// ── Script-tag auto-mount ──────────────────────────────────────────────
	(function autoMount() {
		var s = document.currentScript;
		if (!s) return;
		if (s.hasAttribute('data-manual')) return; // opt out: call ThreeAssistant.init() yourself
		var config = {};
		for (var i = 0; i < PARAM_KEYS.length; i++) {
			var v = s.getAttribute('data-' + PARAM_KEYS[i].toLowerCase());
			if (v !== null) config[PARAM_KEYS[i]] = v;
		}
		var position = s.getAttribute('data-position');
		if (position) config.position = position;
		if (s.hasAttribute('data-open')) config.open = true;
		var boot = function () { api.init(config); };
		if (document.body) boot();
		else document.addEventListener('DOMContentLoaded', boot);
	})();
})();
