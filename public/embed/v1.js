/**
 * three.ws — embed v1
 *
 * The 3D layer of the internet, in one script tag.
 *
 *   <script src="https://three.ws/embed/v1.js" async></script>
 *   <three-d agent="8453:42"></three-d>
 *
 * Or fully drop-in (no markup needed):
 *
 *   <script src="https://three.ws/embed/v1.js" data-agent="8453:42" async></script>
 *
 * Or programmatic:
 *
 *   Three.mount('#root', { agent: '8453:42', interactive: true });
 *
 * Registers three element aliases — <three-d>, <three-agent>, <three-ws> —
 * that all behave identically. Lives entirely alongside the legacy embed.js
 * widget loader; nothing existing is touched.
 *
 * Renderer: model-viewer 4.0.0 (Apache 2.0), lazy-loaded from Google's CDN on
 * first instance. Loader script itself is ~6KB minified.
 *
 * Performance contract:
 *   - First contentful paint within 200ms of script load (poster image only)
 *   - WebGL boot deferred until element scrolls into viewport (IntersectionObserver)
 *   - prefers-reduced-motion respected (auto-rotate disabled)
 *   - WebGL failures degrade to poster + caption, never a black box
 */

(function () {
	'use strict';

	if (window.__threeWsEmbedV1) return; // idempotent — multiple includes are safe
	window.__threeWsEmbedV1 = true;

	var ORIGIN = (function () {
		try {
			return new URL(document.currentScript.src).origin;
		} catch (_) {
			return 'https://three.ws';
		}
	})();

	var MV_CDN = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';

	// model-viewer is loaded once, lazily, on first <three-d> instance.
	// All instances share the same Promise so we never fetch it twice.
	var modelViewerReady = null;
	function ensureModelViewer() {
		if (modelViewerReady) return modelViewerReady;
		modelViewerReady = new Promise(function (resolve, reject) {
			if (window.customElements && customElements.get('model-viewer')) return resolve();
			var s = document.createElement('script');
			s.type = 'module';
			s.src = MV_CDN;
			s.onload = function () { resolve(); };
			s.onerror = function () { reject(new Error('model-viewer failed to load')); };
			document.head.appendChild(s);
		});
		return modelViewerReady;
	}

	// Resolver cache — embeds for the same agent on a single page share one
	// fetch. Cleared on navigation, never persisted.
	var resolverCache = Object.create(null);
	function resolve(id) {
		if (resolverCache[id]) return resolverCache[id];
		resolverCache[id] = fetch(
			ORIGIN + '/api/embed/resolve?id=' + encodeURIComponent(id),
			{ credentials: 'omit' },
		).then(function (r) {
			if (!r.ok) throw new Error('resolve failed: ' + r.status);
			return r.json();
		}).catch(function (err) {
			delete resolverCache[id]; // allow retry
			throw err;
		});
		return resolverCache[id];
	}

	var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	// Tracks which instances are visible so we only boot WebGL for ones that
	// matter. One shared observer for the whole page.
	var visibilityObserver = null;
	function observeVisibility(el) {
		if (!('IntersectionObserver' in window)) {
			el.__threeVisible = true;
			el.__bootIfReady && el.__bootIfReady();
			return;
		}
		if (!visibilityObserver) {
			visibilityObserver = new IntersectionObserver(function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) {
						entry.target.__threeVisible = true;
						entry.target.__bootIfReady && entry.target.__bootIfReady();
						visibilityObserver.unobserve(entry.target);
					}
				});
			}, { rootMargin: '200px' });
		}
		visibilityObserver.observe(el);
	}

	// -------- The element -------------------------------------------------

	var STYLE = ''
		+ ':host{display:inline-block;position:relative;width:100%;max-width:100%;'
		+ 'background:#0a0a0c;border-radius:14px;overflow:hidden;'
		+ 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;'
		+ 'color:#fff;line-height:1.4;contain:layout style;}'
		+ ':host([theme="light"]){background:#f7f7f8;color:#111;}'
		+ ':host([theme="transparent"]){background:transparent;}'
		+ '.stage{position:relative;width:100%;height:100%;min-height:280px;display:block;}'
		+ ':host([height]) .stage{min-height:0;}'
		+ 'model-viewer{width:100%;height:100%;display:block;background:transparent;'
		+ '--poster-color:transparent;--progress-bar-color:rgba(255,255,255,.5);--progress-bar-height:2px;}'
		+ '.poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
		+ 'background:linear-gradient(135deg,#111 0%,#1c1c22 100%);transition:opacity .35s;}'
		+ '.poster--gone{opacity:0;pointer-events:none;}'
		+ '.chrome{position:absolute;left:10px;right:10px;bottom:10px;display:flex;'
		+ 'align-items:center;gap:8px;pointer-events:none;}'
		+ '.chrome a{pointer-events:auto;}'
		+ '.name{font-size:13px;font-weight:600;letter-spacing:.01em;'
		+ 'background:rgba(0,0,0,.55);backdrop-filter:blur(8px);'
		+ '-webkit-backdrop-filter:blur(8px);padding:6px 10px;border-radius:999px;'
		+ 'color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:6px;'
		+ 'border:1px solid rgba(255,255,255,.08);transition:background .15s,border-color .15s;}'
		+ '.name:hover{background:rgba(0,0,0,.75);border-color:rgba(255,255,255,.2);}'
		+ '.badge{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;'
		+ 'padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.08);'
		+ 'border:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.85);}'
		+ '.brand{margin-left:auto;font-size:10px;letter-spacing:.06em;'
		+ 'color:rgba(255,255,255,.6);text-decoration:none;font-weight:500;'
		+ 'background:rgba(0,0,0,.45);padding:5px 8px;border-radius:999px;'
		+ 'border:1px solid rgba(255,255,255,.06);}'
		+ '.brand:hover{color:#fff;border-color:rgba(255,255,255,.18);}'
		+ ':host([hide-chrome]) .chrome{display:none;}'
		+ ':host([theme="light"]) .name{background:rgba(255,255,255,.85);color:#111;'
		+ 'border-color:rgba(0,0,0,.08);}'
		+ ':host([theme="light"]) .name:hover{background:#fff;border-color:rgba(0,0,0,.2);}'
		+ ':host([theme="light"]) .brand{background:rgba(255,255,255,.7);color:rgba(0,0,0,.6);'
		+ 'border-color:rgba(0,0,0,.06);}'
		+ ':host([theme="light"]) .brand:hover{color:#000;border-color:rgba(0,0,0,.2);}'
		+ '.fail{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
		+ 'font-size:13px;color:rgba(255,255,255,.6);padding:24px;text-align:center;}'
		+ '@media (prefers-reduced-motion: reduce){model-viewer{--progress-bar-height:0;}}'
		+ '';

	function ThreeWsAgentElement() {
		return Reflect.construct(HTMLElement, [], this.constructor);
	}
	ThreeWsAgentElement.prototype = Object.create(HTMLElement.prototype);
	ThreeWsAgentElement.prototype.constructor = ThreeWsAgentElement;
	Object.setPrototypeOf(ThreeWsAgentElement, HTMLElement);

	ThreeWsAgentElement.observedAttributes = ['agent', 'src', 'poster', 'name', 'theme', 'height', 'width', 'autoplay', 'interactive', 'hide-chrome'];

	ThreeWsAgentElement.prototype.connectedCallback = function () {
		if (this.__threeMounted) return;
		this.__threeMounted = true;

		var shadow = this.attachShadow({ mode: 'open' });
		var style = document.createElement('style');
		style.textContent = STYLE;
		shadow.appendChild(style);

		var stage = document.createElement('div');
		stage.className = 'stage';
		shadow.appendChild(stage);
		this.__stage = stage;

		// Apply explicit sizing if provided
		var h = this.getAttribute('height');
		var w = this.getAttribute('width');
		if (h) this.style.height = isFinite(+h) ? +h + 'px' : h;
		if (w) this.style.width = isFinite(+w) ? +w + 'px' : w;

		// Poster first — visible in <200ms regardless of WebGL state
		var posterAttr = this.getAttribute('poster');
		if (posterAttr) {
			var img = document.createElement('img');
			img.className = 'poster';
			img.alt = this.getAttribute('name') || '';
			img.src = posterAttr;
			img.loading = 'eager';
			stage.appendChild(img);
			this.__posterEl = img;
		}

		var self = this;
		this.__bootIfReady = function () {
			if (!self.__threeVisible || self.__booted) return;
			self.__booted = true;
			self.__boot().catch(function (err) {
				self.__fail(err);
			});
		};

		observeVisibility(this);
		this.setAttribute('role', 'img');
		if (this.getAttribute('name') && !this.hasAttribute('aria-label')) {
			this.setAttribute('aria-label', this.getAttribute('name'));
		}
	};

	ThreeWsAgentElement.prototype.attributeChangedCallback = function (name) {
		if (!this.__booted) return;
		// Re-render on attribute change after initial boot (rare; mostly for SPA-driven swaps)
		if (name === 'agent' || name === 'src') {
			this.__booted = false;
			this.__stage.querySelectorAll('model-viewer').forEach(function (n) { n.remove(); });
			this.__bootIfReady && this.__bootIfReady();
		}
	};

	ThreeWsAgentElement.prototype.__boot = async function () {
		var self = this;
		var agentSpec = this.getAttribute('agent');
		var src = this.getAttribute('src');
		var nameAttr = this.getAttribute('name');
		var posterAttr = this.getAttribute('poster');
		var passportUrl = null;
		var chainName = null;
		var resolved = null;

		if (!src && agentSpec) {
			try {
				resolved = await resolve(agentSpec);
			} catch (e) {
				throw new Error('Could not resolve agent "' + agentSpec + '"');
			}
			src = resolved.glbUrl;
			nameAttr = nameAttr || resolved.name;
			posterAttr = posterAttr || resolved.poster;
			passportUrl = resolved.passportUrl;
			chainName = resolved.chainName;
			if (posterAttr && !this.__posterEl) {
				var img = document.createElement('img');
				img.className = 'poster';
				img.alt = nameAttr || '';
				img.src = posterAttr;
				this.__stage.insertBefore(img, this.__stage.firstChild);
				this.__posterEl = img;
			}
			if (nameAttr && !this.hasAttribute('aria-label')) {
				this.setAttribute('aria-label', nameAttr);
			}
		}

		if (!src) throw new Error('Missing "agent" or "src" attribute');

		await ensureModelViewer();

		var mv = document.createElement('model-viewer');
		mv.src = src;
		mv.alt = nameAttr || 'three.ws agent';
		mv.loading = 'eager';
		mv.reveal = 'auto';
		mv.setAttribute('environment-image', 'neutral');
		mv.setAttribute('shadow-intensity', '0');
		mv.setAttribute('exposure', '1');
		mv.setAttribute('camera-orbit', '0deg 90deg auto');
		mv.setAttribute('disable-pan', '');
		mv.setAttribute('interaction-prompt', 'none');

		var interactive = this.hasAttribute('interactive');
		var autoplay = this.hasAttribute('autoplay') || !interactive;
		if (!interactive) {
			mv.setAttribute('disable-zoom', '');
			mv.setAttribute('disable-tap', '');
			// camera-controls intentionally omitted — pointer events pass through to host
		} else {
			mv.setAttribute('camera-controls', '');
			mv.setAttribute('touch-action', 'pan-y');
		}
		if (autoplay && !REDUCED_MOTION) {
			mv.setAttribute('auto-rotate', '');
			mv.setAttribute('rotation-per-second', '18deg');
			mv.setAttribute('auto-rotate-delay', '0');
		}

		mv.addEventListener('load', function () {
			if (self.__posterEl) self.__posterEl.classList.add('poster--gone');
		});
		mv.addEventListener('error', function (e) {
			self.__fail(e && e.detail ? e.detail : new Error('model failed to load'));
		});

		this.__stage.appendChild(mv);
		this.__mv = mv;

		// Chrome overlay (name pill + brand link)
		if (!this.hasAttribute('hide-chrome')) {
			var chrome = document.createElement('div');
			chrome.className = 'chrome';
			var nameEl = document.createElement('a');
			nameEl.className = 'name';
			nameEl.textContent = nameAttr || 'Agent';
			nameEl.href = passportUrl ? ORIGIN + passportUrl : ORIGIN + '/discover';
			nameEl.target = '_blank';
			nameEl.rel = 'noopener';
			if (chainName) {
				var b = document.createElement('span');
				b.className = 'badge';
				b.textContent = chainName;
				nameEl.appendChild(b);
			}
			chrome.appendChild(nameEl);
			var brand = document.createElement('a');
			brand.className = 'brand';
			brand.textContent = 'three.ws';
			brand.href = ORIGIN + '/';
			brand.target = '_blank';
			brand.rel = 'noopener';
			chrome.appendChild(brand);
			this.__stage.appendChild(chrome);
		}
	};

	ThreeWsAgentElement.prototype.__fail = function (err) {
		// Replace stage with a graceful caption; never leave a black box.
		var name = this.getAttribute('name') || (this.getAttribute('agent') ? 'Agent ' + this.getAttribute('agent') : '3D agent');
		if (this.__posterEl) {
			this.__posterEl.classList.remove('poster--gone');
		} else {
			var d = document.createElement('div');
			d.className = 'fail';
			d.textContent = 'Could not load ' + name;
			this.__stage.appendChild(d);
		}
		this.dispatchEvent(new CustomEvent('three-error', { detail: err, bubbles: true }));
	};

	ThreeWsAgentElement.prototype.disconnectedCallback = function () {
		if (visibilityObserver) visibilityObserver.unobserve(this);
	};

	// Register all three aliases on the same class
	['three-d', 'three-agent', 'three-ws'].forEach(function (tag) {
		if (!customElements.get(tag)) customElements.define(tag, class extends ThreeWsAgentElement {});
	});

	// -------- Public JS API (window.Three) --------------------------------

	function mount(target, opts) {
		opts = opts || {};
		var host = typeof target === 'string' ? document.querySelector(target) : target;
		if (!host) throw new Error('Three.mount: target not found (' + target + ')');
		var el = document.createElement('three-d');
		['agent', 'src', 'poster', 'name', 'theme', 'height', 'width'].forEach(function (k) {
			if (opts[k] != null) el.setAttribute(k, String(opts[k]));
		});
		['interactive', 'autoplay', 'hideChrome', 'hide-chrome'].forEach(function (k) {
			if (opts[k] || opts[k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); })]) {
				el.setAttribute(k === 'hideChrome' ? 'hide-chrome' : k, '');
			}
		});
		host.appendChild(el);
		return el;
	}

	var api = {
		version: '1.0.0',
		mount: mount,
		resolve: resolve,
		origin: ORIGIN,
	};

	// Expose globally — non-destructive merge with any existing Three (e.g., Three.js)
	if (window.Three && typeof window.Three === 'object' && !window.Three.mount) {
		Object.keys(api).forEach(function (k) {
			if (window.Three[k] == null) window.Three[k] = api[k];
		});
	} else if (!window.Three) {
		window.Three = api;
	} else if (!window.Three.mount) {
		// Three.js is on the page — namespace ours under Three.ws to avoid collision
		window.Three.ws = api;
	}
	// Always reachable namespace, regardless of collisions
	window.ThreeWs = api;

	// -------- Script-tag auto-mount ---------------------------------------
	// Lets non-technical users embed without writing markup:
	//   <script src="https://three.ws/embed/v1.js" data-agent="8453:42" async></script>

	(function autoMount() {
		var s = document.currentScript;
		if (!s) return;
		var agentSpec = s.getAttribute('data-agent') || s.getAttribute('data-src');
		if (!agentSpec) return;
		var el = document.createElement('three-d');
		if (s.getAttribute('data-agent')) el.setAttribute('agent', s.getAttribute('data-agent'));
		if (s.getAttribute('data-src')) el.setAttribute('src', s.getAttribute('data-src'));
		['poster', 'name', 'theme', 'height', 'width'].forEach(function (k) {
			var v = s.getAttribute('data-' + k);
			if (v) el.setAttribute(k, v);
		});
		['interactive', 'autoplay', 'hide-chrome'].forEach(function (k) {
			if (s.hasAttribute('data-' + k)) el.setAttribute(k, '');
		});
		var target = s.getAttribute('data-target');
		var host = target ? document.querySelector(target) : null;
		if (host) host.appendChild(el);
		else s.parentNode.insertBefore(el, s);
	})();
})();
