// The public catalog-bar inspector (/inspect).
//
// One promise holds this page together: the verdict shown here is produced by
// the SAME module that decides whether a platform-generated asset reaches the
// public catalog (api/_lib/seed-mesh-gate.js, stage 1 of the seed quality gate).
// Not a re-implementation of the rules, and not an API that might drift from
// them — the gate itself, imported and run on the visitor's own bytes.
//
// Two consequences, both deliberate:
//
//   • Nothing is uploaded. The gate reads only the glTF JSON chunk, so it runs
//     entirely in the browser. A creator can check an unreleased model without
//     handing it to us, and the verdict is instant because there is no network
//     round-trip in it at all.
//   • A threshold change lands here and in the cron at the same time, because
//     there is only one place to change it.
//
// three.js is imported lazily: the verdict is the product, and it must not wait
// on a renderer bundle. The gate runs and paints before the viewer boots.

import { gateMesh, explainMeshGate, SEED_GATE_VERSION } from '../api/_lib/seed-mesh-gate.js';

// Real models this site already serves, chosen because they demonstrate
// genuinely different verdicts rather than showcasing only passes. `mannequin`
// failing two rules and `default` (the platform's own fallback avatar) failing
// the mesh-count rule are honest results, and they teach the bar far faster
// than four passing models would.
const PRESETS = [
	{ id: 'michelle', label: 'Michelle', url: '/avatars/michelle.glb', note: 'A clean pass' },
	{ id: 'fox', label: 'Fox', url: '/avatars/fox.glb', note: 'Passes, barely' },
	{ id: 'xbot', label: 'X Bot', url: '/avatars/xbot.glb', note: 'Untextured' },
	{ id: 'mannequin', label: 'Mannequin', url: '/avatars/mannequin.glb', note: 'Fails two rules' },
];

const MAX_BYTES = 256 * 1024 * 1024;

const state = {
	category: 'avatar',
	bytes: null,
	name: '',
	sourceUrl: '',
	viewer: null,
	loadToken: 0,
};

const $ = (id) => document.getElementById(id);

// ── Viewer ───────────────────────────────────────────────────────────────────
//
// Deliberately small: one object, framed, lit, orbitable. It exists to let a
// person see WHAT the gate just judged, so anything that competes with the
// verdict for attention (grids, gizmos, animation) is left out.

class Viewer {
	constructor(canvas) {
		this.canvas = canvas;
		this.ready = false;
		this.disposed = false;
		this.current = null;
		this.raf = 0;
	}

	async boot() {
		if (this.ready) return;
		const [THREE, { OrbitControls }, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
			import('three'),
			import('three/addons/controls/OrbitControls.js'),
			import('three/addons/loaders/GLTFLoader.js'),
			import('three/addons/environments/RoomEnvironment.js'),
		]);
		this.THREE = THREE;

		const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		this.renderer = renderer;

		this.scene = new THREE.Scene();
		const pmrem = new THREE.PMREMGenerator(renderer);
		this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

		this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
		this.controls = new OrbitControls(this.camera, renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.06;
		this.controls.enablePan = false;
		this.controls.minDistance = 0.4;
		this.controls.maxDistance = 40;

		const key = new THREE.DirectionalLight(0xffffff, 1.7);
		key.position.set(2.5, 4, 3);
		this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.35));

		// Meshopt is used across this site's own library, so a viewer that cannot
		// decode it would fail on the presets it ships with.
		this.loader = new GLTFLoader();
		try {
			const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
			this.loader.setMeshoptDecoder(MeshoptDecoder);
		} catch {
			// A model that needs meshopt will surface a load error of its own; the
			// gate verdict does not depend on decoding geometry, so this is not fatal.
		}

		this.resize();
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(this.canvas.parentElement);
		this.ready = true;
		this.tick();
	}

	resize() {
		if (!this.renderer) return;
		const host = this.canvas.parentElement;
		const w = Math.max(1, host.clientWidth);
		const h = Math.max(1, host.clientHeight);
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	tick = () => {
		if (this.disposed) return;
		this.raf = requestAnimationFrame(this.tick);
		this.controls?.update();
		this.renderer?.render(this.scene, this.camera);
	};

	clear() {
		if (!this.current) return;
		this.scene.remove(this.current);
		this.current.traverse((n) => {
			if (n.isMesh) {
				n.geometry?.dispose?.();
				for (const m of [].concat(n.material || [])) {
					for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) m?.[k]?.dispose?.();
					m?.dispose?.();
				}
			}
		});
		this.current = null;
	}

	async show(bytes) {
		await this.boot();
		const THREE = this.THREE;
		// parse() wants a real ArrayBuffer of exactly this view's bytes.
		const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const gltf = await new Promise((res, rej) => this.loader.parse(ab, '', res, rej));
		this.clear();
		const root = gltf.scene || gltf.scenes?.[0];
		if (!root) throw new Error('The file parsed but contains no scene to render.');
		this.scene.add(root);
		this.current = root;
		this.frame(root, THREE);
	}

	// Frame the object regardless of its authored scale or origin. Catalog
	// submissions arrive in metres, centimetres and arbitrary units, so a fixed
	// camera would put half of them off-screen.
	frame(root, THREE) {
		const box = new THREE.Box3().setFromObject(root);
		if (!box.isEmpty()) {
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const radius = Math.max(size.length() / 2, 1e-4);
			const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
			this.controls.target.copy(center);
			this.camera.position.set(center.x + dist * 0.42, center.y + size.y * 0.08, center.z + dist * 0.92);
			this.camera.near = Math.max(dist / 900, 0.001);
			this.camera.far = dist * 60;
			this.camera.updateProjectionMatrix();
			this.controls.minDistance = radius * 0.35;
			this.controls.maxDistance = dist * 7;
			this.controls.update();
		}
	}
}

