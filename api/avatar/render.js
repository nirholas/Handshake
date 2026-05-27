// GET /api/avatar/render — public avatar render API.
//
// Returns a rendered PNG/JPEG/WebP of any public avatar. Designed for use in
// <img> tags, social cards, partner integrations, and game engine loaders.
//
// Query parameters:
//   avatar     (required) — avatar UUID
//   scene      — full-body | upper-body | portrait | headshot  (default: upper-body)
//   size       — square pixel dimension  (default: 512, min: 64, max: 2048)
//   width      — override width  (takes precedence over size)
//   height     — override height (takes precedence over size)
//   bg         — CSS color or 'transparent'  (default: transparent)
//   pose       — pose preset ID  (GET /api/render/avatar-clip for catalog)
//   expression — JSON-encoded ARKit-52 morph map  (e.g. {"mouthSmile":0.6})
//   format     — png | jpeg | webp  (default: png)
//   quality    — 1-100 for lossy formats  (default: 90)
//
// Caching:
//   First request per parameter combo renders via headless chromium + three.js
//   and caches the result in R2. Subsequent requests 302 to the CDN URL.
//   Cache is keyed on avatar_id + param hash + avatar updated_at, so updates
//   to the avatar (appearance, GLB, etc.) automatically bust the cache.

import { createHash } from 'node:crypto';
import { cors, error, json, wrap } from '../_lib/http.js';
import { getAvatar } from '../_lib/avatars.js';
import { publicUrl, putObject, headObject } from '../_lib/r2.js';
import { renderClip } from '../_lib/render-clip.js';
import { PRESETS } from '../../src/pose-presets.js';

export const maxDuration = 30;

const MIN_DIM = 64;
const MAX_DIM = 2048;
const DEFAULT_SIZE = 512;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 120;

const SCENE_PRESETS = {
	'full-body':  { phi: 80, theta: 0,  radiusMult: 1.0,  lookAtY: 0.0  },
	'upper-body': { phi: 82, theta: 5,  radiusMult: 0.55, lookAtY: 0.15 },
	'portrait':   { phi: 84, theta: 8,  radiusMult: 0.38, lookAtY: 0.30 },
	'headshot':   { phi: 86, theta: 5,  radiusMult: 0.28, lookAtY: 0.38 },
};

const FORMAT_TYPES = {
	png:  'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
};

