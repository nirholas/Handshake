// Shared <model-viewer> shim, loaded as a classic script on every page that
// renders a model-viewer. Two concerns live here:
//   1. Registers the EXT_meshopt_compression decoder as early as possible
//      (the original purpose of this file, details below).
//   2. Orbit hold: once the user drags a camera-controls viewer to an angle,
//      auto-rotate is stopped for good so the turntable never carries the
//      model away from the angle they chose (second IIFE at the bottom).
//
// Registers the EXT_meshopt_compression decoder with <model-viewer> as early as
// possible — before any <model-viewer> begins loading, including an eager,
// above-the-fold one whose GLB ships meshopt-compressed.
//
// model-viewer auto-loads the Draco and KTX2 decoders but leaves Meshopt unset.
// Every server-baked avatar (the /api/avatars/<id>/glb lane and Forge output)
// emits EXT_meshopt_compression, so without this the viewer throws
//   "THREE.GLTFLoader: setMeshoptDecoder must be called before loading
//    compressed files"
// and the model never renders.
//
// Timing matters: model-viewer captures its loader's decoder config at the moment
// a load STARTS, not when the GLB finishes downloading. Setting the static
// `meshoptDecoderLocation` after a load has begun is too late — the in-flight
// loader was already built without it. A deferred module that runs *after*
// model-viewer's own module therefore loses the race for an eager element (the
// element upgrades and loads in the microtask between the two module scripts —
// exactly the cz.glb failure seen on /register).
//
// To always win that race this file:
//   1. sets the property synchronously if the element is already defined,
//   2. intercepts customElements.define() so the property is set the instant
//      'model-viewer' is defined — before the element upgrades and loads, and
//   3. keeps a whenDefined() fallback for older browsers.
//
// Load it as a CLASSIC script (no type="module"). Classic scripts execute during
// parsing, before deferred module scripts (model-viewer is one), so the define()
// interceptor is installed before model-viewer is ever defined. It has no imports
// or exports, so it also runs correctly if a page still loads it as a module.
(function () {
	if (!window.customElements) return;
	// Served from our own origin (public/vendor/, vendored from the meshoptimizer
	// npm package by scripts/vendor-meshopt-decoder.mjs). It used to hotlink
	// jsdelivr, which made every compressed model on the site unrenderable for
	// anyone the CDN is slow or blocked for, and added a second DNS + TLS
	// handshake to the critical path of the first 3D frame on a phone.
	var DECODER_URL = '/vendor/meshopt_decoder.js';

	function applyTo(ctor) {
		// `meshoptDecoderLocation` is a writable static on model-viewer; guard the
		// assignment so a future read-only build degrades to a no-op rather than
		// throwing and taking the page's module graph down with it.
		if (ctor && !ctor.meshoptDecoderLocation) {
			try {
				ctor.meshoptDecoderLocation = DECODER_URL;
			} catch (e) {
				/* property not writable in this build — nothing more we can do */
			}
		}
	}

	// 1. Helper ran after model-viewer was defined → set it now, synchronously.
	applyTo(customElements.get('model-viewer'));

	// 2. Helper ran before model-viewer was defined (classic script during parse)
	//    → patch define() so the decoder is registered the moment the element is
	//    defined, before its first reactive update kicks off a load. Idempotent:
	//    a flag prevents double-wrapping if this file is included twice.
	if (!customElements.get('model-viewer') && !customElements.__meshoptDefinePatched) {
		customElements.__meshoptDefinePatched = true;
		var nativeDefine = customElements.define;
		customElements.define = function (name, ctor, options) {
			var result = nativeDefine.call(this, name, ctor, options);
			if (name === 'model-viewer') applyTo(ctor);
			return result;
		};
	}

	// 3. Belt-and-suspenders: covers any path where (1) and (2) both miss.
	customElements.whenDefined('model-viewer').then(function (resolved) {
		applyTo(resolved || customElements.get('model-viewer'));
	});
})();

// Orbit hold: a user who drags a model to an angle wants to KEEP that angle.
// model-viewer only pauses auto-rotate during interaction and resumes after
// auto-rotate-delay (default 3000 ms; several of our surfaces set 0), so the
// turntable would spin the model right back off the angle they chose. The
// moment a real drag happens (or an arrow-key orbit), auto-rotate is removed
// permanently on that element.
//
// Delegated on document so it covers every current and future <model-viewer>,
// including ones injected via innerHTML long after this script ran. Pointer
// events are composed, so they retarget out of model-viewer's shadow root and
// appear here with the host element on the composed path. Only elements with
// camera-controls are touched: display-only hero turntables (no user orbit)
// keep spinning by design. A tap without movement also leaves the turntable
// alone; only a deliberate drag claims the camera.
(function () {
	if (typeof document === 'undefined' || window.__mvOrbitHoldInstalled) return;
	window.__mvOrbitHoldInstalled = true;
	var DRAG_PX = 6;

	function findViewer(event) {
		var path = event.composedPath ? event.composedPath() : [event.target];
		for (var i = 0; i < path.length; i++) {
			if (path[i] && path[i].tagName === 'MODEL-VIEWER') return path[i];
		}
		return null;
	}

	function holdOrbit(mv) {
		if (mv.__orbitHeld) return;
		mv.__orbitHeld = true;
		mv.removeAttribute('auto-rotate');
		// Some surfaces re-add auto-rotate later (e.g. marketplace-detail toggles
		// it on viewport re-entry). The user's chosen angle wins: strip it again
		// whenever it reappears. Removing it inside the callback re-fires the
		// observer once for the removal, which no-ops on the hasAttribute check.
		if (window.MutationObserver) {
			new MutationObserver(function () {
				if (mv.hasAttribute('auto-rotate')) mv.removeAttribute('auto-rotate');
			}).observe(mv, { attributes: true, attributeFilter: ['auto-rotate'] });
		}
	}

	document.addEventListener(
		'pointerdown',
		function (e) {
			var mv = findViewer(e);
			if (!mv || mv.__orbitHeld) return;
			if (!mv.hasAttribute('camera-controls') || !mv.hasAttribute('auto-rotate')) return;
			var startX = e.clientX;
			var startY = e.clientY;
			var pointerId = e.pointerId;
			function onMove(ev) {
				if (ev.pointerId !== pointerId) return;
				if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_PX) return;
				holdOrbit(mv);
				cleanup();
			}
			function cleanup() {
				mv.removeEventListener('pointermove', onMove);
				mv.removeEventListener('pointerup', cleanup);
				mv.removeEventListener('pointercancel', cleanup);
			}
			mv.addEventListener('pointermove', onMove);
			mv.addEventListener('pointerup', cleanup);
			mv.addEventListener('pointercancel', cleanup);
		},
		true
	);

	// Keyboard orbit (model-viewer moves the camera with the arrow keys when the
	// element is focused) deserves the same hold as a drag.
	document.addEventListener(
		'keydown',
		function (e) {
			if (
				e.key !== 'ArrowLeft' &&
				e.key !== 'ArrowRight' &&
				e.key !== 'ArrowUp' &&
				e.key !== 'ArrowDown'
			) {
				return;
			}
			var mv = findViewer(e);
			if (!mv || mv.__orbitHeld) return;
			if (!mv.hasAttribute('camera-controls') || !mv.hasAttribute('auto-rotate')) return;
			holdOrbit(mv);
		},
		true
	);
})();
