/**
 * Forge Reel: turn a forged model into shareable media without leaving the page.
 *
 * A text-to-3D site normally hands back a GLB and stops there. That is the
 * wrong last mile: almost nobody's next step is "open Blender", it is "show
 * someone". Cinema mode already gave /forge a clean fullscreen turntable, but
 * it still assumed the user owned a screen recorder, knew how to crop it, and
 * would accept whatever framerate their capture tool felt like.
 *
 * This module removes that detour. It renders its own cinematic pass over the
 * model and hands back three real files:
 *
 *   - a looping video (MP4 where the browser can encode it, WebM otherwise)
 *   - a hero still on the reel's backdrop
 *   - the same hero frame as a transparent PNG cutout, for decks and sites
 *
 * Everything runs client side: no upload, no queue, no worker, no server cost.
 *
 * Why its own renderer rather than recording the page's <model-viewer>: that
 * component runs one shared WebGL canvas across every viewer on the page and
 * moves it between shadow roots as visibility changes, so a canvas stream taken
 * from it can silently carry zero frames while still reporting a clean
 * recording. Owning the canvas also means the output resolution is exactly what
 * the user picked instead of whatever the layout and pixel ratio happened to
 * be, the shot is paced to a fixed timestep so a slow machine produces the same
 * video as a fast one, and the page underneath never gets hijacked mid-take.
 * The look is not a reimplementation either: lighting, tone mapping and the
 * ground shadow all come from src/shared/cinematic-render.js, the same module
 * behind /irl and the avatar viewers.
 *
 * The pure pieces (shot tracks, the sampler, framing maths, codec choice,
 * filenames) are exported and covered by tests/forge-reel.test.js. The mount is
 * DOM guarded so importing this file in Node is safe.
 */

/** Frames per second the reel is rendered and encoded at. */
export const REEL_FPS = 30;

/** Video bitrate. High enough that a dark model on a dark backdrop stays clean. */
const VIDEO_BITRATE = 12_000_000;

/**
 * Output sizes in real pixels.
 *
 * These are the encoded dimensions, full stop. The preview inside the dialog is
 * scaled with CSS, which changes what the user sees and not what gets written.
 */
export const REEL_ASPECTS = [
	{ id: 'wide', label: '16:9', hint: 'Landscape, for sites and decks', width: 1280, height: 720 },
	{ id: 'square', label: '1:1', hint: 'Square, for link previews', width: 1000, height: 1000 },
	{ id: 'tall', label: '9:16', hint: 'Vertical, for phone video', width: 720, height: 1280 },
];

/** Reel lengths offered. Short is the default: most people rewatch, few wait. */
export const REEL_DURATIONS = [4, 8, 12];

/**
 * Camera tracks.
 *
 * A keyframe is `{ t, theta, phi, radius, fov }`:
 *   t       0..1 position along the reel
 *   theta   yaw in degrees, allowed to exceed 360 so a spin reads as a spin
 *   phi     polar angle in degrees (90 is eye level, smaller looks down)
 *   radius  multiple of the model's own framed distance, so scale is irrelevant
 *   fov     multiple of the base field of view
 *
 * `ease` names the curve used to reach that keyframe from the previous one.
 * `heroT` marks the moment the stills are taken: the frame the shot was built
 * to arrive at.
 */
export const REEL_PRESETS = [
	{
		id: 'turntable',
		label: 'Turntable',
		blurb: 'One clean revolution. Loops seamlessly, reads as a product shot.',
		heroT: 0.12,
		track: [
			{ t: 0, theta: 0, phi: 78, radius: 1, fov: 1, ease: 'linear' },
			{ t: 1, theta: 360, phi: 78, radius: 1, fov: 1, ease: 'linear' },
		],
	},
	{
		id: 'hero',
		label: 'Hero push',
		blurb: 'Opens wide, pushes in, settles on a three-quarter hero angle.',
		heroT: 1,
		track: [
			{ t: 0, theta: -58, phi: 88, radius: 1.55, fov: 1.14, ease: 'linear' },
			{ t: 0.55, theta: -16, phi: 72, radius: 1.02, fov: 1, ease: 'out' },
			{ t: 1, theta: 16, phi: 68, radius: 0.95, fov: 0.95, ease: 'inout' },
		],
	},
	{
		id: 'reveal',
		label: 'Low reveal',
		blurb: 'Rises from below the horizon into the hero angle. Good for props.',
		heroT: 1,
		track: [
			{ t: 0, theta: 200, phi: 104, radius: 1.4, fov: 1.1, ease: 'linear' },
			{ t: 0.55, theta: 300, phi: 84, radius: 1.08, fov: 1, ease: 'out' },
			{ t: 1, theta: 382, phi: 70, radius: 1, fov: 0.96, ease: 'inout' },
		],
	},
];

