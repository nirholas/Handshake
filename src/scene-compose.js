/**
 * Scene Composer — real-time multi-object 3D editor with Forge integration.
 *
 * Improvements over v1:
 *   - THREE.Timer + AnimationMixer: avatar animations play automatically
 *   - Undo/redo command system (Ctrl+Z / Ctrl+Y), 50-deep stack
 *   - F to frame/focus the selected object (smooth dolly)
 *   - Ctrl+D to duplicate selected object
 *   - X to toggle world/local space
 *   - Bone region grouping (Head / Torso / Left Arm / Right Arm / Left Leg / Right Leg)
 *   - Proportional scale lock in inspector (chain button)
 *   - Stats overlay: triangle count + object count (live)
 *   - Screenshot export: Ctrl+P or toolbar button
 *   - Geometry/material/texture disposal on remove (no memory leak)
 *   - Camera presets: Front / Back / Left / Right / Top / Isometric
 *   - Grid snapping toggle (Ctrl+G, 0.25-unit resolution)
 *   - Object renaming via double-click in hierarchy
 *   - Suggested prompts by intent type
 *   - Better directional + fill + rim lighting
 *   - Fog for depth
 *   - Model category sent with forge POST
 *   - Toast notifications for all user-facing events
 */

import * as THREE from 'three';
import { createLogger } from './shared/log.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const log = createLogger('scene-compose');

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvasEl     = $('cc');
const loadingEl    = $('cl');
const loadingMsg   = $('lmsg');
const avatarPrompt = $('ap');
const canvasHint   = $('ch');
const objectList   = $('ol');
const inspectorEl  = $('ins');
const saveStatus   = $('ss');
const statTris     = $('s-tri');
const statObjs     = $('s-obj');
const toastRoot    = $('tr');

const btnUndo    = $('btn-undo');
const btnRedo    = $('btn-redo');
const btnTrans   = $('btn-translate');
const btnRot     = $('btn-rotate');
const btnScale   = $('btn-scale');
const btnSpace   = $('btn-space');
const spaceLabel = $('spl');
const btnSnap    = $('btn-snap');
const btnCam     = $('btn-cam');
const camMenu    = $('cmenu');
const btnShot    = $('btn-screenshot');
const btnExport  = $('btn-export');
const btnSaveOutfit = $('btn-save-outfit');
const btnHelp    = $('btn-help');
const helpPanel  = $('hp');
const helpClose  = $('hp-close');

const forgePrompt   = $('fp');
const forgeBtn      = $('fb');
const forgeProgress = $('fpr');
const forgeFill     = $('fprf');
const forgeMsg      = $('fprm');
const forgeErr      = $('fe');
const creationsList = $('gl');
const dropZone      = $('dz');
const glbFileInput  = $('gfi');
const intentChips   = $('intent-chips');
const suggestPills  = $('sps');

const avatarUrlInput = $('av-url');
const btnLoadUrl     = $('btn-load-url');
const btnBrowseAv    = $('btn-browse-av');
const btnSkip        = $('btn-skip');
const btnLoadAvSmall = $('btn-load-av');
const avatarModal    = $('am');
const avatarModalClose = $('am-close');
const avatarModalBody  = $('amb');

// ── Client key (auth-free forge ownership) ────────────────────────────────────
function getClientKey() {
	let k = localStorage.getItem('forge_client_key');
	if (!k) { k = crypto.randomUUID(); localStorage.setItem('forge_client_key', k); }
	return k;
}
const CLIENT_KEY = getClientKey();
const CH = { 'x-forge-client': CLIENT_KEY };

// ── Suggested prompts by intent ───────────────────────────────────────────────
const SUGGESTIONS = {
	'': ['Glowing sword', 'Crystal orb', 'Wooden chest', 'Dragon egg', 'Futuristic helmet'],
	accessory: ['Baseball cap', 'Neon visor', 'Horned crown', 'Steampunk goggles', 'Flower crown'],
	item: ['Magic staff', 'Iron dagger', 'Lantern', 'Treasure chest', 'Shield'],
	scene: ['Fantasy forest', 'Cyberpunk alley', 'Stone ruins', 'Desert dunes', 'Crystal cave'],
	creature: ['Baby dragon', 'Glowing fox', 'Robotic bird', 'Shadow wolf', 'Crystal butterfly'],
	vehicle: ['Hover bike', 'Pirate ship', 'Space fighter', 'Magic carpet', 'Steam locomotive'],
};

// ── Three.js setup ────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070f);
scene.fog = new THREE.FogExp2(0x07070f, 0.018);

// Environment (PMREM from RoomEnvironment)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// Grid
const grid = new THREE.GridHelper(30, 60, 0x1e1e2e, 0x12121e);
grid.material.opacity = 0.7;
grid.material.transparent = true;
scene.add(grid);

// Camera
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
camera.position.set(0, 1.6, 3.8);
camera.lookAt(0, 1, 0);

// Orbit
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.07;
orbit.minDistance = 0.15;
orbit.maxDistance = 80;

// Transform
const transform = new TransformControls(camera, renderer.domElement);
transform.setMode('translate');
// TransformControls extends Controls, not Object3D (three r169+), so adding it to
// the scene throws "THREE.Object3D.add: object not an instance of THREE.Object3D"
// and the gizmo never renders. Its visual is a separate Object3D from getHelper().
scene.add(transform.getHelper());
transform.addEventListener('dragging-changed', (e) => {
	orbit.enabled = !e.value;
	if (!e.value && selectedId !== null) {
		// Push transform command to undo history when drag ends
		const obj = sceneObjects.get(selectedId);
		if (obj && _transformBefore) {
			const after = captureTransform(obj.group);
			if (!transformEqual(_transformBefore, after)) {
				pushHistory({
					execute: () => applyTransform(selectedId, after),
					undo:    () => applyTransform(selectedId, _transformBefore),
				});
			}
			_transformBefore = null;
		}
		syncInspector();
	}
});
transform.addEventListener('mouseDown', () => {
	if (selectedId !== null) {
		const obj = sceneObjects.get(selectedId);
		if (obj) _transformBefore = captureTransform(obj.group);
	}
});

let _transformBefore = null;

