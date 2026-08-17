/**
 * Studio Lab controller — the "every type of 3D" tab.
 *
 * Hosts a set of free, client-side 3D tools:
 *   - Five mesh generators (parametric, 3D text, SVG→3D, lithophane, terrain)
 *     from npm `three` + its github examples/jsm addons. Each builds a real
 *     THREE.Object3D, which we export to a binary GLB (GLTFExporter) and preview
 *     in <model-viewer> with a working Download GLB button.
 *   - Mesh → Gaussian-splat conversion (mesh-to-splat.js): our own splat
 *     generation lane — resamples any mesh (a Lab model or an uploaded GLB) into
 *     a Gaussian-splat radiance field, downloadable as a real .splat file.
 *   - A Gaussian-splat / radiance-field viewer from the npm package
 *     `@mkkellogg/gaussian-splats-3d` — a 3D representation the platform didn't
 *     have. Loads a .splat/.ply (or a generated sample) into its own renderer.
 *
 * Nothing here calls a paid API or the network; every model is computed in the
 * browser, so it is fully self-contained and testable.
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from '../../viewer/internal.js';
import { GENERATORS } from './generators.js';
import { meshToSplatBuffer } from './mesh-to-splat.js';
import { launchTalk } from '../talk-launch.js';

let _inited = false;
let _activeId = null;
let _lastGlbUrl = null;
let _lastGlbBlob = null; // last mesh GLB blob (for "Bring it alive")
let _lastLabel = '';
let _lastSplatUrl = null;
let _lastObject = null; // live Object3D from the last mesh gen (for splat conversion)
let _splat = null; // lazy { viewer, url }

const MESHSPLAT_TOOL = {
	id: 'meshsplat',
	label: 'Mesh → Splats',
	blurb: 'Our own splat lane: resample any mesh — a Lab model or an uploaded GLB — into a Gaussian-splat radiance field, downloadable as .splat.',
	kind: 'meshsplat',
	controls: [
		{
			key: 'source', label: 'Source', type: 'select', default: 'last',
			options: [
				{ value: 'last', label: 'Last Lab model' },
				{ value: 'upload', label: 'Upload a GLB/GLTF' },
			],
		},
		{ key: 'glb', label: 'GLB / GLTF file', type: 'glbfile', default: null, when: { source: 'upload' } },
		{ key: 'count', label: 'Splat count', type: 'range', min: 4000, max: 120000, step: 2000, default: 40000 },
		{ key: 'seed', label: 'Seed', type: 'range', min: 1, max: 999, step: 1, default: 7 },
	],
};

const SPLAT_TOOL = {
	id: 'splat',
	label: 'Splat Viewer',
	blurb: 'View a Gaussian-splat / radiance-field capture (.splat / .ply) — the photoreal 3D format. Drop a file, or render the built-in sample.',
	kind: 'splat',
	controls: [
		{ key: 'file', label: 'Splat file (.splat / .ply / .ksplat)', type: 'splatfile', default: null },
	],
};

const TOOLS = [...GENERATORS.map((g) => ({ ...g, kind: 'mesh' })), MESHSPLAT_TOOL, SPLAT_TOOL];

// ── DOM helpers ───────────────────────────────────────────────────────────────

const root = () => document.getElementById('studio-lab');
const $ = (sel) => root()?.querySelector(sel);

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (v != null) node.setAttribute(k, v);
	}
	for (const c of [].concat(children)) if (c) node.appendChild(c);
	return node;
}

function status(msg, kind = '') {
	const s = $('#lab-status');
	if (!s) return;
	s.textContent = msg || '';
	s.dataset.kind = kind;
}

// ── Tool picker + controls ────────────────────────────────────────────────────

function renderToolPicker() {
	const host = $('#lab-tools');
	host.innerHTML = '';
	for (const tool of TOOLS) {
		const btn = el('button', {
			type: 'button',
			class: 'lab-tool',
			'data-tool': tool.id,
			'aria-pressed': tool.id === _activeId ? 'true' : 'false',
		});
		btn.appendChild(el('span', { class: 'lab-tool-name', text: tool.label }));
		btn.appendChild(el('span', { class: 'lab-tool-blurb', text: tool.blurb }));
		btn.addEventListener('click', () => selectTool(tool.id));
		host.appendChild(btn);
	}
}

function controlVisible(field, values) {
	if (!field.when) return true;
	return Object.entries(field.when).every(([k, v]) => values[k] === v);
}

function currentValues() {
	const tool = TOOLS.find((t) => t.id === _activeId);
	const values = {};
	for (const f of tool.controls) {
		const node = $(`#lab-field-${f.key}`);
		if (!node) {
			values[f.key] = f.default;
			continue;
		}
		if (f.type === 'checkbox') values[f.key] = node.checked;
		else if (f.type === 'image' || f.type === 'splatfile' || f.type === 'glbfile') values[f.key] = node._fileData ?? f.default;
		else values[f.key] = node.value;
	}
	return values;
}

function renderControls() {
	const tool = TOOLS.find((t) => t.id === _activeId);
	const host = $('#lab-controls');
	host.innerHTML = '';

	for (const f of tool.controls) {
		const wrap = el('div', { class: 'lab-field', id: `lab-field-wrap-${f.key}` });
		const labelRow = el('label', { class: 'lab-field-label', for: `lab-field-${f.key}`, text: f.label });
		let input;

		if (f.type === 'range') {
			input = el('input', { type: 'range', id: `lab-field-${f.key}`, min: f.min, max: f.max, step: f.step, value: f.default });
			const out = el('output', { class: 'lab-field-out', text: String(f.default) });
			input.addEventListener('input', () => { out.textContent = input.value; });
			wrap.appendChild(labelRow);
			labelRow.appendChild(out);
			wrap.appendChild(input);
		} else if (f.type === 'select') {
			input = el('select', { id: `lab-field-${f.key}` });
			for (const o of f.options) {
				const opt = el('option', { value: o.value, text: o.label });
				if (o.value === f.default) opt.selected = true;
				input.appendChild(opt);
			}
			input.addEventListener('change', () => syncConditional());
			wrap.appendChild(labelRow);
			wrap.appendChild(input);
		} else if (f.type === 'color') {
			input = el('input', { type: 'color', id: `lab-field-${f.key}`, value: f.default });
			wrap.appendChild(labelRow);
			wrap.appendChild(input);
		} else if (f.type === 'checkbox') {
			input = el('input', { type: 'checkbox', id: `lab-field-${f.key}` });
			input.checked = !!f.default;
			const inline = el('label', { class: 'lab-field-check' });
			inline.appendChild(input);
			inline.appendChild(el('span', { text: f.label }));
			wrap.appendChild(inline);
		} else if (f.type === 'text') {
			input = el('input', { type: 'text', id: `lab-field-${f.key}`, value: f.default, maxlength: f.maxlength, placeholder: f.placeholder });
			wrap.appendChild(labelRow);
			wrap.appendChild(input);
		} else if (f.type === 'textarea') {
			input = el('textarea', { id: `lab-field-${f.key}`, rows: '4', placeholder: f.placeholder });
			input.value = f.default || '';
			wrap.appendChild(labelRow);
			wrap.appendChild(input);
		} else if (f.type === 'image' || f.type === 'splatfile' || f.type === 'glbfile') {
			const accept = f.type === 'image' ? 'image/*' : f.type === 'glbfile' ? '.glb,.gltf,model/gltf-binary' : '.splat,.ply,.ksplat';
			input = el('input', { type: 'file', id: `lab-field-${f.key}`, accept });
			const hintText = f.type === 'image' ? 'optional — uses a sample if empty' : f.type === 'glbfile' ? 'pick a .glb / .gltf' : 'optional — renders a sample if empty';
			const hint = el('span', { class: 'lab-field-out', text: hintText });
			input.addEventListener('change', async () => {
				const file = input.files?.[0];
				if (!file) { input._fileData = null; return; }
				if (f.type === 'image') {
					input._fileData = await fileToDataURL(file);
				} else {
					input._fileData = { buffer: await file.arrayBuffer(), name: file.name };
				}
				hint.textContent = file.name;
			});
			wrap.appendChild(labelRow);
			labelRow.appendChild(hint);
			wrap.appendChild(input);
		}

		host.appendChild(wrap);
	}
	syncConditional();
}

function syncConditional() {
	const tool = TOOLS.find((t) => t.id === _activeId);
	const values = currentValues();
	for (const f of tool.controls) {
		const wrap = $(`#lab-field-wrap-${f.key}`);
		if (wrap) wrap.hidden = !controlVisible(f, values);
	}
}

function selectTool(id) {
	_activeId = id;
	for (const b of root().querySelectorAll('.lab-tool')) {
		b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false');
	}
	const tool = TOOLS.find((t) => t.id === id);
	renderControls();
	const splatLike = tool.kind === 'splat' || tool.kind === 'meshsplat';
	$('#lab-viewer').hidden = splatLike;
	$('#lab-splat').hidden = !splatLike;
	$('#lab-generate').textContent =
		tool.kind === 'mesh' ? 'Generate model' :
		tool.kind === 'meshsplat' ? 'Convert to splats' : 'Render splats';
	// Hide download until there's something to download for this tool kind.
	resetDownload();
	// "Bring it alive" only applies to mesh GLBs (talk-mode needs a GLB), and
	// only once one has been generated.
	$('#lab-talk').classList.toggle('is-hidden', !(tool.kind === 'mesh' && _lastGlbBlob));
	status('');
	if (!splatLike) teardownSplat();
}

function resetDownload() {
	const dl = $('#lab-download');
	dl.classList.add('is-disabled');
	dl.removeAttribute('href');
	// Href-less anchors are invisible to keyboard and screen-reader users, so the
	// disabled affordance has to be announced explicitly rather than implied by
	// the dimmed style alone.
	dl.setAttribute('aria-disabled', 'true');
	dl.setAttribute('title', 'Generate something first, then download it as a file');
}

function setDownload(url, filename, label) {
	const dl = $('#lab-download');
	dl.href = url;
	dl.setAttribute('download', filename);
	dl.querySelector('.lab-dl-label').textContent = label;
	dl.classList.remove('is-disabled');
	dl.removeAttribute('aria-disabled');
	dl.setAttribute('title', `Download ${filename}`);
}

// ── Generate ──────────────────────────────────────────────────────────────────

async function exportGlb(object3d) {
	const exporter = new GLTFExporter();
	const result = await exporter.parseAsync(object3d, { binary: true, onlyVisible: true });
	return new Blob([result], { type: 'model/gltf-binary' });
}

async function loadGlbScene(arrayBuffer) {
	const loader = new GLTFLoader();
	loader.setMeshoptDecoder(await getMeshoptDecoder());
	const gltf = await loader.parseAsync(arrayBuffer, '');
	return gltf.scene;
}

function disposeObject(obj) {
	if (!obj) return;
	obj.traverse((o) => {
		o.geometry?.dispose?.();
		const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
		for (const m of mats) m.dispose?.();
	});
}

async function generate() {
	const tool = TOOLS.find((t) => t.id === _activeId);
	const btn = $('#lab-generate');
	btn.disabled = true;
	try {
		if (tool.kind === 'splat') {
			await renderSplatFile();
		} else if (tool.kind === 'meshsplat') {
			await convertToSplats();
		} else {
			await generateMesh(tool);
		}
	} catch (err) {
		status(err.message || 'Generation failed.', 'err');
		// eslint-disable-next-line no-console
		console.error('[studio-lab]', err);
	} finally {
		btn.disabled = false;
	}
}

async function generateMesh(tool) {
	status('Building geometry…');
	const params = currentValues();
	const object = await tool.build(params);
	object.name = tool.label;
	status('Exporting GLB…');
	const blob = await exportGlb(object);
	if (_lastGlbUrl) URL.revokeObjectURL(_lastGlbUrl);
	_lastGlbUrl = URL.createObjectURL(blob);
	$('#lab-viewer').setAttribute('src', _lastGlbUrl);
	setDownload(_lastGlbUrl, `${tool.id}-${Date.now()}.glb`, 'Download GLB');
	_lastGlbBlob = blob;
	_lastLabel = tool.label;
	$('#lab-talk').classList.remove('is-hidden');
	// Keep the live object so Mesh → Splats can convert it; dispose the prior one.
	disposeObject(_lastObject);
	_lastObject = object;
	status(`${tool.label} ready · ${(blob.size / 1024).toFixed(0)} KB GLB · now try Mesh → Splats`, 'ok');
}

async function bringAlive() {
	if (!_lastGlbBlob) return;
	const btn = $('#lab-talk');
	btn.disabled = true;
	try {
		await launchTalk({ name: _lastLabel || 'Your creation', glbBlob: _lastGlbBlob, kind: 'object' });
	} catch (err) {
		status(err.message || 'Could not start talk mode.', 'err');
		// eslint-disable-next-line no-console
		console.error('[studio-lab] talk', err);
	} finally {
		btn.disabled = false;
	}
}

async function convertToSplats() {
	const params = currentValues();
	let source = _lastObject;
	let sourceLabel = 'last Lab model';
	if (params.source === 'upload') {
		const f = params.glb;
		if (!f?.buffer) throw new Error('Choose a .glb / .gltf file to convert.');
		status('Loading GLB…');
		source = await loadGlbScene(f.buffer);
		sourceLabel = f.name;
	}
	if (!source) throw new Error('No model yet — generate one with a mesh tool first, or upload a GLB.');
	status('Sampling surface into Gaussians… 0%');
	const { buffer, count, textured } = await meshToSplatBuffer(source, {
		count: Number(params.count),
		seed: Number(params.seed),
		onProgress: (pct) => status(`Sampling surface into Gaussians… ${pct}%`),
	});
	if (params.source === 'upload') disposeObject(source); // free the uploaded scene
	const colorNote = textured ? ' · textured' : '';
	await renderSplatBuffer(buffer, `${count.toLocaleString()} splats from ${sourceLabel}${colorNote}`);
	// .splat download
	if (_lastSplatUrl) URL.revokeObjectURL(_lastSplatUrl);
	_lastSplatUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
	setDownload(_lastSplatUrl, `meshsplat-${Date.now()}.splat`, 'Download .splat');
}

// ── Gaussian splats ───────────────────────────────────────────────────────────

// Built-in sample: a rainbow fibonacci-sphere shell in the antimatter15 .splat
// layout (32 bytes/splat).
function sampleSplatBuffer(count = 4000) {
	const buf = new ArrayBuffer(count * 32);
	const f = new DataView(buf);
	const col = new THREE.Color();
	for (let i = 0; i < count; i++) {
		const base = i * 32;
		const t = i / count;
		const phi = Math.acos(1 - 2 * t);
		const theta = Math.PI * (1 + Math.sqrt(5)) * i;
		f.setFloat32(base, Math.sin(phi) * Math.cos(theta), true);
		f.setFloat32(base + 4, Math.cos(phi), true);
		f.setFloat32(base + 8, Math.sin(phi) * Math.sin(theta), true);
		f.setFloat32(base + 12, 0.03, true);
		f.setFloat32(base + 16, 0.03, true);
		f.setFloat32(base + 20, 0.03, true);
		col.setHSL((Math.cos(phi) + 1) / 2, 0.7, 0.55);
		f.setUint8(base + 24, Math.round(col.r * 255));
		f.setUint8(base + 25, Math.round(col.g * 255));
		f.setUint8(base + 26, Math.round(col.b * 255));
		f.setUint8(base + 27, 255);
		f.setUint8(base + 28, 255);
		f.setUint8(base + 29, 128);
		f.setUint8(base + 30, 128);
		f.setUint8(base + 31, 128);
	}
	return buf;
}

async function renderSplatFile() {
	const fileField = $('#lab-field-file');
	const uploaded = fileField?._fileData || null;
	let buffer, format, label;
	const GS = await loadSplatLib();
	if (uploaded) {
		buffer = uploaded.buffer;
		format =
			uploaded.name.endsWith('.ply') ? GS.SceneFormat.Ply :
			uploaded.name.endsWith('.ksplat') ? GS.SceneFormat.KSplat :
			GS.SceneFormat.Splat;
		label = `Loaded ${uploaded.name}`;
	} else {
		buffer = sampleSplatBuffer();
		format = GS.SceneFormat.Splat;
		label = 'Sample radiance field · 4,000 splats';
	}
	await renderSplatBuffer(buffer, label, format);
	// Allow re-downloading the loaded/sample splat.
	if (_lastSplatUrl) URL.revokeObjectURL(_lastSplatUrl);
	_lastSplatUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
	setDownload(_lastSplatUrl, uploaded ? uploaded.name : 'sample.splat', 'Download .splat');
}

let _GS = null;
async function loadSplatLib() {
	if (!_GS) _GS = await import('@mkkellogg/gaussian-splats-3d');
	return _GS;
}

async function renderSplatBuffer(buffer, label, format) {
	status('Loading splat engine…');
	const GS = await loadSplatLib();
	await teardownSplat();
	const host = $('#lab-splat');
	host.innerHTML = '';
	const url = URL.createObjectURL(new Blob([buffer]));
	const viewer = new GS.Viewer({
		rootElement: host,
		sharedMemoryForWorkers: false,
		dynamicScene: false,
		useBuiltInControls: true,
		gpuAcceleratedSort: false,
		cameraUp: [0, 1, 0],
		initialCameraPosition: [0, 0, 4],
		initialCameraLookAt: [0, 0, 0],
	});
	_splat = { viewer, url };
	status('Rendering splats…');
	await viewer.addSplatScene(url, { format: format ?? GS.SceneFormat.Splat, showLoadingUI: false, progressiveLoad: false });
	viewer.start();
	status(label, 'ok');
}

async function teardownSplat() {
	if (!_splat) return;
	const s = _splat;
	_splat = null;
	try {
		s.viewer.stop?.();
		// dispose() cleans up the renderer + its canvas first, then tries to
		// document.body.removeChild(rootElement) — which throws because our root
		// (#lab-splat) is nested, not a direct child of body. Everything we care
		// about is already torn down by then, so we await and swallow that one.
		await s.viewer.dispose?.();
	} catch { /* harmless nested-root removeChild from the splat lib */ }
	if (s.url) URL.revokeObjectURL(s.url);
	const host = document.getElementById('lab-splat');
	if (host) host.innerHTML = '';
}

// ── Misc ──────────────────────────────────────────────────────────────────────

function fileToDataURL(file) {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result);
		r.onerror = () => reject(new Error('Could not read that file.'));
		r.readAsDataURL(file);
	});
}

export function initLab() {
	if (_inited) return;
	if (!root()) return;
	_inited = true;
	renderToolPicker();
	$('#lab-generate').addEventListener('click', generate);
	$('#lab-talk').addEventListener('click', bringAlive);
	selectTool(TOOLS[0].id);
}