// ── Verdict rendering ────────────────────────────────────────────────────────

const STATUS_META = {
	pass: { icon: '✓', label: 'Pass' },
	fail: { icon: '✕', label: 'Fail' },
	skipped: { icon: '–', label: 'Not applied' },
};

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderVerdict(report, verdict) {
	const badge = $('ins-badge');
	badge.className = `ins-badge ${report.pass ? 'is-pass' : 'is-fail'}`;
	badge.textContent = report.pass ? 'Clears the bar' : 'Below the bar';

	$('ins-headline').textContent = report.headline;
	$('ins-summary').textContent = report.summary;

	// Rig state is not a gate rule (an unrigged prop is perfectly valid), but it
	// is the single most common surprise for someone who expected to animate the
	// model, so it is reported as information rather than as a pass/fail.
	const rig = $('ins-rig');
	rig.textContent = verdict.rigged
		? `Rigged · ${verdict.jointCount} joints · ready to animate`
		: 'No skeleton · cannot be animated until it is rigged';
	rig.className = `ins-rig ${verdict.rigged ? 'is-rigged' : 'is-unrigged'}`;

	// Failures first: a person reading a rejection wants the reason, not a list
	// of the checks that were fine.
	const order = { fail: 0, pass: 1, skipped: 2 };
	const checks = [...report.checks].sort((a, b) => order[a.status] - order[b.status]);

	$('ins-checks').innerHTML = checks
		.map((c) => {
			const meta = STATUS_META[c.status] || STATUS_META.skipped;
			const detail =
				c.status === 'fail'
					? `<p class="ins-check-why">${escapeHtml(c.why)}</p><p class="ins-check-fix"><span>How to fix</span>${escapeHtml(c.fix)}</p>`
					: `<p class="ins-check-why">${escapeHtml(c.why)}</p>`;
			return `<details class="ins-check is-${c.status}"${c.status === 'fail' ? ' open' : ''}>
				<summary>
					<span class="ins-check-icon" aria-hidden="true">${meta.icon}</span>
					<span class="ins-check-label">${escapeHtml(c.label)}</span>
					<span class="ins-check-actual">${escapeHtml(c.actual)}</span>
					<span class="ins-check-bound">${escapeHtml(c.bound)}</span>
					<span class="ins-sr">${meta.label}</span>
				</summary>
				<div class="ins-check-body">${detail}</div>
			</details>`;
		})
		.join('');

	$('ins-result').hidden = false;
	$('ins-placeholder').hidden = true;
	$('ins-error').hidden = true;
}

function showError(message) {
	$('ins-error').textContent = message;
	$('ins-error').hidden = false;
	$('ins-result').hidden = true;
	$('ins-placeholder').hidden = true;
	setBusy(false);
}

function setBusy(on, label = 'Inspecting…') {
	$('ins-busy').hidden = !on;
	$('ins-busy-label').textContent = label;
	$('ins-stage').classList.toggle('is-busy', on);
}

// ── The run ──────────────────────────────────────────────────────────────────

function runGate() {
	if (!state.bytes) return;
	const verdict = gateMesh(state.bytes, { category: state.category });
	const report = explainMeshGate(verdict, { category: state.category });
	state.lastReport = { ...report, rigged: verdict.rigged, jointCount: verdict.jointCount, source: state.name };
	renderVerdict(report, verdict);
	return verdict;
}

async function inspect(bytes, name, sourceUrl = '') {
	const token = ++state.loadToken;
	state.bytes = bytes;
	state.name = name;
	state.sourceUrl = sourceUrl;
	$('ins-filename').textContent = name;
	$('ins-filename').hidden = false;

	// The verdict paints first and the renderer follows. The gate is synchronous
	// and costs a few milliseconds; making a person wait for a WebGL bundle to
	// learn whether their model passed would be backwards.
	const verdict = runGate();
	setBusy(false);
	updateShareLink();

	if (!verdict?.quality?.valid) {
		state.viewer?.clear();
		return;
	}
	try {
		state.viewer ||= new Viewer($('ins-canvas'));
		await state.viewer.show(bytes);
		if (token !== state.loadToken) return;
		$('ins-stage').classList.add('has-model');
		$('ins-hint').hidden = false;
	} catch (err) {
		if (token !== state.loadToken) return;
		// The gate verdict is still valid and already on screen; only the preview
		// failed, so this is a note beside the viewer rather than a page error.
		$('ins-stage').classList.remove('has-model');
		$('ins-viewer-note').textContent = `Preview unavailable: ${err?.message || 'the renderer could not open this file'}. The verdict above is unaffected.`;
		$('ins-viewer-note').hidden = false;
	}
}