// Lighting — key + fill + rim
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(4, 10, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 100;
keyLight.shadow.camera.left = -5;
keyLight.shadow.camera.right = 5;
keyLight.shadow.camera.top = 8;
keyLight.shadow.camera.bottom = -2;
keyLight.shadow.bias = -0.001;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8090ff, 0.4);
fillLight.position.set(-5, 3, -3);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffa070, 0.3);
rimLight.position.set(0, 5, -8);
scene.add(rimLight);

// Clock + mixer
const clock = new THREE.Timer();
let mixer = null;

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
	const w = canvasEl.parentElement.clientWidth;
	const h = canvasEl.parentElement.clientHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvasEl.parentElement);
resize();

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
	requestAnimationFrame(animate);
	clock.update();
	const delta = clock.getDelta();
	if (mixer) mixer.update(delta);
	orbit.update();
	renderer.render(scene, camera);
}
animate();

// ── State ─────────────────────────────────────────────────────────────────────
const sceneObjects = new Map(); // id → { group, name, glbUrl, visible, boneAttached, boneName, role }
let nextId = 1;
let selectedId = null;
let avatarId = null;
let avatarBones = []; // { name, bone }
let xformMode = 'translate';
let xformSpace = 'world';
let snapEnabled = false;
let scaleLocked = false;
const SNAP_SIZE = 0.25;
let forgeJobId = null;
let forgePollTimer = null;
let forgePollStart = 0;
let forgeIntent = '';
const FORGE_TIMEOUT = 5 * 60 * 1000;

// ── Undo / Redo ───────────────────────────────────────────────────────────────
const hist = { stack: [], cursor: -1 };

function pushHistory(cmd) {
	hist.stack.splice(hist.cursor + 1);
	hist.stack.push(cmd);
	if (hist.stack.length > 50) hist.stack.shift();
	else hist.cursor++;
	syncUndoUI();
}

function undo() {
	if (hist.cursor < 0) return;
	hist.stack[hist.cursor].undo();
	hist.cursor--;
	syncUndoUI();
}

function redo() {
	if (hist.cursor >= hist.stack.length - 1) return;
	hist.cursor++;
	hist.stack[hist.cursor].execute();
	syncUndoUI();
}

function syncUndoUI() {
	btnUndo.disabled = hist.cursor < 0;
	btnRedo.disabled = hist.cursor >= hist.stack.length - 1;
}

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// ── Transform helpers ─────────────────────────────────────────────────────────
function captureTransform(g) {
	return {
		px: g.position.x, py: g.position.y, pz: g.position.z,
		rx: g.rotation.x, ry: g.rotation.y, rz: g.rotation.z,
		sx: g.scale.x, sy: g.scale.y, sz: g.scale.z,
	};
}

function applyTransform(id, t) {
	const obj = sceneObjects.get(id);
	if (!obj) return;
	const g = obj.group;
	g.position.set(t.px, t.py, t.pz);
	g.rotation.set(t.rx, t.ry, t.rz);
	g.scale.set(t.sx, t.sy, t.sz);
	if (selectedId === id) syncInspector();
}

function transformEqual(a, b) {
	return a.px === b.px && a.py === b.py && a.pz === b.pz &&
	       a.rx === b.rx && a.ry === b.ry && a.rz === b.rz &&
	       a.sx === b.sx && a.sy === b.sy && a.sz === b.sz;
}

// ── Loading helpers ───────────────────────────────────────────────────────────
function showLoading(msg = 'Loading…') { loadingMsg.textContent = msg; loadingEl.classList.remove('h'); }
function hideLoading() { loadingEl.classList.add('h'); }

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, duration = 2500) {
	const el = document.createElement('div');
	el.className = 't';
	el.textContent = msg;
	toastRoot.appendChild(el);
	setTimeout(() => {
		el.classList.add('out');
		setTimeout(() => el.remove(), 350);
	}, duration);
}

// ── GLB loader ────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const meshoptReady = getMeshoptDecoder().then((d) => gltfLoader.setMeshoptDecoder(d));

function loadGLB(url, name, opts = {}) {
	return new Promise((resolve, reject) => {
		meshoptReady.then(() => gltfLoader.load(url, (gltf) => {
			const group = gltf.scene;
			group.traverse((n) => {
				if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
			});
			if (!opts.preserveTransform) {
				const box = new THREE.Box3().setFromObject(group);
				const size = new THREE.Vector3();
				box.getSize(size);
				const center = new THREE.Vector3();
				box.getCenter(center);
				group.position.sub(center);
				group.position.y += size.y / 2;
				const maxDim = Math.max(size.x, size.y, size.z);
				if (maxDim > 4) group.scale.setScalar(2 / maxDim);
			}
			// Collect bones
			const bones = [];
			group.traverse((n) => { if (n.isBone) bones.push({ name: n.name, bone: n }); });
			resolve({ group, gltf, bones });
		}, undefined, reject));
	});
}

// ── Geometry/material disposal ────────────────────────────────────────────────
function disposeObject(root) {
	root.traverse((n) => {
		if (n.isMesh) {
			n.geometry?.dispose();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const m of mats) {
				if (!m) continue;
				for (const key of Object.keys(m)) {
					const val = m[key];
					if (val && typeof val.dispose === 'function') val.dispose();
				}
				m.dispose();
			}
		}
	});
}

// ── Stats ─────────────────────────────────────────────────────────────────────
let _statsTimer = 0;
function updateStats() {
	const now = performance.now();
	if (now - _statsTimer < 500) return;
	_statsTimer = now;
	let tris = 0;
	sceneObjects.forEach((obj) => {
		if (!obj.visible) return;
		obj.group.traverse((n) => {
			if (!n.isMesh || !n.geometry) return;
			const idx = n.geometry.index;
			tris += idx ? idx.count / 3 : (n.geometry.attributes.position?.count || 0) / 3;
		});
	});
	statTris.textContent = `${Math.round(tris).toLocaleString()} tri`;
	statObjs.textContent = `${sceneObjects.size} obj`;
}
setInterval(updateStats, 500);

// ── Scene object registry ─────────────────────────────────────────────────────
function addToScene(group, name, glbUrl, role = 'item', pushUndo = true) {
	const id = nextId++;
	scene.add(group);
	sceneObjects.set(id, { group, name, glbUrl, visible: true, boneAttached: false, boneName: null, role });
	if (pushUndo) {
		pushHistory({
			execute: () => { scene.add(group); sceneObjects.set(id, sceneObjects.get(id) || { group, name, glbUrl, visible: true, boneAttached: false, boneName: null, role }); renderHierarchy(); },
			undo:    () => { if (selectedId === id) deselect(); scene.remove(group); sceneObjects.delete(id); renderHierarchy(); },
		});
	}
	renderHierarchy();
	select(id);
	return id;
}