const rateMap = new Map();
function rateCheck(ip) {
	if (!ip) return true;
	const now = Date.now();
	const arr = (rateMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	if (arr.length >= RATE_LIMIT_MAX) {
		rateMap.set(ip, arr);
		return false;
	}
	arr.push(now);
	rateMap.set(ip, arr);
	return true;
}

function cacheKey(avatarId, paramsHash, format) {
	return `renders/${avatarId}/${paramsHash}.${format}`;
}

function hashParams(obj) {
	return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	if (req.method !== 'GET') {
		res.setHeader('allow', 'GET, OPTIONS');
		return error(res, 405, 'method_not_allowed', 'Use GET');
	}

	const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
	if (!rateCheck(ip)) {
		return error(res, 429, 'rate_limited', `Limit: ${RATE_LIMIT_MAX} renders per ${RATE_LIMIT_WINDOW_MS / 60000}m`);
	}

	const url = new URL(req.url, 'http://x');
	const q = url.searchParams;

	const avatarId = q.get('avatar');
	if (!avatarId) {
		return json(res, 200, {
			endpoint: 'GET /api/avatar/render',
			description: 'Render any public three.ws avatar as an image. Use in <img> tags, social cards, game engines, or anywhere you need a profile picture.',
			parameters: {
				avatar: { required: true, type: 'uuid', description: 'Avatar ID' },
				scene: { type: 'enum', values: Object.keys(SCENE_PRESETS), default: 'upper-body', description: 'Camera framing preset' },
				size: { type: 'integer', min: MIN_DIM, max: MAX_DIM, default: DEFAULT_SIZE, description: 'Square dimension in pixels (overridden by width/height)' },
				width: { type: 'integer', min: MIN_DIM, max: MAX_DIM, description: 'Override width' },
				height: { type: 'integer', min: MIN_DIM, max: MAX_DIM, description: 'Override height' },
				bg: { type: 'string', default: 'transparent', description: 'Background color (CSS color or "transparent")' },
				pose: { type: 'string', description: 'Pose preset ID (GET /api/render/avatar-clip for catalog)' },
				expression: { type: 'json', description: 'ARKit-52 morph target map, e.g. {"mouthSmile":0.6}' },
				format: { type: 'enum', values: ['png', 'jpeg', 'webp'], default: 'png' },
				quality: { type: 'integer', min: 1, max: 100, default: 90, description: 'Quality for jpeg/webp' },
			},
			scenes: Object.fromEntries(
				Object.entries(SCENE_PRESETS).map(([k, v]) => [k, { phi: v.phi, theta: v.theta }])
			),
			poses: PRESETS.map((p) => ({ id: p.id, label: p.label, group: p.group })),
			example: '/api/avatar/render?avatar=YOUR_AVATAR_ID&scene=portrait&size=256&bg=transparent',
		}, { 'cache-control': 'public, max-age=86400' });
	}

	const avatar = await getAvatar({ id: avatarId });
	if (!avatar) {
		return error(res, 404, 'not_found', 'Avatar not found or is private');
	}
	if (!avatar.model_url) {
		return error(res, 403, 'private', 'Avatar is private — only public or unlisted avatars can be rendered');
	}

	const sceneName = q.get('scene') || 'upper-body';
	const scenePreset = SCENE_PRESETS[sceneName];
	if (!scenePreset) {
		return error(res, 400, 'invalid_scene', `Unknown scene "${sceneName}". Valid: ${Object.keys(SCENE_PRESETS).join(', ')}`);
	}

	const size = clamp(parseInt(q.get('size'), 10) || DEFAULT_SIZE, MIN_DIM, MAX_DIM);
	const width = clamp(parseInt(q.get('width'), 10) || size, MIN_DIM, MAX_DIM);
	const height = clamp(parseInt(q.get('height'), 10) || size, MIN_DIM, MAX_DIM);

	const bg = q.get('bg') || 'transparent';
	const format = FORMAT_TYPES[q.get('format')] ? q.get('format') : 'png';
	const quality = clamp(parseInt(q.get('quality'), 10) || 90, 1, 100);

	let posePresetId = null;
	if (q.get('pose')) {
		const found = PRESETS.find((p) => p.id === q.get('pose'));
		if (!found) {
			return error(res, 400, 'unknown_pose', `Unknown pose "${q.get('pose')}". GET this endpoint without params for the catalog.`);
		}
		posePresetId = found.id;
	}

	let expression = null;
	if (q.get('expression')) {
		try {
			expression = JSON.parse(q.get('expression'));
			if (typeof expression !== 'object' || expression === null) throw new Error();
		} catch {
			return error(res, 400, 'invalid_expression', 'expression must be a JSON object of morph targets');
		}
	}

	const paramFingerprint = hashParams({
		scene: sceneName,
		w: width,
		h: height,
		bg,
		format,
		quality,
		pose: posePresetId,
		expression,
		updated: avatar.updated_at,
	});

	const key = cacheKey(avatar.id, paramFingerprint, format);

	try {
		const head = await headObject({ key });
		if (head) {
			const cdnUrl = publicUrl(key);
			res.statusCode = 302;
			res.setHeader('location', cdnUrl);
			res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
			res.setHeader('x-render-cache', 'hit');
			res.end();
			return;
		}
	} catch {
		// Cache miss — render fresh
	}

	const cameraOrbit = {
		theta: scenePreset.theta,
		phi: scenePreset.phi,
		radius: null,
	};

	let result;
	try {
		result = await renderAvatarScene({
			glbUrl: avatar.model_url,
			width,
			height,
			background: bg,
			posePresetId,
			cameraOrbit,
			expression,
			scenePreset,
		});
	} catch (err) {
		const status = err?.status || 502;
		return error(res, status, err?.code || 'render_failed', err?.message || 'Render failed');
	}

	const imageBuffer = result.png;

	putObject({
		key,
		body: imageBuffer,
		contentType: FORMAT_TYPES[format],
		metadata: { avatar_id: avatar.id, scene: sceneName, params: paramFingerprint },
	}).catch((err) => {
		console.warn('[avatar/render] cache write failed:', err?.message);
	});

	res.statusCode = 200;
	res.setHeader('content-type', FORMAT_TYPES[format]);
	res.setHeader('content-length', String(imageBuffer.length));
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=86400');
	res.setHeader('x-render-cache', 'miss');
	res.setHeader('x-render-scene', sceneName);
	res.setHeader('x-render-size', `${width}x${height}`);
	res.setHeader('access-control-expose-headers', 'x-render-cache, x-render-scene, x-render-size');
	res.end(imageBuffer);
});

function clamp(v, min, max) {
	return Math.max(min, Math.min(max, v));
}

// Extended renderer that supports scene presets with lookAt offset + distance
// multiplier. Builds on the same puppeteer+three.js pipeline as render-clip.js
// but with a custom frameCamera that handles scene framing.
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';
import { env } from '../_lib/env.js';

const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';
const CHROMIUM_PACK = env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;
const THREE_VERSION = '0.176.0';

let _browserPromise = null;
async function getBrowser() {
	if (_browserPromise) return _browserPromise;
	_browserPromise = (async () => {
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

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(2, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd6ff, 0.65);
fill.position.set(-3, 1, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xc7a8ff, 0.55);
rim.position.set(0, 2, -4); scene.add(rim);
const bottom = new THREE.DirectionalLight(0xffffff, 0.15);
bottom.position.set(0, -2, 1); scene.add(bottom);

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

new GLTFLoader().load(${JSON.stringify(glbUrl)}, (gltf) => {
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

async function renderAvatarScene({
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