const EASINGS = {
	linear: (x) => x,
	out: (x) => 1 - (1 - x) ** 3,
	in: (x) => x ** 3,
	inout: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
};

/**
 * Sample a camera track at normalised time `t`.
 *
 * Returns `{ theta, phi, radius, fov }` with radius and fov still expressed as
 * multiples. Out-of-range `t` clamps to the endpoints rather than extrapolating,
 * because an extrapolated camera flies through the model.
 */
export function sampleTrack(track, t) {
	if (!Array.isArray(track) || track.length === 0) {
		throw new Error('sampleTrack needs at least one keyframe');
	}
	const clamped = Math.min(1, Math.max(0, Number(t) || 0));
	if (clamped <= track[0].t) return frameOf(track[0]);
	const last = track[track.length - 1];
	if (clamped >= last.t) return frameOf(last);

	let i = 0;
	while (i < track.length - 1 && track[i + 1].t < clamped) i++;
	const a = track[i];
	const b = track[i + 1];
	const span = b.t - a.t;
	const local = span <= 0 ? 1 : (clamped - a.t) / span;
	const ease = EASINGS[b.ease] || EASINGS.inout;
	const k = ease(local);
	return {
		theta: lerp(a.theta, b.theta, k),
		phi: lerp(a.phi, b.phi, k),
		radius: lerp(a.radius, b.radius, k),
		fov: lerp(a.fov, b.fov, k),
	};
}

const lerp = (a, b, k) => a + (b - a) * k;
const frameOf = (kf) => ({ theta: kf.theta, phi: kf.phi, radius: kf.radius, fov: kf.fov });

/**
 * How many frames a reel contains.
 *
 * The reel is rendered frame by frame rather than "for N seconds", so a slow
 * machine produces the same file as a fast one instead of a shorter, jerkier
 * take. At least two frames, or there is no motion to encode.
 */
export function reelFrameCount(seconds, fps = REEL_FPS) {
	return Math.max(2, Math.round((Number(seconds) || 0) * fps));
}

/**
 * Distance at which a sphere of `radius` fills the frame with a little air.
 *
 * A portrait frame is limited by its horizontal field of view, not its
 * vertical, so the aspect has to enter the maths. Getting this wrong is how a
 * 9:16 reel ends up with the model's shoulders cropped off.
 *
 * @param {number} radius bounding-sphere radius of the model
 * @param {number} fovDeg vertical field of view in degrees
 * @param {number} aspect width / height
 * @param {number} margin multiplier for breathing room around the subject
 */
export function fitRadius(radius, fovDeg, aspect, margin = 1.18) {
	const vFov = (Math.max(1, fovDeg) * Math.PI) / 180;
	const safeAspect = Math.max(0.05, aspect || 1);
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * safeAspect);
	const limiting = Math.min(vFov, hFov);
	return (Math.max(1e-6, radius) / Math.sin(limiting / 2)) * margin;
}

/**
 * Candidate recording formats, best first.
 *
 * MP4 is preferred because it drops straight into a slide, a phone, or a post
 * without conversion. Chrome gained MP4 recording only recently and Safari
 * spells its codecs differently, so VP9 WebM stays as the universal floor.
 */
export const REEL_MIME_CANDIDATES = [
	{ mime: 'video/mp4;codecs=avc1.42E01E', ext: 'mp4' },
	{ mime: 'video/mp4', ext: 'mp4' },
	{ mime: 'video/webm;codecs=vp9', ext: 'webm' },
	{ mime: 'video/webm;codecs=vp8', ext: 'webm' },
	{ mime: 'video/webm', ext: 'webm' },
];

/**
 * Pick the first candidate the browser will actually encode.
 *
 * `isSupported` is injected so the choice is testable without a MediaRecorder.
 * Returns null when nothing is supported, which is a real state: the caller
 * falls back to stills instead of pretending a recording happened.
 */
export function pickVideoFormat(isSupported, candidates = REEL_MIME_CANDIDATES) {
	if (typeof isSupported !== 'function') return null;
	for (const candidate of candidates) {
		try {
			if (isSupported(candidate.mime)) return candidate;
		} catch {
			// A browser that throws on an unknown codec string is saying "no".
		}
	}
	return null;
}

/**
 * Build the download filename for one reel artefact.
 *
 * Keeps the model's own name so a folder of downloads stays sorted next to the
 * GLB it came from, and strips anything a filesystem would object to.
 */
