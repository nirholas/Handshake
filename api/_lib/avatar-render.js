// Avatar render core, the headless-chromium + three.js pipeline that turns a
// stored GLB into a PNG/JPEG/WebP, plus the param-resolution and R2 cache layer
// around it. Extracted so BOTH the public HTTP endpoint (api/avatar/render.js)
// and the render_avatar_image MCP tool share one implementation, there is no
// duplicated chromium code anywhere else.

import { createHash } from 'node:crypto';
// puppeteer-core + @sparticuz/chromium-min are loaded lazily inside getBrowser()
// so Vercel's NFT does not statically trace the chromium binary tree on every
// route in a function package, that trace was the 45-min build timeout.
import { env } from './env.js';
import { publicUrl, putObject, headObject } from './r2.js';
import { poseRuntimeModules } from './pose-runtime.js';
import { scriptJson, safeCssColor } from './render-safe.js';
import { DEFAULT_THREE_BASE, resolveThreeCdn, THREE_VERSION, threeImportMap } from './three-cdn.js';
import { PRESETS } from '../../src/pose-presets.js';

export const MIN_DIM = 64;
export const MAX_DIM = 2048;
export const DEFAULT_SIZE = 512;

// Bump whenever the in-page render pipeline changes visibly (pose application,
// camera framing, lighting). Part of the cache fingerprint, so every cached
// render from the previous pipeline is invalidated on deploy instead of
// serving stale/broken images forever.
const RENDER_PIPELINE_VERSION = 2;

// Camera framing per scene. `band` is the vertical slice of the model shown,
// as fractions of its bounding-box height measured from the feet: [0, 1] is
// the whole figure, band[1] > 1 buys guaranteed headroom above the crown so a
// head can never be clipped. `halfWidthFrac` is the minimum horizontal
// half-extent to keep in frame, as a fraction of model height (a head is
// ~0.13 H wide, shoulders ~0.3 H); `fitFullWidth` additionally fits the whole
// bounding-box width (full-body must never crop an outstretched arm).
// `margin` is the safety zoom-out applied after fitting. phi/theta are the
// default orbit angles (degrees; phi is polar from +Y, so ~80-86 is eye-ish
// level looking slightly down).
export const SCENE_PRESETS = {
	'full-body':  { phi: 80, theta: 0, band: [-0.02, 1.05], fitFullWidth: true,  halfWidthFrac: 0.25, margin: 1.12 },
	'upper-body': { phi: 82, theta: 5, band: [0.42, 1.05],  fitFullWidth: false, halfWidthFrac: 0.22, margin: 1.08 },
	'portrait':   { phi: 84, theta: 8, band: [0.60, 1.06],  fitFullWidth: false, halfWidthFrac: 0.14, margin: 1.08 },
	'headshot':   { phi: 86, theta: 5, band: [0.74, 1.07],  fitFullWidth: false, halfWidthFrac: 0.09, margin: 1.08 },
};

// Pure camera-framing math, shared verbatim between Node (unit tests) and the
// headless render page (injected via toString(), so keep it self-contained:
// plain objects and Math only, no three.js, no outer-scope references).
//
// Given the POSED model's world-space bounding box, a scene preset (above),
// the output aspect ratio (width / height) and the vertical FOV, it returns
// where to put the camera and what to look at so the preset's vertical band
// fits the vertical frustum AND the required horizontal extent fits the
// horizontal frustum. Fitting the band (whose top is above the crown) against
// the vertical FOV is what makes portrait-aspect outputs keep the head in
// frame; fitting the width keeps landscape/square framing correct too.
export function computeCameraFraming(box, preset, aspect, fovDeg, orbit) {
	const p = preset || {};
	const sizeX = Math.max(box.max.x - box.min.x, 1e-6);
	const sizeY = Math.max(box.max.y - box.min.y, 1e-6);
	const sizeZ = Math.max(box.max.z - box.min.z, 1e-6);
	const cx = (box.min.x + box.max.x) / 2;
	const cz = (box.min.z + box.max.z) / 2;

	const band = Array.isArray(p.band) && p.band.length === 2 ? p.band : [-0.02, 1.05];
	const bandBottom = box.min.y + sizeY * band[0];
	const bandTop = box.min.y + sizeY * band[1];
	const lookY = (bandBottom + bandTop) / 2;
	const halfH = Math.max((bandTop - bandBottom) / 2, 1e-6);

	const minHalfW = sizeY * (Number.isFinite(p.halfWidthFrac) ? p.halfWidthFrac : 0.3);
	const halfW = p.fitFullWidth ? Math.max(Math.max(sizeX, sizeZ) / 2, minHalfW) : minHalfW;

	const tanV = Math.tan(((Number(fovDeg) || 28) * Math.PI) / 360);
	const tanH = tanV * Math.max(Number(aspect) || 1, 1e-6);
	const margin = Number.isFinite(p.margin) ? p.margin : 1.08;
	// + sizeZ / 2 backs the camera off past the model's front surface so depth
	// (an outstretched punch, a knee toward camera) never breaches the frustum.
	const distance = Math.max(halfH / tanV, halfW / tanH) * margin + sizeZ / 2;

	const num = (v) => (v == null ? NaN : Number(v));
	const thetaDeg = Number.isFinite(num(orbit && orbit.theta)) ? num(orbit.theta) : (Number(p.theta) || 0);
	const phiDeg = Number.isFinite(num(orbit && orbit.phi)) ? num(orbit.phi) : (Number(p.phi) || 80);
	const theta = (thetaDeg * Math.PI) / 180;
	const phi = (phiDeg * Math.PI) / 180;

	return {
		position: {
			x: cx + distance * Math.sin(phi) * Math.sin(theta),
			y: lookY + distance * Math.cos(phi),
			z: cz + distance * Math.sin(phi) * Math.cos(theta),
		},
		target: { x: cx, y: lookY, z: cz },
		distance,
	};
}

