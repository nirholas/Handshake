// Splat Viewer — render Gaussian-splat / radiance-field avatars in the browser.
//
// Reuses @mkkellogg/gaussian-splats-3d (already a project dependency, used by the
// Forge Studio Lab). Loads a .ply / .splat / .ksplat from a URL (?src=), a file
// upload, or a procedurally generated sample. Every state is designed: idle,
// loading, error, and the live HUD.

import { Color } from 'three';

const $ = (s, r = document) => r.querySelector(s);

const STAGE = () => $('#sp-stage');
const HOST = () => $('#sp-host');

// ── Splat lib (lazy) ─────────────────────────────────────────────────────────
let _GS = null;
async function loadSplatLib() {
	if (!_GS) _GS = await import('@mkkellogg/gaussian-splats-3d');
	return _GS;
}

// ── Active viewer lifecycle ──────────────────────────────────────────────────
let _viewer = null;
let _objectUrl = null; // blob URL feeding the viewer
let _downloadUrl = null; // blob URL backing the download button
let _lastRender = null; // { buffer, format, label } — for recenter / re-render

async function teardown() {
	if (!_viewer) return;
	const v = _viewer;
	_viewer = null;
	// dispose() nulls viewer.renderer partway through, so grab it first.
	const renderer = v.renderer;
	try {
		v.stop?.();
		// dispose() tears down the renderer then tries body.removeChild(rootElement),
		// which throws for our nested host. Everything we care about is gone by then.
		await v.dispose?.();
	} catch { /* harmless nested-root removeChild from the splat lib */ }
	// renderer.dispose() frees the three.js caches but leaves the WebGL context
	// alive, and the removeChild throw above aborts the lib's own final cleanup
	// before it can finish. Without an explicit release, every scene swap leaks a
	// live GL context, and a browser only grants a page a handful of those before
	// it starts reclaiming the oldest ones out from under a running scene.
	try {
		renderer?.forceContextLoss?.();
		renderer?.dispose?.();
	} catch { /* context already lost */ }
	if (_objectUrl) { URL.revokeObjectURL(_objectUrl); _objectUrl = null; }
	const host = HOST();
	if (host) host.innerHTML = '';
}

// ── State overlays ───────────────────────────────────────────────────────────
function showOnly(id) {
	for (const k of ['sp-idle', 'sp-loading', 'sp-error']) {
		const node = $(`#${k}`);
		if (node) node.hidden = k !== id;
	}
}
function setLoading(title, sub) {
	$('#sp-loading-title').textContent = title;
	if (sub != null) $('#sp-loading-sub').textContent = sub;
	$('#sp-hud').hidden = true;
	showOnly('sp-loading');
}
function setError(title, sub) {
	$('#sp-error-title').textContent = title;
	$('#sp-error-sub').textContent = sub || '';
	$('#sp-hud').hidden = true;
	showOnly('sp-error');
}
function setLive(label) {
	$('#sp-hud-label').textContent = label;
	$('#sp-hud').hidden = false;
	for (const k of ['sp-idle', 'sp-loading', 'sp-error']) $(`#${k}`).hidden = true;
}

function setDownload(url, filename) {
	const btn = $('#sp-download');
	if (_downloadUrl && _downloadUrl !== url) URL.revokeObjectURL(_downloadUrl);
	if (!url) { btn.hidden = true; btn.removeAttribute('href'); _downloadUrl = null; return; }
	_downloadUrl = url;
	btn.href = url;
	btn.download = filename || 'avatar.splat';
	btn.hidden = false;
}

// ── Format detection ─────────────────────────────────────────────────────────
function formatFor(name, GS) {
	const n = (name || '').toLowerCase();
	if (n.endsWith('.ply')) return GS.SceneFormat.Ply;
	if (n.endsWith('.ksplat')) return GS.SceneFormat.KSplat;
	return GS.SceneFormat.Splat;
}

// ── Core render ──────────────────────────────────────────────────────────────
const CAMERA_START = [0, 0, 3.2];
const CAMERA_TARGET = [0, 0, 0];