export function reelFilename(base, presetId, kind, ext) {
	const safe =
		String(base || 'forge')
			.replace(/\.[a-z0-9]+$/i, '')
			.replace(/[^\w.-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 64) || 'forge';
	return `${safe}-${presetId}-${kind}.${ext}`;
}

/** Human file size for the result panel. Bytes are never the useful unit here. */
export function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

let threeModules = null;

async function loadThree() {
	if (threeModules) return threeModules;
	const [THREE, gltf, draco, meshopt, cinematic] = await Promise.all([
		import('three'),
		import('three/addons/loaders/GLTFLoader.js'),
		import('three/addons/loaders/DRACOLoader.js'),
		import('three/addons/libs/meshopt_decoder.module.js'),
		import('./shared/cinematic-render.js'),
	]);
	threeModules = {
		THREE,
		GLTFLoader: gltf.GLTFLoader,
		DRACOLoader: draco.DRACOLoader,
		MeshoptDecoder: meshopt.MeshoptDecoder,
		cinematic,
	};
	return threeModules;
}

/**
 * A self-contained cinematic stage for one model.
 *
 * Owns its canvas, renderer, scene and camera. Sizes are exact: the drawing
 * buffer is the requested pixel size with the pixel ratio pinned to 1, so the
 * encoded frame is never quietly doubled on a retina display.
 */
async function createStage(modelUrl, { width, height }) {
	const { THREE, GLTFLoader, DRACOLoader, MeshoptDecoder, cinematic } = await loadThree();

	const canvas = document.createElement('canvas');
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		// Manual frame capture reads the buffer after the draw call, so the
		// buffer has to survive it.
		preserveDrawingBuffer: true,
	});
	cinematic.applyCinematicDefaults(renderer, { exposure: 1.2 });
	renderer.setPixelRatio(1);
	renderer.setSize(width, height, false);

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(38, width / height, 0.01, 1000);

	await cinematic.loadEnvironment(renderer, scene, 'studio');

	// A key light exists only to cast the contact shadow; the IBL does the
	// actual lighting, so it is deliberately soft.
	const key = new THREE.DirectionalLight(0xffffff, 1.1);
	key.position.set(2.4, 4.2, 2.6);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	key.shadow.bias = -0.0012;
	scene.add(key);

	const loader = new GLTFLoader();
	const dracoLoader = new DRACOLoader();
	dracoLoader.setDecoderPath('/three/draco/gltf/');
	loader.setDRACOLoader(dracoLoader);
	loader.setMeshoptDecoder(MeshoptDecoder);
	const gltf = await loader.loadAsync(modelUrl);
	const model = gltf.scene;

	// Recentre on the origin and stand it on the ground plane, so every preset
	// orbits the subject rather than wherever the exporter left the pivot.
	const box = new THREE.Box3().setFromObject(model);
	const centre = box.getCenter(new THREE.Vector3());
	model.position.sub(centre);
	const recentred = new THREE.Box3().setFromObject(model);
	model.position.y -= recentred.min.y;

	model.traverse((node) => {
		if (node.isMesh) {
			node.castShadow = true;
			node.receiveShadow = true;
		}
	});
	scene.add(model);

	const framed = new THREE.Box3().setFromObject(model);
	const sphere = framed.getBoundingSphere(new THREE.Sphere());
	const target = new THREE.Vector3(0, sphere.center.y, 0);
	const shadow = cinematic.updateGroundContactShadow(scene, model, null, 0.4);
	if (shadow) scene.add(shadow);

	const backdrop = makeBackdrop(THREE);
	scene.background = backdrop;

	const baseFov = camera.fov;
	const baseRadius = fitRadius(sphere.radius, baseFov, width / height);
	key.shadow.camera.left = -sphere.radius * 2;
	key.shadow.camera.right = sphere.radius * 2;
	key.shadow.camera.top = sphere.radius * 2;
	key.shadow.camera.bottom = -sphere.radius * 2;
	key.shadow.camera.far = baseRadius * 4;
	key.shadow.camera.updateProjectionMatrix();
	key.target.position.copy(target);
	scene.add(key.target);

	function setCamera(sample) {
		camera.fov = baseFov * sample.fov;
		camera.updateProjectionMatrix();
		const theta = (sample.theta * Math.PI) / 180;
		const phi = (sample.phi * Math.PI) / 180;
		const r = baseRadius * sample.radius;
		camera.position.set(
			target.x + r * Math.sin(phi) * Math.sin(theta),
			target.y + r * Math.cos(phi),
			target.z + r * Math.sin(phi) * Math.cos(theta),
		);
		camera.lookAt(target);
	}

	function resize(w, h) {
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	return {
		canvas,
		setCamera,
		resize,
		render: () => renderer.render(scene, camera),
		setBackdrop: (on) => {
			scene.background = on ? backdrop : null;
			renderer.setClearAlpha(on ? 1 : 0);
		},
		dispose: () => {
			backdrop.dispose?.();
			dracoLoader.dispose?.();
			renderer.dispose();
		},
	};
}

