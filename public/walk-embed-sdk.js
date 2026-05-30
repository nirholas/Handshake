// walk-embed-sdk.js — one-tag walking-avatar embed for any website.
//
// Usage:
//   <script src="https://three.ws/walk-embed-sdk.js"
//           data-avatar="<uuid>"
//           data-position="bottom-right"
//           data-width="220"
//           data-height="320"
//           data-env="studio"></script>
//
// The script:
//   1. Reads `data-*` attributes off its own <script> tag.
//   2. Injects a fixed-position <iframe> pointing at /walk-embed?... so the
//      avatar appears as a floating 3D character on the host page.
//   3. Exposes `window.ThreeWalkAvatar` with mount / unmount / setAvatar /
//      setSize / setPosition / on / off methods.
//   4. Re-emits postMessage events from the iframe as document-level
//      CustomEvents (`walk:ready`, `walk:position`, `walk:error`,
//      `walk:avatarChanged`) so host code can listen without knowing about
//      postMessage at all.
//
// Standalone — no runtime deps. Safe to embed on any origin; the iframe page
// ships `content-security-policy: frame-ancestors *`.

(function () {
	'use strict';

	// ── Locate self ───────────────────────────────────────────────────────
	// document.currentScript only works while the script is initially
	// executing; once we go async we need a stable handle.
	var SCRIPT = document.currentScript;
	if (!SCRIPT) {
		// Fall back to "the last <script> with our src in the DOM" — covers
		// the case where this file is dynamically inserted.
		var all = document.getElementsByTagName('script');
		for (var i = all.length - 1; i >= 0; i--) {
			var s = all[i];
			if (s.src && /walk-embed-sdk(\.min)?\.js/.test(s.src)) {
				SCRIPT = s;
				break;
			}
		}
	}

	// Derive the embed origin from the SDK script URL so the SDK and the
	// iframe page can be hosted on the same domain (e.g. three.ws), even
	// when the host page is on a totally different one.
	function originFromScript() {
		if (SCRIPT && SCRIPT.src) {
			try { return new URL(SCRIPT.src).origin; } catch (e) {}
		}
		return 'https://three.ws';
	}
	var EMBED_ORIGIN = originFromScript();

	// ── Defaults + script-attribute overrides ─────────────────────────────
	function attr(name, fallback) {
		if (!SCRIPT) return fallback;
		var v = SCRIPT.getAttribute(name);
		return v == null || v === '' ? fallback : v;
	}

	function attrBool(name, fallback) {
		var v = attr(name, null);
		if (v == null) return fallback;
		v = String(v).toLowerCase();
		return v !== 'false' && v !== '0' && v !== 'no';
	}

	// Floating-corner embeds default to no ground disc and no orbit drag —
	// hosts that mount into a full-size container can opt back in with
	// `data-ground="true"` / `data-orbit="true"`.
	var defaults = {
		avatar: attr('data-avatar', ''),
		position: attr('data-position', 'bottom-right'),
		width: parseInt(attr('data-width', '220'), 10) || 220,
		height: parseInt(attr('data-height', '320'), 10) || 320,
		controls: attr('data-controls', 'none'),
		env: attr('data-env', 'studio'),
		autoplay: attrBool('data-autoplay', true),
		ground: attrBool('data-ground', false),
		orbit: attrBool('data-orbit', false),
		bg: attr('data-bg', 'transparent'),
		zIndex: parseInt(attr('data-z-index', '2147483640'), 10) || 2147483640,
	};

	// ── DOM helpers ───────────────────────────────────────────────────────
	function setPositionStyles(el, pos) {
		// Clear any previous corner-anchor.
		el.style.top = el.style.bottom = el.style.left = el.style.right = '';
		var margin = '16px';
		switch (pos) {
			case 'top-left':     el.style.top = margin; el.style.left = margin; break;
			case 'top-right':    el.style.top = margin; el.style.right = margin; break;
			case 'bottom-left':  el.style.bottom = margin; el.style.left = margin; break;
			case 'bottom-right': // fallthrough
			default:             el.style.bottom = margin; el.style.right = margin; break;
		}
	}

	function buildSrc(opts) {
		var p = new URLSearchParams();
		if (opts.avatar) p.set('avatar', opts.avatar);
		p.set('controls', opts.controls);
		if (opts.autoplay) p.set('autoplay', 'true');
		if (opts.ground === false) p.set('ground', 'false');
		if (opts.orbit === false) p.set('orbit', 'false');
		if (opts.bg && opts.bg !== 'transparent') p.set('bg', opts.bg);
		if (opts.env && opts.env !== 'studio') p.set('env', opts.env);
		return EMBED_ORIGIN + '/walk-embed?' + p.toString();
	}

	// ── State ─────────────────────────────────────────────────────────────
	var state = {
		iframe: null,
		container: null,
		options: Object.assign({}, defaults),
		listeners: {}, // event-name → array of host callbacks
	};

	// ── Event bridge ──────────────────────────────────────────────────────
	function emit(name, detail) {
		// Document-level CustomEvent so host code can listen with a one-liner.
		try {
			document.dispatchEvent(new CustomEvent(name, { detail: detail }));
		} catch (e) {}
		// Also fire any callbacks the host registered through the API.
		var arr = state.listeners[name];
		if (arr) {
			for (var i = 0; i < arr.length; i++) {
				try { arr[i](detail); } catch (e) {}
			}
		}
	}

	function onWindowMessage(e) {
		if (!state.iframe || e.source !== state.iframe.contentWindow) return;
		var msg = e.data;
		if (!msg || typeof msg !== 'object' || !msg.type) return;
		if (msg.type.indexOf('walk:') !== 0) return;
		emit(msg.type, msg);
	}

	function postToFrame(payload) {
		if (!state.iframe || !state.iframe.contentWindow) return;
		try {
			state.iframe.contentWindow.postMessage(payload, EMBED_ORIGIN);
		} catch (e) {}
	}

	// ── Mount / unmount ───────────────────────────────────────────────────
	function mount(target) {
		if (state.container) return state.container; // idempotent

		var host = document.body || document.documentElement;
		var container = document.createElement('div');
		container.className = 'three-walk-avatar-embed';
		container.style.position = 'fixed';
		container.style.width = state.options.width + 'px';
		container.style.height = state.options.height + 'px';
		container.style.zIndex = String(state.options.zIndex);
		container.style.pointerEvents = 'none'; // host page stays clickable
		container.style.background = 'transparent';
		setPositionStyles(container, state.options.position);

		var iframe = document.createElement('iframe');
		iframe.src = buildSrc(state.options);
		iframe.title = 'three.ws walking avatar';
		iframe.allow = 'accelerometer; gyroscope; xr-spatial-tracking';
		iframe.setAttribute('frameborder', '0');
		iframe.setAttribute('scrolling', 'no');
		iframe.style.width = '100%';
		iframe.style.height = '100%';
		iframe.style.border = '0';
		iframe.style.background = 'transparent';
		// Restore pointer events on the iframe itself so users can still
		// interact with the avatar if controls are enabled — only the
		// container's empty padding ignores clicks.
		iframe.style.pointerEvents = state.options.controls === 'none' ? 'none' : 'auto';

		container.appendChild(iframe);

		var mountTarget = target || host;
		if (typeof mountTarget === 'string') mountTarget = document.querySelector(mountTarget) || host;
		mountTarget.appendChild(container);

		state.iframe = iframe;
		state.container = container;

		window.addEventListener('message', onWindowMessage);
		return container;
	}

	function unmount() {
		window.removeEventListener('message', onWindowMessage);
		if (state.container && state.container.parentNode) {
			state.container.parentNode.removeChild(state.container);
		}
		state.iframe = null;
		state.container = null;
	}

	// ── Public API ────────────────────────────────────────────────────────
	var API = {
		mount: mount,
		unmount: unmount,
		setAvatar: function (id) {
			state.options.avatar = id || '';
			postToFrame({ type: 'walk:setAvatar', id: id });
		},
		setMotion: function (motion) {
			postToFrame({ type: 'walk:setMotion', motion: motion });
		},
		setSize: function (w, h) {
			state.options.width = w;
			state.options.height = h;
			if (state.container) {
				state.container.style.width = w + 'px';
				state.container.style.height = h + 'px';
			}
		},
		setPosition: function (pos) {
			state.options.position = pos;
			if (state.container) setPositionStyles(state.container, pos);
		},
		resetPose: function () {
			postToFrame({ type: 'walk:resetPose' });
		},
		setEnv: function (env) {
			state.options.env = env || 'studio';
			postToFrame({ type: 'walk:setEnv', env: env });
		},
		on: function (name, cb) {
			(state.listeners[name] = state.listeners[name] || []).push(cb);
		},
		off: function (name, cb) {
			var arr = state.listeners[name];
			if (!arr) return;
			var i = arr.indexOf(cb);
			if (i >= 0) arr.splice(i, 1);
		},
		// Read-only snapshot — useful for hosts that want to reconfigure
		// before re-mounting under a different container.
		getOptions: function () { return Object.assign({}, state.options); },
	};

	// Expose globally. Don't clobber if some other copy of the SDK already
	// loaded (e.g. inline script tag race) — keep the first one in charge.
	if (!window.ThreeWalkAvatar) {
		window.ThreeWalkAvatar = API;
	}

	// ── Auto-mount ────────────────────────────────────────────────────────
	// Default behavior: if the script tag has any data-* attributes, we
	// auto-mount on DOM ready. Hosts that want explicit control can add
	// `data-auto="false"` and call `ThreeWalkAvatar.mount(...)` themselves.
	var autoMount = attr('data-auto', 'true') !== 'false';
	if (autoMount) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', function () { mount(); });
		} else {
			mount();
		}
	}
})();
