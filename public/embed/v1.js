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
	// Served from the same origin this embed script came from (ORIGIN above), not
	// a public CDN: the decoder is a hard dependency of every compressed avatar,
	// so it must have exactly the same availability as the embed itself.
	var MESHOPT_CDN = ORIGIN + '/vendor/meshopt_decoder.js';

	// model-viewer auto-loads the Draco and KTX2 decoders but leaves Meshopt
	// unset, and every server-baked avatar (the /api/avatars/<id>/glb lane and
	// Forge output) ships EXT_meshopt_compression. Without this the embed threw
	// "setMeshoptDecoder must be called before loading compressed files" and the
	// agent never rendered on the host page. Pages inside three.ws get this from
	// /model-viewer-meshopt.js; an embed on someone else's site has to carry it.
	//
	// Timing matters: model-viewer captures its loader's decoder config when a
	// load STARTS, so the property has to be set before the element upgrades.
	// Setting it via a define() interceptor installed BEFORE the CDN script is
	// appended wins that race; the whenDefined path covers every other ordering.
	function applyMeshopt(ctor) {
		if (ctor && !ctor.meshoptDecoderLocation) {
			try {
				ctor.meshoptDecoderLocation = MESHOPT_CDN;
			} catch (_) {
				/* property not writable in this build: nothing more we can do */
			}
		}
	}
	function installMeshopt() {
		if (!window.customElements) return;
		applyMeshopt(customElements.get('model-viewer'));
		if (!customElements.get('model-viewer') && !customElements.__meshoptDefinePatched) {
			customElements.__meshoptDefinePatched = true;
			var nativeDefine = customElements.define;
			customElements.define = function (name, ctor, options) {
				var result = nativeDefine.call(this, name, ctor, options);
				if (name === 'model-viewer') applyMeshopt(ctor);
				return result;
			};
		}
		customElements.whenDefined('model-viewer').then(function (resolved) {
			applyMeshopt(resolved || customElements.get('model-viewer'));
		});
	}

	// model-viewer is loaded once, lazily, on first <three-d> instance.
	// All instances share the same Promise so we never fetch it twice.
	var modelViewerReady = null;
	function ensureModelViewer() {
		if (modelViewerReady) return modelViewerReady;
		modelViewerReady = new Promise(function (resolve, reject) {
			installMeshopt();
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
	// fetch. Cleared on navigation, never persisted. Only the plain, ungated
	// response is cached: a gated response (locked teaser, or an unlocked
	// payload tied to one visitor's private access token) is never shared
	// across callers and is re-checked every time.
	var resolverCache = Object.create(null);
	function resolve(id, gateToken) {
		var cacheKey = gateToken ? null : id;
		if (cacheKey && resolverCache[cacheKey]) return resolverCache[cacheKey];
		var qs = '?id=' + encodeURIComponent(id) + (gateToken ? '&gate_token=' + encodeURIComponent(gateToken) : '');
		var p = fetch(ORIGIN + '/api/embed/resolve' + qs, { credentials: 'omit' })
			.then(function (r) {
				if (!r.ok) throw new Error('resolve failed: ' + r.status);
				return r.json();
			})
			.then(function (data) {
				if (data && data.gated && cacheKey) delete resolverCache[cacheKey];
				return data;
			});
		if (cacheKey) {
			resolverCache[cacheKey] = p.catch(function (err) {
				delete resolverCache[cacheKey]; // allow retry
				throw err;
			});
			return resolverCache[cacheKey];
		}
		return p;
	}

	// -------- Token gate: cached access token (per asset, per tab) ---------

	var GATE_TOKEN_PREFIX = 'threeWsGateToken:';

	function gateTokenKey(assetId) {
		return GATE_TOKEN_PREFIX + assetId;
	}

	function loadCachedGateToken(assetId) {
		try {
			var raw = sessionStorage.getItem(gateTokenKey(assetId));
			if (!raw) return null;
			var parsed = JSON.parse(raw);
			if (!parsed || !parsed.token || !parsed.exp) return null;
			// 5s safety margin so a token that's about to expire mid-request isn't
			// handed to the server, which would just bounce it back locked anyway.
			if (parsed.exp <= Date.now() + 5000) {
				sessionStorage.removeItem(gateTokenKey(assetId));
				return null;
			}
			return parsed;
		} catch (_) {
			return null;
		}
	}

	function saveGateToken(assetId, token, expiresInSec) {
		try {
			sessionStorage.setItem(
				gateTokenKey(assetId),
				JSON.stringify({ token: token, exp: Date.now() + Math.max(0, Number(expiresInSec) || 0) * 1000 }),
			);
		} catch (_) {
			/* sessionStorage unavailable (private mode / disabled) — token just isn't persisted */
		}
	}

	function clearCachedGateToken(assetId) {
		try {
			sessionStorage.removeItem(gateTokenKey(assetId));
		} catch (_) {}
	}

	// -------- Token gate: wallet connect + SIWS verify ----------------------

	function detectSolanaProvider() {
		if (typeof window === 'undefined') return null;
		return (
			(window.phantom && window.phantom.solana) ||
			window.solana ||
			(window.backpack && window.backpack.solana) ||
			window.solflare ||
			null
		);
	}

	function bytesToBase64(bytes) {
		var bin = '';
		for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	function gatePost(path, body) {
		return fetch(ORIGIN + path, {
			method: 'POST',
			credentials: 'omit',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}).then(function (r) {
			return r.json().then(
				function (data) {
					return { ok: r.ok, data: data };
				},
				function () {
					return { ok: false, data: null };
				},
			);
		});
	}

	function friendlyError(message, extra) {
		var err = new Error(message);
		if (extra) {
			for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) err[k] = extra[k];
		}
		return err;
	}

	// Full connect → sign → verify round trip for one asset. Resolves
	// { accessToken, expiresIn } on success; rejects with a `.userMessage` the
	// locked card can render directly (no provider, connection cancelled, bad
	// signature, or a real, server-checked insufficient balance).
	async function verifyGateOwnership(assetId) {
		var provider = detectSolanaProvider();
		if (!provider) {
			throw friendlyError('no wallet', {
				userMessage: 'No Solana wallet found in this browser.',
				installUrl: 'https://phantom.app',
			});
		}

		var wallet;
		try {
			var resp = provider.connect ? await provider.connect() : null;
			var pk = (resp && resp.publicKey) || provider.publicKey;
			wallet = pk && pk.toString ? pk.toString() : pk ? String(pk) : null;
		} catch (e) {
			throw friendlyError('connect rejected', {
				userMessage: /reject|4001/i.test((e && e.message) || '') ? 'Wallet connection was cancelled.' : 'Could not connect to your wallet.',
			});
		}
		if (!wallet) throw friendlyError('no address', { userMessage: 'Could not read your wallet address.' });

		var phase1 = await gatePost('/api/embed/gate-verify', { assetId: assetId, walletAddress: wallet });
		if (!phase1.ok || !phase1.data || !phase1.data.message) {
			throw friendlyError('phase1 failed', {
				userMessage: (phase1.data && phase1.data.message) || 'This embed is not gated (or the gate was removed).',
			});
		}
		var message = phase1.data.message;

		var signature;
		try {
			var msgBytes = new TextEncoder().encode(message);
			var signed = await provider.signMessage(msgBytes, 'utf8');
			var sigBytes = signed && signed.signature ? signed.signature : signed;
			signature = bytesToBase64(sigBytes);
		} catch (e) {
			throw friendlyError('signature rejected', {
				userMessage: /reject|4001/i.test((e && e.message) || '') ? 'Signature request was cancelled.' : 'Could not sign the verification message.',
			});
		}

		var phase2 = await gatePost('/api/embed/gate-verify', {
			assetId: assetId,
			walletAddress: wallet,
			signature: signature,
			message: message,
		});
		if (!phase2.ok || !phase2.data) {
			throw friendlyError('verify failed', { userMessage: 'Verification failed. Try again.' });
		}
		if (!phase2.data.allowed) {
			var have = phase2.data.amount != null ? Number(phase2.data.amount).toLocaleString() : '0';
			var need = phase2.data.minAmount != null ? Number(phase2.data.minAmount).toLocaleString() : '?';
			throw friendlyError('insufficient balance', {
				userMessage: 'You hold ' + have + ', need ' + need + '.',
				insufficientBalance: true,
			});
		}
		return { accessToken: phase2.data.accessToken, expiresIn: phase2.data.expiresIn };
	}

	var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	// Tracks which instances are visible so we only boot WebGL for ones that
	// matter. One shared observer for the whole page.
	var visibilityObserver = null;
	function observeVisibility(el) {
		if (el.hasAttribute('eager') || !('IntersectionObserver' in window)) {
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
		+ 'background:#0a0a0a;border-radius:14px;overflow:hidden;'
		+ 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;'
		+ 'color:#fff;line-height:1.4;contain:layout style;}'
		+ ':host([theme="light"]){background:#f7f7f8;color:#111;}'
		+ ':host([theme="transparent"]){background:transparent;}'
		+ '.stage{position:relative;width:100%;height:100%;min-height:280px;display:block;}'
		+ ':host([height]) .stage{min-height:0;}'
		+ 'model-viewer{width:100%;height:100%;display:block;background:transparent;'
		+ '--poster-color:transparent;--progress-bar-color:rgba(255,255,255,.5);--progress-bar-height:2px;}'
		+ '.poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
		+ 'background:linear-gradient(135deg,#111 0%,#1c1c1c 100%);transition:opacity .35s;}'
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
		// ── Token-gated locked state ──────────────────────────────────────
		+ '.gate{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
		+ 'justify-content:center;gap:10px;padding:28px 22px;text-align:center;opacity:0;'
		+ 'transition:opacity .32s ease;background:radial-gradient(120% 120% at 50% 0%,rgba(40,40,46,.9),rgba(6,6,8,.96));}'
		+ '.gate.gate--poster{background-size:cover;background-position:center;}'
		+ '.gate.gate--poster::before{content:"";position:absolute;inset:0;'
		+ 'backdrop-filter:blur(18px) saturate(70%);-webkit-backdrop-filter:blur(18px) saturate(70%);'
		+ 'background:rgba(8,8,10,.72);}'
		+ '.gate.gate--in{opacity:1;}'
		+ '.gate>*{position:relative;z-index:1;}'
		+ '.gate-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;'
		+ 'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#fff;margin-bottom:2px;}'
		+ '.gate-icon svg{width:16px;height:16px;}'
		+ '.gate-title{font-size:15px;font-weight:700;letter-spacing:-.005em;color:#fff;margin:0;line-height:1.35;max-width:280px;}'
		+ '.gate-sub{font-size:12px;color:rgba(255,255,255,.55);margin:0;max-width:260px;line-height:1.5;}'
		+ '.gate-btn{appearance:none;border:1px solid rgba(255,255,255,.22);border-radius:999px;'
		+ 'background:#fff;color:#0a0a0a;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;'
		+ 'padding:10px 20px;cursor:pointer;margin-top:6px;transition:transform .15s,background .15s,opacity .15s;'
		+ 'text-decoration:none;display:inline-flex;align-items:center;gap:6px;}'
		+ '.gate-btn:hover{background:#f0f0f0;transform:translateY(-1px);}'
		+ '.gate-btn:active{transform:translateY(0);}'
		+ '.gate-btn[aria-busy="true"]{opacity:.65;cursor:default;pointer-events:none;}'
		+ '.gate-btn:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px;}'
		+ '.gate-note{font-size:11.5px;color:rgba(255,255,255,.5);min-height:14px;margin-top:2px;max-width:260px;line-height:1.5;}'
		+ '.gate-note[data-tone="warn"]{color:#f5c98a;}'
		+ '.gate-mint{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;'
		+ 'color:rgba(255,255,255,.4);letter-spacing:.02em;}'
		+ ':host([theme="light"]) .gate{background:radial-gradient(120% 120% at 50% 0%,rgba(255,255,255,.94),rgba(240,240,242,.98));}'
		+ ':host([theme="light"]) .gate.gate--poster::before{background:rgba(255,255,255,.78);}'
		+ ':host([theme="light"]) .gate-title{color:#111;}'
		+ ':host([theme="light"]) .gate-sub,:host([theme="light"]) .gate-mint{color:rgba(0,0,0,.5);}'
		+ ':host([theme="light"]) .gate-icon{background:rgba(0,0,0,.06);border-color:rgba(0,0,0,.14);color:#111;}'
		+ ':host([theme="light"]) .gate-btn{background:#111;color:#fff;border-color:rgba(0,0,0,.2);}'
		+ ':host([theme="light"]) .gate-btn:hover{background:#000;}'
		+ '@media (prefers-reduced-motion: reduce){.gate,.gate-btn{transition:none;}}'
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
			var cachedGate = loadCachedGateToken(agentSpec);
			try {
				resolved = await resolve(agentSpec, cachedGate ? cachedGate.token : null);
			} catch (e) {
				throw new Error('Could not resolve agent "' + agentSpec + '"');
			}
			if (resolved && resolved.locked) {
				if (cachedGate) clearCachedGateToken(agentSpec); // stale/expired — drop it
				self.__renderLocked(resolved, agentSpec);
				return;
			}
			self.__clearLocked();
			if (resolved && resolved.gated && cachedGate) {
				// Re-verified from a still-valid cached session — keep the auto-revert
				// timer aligned with however much of the token's life is actually left.
				self.__scheduleGateExpiry(agentSpec, (cachedGate.exp - Date.now()) / 1000);
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

	// ── Token-gated locked state ────────────────────────────────────────────
	// Renders a designed teaser in place of the 3D scene: what it is, what it
	// takes to unlock, and a real connect-wallet CTA. Never leaves a blank box
	// or a bare error — every branch (no wallet, cancelled, wrong balance,
	// network hiccup) gets specific, actionable copy.

	var LOCK_SVG =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
		'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/>' +
		'<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';

	ThreeWsAgentElement.prototype.__clearLocked = function () {
		if (this.__gateEl) {
			this.__gateEl.remove();
			this.__gateEl = null;
		}
	};

	// Anti-abuse: re-verification on expiry. Access tokens are short-lived
	// (api/_lib/embed-gate-token.js), so a visitor who keeps a gated embed open
	// past the token's lifetime is automatically dropped back to the locked
	// state — never silently kept unlocked on a stale check.
	ThreeWsAgentElement.prototype.__scheduleGateExpiry = function (assetId, expiresInSec) {
		var self = this;
		if (this.__gateExpiryTimer) {
			clearTimeout(this.__gateExpiryTimer);
			this.__gateExpiryTimer = null;
		}
		var ms = Math.max(0, Number(expiresInSec) || 0) * 1000;
		if (!ms) return;
		this.__gateExpiryTimer = setTimeout(function () {
			self.__gateExpiryTimer = null;
			if (!self.isConnected || self.getAttribute('agent') !== assetId) return;
			clearCachedGateToken(assetId);
			self.__booted = false;
			self.__bootIfReady();
		}, ms);
	};

	ThreeWsAgentElement.prototype.__renderLocked = function (resolved, assetId) {
		var self = this;
		this.__clearLocked();
		if (this.__mv) {
			this.__mv.remove();
			this.__mv = null;
		}

		var gate = resolved.gate || {};
		var amount = gate.minAmount != null ? Number(gate.minAmount).toLocaleString() : '?';
		var symbol = gate.symbol || 'tokens';

		var el = document.createElement('div');
		el.className = 'gate';
		el.setAttribute('role', 'group');
		el.setAttribute('aria-label', 'Locked — token-gated 3D embed');
		if (resolved.poster) {
			el.classList.add('gate--poster');
			el.style.backgroundImage = 'url("' + String(resolved.poster).replace(/"/g, '%22') + '")';
		}

		var icon = document.createElement('div');
		icon.className = 'gate-icon';
		icon.innerHTML = LOCK_SVG;
		el.appendChild(icon);

		var title = document.createElement('p');
		title.className = 'gate-title';
		title.textContent = 'Hold ' + amount + ' ' + symbol + ' to unlock';
		el.appendChild(title);

		var sub = document.createElement('p');
		sub.className = 'gate-sub';
		sub.textContent = resolved.name
			? '"' + resolved.name + '" is a token-gated 3D embed on three.ws.'
			: 'This is a token-gated 3D embed on three.ws.';
		el.appendChild(sub);

		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'gate-btn';
		btn.textContent = 'Connect wallet';
		el.appendChild(btn);

		var note = document.createElement('p');
		note.className = 'gate-note';
		note.setAttribute('role', 'status');
		note.setAttribute('aria-live', 'polite');
		el.appendChild(note);

		if (!this.hasAttribute('hide-chrome') && gate.mint) {
			var mintEl = document.createElement('p');
			mintEl.className = 'gate-mint';
			mintEl.textContent = gate.mint;
			el.appendChild(mintEl);
		}

		var busy = false;
		btn.addEventListener('click', function () {
			if (busy) return;
			var provider = detectSolanaProvider();
			if (!provider) {
				note.textContent = 'No Solana wallet found — install Phantom, then try again.';
				note.dataset.tone = 'warn';
				btn.textContent = 'Get a wallet';
				btn.onclick = null;
				var link = document.createElement('a');
				link.href = 'https://phantom.app';
				link.target = '_blank';
				link.rel = 'noopener';
				link.className = 'gate-btn';
				link.textContent = 'Get a wallet';
				btn.replaceWith(link);
				return;
			}
			busy = true;
			btn.setAttribute('aria-busy', 'true');
			btn.textContent = 'Connecting…';
			note.textContent = '';
			note.dataset.tone = '';
			verifyGateOwnership(assetId)
				.then(function (result) {
					saveGateToken(assetId, result.accessToken, result.expiresIn);
					self.__scheduleGateExpiry(assetId, result.expiresIn);
					self.__booted = true; // already true, but keep intent explicit
					return self.__boot();
				})
				.catch(function (err) {
					busy = false;
					btn.removeAttribute('aria-busy');
					btn.textContent = 'Connect wallet';
					note.textContent = (err && err.userMessage) || 'Verification failed. Try again.';
					note.dataset.tone = 'warn';
				});
		});

		this.__stage.appendChild(el);
		this.__gateEl = el;
		requestAnimationFrame(function () {
			el.classList.add('gate--in');
		});
		this.dispatchEvent(
			new CustomEvent('three-gate:locked', {
				detail: { assetId: assetId, mint: gate.mint, minAmount: gate.minAmount },
				bubbles: true,
			}),
		);
	};

	ThreeWsAgentElement.prototype.disconnectedCallback = function () {
		if (visibilityObserver) visibilityObserver.unobserve(this);
		if (this.__gateExpiryTimer) {
			clearTimeout(this.__gateExpiryTimer);
			this.__gateExpiryTimer = null;
		}
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
