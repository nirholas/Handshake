/**
 * Marketplace 3D lobby — mounts a Three.js scene that renders 3-5 featured
 * avatars on a circular podium, with mouse-parallax camera and click-to-focus.
 *
 *   import { mountLobby, unmountLobby } from './marketplace-lobby.js';
 *   const handle = await mountLobby(canvas, featuredAvatars, { onSelect });
 *   handle.dispose();   // when navigating away
 *
 * Each avatar is a GLB URL. Loading is lazy/parallel; podium renders even
 * before any GLB resolves so the hero never looks empty.
 */

import {
	AmbientLight,
	Box3,
	BufferGeometry,
	CircleGeometry,
	Color,
	DirectionalLight,
	DoubleSide,
	Fog,
	Group,
	HemisphereLight,
	Mesh,
	MeshStandardMaterial,
	PMREMGenerator,
	PerspectiveCamera,
	Raycaster,
	Scene,
	Vector2,
	Vector3,
	WebGLRenderer,
	ACESFilmicToneMapping,
	SRGBColorSpace,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EffectComposer, RenderPass, SelectiveBloomEffect, EffectPass } from 'postprocessing';
import { getMeshoptDecoder } from './viewer/internal.js';

// Accelerate click-to-select raycasting with a BVH. Patches the Three.js
// prototypes once at module load — idempotent if the main viewer already did so.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

const SLOT_SPACING = 1.6; // metres between avatar centres
const PODIUM_RADIUS = 0.55;
const PODIUM_HEIGHT = 0.05;
const TARGET_HEIGHT = 1.6; // Avatars are scaled so bbox.height ≈ this.

