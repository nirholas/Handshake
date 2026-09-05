// Machine Atlas (/assembly): two working machines with no model files behind
// them. Both are generated from their parameters when the page loads, and
// regenerated whenever a slider moves, so what you see is always the geometry
// those numbers describe. The motion is solved from the same dimensions rather
// than played back.
//
// Structure:
//   src/assembly/parts.js       profiles, revolves, extrusions, lofts
//   src/assembly/rig.js         explode runtime and the linkage solvers
//   src/assembly/materials.js   one palette shared by every machine
//   src/assembly/*.js           one module per machine

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as radial from './assembly/radial-engine.js';
import * as locomotive from './assembly/locomotive.js';
import { applyExplode, groupsOf, setGroupVisible } from './assembly/rig.js';
import { disposeTree, ghostMaterial } from './assembly/materials.js';
import { triangleCount } from './assembly/parts.js';
import { track, ANALYTICS_EVENTS } from './analytics.js';

const MACHINES = [radial, locomotive];
const byId = new Map(MACHINES.map((m) => [m.spec.id, m]));
const $ = (id) => document.getElementById(id);

const state = {
	machine: null,
	values: {},
	built: null,
	angle: 0,
	speed: 0.55,
	playing: true,
	explode: 0,
	explodeTarget: 0,
	structure: false,
	hidden: new Set(),
};

/* ── renderer ───────────────────────────────────────────────────────── */

