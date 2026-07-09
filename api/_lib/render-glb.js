// Server-side GLB → PNG renderer for OG cards.
// ---------------------------------------------
// Boots headless chromium via puppeteer-core + @sparticuz/chromium-min,
// loads a tiny inlined three.js viewer page, points it at a GLB URL,
// waits for the model to render one frame, then returns the canvas PNG.
//
// Used by api/avatar-og.js when an avatar has no client-uploaded
// thumbnail yet. After the first render the PNG is cached in R2 and the
// avatar row's thumbnail_key is updated — subsequent crawls hit the
// redirect path and never re-launch chromium.

// puppeteer-core + @sparticuz/chromium-min are loaded lazily inside getBrowser()
// so Vercel's NFT doesn't statically trace the chromium tree for every route
// that transitively imports this module — that trace caused 45-min build hangs.
import { env } from './env.js';
import { fetchModel } from './fetch-model.js';

// Cap on GLB bytes pulled into the renderer. Anything larger risks OOM /
// blowing the render budget; callers may tighten this via `maxBytes`.
const DEFAULT_MAX_GLB_BYTES = 25 * 1024 * 1024;

// The "-min" build of @sparticuz/chromium ships without the chromium binary
// to keep the function bundle small. The binary is downloaded on first use
// from this URL (cached under /tmp on the Vercel runtime so cold-start cost
// is paid once per container, not per invocation). Match the chromium release
// to the @sparticuz/chromium-min version in package.json — see the project's
// release matrix at github.com/Sparticuz/chromium/releases.
// Keep in lockstep with @sparticuz/chromium-min in package.json. v148.0.0 → v148.0.0.
const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';
const CHROMIUM_PACK = env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;

// three.js version pinned in package-lock — must match what the in-app viewer
// renders so the server-side preview is faithful (camera, lighting, material
// behavior are all version-sensitive).
const THREE_VERSION = '0.176.0';

// One browser per warm container. puppeteer.launch is the slow step
// (~1s on warm chromium, ~3s cold); reusing the instance across renders
// in the same lambda invocation amortizes it.
let _browserPromise = null;

// A cached browser can die under us — chromium is the first thing the kernel's
// OOM killer reaps on a memory-tight container, and a long batch render is
// exactly when that happens. Without this check the cached promise keeps
// resolving to a corpse and EVERY subsequent render fails instantly with
// "Connection closed.", which a batch runner would otherwise mistake for a batch
// of unrenderable models. Verify liveness before handing the browser out, and
// drop the cache the moment it disconnects so the next call relaunches.
function isAlive(browser) {
	if (!browser) return false;
	if (typeof browser.connected === 'boolean') return browser.connected;
	if (typeof browser.isConnected === 'function') return browser.isConnected();
	return true;
}

async function getBrowser() {
	if (_browserPromise) {
		const existing = await _browserPromise.catch(() => null);
		if (isAlive(existing)) return existing;
		_browserPromise = null; // dead or failed — relaunch below
	}
	_browserPromise = (async () => {
		const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
			import('puppeteer-core'),
			import('@sparticuz/chromium-min'),
		]);
		const executablePath = await chromium.executablePath(CHROMIUM_PACK);
		const browser = await puppeteer.launch({
			args: chromium.args,
			defaultViewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
			executablePath,
			headless: chromium.headless,
		});
		// Self-heal: a crashed/killed browser evicts itself from the cache.
		browser.on('disconnected', () => {
			if (_browserPromise) _browserPromise = null;
		});
		return browser;
	})().catch((err) => {
		_browserPromise = null;
		throw err;
	});
	return _browserPromise;
}

// A render failure caused by the browser dying (OOM kill, crashed tab, closed
// devtools socket) says nothing about the model — the same GLB will render fine
// on a healthy browser. Batch runners use this to roll a claim back instead of
// spending one of the model's bounded retries. Keep it strict: anything not
// listed here is treated as the model's fault.
const INFRA_ERROR_RE =
	/connection closed|target closed|browser has disconnected|browser was not found|protocol error|session closed|websocket|econnreset|socket hang up|failed to launch/i;

export function isBrowserInfrastructureError(err) {
	return INFRA_ERROR_RE.test(String(err?.message || err || ''));
}

