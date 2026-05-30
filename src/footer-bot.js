import {
	WebGLRenderer,
	ACESFilmicToneMapping,
	SRGBColorSpace,
	Scene,
	PerspectiveCamera,
	MathUtils,
	AmbientLight,
	DirectionalLight,
	Clock,
	AnimationMixer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { reserveWebGLContext } from './webgl-budget.js';

const canvas = document.getElementById('footer-bot-canvas');
if (!canvas) throw new Error('[footer-bot] canvas not found');

const parent = canvas.parentElement;
const w = parent?.clientWidth || 300;
const h = parent?.clientHeight || 400;

const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(w, h);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.7;
renderer.outputColorSpace = SRGBColorSpace;
// Count this context against the shared budget so <agent-3d> grids on the same
// page leave room for it (see webgl-budget.js / element.js).
reserveWebGLContext();

const scene = new Scene();

// Match model-viewer camera-orbit="0deg 80deg 9m" field-of-view="35deg"
const camera = new PerspectiveCamera(35, w / h, 0.1, 100);
const phi = MathUtils.degToRad(80);
camera.position.set(0, 9 * Math.cos(phi), 9 * Math.sin(phi));
camera.lookAt(0, 0, 0);

// Neutral environment (exposure 0.7, no shadows)
scene.add(new AmbientLight(0xffffff, 1.5));
const sun = new DirectionalLight(0xffffff, 2.0);
sun.position.set(1, 2, 3);
scene.add(sun);
const fill = new DirectionalLight(0xffffff, 0.5);
fill.position.set(-1, 1, -2);
scene.add(fill);

let mixer = null;
const clock = new Clock();
let robot = null;

new GLTFLoader().load('/animations/robotexpressive.glb', (gltf) => {
	robot = gltf.scene;
	scene.add(robot);
	if (gltf.animations.length > 0) {
		mixer = new AnimationMixer(robot);
		mixer.clipAction(gltf.animations[0]).play();
	}
});

// 20deg/sec auto-rotate, matching model-viewer rotation-per-second="20deg"
const rotSpeed = MathUtils.degToRad(20);

// The footer sits at the bottom of long pages, so it is offscreen most of the
// time. Only render while it is actually visible and the tab is focused —
// otherwise it burns a GPU context and a RAF loop for nothing.
let running = false;
let onScreen = true;

function animate() {
	if (!running) return;
	requestAnimationFrame(animate);
	const dt = clock.getDelta();
	if (mixer) mixer.update(dt);
	if (robot) robot.rotation.y += rotSpeed * dt;
	renderer.render(scene, camera);
}

function syncRunning() {
	const next = onScreen && document.visibilityState !== 'hidden';
	if (next === running) return;
	running = next;
	if (running) { clock.getDelta(); animate(); }
}

if (typeof IntersectionObserver !== 'undefined') {
	new IntersectionObserver((entries) => {
		onScreen = entries[0].isIntersecting;
		syncRunning();
	}, { threshold: 0 }).observe(canvas);
} else {
	onScreen = true;
}
document.addEventListener('visibilitychange', syncRunning);
syncRunning();

if (typeof ResizeObserver !== 'undefined' && parent) {
	new ResizeObserver(() => {
		const pw = parent.clientWidth || 300;
		const ph = parent.clientHeight || 400;
		camera.aspect = pw / ph;
		camera.updateProjectionMatrix();
		renderer.setSize(pw, ph);
	}).observe(parent);
}