/**
 * The reel's backdrop: a soft vertical gradient rather than flat black.
 *
 * Flat black loses every dark model against it and photographs badly in a
 * thumbnail. The gradient gives the subject something to sit against without
 * introducing a colour the model has to compete with.
 */
function makeBackdrop(THREE) {
	const canvas = document.createElement('canvas');
	canvas.width = 4;
	canvas.height = 512;
	const ctx = canvas.getContext('2d');
	const gradient = ctx.createLinearGradient(0, 0, 0, 512);
	gradient.addColorStop(0, '#1b1b28');
	gradient.addColorStop(0.55, '#111119');
	gradient.addColorStop(1, '#08080d');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 4, 512);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mountForgeReel() {
	const viewer = document.getElementById('viewer');
	const download = document.getElementById('download');
	const cinema = document.getElementById('cinema');
	const resultPanel = document.getElementById('state-result');
	if (!viewer || !resultPanel || !download) return;

	injectStyles();

	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'btn btn-ghost reel-trigger';
	trigger.id = 'reel-open';
	trigger.title = 'Reel: render a cinematic video and stills of this model (R)';
	trigger.setAttribute('aria-haspopup', 'dialog');
	trigger.innerHTML = `${ICON_REEL}Reel`;
	if (cinema && cinema.parentNode) cinema.parentNode.insertBefore(trigger, cinema);
	else download.parentNode.insertBefore(trigger, download);

	const dialog = document.createElement('div');
	dialog.className = 'reel-dialog';
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.setAttribute('aria-label', 'Render a reel of this model');
	dialog.hidden = true;
	dialog.innerHTML = dialogMarkup();
	document.body.appendChild(dialog);

	const el = {
		panel: dialog.querySelector('.reel-panel'),
		close: dialog.querySelector('.reel-close'),
		setup: dialog.querySelector('.reel-setup'),
		presets: dialog.querySelector('.reel-presets'),
		aspects: dialog.querySelector('.reel-aspects'),
		durations: dialog.querySelector('.reel-durations'),
		start: dialog.querySelector('.reel-start'),
		summary: dialog.querySelector('.reel-summary'),
		working: dialog.querySelector('.reel-working'),
		workingTitle: dialog.querySelector('.reel-working-title'),
		stage: dialog.querySelector('.reel-stage'),
		bar: dialog.querySelector('.reel-bar-fill'),
		barTrack: dialog.querySelector('.reel-bar'),
		clock: dialog.querySelector('.reel-clock'),
		cancel: dialog.querySelector('.reel-cancel'),
		done: dialog.querySelector('.reel-done'),
		video: dialog.querySelector('.reel-video'),
		files: dialog.querySelector('.reel-files'),
		again: [...dialog.querySelectorAll('.reel-again')],
		error: dialog.querySelector('.reel-error-panel'),
		errorText: dialog.querySelector('.reel-error-text'),
	};

	const choice = { preset: REEL_PRESETS[0], aspect: REEL_ASPECTS[0], duration: REEL_DURATIONS[0] };
	let busy = false;
	let cancelled = false;
	let lastFocus = null;
	let stage = null;
	let stageUrl = null;
	const artefacts = [];

	buildChoiceRow(el.presets, REEL_PRESETS, 'preset');
	buildChoiceRow(el.aspects, REEL_ASPECTS, 'aspect');
	buildDurationRow(el.durations);
	syncSummary();

	function buildChoiceRow(host, items, kind) {
		for (const item of items) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'reel-chip';
			b.dataset.id = item.id;
			b.setAttribute('aria-pressed', String(item.id === choice[kind].id));
			b.innerHTML = `<span class="reel-chip-label">${escapeHtml(item.label)}</span><span class="reel-chip-hint">${escapeHtml(item.blurb || item.hint || '')}</span>`;
			b.addEventListener('click', () => {
				choice[kind] = item;
				for (const sib of host.querySelectorAll('.reel-chip')) {
					sib.setAttribute('aria-pressed', String(sib.dataset.id === item.id));
				}
				syncSummary();
			});
			host.appendChild(b);
		}
	}

	function buildDurationRow(host) {
		for (const seconds of REEL_DURATIONS) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'reel-chip is-compact';
			b.dataset.id = String(seconds);
			b.setAttribute('aria-pressed', String(seconds === choice.duration));
			b.innerHTML = `<span class="reel-chip-label">${seconds}s</span>`;
			b.addEventListener('click', () => {
				choice.duration = seconds;
				for (const sib of host.querySelectorAll('.reel-chip')) {
					sib.setAttribute('aria-pressed', String(Number(sib.dataset.id) === seconds));
				}
				syncSummary();
			});
			host.appendChild(b);
		}
	}

	function supportsMime(mime) {
		return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
	}

	function syncSummary() {
		const format = pickVideoFormat(supportsMime);
		const { width, height } = choice.aspect;
		el.summary.textContent = format
			? `${width} by ${height} ${format.ext.toUpperCase()}, ${choice.duration}s at ${REEL_FPS}fps, plus two PNG stills.`
			: 'This browser cannot encode video, so Reel will render the stills only.';
	}

	// ---- open / close -----------------------------------------------------

	function open() {
		if (busy) return;
		lastFocus = document.activeElement;
		resetArtefacts();
		showStep('setup');
		dialog.hidden = false;
		requestAnimationFrame(() => dialog.classList.add('is-open'));
		syncSummary();
		el.start.focus();
		document.addEventListener('keydown', onDialogKey, true);
	}

	function close() {
		if (busy) {
			cancelled = true;
			return;
		}
		dialog.classList.remove('is-open');
		document.removeEventListener('keydown', onDialogKey, true);
		const hide = () => {
			dialog.hidden = true;
		};
		if (prefersReducedMotion()) hide();
		else setTimeout(hide, 180);
		if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	function onDialogKey(event) {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		if (event.key !== 'Tab' || dialog.hidden) return;
		const focusables = [...el.panel.querySelectorAll(FOCUSABLE)].filter(
			(node) => !node.disabled && node.offsetParent !== null,
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function showStep(step) {
		el.setup.hidden = step !== 'setup';
		el.working.hidden = step !== 'working';
		el.done.hidden = step !== 'done';
		el.error.hidden = step !== 'error';
	}

	function resetArtefacts() {
		for (const a of artefacts.splice(0)) URL.revokeObjectURL(a.url);
		el.files.textContent = '';
		el.video.removeAttribute('src');
		el.video.hidden = false;
	}

	trigger.addEventListener('click', open);
	el.close.addEventListener('click', close);
	for (const button of el.again) button.addEventListener('click', () => showStep('setup'));
	el.cancel.addEventListener('click', () => {
		cancelled = true;
	});
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) close();
	});
	el.start.addEventListener('click', () => {
		run().catch(fail);
	});

	// `R` mirrors cinema mode's `F`. Ignored while typing, and only while a
	// result is actually on screen.
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'r' && event.key !== 'R') return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isTypingTarget(event.target)) return;
		if (resultPanel.classList.contains('is-hidden')) return;
		if (!dialog.hidden) return;
		event.preventDefault();
		open();
	});

	// ---- the render --------------------------------------------------------

	async function run() {
		const modelUrl = viewer.getAttribute('src');
		if (!modelUrl) {
			fail(new Error('No model is loaded in the viewer yet'));
			return;
		}

		busy = true;
		cancelled = false;
		trigger.disabled = true;
		resetArtefacts();
		showStep('working');
		setPhase('Preparing the stage', true);

		try {
			await ensureStage(modelUrl);
			if (cancelled) return void abandon();

			const format = pickVideoFormat(supportsMime);
			if (format && typeof stage.canvas.captureStream === 'function') {
				setPhase('Rendering the reel', false);
				const video = await renderVideo(format);
				if (video) addArtefact('Video', video.blob, video.filename);
			}
			if (cancelled) return void abandon();

			setPhase('Capturing stills', true);
			for (const still of await renderStills()) {
				addArtefact(still.label, still.blob, still.filename);
			}

			if (cancelled && artefacts.length === 0) return void abandon();
			present(Boolean(format));
		} finally {
			busy = false;
			trigger.disabled = false;
		}
	}

	function abandon() {
		resetArtefacts();
		showStep('setup');
	}

	function fail(err) {
		busy = false;
		trigger.disabled = false;
		showStep('error');
		el.errorText.textContent = `${err?.message || err}. Your model and its GLB download are untouched; try a shorter reel or a smaller aspect.`;
	}

	/**
	 * Build the stage once per model, and resize it per aspect afterwards.
	 *
	 * Re-parsing a multi-megabyte GLB for every take would be the single
	 * slowest thing this feature does, so the parsed scene is kept for as long
	 * as the viewer is showing the same model.
	 */
	async function ensureStage(modelUrl) {
		if (stage && stageUrl === modelUrl) {
			stage.resize(choice.aspect.width, choice.aspect.height);
			return;
		}
		stage?.dispose();
		stage = await createStage(modelUrl, choice.aspect);
		stageUrl = modelUrl;
		el.stage.textContent = '';
		el.stage.appendChild(stage.canvas);
	}

	async function renderVideo(format) {
		const stream = stage.canvas.captureStream(0);
		const track = stream.getVideoTracks()[0];
		const recorder = new MediaRecorder(stream, {
			mimeType: format.mime,
			videoBitsPerSecond: VIDEO_BITRATE,
		});
		const chunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) chunks.push(event.data);
		};
		const finished = new Promise((resolve) => {
			recorder.onstop = () => resolve();
		});

		const frames = reelFrameCount(choice.duration);
		stage.setBackdrop(true);
		stage.setCamera(sampleTrack(choice.preset.track, 0));
		stage.render();
		await nextFrame();

		recorder.start(250);
		const startedAt = performance.now();
		for (let i = 0; i < frames; i++) {
			// Pace to wall-clock so the encoder timestamps land where the shot
			// says they should. A machine that renders faster than realtime
			// waits; one that renders slower produces the same duration with
			// fewer distinct frames.
			const due = startedAt + (i * 1000) / REEL_FPS;
			while (performance.now() < due && !cancelled) await nextFrame();
			if (cancelled) break;
			stage.setCamera(sampleTrack(choice.preset.track, i / frames));
			stage.render();
			track.requestFrame?.();
			setProgress((i + 1) / frames, `frame ${i + 1} of ${frames}`);
		}

		// Flush before tearing the stream down. Killing the tracks first drops
		// whatever the encoder had not handed over yet, which reads as a
		// successful recording that produced no file.
		recorder.stop();
		await finished;
		for (const t of stream.getTracks()) t.stop();

		if (cancelled || chunks.length === 0) return null;
		return {
			blob: new Blob(chunks, { type: format.mime.split(';')[0] }),
			filename: reelFilename(baseName(), choice.preset.id, 'reel', format.ext),
		};
	}

	/**
	 * Two stills from the shot's own hero frame.
	 *
	 * The cutout is rendered rather than cropped: the same camera with the
	 * backdrop removed and the clear alpha at zero, so the transparency follows
	 * the silhouette exactly instead of a rectangle around it.
	 */
	async function renderStills() {
		const out = [];
		const hero = sampleTrack(choice.preset.track, choice.preset.heroT);

		stage.setBackdrop(true);
		stage.setCamera(hero);
		stage.render();
		const onBackdrop = await canvasBlob(stage.canvas);
		if (onBackdrop) {
			out.push({
				label: `Hero still ${choice.aspect.label}`,
				blob: onBackdrop,
				filename: reelFilename(baseName(), choice.preset.id, 'hero', 'png'),
			});
		}

		stage.setBackdrop(false);
		stage.setCamera(hero);
		stage.render();
		const cutout = await canvasBlob(stage.canvas);
		stage.setBackdrop(true);
		if (cutout) {
			out.push({
				label: 'Transparent cutout',
				blob: cutout,
				filename: reelFilename(baseName(), choice.preset.id, 'cutout', 'png'),
			});
		}
		return out;
	}

	function setPhase(title, indeterminate) {
		el.workingTitle.textContent = title;
		el.barTrack.classList.toggle('is-indeterminate', Boolean(indeterminate));
		if (indeterminate) {
			el.bar.style.width = '100%';
			el.clock.textContent = 'Working';
			el.barTrack.removeAttribute('aria-valuenow');
		}
	}

	function setProgress(ratio, note) {
		const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
		el.bar.style.width = `${pct}%`;
		el.barTrack.setAttribute('aria-valuenow', String(pct));
		el.clock.textContent = note;
	}

	function addArtefact(label, blob, filename) {
		artefacts.push({ label, blob, filename, url: URL.createObjectURL(blob) });
	}

	function present(couldRecord) {
		showStep('done');
		el.files.textContent = '';
		const video = artefacts.find((a) => a.label === 'Video');
		if (video) {
			el.video.hidden = false;
			el.video.src = video.url;
			el.video.play().catch(() => {
				// Autoplay refusal is fine: the controls are right there.
			});
		} else {
			el.video.hidden = true;
			const note = document.createElement('p');
			note.className = 'reel-note';
			note.textContent = couldRecord
				? 'The encoder returned no frames on this machine, so Reel saved the shot as stills. Chrome, Edge and Firefox record video reliably.'
				: 'This browser has no canvas video encoder, so Reel saved the shot as stills instead.';
			el.files.appendChild(note);
		}

		for (const artefact of artefacts) {
			const row = document.createElement('a');
			row.className = 'reel-file';
			row.href = artefact.url;
			row.download = artefact.filename;
			row.innerHTML = `
				<span class="reel-file-kind">${escapeHtml(artefact.label)} <span class="reel-file-size">${formatBytes(artefact.blob.size)}</span></span>
				<span class="reel-file-name">${escapeHtml(artefact.filename)}</span>
				<span class="reel-file-cta">Download</span>`;
			el.files.appendChild(row);
		}
	}

	function baseName() {
		return (download.getAttribute('download') || 'forge.glb').replace(/\.glb$/i, '') || 'forge';
	}

	// A new model in the viewer invalidates the cached stage.
	new MutationObserver(() => {
		if (stageUrl && viewer.getAttribute('src') !== stageUrl) {
			stage?.dispose();
			stage = null;
			stageUrl = null;
		}
	}).observe(viewer, { attributes: true, attributeFilter: ['src'] });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const canvasBlob = (canvas) =>
	new Promise((resolve) => {
		try {
			canvas.toBlob((blob) => resolve(blob), 'image/png');
		} catch {
			resolve(null);
		}
	});