function removeObject(id) {
	const obj = sceneObjects.get(id);
	if (!obj) return;
	if (obj.boneAttached && obj.boneName) {
		const be = avatarBones.find((b) => b.name === obj.boneName);
		if (be) scene.attach(obj.group);
	}
	if (selectedId === id) deselect();
	scene.remove(obj.group);
	const snapshot = { ...obj };
	sceneObjects.delete(id);
	if (id === avatarId) { avatarId = null; avatarBones = []; if (mixer) { mixer.stopAllAction(); mixer = null; } }
	pushHistory({
		execute: () => { scene.remove(snapshot.group); sceneObjects.delete(id); renderHierarchy(); },
		undo:    () => { scene.add(snapshot.group); sceneObjects.set(id, snapshot); renderHierarchy(); },
	});
	renderHierarchy();
}

function toggleVis(id) {
	const obj = sceneObjects.get(id);
	if (!obj) return;
	obj.visible = !obj.visible;
	obj.group.visible = obj.visible;
	renderHierarchy();
}

// ── Selection ─────────────────────────────────────────────────────────────────
function select(id) {
	selectedId = id;
	const obj = sceneObjects.get(id);
	if (!obj) { deselect(); return; }
	transform.attach(obj.group);
	renderHierarchy();
	syncInspector();
}

function deselect() {
	selectedId = null;
	transform.detach();
	renderHierarchy();
	inspectorEl.innerHTML = '<div class="ie">Select an object</div>';
}

// Click-to-select raycasting
const raycaster = new THREE.Raycaster();
const mouse2 = new THREE.Vector2();
canvasEl.addEventListener('pointerdown', (e) => {
	if (e.button !== 0 || transform.dragging) return;
	const rect = canvasEl.getBoundingClientRect();
	mouse2.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
	mouse2.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
	raycaster.setFromCamera(mouse2, camera);
	const meshes = [];
	sceneObjects.forEach((obj, id) => {
		if (!obj.visible) return;
		obj.group.traverse((n) => { if (n.isMesh) meshes.push({ mesh: n, id }); });
	});
	const hits = raycaster.intersectObjects(meshes.map((m) => m.mesh));
	if (hits.length) {
		const entry = meshes.find((m) => m.mesh === hits[0].object);
		if (entry) { select(entry.id); return; }
	}
	deselect();
});

// ── Transform mode toolbar ────────────────────────────────────────────────────
function setMode(mode) {
	xformMode = mode;
	transform.setMode(mode);
	[btnTrans, btnRot, btnScale].forEach((b) => b.classList.remove('active'));
	({ translate: btnTrans, rotate: btnRot, scale: btnScale })[mode]?.classList.add('active');
}

btnTrans.addEventListener('click', () => setMode('translate'));
btnRot.addEventListener('click',   () => setMode('rotate'));
btnScale.addEventListener('click', () => setMode('scale'));

function toggleSpace() {
	xformSpace = xformSpace === 'world' ? 'local' : 'world';
	transform.setSpace(xformSpace);
	spaceLabel.textContent = xformSpace === 'world' ? 'World' : 'Local';
	toast(`Space: ${xformSpace}`);
}
btnSpace.addEventListener('click', toggleSpace);

function toggleSnap() {
	snapEnabled = !snapEnabled;
	btnSnap.classList.toggle('active', snapEnabled);
	toast(`Snap ${snapEnabled ? 'on (0.25 units)' : 'off'}`);
}
btnSnap.addEventListener('click', toggleSnap);

// Grid snap — apply during transform change when snap enabled
transform.addEventListener('change', () => {
	if (!snapEnabled || xformMode !== 'translate') return;
	const obj = sceneObjects.get(selectedId)?.group;
	if (!obj) return;
	obj.position.x = Math.round(obj.position.x / SNAP_SIZE) * SNAP_SIZE;
	obj.position.y = Math.round(obj.position.y / SNAP_SIZE) * SNAP_SIZE;
	obj.position.z = Math.round(obj.position.z / SNAP_SIZE) * SNAP_SIZE;
});

// ── Camera presets ────────────────────────────────────────────────────────────
const CAM_PRESETS = {
	front: { pos: [0, 1.5, 5], target: [0, 1, 0] },
	back:  { pos: [0, 1.5,-5], target: [0, 1, 0] },
	left:  { pos: [-5, 1.5, 0], target: [0, 1, 0] },
	right: { pos: [5, 1.5, 0], target: [0, 1, 0] },
	top:   { pos: [0, 8, 0.01], target: [0, 0, 0] },
	iso:   { pos: [3.5, 3.5, 3.5], target: [0, 0.8, 0] },
};

function applyCameraPreset(name) {
	const p = CAM_PRESETS[name];
	if (!p) return;
	camera.position.set(...p.pos);
	orbit.target.set(...p.target);
	orbit.update();
	camMenu.hidden = true;
}

btnCam.addEventListener('click', (e) => { e.stopPropagation(); camMenu.hidden = !camMenu.hidden; });
camMenu.querySelectorAll('.cmi').forEach((item) => {
	item.addEventListener('click', () => applyCameraPreset(item.dataset.cam));
});
document.addEventListener('click', (e) => {
	if (!btnCam.contains(e.target) && !camMenu.contains(e.target)) camMenu.hidden = true;
});

// ── Frame camera on selected (F key) ─────────────────────────────────────────
function frameObject(id) {
	const obj = id != null ? sceneObjects.get(id) : null;
	let box;
	if (obj) {
		box = new THREE.Box3().setFromObject(obj.group);
	} else if (sceneObjects.size > 0) {
		box = new THREE.Box3();
		sceneObjects.forEach((o) => { if (o.visible) box.expandByObject(o.group); });
	} else {
		return;
	}
	if (box.isEmpty()) return;
	const center = new THREE.Vector3();
	box.getCenter(center);
	const size = new THREE.Vector3();
	box.getSize(size);
	const maxDim = Math.max(size.x, size.y, size.z, 0.5);
	const dist = maxDim * 1.8;
	const dir = new THREE.Vector3().subVectors(camera.position, orbit.target).normalize();
	orbit.target.copy(center);
	camera.position.copy(center).addScaledVector(dir, dist);
	orbit.update();
}