async function inspectFile(file) {
	if (file.size > MAX_BYTES) {
		showError(`That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The inspector reads up to 256 MB.`);
		return;
	}
	setBusy(true, 'Reading file…');
	try {
		const buf = await file.arrayBuffer();
		await inspect(new Uint8Array(buf), file.name);
	} catch (err) {
		showError(`Could not read that file: ${err?.message || 'unknown error'}`);
	}
}

async function inspectUrl(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl, window.location.origin);
	} catch {
		showError('That does not look like a URL. Paste a direct link to a .glb file.');
		return;
	}
	if (!/^https?:$/.test(url.protocol)) {
		showError('Only http(s) URLs can be fetched. Drop the file instead.');
		return;
	}
	setBusy(true, 'Fetching model…');
	try {
		const res = await fetch(url.href);
		if (!res.ok) throw new Error(`the server returned ${res.status}`);
		const buf = await res.arrayBuffer();
		await inspect(new Uint8Array(buf), url.pathname.split('/').pop() || url.href, url.href);
	} catch (err) {
		// A cross-origin host without CORS headers is the overwhelmingly common
		// case here, and "failed to fetch" alone sends people hunting the wrong bug.
		showError(
			`Could not fetch that model: ${err?.message || 'the request failed'}. If the file is on another domain it must send CORS headers, otherwise download it and drop it in.`,
		);
	}
}

function updateShareLink() {
	const btn = $('ins-share');
	btn.hidden = !state.sourceUrl;
	btn.dataset.url = state.sourceUrl
		? `${window.location.origin}/inspect?url=${encodeURIComponent(state.sourceUrl)}&category=${state.category}`
		: '';
}

async function copy(text, btn, done = 'Copied') {
	const original = btn.textContent;
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = done;
	} catch {
		btn.textContent = 'Copy failed';
	}
	setTimeout(() => {
		btn.textContent = original;
	}, 1600);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wire() {
	const drop = $('ins-drop');
	const fileInput = $('ins-file');

	$('ins-browse').addEventListener('click', () => fileInput.click());
	fileInput.addEventListener('change', () => {
		if (fileInput.files?.[0]) inspectFile(fileInput.files[0]);
	});

	// dragover must be cancelled or the browser navigates to the file instead.
	let depth = 0;
	drop.addEventListener('dragenter', (e) => {
		e.preventDefault();
		depth++;
		drop.classList.add('is-over');
	});
	drop.addEventListener('dragover', (e) => e.preventDefault());
	drop.addEventListener('dragleave', () => {
		if (--depth <= 0) drop.classList.remove('is-over');
	});
	drop.addEventListener('drop', (e) => {
		e.preventDefault();
		depth = 0;
		drop.classList.remove('is-over');
		const file = e.dataTransfer?.files?.[0];
		if (file) inspectFile(file);
	});

	const urlForm = $('ins-url-form');
	urlForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const v = $('ins-url').value.trim();
		if (v) inspectUrl(v);
	});

	for (const btn of document.querySelectorAll('[data-category]')) {
		btn.addEventListener('click', () => {
			state.category = btn.dataset.category;
			for (const b of document.querySelectorAll('[data-category]')) {
				b.setAttribute('aria-pressed', String(b === btn));
			}
			// Re-judging locally is free, so switching category is instant and
			// shows the mesh-count rule turning itself off for props.
			runGate();
			updateShareLink();
		});
	}

	$('ins-presets').innerHTML = PRESETS.map(
		(p) =>
			`<button type="button" class="ins-preset" data-url="${p.url}" data-name="${p.label}">
				<span class="ins-preset-name">${p.label}</span>
				<span class="ins-preset-note">${p.note}</span>
			</button>`,
	).join('');
	$('ins-presets').addEventListener('click', (e) => {
		const btn = e.target.closest('.ins-preset');
		if (btn) inspectUrl(btn.dataset.url);
	});

	$('ins-copy-json').addEventListener('click', (e) => {
		copy(JSON.stringify(state.lastReport, null, 2), e.currentTarget);
	});
	$('ins-share').addEventListener('click', (e) => {
		copy(e.currentTarget.dataset.url, e.currentTarget, 'Link copied');
	});

	$('ins-gate-version').textContent = `gate v${SEED_GATE_VERSION}`;
}

function bootFromQuery() {
	const q = new URLSearchParams(window.location.search);
	const cat = q.get('category');
	if (cat === 'accessory' || cat === 'avatar') {
		state.category = cat;
		for (const b of document.querySelectorAll('[data-category]')) {
			b.setAttribute('aria-pressed', String(b.dataset.category === cat));
		}
	}
	const url = q.get('url');
	if (url) {
		$('ins-url').value = url;
		inspectUrl(url);
	}
}

wire();
bootFromQuery();