const prefersReducedMotion = () =>
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function isTypingTarget(node) {
	if (!node) return false;
	const tag = node.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

function escapeHtml(text) {
	return String(text).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

const ICON_REEL =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>';

function dialogMarkup() {
	return `
	<div class="reel-panel">
		<header class="reel-head">
			<div>
				<h2 class="reel-title">Render a reel</h2>
				<p class="reel-sub">A cinematic pass over this model, rendered and encoded in your browser. Nothing is uploaded.</p>
			</div>
			<button type="button" class="reel-close" aria-label="Close">&times;</button>
		</header>

		<section class="reel-setup">
			<h3 class="reel-legend">Shot</h3>
			<div class="reel-presets reel-row"></div>
			<h3 class="reel-legend">Aspect</h3>
			<div class="reel-aspects reel-row"></div>
			<h3 class="reel-legend">Length</h3>
			<div class="reel-durations reel-row is-tight"></div>
			<p class="reel-summary"></p>
			<button type="button" class="btn btn-primary reel-start">Render reel</button>
		</section>

		<section class="reel-working" hidden>
			<div class="reel-stage" aria-hidden="true"></div>
			<p class="reel-working-title">Preparing the stage</p>
			<div class="reel-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Render progress">
				<span class="reel-bar-fill"></span>
			</div>
			<p class="reel-clock" aria-live="polite">Working</p>
			<button type="button" class="btn btn-ghost reel-cancel">Cancel</button>
		</section>

		<section class="reel-done" hidden>
			<video class="reel-video" playsinline muted loop controls></video>
			<div class="reel-files"></div>
			<button type="button" class="btn btn-ghost reel-again">Render another</button>
		</section>

		<section class="reel-error-panel" hidden role="alert">
			<p class="reel-error-text"></p>
			<button type="button" class="btn btn-ghost reel-again">Back</button>
		</section>
	</div>`;
}

function injectStyles() {
	const style = document.createElement('style');
	style.id = 'forge-reel-styles';
	style.textContent = `
	.reel-trigger svg { margin-right: 0.35rem; }

	.reel-dialog {
		position: fixed;
		inset: 0;
		z-index: 10002;
		display: grid;
		place-items: center;
		padding: 1.25rem;
		background: rgba(6, 6, 10, 0.72);
		backdrop-filter: blur(6px);
		opacity: 0;
		transition: opacity 0.18s ease;
	}
	.reel-dialog.is-open { opacity: 1; }
	.reel-panel {
		width: min(560px, 100%);
		max-height: min(88vh, 780px);
		overflow-y: auto;
		padding: 1.25rem 1.35rem 1.45rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 18px;
		background: var(--surface-1, #14141b);
		box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
		transform: translateY(10px);
		transition: transform 0.18s ease;
	}
	.reel-dialog.is-open .reel-panel { transform: translateY(0); }

	.reel-head { display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 1.1rem; }
	.reel-title { margin: 0; font-size: 1.08rem; letter-spacing: -0.01em; }
	.reel-sub { margin: 0.3rem 0 0; font-size: 0.82rem; line-height: 1.5; opacity: 0.7; }
	.reel-close {
		margin-left: auto;
		width: 32px; height: 32px;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 9px;
		background: transparent; color: inherit;
		font-size: 1.15rem; line-height: 1; cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.reel-close:hover { background: var(--surface-3, rgba(255, 255, 255, 0.09)); }
	.reel-close:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }

	.reel-legend {
		margin: 0 0 0.5rem;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		opacity: 0.55;
	}
	.reel-row { display: grid; gap: 0.5rem; margin-bottom: 1.05rem; }
	.reel-row.is-tight { grid-auto-flow: column; grid-auto-columns: 1fr; }
	@media (min-width: 520px) {
		.reel-aspects { grid-template-columns: repeat(3, 1fr); }
	}

	.reel-chip {
		display: block;
		width: 100%;
		padding: 0.62rem 0.75rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 11px;
		background: var(--surface-2, rgba(255, 255, 255, 0.04));
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
	}
	.reel-chip:hover { background: var(--surface-3, rgba(255, 255, 255, 0.08)); transform: translateY(-1px); }
	.reel-chip:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }
	.reel-chip[aria-pressed='true'] {
		border-color: var(--accent, #7c6cff);
		background: color-mix(in srgb, var(--accent, #7c6cff) 16%, transparent);
	}
	.reel-chip.is-compact { text-align: center; }
	.reel-chip-label { display: block; font-size: 0.87rem; font-weight: 600; }
	.reel-chip-hint { display: block; margin-top: 0.16rem; font-size: 0.74rem; line-height: 1.4; opacity: 0.66; }
	.reel-chip.is-compact .reel-chip-hint { display: none; }

	.reel-summary { margin: 0 0 0.95rem; font-size: 0.78rem; opacity: 0.66; }
	.reel-start { width: 100%; }

	.reel-stage {
		display: grid;
		place-items: center;
		margin-bottom: 0.95rem;
		border-radius: 12px;
		overflow: hidden;
		background: #08080d;
	}
	.reel-stage canvas { display: block; width: 100%; height: auto; max-height: 46vh; object-fit: contain; }

	.reel-working-title { margin: 0 0 0.7rem; font-size: 0.92rem; font-weight: 600; }
	.reel-bar {
		height: 6px;
		border-radius: 999px;
		background: var(--surface-3, rgba(255, 255, 255, 0.1));
		overflow: hidden;
	}
	.reel-bar-fill {
		display: block;
		height: 100%;
		width: 0%;
		border-radius: inherit;
		background: var(--accent, #7c6cff);
		transition: width 0.1s linear;
	}
	.reel-bar.is-indeterminate .reel-bar-fill {
		background: linear-gradient(90deg, transparent, var(--accent, #7c6cff), transparent);
		animation: reel-sweep 1.1s ease-in-out infinite;
	}
	@keyframes reel-sweep {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(100%); }
	}
	.reel-clock { margin: 0.55rem 0 1rem; font-size: 0.78rem; opacity: 0.7; font-variant-numeric: tabular-nums; }

	.reel-video {
		width: 100%;
		border-radius: 12px;
		background: #06060a;
		margin-bottom: 0.9rem;
	}
	.reel-files { display: grid; gap: 0.5rem; margin-bottom: 0.95rem; }
	.reel-file {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.75rem;
		align-items: center;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 11px;
		background: var(--surface-2, rgba(255, 255, 255, 0.04));
		color: inherit;
		text-decoration: none;
		transition: background 0.14s ease, border-color 0.14s ease;
	}
	.reel-file:hover { background: var(--surface-3, rgba(255, 255, 255, 0.09)); border-color: var(--accent, #7c6cff); }
	.reel-file:focus-visible { outline: 2px solid var(--accent, #7c6cff); outline-offset: 2px; }
	.reel-file-kind { font-size: 0.85rem; font-weight: 600; }
	.reel-file-size { font-weight: 400; opacity: 0.55; }
	.reel-file-cta { grid-row: 1 / span 2; font-size: 0.78rem; opacity: 0.8; }
	.reel-file-name { grid-column: 1; font-size: 0.73rem; opacity: 0.6; word-break: break-all; }

	.reel-note, .reel-error-text { margin: 0 0 0.9rem; font-size: 0.8rem; line-height: 1.5; opacity: 0.78; }
	.reel-error-text { color: var(--danger, #ff6b6b); opacity: 0.95; }

	@media (prefers-reduced-motion: reduce) {
		.reel-dialog, .reel-panel, .reel-chip, .reel-bar-fill { transition: none; }
		.reel-chip:hover { transform: none; }
		.reel-bar.is-indeterminate .reel-bar-fill { animation: none; }
	}`;
	document.head.appendChild(style);
}

if (typeof document !== 'undefined') mountForgeReel();