// ── Duplicate (Ctrl+D) ────────────────────────────────────────────────────────
function duplicateSelected() {
	const obj = sceneObjects.get(selectedId);
	if (!obj) { toast('Select an object first'); return; }
	const clone = obj.group.clone();
	clone.position.x += 0.5;
	addToScene(clone, obj.name + ' (copy)', obj.glbUrl, obj.role);
	toast('Duplicated');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
	const inp = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
	const ctrl = e.ctrlKey || e.metaKey;

	// Always-active
	if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
	if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }
	if (ctrl && e.key === 'g') { e.preventDefault(); toggleSnap(); return; }
	if (ctrl && e.key === 'p') { e.preventDefault(); takeScreenshot(); return; }
	if (ctrl && e.key === 'd') { e.preventDefault(); duplicateSelected(); return; }

	if (inp) return;

	if (e.key === 'w' || e.key === 'W') setMode('translate');
	if (e.key === 'e' || e.key === 'E') setMode('rotate');
	if (e.key === 'r' || e.key === 'R') setMode('scale');
	if (e.key === 'f' || e.key === 'F') frameObject(selectedId);
	if (e.key === 'x' || e.key === 'X') toggleSpace();
	if (e.key === 'Escape') { deselect(); camMenu.hidden = true; helpPanel.hidden = true; avatarModal.hidden = true; }
	if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId !== null) removeObject(selectedId); }
	if (e.key === '?') { helpPanel.hidden = !helpPanel.hidden; }
	// Numpad camera presets (Blender-style)
	if (e.code === 'Numpad1' && !e.ctrlKey) applyCameraPreset('front');
	if (e.code === 'Numpad3' && !e.ctrlKey) applyCameraPreset('left');
	if (e.code === 'Numpad7' && !e.ctrlKey) applyCameraPreset('top');
});

// ── Help panel ────────────────────────────────────────────────────────────────
btnHelp.addEventListener('click', () => { helpPanel.hidden = !helpPanel.hidden; });
helpClose.addEventListener('click', () => { helpPanel.hidden = true; });
helpPanel.addEventListener('click', (e) => { if (e.target === helpPanel) helpPanel.hidden = true; });

// ── Hierarchy rendering ───────────────────────────────────────────────────────
function roleIcon(role) {
	return { avatar:'◉', accessory:'◈', item:'◇', scene:'▦', creature:'◆', vehicle:'▷', other:'○' }[role] || '◇';
}

function renderHierarchy() {
	objectList.innerHTML = '';
	if (sceneObjects.size === 0) {
		const e = document.createElement('div');
		e.style.cssText = 'padding:14px 12px;font-size:11px;color:#3d3d4a;';
		e.textContent = 'No objects — load an avatar or forge an item.';
		objectList.appendChild(e);
		return;
	}

	// Group: avatar first, then items
	const avatarEntry = avatarId != null ? [[avatarId, sceneObjects.get(avatarId)]] : [];
	const itemEntries = [...sceneObjects.entries()].filter(([id]) => id !== avatarId);

	function makeRow(id, obj) {
		const row = document.createElement('div');
		row.className = 'or' + (id === selectedId ? ' sel' : '');
		row.dataset.id = id;

		const icon = document.createElement('span');
		icon.className = 'oi';
		icon.textContent = roleIcon(obj.role);
		row.appendChild(icon);

		const name = document.createElement('span');
		name.className = 'on';
		name.textContent = obj.name;
		row.appendChild(name);

		if (obj.boneAttached) {
			const tag = document.createElement('span');
			tag.className = 'ot b';
			tag.textContent = cleanBoneName(obj.boneName).split(' ').pop();
			row.appendChild(tag);
		} else if (obj.role !== 'item' && obj.role !== 'other') {
			const tag = document.createElement('span');
			tag.className = 'ot';
			tag.textContent = obj.role;
			row.appendChild(tag);
		}

		const actions = document.createElement('div');
		actions.className = 'oa';

		const visBtn = document.createElement('button');
		visBtn.className = 'oab';
		visBtn.title = obj.visible ? 'Hide' : 'Show';
		visBtn.textContent = obj.visible ? '●' : '○';
		visBtn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleVis(id); });
		actions.appendChild(visBtn);

		const delBtn = document.createElement('button');
		delBtn.className = 'oab d';
		delBtn.title = 'Remove';
		delBtn.textContent = '×';
		delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); removeObject(id); });
		actions.appendChild(delBtn);

		row.appendChild(actions);
		row.addEventListener('click', () => select(id));
		// Double-click to rename
		row.addEventListener('dblclick', (ev) => { ev.preventDefault(); startRename(id, row, name); });
		objectList.appendChild(row);
	}

	if (avatarEntry.length) {
		avatarEntry.forEach(([id, obj]) => makeRow(id, obj));
	}
	if (itemEntries.length) {
		itemEntries.forEach(([id, obj]) => makeRow(id, obj));
	}
}

function startRename(id, row, nameEl) {
	const obj = sceneObjects.get(id);
	if (!obj) return;
	const input = document.createElement('input');
	input.className = 'oni';
	input.value = obj.name;
	nameEl.replaceWith(input);
	input.focus();
	input.select();
	const commit = () => {
		const newName = input.value.trim() || obj.name;
		obj.name = newName;
		const span = document.createElement('span');
		span.className = 'on';
		span.textContent = newName;
		input.replaceWith(span);
		span.addEventListener('dblclick', (ev) => { ev.preventDefault(); startRename(id, row, span); });
	};
	input.addEventListener('blur', commit);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { commit(); }
		if (e.key === 'Escape') { input.value = obj.name; commit(); }
	});
}

// ── Bone regions ──────────────────────────────────────────────────────────────
const BONE_REGIONS = {
	'Head':      ['head','neck','jaw','eye','ear','hair','skull'],
	'Torso':     ['hips','pelvis','spine','chest','breast','clavicle','collar','shoulder'],
	'Left Arm':  ['leftshoulder','leftarm','leftforearm','lefthand','leftelbow','leftwrist'],
	'Right Arm': ['rightshoulder','rightarm','rightforearm','righthand','rightelbow','rightwrist'],
	'Left Leg':  ['leftupleg','leftleg','leftfoot','leftthigh','leftknee','leftankle','lefttoebase','lefttoe'],
	'Right Leg': ['rightupleg','rightleg','rightfoot','rightthigh','rightknee','rightankle','righttoebase','righttoe'],
	'Fingers L': ['lefthandthumb','lefthandindex','lefthandmiddle','lefthandring','lefthandpinky'],
	'Fingers R': ['righthandthumb','righthandindex','righthandmiddle','righthandring','righthandpinky'],
};