export async function mountLobby(canvas, avatars, options = {}) {
	const { onSelect } = options;
	if (!canvas || !canvas.getContext) throw new Error('canvas required');
	const slots = (avatars || []).slice(0, 5);
	if (!slots.length) return { dispose: () => {} };

	const renderer = new WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: 'high-performance',
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const scene = new Scene();
	scene.background = null;
	scene.fog = new Fog(0x07090c, 6, 14);

	const camera = new PerspectiveCamera(28, 1, 0.1, 100);
	const baseCamPos = new Vector3(0, 1.55, 5.6);
	camera.position.copy(baseCamPos);
	camera.lookAt(0, 1.0, 0);

	// Lighting: hemisphere + warm key + cool rim, plus environment for PBR.
	scene.add(new AmbientLight(0xffffff, 0.18));
	scene.add(new HemisphereLight(0xfde68a, 0x0a0a0a, 0.45));

	const key = new DirectionalLight(0xfff7ed, 1.4);
	key.position.set(2.5, 4, 3);
	scene.add(key);

	const rim = new DirectionalLight(0x7dd3fc, 0.8);
	rim.position.set(-3, 2, -2);
	scene.add(rim);

	const accent = new DirectionalLight(0xc4b5fd, 0.5);
	accent.position.set(0, 1.2, -3);
	scene.add(accent);

	const pmrem = new PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	pmrem.dispose(); // environment baked — the generator's GPU targets are no longer needed

	// Podiums under each avatar slot.
	const podiumGroup = new Group();
	scene.add(podiumGroup);
	const slotsRoot = new Group();
	scene.add(slotsRoot);
	const startX = -((slots.length - 1) * SLOT_SPACING) / 2;
	const bloomSelection = [];
	const slotMeta = slots.map((_, i) => {
		const x = startX + i * SLOT_SPACING;
		const { group: podium, ring } = makePodium();
		podium.position.set(x, 0, 0);
		podiumGroup.add(podium);
		bloomSelection.push(ring);
		const slotGroup = new Group();
		slotGroup.position.set(x, PODIUM_HEIGHT, 0);
		slotsRoot.add(slotGroup);
		return { x, group: slotGroup, model: null };
	});

	// Post-processing: merge a single fullscreen pass with selective bloom so the
	// emissive podium rings glow without blooming the avatars sitting on them.
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const bloomEffect = new SelectiveBloomEffect(scene, camera, {
		intensity: 1.8,
		luminanceThreshold: 0.05,
		luminanceSmoothing: 0.3,
		mipmapBlur: true,
	});
	bloomEffect.selection.set(bloomSelection);
	const effectPass = new EffectPass(camera, bloomEffect);
	effectPass.renderToScreen = true;
	composer.addPass(effectPass);

	// Lazy-load GLBs in parallel; if one fails, the other slots still render.
	// Baked avatars use EXT_meshopt_compression, so the loader needs the
	// matching decoder before it can parse them.
	const loader = new GLTFLoader();
	const decoderReady = getMeshoptDecoder().then((dec) => loader.setMeshoptDecoder(dec));
	slots.forEach((avatar, i) => {
		const url = avatar?.glbUrl;
		if (!url) return;
		decoderReady.then(() => {
			loader.load(
				url,
				(gltf) => {
					const root = gltf.scene || gltf.scenes?.[0];
					if (!root) return;
					fitToHeight(root, TARGET_HEIGHT);
					// Build a BVH per mesh so click raycasts are O(log n), not per-triangle.
					root.traverse((node) => {
						if (node.isMesh && node.geometry?.attributes?.position?.count) {
							node.geometry.computeBoundsTree();
						}
					});
					slotMeta[i].group.add(root);
					slotMeta[i].model = root;
					slotMeta[i].avatar = avatar;
				},
				undefined,
				(err) => console.warn('[lobby] failed to load', url, err?.message),
			);
		});
	});

	// Mouse-parallax: camera drifts a little toward the cursor.
	const mouse = new Vector2(0, 0);
	const targetCamOffset = new Vector3();
	const onPointerMove = (e) => {
		const rect = canvas.getBoundingClientRect();
		mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		mouse.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
	};
	canvas.addEventListener('pointermove', onPointerMove);

	// Click-to-select: raycast at the slot groups.
	const raycaster = new Raycaster();
	const onClick = (e) => {
		const rect = canvas.getBoundingClientRect();
		const ndc = new Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-(((e.clientY - rect.top) / rect.height) * 2 - 1),
		);
		raycaster.setFromCamera(ndc, camera);
		// Walk up from intersected mesh to find the slot group; check x position.
		const hits = raycaster.intersectObjects(slotsRoot.children, true);
		if (hits[0] && onSelect) {
			let node = hits[0].object;
			while (node && node.parent && node.parent !== slotsRoot) node = node.parent;
			const idx = slotsRoot.children.indexOf(node);
			if (idx >= 0 && slotMeta[idx]?.avatar) onSelect(slotMeta[idx].avatar, idx);
		}
	};
	canvas.addEventListener('click', onClick);
	canvas.style.cursor = 'pointer';

	// Resize observer keeps the renderer in sync with the host element.
	let width = 1;
	let height = 1;
	const ro = new ResizeObserver(() => resize());
	ro.observe(canvas);
	function resize() {
		const rect = canvas.getBoundingClientRect();
		width = Math.max(1, Math.floor(rect.width));
		height = Math.max(1, Math.floor(rect.height));
		renderer.setSize(width, height, false);
		composer.setSize(width, height);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}
	resize();

	// Pause rendering while the canvas is scrolled out of view — saves GPU.
	let visible = true;
	const io = new IntersectionObserver(
		([entry]) => {
			visible = entry.isIntersecting;
		},
		{ threshold: 0.01 },
	);
	io.observe(canvas);

	// Render loop with subtle scene rotation + camera parallax + per-slot spin.
	let alive = true;
	let lastT = performance.now();
	function tick() {
		if (!alive) return;
		rafId = requestAnimationFrame(tick);
		const now = performance.now();
		const dt = (now - lastT) / 1000;
		lastT = now;
		if (!visible) return; // off-screen: skip render, keep the RAF alive for return

		// Slow constant rotation of each loaded avatar (idle showcase).
		for (const slot of slotMeta) {
			if (slot.model) slot.model.rotation.y += dt * 0.35;
		}
		// Gentle podium counter-rotation for visual cohesion.
		podiumGroup.rotation.y -= dt * 0.05;

		// Camera parallax — eased toward mouse position.
		targetCamOffset.set(mouse.x * 0.45, -mouse.y * 0.18, 0);
		camera.position.lerp(baseCamPos.clone().add(targetCamOffset), 0.06);
		camera.lookAt(0, 1.05, 0);

		composer.render();
	}
	let rafId = requestAnimationFrame(tick);

	function dispose() {
		alive = false;
		cancelAnimationFrame(rafId);
		ro.disconnect();
		io.disconnect();
		canvas.removeEventListener('pointermove', onPointerMove);
		canvas.removeEventListener('click', onClick);
		// Free GPU resources.
		scene.traverse((obj) => {
			if (obj.geometry) {
				obj.geometry.disposeBoundsTree?.();
				obj.geometry.dispose?.();
			}
			if (obj.material) {
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const m of mats) {
					for (const k in m) {
						const v = m[k];
						if (v && typeof v.dispose === 'function' && v.isTexture) v.dispose();
					}
					m.dispose?.();
				}
			}
		});
		composer.dispose();
		renderer.dispose();
	}

	return { dispose };
}

// ── helpers ──────────────────────────────────────────────────────────────

function makePodium() {
	const g = new Group();
	const top = new Mesh(
		new CircleGeometry(PODIUM_RADIUS, 48),
		new MeshStandardMaterial({
			color: new Color(0x111317),
			metalness: 0.4,
			roughness: 0.55,
			side: DoubleSide,
		}),
	);
	top.rotation.x = -Math.PI / 2;
	top.position.y = PODIUM_HEIGHT;
	g.add(top);

	const ring = new Mesh(
		new CircleGeometry(PODIUM_RADIUS * 1.18, 64),
		new MeshStandardMaterial({
			color: new Color(0x7dd3fc),
			emissive: new Color(0x1a3a4d),
			emissiveIntensity: 0.4,
			metalness: 0.6,
			roughness: 0.3,
			transparent: true,
			opacity: 0.18,
		}),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.001;
	g.add(ring);

	return { group: g, ring };
}

function fitToHeight(object, targetHeight) {
	const box = new Box3().setFromObject(object);
	const size = new Vector3();
	box.getSize(size);
	if (size.y <= 0) return;
	const scale = targetHeight / size.y;
	object.scale.setScalar(scale);
	// Re-measure to find the min Y after scaling, so the model sits flush on the podium.
	const box2 = new Box3().setFromObject(object);
	const minY = box2.min.y;
	const center = new Vector3();
	box2.getCenter(center);
	object.position.x -= center.x;
	object.position.z -= center.z;
	object.position.y -= minY;
}