const host = $('maCanvas');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 0.6;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.495;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(4.2, 6.4, 3.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0012;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc4ff, 0.7);
rim.position.set(-5, 2.4, -4.5);
scene.add(rim);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const shadowPlane = new THREE.Mesh(
	new THREE.PlaneGeometry(80, 80),
	new THREE.ShadowMaterial({ opacity: 0.3 }),
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

// The stage follows the site theme instead of pinning one background, so the
// atlas does not glare in light mode or wash out in dark.
function applyTheme() {
	const light = document.documentElement.getAttribute('data-theme') === 'light';
	const bg = light ? 0xeceef0 : 0x0c0d0f;
	scene.background = new THREE.Color(bg);
	scene.fog = new THREE.Fog(bg, 14, 46);
	shadowPlane.material.opacity = light ? 0.22 : 0.34;
}
applyTheme();
new MutationObserver(applyTheme).observe(document.documentElement, {
	attributes: true,
	attributeFilter: ['data-theme'],
});

function resize() {
	const w = host.clientWidth || 1;
	const h = host.clientHeight || 1;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();

/* ── build and rebuild ──────────────────────────────────────────────── */

let current = null;

// Fit the machine in frame. `keepDirection` preserves whatever angle the user
// has orbited to and changes only the distance, which is what a refit after an
// explode should do: the view is theirs, the framing is ours.
// The ground catches the shadow, so it tracks the lowest point of whatever is
// on stage even when the camera is left alone.
function settleShadow(root) {
	shadowPlane.position.y = new THREE.Box3().setFromObject(root).min.y + 0.002;
}

function frameMachine(spec, root, { animate = false, keepDirection = false, explode = null } = {}) {
	const restore = explode !== null && explode !== state.explode;
	if (restore) applyExplode(root, explode);
	// Frame the machine, not the scenery. The locomotive's track runs well past
	// both ends of it; including that would push the camera into the next county.
	const box = new THREE.Box3();
	const ground = new THREE.Box3().setFromObject(root);
	root.traverse((o) => {
		if (!o.isMesh || !o.visible) return;
		if (o.userData.group === 'track') return;
		box.expandByObject(o);
	});
	if (restore) applyExplode(root, state.explode);
	if (box.isEmpty()) box.copy(ground);
	const size = box.getSize(new THREE.Vector3());
	const centre = box.getCenter(new THREE.Vector3());
	const radiusOf = Math.max(size.x, size.y, size.z) * 0.5;
	// Fit the bounding sphere in the vertical field of view, with room to spare
	// so a propeller tip or a chimney never touches the frame edge.
	const dist = (radiusOf / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.16;
	const dir = keepDirection
		? camera.position.clone().sub(controls.target).normalize()
		: new THREE.Vector3(...spec.camera.position).normalize();
	const target = new THREE.Vector3(centre.x, centre.y * 0.9, centre.z);
	const eye = target.clone().addScaledVector(dir, dist);
	if (animate) {
		tweenCamera(eye, target);
	} else {
		camera.position.copy(eye);
		controls.target.copy(target);
		controls.update();
	}
	shadowPlane.position.y = ground.min.y + 0.002;
}

let tween = null;
function tweenCamera(eye, target) {
	tween = {
		fromEye: camera.position.clone(),
		fromTarget: controls.target.clone(),
		eye,
		target,
		t: 0,
	};
}

// `frame` decides what happens to the camera: 'reset' flies to the machine's
// signature angle, 'keep' leaves the user exactly where they were. Dragging a
// dimension slider rebuilds geometry many times a second, and snapping the
// camera back on each rebuild would make the sliders unusable.
function build(machineId, values, { frame = 'keep' } = {}) {
	const machine = byId.get(machineId);
	if (!machine) return;
	if (current) {
		scene.remove(current.root);
		disposeTree(current.root);
	}
	const built = machine.build(values);
	scene.add(built.root);
	current = built;
	state.machine = machine;
	state.built = built;
	built.update(state.angle);
	applyExplode(built.root, state.explode);
	for (const g of state.hidden) setGroupVisible(built.root, g, false);
	if (state.structure) setStructure(true);
	if (frame === 'reset') frameMachine(machine.spec, built.root, { animate: true });
	else if (frame === 'first') frameMachine(machine.spec, built.root, { animate: false });
	else settleShadow(built.root);
	renderStats();
	renderParts();
	renderCode();
	renderReadout();
}

// Pulling a machine apart makes it bigger. Refit the distance to the exploded
// bounds while keeping the angle the user chose, so nothing leaves the frame.
function refitForExplode() {
	if (!current) return;
	frameMachine(state.machine.spec, current.root, {
		animate: true,
		keepDirection: true,
		explode: state.explodeTarget,
	});
}

/* ── structure view ─────────────────────────────────────────────────── */

const ghost = ghostMaterial();
function setStructure(on) {
	state.structure = on;
	if (!current) return;
	current.root.traverse((o) => {
		if (!o.isMesh) return;
		if (on) {
			if (!o.userData.solidMaterial) o.userData.solidMaterial = o.material;
			o.material = ghost;
			o.castShadow = false;
		} else if (o.userData.solidMaterial) {
			o.material = o.userData.solidMaterial;
			o.castShadow = true;
		}
	});
	$('maStructure').setAttribute('aria-pressed', String(on));
}

/* ── url state ──────────────────────────────────────────────────────── */

function readUrl() {
	const q = new URLSearchParams(location.search);
	const id = q.get('m');
	const machine = byId.get(id) || MACHINES[0];
	const values = {};
	for (const p of machine.spec.params) {
		const raw = q.get(p.key);
		const n = raw === null ? p.value : Number(raw);
		values[p.key] = Number.isFinite(n) ? clampStep(n, p) : p.value;
	}
	return { machine, values };
}

// Snap to the slider's own grid, which starts at `min` and not at zero. Off by
// one step is the difference between a nine-cylinder radial and a ten.
function clampStep(n, p) {
	const clamped = Math.min(p.max, Math.max(p.min, n));
	const snapped = p.min + Math.round((clamped - p.min) / p.step) * p.step;
	return Number(snapped.toFixed(4));
}

function writeUrl() {
	const q = new URLSearchParams();
	q.set('m', state.machine.spec.id);
	for (const p of state.machine.spec.params) {
		const v = state.values[p.key];
		if (v !== p.value) q.set(p.key, String(v));
	}
	const url = `${location.pathname}?${q.toString()}`;
	history.replaceState(null, '', url);
	return new URL(url, location.origin).toString();
}

/* ── panels ─────────────────────────────────────────────────────────── */

function renderTabs() {
	const wrap = $('maTabs');
	wrap.innerHTML = '';
	for (const m of MACHINES) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'ma-tab';
		b.setAttribute('aria-pressed', String(m === state.machine));
		b.innerHTML = `<span class="ma-tab-no">${String(MACHINES.indexOf(m) + 1).padStart(2, '0')}</span><span class="ma-tab-name">${m.spec.name}</span><span class="ma-tab-era">${m.spec.era}</span>`;
		b.addEventListener('click', () => selectMachine(m.spec.id));
		wrap.appendChild(b);
	}
}

function renderHeader() {
	const s = state.machine.spec;
	$('maName').textContent = s.name;
	$('maSubtitle').textContent = s.subtitle;
	$('maBlurb').textContent = s.blurb;
	const facts = $('maFacts');
	facts.innerHTML = '';
	for (const [k, v] of s.facts) {
		const li = document.createElement('li');
		li.innerHTML = `<span>${k}</span><strong>${v}</strong>`;
		facts.appendChild(li);
	}
}

function renderParams() {
	const wrap = $('maParams');
	wrap.innerHTML = '';
	for (const p of state.machine.spec.params) {
		const row = document.createElement('div');
		row.className = 'ma-param';
		const id = `ma-p-${p.key}`;
		row.innerHTML = `
			<label for="${id}">${p.label}</label>
			<output id="${id}-out">${format(state.values[p.key], p)}</output>
			<input id="${id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${state.values[p.key]}" />`;
		const input = row.querySelector('input');
		const out = row.querySelector('output');
		input.addEventListener('input', () => {
			state.values[p.key] = Number(input.value);
			out.textContent = format(state.values[p.key], p);
			scheduleRebuild();
		});
		input.addEventListener('change', () => {
			track(ANALYTICS_EVENTS.CTA_CLICKED, { cta: `assembly_param_${p.key}`, location: 'assembly' });
		});
		wrap.appendChild(row);
	}
}

function format(v, p) {
	const n = p.step < 1 ? v.toFixed(2) : String(Math.round(v));
	return p.unit ? `${n} ${p.unit}`.trim() : n;
}

let rebuildQueued = false;
let lastRebuild = 0;
function scheduleRebuild() {
	if (rebuildQueued) return;
	rebuildQueued = true;
	const wait = Math.max(0, 70 - (performance.now() - lastRebuild));
	setTimeout(() => {
		rebuildQueued = false;
		lastRebuild = performance.now();
		build(state.machine.spec.id, state.values);
		writeUrl();
	}, wait);
}

function renderReadout() {
	const wrap = $('maReadout');
	wrap.innerHTML = '';
	for (const [k, v] of current.readout) {
		const li = document.createElement('li');
		li.innerHTML = `<span>${k}</span><strong>${v}</strong>`;
		wrap.appendChild(li);
	}
}

function renderParts() {
	const wrap = $('maParts');
	wrap.innerHTML = '';
	const counts = new Map();
	current.root.traverse((o) => {
		if (!o.isMesh) return;
		const g = o.userData.group || 'frame';
		counts.set(g, (counts.get(g) || 0) + 1);
	});
	for (const g of groupsOf(current.root)) {
		if (!counts.has(g)) continue;
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'ma-part';
		const on = !state.hidden.has(g);
		b.setAttribute('aria-pressed', String(on));
		b.innerHTML = `<span class="ma-dot" aria-hidden="true"></span><span class="ma-part-name">${g}</span><span class="ma-part-n">${counts.get(g)}</span>`;
		b.addEventListener('click', () => {
			const nowOn = state.hidden.has(g);
			if (nowOn) state.hidden.delete(g);
			else state.hidden.add(g);
			setGroupVisible(current.root, g, nowOn);
			b.setAttribute('aria-pressed', String(nowOn));
			renderStats();
		});
		wrap.appendChild(b);
	}
}

function renderCode() {
	const wrap = $('maCode');
	wrap.innerHTML = '';
	for (const { label, code } of state.machine.codeFor(state.values)) {
		const block = document.createElement('figure');
		block.className = 'ma-code-block';
		const cap = document.createElement('figcaption');
		cap.textContent = label;
		const pre = document.createElement('pre');
		pre.textContent = code;
		block.append(cap, pre);
		wrap.appendChild(block);
	}
}

function renderStats() {
	let meshes = 0;
	current.root.traverse((o) => {
		if (o.isMesh && o.visible) meshes++;
	});
	$('maStatParts').textContent = String(meshes);
	$('maStatTris').textContent = formatCount(triangleCount(current.root));
}

function formatCount(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

function selectMachine(id) {
	if (state.machine && state.machine.spec.id === id) return;
	const machine = byId.get(id);
	state.values = {};
	for (const p of machine.spec.params) state.values[p.key] = p.value;
	state.hidden.clear();
	state.angle = 0;
	build(id, state.values, { frame: 'reset' });
	renderTabs();
	renderHeader();
	renderParams();
	writeUrl();
	track(ANALYTICS_EVENTS.SURFACE_OPENED, { surface: `visualizer:assembly:${id}` });
}

/* ── hover inspection ───────────────────────────────────────────────── */

const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const label = $('maLabel');
let hovered = null;

host.addEventListener('pointermove', (e) => {
	const r = host.getBoundingClientRect();
	pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
	pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
	label.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top + 14}px)`;
	pickPending = true;
});
host.addEventListener('pointerleave', () => {
	setHovered(null);
	pickPending = false;
});

let pickPending = false;
function pick() {
	if (!current) return;
	ray.setFromCamera(pointer, camera);
	const hit = ray.intersectObject(current.root, true).find((h) => h.object.visible);
	setHovered(hit ? hit.object : null);
}

function setHovered(obj) {
	if (obj === hovered) return;
	if (hovered && hovered.userData.hoverMaterial) {
		hovered.material = hovered.userData.hoverMaterial;
		hovered.userData.hoverMaterial = null;
	}
	hovered = obj;
	if (!obj) {
		label.hidden = true;
		return;
	}
	if (!state.structure) {
		obj.userData.hoverMaterial = obj.material;
		const m = obj.material.clone();
		m.emissive = new THREE.Color(0x2f6fff);
		m.emissiveIntensity = 0.55;
		obj.material = m;
	}
	label.hidden = false;
	label.innerHTML = `<strong>${obj.name}</strong><span>${obj.userData.group || 'frame'}</span>`;
}

/* ── actions ────────────────────────────────────────────────────────── */

function toast(message) {
	const el = $('maToast');
	el.textContent = message;
	el.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => {
		el.hidden = true;
	}, 2600);
}

async function copy(text, message) {
	try {
		await navigator.clipboard.writeText(text);
		toast(message);
	} catch {
		const ta = document.createElement('textarea');
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		document.execCommand('copy');
		ta.remove();
		toast(message);
	}
}

function specJson() {
	return JSON.stringify(
		{
			machine: state.machine.spec.id,
			name: state.machine.spec.name,
			units: 'mm and count, as labelled',
			params: state.values,
		},
		null,
		2,
	);
}

function download(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportGlb() {
	const btn = $('maExport');
	btn.disabled = true;
	btn.dataset.busy = '1';
	try {
		const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
		const exporter = new GLTFExporter();
		const buffer = await exporter.parseAsync(current.root, { binary: true, onlyVisible: true });
		download(new Blob([buffer], { type: 'model/gltf-binary' }), `${state.machine.spec.id}.glb`);
		toast('GLB exported. Drop it on /viewer to inspect it.');
		track(ANALYTICS_EVENTS.CTA_CLICKED, { cta: 'assembly_export_glb', location: 'assembly' });
	} catch (err) {
		toast(`Export failed: ${err && err.message ? err.message : 'unknown error'}`);
	} finally {
		btn.disabled = false;
		delete btn.dataset.busy;
	}
}

function saveFrame() {
	const w = host.clientWidth;
	const h = host.clientHeight;
	const ratio = renderer.getPixelRatio();
	renderer.setPixelRatio(Math.min(3, ratio * 2));
	renderer.setSize(w, h, false);
	renderer.render(scene, camera);
	renderer.domElement.toBlob((blob) => {
		if (blob) download(blob, `${state.machine.spec.id}-frame.png`);
		renderer.setPixelRatio(ratio);
		resize();
	}, 'image/png');
	track(ANALYTICS_EVENTS.CTA_CLICKED, { cta: 'assembly_save_frame', location: 'assembly' });
}

function share() {
	const url = writeUrl();
	const text = `${state.machine.spec.name}: no model file, generated in the browser from ${state.machine.spec.params.length} numbers.`;
	const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
	window.open(intent, '_blank', 'noopener');
	track(ANALYTICS_EVENTS.CTA_CLICKED, { cta: 'assembly_share', location: 'assembly' });
}

/* ── transport ──────────────────────────────────────────────────────── */

function setPlaying(on) {
	state.playing = on;
	const b = $('maPlay');
	b.setAttribute('aria-pressed', String(on));
	b.querySelector('.ma-play-label').textContent = on ? 'Running' : 'Held';
}

function wire() {
	$('maPlay').addEventListener('click', () => setPlaying(!state.playing));
	$('maSpeed').addEventListener('input', (e) => {
		state.speed = Number(e.target.value);
		$('maSpeedOut').textContent = `${state.speed.toFixed(2)} rev/s`;
	});
	$('maExplode').addEventListener('input', (e) => {
		state.explodeTarget = Number(e.target.value);
	});
	$('maExplode').addEventListener('change', refitForExplode);
	$('maStructure').addEventListener('click', () => setStructure(!state.structure));
	$('maReset').addEventListener('click', () => {
		for (const p of state.machine.spec.params) state.values[p.key] = p.value;
		renderParams();
		build(state.machine.spec.id, state.values, { frame: 'reset' });
		writeUrl();
		toast('Back to the reference dimensions.');
	});
	$('maExport').addEventListener('click', exportGlb);
	$('maFrame').addEventListener('click', saveFrame);
	$('maSpec').addEventListener('click', () => copy(specJson(), 'Spec JSON copied.'));
	$('maLink').addEventListener('click', () => copy(writeUrl(), 'Shareable link copied.'));
	$('maShare').addEventListener('click', share);
	$('maSourceToggle').addEventListener('click', () => {
		const open = document.body.classList.toggle('ma-source-open');
		$('maSourceToggle').setAttribute('aria-expanded', String(open));
	});
	addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLInputElement) return;
		if (e.key === ' ') {
			e.preventDefault();
			setPlaying(!state.playing);
		} else if (e.key === 'e' || e.key === 'E') {
			state.explodeTarget = state.explodeTarget > 0.5 ? 0 : 1;
			$('maExplode').value = String(state.explodeTarget);
			refitForExplode();
		} else if (e.key === 's' || e.key === 'S') {
			setStructure(!state.structure);
		} else if (e.key >= '1' && e.key <= String(MACHINES.length)) {
			selectMachine(MACHINES[Number(e.key) - 1].spec.id);
		}
	});
}

/* ── loop ───────────────────────────────────────────────────────────── */

const timer = new THREE.Timer();
let frames = 0;
let fpsAt = performance.now();

function loop() {
	requestAnimationFrame(loop);
	timer.update();
	const dt = Math.min(timer.getDelta(), 0.05);

	if (state.playing) {
		state.angle += dt * state.speed * Math.PI * 2;
		current.update(state.angle);
	}

	if (Math.abs(state.explode - state.explodeTarget) > 0.0005) {
		state.explode += (state.explodeTarget - state.explode) * Math.min(1, dt * 7);
		applyExplode(current.root, state.explode);
	} else if (state.explode !== state.explodeTarget) {
		state.explode = state.explodeTarget;
		applyExplode(current.root, state.explode);
	} else if (state.playing) {
		applyExplode(current.root, state.explode);
	}

	if (tween) {
		tween.t = Math.min(1, tween.t + dt * 1.6);
		const k = 1 - (1 - tween.t) ** 3;
		camera.position.lerpVectors(tween.fromEye, tween.eye, k);
		controls.target.lerpVectors(tween.fromTarget, tween.target, k);
		if (tween.t >= 1) tween = null;
	}

	if (pickPending) {
		pickPending = false;
		pick();
	}

	controls.update();
	renderer.render(scene, camera);

	frames++;
	const now = performance.now();
	if (now - fpsAt > 500) {
		$('maStatFps').textContent = String(Math.round((frames * 1000) / (now - fpsAt)));
		frames = 0;
		fpsAt = now;
	}
}

/* ── boot ───────────────────────────────────────────────────────────── */

const start = readUrl();
state.machine = start.machine;
state.values = start.values;
renderTabs();
renderHeader();
renderParams();
wire();
build(start.machine.spec.id, start.values, { frame: 'first' });
setPlaying(true);
$('maSpeedOut').textContent = `${state.speed.toFixed(2)} rev/s`;
$('maStage').classList.add('is-ready');
track(ANALYTICS_EVENTS.SURFACE_OPENED, { surface: `visualizer:assembly:${start.machine.spec.id}` });
loop();
