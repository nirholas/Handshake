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
	PCFShadowMap,
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
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

import { getDecoders } from './viewer/internal.js';
import {
	CANONICAL_LABELS,
	MannequinRig,
	makeGltfRig,
	poseFromMannequinPreset,
} from './pose-rig.js';
import { PRESETS, getPresetsByGroup, getPresetById } from './pose-presets.js';
import { decodePoseFromLocation } from './pose-share.js';
import { AvatarGalleryPicker } from './avatar-gallery-picker.js';
import {
	createDocument,
	upsertKeyframe,
	removeKeyframe,
	moveKeyframe,
	setKeyframeEasing,
	clampKeyframesToDuration,
	sampleAtTime,
	bakeClip,
	serializeClip,
	clonePose,
	posesEqual,
	EASINGS,
	DEFAULT_EASING,
} from './pose-animation.js';
import { PoseLibrary } from './pose-library.js';
import { AnimationLibrary } from './animation-library.js';
import { putSceneHandoff } from './shared/scene-handoff.js';
import { isSafeQueryModelUrl } from './shared/safe-model-url.js';
import { log } from './shared/log.js';

// ─── DOM helpers ────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function')
			node.addEventListener(k.slice(2), v);
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
			for (const [x, z] of [
				[+0.19, +0.19],
				[+0.19, -0.19],
				[-0.19, +0.19],
				[-0.19, -0.19],
			]) {
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
			const base = new Mesh(new CylinderGeometry(0.18, 0.2, 0.03, 24), mat);
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
const handleMat = new MeshBasicMaterial({
	color: '#22d3ee',
	transparent: true,
	opacity: 0.9,
	depthTest: false,
});

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
	renderer.shadowMap.type = PCFShadowMap;

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
	// The shared nav injects asynchronously and the stage flexes with the page
	// shell, so track the canvas box directly rather than relying on window
	// resize alone — keeps the render crisp at every breakpoint.
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(resize).observe(canvas);
	}
	resize();

	function setStatus(text, kind = 'info') {
		if (!hudStatus) return;
		hudStatus.textContent = text;
		hudStatus.dataset.kind = kind;
	}

	return {
		scene,
		camera,
		renderer,
		controls,
		gizmo,
		key,
		hemi,
		ambient,
		propLayer,
		ikLayer,
		setStatus,
	};
}

// ─── State ──────────────────────────────────────────────────────────────
const state = {
	rig: null, // current Rig (MannequinRig | GltfRig)
	selectedBone: null, // canonical bone key
	poseMode: 'fk', // 'fk' (gizmo + sliders) | 'ik' (drag end-effectors)
	avatar: null, // { id, name } when a GLB is loaded, else null
	loadingAvatar: false,
	prop: 'none',
	propGroup: null,
	keyLight: null,
	keyAzimuth: 0.9,
	keyElevation: 0.95,
	keyDistance: 5.8,
	ikHandles: new Map(), // effectorKey → Mesh
	draggingIK: null, // { effectorKey, plane }
	anim: null, // timeline controller handle (set on boot)
	animLibrary: null, // AnimationLibrary (preset gallery) handle (set on boot)
};

// Studio handle exposed for later tasks (save/library/monetize) to share the
// rig, scene, and the current animation document without re-importing internals.
export const studio = {
	get rig() {
		return state.rig;
	},
	get scene() {
		return state.ctx?.scene || null;
	},
	get camera() {
		return state.ctx?.camera || null;
	},
	get renderer() {
		return state.ctx?.renderer || null;
	},
	get avatar() {
		return state.avatar;
	},
	// ── Animation handoff API (Task 4/5/6) ───────────────────────────────────
	get document() {
		return state.anim?.doc || null;
	},
	/** Bake the current document to a THREE.AnimationClip (canonical bone names). */
	bake() {
		return state.anim ? state.anim.bake() : null;
	},
	/** The documented clip-JSON ({ name, duration, tracks }). */
	serializeClip() {
		return state.anim ? state.anim.serialize() : null;
	},
	/** PNG data URL of the current viewport (reuses the screenshot pipeline). */
	captureThumbnail() {
		return state.anim ? state.anim.captureThumbnail() : null;
	},
};

