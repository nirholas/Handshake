// The 3D stage behind /diff.
//
// A change set tells you a mesh moved. Seeing it move is what makes the change
// obvious, so this renders both models in the same scene and offers the three
// ways people actually compare things:
//
//   overlay   the baseline as a translucent ghost, the candidate solid on top
//   wipe      one screen-aligned clipping plane, dragged across the view
//   split     both models placed side by side, orbiting together
//
// The wipe plane is rebuilt from the camera basis every frame rather than fixed
// to world X. A plane pinned to a world axis stops being a wipe the moment you
// orbit: it slices the models diagonally and then edge-on. Deriving it from the
// camera's right vector keeps the seam vertical on screen no matter where the
// camera is, which is the only version that reads as a wipe.
//
// Loaded lazily by src/model-diff.js: three.js plus the glTF loader stack is by
// far the heaviest thing on the page, and a visitor who reads the explainer and
// leaves should not pay for it.

import {
	AmbientLight,
	AnimationMixer,
	Box3,
	Color,
	DirectionalLight,
	Group,
	MeshStandardMaterial,
	PMREMGenerator,
	PerspectiveCamera,
	Plane,
	Scene,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getDecoders } from './viewer/internal.js';

// Ghost blue for the baseline, warm amber for edits, green for additions, red
// for what is gone. The same five values the page legend prints, so the picture
// and the caption can never drift apart.
const COLOR = {
	before: 0x60a5fa,
	changed: 0xfbbf24,
	added: 0x4ade80,
	removed: 0xf87171,
};

let loaderPromise = null;
function getLoader() {
	if (!loaderPromise) {
		loaderPromise = getDecoders().then(({ dracoLoader, ktx2Loader, meshoptDecoder }) => {
			const loader = new GLTFLoader();
			loader.setDRACOLoader(dracoLoader);
			loader.setKTX2Loader(ktx2Loader);
			loader.setMeshoptDecoder(meshoptDecoder);
			return loader;
		});
	}
	return loaderPromise;
}

// Rebuild the same node paths describe.js produces, against the loaded scene
// graph, so a row in the report can point at an object in the viewport. glTF
// node names survive on `userData.name`; `object.name` has been through three's
// PropertyBinding sanitizer and would not match a path built from the file.
function indexByPath(root) {
	const byPath = new Map();
	const seen = new Set();
	let index = 0;

	const visit = (object, parentPath) => {
		const raw = object.userData?.name || object.name || `#node.${index}`;
		const path = parentPath ? `${parentPath}/${raw}` : raw;
		let unique = path;
		let bump = 1;
		while (seen.has(unique)) unique = `${path}#${bump++}`;
		seen.add(unique);
		byPath.set(unique, object);
		index++;
		for (const child of object.children) visit(child, unique);
	};

	for (const child of root.children) visit(child, '');
	return byPath;
}

function disposeObject(object) {
	object.traverse((node) => {
		if (node.geometry) node.geometry.dispose();
		const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
		for (const material of materials) {
			for (const value of Object.values(material)) {
				if (value && value.isTexture) value.dispose();
			}
			material.dispose();
		}
	});
}

class Side {
	constructor(role) {
		this.role = role;
		this.group = new Group();
		this.root = null;
		this.mixer = null;
		this.clips = [];
		this.byPath = new Map();
		this.originalMaterials = new Map();
		this.overrides = new Set();
		this.clipPlanes = [];
	}

	adopt(scene, animations) {
		this.clear();
		this.root = scene;
		this.group.add(scene);
		this.byPath = indexByPath(scene);
		this.clips = animations || [];
		this.mixer = this.clips.length ? new AnimationMixer(scene) : null;
		scene.traverse((node) => {
			if (node.isMesh || node.isSkinnedMesh) this.originalMaterials.set(node, node.material);
		});
	}

	clear() {
		if (this.root) {
			this.group.remove(this.root);
			disposeObject(this.root);
		}
		for (const material of this.overrides) material.dispose();
		this.overrides.clear();
		this.originalMaterials.clear();
		this.byPath.clear();
		this.root = null;
		this.mixer = null;
		this.clips = [];
	}

	get loaded() {
		return Boolean(this.root);
	}

	// Swap in a generated material while remembering the authored one, so
	// toggling highlight off restores exactly what the file shipped.
	override(node, build) {
		const original = this.originalMaterials.get(node);
		if (!original) return;
		const source = Array.isArray(original) ? original[0] : original;
		const material = build(source);
		this.overrides.add(material);
		node.material = material;
	}

	restore() {
		for (const [node, material] of this.originalMaterials) node.material = material;
		for (const material of this.overrides) material.dispose();
		this.overrides.clear();
	}

