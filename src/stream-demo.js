/**
 * /stream - a side-by-side demonstration of progressive avatar delivery.
 *
 * The comparison is real. Both panels fetch real bytes over the real network and
 * render them with the same renderer. The only thing simulated is the downlink
 * cap, and it is applied identically to both sides by metering the byte stream
 * as it arrives: on a datacentre connection every avatar loads instantly and the
 * demonstration would show nothing at all. The byte counts, triangle counts and
 * timings on screen are measured, never scripted.
 */

import {
	AmbientLight,
	Box3,
	Color,
	DirectionalLight,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
	AnimationMixer,
	Clock,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';

import { A3SPlayer } from '../packages/avatar-stream/src/three.js';
import { A3SStream } from '../packages/avatar-stream/src/reader.js';

/** Downlink profiles, in bytes per second, matching the browser devtools presets. */
const CONNECTIONS = {
	'slow-3g': { label: 'Slow 3G', bytesPerSecond: 50 * 1024 },
	'fast-3g': { label: 'Fast 3G', bytesPerSecond: 180 * 1024 },
	'4g': { label: '4G', bytesPerSecond: 1200 * 1024 },
	none: { label: 'No limit', bytesPerSecond: Infinity },
};

const AVATARS = [
	{ id: 'michelle', label: 'Michelle', src: '/avatars/michelle.glb' },
	{ id: 'xbot', label: 'X Bot', src: '/avatars/xbot.glb' },
	{ id: 'realistic-male', label: 'Realistic male', src: '/avatars/realistic-male.glb' },
	{ id: 'cupsey', label: 'Pill', src: '/avatars/pumpfun-pill-cupsey.glb' },
	{ id: 'brainstem', label: 'Brain stem', src: '/avatars/brainstem.glb' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Meter a byte payload against a downlink budget.
 * Resolves only once the last byte would have arrived at the given rate.
 */
async function meter(byteLength, bytesPerSecond, onProgress) {
	if (!Number.isFinite(bytesPerSecond)) {
		onProgress?.(byteLength);
		return;
	}
	const totalMs = (byteLength / bytesPerSecond) * 1000;
	const started = performance.now();
	let delivered = 0;
	// Tick often enough to animate, rarely enough to stay cheap.
	while (delivered < byteLength) {
		await sleep(Math.min(50, Math.max(8, totalMs / 40)));
		const elapsed = performance.now() - started;
		delivered = Math.min(byteLength, (elapsed / 1000) * bytesPerSecond);
		onProgress?.(delivered);
	}
	const remaining = totalMs - (performance.now() - started);
	if (remaining > 0) await sleep(remaining);
	onProgress?.(byteLength);
}

/** A three.js viewport that can be reset between runs. */
class Stage {
	constructor(canvas) {
		this.canvas = canvas;
		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
		this.scene = new Scene();
		this.scene.background = null;
		this.camera = new PerspectiveCamera(35, 1, 0.05, 100);
		this.camera.position.set(0, 1.35, 3.1);
		this.scene.add(new AmbientLight(0xffffff, 1.5));
		const key = new DirectionalLight(0xffffff, 2.2);
		key.position.set(2, 4, 3);
		this.scene.add(key);
		const rim = new DirectionalLight(0x6ea8ff, 1.1);
		rim.position.set(-3, 2, -2);
		this.scene.add(rim);
		this.mixer = null;
		this.clock = new Clock();
		this.root = null;
		this.resize();
		this.loop = this.loop.bind(this);
		this.running = true;
		requestAnimationFrame(this.loop);
	}

	resize() {
		const rect = this.canvas.getBoundingClientRect();
		const width = Math.max(1, rect.width);
		const height = Math.max(1, rect.height);
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
	}

	clear() {
		if (this.root) {
			this.scene.remove(this.root);
			this.root.traverse((object) => {
				object.geometry?.dispose?.();
				const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
				for (const material of materials) material.dispose?.();
			});
		}
		this.root = null;
		this.mixer = null;
	}

	/** Frame the model so avatars of different scales fill the viewport equally. */
	add(object) {
		this.root = object;
		this.scene.add(object);
		const box = new Box3().setFromObject(object);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		const height = Math.max(size.y, 0.001);
		object.position.sub(center);
		object.position.y += height / 2;
		const distance = height * 2.1;
		this.camera.position.set(0, height * 0.62, distance);
		this.camera.lookAt(0, height * 0.5, 0);
	}

	playClips(clips) {
		if (!clips?.length || !this.root) return;
		this.mixer = new AnimationMixer(this.root);
		// Prefer an idle-looking clip over whatever happens to be first.
		const clip = clips.find((c) => /idle|stand/i.test(c.name)) || clips[0];
		this.mixer.clipAction(clip).play();
	}

	loop() {
		if (!this.running) return;
		const delta = this.clock.getDelta();
		this.mixer?.update(delta);
		if (this.root) this.root.rotation.y += delta * 0.35;
		this.renderer.render(this.scene, this.camera);
		requestAnimationFrame(this.loop);
	}
}

/** Count triangles actually resident in a scene graph. */
function countTriangles(root) {
	let total = 0;
	root?.traverse((object) => {
		const geometry = object.geometry;
		if (!geometry) return;
		total += geometry.index ? geometry.index.count / 3 : (geometry.getAttribute('position')?.count || 0) / 3;
	});
	return Math.round(total);
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

class Panel {
	constructor(rootElement) {
		this.el = rootElement;
		this.canvas = rootElement.querySelector('canvas');
		this.stage = new Stage(this.canvas);
		this.statusEl = rootElement.querySelector('[data-role="status"]');
		this.firstEl = rootElement.querySelector('[data-role="first"]');
		this.bytesEl = rootElement.querySelector('[data-role="bytes"]');
		this.trisEl = rootElement.querySelector('[data-role="tris"]');
		this.barEl = rootElement.querySelector('[data-role="bar"]');
		this.logEl = rootElement.querySelector('[data-role="log"]');
	}

	reset() {
		this.stage.clear();
		this.statusEl.textContent = 'waiting';
		this.el.dataset.state = 'idle';
		this.firstEl.textContent = '--';
		this.bytesEl.textContent = '--';
		this.trisEl.textContent = '--';
		this.barEl.style.width = '0%';
		this.logEl.innerHTML = '';
	}

	progress(delivered, total) {
		this.barEl.style.width = `${Math.min(100, (delivered / total) * 100).toFixed(1)}%`;
		this.bytesEl.textContent = fmtBytes(delivered);
	}

	log(text, tone = '') {
		const row = document.createElement('li');
		row.textContent = text;
		if (tone) row.dataset.tone = tone;
		this.logEl.appendChild(row);
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	markFirstFrame(ms) {
		this.firstEl.textContent = fmtMs(ms);
		this.el.dataset.state = 'live';
		this.statusEl.textContent = 'rendering';
	}

	finish() {
		this.statusEl.textContent = 'complete';
		this.el.dataset.state = 'done';
		this.trisEl.textContent = countTriangles(this.stage.root).toLocaleString();
	}
}

/** Classic path: one request, nothing on screen until the last byte lands. */
async function runClassic(panel, avatar, bytesPerSecond, signal) {
	panel.reset();
	panel.statusEl.textContent = 'fetching';
	const started = performance.now();
	const response = await fetch(avatar.src, { signal });
	const buffer = new Uint8Array(await response.arrayBuffer());
	panel.log(`GET ${avatar.src}`);
	panel.log(`${fmtBytes(buffer.byteLength)} to download before the first pixel`);

	await meter(buffer.byteLength, bytesPerSecond, (delivered) => panel.progress(delivered, buffer.byteLength));
	if (signal.aborted) return null;

	const gltf = await new GLTFLoader().parseAsync(buffer.slice().buffer, '');
	const elapsed = performance.now() - started;
	panel.stage.add(gltf.scene);
	panel.stage.playClips(gltf.animations);
	panel.markFirstFrame(elapsed);
	panel.log(`first frame at ${fmtMs(elapsed)}`, 'good');
	panel.finish();
	return { firstFrameMs: elapsed, bytes: buffer.byteLength };
}

/** Progressive path: one ranged request to first frame, then refinement. */
async function runStream(panel, avatar, bytesPerSecond, signal) {
	panel.reset();
	panel.statusEl.textContent = 'fetching';
	const started = performance.now();
	const url = `/api/avatar-stream?src=${encodeURIComponent(avatar.src)}`;

	let transferred = 0;
	let totalBytes = 1;
	// Every range read is metered at the same downlink as the classic panel.
	const meteredFetch = async (input, init) => {
		const response = await fetch(input, { ...init, signal });
		const buffer = new Uint8Array(await response.arrayBuffer());
		await meter(buffer.byteLength, bytesPerSecond, (delivered) => {
			panel.progress(transferred + delivered, totalBytes);
		});
		transferred += buffer.byteLength;
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
		};
	};

	const stream = await A3SStream.open(url, { fetch: meteredFetch });
	totalBytes = stream.preamble.totalLength;
	panel.log(`GET ${url}`);
	panel.log(`Range: bytes=0-${stream.preamble.baseOffset + stream.preamble.baseLength - 1}`);

	const player = await A3SPlayer.load(stream, { THREE, GLTFLoader });

	const elapsed = performance.now() - started;
	panel.stage.add(player.scene);
	panel.markFirstFrame(elapsed);
	panel.trisEl.textContent = countTriangles(player.scene).toLocaleString();
	panel.log(`first frame at ${fmtMs(elapsed)} from ${fmtBytes(stream.preamble.baseOffset + stream.preamble.baseLength)}`, 'good');

	player.onLayer = (info) => {
		if (info.level === 0) return;
		panel.log(`level ${info.level}: +${fmtBytes(info.bytes)} to ${info.triangleCount.toLocaleString()} triangles`);
		panel.trisEl.textContent = countTriangles(player.scene).toLocaleString();
		if (info.clips && !panel.stage.mixer) panel.stage.playClips(player.animations);
	};
	panel.statusEl.textContent = 'refining';
	await player.refine();
	if (signal.aborted) return null;
	panel.stage.playClips(player.animations);
	panel.finish();
	panel.bytesEl.textContent = fmtBytes(transferred);
	return { firstFrameMs: elapsed, bytes: transferred, baseBytes: stream.preamble.baseOffset + stream.preamble.baseLength };
}

function mount(root) {
	root.innerHTML = `
		<div class="st-controls">
			<label class="st-field">
				<span>Avatar</span>
				<select id="st-avatar">${AVATARS.map((a) => `<option value="${a.id}">${a.label}</option>`).join('')}</select>
			</label>
			<label class="st-field">
				<span>Simulated downlink</span>
				<select id="st-connection">${Object.entries(CONNECTIONS).map(([k, v]) => `<option value="${k}"${k === 'fast-3g' ? ' selected' : ''}>${v.label}</option>`).join('')}</select>
			</label>
			<button id="st-run" class="st-run" type="button">Run comparison</button>
		</div>
		<p class="st-note">Both panels fetch real bytes and render with the same renderer. The downlink cap is simulated and applied identically to both, because on a fast connection neither path is observable.</p>
		<div class="st-grid">
			${['classic', 'stream'].map((kind) => `
				<section class="st-panel" data-kind="${kind}" data-state="idle">
					<header class="st-panel-head">
						<h2>${kind === 'classic' ? 'Classic GLB' : 'A3S stream'}</h2>
						<span class="st-status" data-role="status">waiting</span>
					</header>
					<div class="st-stage"><canvas></canvas></div>
					<div class="st-bar"><i data-role="bar"></i></div>
					<dl class="st-metrics">
						<div><dt>First frame</dt><dd data-role="first">--</dd></div>
						<div><dt>Transferred</dt><dd data-role="bytes">--</dd></div>
						<div><dt>Triangles</dt><dd data-role="tris">--</dd></div>
					</dl>
					<ul class="st-log" data-role="log"></ul>
				</section>`).join('')}
		</div>
		<p class="st-verdict" id="st-verdict" aria-live="polite"></p>`;

	const panels = {
		classic: new Panel(root.querySelector('[data-kind="classic"]')),
		stream: new Panel(root.querySelector('[data-kind="stream"]')),
	};
	const avatarSelect = root.querySelector('#st-avatar');
	const connectionSelect = root.querySelector('#st-connection');
	const runButton = root.querySelector('#st-run');
	const verdict = root.querySelector('#st-verdict');

	addEventListener('resize', () => {
		panels.classic.stage.resize();
		panels.stream.stage.resize();
	});

	let controller = null;
	async function run() {
		controller?.abort();
		controller = new AbortController();
		const { signal } = controller;
		const avatar = AVATARS.find((a) => a.id === avatarSelect.value);
		const bytesPerSecond = CONNECTIONS[connectionSelect.value].bytesPerSecond;
		runButton.disabled = true;
		runButton.textContent = 'Running';
		verdict.textContent = '';
		try {
			// Run both paths concurrently so neither is advantaged by a warm cache.
			const [classic, streamed] = await Promise.all([
				runClassic(panels.classic, avatar, bytesPerSecond, signal),
				runStream(panels.stream, avatar, bytesPerSecond, signal),
			]);
			if (classic && streamed) {
				const speedup = classic.firstFrameMs / streamed.firstFrameMs;
				verdict.textContent = `${speedup.toFixed(1)}x faster to first frame: ${fmtBytes(streamed.baseBytes)} versus ${fmtBytes(classic.bytes)} before anything is on screen.`;
			}
		} catch (error) {
			if (error.name !== 'AbortError') {
				verdict.textContent = `Run failed: ${error.message}`;
				panels.stream.log(error.message, 'bad');
			}
		} finally {
			runButton.disabled = false;
			runButton.textContent = 'Run comparison';
		}
	}

	runButton.addEventListener('click', run);
	avatarSelect.addEventListener('change', run);
	connectionSelect.addEventListener('change', run);
	run();
}

const root = document.querySelector('#stream-root');
if (root) mount(root);