async function renderBuffer(buffer, { label, format }) {
	_lastRender = { buffer, format, label };
	setLoading('Decoding radiance field…', `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
	const GS = await loadSplatLib();
	await teardown();
	const host = HOST();
	host.innerHTML = '';

	_objectUrl = URL.createObjectURL(new Blob([buffer]));
	const viewer = new GS.Viewer({
		rootElement: host,
		sharedMemoryForWorkers: false,
		dynamicScene: false,
		useBuiltInControls: true,
		gpuAcceleratedSort: false,
		cameraUp: [0, 1, 0],
		initialCameraPosition: CAMERA_START,
		initialCameraLookAt: CAMERA_TARGET,
	});
	_viewer = viewer;
	try {
		await viewer.addSplatScene(_objectUrl, {
			format: format ?? GS.SceneFormat.Splat,
			showLoadingUI: false,
			progressiveLoad: false,
		});
		viewer.start();
		watchContextLoss(viewer);
		setLive(label);
		return true;
	} catch (err) {
		await teardown();
		setError('That file isn’t a valid splat', 'Expected a .ply, .splat, or .ksplat Gaussian-splat scene. Check the file and try again.');
		console.error('[splat] decode failed', err);
		return false;
	}
}

// A GPU driver reset or a browser-reclaimed context leaves a live canvas painting
// nothing. Say so instead of showing a frozen frame, and offer the way back.
function watchContextLoss(viewer) {
	const canvas = viewer.renderer?.domElement;
	if (!canvas) return;
	canvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault();
		if (_viewer !== viewer) return;
		teardown();
		setError('The 3D context was lost', 'Your browser released the WebGL context, usually after a GPU reset or heavy memory pressure. Load the scene again to restore it.');
	}, { once: true });
}

// Reset the camera on the live viewer. Rebuilding from the cached buffer also
// works, but it drops and recreates a WebGL context for what is a two-line
// transform change, and the stage flashes through the loading overlay.
function recenter() {
	const v = _viewer;
	if (v?.camera && v.controls) {
		v.camera.position.set(...CAMERA_START);
		v.controls.target.set(...CAMERA_TARGET);
		v.camera.lookAt(v.controls.target);
		v.controls.update();
		v.forceRenderNextFrame?.();
		return;
	}
	if (_lastRender) renderBuffer(_lastRender.buffer, _lastRender);
}

// Rewrite the page/redirect URLs of common asset hosts to their CORS-enabled
// raw form. GitHub and Hugging Face host most public .ply/.splat scenes, but
// their human-facing URLs (github.com/.../raw, .../blob, HF /blob) 302-redirect
// or serve HTML, and the redirect target's CORS headers break a browser fetch.
// The canonical raw hosts (raw.githubusercontent.com, HF /resolve) send
// `Access-Control-Allow-Origin: *`, so the same file loads cleanly.
function normalizeAssetUrl(parsed) {
	const host = parsed.hostname.toLowerCase();
	if (host === 'github.com') {
		// /<owner>/<repo>/(raw|blob)/<ref>/<path…>  →  raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…>
		const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/);
		if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}${parsed.search}`);
	}
	if (host === 'huggingface.co' || host === 'www.huggingface.co') {
		// .../blob/<ref>/<path>  →  .../resolve/<ref>/<path>  (raw bytes, with CORS)
		if (parsed.pathname.includes('/blob/')) {
			return new URL(`https://huggingface.co${parsed.pathname.replace('/blob/', '/resolve/')}${parsed.search}`);
		}
	}
	if (host === 'www.dropbox.com' || host === 'dropbox.com') {
		// Force a direct download instead of the HTML preview page.
		const direct = new URL(parsed.href);
		direct.searchParams.set('dl', '1');
		return direct;
	}
	return parsed;
}

async function loadFromUrl(url, label) {
	if (!url) return;
	let parsed;
	try { parsed = new URL(url, location.href); } catch { setError('That doesn’t look like a URL', url); return; }
	parsed = normalizeAssetUrl(parsed);
	setLoading('Fetching splat…', parsed.hostname);
	const GS = await loadSplatLib();
	let buffer;
	try {
		const res = await fetch(parsed.href);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		buffer = await res.arrayBuffer();
	} catch (err) {
		setError('Couldn’t fetch that splat', `${err.message}. The host may block cross-origin requests (CORS). Download the file and upload it instead.`);
		console.error('[splat] fetch failed', err);
		return;
	}
	const name = parsed.pathname.split('/').pop() || 'remote.splat';
	const ok = await renderBuffer(buffer, { label: label || name, format: formatFor(name, GS) });
	// The bytes are already in memory, so a remote scene is as saveable as an
	// uploaded one. Handing back the fetched buffer also spares the user a second
	// round trip to a host that may not allow one.
	setDownload(ok ? URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' })) : null, name);
}

async function loadFromFile(file) {
	const GS = await loadSplatLib();
	setLoading('Reading file…', file.name);
	let buffer;
	try { buffer = await file.arrayBuffer(); }
	catch (err) { setError('Couldn’t read that file', err.message); return; }
	const ok = await renderBuffer(buffer, { label: file.name, format: formatFor(file.name, GS) });
	setDownload(ok ? URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' })) : null, file.name);
}

// ── Procedural samples (antimatter15 .splat layout, 32 bytes/splat) ──────────
function writeSplat(view, base, x, y, z, sx, sy, sz, r, g, b, a) {
	view.setFloat32(base, x, true);
	view.setFloat32(base + 4, y, true);
	view.setFloat32(base + 8, z, true);
	view.setFloat32(base + 12, sx, true);
	view.setFloat32(base + 16, sy, true);
	view.setFloat32(base + 20, sz, true);
	view.setUint8(base + 24, r);
	view.setUint8(base + 25, g);
	view.setUint8(base + 26, b);
	view.setUint8(base + 27, a);
	// identity-ish rotation quaternion, encoded around 128
	view.setUint8(base + 28, 255);
	view.setUint8(base + 29, 128);
	view.setUint8(base + 30, 128);
	view.setUint8(base + 31, 128);
}

function sampleShell(count = 6000) {
	const buf = new ArrayBuffer(count * 32);
	const f = new DataView(buf);
	const col = new Color();
	for (let i = 0; i < count; i++) {
		const t = i / count;
		const phi = Math.acos(1 - 2 * t);
		const theta = Math.PI * (1 + Math.sqrt(5)) * i;
		col.setHSL((Math.cos(phi) + 1) / 2, 0.7, 0.55);
		writeSplat(f, i * 32,
			Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta),
			0.03, 0.03, 0.03,
			Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255), 255);
	}
	return buf;
}

