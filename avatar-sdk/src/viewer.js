// Minimal <three-ws-viewer> web component.
//
// Pure visual: loads a GLB at `src`, renders it with OrbitControls and a
// two-light setup. No chat, no voice, no skills — for sites that just want a
// 3D preview without pulling in the full <agent-3d> runtime.
//
// Peer-depends on `three` (>=0.150.0). Import paths use `three/addons/*`,
// which resolves through your bundler's normal three.js entry. Consumers
// that bundle this file get tree-shaking for free; the heavy <agent-3d>
// runtime in `./agent` is never touched.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	AmbientLight,
	DirectionalLight,
	Box3,
	Vector3,
	Color,
	Spherical,
	PMREMGenerator,
	ACESFilmicToneMapping,
	SRGBColorSpace,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadPercent, progressLabel, nextViewerState } from './viewer-state.js';

const TAG = 'three-ws-viewer';

// The platform's device-aware "View in AR" launcher (Android → Scene Viewer,
// iOS → Quick Look via model-viewer's on-the-fly USDZ conversion, desktop →
// the interactive viewer fallback). Already live at three.ws — reused as-is
// instead of duplicating USD export logic inside a peer-dependency-only SDK
// package. See api/ar.js + api/_lib/ar-launch.js in the three.ws monorepo.
const AR_LAUNCH_ORIGIN = 'https://three.ws';

// three.ws-served GLBs (and any gltf-transform-optimized asset) may carry
// EXT_meshopt_compression; without a decoder GLTFLoader throws before parsing.
// Lazy + memoized so uncompressed-only consumers never pay for the wasm init.
let _meshoptPromise = null;
function getMeshoptDecoder() {
	if (!_meshoptPromise) {
		_meshoptPromise = import('three/addons/libs/meshopt_decoder.module.js').then((m) => m.MeshoptDecoder);
	}
	return _meshoptPromise;
}

// KHR_draco_mesh_compression decoder — lazy + memoized alongside meshopt so a
// consumer that only ever loads meshopt (or uncompressed) assets never pays
// for the wasm init. Draco-compressed GLBs (max-compression tier, per
// prompts/finish/roadmap-REUSE-MAP.md §1) throw without this wired.
let _dracoPromise = null;
function getDracoLoader() {
	if (!_dracoPromise) {
		_dracoPromise = import('three/addons/loaders/DRACOLoader.js').then((m) => {
			const loader = new m.DRACOLoader();
			loader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
			return loader;
		});
	}
	return _dracoPromise;
}

// Real photographic IBL — every viewer on the platform is lit by an actual
// HDRI, not just the procedural RoomEnvironment. `<three-ws-viewer>` embeds
// on arbitrary third-party sites, so a root-relative path (`/hdri/studio.hdr`)
// would resolve against the HOST page's origin and 404; this fetches from
// three.ws's own absolute origin, same pattern as AR_LAUNCH_ORIGIN above.
// Lazy + memoized: the decoded HDRI texture is shared across every viewer
// instance on the page (each still gets its own PMREM-derived env map, so
// per-instance disposal never affects a sibling viewer).
let _hdriPromise = null;
function getHdriTexture() {
	if (!_hdriPromise) {
		// RGBELoader on purpose, not HDRLoader. three renamed the class in r180
		// (RGBELoader now subclasses HDRLoader and logs a deprecation warning on
		// construction), but our peer range is `three >= 0.150.0` and this file
		// ships as raw source on the "./viewer" subpath: the CONSUMER's bundler
		// resolves this specifier against THEIR three. HDRLoader.js does not
		// exist before r180, and a bundler resolves a literal dynamic import
		// statically, so naming it here turns one cosmetic console line on new
		// three into a hard "module not found" build failure on older three. A
		// runtime try/catch cannot rescue that: the failure is at build time.
		// Revisit when the peer floor moves to >= 0.180.0.
		_hdriPromise = import('three/addons/loaders/RGBELoader.js').then(({ RGBELoader }) =>
			new RGBELoader().loadAsync(`${AR_LAUNCH_ORIGIN}/hdri/studio.hdr`),
		);
	}
	return _hdriPromise;
}

