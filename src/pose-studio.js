// /pose — the three.ws Animation Studio. A Three.js scene with a posable rig
// (the built-in primitive mannequin OR a loaded rigged GLB avatar — including
// the user's own three.ws avatars), orbit camera, ground + grid, and a control
// panel for posing (FK gizmos + sliders and drag-IK), presets, lighting, props,
// and PNG export. Task 2 layers a keyframe timeline on top of this foundation.

import {
	AmbientLight,
	Box3,
	BoxGeometry,
	CircleGeometry,
	Color,
	CylinderGeometry,
	DirectionalLight,
	GridHelper,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PCFSoftShadowMap,
	PerspectiveCamera,
	Plane,
	Quaternion,
	Raycaster,
	Scene,
	ShadowMaterial,
	SphereGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { getDecoders } from './viewer/internal.js';
import {
	CANONICAL_LABELS,
	MannequinRig,
	makeGltfRig,
	poseFromMannequinPreset,
} from './pose-rig.js';
import { PRESETS, getPresetsByGroup, getPresetById } from './pose-presets.js';
import { AvatarGalleryPicker } from './avatar-gallery-picker.js';

// ─── DOM helpers ────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) node.setAttribute(k, v);
	}
	for (const child of children) {
		if (child == null) continue;
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
};

// ─── Floor props ────────────────────────────────────────────────────────
const FLOOR_PROPS = {
	none: { label: 'None', build: null },
	chair: {
		label: 'Chair',
		build: () => {
			const g = new Group();
			const wood = new MeshStandardMaterial({ color: '#8b6f47', roughness: 0.8 });
			const seat = new Mesh(new BoxGeometry(0.46, 0.05, 0.46), wood);
			seat.position.y = 0.45;
			seat.castShadow = true;
			seat.receiveShadow = true;
			g.add(seat);
			const legGeom = new BoxGeometry(0.05, 0.45, 0.05);
			for (const [x, z] of [[+0.19, +0.19], [+0.19, -0.19], [-0.19, +0.19], [-0.19, -0.19]]) {
				const leg = new Mesh(legGeom, wood);
				leg.position.set(x, 0.225, z);
				leg.castShadow = true;
				leg.receiveShadow = true;
				g.add(leg);
			}
			const back = new Mesh(new BoxGeometry(0.46, 0.55, 0.04), wood);
			back.position.set(0, 0.75, -0.22);
			back.castShadow = true;
			back.receiveShadow = true;
			g.add(back);
			return g;
		},
	},
	stool: {
		label: 'Stool',
		build: () => {
			const g = new Group();
			const mat = new MeshStandardMaterial({ color: '#3f3f46', roughness: 0.6 });
			const top = new Mesh(new CylinderGeometry(0.22, 0.22, 0.05, 24), mat);
			top.position.y = 0.45;
			top.castShadow = true;
			top.receiveShadow = true;
			g.add(top);
			const post = new Mesh(new CylinderGeometry(0.04, 0.04, 0.42, 14), mat);
			post.position.y = 0.21;
			post.castShadow = true;
			g.add(post);
			const base = new Mesh(new CylinderGeometry(0.18, 0.20, 0.03, 24), mat);
			base.position.y = 0.015;
			base.receiveShadow = true;
			g.add(base);
			return g;
		},
	},
	cube: {
		label: 'Cube',
		build: () => {
			const g = new Group();
			const mat = new MeshStandardMaterial({ color: '#ef4444', roughness: 0.7 });
			const box = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), mat);
			box.position.y = 0.25;
			box.castShadow = true;
			box.receiveShadow = true;
			g.add(box);
			return g;
		},
	},
	ball: {
		label: 'Ball',
		build: () => {
			const g = new Group();
			const mat = new MeshStandardMaterial({ color: '#facc15', roughness: 0.5 });
			const ball = new Mesh(new SphereGeometry(0.18, 24, 16), mat);
			ball.position.y = 0.18;
			ball.castShadow = true;
			ball.receiveShadow = true;
			g.add(ball);
			return g;
		},
	},
	plinth: {
		label: 'Plinth',
		build: () => {
			const g = new Group();
			const mat = new MeshStandardMaterial({ color: '#a8a29e', roughness: 0.85 });
			const box = new Mesh(new BoxGeometry(0.7, 0.8, 0.7), mat);
			box.position.y = 0.4;
			box.castShadow = true;
			box.receiveShadow = true;
			g.add(box);
			return g;
		},
	},
};

