// Avatar render core — the headless-chromium + three.js pipeline that turns a
// stored GLB into a PNG/JPEG/WebP, plus the param-resolution and R2 cache layer
// around it. Extracted so BOTH the public HTTP endpoint (api/avatar/render.js)
// and the render_avatar_image MCP tool share one implementation — there is no
// duplicated chromium code anywhere else.

import { createHash } from 'node:crypto';
// puppeteer-core + @sparticuz/chromium-min are loaded lazily inside getBrowser()
// so Vercel's NFT does not statically trace the chromium binary tree on every
// route in a function package — that trace was the 45-min build timeout.
import { env } from './env.js';
import { publicUrl, putObject, headObject } from './r2.js';
import { PRESETS } from '../../src/pose-presets.js';

export const MIN_DIM = 64;
export const MAX_DIM = 2048;
export const DEFAULT_SIZE = 512;

export const SCENE_PRESETS = {
	'full-body':  { phi: 80, theta: 0,  radiusMult: 1.0,  lookAtY: 0.0  },
	'upper-body': { phi: 82, theta: 5,  radiusMult: 0.55, lookAtY: 0.15 },
	'portrait':   { phi: 84, theta: 8,  radiusMult: 0.38, lookAtY: 0.30 },
	'headshot':   { phi: 86, theta: 5,  radiusMult: 0.28, lookAtY: 0.38 },
};

export const FORMAT_TYPES = {
	png:  'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
};

export function clamp(v, min, max) {
	return Math.max(min, Math.min(max, v));
}

