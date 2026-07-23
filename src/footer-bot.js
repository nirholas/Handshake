import {
	WebGLRenderer,
	ACESFilmicToneMapping,
	SRGBColorSpace,
	Scene,
	PerspectiveCamera,
	MathUtils,
	AmbientLight,
	DirectionalLight,
	Timer,
	AnimationMixer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { reserveWebGLContext } from './webgl-budget.js';
import { loadEnvironment } from './shared/cinematic-render.js';

// The footer bot is purely decorative. Every failure mode here — no mount
// point, a browser that refuses a WebGL context (context budget exhausted, GPU
// blocklist, headless/locked-down environment) — must degrade to an empty
// canvas, never an uncaught error. The whole init is wrapped so a throw on any
// page leaves the rest of the page untouched.
(function initFooterBot() {
	const canvas = document.getElementById('footer-bot-canvas');
	if (!canvas) return; // no mount point on this page — nothing to render

	const parent = canvas.parentElement;
	const w = parent?.clientWidth || 300;
	const h = parent?.clientHeight || 400;

	let renderer;
	try {
		renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
	} catch {
		// Context creation throws when the page already holds the browser's max
		// number of live WebGL contexts, or the GPU is unavailable. Decorative —
		// skip silently rather than surface "Error creating WebGL context".
		return;
	}
	renderer.setSize(w, h);
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.7;
	renderer.outputColorSpace = SRGBColorSpace;
	// Count this context against the shared budget so <agent-3d> grids on the same
	// page leave room for it (see webgl-budget.js / element.js).
	reserveWebGLContext();

	const scene = new Scene();
	// This widget mounts on every page load, site-wide. A real HDRI fetch would
	// add a network request (and PMREM compile cost) to every page for a small,
	// purely decorative mascot that most users never look at directly — not
	// worth the tradeoff. Pass `null` so loadEnvironment installs the
	// procedural RoomEnvironment instead: still correct PBR image-based
	// lighting (soft, neutral, no washed-out flat shading), zero network cost.
	loadEnvironment(renderer, scene, null);

	// Match model-viewer camera-orbit="0deg 80deg 9m" field-of-view="35deg"
	const camera = new PerspectiveCamera(35, w / h, 0.1, 100);
	const phi = MathUtils.degToRad(80);
	camera.position.set(0, 9 * Math.cos(phi), 9 * Math.sin(phi));
	camera.lookAt(0, 0, 0);

	// Neutral environment (exposure 0.7, no shadows)
	scene.add(new AmbientLight(0xffffff, 1.5));
	const sun = new DirectionalLight(0xffffff, 2.0);
	sun.position.set(1, 2, 3);
	scene.add(sun);
	const fill = new DirectionalLight(0xffffff, 0.5);
	fill.position.set(-1, 1, -2);
	scene.add(fill);

	let mixer = null;
	const clock = new Timer();
	let robot = null;

	// A transient CDN/network blip on the primary asset must never leave an empty
	// canvas. Walk a fallback chain — the expressive robot, retried once for
	// transient failures, then a static avatar that ships in the same bundle —
	// and give up silently only if every source is unreachable. A model with no
	// clips simply renders without motion.
	const BOT_ASSETS = ['/animations/robotexpressive.glb', '/avatars/default.glb'];

	function mountBot(gltf) {
		robot = gltf.scene;
		scene.add(robot);
		if (gltf.animations.length > 0) {
			mixer = new AnimationMixer(robot);
			mixer.clipAction(gltf.animations[0]).play();
		}
	}

	// Both bot assets ship with EXT_meshopt_compression, so the loader must have
	// the meshopt decoder wired before it can parse a single bufferView —
	// otherwise GLTFLoader throws "setMeshoptDecoder must be called before loading
	// compressed files". One loader, built once; getMeshoptDecoder is memoized and
	// shared with the rest of the app, and pulls only the small meshopt module
	// (no draco/KTX2 — these assets use neither).
	let _loaderPromise = null;
	function getLoader() {
		if (!_loaderPromise) {
			_loaderPromise = getMeshoptDecoder().then((decoder) => {
				const loader = new GLTFLoader();
				loader.setMeshoptDecoder(decoder);
				return loader;
			});
		}
		return _loaderPromise;
	}

	function loadBot(index = 0, retried = false) {
		if (index >= BOT_ASSETS.length) return; // every source exhausted — leave the canvas empty
		const url = BOT_ASSETS[index];
		getLoader().then((loader) => {
			loader.load(url, mountBot, undefined, () => {
				// Retry the same source once (transient fetch failures usually clear),
				// then advance to the next fallback asset.
				if (!retried) loadBot(index, true);
				else loadBot(index + 1, false);
			});
		}).catch(() => {
			// Decoder module import failed (offline / blocked CDN). Decorative — leave
			// the canvas empty rather than surface an uncaught rejection.
		});
	}

	loadBot();

	// 20deg/sec auto-rotate, matching model-viewer rotation-per-second="20deg"
	const rotSpeed = MathUtils.degToRad(20);

	// The footer sits at the bottom of long pages, so it is offscreen most of the
	// time. Only render while it is actually visible and the tab is focused —
	// otherwise it burns a GPU context and a RAF loop for nothing.
	let running = false;
	let onScreen = true;

	function animate() {
		if (!running) return;
		requestAnimationFrame(animate);
		clock.update();
		const dt = clock.getDelta();
		if (mixer) mixer.update(dt);
		if (robot) robot.rotation.y += rotSpeed * dt;
		renderer.render(scene, camera);
	}

	function syncRunning() {
		const next = onScreen && document.visibilityState !== 'hidden';
		if (next === running) return;
		running = next;
		if (running) {
			clock.update();
			animate();
		}
	}

	if (typeof IntersectionObserver !== 'undefined') {
		new IntersectionObserver(
			(entries) => {
				onScreen = entries[0].isIntersecting;
				syncRunning();
			},
			{ threshold: 0 },
		).observe(canvas);
	} else {
		onScreen = true;
	}
	document.addEventListener('visibilitychange', syncRunning);
	syncRunning();

	if (typeof ResizeObserver !== 'undefined' && parent) {
		new ResizeObserver(() => {
			const pw = parent.clientWidth || 300;
			const ph = parent.clientHeight || 400;
			camera.aspect = pw / ph;
			camera.updateProjectionMatrix();
			renderer.setSize(pw, ph);
		}).observe(parent);
	}
})();