// A head-and-shoulders bust: ellipsoid head + tapered shoulders, skin-toned, to
// evoke what a real GaussianAvatars capture looks like in this viewer. Synthetic.
function sampleBust(count = 14000) {
	const buf = new ArrayBuffer(count * 32);
	const f = new DataView(buf);
	const col = new Color();
	for (let i = 0; i < count; i++) {
		const t = i / count;
		const theta = Math.PI * (1 + Math.sqrt(5)) * i;
		let x, y, z;
		if (t < 0.62) {
			// Head — ellipsoid centered above origin
			const u = t / 0.62;
			const phi = Math.acos(1 - 2 * u);
			x = 0.62 * Math.sin(phi) * Math.cos(theta);
			y = 0.55 + 0.78 * Math.cos(phi);
			z = 0.66 * Math.sin(phi) * Math.sin(theta);
			const front = (z + 0.66) / 1.32; // warmer toward the face
			if (y > 1.18) col.setHSL(0.07, 0.3, 0.18); // hair cap
			else col.setHSL(0.06, 0.45, Math.max(0.1, 0.42 + 0.16 * front));
		} else {
			// Shoulders / chest — flattened cone widening downward
			const u = (t - 0.62) / 0.38;
			const r = 0.55 + 0.85 * u;
			x = r * Math.cos(theta);
			y = -0.05 - 0.95 * u;
			z = 0.62 * r * Math.sin(theta);
			col.setHSL(0.6, 0.25, 0.34 + 0.06 * Math.sin(theta * 3)); // garment
		}
		writeSplat(f, i * 32, x, y, z, 0.022, 0.022, 0.022,
			Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255), 255);
	}
	return buf;
}

async function loadSample(kind) {
	const GS = await loadSplatLib();
	const isBust = kind === 'bust';
	const buffer = isBust ? sampleBust() : sampleShell();
	const label = isBust ? 'Synthetic head bust · 14,000 splats' : 'Radiance shell · 6,000 splats';
	const ok = await renderBuffer(buffer, { label, format: GS.SceneFormat.Splat });
	setDownload(ok ? URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' })) : null, isBust ? 'sample-bust.splat' : 'sample-shell.splat');
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function init() {
	if (!STAGE()) return;

	$('#sp-load-url').addEventListener('click', () => {
		const url = $('#sp-url').value.trim();
		if (url) loadFromUrl(url);
	});
	$('#sp-url').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { const url = e.target.value.trim(); if (url) loadFromUrl(url); }
	});

	$('#sp-pick').addEventListener('click', () => $('#sp-file').click());
	// The whole idle panel is a mouse target, and the button inside it is the
	// keyboard one. Stop the button's click bubbling or the picker opens twice.
	$('#sp-idle-pick').addEventListener('click', (e) => { e.stopPropagation(); $('#sp-file').click(); });
	$('#sp-idle').addEventListener('click', () => $('#sp-file').click());
	$('#sp-file').addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) loadFromFile(file);
		e.target.value = '';
	});

	for (const btn of document.querySelectorAll('.sp-sample')) {
		btn.addEventListener('click', () => loadSample(btn.dataset.sample));
	}

	$('#sp-error-retry').addEventListener('click', () => loadSample('bust'));
	$('#sp-recenter').addEventListener('click', recenter);

	// Drag & drop onto the stage
	const stage = STAGE();
	['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
		e.preventDefault(); stage.classList.add('is-dragover');
	}));
	stage.addEventListener('dragleave', (e) => { if (e.target === stage) stage.classList.remove('is-dragover'); });
	stage.addEventListener('drop', (e) => {
		e.preventDefault(); stage.classList.remove('is-dragover');
		const file = e.dataTransfer?.files?.[0];
		if (file) loadFromFile(file);
	});

	// Deep link: ?src=<url>&name=<label>
	const p = new URLSearchParams(location.search);
	const src = p.get('src');
	if (src) {
		$('#sp-url').value = src;
		loadFromUrl(src, p.get('name') || undefined);
	}

	// pagehide, not beforeunload: an unconditional beforeunload listener opts the
	// page out of the back/forward cache, so returning to it would cost a full
	// reload of the splat engine.
	window.addEventListener('pagehide', () => { teardown(); setDownload(null); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
