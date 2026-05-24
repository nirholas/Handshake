// three.ws — script-tag embed.
// <script async src="https://three.ws/embed.js" data-widget="wdgt_..."></script>
//
// Injects a sandboxed iframe at the script tag's location, sized via data-*
// attributes (or the type's default), then forwards widget:resize events from
// the iframe to keep the host layout snug.
//
// Zero deps, plain DOM. Intentionally tiny — gets minified/cached at the edge.

(function () {
	'use strict';

	var TYPE_SIZES = {
		'turntable':         [600, 600],
		'animation-gallery': [720, 720],
		'talking-agent':     [420, 600],
		'passport':          [480, 560],
		'hotspot-tour':      [800, 600],
	};

	var ORIGIN = (function () {
		try { return new URL(document.currentScript.src).origin; }
		catch (e) { return 'https://three.ws'; }
	})();

	// Single module-level registry: widgetId → iframe element.
	// One delegated message listener handles all embeds on the page — no
	// per-mount listeners that multiply with each <script data-widget>.
	var registry = Object.create(null);

	function onResize(e) {
		if (e.origin !== ORIGIN) return;
		if (!e.data || e.data.type !== 'widget:resize') return;
		var id = e.data.id;
		var iframe = id ? registry[id] : null;
		// If no id given, apply to every registered iframe (legacy broadcast).
		var targets = iframe ? [iframe] : Object.keys(registry).map(function (k) { return registry[k]; });
		targets.forEach(function (f) {
			if (e.data.width)  f.setAttribute('width',  String(e.data.width));
			if (e.data.height) f.setAttribute('height', String(e.data.height));
		});
	}

	window.addEventListener('message', onResize);

	function attr(el, name, fallback) {
		var v = el && el.getAttribute && el.getAttribute(name);
		return v != null && v !== '' ? v : fallback;
	}

	function mount(scriptEl) {
		var widgetId = attr(scriptEl, 'data-widget', null);
		if (!widgetId) {
			console.warn('[3d-agent embed] missing data-widget attribute');
			return;
		}
		var type     = attr(scriptEl, 'data-type', null);
		var defaults = (type && TYPE_SIZES[type]) || [600, 600];
		var width    = attr(scriptEl, 'data-width',  String(defaults[0]));
		var height   = attr(scriptEl, 'data-height', String(defaults[1]));
		var radius   = attr(scriptEl, 'data-radius', '12');
		var border   = attr(scriptEl, 'data-border', '0');

		// /widget = slim viewer shell. Same engine as /app but without the
		// marketing nav/footer/auth chrome in the DOM, so the embed iframe
		// doesn't flash the parent site before the model renders.
		var src = ORIGIN + '/widget#widget=' + encodeURIComponent(widgetId) + '&kiosk=true';

		var iframe = document.createElement('iframe');
		iframe.src = src;
		iframe.title = 'three.ws widget ' + widgetId;
		iframe.allow = 'autoplay; clipboard-write; xr-spatial-tracking';
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
		iframe.setAttribute('width',  width);
		iframe.setAttribute('height', height);
		iframe.style.border       = border + 'px solid transparent';
		iframe.style.borderRadius = radius + 'px';
		iframe.style.maxWidth     = '100%';
		iframe.style.display      = 'block';

		// Wrap in a positioned container that holds the skeleton placeholder.
		var wrapper = document.createElement('div');
		wrapper.style.cssText =
			'position:relative;display:inline-block;max-width:100%;' +
			'width:' + width + 'px;height:' + height + 'px;' +
			'border-radius:' + radius + 'px;overflow:hidden;' +
			'background:#0c0c12;';

		var skeleton = document.createElement('div');
		skeleton.setAttribute('aria-hidden', 'true');
		skeleton.style.cssText =
			'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
			'pointer-events:none;transition:opacity 0.3s;';
		skeleton.innerHTML =
			'<div style="width:32px;height:32px;border:2px solid rgba(255,255,255,0.08);' +
			'border-top-color:rgba(255,255,255,0.35);border-radius:50%;' +
			'animation:_3dws_spin 0.8s linear infinite"></div>';

		// Inject the keyframe only once per page.
		if (!document.getElementById('_3dws_embed_css')) {
			var style = document.createElement('style');
			style.id = '_3dws_embed_css';
			style.textContent = '@keyframes _3dws_spin{to{transform:rotate(360deg)}}';
			document.head.appendChild(style);
		}

		iframe.style.position = 'relative';
		iframe.style.zIndex = '1';
		iframe.addEventListener('load', function () {
			skeleton.style.opacity = '0';
			setTimeout(function () { if (skeleton.parentNode) skeleton.parentNode.removeChild(skeleton); }, 350);
		});

		wrapper.appendChild(skeleton);
		wrapper.appendChild(iframe);

		var anchor = scriptEl.parentNode;
		if (!anchor) return;
		anchor.insertBefore(wrapper, scriptEl);

		// Register for the delegated resize listener.
		registry[widgetId] = iframe;

		// Lazy-load via IntersectionObserver when available (Firefox compat).
		// Falls back to immediate load when IO is absent. When the iframe first
		// becomes visible, fire a fire-and-forget analytics beacon so the
		// creator can see "where was my widget loaded from" without any
		// cookie/localStorage touch on the visitor's browser.
		if (typeof IntersectionObserver !== 'undefined') {
			iframe.src = '';
			var io = new IntersectionObserver(function (entries, obs) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) {
						iframe.src = src;
						sendViewBeacon(widgetId);
						obs.disconnect();
					}
				});
			}, { rootMargin: '200px' });
			io.observe(wrapper);
		} else {
			iframe.src = src;
			sendViewBeacon(widgetId);
		}
	}

	function sendViewBeacon(widgetId) {
		var url = ORIGIN + '/api/widgets/' + encodeURIComponent(widgetId) + '/view';
		try {
			if (navigator.sendBeacon) {
				navigator.sendBeacon(url, new Blob([''], { type: 'text/plain' }));
				return;
			}
		} catch (e) { /* fall through to fetch */ }
		try {
			fetch(url, { method: 'POST', keepalive: true, mode: 'no-cors', credentials: 'omit' });
		} catch (e) { /* best-effort only */ }
	}

	// Mount every <script data-widget="..."> on the page (allows multiple embeds).
	var current = document.currentScript;
	if (current && current.getAttribute('data-widget')) {
		mount(current);
	} else {
		var scripts = document.querySelectorAll('script[data-widget][src*="embed.js"]');
		for (var i = 0; i < scripts.length; i++) mount(scripts[i]);
	}

	// ──────────────────────────────────────────────────────────────────────
	// <threews-avatar> web component
	//
	// The widget mounter above handles legacy data-widget snippets. The
	// component below is the modern "drop an avatar anywhere" surface that
	// mirrors Google's <model-viewer> attribute pattern. Both live in this
	// one file so a single <script src="/embed.js"> covers everything.
	//
	// Attributes:
	//   src              — direct GLB URL
	//   avatar-id        — three.ws saved avatar id
	//   agent            — chain reference "eip155:8453/erc8004:0x.../1"
	//   pose, animation  — animation clip to play on load
	//   bg               — 'transparent' (default) | 'dark' | 'light'
	//   chromakey        — '#00ff00' / 'green' / 'blue' / 'magenta'
	//   hide-chrome      — suppress name plate / link / loading
	//   driveable        — upgrade to agent runtime (speak/gesture API)
	//   name="0"         — hide just the name plate
	//
	// JS API (after `await el.ready`):
	//   el.play(name), el.speak(text), el.gesture(name), el.snapshot()
	//   el.bridge — raw EmbedHostBridge in driveable mode
	//
	// Events: 'ready', 'error', 'blocked'
	// ──────────────────────────────────────────────────────────────────────

	if (typeof customElements === 'undefined' || customElements.get('threews-avatar')) return;

	var COMPONENT_STYLES =
		':host{display:inline-block;position:relative;width:100%;min-width:200px;' +
		'min-height:200px;aspect-ratio:1/1;background:transparent;border-radius:inherit;' +
		'overflow:hidden;contain:layout style paint}' +
		':host([hidden]){display:none}' +
		'iframe{position:absolute;inset:0;width:100%;height:100%;border:0;' +
		'background:transparent;display:block}' +
		'.error{position:absolute;inset:0;display:flex;align-items:center;' +
		'justify-content:center;color:rgba(255,255,255,0.5);background:rgba(0,0,0,0.25);' +
		'font:12px/1.4 system-ui,sans-serif;padding:12px;text-align:center}';

	function cryptoRandomId() {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
		return 'id-' + Math.random().toString(36).slice(2);
	}

	class ThreeWsAvatar extends HTMLElement {
		static get observedAttributes() {
			return [
				'src', 'avatar-id', 'agent', 'handle', 'pose', 'animation',
				'bg', 'chromakey', 'hide-chrome', 'name', 'driveable',
				'mocap', 'idle', 'lod', 'texture-size', 'morphs', 'draco',
			];
		}

		constructor() {
			super();
			this.attachShadow({ mode: 'open' });
			this._iframe = null;
			this._origin = ORIGIN;
			this._destroyed = false;
			this.bridge = null;
			this._resetReady();
			this._onMessage = handleAvatarMessage.bind(this);
		}

		_resetReady() {
			var self = this;
			this.ready = new Promise(function (resolve, reject) {
				self._readyResolve = resolve;
				self._readyReject = reject;
			});
		}

		connectedCallback() {
			var style = document.createElement('style');
			style.textContent = COMPONENT_STYLES;
			this.shadowRoot.appendChild(style);
			mountAvatarFrame(this);
			window.addEventListener('message', this._onMessage);
		}

		disconnectedCallback() {
			this._destroyed = true;
			window.removeEventListener('message', this._onMessage);
			if (this._iframe) { this._iframe.remove(); this._iframe = null; }
			if (this.bridge && typeof this.bridge.destroy === 'function') this.bridge.destroy();
			this.bridge = null;
		}

		attributeChangedCallback(name, oldVal, newVal) {
			if (oldVal === newVal) return;
			if (
				name === 'src' || name === 'avatar-id' || name === 'agent' ||
				name === 'handle' || name === 'driveable' ||
				name === 'mocap' || name === 'idle' || name === 'lod' ||
				name === 'texture-size' || name === 'morphs' || name === 'draco'
			) {
				if (this.isConnected) mountAvatarFrame(this);
				return;
			}
			if (name === 'pose' || name === 'animation') {
				if (newVal) this.play(newVal).catch(function () {});
				return;
			}
			if (name === 'bg' || name === 'chromakey' || name === 'hide-chrome' || name === 'name') {
				if (this.isConnected) mountAvatarFrame(this);
			}
		}

		play(animationName) {
			var self = this;
			return this.ready.then(function () {
				if (!animationName) return;
				if (self.bridge) return self.bridge.gesture(animationName, { loop: true });
				self.setAttribute('animation', animationName);
			});
		}

		speak(text, opts) {
			var self = this;
			return this.ready.then(function () {
				if (!self.bridge) throw new Error('threews-avatar: speak() requires `driveable`');
				return self.bridge.speak(text, opts);
			});
		}

		gesture(gestureName, opts) {
			var self = this;
			return this.ready.then(function () {
				if (!self.bridge) throw new Error('threews-avatar: gesture() requires `driveable`');
				return self.bridge.gesture(gestureName, opts);
			});
		}

		snapshot() {
			var self = this;
			return this.ready.then(function () {
				return new Promise(function (resolve) {
					var id = cryptoRandomId();
					function handler(ev) {
						if (!self._iframe || ev.source !== self._iframe.contentWindow) return;
						if (!ev.data || ev.data.id !== id) return;
						window.removeEventListener('message', handler);
						resolve(ev.data.dataUrl || null);
					}
					window.addEventListener('message', handler);
					try {
						self._iframe.contentWindow.postMessage(
							{ action: 'takeScreenshot', id: id }, self._origin,
						);
					} catch (e) {
						window.removeEventListener('message', handler);
						resolve(null);
					}
					setTimeout(function () {
						window.removeEventListener('message', handler);
						resolve(null);
					}, 5000);
				});
			});
		}
	}

	function mountAvatarFrame(el) {
		if (el._iframe) { el._iframe.remove(); el._iframe = null; }
		if (el.bridge && typeof el.bridge.destroy === 'function') el.bridge.destroy();
		el.bridge = null;
		var oldErr = el.shadowRoot.querySelector('.error');
		if (oldErr) oldErr.remove();
		el._resetReady();

		var src = resolveAvatarIframeSrc(el);
		if (!src) {
			showAvatarError(el, 'threews-avatar: missing `src`, `avatar-id`, or `agent`');
			return;
		}
		el._origin = new URL(src, location.href).origin;

		var iframe = document.createElement('iframe');
		iframe.src = src;
		iframe.allow = 'autoplay; camera; microphone; xr-spatial-tracking';
		iframe.setAttribute('allowtransparency', 'true');
		iframe.setAttribute('aria-label', el.getAttribute('name') || 'three.ws avatar');
		el.shadowRoot.appendChild(iframe);
		el._iframe = iframe;

		if (isAvatarDriveable(el)) upgradeAvatarToBridge(el);
	}

	function resolveAvatarIframeSrc(el) {
		var driveable = isAvatarDriveable(el);
		var src = el.getAttribute('src');
		var avatarId = el.getAttribute('avatar-id');
		var agentRef = el.getAttribute('agent');
		var handle = el.getAttribute('handle');

		// Portable @handle mount — routes to the v1.avatar.* embed runtime that
		// supports lipsync, idle-life, and (optionally) webcam mocap.
		if (handle) {
			var h = String(handle).replace(/^@/, '');
			var hUrl = new URL('/embed/avatar/' + encodeURIComponent(h), ORIGIN);
			applyAvatarPortableParams(el, hUrl);
			return hUrl.href;
		}

		if (driveable) {
			if (!avatarId && !agentRef) return null;
			var dUrl = new URL('/agent-embed', ORIGIN);
			if (avatarId) dUrl.searchParams.set('agentId', avatarId);
			if (agentRef) dUrl.searchParams.set('agent', agentRef);
			applyAvatarCommonParams(el, dUrl);
			return dUrl.href;
		}

		if (agentRef && /^[a-z0-9]+:\d+\/[a-z0-9]+:[\w-]+\/\d+$/i.test(agentRef)) {
			var parts = agentRef.split('/');
			var chainId = parts[0].split(':')[1];
			var pUrl = new URL('/a/' + chainId + '/' + parts.slice(1).join('/') + '/embed', ORIGIN);
			applyAvatarCommonParams(el, pUrl);
			return pUrl.href;
		}

		if (avatarId) {
			// Prefer the portable embed surface when no agent identity is needed
			// — gives the host the v1.avatar.* bridge + idle-life out of the box.
			var aUrl = new URL('/embed/avatar', ORIGIN);
			aUrl.searchParams.set('id', avatarId);
			applyAvatarPortableParams(el, aUrl);
			return aUrl.href;
		}

		if (src) {
			var sUrl = new URL('/embed/avatar', ORIGIN);
			sUrl.searchParams.set('model', src);
			applyAvatarPortableParams(el, sUrl);
			return sUrl.href;
		}

		return null;
	}

	// Param set understood by the portable /embed/avatar runtime (v1.avatar.*).
	function applyAvatarPortableParams(el, url) {
		applyAvatarCommonParams(el, url);
		var mocap = el.getAttribute('mocap');
		if (mocap && mocap !== 'off') url.searchParams.set('mocap', mocap);
		var idle = el.getAttribute('idle');
		if (idle && idle !== 'on') url.searchParams.set('idle', idle);
		var lod = el.getAttribute('lod');
		if (lod) url.searchParams.set('lod', lod);
		var ts = el.getAttribute('texture-size');
		if (ts) url.searchParams.set('textureSize', ts);
		var morphs = el.getAttribute('morphs');
		if (morphs) url.searchParams.set('morphs', morphs);
		var draco = el.getAttribute('draco');
		if (draco) url.searchParams.set('draco', draco);
	}

	function applyAvatarCommonParams(el, url) {
		var bg = el.getAttribute('bg');
		if (bg) url.searchParams.set('bg', bg);
		var ck = el.getAttribute('chromakey');
		if (ck) url.searchParams.set('chromakey', ck);
		if (el.hasAttribute('hide-chrome')) url.searchParams.set('hide-chrome', '1');
		if (el.getAttribute('name') === '0') url.searchParams.set('name', '0');
		var pose = el.getAttribute('pose') || el.getAttribute('animation');
		if (pose) url.searchParams.set('animation', pose);
	}

	function isAvatarDriveable(el) {
		return el.hasAttribute('driveable') && el.getAttribute('driveable') !== 'false';
	}

	function upgradeAvatarToBridge(el) {
		import(ORIGIN + '/src/embed-host-bridge.js').then(function (mod) {
			if (el._destroyed || !el._iframe) return;
			var agentId = el.getAttribute('avatar-id') || el.getAttribute('agent') || 'unknown';
			el.bridge = new mod.EmbedHostBridge({
				iframe: el._iframe,
				agentId: agentId,
				allowedOrigin: el._origin,
			});
		}).catch(function (err) {
			console.warn('[threews-avatar] driveable upgrade failed', err);
		});
	}

	function handleAvatarMessage(ev) {
		if (!this._iframe || ev.source !== this._iframe.contentWindow) return;
		if (ev.origin && this._origin && ev.origin !== this._origin) return;
		var data = ev.data;
		if (!data || typeof data !== 'object') return;
		if (!data.__agent) return;

		if (data.type === 'ready') {
			this._readyResolve({ name: data.name || '', avatar: data.avatar || null });
			this.dispatchEvent(new CustomEvent('ready', { detail: data }));
		} else if (data.type === 'error') {
			showAvatarError(this, data.message || 'Failed to load');
			this._readyReject(new Error(data.message || 'Failed to load'));
			this.dispatchEvent(new CustomEvent('error', { detail: data }));
		} else if (data.type === 'blocked') {
			showAvatarError(this, 'Embedding blocked on ' + (data.host || 'this host') + '.');
			this._readyReject(new Error('Embed blocked'));
			this.dispatchEvent(new CustomEvent('blocked', { detail: data }));
		}
	}

	function showAvatarError(el, message) {
		var existing = el.shadowRoot.querySelector('.error');
		if (existing) {
			existing.textContent = message;
		} else {
			var div = document.createElement('div');
			div.className = 'error';
			div.textContent = message;
			el.shadowRoot.appendChild(div);
		}
	}

	customElements.define('threews-avatar', ThreeWsAvatar);
	if (!customElements.get('agent-3d')) {
		class Agent3D extends ThreeWsAvatar {}
		customElements.define('agent-3d', Agent3D);
	}

	window.threeWs = window.threeWs || {};
	window.threeWs.mount = function (target, options) {
		options = options || {};
		var host = typeof target === 'string' ? document.querySelector(target) : target;
		if (!host) throw new Error('threeWs.mount: target not found');
		var el = document.createElement('threews-avatar');
		Object.keys(options).forEach(function (key) {
			var val = options[key];
			if (val == null) return;
			var attrName = key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
			el.setAttribute(attrName, typeof val === 'boolean' ? (val ? '' : null) : String(val));
		});
		host.appendChild(el);
		return el;
	};
	window.threeWs.version = '1.0.0';

	// Auto-mount when the loader script itself carries data-avatar / data-agent.
	(function autoMountAvatar() {
		try {
			var s = document.currentScript ||
				document.querySelector('script[data-avatar][src*="embed.js"], script[data-agent][src*="embed.js"]');
			if (!s) return;
			var avatar = s.getAttribute('data-avatar');
			var agent = s.getAttribute('data-agent');
			var avatarId = s.getAttribute('data-avatar-id');
			if (!avatar && !agent && !avatarId) return;
			if (s.getAttribute('data-widget')) return; // legacy widget snippet, handled above
			var target = s.getAttribute('data-target');
			var host = target ? document.querySelector(target) : null;
			var el = document.createElement('threews-avatar');

			// data-avatar="@handle"  → portable @handle mount.
			// data-avatar="<uuid>"    → legacy avatar-id mount (back-compat).
			// Discriminator: anything starting with @, or matching the username
			// charset and *not* a UUID 8-4-4-4-12 pattern, is a handle.
			if (avatar) {
				var trimmed = String(avatar).trim();
				var isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
				var isHandle = !isUuid && (
					trimmed.charAt(0) === '@' ||
					/^[a-z0-9_-]{3,30}$/i.test(trimmed)
				);
				if (isHandle) {
					el.setAttribute('handle', trimmed.replace(/^@/, ''));
				} else {
					el.setAttribute('avatar-id', trimmed);
				}
			}
			if (avatarId) el.setAttribute('avatar-id', avatarId);
			if (agent) el.setAttribute('agent', agent);
			if (s.getAttribute('data-pose')) el.setAttribute('pose', s.getAttribute('data-pose'));
			if (s.getAttribute('data-bg')) el.setAttribute('bg', s.getAttribute('data-bg'));
			if (s.getAttribute('data-chromakey')) el.setAttribute('chromakey', s.getAttribute('data-chromakey'));
			if (s.getAttribute('data-hide-chrome') || s.getAttribute('data-chrome') === '0') {
				el.setAttribute('hide-chrome', '1');
			}
			if (s.getAttribute('data-driveable')) el.setAttribute('driveable', '');
			// Portable-embed knobs (only meaningful when routed through /embed/avatar):
			if (s.getAttribute('data-mocap')) el.setAttribute('mocap', s.getAttribute('data-mocap'));
			if (s.getAttribute('data-idle')) el.setAttribute('idle', s.getAttribute('data-idle'));
			if (s.getAttribute('data-lod')) el.setAttribute('lod', s.getAttribute('data-lod'));
			if (s.getAttribute('data-texture-size')) el.setAttribute('texture-size', s.getAttribute('data-texture-size'));
			if (s.getAttribute('data-morphs')) el.setAttribute('morphs', s.getAttribute('data-morphs'));
			if (s.getAttribute('data-draco')) el.setAttribute('draco', s.getAttribute('data-draco'));
			(host || s.parentNode || document.body).appendChild(el);
		} catch (err) {
			console.warn('[threews-embed] auto-mount failed', err);
		}
	})();
})();