// Applies a requested morph map to a loaded model and reports which names
// actually landed. Shared verbatim between Node (unit tests) and the headless
// render page (injected via toString(), so keep it self-contained: plain
// objects only, no three.js, no outer-scope references). A model with no
// morph targets (or differently-named ones) used to make this a silent no-op:
// the caller got a clean 200 with none of the requested expression applied
// and no way to tell. Returns { requested, missing } or null when nothing
// was requested.
export function applyExpression(root, expression) {
	if (!expression || typeof expression !== 'object') return null;
	const requested = Object.keys(expression);
	if (!requested.length) return null;
	const matched = new Set();
	root.traverse((o) => {
		if (!o.isMesh || !o.morphTargetDictionary || !o.morphTargetInfluences) return;
		for (const [name, value] of Object.entries(expression)) {
			const idx = o.morphTargetDictionary[name] ?? o.morphTargetDictionary[name.toLowerCase()];
			if (typeof idx === 'number') {
				o.morphTargetInfluences[idx] = Number(value) || 0;
				matched.add(name);
			}
		}
	});
	return { requested, missing: requested.filter((n) => !matched.has(n)) };
}

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
	// `bg` is interpolated into the render page's script block, and that page has
	// container network egress, so an unvalidated string here is caller JS with an
	// internal-network view. Reject anything that is not a CSS color rather than
	// silently swapping in a default the caller did not ask for.
	let bg = 'transparent';
	if (input.bg && input.bg !== 'transparent') {
		bg = safeCssColor(input.bg);
		if (!bg) {
			return {
				error: {
					code: 'invalid_bg',
					message: 'bg must be "transparent" or a CSS color (hex, rgb()/rgba(), hsl()/hsla(), or a named color)',
				},
			};
		}
	}
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
		pipeline: RENDER_PIPELINE_VERSION,
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
// Returns { cached, key, imageUrl, buffer, contentType, expressionReport }.
// buffer is null on a hit. expressionReport is { requested, missing } when an
// expression was requested on a fresh render (missing = morph names the model
// does not carry, i.e. the part of the request that could not be honored),
// null when no expression was requested, and undefined on a cache hit (the
// stored image predates the check).
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
		// Cache miss, render fresh.
	}

	const cameraOrbit = { theta: params.scenePreset.theta, phi: params.scenePreset.phi, radius: null };
	const { png, expressionReport } = await renderAvatarScene({
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

	return { cached: false, key, imageUrl: publicUrl(key), buffer: png, contentType, expressionReport };
}

const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';
const CHROMIUM_PACK = env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;

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

// The posing stack the render page runs lives in ./pose-runtime.js, shared with
// api/_lib/render-clip.js so the two chromium renderers can never disagree about
// which rigs a preset lands on. Re-exported for callers that already import it
// from here.
export { poseRuntimeModules };

export function sceneViewerHtml({ glbUrl, width, height, background, pose, cameraOrbit, expression, scenePreset, threeBase = DEFAULT_THREE_BASE }) {
	// Every value below is interpolated into a <script> block. scriptJson (not
	// JSON.stringify) is what keeps a caller-supplied string from closing the tag
	// and running its own code in a page with container network egress.
	const bg = background === 'transparent' ? 'null' : scriptJson(safeCssColor(background) || '#0a0a0a');
	const poseJson = pose ? scriptJson(pose) : 'null';
	const orbitJson = scriptJson(cameraOrbit || { theta: 0, phi: 80, radius: null });
	const expressionJson = scriptJson(expression || null);
	const presetJson = scriptJson(scenePreset);
	const poseModules = poseRuntimeModules();

	return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head><body>
<canvas id="c" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
<script type="importmap">{ "imports": {
	${scriptJson(threeImportMap(threeBase)).slice(1, -1)},
	"glb-canonicalize": "${poseModules['glb-canonicalize']}",
	"pose-mannequin": "${poseModules['pose-mannequin']}",
	"pose-rig": "${poseModules['pose-rig']}"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeGltfRig, poseFromMannequinPreset } from 'pose-rig';

window.__renderDone = false;
window.__renderError = null;
window.__expressionReport = null;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(${width}, ${height}, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Neutral (Khronos PBR Neutral) tone mapping renders asset colors faithfully
// without the shadow-crushing ACES rolloff, the right choice for a product
// render where the character must read clearly.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const bgColor = ${bg};
if (bgColor !== null) scene.background = new THREE.Color(bgColor);

const camera = new THREE.PerspectiveCamera(28, ${width}/${height}, 0.01, 100);

// Image-based lighting is what makes PBR materials read: metal and glossy
// surfaces draw their reflections from scene.environment, so with none set they
// collapse to near-black, the "dark, murky" render. RoomEnvironment is three's
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

// Preset poses are authored in the mannequin convention (src/pose-presets.js);
// poseFromMannequinPreset converts them to canonical world-frame deltas and
// GltfRig.applyPose replays those on the avatar's OWN rest pose with
// reference-stance alignment, the same path the /pose studio uses, so a
// preset lands identically here whether the rig binds in a T-pose or A-pose,
// and whatever naming convention its bones use. Rigs with no recognizable
// humanoid skeleton stay in bind pose (there is no safe mapping for those).
function applyPose(root, poseMap) {
	if (!poseMap) return;
	const rig = makeGltfRig(root);
	if (!rig) return;
	rig.applyPose(poseFromMannequinPreset(poseMap));
}

${applyExpression.toString()}

${computeCameraFraming.toString()}

function frameCameraForScene(root, orbit, preset) {
	// The bounding box must reflect the POSED skin, not the bind-pose geometry:
	// three's Box3.setFromObject defers to SkinnedMesh.computeBoundingBox (CPU
	// skinning), which needs current bone matrices, update the graph and each
	// skeleton first. (Never reset rigs via THREE.Skeleton's pose method: it
	// reconstructs bind from inverse-bind matrices and collapses Mixamo rigs.)
	root.updateMatrixWorld(true);
	root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
	const box = new THREE.Box3().setFromObject(root);

	const framing = computeCameraFraming(
		{ min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } },
		preset, ${width} / ${height}, camera.fov, orbit,
	);
	// Scale-aware clip planes: pipeline GLBs are ~1.7 units tall but Mixamo
	// cm-scale exports are ~170, a fixed near/far would clip one or the other.
	camera.near = Math.max(framing.distance / 1000, 0.001);
	camera.far = framing.distance * 10;
	camera.updateProjectionMatrix();
	camera.position.set(framing.position.x, framing.position.y, framing.position.z);
	camera.lookAt(framing.target.x, framing.target.y, framing.target.z);
}

const orbit = ${orbitJson};
const poseMap = ${poseJson};
const expression = ${expressionJson};
const preset = ${presetJson};

// Pipeline GLBs ship Draco geometry, Meshopt buffers, and KTX2 textures;
// a bare GLTFLoader throws "No DRACOLoader instance provided". Register
// every standard compression decoder from the pinned three.js release.
const ADDONS = ${scriptJson(`${threeBase}examples/jsm/`)};
const dracoLoader = new DRACOLoader().setDecoderPath(ADDONS + 'libs/draco/');
const ktx2Loader = new KTX2Loader().setTranscoderPath(ADDONS + 'libs/basis/').detectSupport(renderer);

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
loader.setKTX2Loader(ktx2Loader);
loader.setMeshoptDecoder(MeshoptDecoder);

loader.load(${scriptJson(glbUrl)}, (gltf) => {
	try {
		const root = gltf.scene;
		scene.add(root);
		applyPose(root, poseMap);
		window.__expressionReport = applyExpression(root, expression);
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
		// Pick a live three.js CDN first: an unpkg outage would otherwise hang
		// the page's module import until the watchdog fires and the render
		// comes back blank.
		const { base: threeBase } = await resolveThreeCdn(THREE_VERSION);
		const html = sceneViewerHtml({
			glbUrl, width: W, height: H, background,
			pose, cameraOrbit: cameraOrbit || { theta: 0, phi: 80, radius: null },
			expression, scenePreset, threeBase,
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
		const expressionReport = await page.evaluate(() => window.__expressionReport);
		const png = await page.screenshot({
			type: 'png',
			omitBackground: background === 'transparent',
			clip: { x: 0, y: 0, width: W, height: H },
		});
		return { png, expressionReport };
	} finally {
		await page.close().catch(() => {});
	}
}