	applyClipPlanes(planes) {
		this.clipPlanes = planes;
		const walk = (material) => {
			material.clippingPlanes = planes.length ? planes : null;
			material.clipShadows = true;
			material.needsUpdate = true;
		};
		this.group.traverse((node) => {
			const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
			for (const material of materials) walk(material);
		});
	}
}

/**
 * Mount the comparison stage inside `container`.
 * @param {HTMLElement} container
 */
export async function createDiffStage(container) {
	const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.localClippingEnabled = true;
	container.appendChild(renderer.domElement);

	const scene = new Scene();
	scene.background = new Color(0x0a0a0a);

	const pmrem = new PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

	scene.add(new AmbientLight(0xffffff, 0.35));
	const key = new DirectionalLight(0xffffff, 1.6);
	key.position.set(2.5, 4, 3);
	scene.add(key);

	const camera = new PerspectiveCamera(45, 1, 0.01, 2000);
	camera.position.set(0, 1.4, 3.4);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.target.set(0, 0.9, 0);

	const sides = { a: new Side('a'), b: new Side('b') };
	scene.add(sides.a.group, sides.b.group);

	const state = {
		mode: 'overlay',
		wipe: 0.5,
		highlight: true,
		playing: false,
		// Node paths, straight from the change set: `removed` exists only in the
		// baseline, `added` only in the candidate, `edited` in both but different.
		removed: new Set(),
		added: new Set(),
		edited: new Set(),
		disposed: false,
		visible: true,
	};

	// Frame delta from the loop's own timestamp. three.js deprecated Clock in
	// favour of Timer, and an addon import for one subtraction is not worth the
	// bytes on a page that already lazy-loads the whole renderer.
	let lastFrame = 0;
	const planeA = new Plane();
	const planeB = new Plane();
	const right = new Vector3();
	const seam = new Vector3();
	const center = new Vector3();
	const size = new Vector3();
	const box = new Box3();

	// ── Framing ────────────────────────────────────────────────────────────

	function unionBox() {
		box.makeEmpty();
		for (const side of Object.values(sides)) {
			if (side.loaded) box.expandByObject(side.root);
		}
		return box;
	}

	function frameAll() {
		const bounds = unionBox();
		if (bounds.isEmpty()) return;
		bounds.getCenter(center);
		bounds.getSize(size);
		const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
		const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.5;
		controls.target.copy(center);
		camera.position.set(center.x + distance * 0.25, center.y + radius * 0.35, center.z + distance);
		camera.near = Math.max(distance / 500, 0.001);
		camera.far = distance * 20;
		camera.updateProjectionMatrix();
		controls.update();
	}

	function focus(object) {
		if (!object) return;
		const bounds = new Box3().setFromObject(object);
		if (bounds.isEmpty()) return;
		const target = new Vector3();
		const extent = new Vector3();
		bounds.getCenter(target);
		bounds.getSize(extent);
		const radius = Math.max(extent.x, extent.y, extent.z, 0.05) * 0.5;
		const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 2.4;
		const direction = camera.position.clone().sub(controls.target).normalize();
		controls.target.copy(target);
		camera.position.copy(target).addScaledVector(direction, distance);
		camera.updateProjectionMatrix();
		controls.update();
	}

	// ── Presentation ───────────────────────────────────────────────────────

	function ghostMaterial() {
		return new MeshStandardMaterial({
			color: COLOR.before,
			transparent: true,
			opacity: 0.28,
			depthWrite: false,
			roughness: 0.9,
			metalness: 0,
		});
	}

	function tintMaterial(source, color, opacity = 1) {
		const material = new MeshStandardMaterial({
			color,
			emissive: new Color(color).multiplyScalar(0.35),
			roughness: 0.55,
			metalness: 0.05,
			transparent: opacity < 1,
			opacity,
			depthWrite: opacity >= 1,
		});
		if (source?.map) material.map = source.map;
		return material;
	}

	// Which objects wear which colour is decided here and nowhere else, so the
	// legend, the report rows, and the viewport always agree.
	function paint() {
		for (const side of Object.values(sides)) side.restore();
		if (!sides.a.loaded || !sides.b.loaded) return;

		const ghostA = state.mode === 'overlay';
		for (const [path, object] of sides.a.byPath) {
			const removed = state.highlight && state.removed.has(path);
			if (!ghostA && !removed) continue;
			object.traverse((node) => {
				if (!node.isMesh && !node.isSkinnedMesh) return;
				if (removed) sides.a.override(node, (source) => tintMaterial(source, COLOR.removed, ghostA ? 0.5 : 1));
				else sides.a.override(node, ghostMaterial);
			});
		}

		if (!state.highlight) return;
		for (const [path, object] of sides.b.byPath) {
			const isAdded = state.added.has(path);
			if (!isAdded && !state.edited.has(path)) continue;
			object.traverse((node) => {
				if (!node.isMesh && !node.isSkinnedMesh) return;
				sides.b.override(node, (source) => tintMaterial(source, isAdded ? COLOR.added : COLOR.changed));
			});
		}
	}

	function layout() {
		const bounds = unionBox();
		bounds.getSize(size);
		const separation = state.mode === 'split' ? Math.max(size.x, 0.5) * 0.62 : 0;
		sides.a.group.position.x = -separation;
		sides.b.group.position.x = separation;

		if (state.mode === 'wipe') {
			sides.a.applyClipPlanes([planeA]);
			sides.b.applyClipPlanes([planeB]);
		} else {
			sides.a.applyClipPlanes([]);
			sides.b.applyClipPlanes([]);
		}
		paint();
	}

	function updateWipePlanes() {
		if (state.mode !== 'wipe') return;
		unionBox().getCenter(center);
		right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
		const distance = camera.position.distanceTo(center);
		const halfWidth = Math.tan((camera.fov * Math.PI) / 360) * distance * camera.aspect;
		seam.copy(center).addScaledVector(right, (state.wipe - 0.5) * 2 * halfWidth);
		planeA.setFromNormalAndCoplanarPoint(right.clone().negate(), seam);
		planeB.setFromNormalAndCoplanarPoint(right.clone(), seam);
	}

	// ── Loop ───────────────────────────────────────────────────────────────

	renderer.setAnimationLoop((time) => {
		if (state.disposed || !state.visible) {
			lastFrame = time;
			return;
		}
		const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 0;
		lastFrame = time;
		if (state.playing) {
			for (const side of Object.values(sides)) side.mixer?.update(delta);
		}
		controls.update();
		updateWipePlanes();
		renderer.render(scene, camera);
	});

	function resize() {
		const width = container.clientWidth || 1;
		const height = container.clientHeight || 1;
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}

	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(container);
	resize();

	// A WebGL loop running against an off-screen canvas is pure battery drain on
	// a page whose report is long enough to scroll the viewer away.
	const visibility = new IntersectionObserver(
		(entries) => {
			state.visible = entries.some((entry) => entry.isIntersecting);
		},
		{ threshold: 0.01 },
	);
	visibility.observe(container);

	return {
		/**
		 * Load one side from raw bytes.
		 * @param {'a'|'b'} role
		 * @param {ArrayBuffer} buffer
		 */
		async setModel(role, buffer) {
			const loader = await getLoader();
			const gltf = await loader.parseAsync(buffer.slice(0), '');
			sides[role].adopt(gltf.scene, gltf.animations);
			frameAll();
			layout();
			return { clips: gltf.animations.map((clip) => clip.name) };
		},

		/**
		 * Colour the viewport from a change set: which node paths were removed
		 * from the baseline, and which were added or edited in the candidate.
		 */
		applyChangeSet(changeset) {
			state.removed = new Set(changeset.sections.nodes.removed.map((item) => item.name));
			state.added = new Set(changeset.sections.nodes.added.map((item) => item.name));
			state.edited = new Set([
				...changeset.sections.nodes.modified.map((item) => item.name),
				...changeset.sections.nodes.moved.map((item) => item.to),
			]);
			paint();
		},

		setMode(mode) {
			state.mode = mode;
			layout();
		},

		setWipe(fraction) {
			state.wipe = Math.min(1, Math.max(0, fraction));
		},

		setHighlight(on) {
			state.highlight = Boolean(on);
			paint();
		},

		setPlaying(on) {
			state.playing = Boolean(on);
			for (const side of Object.values(sides)) {
				if (!side.mixer) continue;
				if (on) {
					side.mixer.stopAllAction();
					const clip = side.clips[0];
					if (clip) side.mixer.clipAction(clip).reset().play();
				} else {
					side.mixer.stopAllAction();
				}
			}
		},

		hasClips() {
			return sides.a.clips.length > 0 || sides.b.clips.length > 0;
		},

		/** Frame one node by its diff path. Falls back to the other side when only one has it. */
		focusPath(path) {
			focus(sides.b.byPath.get(path) || sides.a.byPath.get(path));
		},

		frameAll,

		dispose() {
			state.disposed = true;
			renderer.setAnimationLoop(null);
			resizeObserver.disconnect();
			visibility.disconnect();
			controls.dispose();
			for (const side of Object.values(sides)) side.clear();
			pmrem.dispose();
			scene.environment?.dispose();
			renderer.dispose();
			renderer.domElement.remove();
		},
	};
}
