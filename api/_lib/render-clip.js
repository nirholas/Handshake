// Server-side renderer for the `render_avatar_clip` MCP tool and
// `/api/render/avatar-clip` HTTP endpoint.
//
// Boots headless chromium via puppeteer-core + @sparticuz/chromium-min,
// loads an inlined three.js viewer that:
//   1. Loads a GLB,
//   2. Optionally applies a pose preset's joint Euler rotations,
//   3. Frames the camera by the model's bounding box plus the requested
//      `cameraOrbit` (theta, phi, radius) in degrees / meters,
//   4. Renders one PNG.
//
// The same module powers both transparent OG cards and the full clip
// renderer — single source of truth for headless three.js rendering so the
// MCP tool, the OG card, and any future video renderer share lighting +
// framing.

// puppeteer-core + @sparticuz/chromium-min are loaded lazily inside getBrowser()
// so Vercel's NFT doesn't statically trace the chromium tree for every route
// that transitively imports this module — that trace caused 45-min build hangs.
import { env } from './env.js';
import { PRESETS } from '../../src/pose-presets.js';

const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';
const CHROMIUM_PACK = env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;
const THREE_VERSION = '0.176.0';

let _browserPromise = null;
async function getBrowser() {
	if (_browserPromise) return _browserPromise;
	_browserPromise = (async () => {
		const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
			import('puppeteer-core'),
			import('@sparticuz/chromium-min'),
		]);
		const executablePath = await chromium.executablePath(CHROMIUM_PACK);
		return puppeteer.launch({
			args: chromium.args,
			defaultViewport: { width: 1024, height: 1024, deviceScaleFactor: 1 },
			executablePath,
			headless: chromium.headless,
		});
	})().catch((err) => {
		_browserPromise = null;
		throw err;
	});
	return _browserPromise;
}

function poseById(id) {
	if (!id) return null;
	const found = PRESETS.find((p) => p.id === id);
	return found ? { id: found.id, label: found.label, pose: found.pose } : null;
}