// Low-power heuristic: coarse pointer (touch) + few cores/little memory almost
// always means an entry-level phone. `deviceMemory` is Chromium-only and
// absent on iOS/Firefox, so it only ever *adds* signal, never gates alone.
function looksLowPower() {
	if (typeof navigator === 'undefined' || typeof matchMedia === 'undefined') return false;
	const touch = matchMedia('(pointer: coarse)').matches;
	if (!touch) return false;
	const fewCores = typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4;
	const lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
	return fewCores || lowMem;
}

function prefersReducedMotion() {
	return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class ThreeWsViewerElement extends HTMLElement {
	static get observedAttributes() {
		return ['src', 'alt', 'background', 'wallet', 'agent-id', 'api-base', 'ar', 'auto-rotate'];
	}

	// Property accessors that reflect to the attributes above. Setting an
	// attribute has always worked; a plain `el.src = url` did not, which is how
	// React 19 (which prefers a property when the element defines one), Vue's
	// `.prop` bindings, and any `Object.assign(el, props)` helper drive a custom
	// element. Each accessor is a thin reflection, so both spellings drive the
	// same attributeChangedCallback path.
	get src() { return this.getAttribute('src'); }
	set src(value) { this._reflect('src', value); }

	get alt() { return this.getAttribute('alt'); }
	set alt(value) { this._reflect('alt', value); }

	get background() { return this.getAttribute('background'); }
	set background(value) { this._reflect('background', value); }

	get ar() { return this.hasAttribute('ar'); }
	set ar(value) { this._reflectBoolean('ar', value); }

	get autoRotate() { return this.hasAttribute('auto-rotate'); }
	set autoRotate(value) { this._reflectBoolean('auto-rotate', value); }

	_reflect(name, value) {
		if (value == null || value === '') this.removeAttribute(name);
		else this.setAttribute(name, String(value));
	}

	_reflectBoolean(name, value) {
		if (value) this.setAttribute(name, '');
		else this.removeAttribute(name);
	}

	// A framework that assigns a property before the element upgrades leaves an
	// own property shadowing the accessor forever. Deleting it and re-assigning
	// hands the value back to the accessor (the standard custom-element upgrade
	// dance) so a pre-upgrade `el.src = url` still loads the model.
	_upgradeProperty(name) {
		if (!Object.prototype.hasOwnProperty.call(this, name)) return;
		const value = this[name];
		delete this[name];
		this[name] = value;
	}

	constructor() {
		super();
		this._shadow = this.attachShadow({ mode: 'open' });
		this._shadow.innerHTML = `<style>
			:host { display: block; position: relative; width: 100%; height: 100%; min-height: 320px; }
			/* The canvas fades in once the model is framed, so it materializes instead
			   of popping. Starts transparent; .is-ready reveals it. */
			canvas { display: block; width: 100%; height: 100%; outline: none; touch-action: none; opacity: 0; transition: opacity 0.55s ease; }
			:host(.is-ready) canvas { opacity: 1; }
			canvas:focus-visible { outline: 2px solid #6ee7b7; outline-offset: -2px; }
			.label { position: absolute; inset: auto 0 8px 0; text-align: center; font: 12px system-ui, sans-serif; color: rgba(255,255,255,0.65); pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
			.ar-btn {
				position: absolute; right: 10px; bottom: 10px; z-index: 1;
				display: inline-flex; align-items: center; gap: 6px;
				appearance: none; cursor: pointer; border: 1px solid rgba(255,255,255,0.22);
				border-radius: 999px; padding: 8px 14px; background: rgba(10,11,14,0.72);
				color: #fff; font: 600 12.5px/1 system-ui, sans-serif; backdrop-filter: blur(6px);
				transition: background 0.15s, border-color 0.15s, transform 0.08s;
			}
			.ar-btn:hover { background: rgba(20,22,28,0.85); border-color: rgba(255,255,255,0.4); }
			.ar-btn:active { transform: translateY(1px); }
			.ar-btn:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
			/* Designed load lifecycle: loading spinner, error card, empty placeholder.
			   One overlay host, swapped by _setState; pointer-events only where a
			   control lives so orbit drags pass through everywhere else. */
			.tws-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; pointer-events: none; }
			.tws-overlay[hidden] { display: none; }
			.tws-inner { display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 280px; text-align: center; font: 13px/1.5 system-ui, sans-serif; color: rgba(255,255,255,0.82); }
			.tws-spinner { width: 34px; height: 34px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,0.14); border-top-color: #6ee7b7; animation: tws-spin 0.8s linear infinite; }
			.tws-progress { font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; color: rgba(255,255,255,0.6); }
			.tws-title { font-weight: 700; color: #fff; }
			.tws-body { color: rgba(255,255,255,0.6); }
			.tws-icon { color: rgba(255,255,255,0.34); }
			.tws-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; pointer-events: auto; }
			.tws-btn { appearance: none; cursor: pointer; border: 1px solid rgba(255,255,255,0.22); border-radius: 999px; padding: 8px 15px; background: rgba(255,255,255,0.06); color: #fff; font: 600 12.5px/1 system-ui, sans-serif; text-decoration: none; display: inline-flex; align-items: center; transition: background 0.15s, border-color 0.15s, transform 0.08s; }
			.tws-btn:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.4); }
			.tws-btn:active { transform: translateY(1px); }
			.tws-btn:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
			.tws-btn--primary { background: #6ee7b7; border-color: #6ee7b7; color: #04140d; }
			.tws-btn--primary:hover { background: #5bd9a6; }
			/* One-time "drag to rotate" cue, shown when a model first becomes ready. */
			.tws-hint { position: absolute; left: 50%; top: 12px; transform: translate(-50%, -6px); z-index: 1; padding: 5px 12px; border-radius: 999px; background: rgba(10,11,14,0.66); border: 1px solid rgba(255,255,255,0.14); color: rgba(255,255,255,0.82); font: 500 11.5px/1 system-ui, sans-serif; backdrop-filter: blur(6px); pointer-events: none; opacity: 0; transition: opacity 0.3s ease, transform 0.3s ease; }
			.tws-hint.is-visible { opacity: 1; transform: translate(-50%, 0); }
			@keyframes tws-spin { to { transform: rotate(360deg); } }
			@media (prefers-reduced-motion: reduce) {
				.ar-btn, .tws-btn, .tws-hint { transition: none; }
				canvas { transition: none; }
				.tws-spinner { animation: none; border-top-color: rgba(255,255,255,0.5); }
			}
		</style>`;
		this._canvas = document.createElement('canvas');
		this._canvas.tabIndex = 0;
		this._canvas.setAttribute('role', 'img');
		this._shadow.appendChild(this._canvas);

		// Overlay host for the loading / error / empty states, plus a transient
		// interaction hint. Built once; content swapped by _setState.
		this._overlay = document.createElement('div');
		this._overlay.className = 'tws-overlay';
		this._overlay.hidden = true;
		this._shadow.appendChild(this._overlay);
		this._hint = document.createElement('div');
		this._hint.className = 'tws-hint';
		this._hint.textContent = 'Drag to rotate';
		this._hint.hidden = true;
		this._shadow.appendChild(this._hint);

		this._label = null;
		this._arBtn = null;
		this._state = null;
		this._hintTimer = 0;
		this._hintShown = false;

		this._scene = null;
		this._camera = null;
		this._renderer = null;
		this._controls = null;
		this._model = null;
		this._raf = 0;
		this._resizeObs = null;
		this._loadToken = 0;
		this._wallet = null; // mounted wallet affordance, when opted in

		this._reducedMotion = prefersReducedMotion();
		this._lowPower = looksLowPower();
		this._basePixelRatio = this._lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2);
		this._fpsWindow = [];
		this._degraded = false;

		this._onKeydown = this._onKeydown.bind(this);
	}

	connectedCallback() {
		for (const prop of ['src', 'alt', 'background', 'ar', 'autoRotate']) this._upgradeProperty(prop);
		this._init();
		this._render = this._render.bind(this);
		this._raf = requestAnimationFrame(this._render);
		this._applyAutoRotate();
		const src = this.getAttribute('src');
		if (src) this._loadModel(src);
		else this._setState('empty'); // designed placeholder instead of a blank canvas
		this._applyAlt(this.getAttribute('alt'));
		this._applyWallet();
		this._applyAr();
		this._canvas.addEventListener('keydown', this._onKeydown);
		// First real interaction retires the "drag to rotate" cue early.
		this._dismissHint = this._dismissHint.bind(this);
		this._canvas.addEventListener('pointerdown', this._dismissHint);
	}

	disconnectedCallback() {
		cancelAnimationFrame(this._raf);
		this._raf = 0;
		clearTimeout(this._hintTimer);
		this._canvas.removeEventListener('keydown', this._onKeydown);
		if (this._dismissHint) this._canvas.removeEventListener('pointerdown', this._dismissHint);
		if (this._resizeObs) {
			this._resizeObs.disconnect();
			this._resizeObs = null;
		}
		if (this._controls) {
			this._controls.dispose();
			this._controls = null;
		}
		if (this._renderer) {
			this._renderer.dispose();
			this._renderer.forceContextLoss?.();
			this._renderer = null;
		}
		this._envTex?.dispose();
		this._envTex = null;
		if (this._wallet) { try { this._wallet.destroy(); } catch { /* gone */ } this._wallet = null; }
		if (this._model) { this._disposeModel(this._model); this._model = null; }
		this._scene = null;
		this._camera = null;
	}

	attributeChangedCallback(name, _old, value) {
		if (!this._scene) return;
		if (name === 'src') {
			if (value) this._loadModel(value);
			else this._setState('empty');
		}
		else if (name === 'alt') this._applyAlt(value);
		else if (name === 'background') this._applyBackground(value);
		else if (name === 'wallet' || name === 'agent-id' || name === 'api-base') this._applyWallet();
		else if (name === 'ar') this._applyAr();
		else if (name === 'auto-rotate') this._applyAutoRotate();
	}

	_init() {
		this._scene = new Scene();
		this._applyBackground(this.getAttribute('background'));

		const width = this.clientWidth || 320;
		const height = this.clientHeight || 320;

		this._camera = new PerspectiveCamera(35, width / height, 0.05, 200);
		this._camera.position.set(0, 1.3, 3);

		this._renderer = new WebGLRenderer({
			canvas: this._canvas,
			// Low-power devices skip MSAA — the biggest single GPU cost on
			// entry-level mobile GPUs — in exchange for a stable frame rate.
			antialias: !this._lowPower,
			alpha: true,
			powerPreference: 'high-performance',
		});
		this._renderer.setPixelRatio(this._basePixelRatio);
		this._renderer.setSize(width, height, false);
		this._renderer.outputColorSpace = SRGBColorSpace;
		this._renderer.toneMapping = ACESFilmicToneMapping;
		this._renderer.toneMappingExposure = 1.0;

		// Low-power devices skip the PMREM environment prefilter (a real-time
		// render-to-cubemap pass) and get a slightly brighter ambient term
		// instead — visually close, meaningfully cheaper on first paint.
		if (!this._lowPower) {
			const pmrem = new PMREMGenerator(this._renderer);
			pmrem.compileEquirectangularShader();
			// Paint immediately with the procedural room so the model is never
			// unlit while the real HDRI streams in over the network — then swap
			// to the photographic environment once it lands.
			this._envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
			this._scene.environment = this._envTex;
			getHdriTexture()
				.then((hdrTexture) => {
					if (!this._renderer || !this._scene) { pmrem.dispose(); return; } // torn down before it landed
					const prevEnv = this._envTex;
					this._envTex = pmrem.fromEquirectangular(hdrTexture).texture;
					this._scene.environment = this._envTex;
					prevEnv?.dispose();
					pmrem.dispose();
				})
				.catch(() => {
					// Real HDRI unreachable from this embed's host (offline, CSP,
					// blocked cross-origin request) — the procedural room stays as
					// a correct, if less photographic, fallback.
					pmrem.dispose();
				});
		}

		this._scene.add(new AmbientLight(0xffffff, this._lowPower ? 0.75 : 0.55));
		const key = new DirectionalLight(0xffffff, 1.1);
		key.position.set(2, 4, 3);
		this._scene.add(key);

		this._controls = new OrbitControls(this._camera, this._canvas);
		this._controls.enableDamping = !this._reducedMotion;
		this._controls.dampingFactor = 0.08;
		this._controls.target.set(0, 1.0, 0);
		this._controls.update();

		this._resizeObs = new ResizeObserver(() => this._handleResize());
		this._resizeObs.observe(this);
	}

	// Keyboard-only orbit + zoom for users who can't drag a pointer. Arrow keys
	// rotate azimuth/polar around the current target; +/- and PageUp/PageDown
	// dolly. Mirrors OrbitControls' own step sizes so keyboard and pointer
	// interaction feel consistent.
	_onKeydown(event) {
		if (!this._controls || !this._camera) return;
		const rotateStep = 0.05; // radians
		const zoomStep = 1.08;
		const offset = new Vector3().subVectors(this._camera.position, this._controls.target);
		const spherical = new Spherical().setFromVector3(offset);
		let handled = true;
		switch (event.key) {
			case 'ArrowLeft': spherical.theta -= rotateStep; break;
			case 'ArrowRight': spherical.theta += rotateStep; break;
			case 'ArrowUp': spherical.phi = Math.max(0.05, spherical.phi - rotateStep); break;
			case 'ArrowDown': spherical.phi = Math.min(Math.PI - 0.05, spherical.phi + rotateStep); break;
			case '+':
			case '=':
			case 'PageUp': spherical.radius /= zoomStep; break;
			case '-':
			case '_':
			case 'PageDown': spherical.radius *= zoomStep; break;
			default: handled = false;
		}
		if (!handled) return;
		event.preventDefault();
		offset.setFromSpherical(spherical);
		this._camera.position.copy(this._controls.target).add(offset);
		this._controls.update();
	}

	_handleResize() {
		if (!this._renderer || !this._camera) return;
		const w = this.clientWidth || 1;
		const h = this.clientHeight || 1;
		this._renderer.setSize(w, h, false);
		this._camera.aspect = w / h;
		this._camera.updateProjectionMatrix();
	}

	async _loadModel(url) {
		if (!url) { this._setState('empty'); return; }
		this._currentSrc = url;
		const token = ++this._loadToken;
		this._setState('loading');
		const loader = new GLTFLoader();
		try {
			const [meshoptDecoder, dracoLoader] = await Promise.all([getMeshoptDecoder(), getDracoLoader()]);
			if (token !== this._loadToken) return; // superseded while decoders resolved
			loader.setMeshoptDecoder(meshoptDecoder);
			loader.setDRACOLoader(dracoLoader);
			// Real byte progress: GLTFLoader forwards the XHR ProgressEvent, so the
			// overlay shows an honest percent (indeterminate spinner when the server
			// omits Content-Length) and a `progress` event fires for the host page.
			const gltf = await new Promise((resolve, reject) => {
				loader.load(
					url,
					resolve,
					(evt) => {
						if (token !== this._loadToken) return;
						const pct = loadPercent(evt?.loaded, evt?.total);
						this._setLoadProgress(pct);
						this.dispatchEvent(new CustomEvent('progress', {
							detail: { url, loaded: evt?.loaded ?? 0, total: evt?.total ?? 0, percent: pct },
						}));
					},
					reject,
				);
			});
			if (token !== this._loadToken || !this._scene) return;
			if (this._model) { this._scene.remove(this._model); this._disposeModel(this._model); }
			this._model = gltf.scene;
			this._scene.add(this._model);
			this._frameModel(this._model);
			this._setState('ready');
			this.dispatchEvent(new CustomEvent('load', { detail: { url } }));
		} catch (err) {
			if (token !== this._loadToken) return;
			this._setState('error', err);
			this.dispatchEvent(new CustomEvent('error', { detail: { url, error: err } }));
		}
	}

	// ── Load-lifecycle overlays ──────────────────────────────────────────────
	// Swap the overlay to match the load state, reveal/hide the canvas, and (on
	// first ready) flash the interaction hint. All content is built here so the
	// component ships one self-contained visual for every state instead of a blank
	// canvas the embedding page has to paper over.
	_setState(state, error) {
		if (state === this._state && state !== 'error') return;
		this._state = state;
		this.classList.toggle('is-ready', state === 'ready');
		if (state === 'ready') {
			this._overlay.hidden = true;
			this._showHintOnce();
			return;
		}
		this._overlay.hidden = false;
		if (state === 'loading') this._renderLoading();
		else if (state === 'empty') this._renderEmpty();
		else if (state === 'error') this._renderError(error);
	}

	_renderLoading() {
		this._overlay.innerHTML =
			'<div class="tws-inner"><div class="tws-spinner"></div>' +
			'<div class="tws-progress" part="progress">Loading</div></div>';
		this._progressEl = this._overlay.querySelector('.tws-progress');
	}

	_setLoadProgress(pct) {
		if (this._state !== 'loading' || !this._progressEl) return;
		this._progressEl.textContent = progressLabel(pct);
	}

	_renderEmpty() {
		this._overlay.innerHTML =
			'<div class="tws-inner">' +
			'<svg class="tws-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
			'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/></svg>' +
			'<div class="tws-body">No model to show yet. Set a <code>src</code> to a GLB to load one.</div></div>';
	}

	_renderError(err) {
		const overlay = this._overlay;
		overlay.innerHTML =
			'<div class="tws-inner">' +
			'<svg class="tws-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
			'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>' +
			'<div class="tws-title">Couldn’t load this model</div>' +
			'<div class="tws-body">The 3D file didn’t load. Check your connection, then try again.</div>' +
			'<div class="tws-row"></div></div>';
		const row = overlay.querySelector('.tws-row');
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'tws-btn tws-btn--primary';
		retry.textContent = 'Try again';
		retry.addEventListener('click', () => this._loadModel(this._currentSrc || this.getAttribute('src')));
		row.appendChild(retry);
		const src = this._currentSrc || this.getAttribute('src');
		if (src) {
			const dl = document.createElement('a');
			dl.className = 'tws-btn';
			dl.href = src;
			dl.setAttribute('download', '');
			dl.setAttribute('rel', 'noopener');
			dl.textContent = 'Download GLB';
			row.appendChild(dl);
		}
	}

	_showHintOnce() {
		if (this._hintShown || this._reducedMotion) return;
		this._hintShown = true;
		this._hint.hidden = false;
		// Next frame so the transition runs from the hidden state.
		requestAnimationFrame(() => this._hint.classList.add('is-visible'));
		this._hintTimer = setTimeout(() => this._dismissHint(), 2600);
	}

	_dismissHint() {
		if (!this._hint || this._hint.hidden) return;
		clearTimeout(this._hintTimer);
		this._hint.classList.remove('is-visible');
		setTimeout(() => { if (this._hint) this._hint.hidden = true; }, 300);
	}

	// Opt-in idle spin (`auto-rotate` boolean attribute). Off by default so existing
	// embeds are unchanged; when on, it both adds life and signals the model is
	// interactive. Reduced-motion users never get the spin.
	_applyAutoRotate() {
		if (!this._controls) return;
		this._controls.autoRotate = this.hasAttribute('auto-rotate') && !this._reducedMotion;
		this._controls.autoRotateSpeed = 1.0;
	}

	_frameModel(obj) {
		const box = new Box3().setFromObject(obj);
		const size = new Vector3();
		const center = new Vector3();
		box.getSize(size);
		box.getCenter(center);

		const maxDim = Math.max(size.x, size.y, size.z) || 1;
		const fov = (this._camera.fov * Math.PI) / 180;
		const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.6;

		this._camera.position.set(center.x, center.y + size.y * 0.05, center.z + dist);
		this._camera.near = Math.max(0.01, dist / 100);
		this._camera.far = dist * 50;
		this._camera.updateProjectionMatrix();
		this._controls.target.copy(center);
		this._controls.update();
	}

	_applyBackground(value) {
		if (!this._scene) return;
		if (!value || value === 'transparent') {
			this._scene.background = null;
			return;
		}
		try {
			this._scene.background = new Color(value);
		} catch {
			this._scene.background = null;
		}
	}

	_applyAlt(value) {
		const text = (value || '').trim() || '3D model viewer';
		this.setAttribute('aria-label', text);
		this._canvas.setAttribute('aria-label', text);
		if (!(value || '').trim()) {
			if (this._label) {
				this._label.remove();
				this._label = null;
			}
			return;
		}
		if (!this._label) {
			this._label = document.createElement('div');
			this._label.className = 'label';
			this._shadow.appendChild(this._label);
		}
		this._label.textContent = text;
	}

	// Opt-in "View in AR" affordance (`ar` boolean attribute). Absent by
	// default — existing embeds are unaffected. Delegates to the platform's
	// already-live device-aware AR launcher (three.ws/api/ar): Android opens
	// Google Scene Viewer, iOS opens Apple Quick Look (model-viewer converts
	// the GLB to USDZ on the fly there — no client-side USD export needed in
	// this lightweight, peer-dependency-only SDK component), desktop falls
	// back to the interactive viewer. New tab, so the host page never
	// navigates away under the embed.
	_applyAr() {
		const wants = this.hasAttribute('ar');
		if (!wants) {
			if (this._arBtn) { this._arBtn.remove(); this._arBtn = null; }
			return;
		}
		if (this._arBtn) return; // already mounted
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ar-btn';
		btn.setAttribute('aria-label', 'View this model in augmented reality');
		btn.innerHTML =
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
			'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/>' +
			'<path d="m3 7 9 5 9-5"/><path d="M12 12v10"/></svg><span>View in AR</span>';
		btn.addEventListener('click', () => this._launchAr());
		this._shadow.appendChild(btn);
		this._arBtn = btn;
	}

	_launchAr() {
		const src = this._currentSrc || this.getAttribute('src');
		if (!src) return;
		let absoluteSrc;
		try {
			absoluteSrc = new URL(src, window.location.href).href;
		} catch {
			return;
		}
		const params = new URLSearchParams({ src: absoluteSrc });
		const title = (this.getAttribute('alt') || '').trim();
		if (title) params.set('title', title.slice(0, 120));
		const launchUrl = `${AR_LAUNCH_ORIGIN}/api/ar?${params.toString()}`;
		window.open(launchUrl, '_blank', 'noopener');
		this.dispatchEvent(new CustomEvent('ar-launch', { detail: { src: absoluteSrc, launchUrl } }));
	}

	// Opt-in wallet identity: with `wallet agent-id="<uuid>"` the viewer shows the
	// agent's public wallet (address, value, tips, one-tap tip) without pulling the
	// heavy <agent-3d> runtime or any dependency. Lazy-loaded so a wallet-less embed
	// pays zero cost. Visitor view only — never an owner control.
	async _applyWallet() {
		const wants = this.hasAttribute('wallet');
		const agentId = (this.getAttribute('agent-id') || '').trim();
		const apiBase = (this.getAttribute('api-base') || '').trim() || undefined;
		// Tear down on a change so we never stack two cards or keep a stale agent.
		if (this._wallet) { try { this._wallet.destroy(); } catch { /* gone */ } this._wallet = null; }
		if (!wants || !agentId) return;
		const network = (this.getAttribute('wallet') || '').toLowerCase() === 'devnet' ? 'devnet' : 'mainnet';
		try {
			const { mountSdkWallet } = await import('./wallet-affordance.js');
			if (!this.isConnected || (this.getAttribute('agent-id') || '').trim() !== agentId) return;
			this._wallet = mountSdkWallet(this._shadow, { agentId, apiBase, network });
		} catch {
			/* wallet module unavailable — the viewer still renders the avatar cleanly */
		}
	}

	_disposeModel(obj) {
		obj?.traverse?.((n) => {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			mats.forEach((m) => {
				if (!m) return;
				for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
				m.dispose?.();
			});
		});
	}

	_render(now) {
		if (!this._renderer) return;
		this._raf = requestAnimationFrame(this._render);
		this._controls?.update();
		this._renderer.render(this._scene, this._camera);
		this._sampleFps(now || performance.now());
	}

	// Runtime quality auto-degrade: a device that *reports* as capable but
	// actually renders below ~24fps (thermal throttling, an old iGPU, a
	// background-tab wake-up) gets its pixel ratio dropped once, live — no
	// reload, no flicker, just a resolution step-down. Only ever tightens;
	// never re-escalates mid-session (avoids oscillating).
	_sampleFps(now) {
		if (this._degraded || !this._lastFrameTime) {
			this._lastFrameTime = now;
			return;
		}
		const delta = now - this._lastFrameTime;
		this._lastFrameTime = now;
		this._fpsWindow.push(delta);
		if (this._fpsWindow.length < 90) return; // ~1.5s at 60fps before judging
		const avg = this._fpsWindow.reduce((a, b) => a + b, 0) / this._fpsWindow.length;
		this._fpsWindow.length = 0;
		if (avg > 41.6) { // sustained < ~24fps
			this._degraded = true;
			const next = Math.max(1, this._basePixelRatio * 0.75);
			this._renderer.setPixelRatio(next);
		}
	}
}

if (typeof customElements !== 'undefined' && !customElements.get(TAG)) {
	customElements.define(TAG, ThreeWsViewerElement);
}

export { ThreeWsViewerElement };
export default ThreeWsViewerElement;