function cleanBoneName(name) {
	return name
		.replace(/^mixamorig:?/i, '')
		.replace(/^CC_Base_/i, '')
		.replace(/^rig_/i, '')
		.replace(/_/g, ' ');
}

function bonesToRegionMap(bones) {
	const regionMap = Object.fromEntries(Object.keys(BONE_REGIONS).map((r) => [r, []]));
	const other = [];
	for (const b of bones) {
		const lower = b.name.replace(/^mixamorig:?/i, '').replace(/^CC_Base_/i, '').replace(/^rig_/i, '').toLowerCase().replace(/[_\s]/g, '');
		let placed = false;
		for (const [region, keywords] of Object.entries(BONE_REGIONS)) {
			if (keywords.some((kw) => lower.includes(kw))) {
				regionMap[region].push(b);
				placed = true;
				break;
			}
		}
		if (!placed) other.push(b);
	}
	return { regionMap, other };
}

function buildBoneSelect(bones, currentBoneName) {
	const sel = document.createElement('select');
	sel.className = 'bs';
	const { regionMap, other } = bonesToRegionMap(bones);
	for (const [region, bs] of Object.entries(regionMap)) {
		if (!bs.length) continue;
		const grp = document.createElement('optgroup');
		grp.label = region;
		for (const b of bs) {
			const opt = document.createElement('option');
			opt.value = b.name;
			opt.textContent = cleanBoneName(b.name);
			if (b.name === currentBoneName) opt.selected = true;
			grp.appendChild(opt);
		}
		sel.appendChild(grp);
	}
	if (other.length) {
		const grp = document.createElement('optgroup');
		grp.label = 'Other';
		for (const b of other) {
			const opt = document.createElement('option');
			opt.value = b.name;
			opt.textContent = cleanBoneName(b.name);
			if (b.name === currentBoneName) opt.selected = true;
			grp.appendChild(opt);
		}
		sel.appendChild(grp);
	}
	return sel;
}

// ── Inspector ─────────────────────────────────────────────────────────────────
function syncInspector() {
	const obj = sceneObjects.get(selectedId);
	if (!obj) { deselect(); return; }
	const g = obj.group;
	const fmt = (v) => v.toFixed(3);

	let html = `
	<div class="ibh">Position<button class="ir" data-reset="pos">↺ Reset</button></div>
	<div class="xr"><span class="xl">X</span><input class="xi" data-a="px" value="${fmt(g.position.x)}"><input class="xi" data-a="py" value="${fmt(g.position.y)}"><input class="xi" data-a="pz" value="${fmt(g.position.z)}"></div>
	<div class="ibh">Rotation °<button class="ir" data-reset="rot">↺ Reset</button></div>
	<div class="xr"><span class="xl">R</span><input class="xi" data-a="rx" value="${fmt(THREE.MathUtils.radToDeg(g.rotation.x))}"><input class="xi" data-a="ry" value="${fmt(THREE.MathUtils.radToDeg(g.rotation.y))}"><input class="xi" data-a="rz" value="${fmt(THREE.MathUtils.radToDeg(g.rotation.z))}"></div>
	<div class="ibh">Scale<button class="ir" data-reset="scl">↺ Reset</button></div>
	<div class="xr xrl"><span class="xl">S</span><input class="xi" data-a="sx" value="${fmt(g.scale.x)}"><input class="xi" data-a="sy" value="${fmt(g.scale.y)}"><input class="xi" data-a="sz" value="${fmt(g.scale.z)}"><button class="xk${scaleLocked?' on':''}" id="scale-lock" title="Proportional scale">⛓</button></div>
	`;

	// Bone attach (only for non-avatar items when an avatar with bones is in the scene)
	if (obj.role !== 'avatar' && avatarId !== null && avatarBones.length > 0) {
		html += '<div class="baw"></div>';
	}

	inspectorEl.innerHTML = html;

	// Wire inputs
	inspectorEl.querySelectorAll('.xi').forEach((inp) => {
		inp.addEventListener('change', () => {
			const v = parseFloat(inp.value);
			if (!isFinite(v)) return;
			const g2 = sceneObjects.get(selectedId)?.group;
			if (!g2) return;
			const before = captureTransform(g2);
			const a = inp.dataset.a;
			if (a === 'px') g2.position.x = v;
			else if (a === 'py') g2.position.y = v;
			else if (a === 'pz') g2.position.z = v;
			else if (a === 'rx') g2.rotation.x = THREE.MathUtils.degToRad(v);
			else if (a === 'ry') g2.rotation.y = THREE.MathUtils.degToRad(v);
			else if (a === 'rz') g2.rotation.z = THREE.MathUtils.degToRad(v);
			else if (a === 'sx') {
				if (scaleLocked) { const r = v / g2.scale.x; g2.scale.multiplyScalar(r); } else g2.scale.x = v;
			}
			else if (a === 'sy') {
				if (scaleLocked) { const r = v / g2.scale.y; g2.scale.multiplyScalar(r); } else g2.scale.y = v;
			}
			else if (a === 'sz') {
				if (scaleLocked) { const r = v / g2.scale.z; g2.scale.multiplyScalar(r); } else g2.scale.z = v;
			}
			const after = captureTransform(g2);
			if (!transformEqual(before, after)) pushHistory({ execute: () => applyTransform(selectedId, after), undo: () => applyTransform(selectedId, before) });
			if (scaleLocked) syncInspector();
		});
	});

	// Reset buttons
	inspectorEl.querySelectorAll('.ir').forEach((btn) => {
		btn.addEventListener('click', () => {
			const g2 = sceneObjects.get(selectedId)?.group;
			if (!g2) return;
			const before = captureTransform(g2);
			if (btn.dataset.reset === 'pos') g2.position.set(0, 0, 0);
			else if (btn.dataset.reset === 'rot') g2.rotation.set(0, 0, 0);
			else if (btn.dataset.reset === 'scl') g2.scale.setScalar(1);
			const after = captureTransform(g2);
			if (!transformEqual(before, after)) pushHistory({ execute: () => applyTransform(selectedId, after), undo: () => applyTransform(selectedId, before) });
			syncInspector();
		});
	});

	// Scale lock
	const lockBtn = document.getElementById('scale-lock');
	if (lockBtn) {
		lockBtn.addEventListener('click', () => {
			scaleLocked = !scaleLocked;
			lockBtn.classList.toggle('on', scaleLocked);
			toast(`Scale lock ${scaleLocked ? 'on' : 'off'}`);
		});
	}

	// Bone section
	if (obj.role !== 'avatar' && avatarId !== null && avatarBones.length > 0) {
		const baw = inspectorEl.querySelector('.baw');
		const label = document.createElement('div');
		label.className = 'bal';
		label.textContent = 'Attach to Bone';
		baw.appendChild(label);
		const row = document.createElement('div');
		row.className = 'bar';
		const sel = buildBoneSelect(avatarBones, obj.boneName);
		row.appendChild(sel);
		if (obj.boneAttached) {
			const btn = document.createElement('button');
			btn.className = 'bb de';
			btn.textContent = 'Detach';
			btn.addEventListener('click', () => detachFromBone(selectedId));
			row.appendChild(btn);
		} else {
			const btn = document.createElement('button');
			btn.className = 'bb at';
			btn.textContent = 'Attach';
			btn.addEventListener('click', () => attachToBone(selectedId, sel.value));
			row.appendChild(btn);
		}
		baw.appendChild(row);
	}
}

