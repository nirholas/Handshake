// The viewer that runs inside the VS Code webview.
//
// Loads a GLB/glTF with three.js, lights it the way the three.ws viewer does
// (ACES tone mapping, an image-based studio environment, one shadow-casting key
// light), and exposes the controls a developer actually wants while looking at a
// model in their editor: animation playback, wireframe, skeleton, grid, and a
// PNG snapshot. Everything is local; the only network fetch is the model itself.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { retargetClipToObject } from '../../../src/animation-retarget.js';

const vscode = acquireVsCodeApi();
const stage = document.getElementById('stage');
const els = {
	loading: document.getElementById('loading'),
	loadingLabel: document.getElementById('loading-label'),
	error: document.getElementById('error'),
	errorText: document.getElementById('error-text'),
	toolbar: document.getElementById('toolbar'),
	clips: document.getElementById('clips'),
	play: document.getElementById('play'),
	scrub: document.getElementById('scrub'),
	playback: document.getElementById('playback'),
	report: document.getElementById('report'),
	reportBody: document.getElementById('report-body'),
	stats: document.getElementById('stats'),
	bake: document.getElementById('bake'),
	busy: document.getElementById('busy'),
	busyLabel: document.getElementById('busy-label'),
};

const config = window.__THREEWS_CONFIG__ || {};
const state = {
	mixer: null,
	action: null,
	clips: [],
	model: null,
	skeleton: null,
	wireframe: false,
	playing: true,
	radius: 1,
	// Library clips retargeted onto this rig live beside the file's own clips;
	// only these can be baked back into the model.
	libraryClips: new Map(),
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(readThemeColor('--vscode-editor-background', '#1e1e1e'));

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(0, 1.4, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 1.2;
controls.autoRotate = Boolean(config.autoRotate);

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0005;
scene.add(key, key.target, new THREE.HemisphereLight(0xffffff, 0x404040, 0.6));

const ground = new THREE.Mesh(
	new THREE.PlaneGeometry(1, 1),
	new THREE.ShadowMaterial({ opacity: 0.28 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

let grid = null;

if (config.environment !== 'none') {
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	if (config.environment === 'neutral') scene.environmentIntensity = 0.6;
	pmrem.dispose();
}

const loader = new GLTFLoader();
if (config.dracoPath) {
	const draco = new DRACOLoader();
	draco.setDecoderPath(config.dracoPath);
	loader.setDRACOLoader(draco);
}
if (config.basisPath) {
	const ktx2 = new KTX2Loader();
	ktx2.setTranscoderPath(config.basisPath);
	ktx2.detectSupport(renderer);
	loader.setKTX2Loader(ktx2);
}

// Every three.ws avatar ships meshopt-compressed, so the decoder is wired before
// the first load rather than lazily: GLTFLoader throws if it arrives late.
MeshoptDecoder.ready
	.then(() => {
		loader.setMeshoptDecoder(MeshoptDecoder);
		vscode.postMessage({ type: 'ready' });
	})
	.catch((err) => fail(`the meshopt decoder failed to start: ${err?.message || err}`));

function readThemeColor(varName, fallback) {
	const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
	return value || fallback;
}

function fail(message) {
	els.loading.hidden = true;
	els.errorText.textContent = message;
	els.error.hidden = false;
	vscode.postMessage({ type: 'error', message });
}

function clearModel() {
	if (!state.model) return;
	scene.remove(state.model);
	state.model.traverse((node) => {
		if (node.isMesh) {
			node.geometry?.dispose?.();
			for (const mat of materialsOf(node)) {
				for (const value of Object.values(mat)) value?.isTexture && value.dispose();
				mat.dispose();
			}
		}
	});
	state.model = null;
	if (state.skeleton) {
		scene.remove(state.skeleton);
		state.skeleton = null;
	}
	state.mixer = null;
	state.action = null;
	state.clips = [];
	state.libraryClips = new Map();
	els.bake.hidden = true;
}

function materialsOf(mesh) {
	return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function load(src) {
	clearModel();
	els.error.hidden = true;
	els.loading.hidden = false;
	els.loadingLabel.textContent = 'Loading model…';
	loader.load(
		src,
		(gltf) => {
			els.loading.hidden = true;
			state.model = gltf.scene || gltf.scenes[0];
			state.model.traverse((node) => {
				if (node.isMesh) {
					node.castShadow = true;
					node.receiveShadow = true;
					node.frustumCulled = false;
				}
			});
			scene.add(state.model);
			frame(state.model);
			setupAnimations(gltf.animations || []);
			applyGrid(config.showGrid !== false);
			vscode.postMessage({ type: 'loaded', stats: sceneStats(gltf) });
		},
		(event) => {
			if (event?.total) {
				const pct = Math.round((event.loaded / event.total) * 100);
				els.loadingLabel.textContent = `Loading model… ${pct}%`;
			} else if (event?.loaded) {
				els.loadingLabel.textContent = `Loading model… ${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
			}
		},
		(err) => fail(err?.message || 'the model could not be loaded'),
	);
}

/** Frame the model: centre it on the origin, sit it on the ground, fit the camera. */
function frame(model) {
	const box = new THREE.Box3().setFromObject(model);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
	state.radius = radius;

	model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));

	ground.scale.setScalar(radius * 20);
	camera.near = radius / 100;
	camera.far = radius * 100;
	camera.updateProjectionMatrix();
	resetView();
}

function resetView() {
	const r = state.radius;
	const height = state.model
		? new THREE.Box3().setFromObject(state.model).getSize(new THREE.Vector3()).y
		: r * 2;
	controls.target.set(0, height / 2, 0);
	camera.position.set(r * 1.9, height * 0.62 + r * 0.6, r * 2.6);
	controls.update();
	key.target.position.set(0, height / 2, 0);
	key.target.updateMatrixWorld();
	const span = Math.max(r * 3, height * 1.5);
	key.shadow.camera.left = -span;
	key.shadow.camera.right = span;
	key.shadow.camera.top = span;
	key.shadow.camera.bottom = -span;
	key.shadow.camera.far = span * 6;
	key.shadow.camera.updateProjectionMatrix();
}

function applyGrid(show) {
	if (grid) {
		scene.remove(grid);
		grid.geometry.dispose();
		grid.material.dispose();
		grid = null;
	}
	if (!show) return;
	const span = Math.max(2, Math.ceil(state.radius * 6));
	grid = new THREE.GridHelper(span * 2, span * 2, 0x9aa0a6, 0x6f767d);
	grid.material.transparent = true;
	grid.material.opacity = 0.5;
	scene.add(grid);
}

function setupAnimations(clips) {
	state.clips = clips;
	if (!clips.length) {
		els.playback.hidden = true;
		els.clips.innerHTML = '';
		return;
	}
	state.mixer = new THREE.AnimationMixer(state.model);
	rebuildClipPicker();
	playClip(0);
}

function rebuildClipPicker() {
	els.clips.innerHTML = '';
	state.clips.forEach((clip, i) => {
		const option = document.createElement('option');
		option.value = String(i);
		const tag = state.libraryClips.has(clip) ? ' · library' : '';
		option.textContent = `${clip.name || `clip ${i + 1}`} (${clip.duration.toFixed(2)}s)${tag}`;
		els.clips.appendChild(option);
	});
	els.playback.hidden = state.clips.length === 0;
	els.clips.hidden = state.clips.length < 2;
}

function playClip(index) {
	const clip = state.clips[index];
	if (!clip || !state.mixer) return;
	state.action?.fadeOut(0.2);
	state.action = state.mixer.clipAction(clip);
	const library = state.libraryClips.get(clip);
	if (library && !library.loop) {
		state.action.setLoop(THREE.LoopOnce, 1);
		state.action.clampWhenFinished = true;
	} else {
		state.action.setLoop(THREE.LoopRepeat, Infinity);
	}
	state.action.reset().fadeIn(0.2).play();
	state.action.paused = !state.playing;
	els.scrub.max = String(clip.duration);
	els.clips.value = String(index);
	els.bake.hidden = !library;
}

/**
 * Retarget a library clip (authored on the canonical humanoid skeleton) onto
 * the loaded model with the platform's retargeter, add it to the picker, and
 * play it. Answers the host with the coverage so it can explain a refusal.
 */
function playLibraryClip({ requestId, clip, label, loop }) {
	const reply = (result) => vscode.postMessage({ type: 'clip-result', requestId, ...result });
	if (!state.model) return reply({ ok: false, coverage: 0, matched: 0, total: 0, message: 'no model is loaded' });
	let parsed;
	try {
		parsed = THREE.AnimationClip.parse(clip);
	} catch (err) {
		return reply({ ok: false, coverage: 0, matched: 0, total: 0, message: `the clip could not be parsed: ${err?.message || err}` });
	}
	let result;
	try {
		result = retargetClipToObject(parsed, state.model);
	} catch (err) {
		return reply({ ok: false, coverage: 0, matched: 0, total: 0, message: err?.message || String(err) });
	}
	if (!result.clip) {
		return reply({ ok: false, coverage: result.coverage, matched: result.matched, total: result.total });
	}
	result.clip.name = label || parsed.name;
	if (!state.mixer) state.mixer = new THREE.AnimationMixer(state.model);
	// Replace an earlier take of the same clip instead of piling up copies.
	const previous = state.clips.findIndex((c) => state.libraryClips.has(c) && c.name === result.clip.name);
	if (previous !== -1) {
		state.libraryClips.delete(state.clips[previous]);
		state.clips.splice(previous, 1);
	}
	state.clips.push(result.clip);
	state.libraryClips.set(result.clip, { loop: Boolean(loop), label: result.clip.name });
	rebuildClipPicker();
	if (!state.playing) togglePlay();
	playClip(state.clips.length - 1);
	reply({ ok: true, coverage: result.coverage, matched: result.matched, total: result.total });
}

function bakeCurrentClip() {
	const clip = state.action?.getClip();
	const library = clip && state.libraryClips.get(clip);
	if (!library) return;
	vscode.postMessage({ type: 'bake-clip', clip: THREE.AnimationClip.toJSON(clip), label: library.label });
}

function sceneStats(gltf) {
	let triangles = 0;
	let meshes = 0;
	const materials = new Set();
	const textures = new Set();
	let bones = 0;
	(gltf.scene || gltf.scenes[0]).traverse((node) => {
		if (node.isBone) bones++;
		if (!node.isMesh) return;
		meshes++;
		const geo = node.geometry;
		const count = geo.index ? geo.index.count : geo.attributes.position?.count || 0;
		triangles += Math.floor(count / 3);
		for (const mat of materialsOf(node)) {
			if (!mat) continue;
			materials.add(mat.uuid);
			for (const value of Object.values(mat)) {
				if (value?.isTexture) textures.add(value.uuid);
			}
		}
	});
	return {
		triangles,
		meshes,
		materials: materials.size,
		textures: textures.size,
		bones,
		animations: (gltf.animations || []).length,
	};
}

function setWireframe(on) {
	state.wireframe = on;
	state.model?.traverse((node) => {
		if (!node.isMesh) return;
		for (const mat of materialsOf(node)) {
			if (mat) mat.wireframe = on;
		}
	});
}

function setSkeleton(on) {
	if (on && !state.skeleton && state.model) {
		state.skeleton = new THREE.SkeletonHelper(state.model);
		state.skeleton.material.linewidth = 2;
		scene.add(state.skeleton);
	} else if (!on && state.skeleton) {
		scene.remove(state.skeleton);
		state.skeleton = null;
	}
}

function renderReport(rows, suggestions) {
	els.reportBody.innerHTML = '';
	for (const [label, value] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = label;
		const dd = document.createElement('dd');
		dd.textContent = value;
		els.reportBody.append(dt, dd);
	}
	els.stats.innerHTML = '';
	for (const s of suggestions) {
		const li = document.createElement('li');
		li.className = `sev-${s.severity}`;
		li.textContent = s.message;
		els.stats.appendChild(li);
	}
}

// Toolbar wiring. Each toggle button carries data-toggle so the handler stays
// one place instead of one listener per control.
els.toolbar.addEventListener('click', (event) => {
	const button = event.target.closest('button');
	if (!button) return;
	const action = button.dataset.action;
	const toggle = button.dataset.toggle;
	if (toggle) {
		const on = button.getAttribute('aria-pressed') !== 'true';
		button.setAttribute('aria-pressed', String(on));
		if (toggle === 'grid') applyGrid(on);
		if (toggle === 'wireframe') setWireframe(on);
		if (toggle === 'skeleton') setSkeleton(on);
		if (toggle === 'rotate') controls.autoRotate = on;
		if (toggle === 'report') els.report.hidden = !on;
		return;
	}
	if (action === 'reset') return resetView();
	if (action === 'snapshot') return sendSnapshot();
	if (action === 'turntable') return sendTurntable();
	if (action === 'play') return togglePlay();
	if (action === 'bake') return bakeCurrentClip();
	if (action) vscode.postMessage({ type: 'action', action });
});

els.clips.addEventListener('change', () => playClip(Number(els.clips.value)));

els.scrub.addEventListener('input', () => {
	if (!state.action) return;
	state.action.time = Number(els.scrub.value);
	state.mixer.update(0);
});

function togglePlay() {
	state.playing = !state.playing;
	if (state.action) state.action.paused = !state.playing;
	els.play.setAttribute('aria-pressed', String(state.playing));
	els.play.textContent = state.playing ? 'Pause' : 'Play';
}

function sendSnapshot() {
	renderer.render(scene, camera);
	vscode.postMessage({ type: 'snapshot', dataUrl: renderer.domElement.toDataURL('image/png') });
}

/** A render sized for a vision model: the current view, at most 768px wide. */
function sendQualityRender(requestId) {
	renderer.render(scene, camera);
	const source = renderer.domElement;
	const scale = Math.min(1, 768 / Math.max(source.width, source.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(source.width * scale));
	canvas.height = Math.max(1, Math.round(source.height * scale));
	canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
	vscode.postMessage({ type: 'clip-result', requestId, ok: true, dataUrl: canvas.toDataURL('image/png') });
}

function setBusy(label) {
	els.busy.hidden = !label;
	els.busyLabel.textContent = label || '';
}

/**
 * Render a full orbit around the model into a looping GIF.
 *
 * Frames render off-screen into a square target at the configured size so the
 * result is independent of the panel's aspect ratio, and the animation (if one
 * is playing) is stepped in lockstep so a walk cycle turns with the model.
 */
async function sendTurntable() {
	if (!state.model) return;
	const frames = Math.max(8, Math.min(120, Number(config.turntableFrames) || 36));
	const size = Math.max(128, Math.min(1024, Number(config.turntableSize) || 480));
	const delay = 60;
	setBusy(`Rendering turntable… 0/${frames}`);

	const target = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
	const pixels = new Uint8Array(size * size * 4);
	const flipped = new Uint8ClampedArray(size * size * 4);
	const gif = GIFEncoder();
	const orbit = new THREE.PerspectiveCamera(camera.fov, 1, camera.near, camera.far);
	const focus = controls.target.clone();
	const offset = camera.position.clone().sub(focus);
	const radius = Math.hypot(offset.x, offset.z);
	const startAngle = Math.atan2(offset.x, offset.z);
	const wasPaused = state.action?.paused;
	const clipDuration = state.action?.getClip().duration || 0;
	const savedTime = state.action?.time || 0;

	try {
		for (let i = 0; i < frames; i++) {
			const angle = startAngle + (i / frames) * Math.PI * 2;
			orbit.position.set(focus.x + Math.sin(angle) * radius, camera.position.y, focus.z + Math.cos(angle) * radius);
			orbit.lookAt(focus);
			if (state.action && state.mixer) {
				state.action.paused = false;
				state.action.time = (savedTime + (i / frames) * clipDuration) % (clipDuration || 1);
				state.mixer.update(0);
			}
			renderer.setRenderTarget(target);
			renderer.render(scene, orbit);
			renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
			renderer.setRenderTarget(null);
			// GL reads bottom-up; GIF rows go top-down.
			for (let y = 0; y < size; y++) {
				flipped.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
			}
			const palette = quantize(flipped, 256, { format: 'rgb565' });
			const index = applyPalette(flipped, palette, 'rgb565');
			gif.writeFrame(index, size, size, { palette, delay, repeat: 0 });
			setBusy(`Rendering turntable… ${i + 1}/${frames}`);
			// Yield so the busy label paints and the panel stays responsive.
			await new Promise((r) => requestAnimationFrame(r));
		}
		gif.finish();
		const bytes = gif.bytes();
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		vscode.postMessage({ type: 'turntable', dataUrl: `data:image/gif;base64,${btoa(binary)}` });
	} catch (err) {
		vscode.postMessage({ type: 'error', message: `turntable failed: ${err?.message || err}` });
	} finally {
		target.dispose();
		if (state.action) {
			state.action.time = savedTime;
			state.action.paused = Boolean(wasPaused);
			state.mixer.update(0);
		}
		setBusy('');
	}
}

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg?.type === 'load') load(msg.src);
	if (msg?.type === 'report') renderReport(msg.rows || [], msg.suggestions || []);
	if (msg?.type === 'snapshot') sendSnapshot();
	if (msg?.type === 'turntable') sendTurntable();
	if (msg?.type === 'play-clip') playLibraryClip(msg);
	if (msg?.type === 'render') sendQualityRender(msg.requestId);
	if (msg?.type === 'toggle-report') {
		const button = els.toolbar.querySelector('[data-toggle="report"]');
		button?.click();
	}
});

const observer = new ResizeObserver(() => resize());
observer.observe(stage);

function resize() {
	const { clientWidth: w, clientHeight: h } = stage;
	if (!w || !h) return;
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h, false);
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
	const dt = clock.getDelta();
	if (state.mixer && state.playing) state.mixer.update(dt);
	if (state.action && !els.scrub.matches(':active')) {
		els.scrub.value = String(state.action.time % (state.action.getClip().duration || 1));
	}
	controls.update();
	renderer.render(scene, camera);
});

resize();