function toInt(v, fallback) {
	const n = typeof v === 'number' ? Math.trunc(v) : parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

// Normalize loose render inputs (HTTP query strings or MCP-typed values) into a
// validated param set, or an { error } the caller maps to its own error shape.
// Validates scene / pose / expression exactly as the public endpoint always has.
export function resolveRenderParams(input = {}) {
	const sceneName = input.scene || 'upper-body';
	const scenePreset = SCENE_PRESETS[sceneName];
	if (!scenePreset) {
		return {
			error: {
				code: 'invalid_scene',
				message: `Unknown scene "${sceneName}". Valid: ${Object.keys(SCENE_PRESETS).join(', ')}`,
			},
		};
	}

	const size = clamp(toInt(input.size, DEFAULT_SIZE), MIN_DIM, MAX_DIM);
	const width = clamp(toInt(input.width, size), MIN_DIM, MAX_DIM);
	const height = clamp(toInt(input.height, size), MIN_DIM, MAX_DIM);
	const bg = input.bg || 'transparent';
	const format = FORMAT_TYPES[input.format] ? input.format : 'png';
	const quality = clamp(toInt(input.quality, 90), 1, 100);

	let posePresetId = null;
	if (input.pose) {
		const found = PRESETS.find((p) => p.id === input.pose);
		if (!found) {
			return {
				error: {
					code: 'unknown_pose',
					message: `Unknown pose "${input.pose}". GET /api/avatar/render for the catalog.`,
				},
			};
		}
		posePresetId = found.id;
	}

	let expression = null;
	if (input.expression != null) {
		let exp = input.expression;
		if (typeof exp === 'string') {
			try {
				exp = JSON.parse(exp);
			} catch {
				return {
					error: {
						code: 'invalid_expression',
						message: 'expression must be a JSON object of morph targets',
					},
				};
			}
		}
		if (typeof exp !== 'object' || exp === null || Array.isArray(exp)) {
			return {
				error: {
					code: 'invalid_expression',
					message: 'expression must be a JSON object of morph targets',
				},
			};
		}
		expression = exp;
	}

	return { params: { scene: sceneName, scenePreset, size, width, height, bg, format, quality, posePresetId, expression } };
}

function cacheKey(avatarId, paramsHash, format) {
	return `renders/${avatarId}/${paramsHash}.${format}`;
}

function hashParams(obj) {
	return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// Deterministic cache fingerprint. Includes avatar.updated_at so any change to
// the avatar (appearance, GLB, etc.) automatically busts every cached render.
function renderFingerprint(updatedAt, params) {
	return hashParams({
		scene: params.scene,
		w: params.width,
		h: params.height,
		bg: params.bg,
		format: params.format,
		quality: params.quality,
		pose: params.posePresetId,
		expression: params.expression,
		updated: updatedAt,
	});
}

// Resolve the render from cache, or render fresh + persist to R2 and return it.
//   avatar       the avatar row (needs id + updated_at for the cache key)
//   glbUrl       fetchable GLB URL (public CDN for public/unlisted, signed for private)
//   params       a resolveRenderParams() result.params
//   awaitUpload  true  → await the R2 write so the returned imageUrl is live
//                       (MCP callers that only get a URL back)
//                false → fire the write in the background and hand back the
//                       buffer the caller already holds (the HTTP endpoint)
// Returns { cached, key, imageUrl, buffer, contentType }. buffer is null on a hit.
export async function renderAvatarImage({ avatar, glbUrl, params, awaitUpload = false }) {
	const contentType = FORMAT_TYPES[params.format];
	const fingerprint = renderFingerprint(avatar.updated_at, params);
	const key = cacheKey(avatar.id, fingerprint, params.format);

	try {
		const head = await headObject(key);
		if (head) {
			return { cached: true, key, imageUrl: publicUrl(key), buffer: null, contentType };
		}
	} catch {
		// Cache miss — render fresh.
	}

	const cameraOrbit = { theta: params.scenePreset.theta, phi: params.scenePreset.phi, radius: null };
	const { png } = await renderAvatarScene({
		glbUrl,
		width: params.width,
		height: params.height,
		background: params.bg,
		posePresetId: params.posePresetId,
		cameraOrbit,
		expression: params.expression,
		scenePreset: params.scenePreset,
	});

	const put = putObject({
		key,
		body: png,
		contentType,
		metadata: { avatar_id: avatar.id, scene: params.scene, params: fingerprint },
	});
	if (awaitUpload) {
		await put;
	} else {
		put.catch((err) => console.warn('[avatar-render] cache write failed:', err?.message));
	}

	return { cached: false, key, imageUrl: publicUrl(key), buffer: png, contentType };
}

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

function sceneViewerHtml({ glbUrl, width, height, background, pose, cameraOrbit, expression, scenePreset }) {
	const bg = background === 'transparent' ? 'null' : JSON.stringify(background || '#0a0a0a');
	const poseJson = pose ? JSON.stringify(pose) : 'null';
	const orbitJson = JSON.stringify(cameraOrbit || { theta: 0, phi: 80, radius: null });
	const expressionJson = JSON.stringify(expression || null);
	const presetJson = JSON.stringify(scenePreset);

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
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

window.__renderDone = false;
window.__renderError = null;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(${width}, ${height}, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Neutral (Khronos PBR Neutral) tone mapping renders asset colors faithfully
// without the shadow-crushing ACES rolloff — the right choice for a product
// render where the character must read clearly.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const bgColor = ${bg};
if (bgColor !== null) scene.background = new THREE.Color(bgColor);

const camera = new THREE.PerspectiveCamera(28, ${width}/${height}, 0.01, 100);

// Image-based lighting is what makes PBR materials read: metal and glossy
// surfaces draw their reflections from scene.environment, so with none set they
// collapse to near-black — the "dark, murky" render. RoomEnvironment is three's
// built-in procedural studio environment (no external HDR asset to host).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 1.15;

// Directional lights are accents on top of the IBL base: a warm key for form,
// a soft cool fill to open the shadow side, a violet rim for separation.
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(2.5, 3.5, 3.5); scene.add(key);
const fill = new THREE.DirectionalLight(0xdfeaff, 0.5);
fill.position.set(-3, 1.2, 2.5); scene.add(fill);
const rim = new THREE.DirectionalLight(0xecdcff, 0.7);
rim.position.set(-0.5, 2.5, -4); scene.add(rim);

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

function frameCameraForScene(root, orbit, preset) {
	const box = new THREE.Box3().setFromObject(root);
	const size = new THREE.Vector3(); box.getSize(size);
	const center = new THREE.Vector3(); box.getCenter(center);

	root.position.sub(center);

	const halfH = size.y * 0.5;
	const lookAtY = halfH * (preset.lookAtY || 0);

	root.position.y += size.y * 0.05;

	const maxDim = Math.max(size.x, size.y, size.z);
	const fov = THREE.MathUtils.degToRad(camera.fov);
	const defaultDist = (maxDim / 2) / Math.tan(fov / 2) * 1.45;
	const radius = defaultDist * (preset.radiusMult || 1.0);

	const theta = THREE.MathUtils.degToRad(Number(orbit.theta) || 0);
	const phi = THREE.MathUtils.degToRad(Number(orbit.phi) || 80);
	const x = radius * Math.sin(phi) * Math.sin(theta);
	const y = radius * Math.cos(phi) + lookAtY;
	const z = radius * Math.sin(phi) * Math.cos(theta);
	camera.position.set(x, y, z);
	camera.lookAt(0, lookAtY, 0);
}

const orbit = ${orbitJson};
const poseMap = ${poseJson};
const expression = ${expressionJson};
const preset = ${presetJson};

// Pipeline GLBs ship Draco geometry, Meshopt buffers, and KTX2 textures;
// a bare GLTFLoader throws "No DRACOLoader instance provided". Register
// every standard compression decoder from the pinned three.js release.
const ADDONS = 'https://unpkg.com/three@${THREE_VERSION}/examples/jsm/';
const dracoLoader = new DRACOLoader().setDecoderPath(ADDONS + 'libs/draco/');
const ktx2Loader = new KTX2Loader().setTranscoderPath(ADDONS + 'libs/basis/').detectSupport(renderer);

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
loader.setKTX2Loader(ktx2Loader);
loader.setMeshoptDecoder(MeshoptDecoder);

loader.load(${JSON.stringify(glbUrl)}, (gltf) => {
	try {
		const root = gltf.scene;
		scene.add(root);
		applyPose(root, poseMap);
		applyExpression(root, expression);
		frameCameraForScene(root, orbit, preset);
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

export async function renderAvatarScene({
	glbUrl,
	width = 512,
	height = 512,
	background = 'transparent',
	posePresetId = null,
	cameraOrbit = null,
	expression = null,
	scenePreset = SCENE_PRESETS['upper-body'],
} = {}) {
	const W = clamp(Number(width) || 512, MIN_DIM, MAX_DIM);
	const H = clamp(Number(height) || 512, MIN_DIM, MAX_DIM);

	let pose = null;
	if (posePresetId) {
		const found = PRESETS.find((p) => p.id === posePresetId);
		if (found) pose = found.pose;
	}

	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
		const html = sceneViewerHtml({
			glbUrl, width: W, height: H, background,
			pose, cameraOrbit: cameraOrbit || { theta: 0, phi: 80, radius: null },
			expression, scenePreset,
		});
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
		return { png };
	} finally {
		await page.close().catch(() => {});
	}
}