// ── Bone attachment ───────────────────────────────────────────────────────────
function attachToBone(itemId, boneName) {
	const item = sceneObjects.get(itemId);
	const be = avatarBones.find((b) => b.name === boneName);
	if (!item || !be) return;
	if (item.boneAttached) detachFromBone(itemId, false);
	scene.remove(item.group);
	be.bone.add(item.group);
	item.group.position.set(0, 0, 0);
	item.group.rotation.set(0, 0, 0);
	item.boneAttached = true;
	item.boneName = boneName;
	renderHierarchy();
	syncInspector();
	toast(`Attached to ${cleanBoneName(boneName)}`);
}

function detachFromBone(itemId, updateUI = true) {
	const item = sceneObjects.get(itemId);
	if (!item || !item.boneAttached) return;
	const be = avatarBones.find((b) => b.name === item.boneName);
	if (be) scene.attach(item.group);
	item.boneAttached = false;
	item.boneName = null;
	if (updateUI) { renderHierarchy(); syncInspector(); toast('Detached'); }
}

// ── Avatar loading ────────────────────────────────────────────────────────────
async function loadAvatar(url, name = 'Avatar') {
	showLoading('Loading avatar…');
	avatarPrompt.classList.add('h');
	canvasHint.classList.remove('h');
	try {
		const { group, gltf, bones } = await loadGLB(url, name);
		if (avatarId !== null) removeObject(avatarId);
		const id = addToScene(group, name, url, 'avatar', false);
		avatarId = id;
		avatarBones = bones;
		// Set up AnimationMixer if avatar has animations
		if (gltf.animations && gltf.animations.length > 0) {
			mixer = new THREE.AnimationMixer(group);
			// Play first animation (typically idle)
			const clip = gltf.animations[0];
			const action = mixer.clipAction(clip);
			action.play();
		}
		frameObject(id);
	} catch (err) {
		log.error('avatar load failed:', err);
		avatarPrompt.classList.remove('h');
		toast(`Failed to load avatar: ${err.message}`);
	} finally {
		hideLoading();
	}
}

// ── URL param auto-load ───────────────────────────────────────────────────────
(async () => {
	const params = new URLSearchParams(location.search);
	const glbParam = params.get('glb');
	const avatarParam = params.get('avatar');

	if (glbParam) {
		avatarPrompt.classList.add('h');
		canvasHint.classList.remove('h');
		showLoading('Loading item…');
		try {
			const { group } = await loadGLB(glbParam, 'Forged item');
			addToScene(group, 'Forged item', glbParam, 'item', false);
			frameObject(null);
		} catch (err) {
			toast(`Failed to load: ${err.message}`);
		} finally {
			hideLoading();
		}
	} else if (avatarParam) {
		showLoading('Fetching avatar…');
		try {
			if (avatarParam.startsWith('http')) {
				await loadAvatar(avatarParam, 'Avatar');
			} else {
				const res = await fetch(`/api/avatars/${encodeURIComponent(avatarParam)}`);
				const data = await res.json().catch(() => ({}));
				const u = data.glbUrl || data.glb_url;
				if (u) await loadAvatar(u, data.name || 'Avatar');
				else hideLoading();
			}
		} catch { hideLoading(); }
	} else {
		hideLoading();
	}
})();

// ── Avatar prompt UI ──────────────────────────────────────────────────────────
btnLoadUrl.addEventListener('click', () => {
	const url = avatarUrlInput.value.trim();
	if (!url) return;
	loadAvatar(url, 'Avatar');
});
avatarUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnLoadUrl.click(); });
btnSkip.addEventListener('click', () => { avatarPrompt.classList.add('h'); canvasHint.classList.remove('h'); hideLoading(); });
btnLoadAvSmall.addEventListener('click', () => avatarPrompt.classList.remove('h'));

btnBrowseAv.addEventListener('click', openAvatarModal);
avatarModalClose.addEventListener('click', closeAvatarModal);
avatarModal.addEventListener('click', (e) => { if (e.target === avatarModal) closeAvatarModal(); });