function viewerHtml({ glbUrl, width, height, background, pose, cameraOrbit, expression }) {
	const bg = background === 'transparent' ? 'null' : JSON.stringify(background || '#0a0a0a');
	const poseJson = pose ? JSON.stringify(pose.pose) : 'null';
	const orbitJson = JSON.stringify(cameraOrbit || { theta: 0, phi: 80, radius: null });
	const expressionJson = JSON.stringify(expression || null);
	return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head><body>
<canvas id="c" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
<script type="importmap">{ "imports": {
	"three": "https://unpkg.com/three@${THREE_VERSION}/build/three.module.js",
	"three/addons/": "https://unpkg.com/three@${THREE_VERSION}/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

window.__renderDone = false;
window.__renderError = null;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(${width}, ${height}, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const bgColor = ${bg};
if (bgColor !== null) scene.background = new THREE.Color(bgColor);

const camera = new THREE.PerspectiveCamera(28, ${width}/${height}, 0.01, 100);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd6ff, 0.6); fill.position.set(-3, 1, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xc7a8ff, 0.5); rim.position.set(0, 2, -4); scene.add(rim);

const aliases = {
	shoulderl: ['leftshoulder','shoulder_l','l_shoulder','mixamorig:leftshoulder'],
	shoulderr: ['rightshoulder','shoulder_r','r_shoulder','mixamorig:rightshoulder'],
	elbowl: ['leftforearm','leftelbow','elbow_l','mixamorig:leftforearm','mixamorig:leftelbow'],
	elbowr: ['rightforearm','rightelbow','elbow_r','mixamorig:rightforearm','mixamorig:rightelbow'],
	wristl: ['lefthand','wrist_l','mixamorig:lefthand'],
	wristr: ['righthand','wrist_r','mixamorig:righthand'],
	hipl: ['leftupleg','hip_l','mixamorig:leftupleg'],
	hipr: ['rightupleg','hip_r','mixamorig:rightupleg'],
	kneel: ['leftleg','knee_l','mixamorig:leftleg'],
	kneer: ['rightleg','knee_r','mixamorig:rightleg'],
	anklel: ['leftfoot','ankle_l','mixamorig:leftfoot'],
	ankler: ['rightfoot','ankle_r','mixamorig:rightfoot'],
	head: ['head','mixamorig:head'],
	neck: ['neck','mixamorig:neck'],
	spine: ['spine','spine1','mixamorig:spine','mixamorig:spine1'],
	hips: ['hips','mixamorig:hips'],
};

function applyPose(root, poseMap) {
	if (!poseMap) return;
	const byName = new Map();
	root.traverse((o) => { if (o.name) byName.set(o.name.toLowerCase(), o); });
	function findJoint(k) {
		const key = k.toLowerCase();
		const direct = byName.get(key);
		if (direct) return direct;
		const list = aliases[key] || [];
		for (const a of list) { const j = byName.get(a); if (j) return j; }
		return null;
	}
	for (const [key, rot] of Object.entries(poseMap)) {
		const joint = findJoint(key);
		if (!joint) continue;
		joint.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
	}
}

function applyExpression(root, expression) {
	if (!expression || typeof expression !== 'object') return;
	root.traverse((o) => {
		if (!o.isMesh || !o.morphTargetDictionary || !o.morphTargetInfluences) return;
		for (const [name, value] of Object.entries(expression)) {
			const idx = o.morphTargetDictionary[name] ?? o.morphTargetDictionary[name.toLowerCase()];
			if (typeof idx === 'number') o.morphTargetInfluences[idx] = Number(value) || 0;
		}
	});
}

function frameCamera(root, orbit) {
	const box = new THREE.Box3().setFromObject(root);
	const size = new THREE.Vector3(); box.getSize(size);
	const center = new THREE.Vector3(); box.getCenter(center);
	root.position.sub(center);
	root.position.y += size.y * 0.05;
	const maxDim = Math.max(size.x, size.y, size.z);
	const fov = THREE.MathUtils.degToRad(camera.fov);
	const defaultDist = (maxDim / 2) / Math.tan(fov / 2) * 1.45;
	const radius = (typeof orbit.radius === 'number' && orbit.radius > 0) ? orbit.radius : defaultDist;
	const theta = THREE.MathUtils.degToRad(Number(orbit.theta) || 0);
	const phi = THREE.MathUtils.degToRad(Number(orbit.phi) || 80);
	const x = radius * Math.sin(phi) * Math.sin(theta);
	const y = radius * Math.cos(phi);
	const z = radius * Math.sin(phi) * Math.cos(theta);
	camera.position.set(x, y, z);
	camera.lookAt(0, 0, 0);
}

const orbit = ${orbitJson};
const poseMap = ${poseJson};
const expression = ${expressionJson};

new GLTFLoader().load(${JSON.stringify(glbUrl)}, (gltf) => {
	try {
		const root = gltf.scene;
		scene.add(root);
		applyPose(root, poseMap);
		applyExpression(root, expression);
		frameCamera(root, orbit);
		renderer.render(scene, camera);
		requestAnimationFrame(() => {
			renderer.render(scene, camera);
			window.__renderDone = true;
		});
	} catch (err) {
		window.__renderError = err.message || String(err);
	}
}, undefined, (err) => {
	window.__renderError = 'glb load failed: ' + (err?.message || err);
});
</script></body></html>`;
}

/**
 * Render a GLB to a PNG buffer with optional pose preset and camera orbit.
 *
 * @param {object} opts
 * @param {string} opts.glbUrl
 * @param {number} [opts.width=1024]
 * @param {number} [opts.height=1024]
 * @param {string} [opts.background='#0a0a0a']
 * @param {string} [opts.posePresetId]
 * @param {{theta?:number,phi?:number,radius?:number}} [opts.cameraOrbit]
 * @param {Object<string,number>} [opts.expression]
 * @returns {Promise<{png:Buffer,pose:object|null}>}
 */
export async function renderClip({
	glbUrl,
	width = 1024,
	height = 1024,
	background = '#0a0a0a',
	posePresetId = null,
	cameraOrbit = null,
	expression = null,
} = {}) {
	if (!glbUrl || typeof glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	const W = Math.max(64, Math.min(2048, Number(width) || 1024));
	const H = Math.max(64, Math.min(2048, Number(height) || 1024));
	const pose = poseById(posePresetId);
	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
		const html = viewerHtml({ glbUrl, width: W, height: H, background, pose, cameraOrbit, expression });
		await page.setContent(html, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(
			'window.__renderDone === true || window.__renderError !== null',
			{ timeout: 20_000 },
		);
		const err = await page.evaluate(() => window.__renderError);
		if (err) {
			throw Object.assign(new Error(`render failed: ${err}`), { status: 502, code: 'render_failed' });
		}
		const png = await page.screenshot({
			type: 'png',
			omitBackground: background === 'transparent',
			clip: { x: 0, y: 0, width: W, height: H },
		});
		return { png, pose };
	} finally {
		await page.close().catch(() => {});
	}
}