// ─── App boot ───────────────────────────────────────────────────────────
function boot() {
	const canvas = $('#pose-canvas');
	const hudStatus = $('#pose-status');
	if (!canvas) {
		log.error('[pose] missing #pose-canvas');
		return;
	}

	const ctx = setupScene(canvas, hudStatus);
	state.ctx = ctx;
	const { scene, camera, renderer, controls, gizmo, key, propLayer, ikLayer, setStatus } = ctx;
	state.keyLight = key;

	// Timeline controller — assigned near the end of boot once its DOM refs
	// exist. Declared here so mountRig() (called during boot, before the
	// assignment) can safely reference it via optional chaining.
	let timeline = null;

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
		timeline?.onRigChanged();
		state.animLibrary?.onRigChanged();
	}

	const mannequinRig = new MannequinRig({ build: 'male', color: '#d4d4d8' });
	mountRig(mannequinRig);
	state.avatar = null;

	// A pose handed over from elsewhere (the homepage demo's "Open full studio"
	// link / share URL) wins; otherwise pick a reasonable starting pose so the
	// figure looks alive on load.
	const sharedPose = decodePoseFromLocation();
	if (sharedPose) {
		state.rig.applyPose(sharedPose);
	} else {
		const intro = getPresetById('contrapposto');
		if (intro) state.rig.applyPose(poseFromMannequinPreset(intro.pose));
	}

	// ── Render loop ──────────────────────────────────────────────────────
	let lastFrameMs = performance.now();
	function tick() {
		requestAnimationFrame(tick);
		const now = performance.now();
		const dt = Math.min((now - lastFrameMs) / 1000, 0.1); // cap to avoid tab-switch jumps
		lastFrameMs = now;
		controls.update();
		// A preset preview owns the figure while it runs; the keyframe timeline
		// yields so the two never fight over bone transforms.
		if (state.animLibrary?.isPreviewing()) state.animLibrary.update(dt);
		else timeline?.update(dt);
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
			if (d < bestDist) {
				bestDist = d;
				best = key;
			}
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
		try {
			canvas.releasePointerCapture(ev.pointerId);
		} catch {}
		state.draggingIK = null;
		controls.enabled = true;
		syncIKHandles();
		commitEdit();
	}
	canvas.addEventListener('pointerup', endIKDrag);
	canvas.addEventListener('pointercancel', endIKDrag);

	// Gizmo rotations should refresh the slider readout live.
	gizmo.addEventListener('objectChange', () => {
		if (state.selectedBone) renderControlsPanel();
	});
	// A gizmo drag is one undoable edit: snapshot on grab, commit on release.
	gizmo.addEventListener('mouseDown', beginEdit);
	gizmo.addEventListener('mouseUp', commitEdit);

	// ── Pose history (undo / redo) ───────────────────────────────────────────
	// A bounded stack of canonical pose snapshots. Discrete actions (preset,
	// reset, mirror, paste, import) call recordHistory() before mutating;
	// continuous gestures (gizmo, IK drag, FK slider) bracket themselves with
	// beginEdit()/commitEdit() so the whole drag collapses to a single step.
	const HISTORY_LIMIT = 100;
	const history = { undo: [], redo: [], pending: null };

	function pushUndo(before) {
		history.undo.push(before);
		if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
		history.redo.length = 0;
		updateHistoryButtons();
	}
	function recordHistory() {
		pushUndo(state.rig.getPose());
	}
	function beginEdit() {
		if (!history.pending) history.pending = state.rig.getPose();
	}
	function commitEdit() {
		const before = history.pending;
		history.pending = null;
		if (before && !posesEqual(before, state.rig.getPose())) pushUndo(before);
	}
	function restorePose(pose) {
		state.rig.applyPose(pose);
		if (state.poseMode === 'fk') attachGizmo();
		else syncIKHandles();
		renderControlsPanel();
	}
	function undoPose() {
		if (!history.undo.length) return setStatus('Nothing to undo.');
		history.redo.push(state.rig.getPose());
		if (history.redo.length > HISTORY_LIMIT) history.redo.shift();
		restorePose(history.undo.pop());
		updateHistoryButtons();
		setStatus('Undo.');
	}
	function redoPose() {
		if (!history.redo.length) return setStatus('Nothing to redo.');
		history.undo.push(state.rig.getPose());
		restorePose(history.redo.pop());
		updateHistoryButtons();
		setStatus('Redo.');
	}
	function updateHistoryButtons() {
		const u = $('#pose-undo');
		const r = $('#pose-redo');
		if (u) u.disabled = !history.undo.length;
		if (r) r.disabled = !history.redo.length;
	}

	// ── Mirror / copy / paste ────────────────────────────────────────────────
	function mirrorPose() {
		recordHistory();
		state.rig.mirrorPose();
		if (state.poseMode === 'fk') attachGizmo();
		else syncIKHandles();
		renderControlsPanel();
		setStatus('Pose mirrored left ↔ right.');
	}
	function copyPose() {
		state.clipboardPose = clonePose(state.rig.getPose());
		try {
			navigator.clipboard?.writeText(JSON.stringify(state.clipboardPose)).catch(() => {});
		} catch {}
		const pasteBtn = $('#pose-paste');
		if (pasteBtn) pasteBtn.disabled = false;
		setStatus('Pose copied.');
	}
	function pastePose() {
		if (!state.clipboardPose) return setStatus('Copy a pose first.', 'error');
		recordHistory();
		restorePose(state.clipboardPose);
		setStatus('Pose pasted.');
	}

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
		for (const m of state.ikHandles.values()) {
			ikLayer.remove(m);
			m.material?.dispose();
		}
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
		beginEdit();
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
		const AXES = [
			['x', 'Bend / Pitch'],
			['y', 'Twist / Yaw'],
			['z', 'Tilt / Roll'],
		];
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
			slider.addEventListener('pointerdown', beginEdit);
			slider.addEventListener('keydown', beginEdit);
			slider.addEventListener('change', commitEdit);
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
		const resetBtn = el('button', { class: 'pose-btn pose-btn-ghost', type: 'button' }, [
			'Reset this bone',
		]);
		resetBtn.addEventListener('click', () => {
			recordHistory();
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
		const bones = state.rig
			.getBones()
			.filter(
				({ key, label }) =>
					!q || key.toLowerCase().includes(q) || label.toLowerCase().includes(q),
			);
		if (!bones.length) {
			boneListHost.appendChild(
				el('p', { class: 'pose-hint' }, ['No bones match your search.']),
			);
			return;
		}
		const row = el('div', { class: 'pose-joint-row' }, []);
		for (const { key, label } of bones) {
			const btn = el(
				'button',
				{
					class: 'pose-joint-btn',
					type: 'button',
					'data-bone': key,
					'aria-pressed': String(state.selectedBone === key),
				},
				[label],
			);
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
				const btn = el(
					'button',
					{ class: 'pose-preset-btn', type: 'button', 'data-preset': preset.id },
					[preset.label],
				);
				btn.addEventListener('click', () => {
					recordHistory();
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
		let gltf;
		try {
			gltf = await new Promise((resolve, reject) => {
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
		} finally {
			state.loadingAvatar = false;
		}
		const scn = gltf.scene || gltf.scenes?.[0];
		const rig = scn && makeGltfRig(scn);
		if (!rig) {
			throw new Error(
				'That model has no recognizable humanoid skeleton — pick a rigged avatar.',
			);
		}
		mountRig(rig);
		state.avatar = { id: meta.id || null, name: meta.name || 'Avatar', model_url: modelUrl };
		frameObject(rig.root);
		setMannequinControlsEnabled(false);
		setStatus(`Loaded ${state.avatar.name}. Select a bone to pose, or switch to IK.`);
	}

	async function loadAvatarById(id) {
		setStatus('Resolving avatar…');
		const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, {
			credentials: 'include',
		});
		if (!res.ok)
			throw new Error(`Couldn't load avatar (${res.status}). It may be private or removed.`);
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
		recordHistory();
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
				recordHistory();
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
		setStatus(
			ev.target.checked
				? 'Biological constraints on.'
				: 'Constraints off — full rotation allowed.',
		);
	});

	$('#pose-bg')?.addEventListener('input', (ev) => {
		scene.background = new Color(ev.target.value);
	});
	$('#pose-fov')?.addEventListener('input', (ev) => {
		camera.fov = parseFloat(ev.target.value);
		camera.updateProjectionMatrix();
	});
	$('#pose-grid')?.addEventListener('change', (ev) => {
		scene.traverse((o) => {
			if (o.isGridHelper) o.visible = ev.target.checked;
		});
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
	$('#pose-light-azimuth')?.addEventListener('input', (ev) => {
		state.keyAzimuth = (parseFloat(ev.target.value) / 180) * Math.PI;
		syncKeyLight();
	});
	$('#pose-light-elevation')?.addEventListener('input', (ev) => {
		state.keyElevation = (parseFloat(ev.target.value) / 180) * Math.PI;
		syncKeyLight();
	});
	$('#pose-light-intensity')?.addEventListener('input', (ev) => {
		state.keyLight.intensity = parseFloat(ev.target.value);
	});

	// ── Floor props ────────────────────────────────────────────────────────
	const propHost = $('#pose-prop-host');
	if (propHost) {
		for (const [id, def] of Object.entries(FLOOR_PROPS)) {
			const btn = el(
				'button',
				{
					class: 'pose-prop-btn',
					type: 'button',
					'data-prop': id,
					'aria-pressed': String(state.prop === id),
				},
				[def.label],
			);
			btn.addEventListener('click', () => {
				state.prop = id;
				if (state.propGroup) {
					state.propGroup.traverse((n) => {
						n.geometry?.dispose();
						if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose());
						else n.material?.dispose();
					});
					state.propGroup = null;
				}
				propLayer.clear();
				if (def.build) {
					const g = def.build();
					propLayer.add(g);
					state.propGroup = g;
				}
				document
					.querySelectorAll('[data-prop]')
					.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.prop === id)));
			});
			propHost.appendChild(btn);
		}
	}

	// ── Top-toolbar pose actions ─────────────────────────────────────────────
	$('#pose-undo')?.addEventListener('click', undoPose);
	$('#pose-redo')?.addEventListener('click', redoPose);
	$('#pose-mirror')?.addEventListener('click', mirrorPose);
	$('#pose-copy')?.addEventListener('click', copyPose);
	$('#pose-paste')?.addEventListener('click', pastePose);
	updateHistoryButtons();

	// ── Keyboard shortcuts ───────────────────────────────────────────────────
	window.addEventListener('keydown', (ev) => {
		if (ev.target.matches('input, textarea, select')) return;
		const k = ev.key.toLowerCase();
		const mod = ev.ctrlKey || ev.metaKey;
		// Undo / redo — Ctrl/Cmd+Z, Shift+Z or Ctrl+Y to redo.
		if (mod && k === 'z') {
			ev.preventDefault();
			ev.shiftKey ? redoPose() : undoPose();
			return;
		}
		if (mod && k === 'y') {
			ev.preventDefault();
			redoPose();
			return;
		}
		// Remaining shortcuts are single-key (no modifier) so they never clobber
		// browser/OS chords like Ctrl+C.
		if (mod || ev.altKey) return;
		if (k === 'f') {
			state.poseMode = 'fk';
			applyPoseMode();
			renderControlsPanel();
		} else if (k === 'i') {
			const b = document.querySelector('[data-posemode="ik"]');
			if (b && !b.disabled) {
				state.poseMode = 'ik';
				applyPoseMode();
				renderControlsPanel();
			}
		} else if (k === 'r' && state.selectedBone) {
			recordHistory();
			state.rig.setBoneEuler(state.selectedBone, { x: 0, y: 0, z: 0 });
			renderControlsPanel();
		} else if (k === 'm') {
			mirrorPose();
		} else if (k === 'c') {
			copyPose();
		} else if (k === 'v') {
			pastePose();
		} else if (k === 'escape') {
			state.selectedBone = null;
			gizmo.detach();
			renderControlsPanel();
			renderBoneList();
			updateSelectionLabel();
		}
	});

	// ── Animation timeline ───────────────────────────────────────────────────
	// Keyframe recorder: set a pose → drop a keyframe → advance the playhead →
	// re-pose → drop another. The render loop interpolates (slerp) between
	// keyframes and plays the result; export bakes a THREE.AnimationClip.
	timeline = setupTimeline();

	// ── Crash recovery & unsaved-work guard ──────────────────────────────────
	// Posing and keyframing never touch the account until the user explicitly
	// Saves, so a refresh or accidental tab close would lose in-progress work.
	// We snapshot the timeline document to localStorage on a light interval and
	// warn before unload while the current state differs from the last point it
	// was persisted (an account save, or opening a saved clip). On the next boot
	// the draft is offered back — unless an explicit deep-link (?anim=) wins.
	const autosave = setupAutosave();

	// ── Animation preset library ─────────────────────────────────────────────
	// A curated gallery of ready-to-apply motion clips. Picking one retargets it
	// onto the loaded rig and plays it live in this same viewport, then offers an
	// animated-GLB export. While a preset previews it drives the figure, so we
	// pause the keyframe timeline and stow the FK gizmo.
	const animLibraryHost = $('#pose-anim-library');
	if (animLibraryHost) {
		const animLibrary = new AnimationLibrary({
			host: animLibraryHost,
			getRig: () => state.rig,
			setStatus,
			onPreviewStart: () => {
				timeline?.pause?.();
				gizmo.detach();
				gizmo.enabled = false;
				gizmo.visible = false;
			},
			onPreviewStop: () => {
				if (state.poseMode === 'fk' && state.selectedBone) attachGizmo();
				renderControlsPanel();
			},
		});
		state.animLibrary = animLibrary;
		animLibrary.mount();
	}

	function setupTimeline() {
		const doc = createDocument();
		const anim = { doc, playing: false, playhead: 0, selectedId: null };
		state.anim = anim;

		const tl = {
			track: $('#tl-track'),
			lane: $('#tl-lane'),
			ruler: $('#tl-ruler'),
			playhead: $('#tl-playhead'),
			empty: $('#tl-empty'),
			time: $('#tl-time'),
			play: $('#tl-play'),
			stop: $('#tl-stop'),
			start: $('#tl-start'),
			end: $('#tl-end'),
			loop: $('#tl-loop'),
			add: $('#tl-add-key'),
			del: $('#tl-del-key'),
			easing: $('#tl-easing'),
			name: $('#tl-name'),
			duration: $('#tl-duration'),
			fps: $('#tl-fps'),
			exportJson: $('#tl-export-json'),
			exportGlb: $('#tl-export-glb'),
			openScene: $('#tl-open-scene'),
		};
		if (!tl.track) return null; // page without the timeline markup — no-op

		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
		const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
		const pct = (t) => (doc.duration > 0 ? (t / doc.duration) * 100 : 0);
		const xToTime = (clientX) => {
			const rect = tl.track.getBoundingClientRect();
			return clamp((clientX - rect.left) / rect.width, 0, 1) * doc.duration;
		};
		const safeName = () =>
			(doc.name || 'animation')
				.replace(/[^a-z0-9._-]+/gi, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 60) || 'animation';

		// Sync the static control values from the document defaults.
		tl.name.value = doc.name;
		tl.duration.value = String(doc.duration);
		tl.fps.value = String(doc.fps);
		tl.loop.setAttribute('aria-pressed', String(doc.loop));
		tl.track.setAttribute('aria-valuemax', String(doc.duration));

		// ── Preview ────────────────────────────────────────────────────────────
		function applyPreview() {
			if (!doc.keyframes.length || !state.rig) return;
			const pose = sampleAtTime(doc, anim.playhead);
			if (pose) {
				state.rig.applyPose(pose);
				if (state.poseMode === 'ik') syncIKHandles();
			}
		}

		function setPlayhead(t, { render = false } = {}) {
			anim.playhead = clamp(t, 0, doc.duration);
			tl.playhead.style.left = `${pct(anim.playhead)}%`;
			tl.time.innerHTML = `<b>${anim.playhead.toFixed(2)}</b> / ${doc.duration.toFixed(2)}s`;
			tl.track.setAttribute('aria-valuenow', anim.playhead.toFixed(2));
			applyPreview();
			if (render && state.selectedBone) renderControlsPanel();
		}

		// ── Transport ────────────────────────────────────────────────────────────
		function play() {
			if (!doc.keyframes.length) {
				setStatus('Add a keyframe first, then play.', 'error');
				return;
			}
			if (!doc.loop && anim.playhead >= doc.duration - 1e-3) anim.playhead = 0;
			anim.playing = true;
			tl.play.textContent = '⏸';
			tl.play.setAttribute('aria-pressed', 'true');
		}
		function pause() {
			anim.playing = false;
			tl.play.textContent = '▶';
			tl.play.setAttribute('aria-pressed', 'false');
		}
		function toggle() {
			anim.playing ? pause() : play();
		}
		function stop() {
			pause();
			setPlayhead(0, { render: true });
		}

		function advance(dt) {
			if (!anim.playing) return;
			let t = anim.playhead + dt;
			if (t >= doc.duration) {
				if (doc.loop) t = doc.duration > 0 ? t % doc.duration : 0;
				else {
					setPlayhead(doc.duration);
					pause();
					return;
				}
			}
			setPlayhead(t);
		}

		// ── Ruler + keyframes render ─────────────────────────────────────────────
		function niceStep(raw) {
			for (const s of NICE_STEPS) if (s >= raw) return s;
			return NICE_STEPS[NICE_STEPS.length - 1];
		}
		function renderRuler() {
			tl.ruler.innerHTML = '';
			const step = niceStep(doc.duration / 8);
			for (let t = 0; t <= doc.duration + 1e-6; t += step) {
				const left = pct(t);
				tl.ruler.appendChild(el('div', { class: 'tl-tick', style: `left:${left}%` }));
				tl.ruler.appendChild(
					el('div', { class: 'tl-tick-label', style: `left:${left}%` }, [
						`${+t.toFixed(3)}s`,
					]),
				);
			}
		}

		function refreshExportEnabled() {
			const has = doc.keyframes.length > 0;
			tl.exportJson.disabled = !has;
			tl.exportGlb.disabled = !has;
			if (tl.openScene) tl.openScene.disabled = !has;
		}

		function updateSelectionUI() {
			const kf = doc.keyframes.find((k) => k.id === anim.selectedId);
			tl.easing.disabled = !kf;
			tl.del.disabled = !kf;
			if (kf) tl.easing.value = kf.easing;
			tl.lane.querySelectorAll('.tl-key').forEach((d) => {
				d.setAttribute('aria-selected', String(d.dataset.id === anim.selectedId));
			});
		}

		function renderKeyframes() {
			tl.lane.innerHTML = '';
			tl.empty.style.display = doc.keyframes.length ? 'none' : 'flex';
			for (const kf of doc.keyframes) {
				const diamond = el('div', {
					class: 'tl-key',
					'data-id': kf.id,
					tabindex: '0',
					role: 'button',
					'aria-selected': String(kf.id === anim.selectedId),
					'aria-label': `Keyframe at ${kf.time.toFixed(2)} seconds, ${kf.easing}`,
					title: `${kf.time.toFixed(2)}s · ${kf.easing}`,
					style: `left:${pct(kf.time)}%`,
				});
				diamond.addEventListener('pointerdown', (ev) => startKeyDrag(ev, kf, diamond));
				diamond.addEventListener('keydown', (ev) => {
					if (ev.key === 'Delete' || ev.key === 'Backspace') {
						ev.preventDefault();
						select(kf.id);
						deleteSelected();
					} else if (ev.key === 'Enter' || ev.key === ' ') {
						ev.preventDefault();
						select(kf.id);
					}
				});
				tl.lane.appendChild(diamond);
			}
			refreshExportEnabled();
			updateSelectionUI();
		}

		// ── Keyframe ops ──────────────────────────────────────────────────────────
		function select(id) {
			anim.selectedId = id;
			const kf = doc.keyframes.find((k) => k.id === id);
			updateSelectionUI();
			if (kf) setPlayhead(kf.time, { render: true });
		}

		function captureKeyframe() {
			if (!state.rig) return;
			const existed = doc.keyframes.some((k) => Math.abs(k.time - anim.playhead) <= 1e-3);
			const kf = upsertKeyframe(doc, anim.playhead, state.rig.getPose(), DEFAULT_EASING);
			anim.selectedId = kf.id;
			renderKeyframes();
			setStatus(
				existed
					? `Keyframe updated at ${kf.time.toFixed(2)}s.`
					: `Keyframe added at ${kf.time.toFixed(2)}s · ${doc.keyframes.length} total.`,
			);
		}

		function deleteSelected() {
			if (!anim.selectedId) return;
			removeKeyframe(doc, anim.selectedId);
			anim.selectedId = null;
			renderKeyframes();
			applyPreview();
			setStatus('Keyframe deleted.');
		}

		// Drag a keyframe diamond to retime it (and scrub the playhead with it).
		function startKeyDrag(ev, kf, diamond) {
			ev.stopPropagation();
			ev.preventDefault();
			pause();
			select(kf.id);
			diamond.setPointerCapture(ev.pointerId);
			const onMove = (e) => {
				// moveKeyframe re-sorts the list, so live preview (sampleAtTime,
				// which assumes sorted keyframes) stays correct mid-drag.
				moveKeyframe(doc, kf.id, xToTime(e.clientX));
				diamond.style.left = `${pct(kf.time)}%`;
				diamond.title = `${kf.time.toFixed(2)}s · ${kf.easing}`;
				setPlayhead(kf.time);
			};
			const onUp = (e) => {
				diamond.removeEventListener('pointermove', onMove);
				diamond.removeEventListener('pointerup', onUp);
				diamond.removeEventListener('pointercancel', onUp);
				try {
					diamond.releasePointerCapture(e.pointerId);
				} catch {}
				renderKeyframes();
				if (state.selectedBone) renderControlsPanel();
			};
			diamond.addEventListener('pointermove', onMove);
			diamond.addEventListener('pointerup', onUp);
			diamond.addEventListener('pointercancel', onUp);
		}

		// ── Track scrubbing ────────────────────────────────────────────────────────
		let scrubbing = false;
		tl.track.addEventListener('pointerdown', (ev) => {
			if (ev.target.closest('.tl-key')) return; // diamond handles its own drag
			pause();
			scrubbing = true;
			tl.track.setPointerCapture(ev.pointerId);
			setPlayhead(xToTime(ev.clientX), { render: true });
		});
		tl.track.addEventListener('pointermove', (ev) => {
			if (scrubbing) setPlayhead(xToTime(ev.clientX));
		});
		const endScrub = (ev) => {
			if (!scrubbing) return;
			scrubbing = false;
			try {
				tl.track.releasePointerCapture(ev.pointerId);
			} catch {}
			if (state.selectedBone) renderControlsPanel();
		};
		tl.track.addEventListener('pointerup', endScrub);
		tl.track.addEventListener('pointercancel', endScrub);
		tl.track.addEventListener('keydown', (ev) => {
			const stepDt = 1 / clamp(doc.fps || 30, 1, 120);
			if (ev.key === 'ArrowLeft') {
				ev.preventDefault();
				pause();
				setPlayhead(anim.playhead - stepDt, { render: true });
			} else if (ev.key === 'ArrowRight') {
				ev.preventDefault();
				pause();
				setPlayhead(anim.playhead + stepDt, { render: true });
			} else if (ev.key === 'Home') {
				ev.preventDefault();
				setPlayhead(0, { render: true });
			} else if (ev.key === 'End') {
				ev.preventDefault();
				setPlayhead(doc.duration, { render: true });
			}
		});

		// ── Controls ────────────────────────────────────────────────────────────────
		tl.play.addEventListener('click', toggle);
		tl.stop.addEventListener('click', stop);
		tl.start.addEventListener('click', () => {
			pause();
			setPlayhead(0, { render: true });
		});
		tl.end.addEventListener('click', () => {
			pause();
			setPlayhead(doc.duration, { render: true });
		});
		tl.loop.addEventListener('click', () => {
			doc.loop = !doc.loop;
			tl.loop.setAttribute('aria-pressed', String(doc.loop));
			setStatus(`Loop ${doc.loop ? 'on' : 'off'}.`);
		});
		tl.add.addEventListener('click', captureKeyframe);
		tl.del.addEventListener('click', deleteSelected);
		tl.easing.addEventListener('change', () => {
			if (!anim.selectedId) return;
			setKeyframeEasing(doc, anim.selectedId, tl.easing.value);
			applyPreview();
			setStatus(`Easing set to ${tl.easing.value}.`);
		});
		tl.name.addEventListener('input', () => {
			doc.name = tl.name.value.trim() || 'animation';
		});
		tl.duration.addEventListener('change', () => {
			doc.duration = clamp(parseFloat(tl.duration.value) || 4, 0.25, 120);
			tl.duration.value = String(doc.duration);
			tl.track.setAttribute('aria-valuemax', String(doc.duration));
			clampKeyframesToDuration(doc);
			renderRuler();
			renderKeyframes();
			setPlayhead(Math.min(anim.playhead, doc.duration), { render: true });
		});
		tl.fps.addEventListener('change', () => {
			doc.fps = Math.round(clamp(parseFloat(tl.fps.value) || 30, 1, 120));
			tl.fps.value = String(doc.fps);
		});

		// ── Export ────────────────────────────────────────────────────────────────
		function downloadBlob(data, filename, mime) {
			const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
		}
		async function withBusy(btn, label, fn, opts = {}) {
			const original = btn.textContent;
			btn.classList.remove('is-ok', 'is-err');
			btn.classList.add('is-busy');
			btn.textContent = opts.busyText || 'Working…';
			try {
				await fn();
				btn.classList.replace('is-busy', 'is-ok');
				btn.textContent = opts.okText || 'Saved ✓';
				setStatus(opts.doneStatus || `${label} downloaded.`);
			} catch (err) {
				btn.classList.replace('is-busy', 'is-err');
				btn.textContent = 'Failed';
				setStatus(`${label} failed: ${err.message}`, 'error');
			} finally {
				setTimeout(() => {
					btn.classList.remove('is-ok', 'is-err');
					btn.textContent = original;
				}, 2200);
			}
		}

		tl.exportJson.addEventListener('click', () => {
			pause();
			withBusy(tl.exportJson, 'Clip JSON', async () => {
				const json = serializeClip(doc, { resolveBoneName: (k) => k, rootName: 'Hips' });
				downloadBlob(
					JSON.stringify(json, null, 2),
					`${safeName()}.json`,
					'application/json',
				);
			});
		});
		// Bake the keyframe document onto the live rig and serialize the rig
		// (mesh + embedded clip) to a binary GLB. The clip's tracks bind to the
		// rig's ACTUAL node names so the animation plays against this same model
		// when re-imported anywhere (download, or the Scene Studio handoff).
		async function bakeAnimatedGlb() {
			const rig = state.rig;
			const clip = bakeClip(doc, {
				resolveBoneName: (k) => rig.getNode(k)?.name || null,
				rootName: rig.root?.name || '',
			});
			const exporter = new GLTFExporter();
			const buffer = await exporter.parseAsync(rig.root, {
				binary: true,
				animations: [clip],
				embedImages: true,
			});
			return { buffer, clip };
		}

		tl.exportGlb.addEventListener('click', () => {
			pause();
			withBusy(tl.exportGlb, 'Animated GLB', async () => {
				const { buffer } = await bakeAnimatedGlb();
				downloadBlob(buffer, `${safeName()}.glb`, 'model/gltf-binary');
			});
		});

		// Hand the animation to /scene (the three.js editor) as a recordable
		// timeline track. We stash the baked GLB in IndexedDB and navigate —
		// navigating only after the write resolves, so the studio never opens to
		// an empty handoff. Same-tab so a popup blocker can't swallow it.
		tl.openScene?.addEventListener('click', () => {
			pause();
			withBusy(
				tl.openScene,
				'Scene Studio',
				async () => {
					const { buffer, clip } = await bakeAnimatedGlb();
					const label = (state.avatar?.name || doc.name || 'Animation')
						.toString()
						.slice(0, 64);
					await putSceneHandoff({ glb: buffer, name: label, animationName: clip.name });
					window.location.assign('/scene?handoff=1');
				},
				{
					busyText: 'Opening…',
					okText: 'Opening ↗',
					doneStatus: 'Opening Scene Studio — use Render ▸ Video to record.',
				},
			);
		});

		// ── Keyboard (timeline) ──────────────────────────────────────────────────────
		window.addEventListener('keydown', (ev) => {
			if (ev.target.matches('input, textarea, select') || ev.target.closest('.tl-key'))
				return;
			if (ev.key === ' ') {
				ev.preventDefault();
				toggle();
			} else if (ev.key === 'k' || ev.key === 'K') {
				captureKeyframe();
			} else if ((ev.key === 'Delete' || ev.key === 'Backspace') && anim.selectedId) {
				ev.preventDefault();
				deleteSelected();
			} else if (ev.key === 'Home') {
				setPlayhead(0, { render: true });
			} else if (ev.key === 'End') {
				setPlayhead(doc.duration, { render: true });
			}
		});

		// ── Init ────────────────────────────────────────────────────────────────────
		renderRuler();
		renderKeyframes();
		setPlayhead(0);

		// Snapshot the editing document (deep clone) for saving.
		function getDocument() {
			return {
				name: doc.name,
				duration: doc.duration,
				fps: doc.fps,
				loop: doc.loop,
				keyframes: doc.keyframes.map((k) => ({
					id: k.id,
					time: k.time,
					easing: k.easing,
					pose: {
						bones: { ...k.pose.bones },
						rootPosition: { ...(k.pose.rootPosition || { x: 0, y: 0, z: 0 }) },
					},
				})),
			};
		}

		// Replace the editing document (reopening a saved clip). Rebuilds the
		// timeline and applies the first frame so the rig reflects the animation.
		function loadDocument(nd) {
			if (!nd) return;
			pause();
			doc.name = nd.name || 'animation';
			doc.duration = clamp(Number(nd.duration) || 4, 0.25, 120);
			doc.fps = Math.round(clamp(Number(nd.fps) || 30, 1, 240));
			doc.loop = nd.loop !== false;
			doc.keyframes = (nd.keyframes || [])
				.map((k, i) => ({
					id: typeof k.id === 'string' && k.id ? k.id : `kf_load_${i}`,
					time: clamp(Number(k.time) || 0, 0, doc.duration),
					easing: EASINGS[k.easing] ? k.easing : DEFAULT_EASING,
					pose:
						k.pose && k.pose.bones
							? {
									bones: { ...k.pose.bones },
									rootPosition: k.pose.rootPosition || { x: 0, y: 0, z: 0 },
								}
							: { bones: {} },
				}))
				.sort((a, b) => a.time - b.time);
			anim.selectedId = null;
			tl.name.value = doc.name;
			tl.duration.value = String(doc.duration);
			tl.fps.value = String(doc.fps);
			tl.loop.setAttribute('aria-pressed', String(doc.loop));
			tl.track.setAttribute('aria-valuemax', String(doc.duration));
			renderRuler();
			renderKeyframes();
			setPlayhead(0, { render: true });
		}

		return {
			update: advance,
			pause,
			onRigChanged: () => {
				if (doc.keyframes.length) applyPreview();
			},
			bake: () => bakeClip(doc, { resolveBoneName: (k) => k, rootName: 'Hips' }),
			serialize: () => serializeClip(doc, { resolveBoneName: (k) => k, rootName: 'Hips' }),
			// Bake the live rig (mesh + embedded clip) to a self-contained binary
			// GLB — the sellable artifact for a marketplace listing.
			bakeArtifact: () => bakeAnimatedGlb(),
			captureThumbnail: () => {
				renderer.render(scene, camera);
				return renderer.domElement.toDataURL('image/png');
			},
			getDocument,
			loadDocument,
			keyframeCount: () => doc.keyframes.length,
		};
	}

	// Local crash-recovery for in-progress timeline work. Returns null when the
	// page has no timeline (the studio markup is absent) so callers no-op safely.
	function setupAutosave() {
		if (!timeline) return null;
		const DRAFT_KEY = 'pose-studio:draft:v2';
		// savedBaseline = the document JSON at the last persisted point (account
		// save or open). lastDraftJson tracks what we last wrote to localStorage so
		// the interval skips redundant writes.
		let savedBaseline = JSON.stringify(timeline.getDocument());
		let lastDraftJson = null;

		const currentJson = () => JSON.stringify(timeline.getDocument());

		const readDraft = () => {
			try {
				return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
			} catch {
				return null;
			}
		};
		const clearDraft = () => {
			try {
				localStorage.removeItem(DRAFT_KEY);
			} catch {
				/* storage blocked — nothing to clear */
			}
		};

		function hasUnsavedWork() {
			const doc = timeline.getDocument();
			return doc.keyframes.length > 0 && currentJson() !== savedBaseline;
		}

		function persistDraft() {
			const cur = currentJson();
			if (cur === lastDraftJson) return;
			lastDraftJson = cur;
			const doc = timeline.getDocument();
			// Only stash genuine, not-yet-saved work — never an empty doc or a
			// document that already matches the persisted baseline.
			if (!doc.keyframes.length || cur === savedBaseline) {
				clearDraft();
				return;
			}
			try {
				localStorage.setItem(
					DRAFT_KEY,
					JSON.stringify({ doc, savedAt: Date.now(), avatarId: state.avatar?.id || null }),
				);
			} catch {
				/* quota / private mode — recovery simply unavailable this session */
			}
		}

		// Called when the document reaches a persisted state (saved to the account
		// or freshly opened from it): reset the baseline and drop the local draft.
		function markSaved() {
			savedBaseline = currentJson();
			lastDraftJson = null;
			clearDraft();
		}

		// Offer the previous session's unsaved draft back. Restored work stays
		// "unsaved" (it isn't in the account yet), so the unload guard keeps
		// protecting it until the user Saves.
		function tryRestore() {
			const saved = readDraft();
			const count = saved?.doc?.keyframes?.length || 0;
			if (!count) return false;
			timeline.loadDocument(saved.doc);
			lastDraftJson = currentJson();
			const when = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString() : 'a previous session';
			setStatus(
				`Recovered your unsaved animation — ${count} keyframe${count === 1 ? '' : 's'} from ${when}. Save it to keep it.`,
			);
			return true;
		}

		const interval = setInterval(persistDraft, 1500);
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) persistDraft();
		});
		window.addEventListener('beforeunload', (ev) => {
			persistDraft();
			if (hasUnsavedWork()) {
				ev.preventDefault();
				ev.returnValue = '';
			}
		});
		window.addEventListener('pagehide', () => clearInterval(interval));

		return { markSaved, tryRestore, hasUnsavedWork };
	}

	// ── Account: save + "My animations" library ──────────────────────────────
	const library = new PoseLibrary({
		getDocument: () => timeline.getDocument(),
		loadDocument: (d) => {
			timeline.loadDocument(d);
			autosave?.markSaved();
		},
		onSaved: () => autosave?.markSaved(),
		serializeClip: () => timeline.serialize(),
		bakeArtifact: () => timeline.bakeArtifact(),
		captureThumbnail: () => timeline.captureThumbnail(),
		keyframeCount: () => timeline.keyframeCount(),
		currentAvatarId: () => state.avatar?.id || null,
		currentAvatarName: () => state.avatar?.name || null,
		loadAvatarById: (id) => loadAvatarById(id),
		switchToMannequin: () => switchToMannequin(),
		setStatus: (m, k) => setStatus(m, k),
	});
	state.library = library;
	library.mount();

	// ── Boot: honor ?avatar=, ?src= and ?anim= ───────────────────────────────
	const _params = new URL(window.location.href).searchParams;
	const requestedAvatar = _params.get('avatar');
	// ?src=<glb url> loads a model straight off its URL (the /viewer "Animate"
	// funnel). Same trusted-host gate as every other model-URL query param.
	const rawSrc = _params.get('src') || '';
	const requestedSrc = isSafeQueryModelUrl(rawSrc) ? rawSrc : '';
	const requestedAnim = _params.get('anim');

	if (rawSrc && !requestedSrc) {
		setStatus('That model link is not from a trusted host. Pick an avatar instead.', 'error');
	}

	// An explicit ?anim= or model deep-link wins over any recovered draft;
	// otherwise we offer back last session's unsaved work.
	const recovered = !requestedAnim && !requestedSrc && autosave?.tryRestore();

	// A 36-char UUID is a saved community clip (PoseLibrary.openById); anything
	// else is a built-in preset name from the animation library (AnimationLibrary
	// .openByName). The /animations gallery deep-links into both.
	const openRequestedAnim = (id) => {
		const isApiId = /^[0-9a-f-]{36}$/i.test(id);
		const p = isApiId
			? library.openById(id)
			: state.animLibrary
				? state.animLibrary.openByName(id)
				: Promise.reject(new Error('animation library unavailable'));
		return p.catch((err) => {
			setStatus(`Could not load animation: ${err?.message || 'unknown error'}`, 'error');
		});
	};

	if (requestedAvatar) {
		loadAvatarById(requestedAvatar).catch((err) => {
			setStatus(`${err.message} Showing the mannequin instead.`, 'error');
			switchToMannequin();
		}).then(() => {
			if (requestedAnim) openRequestedAnim(requestedAnim);
		});
	} else if (requestedSrc) {
		// /viewer funnel: animate a freshly generated GLB by URL. A model with no
		// humanoid skeleton can't be posed; say so and fall back to the mannequin.
		loadAvatarFromUrl(requestedSrc, { name: _params.get('title') || 'Imported model' })
			.catch((err) => {
				setStatus(`${err?.message || 'Could not load that model.'} Showing the mannequin instead.`, 'error');
				switchToMannequin();
			})
			.then(() => {
				if (requestedAnim) openRequestedAnim(requestedAnim);
			});
	} else if (requestedAnim) {
		// Deep-linked to an animation with no avatar chosen (the /animations
		// gallery "Open in Studio" path). Presets need a rigged figure to play on,
		// so auto-load one of the built-in avatars — varied by clip so the gallery
		// doesn't feel like it only ships one character — then play the clip live.
		const model = pickDeepLinkAvatar(requestedAnim);
		setStatus(`Loading ${model.name} to preview this animation…`);
		loadAvatarFromUrl(model.url, { name: model.name })
			.catch((err) => {
				log.warn('[pose] deep-link avatar load failed:', err?.message);
				switchToMannequin();
			})
			.then(() => openRequestedAnim(requestedAnim));
	} else {
		if (!recovered) setStatus('Ready. Click a body part to pose, or load an avatar.');
	}
}

// Built-in rigged avatars that retarget the full canonical clip library cleanly
// (verified 52/52 canonical bones). Used when a visitor deep-links straight to
// an animation without picking an avatar — the clip needs a body to play on.
const DEEP_LINK_AVATARS = [
	{ url: '/avatars/cz.glb', name: 'CZ' },
	{ url: '/avatars/michelle.glb', name: 'Michelle' },
	{ url: '/avatars/realistic-female.glb', name: 'Ada' },
	{ url: '/avatars/realistic-male.glb', name: 'Max' },
	{ url: '/avatars/xbot.glb', name: 'X Bot' },
	{ url: '/avatars/selfie-girl.glb', name: 'Nova' },
];

// Deterministic pick from the clip id, so the same animation always previews on
// the same avatar (a shared link looks identical for everyone) while different
// animations spread across the roster.
function pickDeepLinkAvatar(animId) {
	let hash = 0;
	for (let i = 0; i < animId.length; i++) hash = (hash * 31 + animId.charCodeAt(i)) >>> 0;
	return DEEP_LINK_AVATARS[hash % DEEP_LINK_AVATARS.length];
}

document.addEventListener('DOMContentLoaded', boot);