// Inline viewer HTML — bundled into the function so the renderer needs no
// extra static assets. three.js + GLTFLoader load from unpkg pinned to the
// installed version. window.__renderDone signals readiness to puppeteer.
function viewerHtml({ glbBase64, width, height, background }) {
	const bg = background === 'transparent' ? 'null' : JSON.stringify(background || '#0a0a0a');
	return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head><body>
<canvas id="c" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
<script>window.__GLB_B64=${JSON.stringify(glbBase64)};</script>
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
// Khronos PBR-Neutral keeps midtone brightness and saturation instead of the
// darkening/desaturation ACES applies — posters match the bright, true-color
// look of the live viewer (src/viewer.js) instead of coming out muddy.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const bgColor = ${bg};
if (bgColor !== null) scene.background = new THREE.Color(bgColor);

// Image-based lighting from a neutral room — gives PBR materials a soft,
// even ambient response so unlit/shadowed areas never read as flat black.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
if ('environmentIntensity' in scene) scene.environmentIntensity = 1.15;

const camera = new THREE.PerspectiveCamera(28, ${width}/${height}, 0.01, 100);

// Studio three-light rig: key from front-right, fill from front-left, rim from
// behind to carve the silhouette out of dark backdrops.
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(2, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xdce6ff, 0.9); fill.position.set(-3, 1, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(-1.5, 3, -4); scene.add(rim);

// Avatars from the forge/remesh/texture pipeline ship Draco-compressed
// geometry, Meshopt-packed buffers, and KTX2 (Basis) textures. A bare
// GLTFLoader throws "No DRACOLoader instance provided" on the first such
// model — register every standard compression decoder so the renderer
// handles optimized GLBs instead of falling back to the SVG card. Decoder
// assets load from the same pinned three.js release as the loaders.
const ADDONS = 'https://unpkg.com/three@${THREE_VERSION}/examples/jsm/';
const dracoLoader = new DRACOLoader().setDecoderPath(ADDONS + 'libs/draco/');
const ktx2Loader = new KTX2Loader().setTranscoderPath(ADDONS + 'libs/basis/').detectSupport(renderer);

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
loader.setKTX2Loader(ktx2Loader);
loader.setMeshoptDecoder(MeshoptDecoder);

// The GLB bytes are fetched server-side through the SSRF-pinned fetchModel
// path and embedded here as base64, so chromium never makes a network
// request for the user-supplied URL (no DNS-rebinding / redirect SSRF).
function onLoaded(gltf) {
	try {
		const root = gltf.scene;
		scene.add(root);
		// Frame the model: compute bounds, center it, position camera so it
		// fills the frame with a small margin.
		const box = new THREE.Box3().setFromObject(root);
		const size = new THREE.Vector3(); box.getSize(size);
		const center = new THREE.Vector3(); box.getCenter(center);
		root.position.sub(center);
		root.position.y += size.y * 0.05; // tiny lift so feet aren't dead-center
		const maxDim = Math.max(size.x, size.y, size.z);
		const fov = THREE.MathUtils.degToRad(camera.fov);
		const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.45;
		camera.position.set(0, size.y * 0.05, dist);
		camera.lookAt(0, 0, 0);
		// Two paints guard against partial first-frame artifacts (textures
		// still uploading, skinned meshes pre-bind). Cheap on a single GLB.
		renderer.render(scene, camera);
		requestAnimationFrame(() => {
			renderer.render(scene, camera);
			window.__renderDone = true;
		});
	} catch (err) {
		window.__renderError = err.message || String(err);
	}
}

(async () => {
	try {
		const buf = await (await fetch('data:application/octet-stream;base64,' + window.__GLB_B64)).arrayBuffer();
		loader.parse(buf, '', onLoaded, (err) => {
			window.__renderError = 'glb parse failed: ' + (err?.message || err);
		});
	} catch (err) {
		window.__renderError = 'glb decode failed: ' + (err?.message || String(err));
	}
})();
</script></body></html>`;
}

/**
 * Render a GLB to a PNG buffer via headless chromium.
 *
 * @param {object} opts
 * @param {string} opts.glbUrl  - publicly reachable URL of the .glb
 * @param {number} [opts.width=1200]
 * @param {number} [opts.height=630]
 * @param {string} [opts.background='#0a0a0a'] - 'transparent' or hex color
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderGlbToPng({ glbUrl, width = 1200, height = 630, background = '#0a0a0a', maxBytes = DEFAULT_MAX_GLB_BYTES } = {}) {
	if (!glbUrl || typeof glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	// Pull the GLB through the SSRF-pinned fetcher (DNS-pinned per hop, redirects
	// re-validated, byte cap enforced during download) so chromium never fetches
	// the untrusted URL itself. This is the single boundary where the user URL
	// touches the network — defeating DNS-rebinding and redirect-to-internal SSRF.
	let glbBase64;
	try {
		const { bytes } = await fetchModel(glbUrl, { maxBytes });
		glbBase64 = Buffer.from(bytes).toString('base64');
	} catch (err) {
		throw Object.assign(new Error(`glb fetch failed: ${err?.message || err}`), {
			status: err?.code === 'file_too_large' ? 413 : 400,
			code: err?.code || 'glb_fetch_failed',
		});
	}
	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: 1 });
		const html = viewerHtml({ glbBase64, width, height, background });
		// data: URL avoids needing a network fetch for the bootstrap page itself.
		// importmap dependencies (three, GLTFLoader) still come from unpkg.
		await page.setContent(html, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(
			'window.__renderDone === true || window.__renderError !== null',
			{ timeout: 15_000 },
		);
		const err = await page.evaluate(() => window.__renderError);
		if (err) {
			throw Object.assign(new Error(`render failed: ${err}`), { status: 502, code: 'render_failed' });
		}
		return await page.screenshot({
			type: 'png',
			omitBackground: background === 'transparent',
			clip: { x: 0, y: 0, width, height },
		});
	} finally {
		await page.close().catch(() => {});
	}
}

// Test seam — let test suites bypass the real launcher without monkey-patching
// the module path. Production code never sets this.
export function __setBrowserForTests(browser) {
	_browserPromise = browser ? Promise.resolve(browser) : null;
}