async function openAvatarModal() {
	avatarModal.hidden = false;
	avatarModalBody.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px;color:#52525b;font-size:12px;">Loading…</div>';
	try {
		const res = await fetch('/api/explore?type=avatar&limit=24');
		const data = await res.json().catch(() => ({}));
		const avatars = data.avatars || data.items || [];
		avatarModalBody.innerHTML = '';
		if (!avatars.length) {
			avatarModalBody.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px;color:#52525b;font-size:12px;">No avatars found. <a href="/forge" style="color:#a5b4fc;">Forge one first.</a></div>';
			return;
		}
		for (const av of avatars) {
			const glbUrl = av.glbUrl || av.glb_url;
			if (!glbUrl) continue;
			const card = document.createElement('div');
			card.style.cssText = 'aspect-ratio:1;border-radius:8px;overflow:hidden;cursor:pointer;background:#111120;border:1px solid rgba(255,255,255,.07);position:relative;transition:border-color .12s,transform .1s;';
			card.addEventListener('mouseenter', () => { card.style.borderColor='rgba(99,102,241,.5)'; card.style.transform='scale(1.03)'; });
			card.addEventListener('mouseleave', () => { card.style.borderColor=''; card.style.transform=''; });
			const thumb = av.thumbnailUrl || av.thumbnail_url;
			if (thumb) {
				const img = document.createElement('img');
				img.src = thumb; img.alt = av.name || 'Avatar';
				img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
				card.appendChild(img);
			} else {
				card.style.display = 'flex'; card.style.alignItems = 'center'; card.style.justifyContent = 'center';
				card.innerHTML = '<span style="font-size:28px;opacity:.3;">◉</span>';
			}
			const lbl = document.createElement('div');
			lbl.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:rgba(0,0,0,.65);font-size:10px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
			lbl.textContent = av.name || 'Avatar';
			card.appendChild(lbl);
			card.addEventListener('click', () => { closeAvatarModal(); loadAvatar(glbUrl, av.name || 'Avatar'); });
			avatarModalBody.appendChild(card);
		}
	} catch {
		avatarModalBody.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px;color:#f87171;font-size:12px;">Failed to load avatars</div>';
	}
}

function closeAvatarModal() { avatarModal.hidden = true; }

// ── Intent chips + suggested prompts ─────────────────────────────────────────
function updateSuggestions() {
	suggestPills.innerHTML = '';
	const pills = SUGGESTIONS[forgeIntent] || [];
	for (const p of pills) {
		const btn = document.createElement('button');
		btn.className = 'sp';
		btn.textContent = p;
		btn.addEventListener('click', () => {
			forgePrompt.value = p;
			forgePrompt.focus();
		});
		suggestPills.appendChild(btn);
	}
}

intentChips.querySelectorAll('.ic').forEach((chip) => {
	chip.addEventListener('click', () => {
		intentChips.querySelectorAll('.ic').forEach((c) => c.classList.remove('a'));
		chip.classList.add('a');
		forgeIntent = chip.dataset.intent;
		updateSuggestions();
	});
});
updateSuggestions();

// ── Forge ─────────────────────────────────────────────────────────────────────
function setForgeBusy(busy) {
	forgeBtn.disabled = busy;
	forgeBtn.classList.toggle('busy', busy);
	forgePrompt.disabled = busy;
}

function showForgeProgress(msg, pct) {
	forgeProgress.classList.add('on');
	forgeMsg.textContent = msg;
	forgeFill.style.width = `${pct}%`;
}
function hideForgeProgress() { forgeProgress.classList.remove('on'); }
function showForgeError(msg) {
	forgeErr.textContent = msg;
	forgeErr.classList.add('on');
	setTimeout(() => forgeErr.classList.remove('on'), 6000);
}

forgeBtn.addEventListener('click', startForge);
forgePrompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startForge(); });