// Shared IK target-handle assets (cloned per handle for per-instance opacity).
const handleGeom = new SphereGeometry(0.045, 16, 12);
const handleMat = new MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.9, depthTest: false });

// ─── Scene setup ────────────────────────────────────────────────────────
function setupScene(canvas, hudStatus) {
	const scene = new Scene();
	scene.background = new Color('#0b0b10');

	const camera = new PerspectiveCamera(45, 1, 0.05, 100);
	camera.position.set(2.2, 1.65, 3.0);

	const renderer = new WebGLRenderer({
		canvas,
		antialias: true,
		preserveDrawingBuffer: true, // needed for toDataURL screenshots / thumbnails
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFSoftShadowMap;

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 0.6;
	controls.maxDistance = 12;
	controls.maxPolarAngle = Math.PI * 0.96;
	controls.target.set(0, 0.95, 0);

	// Rotation gizmo for the selected bone (FK posing). Newer three exposes the
	// visual via getHelper(); the control instance carries the interaction.
	const gizmo = new TransformControls(camera, canvas);
	gizmo.setMode('rotate');
	gizmo.setSpace('local');
	gizmo.setSize(0.8);
	gizmo.visible = false;
	gizmo.enabled = false;
	scene.add(gizmo.getHelper());
	// Suspend orbit while a gizmo drag is in progress.
	gizmo.addEventListener('dragging-changed', (e) => {
		controls.enabled = !e.value;
	});

	const hemi = new HemisphereLight('#f1f5f9', '#0a0a0f', 0.55);
	scene.add(hemi);
	const ambient = new AmbientLight('#ffffff', 0.18);
	scene.add(ambient);

	const key = new DirectionalLight('#ffffff', 1.4);
	key.position.set(3, 5, 2.5);
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.camera.near = 0.5;
	key.shadow.camera.far = 18;
	key.shadow.camera.left = -3.5;
	key.shadow.camera.right = 3.5;
	key.shadow.camera.top = 4;
	key.shadow.camera.bottom = -1;
	key.shadow.bias = -0.0008;
	scene.add(key);

	const fill = new DirectionalLight('#9bb1ff', 0.35);
	fill.position.set(-2.5, 2, -2);
	scene.add(fill);

	const ground = new Mesh(new CircleGeometry(12, 64), new ShadowMaterial({ opacity: 0.35 }));
	ground.rotation.x = -Math.PI / 2;
	ground.position.y = 0;
	ground.receiveShadow = true;
	scene.add(ground);

	const grid = new GridHelper(8, 32, 0x2a2a35, 0x1a1a22);
	grid.position.y = 0.001;
	scene.add(grid);

	const propLayer = new Group();
	scene.add(propLayer);

	// Layer that holds draggable IK target handles (kept out of the rig so it
	// survives a rig swap and never exports into a GLB).
	const ikLayer = new Group();
	scene.add(ikLayer);

	function resize() {
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / Math.max(1, h);
		camera.updateProjectionMatrix();
	}
	window.addEventListener('resize', resize);
	resize();

	function setStatus(text, kind = 'info') {
		if (!hudStatus) return;
		hudStatus.textContent = text;
		hudStatus.dataset.kind = kind;
	}

	return { scene, camera, renderer, controls, gizmo, key, hemi, ambient, propLayer, ikLayer, setStatus };
}

// ─── State ──────────────────────────────────────────────────────────────
const state = {
	rig: null,            // current Rig (MannequinRig | GltfRig)
	selectedBone: null,   // canonical bone key
	poseMode: 'fk',       // 'fk' (gizmo + sliders) | 'ik' (drag end-effectors)
	avatar: null,         // { id, name } when a GLB is loaded, else null
	loadingAvatar: false,
	prop: 'none',
	propGroup: null,
	keyLight: null,
	keyAzimuth: 0.9,
	keyElevation: 0.95,
	keyDistance: 5.8,
	ikHandles: new Map(), // effectorKey → Mesh
	draggingIK: null,     // { effectorKey, plane }
};

// Studio handle exposed for later tasks (timeline/save) to share the rig +
// scene without re-importing internals.
export const studio = {
	get rig() { return state.rig; },
	get scene() { return state.ctx?.scene || null; },
	get camera() { return state.ctx?.camera || null; },
	get renderer() { return state.ctx?.renderer || null; },
	get avatar() { return state.avatar; },
};

// ─── App boot ───────────────────────────────────────────────────────────
function boot() {
	const canvas = $('#pose-canvas');
	const hudStatus = $('#pose-status');
	if (!canvas) {
		console.error('[pose] missing #pose-canvas');
		return;
	}

	const ctx = setupScene(canvas, hudStatus);
	state.ctx = ctx;
	const { scene, camera, renderer, controls, gizmo, key, propLayer, ikLayer, setStatus } = ctx;
	state.keyLight = key;

	// Panel DOM refs (resolved up-front: mountRig() renders into them on boot).
	const sliderHost = $('#pose-controls-host');
	const selectionLabel = $('#pose-selection-label');
	const boneListHost = $('#pose-joint-picker');
	const boneSearch = $('#pose-bone-search');

	// ── Rig lifecycle ────────────────────────────────────────────────────
	function mountRig(rig) {
		// Tear down the previous rig.
		if (state.rig) {
			gizmo.detach();
			scene.remove(state.rig.root);
			state.rig.dispose?.();
		}
		state.rig = rig;
		scene.add(rig.root);
		state.selectedBone = null;
		clearIKHandles();
		buildIKHandles();
		applyPoseMode();
		renderControlsPanel();
		renderBoneList();
		updateSelectionLabel();
	}

	const mannequinRig = new MannequinRig({ build: 'male', color: '#d4d4d8' });
	mountRig(mannequinRig);
	state.avatar = null;

	// Pick a reasonable starting pose so the figure looks alive on load.
	const intro = getPresetById('contrapposto');
	if (intro) state.rig.applyPose(poseFromMannequinPreset(intro.pose));

	// ── Render loop ──────────────────────────────────────────────────────
	function tick() {
		requestAnimationFrame(tick);
		controls.update();
		if (state.poseMode === 'ik' && !state.draggingIK) syncIKHandles();
		renderer.render(scene, camera);
	}
	tick();

	// ── Camera framing ───────────────────────────────────────────────────
	function frameObject(object) {
		object.updateMatrixWorld(true);
		const box = new Box3().setFromObject(object);
		if (box.isEmpty()) return;
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		// Drop the rig so its feet rest on the ground plane.
		object.position.y -= box.min.y;
		const height = Math.max(0.5, size.y);
		controls.target.set(0, height * 0.55, 0);
		const dist = height * 2.2;
		camera.position.set(dist * 0.6, height * 0.8, dist);
		controls.minDistance = height * 0.4;
		controls.maxDistance = height * 8;
		controls.update();
	}

	// ── Raycast selection (FK) ─────────────────────────────────────────────
	const raycaster = new Raycaster();
	const ndc = new Vector2();
	const _v = new Vector3();

	function toNDC(clientX, clientY) {
		const rect = canvas.getBoundingClientRect();
		ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
		return ndc;
	}

	// Pick a bone from a screen position. Mannequin: raycast tagged meshes. GLB:
	// raycast the skinned mesh to confirm the click is on the figure, then pick
	// the posable bone whose projected position is nearest the cursor.
	function pickBoneAt(clientX, clientY) {
		const rig = state.rig;
		raycaster.setFromCamera(toNDC(clientX, clientY), camera);
		if (rig.kind === 'mannequin') {
			const hits = raycaster.intersectObjects(rig.getSelectableMeshes(), false);
			if (!hits.length) return null;
			return rig.boneFromHit(hits[0].object);
		}
		// GLB: require a hit on the mesh so empty-space clicks deselect.
		const meshes = rig.skinnedMeshes?.length ? rig.skinnedMeshes : rig.getSelectableMeshes();
		const hits = raycaster.intersectObjects(meshes, true);
		if (!hits.length) return null;
		const rect = canvas.getBoundingClientRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		let best = null;
		let bestDist = Infinity;
		for (const { key, node } of rig.getBones()) {
			node.getWorldPosition(_v).project(camera);
			const sx = (_v.x * 0.5 + 0.5) * rect.width;
			const sy = (-_v.y * 0.5 + 0.5) * rect.height;
			const d = Math.hypot(sx - px, sy - py);
			if (d < bestDist) { bestDist = d; best = key; }
		}
		return bestDist < 80 ? best : null;
	}

	function selectBone(key) {
		state.selectedBone = key;
		if (state.poseMode === 'fk') attachGizmo();
		renderControlsPanel();
		renderBoneList();
		updateSelectionLabel();
	}

	canvas.addEventListener('pointerdown', (ev) => {
		if (ev.button !== 0) return;
		if (gizmo.dragging) return; // gizmo owns this drag
		if (state.poseMode === 'ik' && tryStartIKDrag(ev)) {
			ev.preventDefault();
			return;
		}
		const bone = pickBoneAt(ev.clientX, ev.clientY);
		if (bone) selectBone(bone);
	});

	canvas.addEventListener('pointermove', (ev) => {
		if (!state.draggingIK) return;
		const hit = intersectDragPlane(ev.clientX, ev.clientY, state.draggingIK.plane);
		if (!hit) return;
		state.rig.solveIK(state.draggingIK.effectorKey, hit);
		const handle = state.ikHandles.get(state.draggingIK.effectorKey);
		if (handle) handle.position.copy(hit);
		if (state.selectedBone) renderControlsPanel();
	});

	function endIKDrag(ev) {
		if (!state.draggingIK) return;
		try { canvas.releasePointerCapture(ev.pointerId); } catch {}
		state.draggingIK = null;
		controls.enabled = true;
		syncIKHandles();
	}
	canvas.addEventListener('pointerup', endIKDrag);
	canvas.addEventListener('pointercancel', endIKDrag);

	// Gizmo rotations should refresh the slider readout live.
	gizmo.addEventListener('objectChange', () => {
		if (state.selectedBone) renderControlsPanel();
	});

	// ── FK gizmo ───────────────────────────────────────────────────────────
	function attachGizmo() {
		const key = state.selectedBone;
		const node = key && state.rig.getNode(key);
		if (state.poseMode !== 'fk' || !node) {
			gizmo.detach();
			gizmo.enabled = false;
			gizmo.visible = false;
			return;
		}
		gizmo.attach(node);
		gizmo.enabled = true;
		gizmo.visible = true;
	}

	// ── IK target handles ──────────────────────────────────────────────────
	function buildIKHandles() {
		for (const chain of state.rig.getIKChains()) {
			const m = new Mesh(handleGeom, handleMat.clone());
			m.renderOrder = 999;
			m.userData.effectorKey = chain.effectorKey;
			m.visible = false;
			ikLayer.add(m);
			state.ikHandles.set(chain.effectorKey, m);
		}
		syncIKHandles();
	}
	function clearIKHandles() {
		for (const m of state.ikHandles.values()) ikLayer.remove(m);
		state.ikHandles.clear();
	}
	function syncIKHandles() {
		for (const [effKey, m] of state.ikHandles) {
			const node = state.rig.getNode(effKey);
			if (node) node.getWorldPosition(m.position);
		}
	}

	function tryStartIKDrag(ev) {
		raycaster.setFromCamera(toNDC(ev.clientX, ev.clientY), camera);
		const handles = [...state.ikHandles.values()].filter((m) => m.visible);
		const hits = raycaster.intersectObjects(handles, false);
		if (!hits.length) return false;
		const handle = hits[0].object;
		const effectorKey = handle.userData.effectorKey;
		// Drag plane: faces the camera, passes through the handle.
		const normal = camera.getWorldDirection(new Vector3()).negate();
		const plane = new Plane().setFromNormalAndCoplanarPoint(normal, handle.position.clone());
		state.draggingIK = { effectorKey, plane };
		controls.enabled = false;
		canvas.setPointerCapture(ev.pointerId);
		selectBone(effectorKey);
		return true;
	}

	function intersectDragPlane(clientX, clientY, plane) {
		raycaster.setFromCamera(toNDC(clientX, clientY), camera);
		const pt = new Vector3();
		return raycaster.ray.intersectPlane(plane, pt) ? pt : null;
	}

	function applyPoseMode() {
		const ik = state.poseMode === 'ik';
		for (const m of state.ikHandles.values()) m.visible = ik;
		if (ik) {
			gizmo.detach();
			gizmo.enabled = false;
			gizmo.visible = false;
			syncIKHandles();
		} else {
			attachGizmo();
		}
		document.querySelectorAll('[data-posemode]').forEach((b) => {
			b.setAttribute('aria-pressed', String(b.dataset.posemode === state.poseMode));
		});
		const hasIK = state.rig.getIKChains().length > 0;
		const ikBtn = document.querySelector('[data-posemode="ik"]');
		if (ikBtn) {
			ikBtn.disabled = !hasIK;
			ikBtn.title = hasIK
				? 'IK — drag a hand or foot and the limb solves'
				: 'IK unavailable — this rig has no recognizable limb chains';
		}
	}

	// ── Controls panel (FK sliders for the selected bone) ───────────────────
	function updateSelectionLabel() {
		if (!selectionLabel) return;
		selectionLabel.textContent = state.selectedBone
			? CANONICAL_LABELS[state.selectedBone] || state.selectedBone
			: 'Click a body part';
	}

	function renderControlsPanel() {
		if (!sliderHost) return;
		sliderHost.innerHTML = '';
		const key = state.selectedBone;
		if (!key || !state.rig.hasBone(key)) {
			sliderHost.appendChild(
				el('p', { class: 'pose-hint' }, [
					state.poseMode === 'ik'
						? 'Drag a glowing hand or foot handle to pose the limb with inverse kinematics.'
						: 'Click any body part in the scene, search a bone on the left, or pick a preset to start posing.',
				]),
			);
			return;
		}
		const rot = state.rig.getBoneEuler(key);
		const AXES = [['x', 'Bend / Pitch'], ['y', 'Twist / Yaw'], ['z', 'Tilt / Roll']];
		for (const [axis, label] of AXES) {
			const value = rot[axis];
			const row = el('div', { class: 'pose-slider-row' }, [
				el('label', {}, [`${label} (${axis.toUpperCase()})`]),
				el('div', { class: 'pose-slider-value', 'data-axis': axis }, [
					`${((value * 180) / Math.PI).toFixed(0)}°`,
				]),
			]);
			const slider = el('input', {
				type: 'range',
				min: '-3.14159',
				max: '3.14159',
				step: '0.01',
				value: String(value),
				'aria-label': `${CANONICAL_LABELS[key] || key} ${label}`,
			});
			slider.addEventListener('input', () => {
				const cur = state.rig.getBoneEuler(key);
				cur[axis] = parseFloat(slider.value);
				state.rig.setBoneEuler(key, cur);
				const next = state.rig.getBoneEuler(key);
				row.querySelector(`.pose-slider-value[data-axis="${axis}"]`).textContent =
					`${((next[axis] * 180) / Math.PI).toFixed(0)}°`;
				slider.value = String(next[axis]);
			});
			row.appendChild(slider);
			sliderHost.appendChild(row);
		}
		const resetBtn = el('button', { class: 'pose-btn pose-btn-ghost', type: 'button' }, ['Reset this bone']);
		resetBtn.addEventListener('click', () => {
			state.rig.setBoneEuler(key, { x: 0, y: 0, z: 0 });
			renderControlsPanel();
		});
		sliderHost.appendChild(resetBtn);
	}

	// ── Bone list (searchable) ───────────────────────────────────────────────
	function renderBoneList() {
		if (!boneListHost) return;
		const q = (boneSearch?.value || '').trim().toLowerCase();
		boneListHost.innerHTML = '';
		const bones = state.rig.getBones().filter(({ key, label }) =>
			!q || key.toLowerCase().includes(q) || label.toLowerCase().includes(q));
		if (!bones.length) {
			boneListHost.appendChild(el('p', { class: 'pose-hint' }, ['No bones match your search.']));
			return;
		}
		const row = el('div', { class: 'pose-joint-row' }, []);
		for (const { key, label } of bones) {
			const btn = el('button', {
				class: 'pose-joint-btn',
				type: 'button',
				'data-bone': key,
				'aria-pressed': String(state.selectedBone === key),
			}, [label]);
			btn.addEventListener('click', () => selectBone(key));
			row.appendChild(btn);
		}
		boneListHost.appendChild(row);
	}
	boneSearch?.addEventListener('input', renderBoneList);

	// ── Preset picker ──────────────────────────────────────────────────────
	const presetHost = $('#pose-presets-host');
	if (presetHost) {
		const grouped = getPresetsByGroup();
		for (const [groupName, presets] of Object.entries(grouped)) {
			if (!presets.length) continue;
			presetHost.appendChild(el('div', { class: 'pose-preset-group' }, [groupName]));
			const wrap = el('div', { class: 'pose-preset-grid' }, []);
			for (const preset of presets) {
				const btn = el('button', { class: 'pose-preset-btn', type: 'button', 'data-preset': preset.id }, [preset.label]);
				btn.addEventListener('click', () => {
					state.rig.applyPose(poseFromMannequinPreset(preset.pose));
					if (state.poseMode === 'fk') attachGizmo();
					renderControlsPanel();
					setStatus(`Applied preset: ${preset.label}`);
				});
				wrap.appendChild(btn);
			}
			presetHost.appendChild(wrap);
		}
	}

	// ── Avatar loading ───────────────────────────────────────────────────────
	const gltfLoader = new GLTFLoader();
	let decodersReady = null;
	async function ensureDecoders() {
		if (!decodersReady) {
			decodersReady = getDecoders().then(({ dracoLoader, ktx2Loader, meshoptDecoder }) => {
				gltfLoader
					.setDRACOLoader(dracoLoader)
					.setKTX2Loader(ktx2Loader.detectSupport(renderer))
					.setMeshoptDecoder(meshoptDecoder);
			});
		}
		return decodersReady;
	}

	async function loadAvatarFromUrl(modelUrl, meta = {}) {
		if (!modelUrl) throw new Error('No model URL for this avatar.');
		await ensureDecoders();
		setStatus(`Loading ${meta.name || 'avatar'}…`);
		state.loadingAvatar = true;
		const gltf = await new Promise((resolve, reject) => {
			gltfLoader.load(
				modelUrl,
				resolve,
				(xhr) => {
					if (xhr.total) {
						const pct = Math.round((xhr.loaded / xhr.total) * 100);
						setStatus(`Loading ${meta.name || 'avatar'}… ${pct}%`);
					}
				},
				reject,
			);
		});
		state.loadingAvatar = false;
		const scn = gltf.scene || gltf.scenes?.[0];
		const rig = scn && makeGltfRig(scn);
		if (!rig) {
			throw new Error('That model has no recognizable humanoid skeleton — pick a rigged avatar.');
		}
		mountRig(rig);
		state.avatar = { id: meta.id || null, name: meta.name || 'Avatar', model_url: modelUrl };
		frameObject(rig.root);
		setMannequinControlsEnabled(false);
		setStatus(`Loaded ${state.avatar.name}. Select a bone to pose, or switch to IK.`);
	}

	async function loadAvatarById(id) {
		setStatus('Resolving avatar…');
		const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!res.ok) throw new Error(`Couldn't load avatar (${res.status}). It may be private or removed.`);
		const { avatar } = await res.json();
		const url = avatar?.model_url || avatar?.url;
		if (!url) throw new Error('That avatar has no downloadable model.');
		await loadAvatarFromUrl(url, { id: avatar.id, name: avatar.name });
	}

	function switchToMannequin() {
		gizmo.detach();
		mountRig(mannequinRig);
		state.avatar = null;
		controls.target.set(0, 0.95, 0);
		camera.position.set(2.2, 1.65, 3.0);
		controls.update();
		setMannequinControlsEnabled(true);
		updateUrlAvatar(null);
		setStatus('Switched to mannequin.');
	}

	function updateUrlAvatar(id) {
		const url = new URL(window.location.href);
		if (id) url.searchParams.set('avatar', id);
		else url.searchParams.delete('avatar');
		window.history.replaceState({}, '', url);
	}

	function setMannequinControlsEnabled(on) {
		for (const sel of ['#pose-build', '#pose-skin', '#pose-constraints']) {
			const node = $(sel);
			if (node) {
				node.disabled = !on;
				node.closest('.pose-form-row')?.classList.toggle('pose-disabled', !on);
			}
		}
	}

	// Load avatar / mannequin toolbar buttons.
	$('#pose-load-avatar')?.addEventListener('click', () => {
		const signedIn = document.cookie.includes('session') || false;
		const picker = new AvatarGalleryPicker({
			source: signedIn ? 'both' : 'public',
			title: 'Load an avatar to animate',
			ctaLabel: 'Pose this avatar',
			showModes: false,
			onSelect: async (avatar) => {
				picker.close();
				try {
					await loadAvatarFromUrl(avatar.model_url, { id: avatar.id, name: avatar.name });
					updateUrlAvatar(avatar.id);
				} catch (err) {
					setStatus(err.message, 'error');
				}
			},
		});
		picker.openModal();
	});
	$('#pose-use-mannequin')?.addEventListener('click', switchToMannequin);

	// ── Posing-mode toggle (FK / IK) ────────────────────────────────────────
	document.querySelectorAll('[data-posemode]').forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			state.poseMode = btn.dataset.posemode;
			applyPoseMode();
			renderControlsPanel();
		});
	});

	// ── Top toolbar ──────────────────────────────────────────────────────────
	$('#pose-reset')?.addEventListener('click', () => {
		state.rig.resetPose();
		if (state.poseMode === 'fk') attachGizmo();
		else syncIKHandles();
		setStatus('Pose reset.');
		renderControlsPanel();
	});

	$('#pose-screenshot')?.addEventListener('click', () => {
		renderer.render(scene, camera);
		const url = canvas.toDataURL('image/png');
		const a = document.createElement('a');
		a.href = url;
		a.download = `pose-${Date.now()}.png`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setStatus('Screenshot saved.');
	});

	$('#pose-export-json')?.addEventListener('click', () => {
		const pose = state.rig.getPose();
		const blob = new Blob([JSON.stringify(pose, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `pose-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setStatus('Pose JSON saved.');
	});

	$('#pose-import-json')?.addEventListener('change', (ev) => {
		const file = ev.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const pose = JSON.parse(String(reader.result));
				state.rig.applyPose(pose);
				if (state.poseMode === 'fk') attachGizmo();
				renderControlsPanel();
				setStatus(`Imported pose from ${file.name}.`);
			} catch (err) {
				setStatus(`Import failed: ${err.message}`, 'error');
			}
		};
		reader.readAsText(file);
		ev.target.value = '';
	});

	// ── Settings panel (mannequin-only model controls) ───────────────────────
	$('#pose-build')?.addEventListener('change', (ev) => {
		if (state.rig.kind !== 'mannequin') return;
		state.rig.setBuild(ev.target.value);
		buildIKHandles();
		applyPoseMode();
	});
	$('#pose-skin')?.addEventListener('input', (ev) => {
		if (state.rig.kind === 'mannequin') state.rig.setColor(ev.target.value);
	});
	$('#pose-constraints')?.addEventListener('change', (ev) => {
		if (state.rig.kind !== 'mannequin') return;
		state.rig.setConstraintsEnabled(ev.target.checked);
		setStatus(ev.target.checked ? 'Biological constraints on.' : 'Constraints off — full rotation allowed.');
	});

	$('#pose-bg')?.addEventListener('input', (ev) => { scene.background = new Color(ev.target.value); });
	$('#pose-fov')?.addEventListener('input', (ev) => {
		camera.fov = parseFloat(ev.target.value);
		camera.updateProjectionMatrix();
	});
	$('#pose-grid')?.addEventListener('change', (ev) => {
		scene.traverse((o) => { if (o.isGridHelper) o.visible = ev.target.checked; });
	});

	function syncKeyLight() {
		const r = state.keyDistance;
		const x = r * Math.cos(state.keyElevation) * Math.sin(state.keyAzimuth);
		const z = r * Math.cos(state.keyElevation) * Math.cos(state.keyAzimuth);
		const y = r * Math.sin(state.keyElevation);
		state.keyLight.position.set(x, y, z);
		state.keyLight.target.position.set(0, 0.9, 0);
		state.keyLight.target.updateMatrixWorld();
	}
	syncKeyLight();
	$('#pose-light-azimuth')?.addEventListener('input', (ev) => { state.keyAzimuth = (parseFloat(ev.target.value) / 180) * Math.PI; syncKeyLight(); });
	$('#pose-light-elevation')?.addEventListener('input', (ev) => { state.keyElevation = (parseFloat(ev.target.value) / 180) * Math.PI; syncKeyLight(); });
	$('#pose-light-intensity')?.addEventListener('input', (ev) => { state.keyLight.intensity = parseFloat(ev.target.value); });

	// ── Floor props ────────────────────────────────────────────────────────
	const propHost = $('#pose-prop-host');
	if (propHost) {
		for (const [id, def] of Object.entries(FLOOR_PROPS)) {
			const btn = el('button', { class: 'pose-prop-btn', type: 'button', 'data-prop': id, 'aria-pressed': String(state.prop === id) }, [def.label]);
			btn.addEventListener('click', () => {
				state.prop = id;
				propLayer.clear();
				if (def.build) { const g = def.build(); propLayer.add(g); state.propGroup = g; }
				document.querySelectorAll('[data-prop]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.prop === id)));
			});
			propHost.appendChild(btn);
		}
	}

	// ── Keyboard shortcuts ───────────────────────────────────────────────────
	window.addEventListener('keydown', (ev) => {
		if (ev.target.matches('input, textarea, select')) return;
		const k = ev.key.toLowerCase();
		if (k === 'f') { state.poseMode = 'fk'; applyPoseMode(); renderControlsPanel(); }
		else if (k === 'i') { const b = document.querySelector('[data-posemode="ik"]'); if (b && !b.disabled) { state.poseMode = 'ik'; applyPoseMode(); renderControlsPanel(); } }
		else if (k === 'r' && state.selectedBone) { state.rig.setBoneEuler(state.selectedBone, { x: 0, y: 0, z: 0 }); renderControlsPanel(); }
		else if (k === 'escape') { state.selectedBone = null; gizmo.detach(); renderControlsPanel(); renderBoneList(); updateSelectionLabel(); }
	});

	// ── Boot: honor ?avatar= ─────────────────────────────────────────────────
	const requestedAvatar = new URL(window.location.href).searchParams.get('avatar');
	if (requestedAvatar) {
		loadAvatarById(requestedAvatar).catch((err) => {
			setStatus(`${err.message} Showing the mannequin instead.`, 'error');
			switchToMannequin();
		});
	} else {
		setStatus('Ready. Click a body part to pose, or load an avatar.');
	}
}

document.addEventListener('DOMContentLoaded', boot);