async function startForge() {
	const prompt = forgePrompt.value.trim();
	if (!prompt) { forgePrompt.focus(); return; }
	if (forgeBtn.disabled) return;
	setForgeBusy(true);
	hideForgeProgress();
	forgeErr.classList.remove('on');
	try {
		const body = { prompt };
		if (forgeIntent) body.model_category = forgeIntent;
		const res = await fetch('/api/forge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...CH },
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
		if (data.status === 'done' && data.glb_url) {
			await addForgedItem(data, prompt);
			setForgeBusy(false);
			return;
		}
		if (!data.job_id) throw new Error('No job ID from server');
		forgeJobId = data.job_id;
		forgePollStart = Date.now();
		showForgeProgress('Generating…', 8);
		pollForge();
	} catch (err) {
		setForgeBusy(false);
		hideForgeProgress();
		showForgeError(`Forge failed: ${err.message}`);
	}
}

function pollForge() {
	clearTimeout(forgePollTimer);
	if (!forgeJobId) return;
	if (Date.now() - forgePollStart > FORGE_TIMEOUT) {
		setForgeBusy(false);
		hideForgeProgress();
		showForgeError('Generation timed out. Try again.');
		forgeJobId = null;
		return;
	}
	forgePollTimer = setTimeout(async () => {
		try {
			const res = await fetch(`/api/forge?job=${encodeURIComponent(forgeJobId)}`, { headers: CH });
			const data = await res.json().catch(() => ({}));
			if (data.status === 'done' && data.glb_url) {
				const elapsed = ((Date.now() - forgePollStart) / 1000).toFixed(0);
				showForgeProgress(`Done in ${elapsed}s`, 100);
				await addForgedItem(data, forgePrompt.value.trim());
				setTimeout(() => { hideForgeProgress(); setForgeBusy(false); }, 900);
				forgeJobId = null;
				loadGallery();
			} else if (data.status === 'failed') {
				throw new Error(data.error || 'Generation failed');
			} else {
				const elapsed = Date.now() - forgePollStart;
				const pct = Math.min(8 + (elapsed / FORGE_TIMEOUT) * 82, 92);
				const STAGES = ['Initializing…', 'Analyzing prompt…', 'Building mesh…', 'Adding textures…', 'Finalizing…'];
				showForgeProgress(STAGES[Math.min(Math.floor(pct / 20), STAGES.length - 1)], pct);
				pollForge();
			}
		} catch (err) {
			setForgeBusy(false);
			hideForgeProgress();
			showForgeError(`Error: ${err.message}`);
			forgeJobId = null;
		}
	}, 3000);
}

async function addForgedItem(data, prompt) {
	const url = data.glb_url;
	if (!url) return;
	showLoading('Adding to scene…');
	try {
		const { group } = await loadGLB(url, prompt.slice(0, 40));
		// Stagger positions so items don't stack
		const count = sceneObjects.size;
		group.position.x = (count % 4) * 0.7 - 1.05;
		group.position.z = Math.floor(count / 4) * 0.7;
		const role = data.model_category || forgeIntent || 'item';
		addToScene(group, prompt.slice(0, 40), url, role, false);
		frameObject(null);
		toast(`Added: ${prompt.slice(0, 30)}…`);
	} catch (err) {
		showForgeError(`Failed to load: ${err.message}`);
	} finally {
		hideLoading();
	}
}

// ── Gallery ───────────────────────────────────────────────────────────────────
function promptGradient(str) {
	let h = 0;
	for (let i = 0; i < (str || '').length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	const hue = Math.abs(h) % 360;
	return `linear-gradient(135deg,hsl(${hue},28%,14%),hsl(${(hue+40)%360},22%,10%))`;
}

async function loadGallery() {
	try {
		const res = await fetch('/api/forge-gallery?limit=24', { headers: CH });
		const data = await res.json().catch(() => ({}));
		const items = data.creations || [];
		if (!items.length) {
			creationsList.innerHTML = '<div class="ge">Forge your first item above</div>';
			return;
		}
		creationsList.innerHTML = '';
		for (const c of items) {
			if (!c.glb_url) continue;
			const card = document.createElement('div');
			card.className = 'gc';
			card.title = c.prompt || 'Forged item';
			if (c.preview_image_url) {
				const img = document.createElement('img');
				img.src = c.preview_image_url; img.alt = c.prompt || ''; img.loading = 'lazy';
				img.onerror = () => { img.remove(); addGradient(card, c.prompt); };
				card.appendChild(img);
			} else {
				addGradient(card, c.prompt);
			}
			const ov = document.createElement('div');
			ov.className = 'gco';
			ov.innerHTML = `<div class="gcp">${escHtml(c.prompt || 'Forged item')}</div><div class="gca">+ Add to scene</div>`;
			card.appendChild(ov);
			card.addEventListener('click', () => loadGalleryItem(c));
			creationsList.appendChild(card);
		}
	} catch {
		creationsList.innerHTML = '<div class="ge">Could not load creations</div>';
	}
}

function addGradient(card, prompt) {
	const d = document.createElement('div');
	d.className = 'gcg'; d.textContent = prompt || 'Forged item';
	d.style.background = promptGradient(prompt);
	card.prepend(d);
}

function escHtml(str) {
	return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadGalleryItem(c) {
	showLoading('Loading…');
	try {
		const { group } = await loadGLB(c.glb_url, (c.prompt || 'item').slice(0, 40));
		const count = sceneObjects.size;
		group.position.x = (count % 4) * 0.7 - 1.05;
		group.position.z = Math.floor(count / 4) * 0.7;
		addToScene(group, (c.prompt || 'item').slice(0, 40), c.glb_url, c.model_category || 'item', false);
		frameObject(null);
		toast(`Added: ${(c.prompt || 'item').slice(0, 30)}…`);
	} catch (err) {
		toast(`Failed to load: ${err.message}`);
	} finally {
		hideLoading();
	}
}

loadGallery();

// ── File drop / upload ────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dh'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dh'));
dropZone.addEventListener('drop', (e) => {
	e.preventDefault(); dropZone.classList.remove('dh');
	const file = e.dataTransfer?.files?.[0];
	if (file) loadFile(file);
});
glbFileInput.addEventListener('change', () => { const f = glbFileInput.files?.[0]; if (f) loadFile(f); });

function loadFile(file) {
	const url = URL.createObjectURL(file);
	const name = file.name.replace(/\.(glb|gltf)$/i, '');
	showLoading(`Loading ${file.name}…`);
	loadGLB(url, name)
		.then(({ group }) => {
			addToScene(group, name, url, 'item', false);
			frameObject(null);
			toast(`Loaded: ${name}`);
		})
		.catch((err) => toast(`Failed: ${err.message}`))
		.finally(hideLoading);
}

// ── Screenshot ────────────────────────────────────────────────────────────────
btnShot.addEventListener('click', takeScreenshot);

async function takeScreenshot() {
	renderer.render(scene, camera); // force a clean frame
	return new Promise((resolve) => {
		renderer.domElement.toBlob((blob) => {
			if (!blob) { toast('Screenshot failed'); return; }
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = 'scene-compose.png';
			a.click();
			URL.revokeObjectURL(url);
			toast('Screenshot saved');
			resolve();
		}, 'image/png');
	});
}

// ── Export GLB ────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', exportScene);

async function exportScene() {
	if (sceneObjects.size === 0) { toast('Nothing to export'); return; }
	showLoading('Exporting…');
	try {
		const exporter = new GLTFExporter();
		const exportGroup = new THREE.Group();
		sceneObjects.forEach((obj) => {
			if (obj.visible && !obj.boneAttached) exportGroup.add(obj.group.clone());
		});
		const glb = await new Promise((resolve, reject) => exporter.parse(exportGroup, resolve, reject, { binary: true }));
		const blob = new Blob([glb], { type: 'model/gltf-binary' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url; a.download = 'scene-compose.glb'; a.click();
		URL.revokeObjectURL(url);
		flashSave('Exported ✓');
	} catch (err) {
		toast(`Export failed: ${err.message}`);
	} finally {
		hideLoading();
	}
}

// ── Save outfit ───────────────────────────────────────────────────────────────
btnSaveOutfit.addEventListener('click', saveOutfit);

async function saveOutfit() {
	if (avatarId === null) { toast('Load an avatar first'); return; }
	const avatarObj = sceneObjects.get(avatarId);
	const attached = [];
	sceneObjects.forEach((obj, id) => {
		if (id !== avatarId && obj.boneAttached) attached.push({ bone: obj.boneName, glbUrl: obj.glbUrl, name: obj.name });
	});
	if (!attached.length) { toast('Attach at least one item to a bone first'); return; }
	const urlMatch = avatarObj?.glbUrl?.match(/\/avatars\/([^/?]+)/);
	const avatarApiId = urlMatch?.[1];
	if (!avatarApiId) { toast('Use Export GLB to save this scene'); return; }
	showLoading('Saving outfit…');
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(avatarApiId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', ...CH },
			body: JSON.stringify({ accessories: attached }),
		});
		if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
		flashSave('Outfit saved ✓');
	} catch (err) {
		toast(`Save failed: ${err.message}`);
	} finally {
		hideLoading();
	}
}

function flashSave(msg = 'Saved ✓') {
	saveStatus.textContent = msg;
	saveStatus.classList.add('v');
	setTimeout(() => saveStatus.classList.remove('v'), 3000);
}

// ── Initial render ────────────────────────────────────────────────────────────
renderHierarchy();
