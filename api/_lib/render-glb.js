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
			defaultViewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
			executablePath,
			headless: chromium.headless,
		});
	})().catch((err) => {
		_browserPromise = null;
		throw err;
	});
	return _browserPromise;
}

// Inline viewer HTML — bundled into the function so the renderer needs no
// extra static assets. three.js + GLTFLoader load from unpkg pinned to the
// installed version. window.__renderDone signals readiness to puppeteer.
function viewerHtml({ glbUrl, width, height, background }) {
	const bg = background === 'transparent' ? 'null' : JSON.stringify(background || '#0a0a0a');
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

// Three-light rig: key from front-right, fill from front-left, rim from behind.
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0xbfd6ff, 0.6); fill.position.set(-3, 1, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xc7a8ff, 0.5); rim.position.set(0, 2, -4); scene.add(rim);

new GLTFLoader().load(${JSON.stringify(glbUrl)}, (gltf) => {
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
}, undefined, (err) => {
	window.__renderError = 'glb load failed: ' + (err?.message || err);
});
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
export async function renderGlbToPng({ glbUrl, width = 1200, height = 630, background = '#0a0a0a' } = {}) {
	if (!glbUrl || typeof glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: 1 });
		const html = viewerHtml({ glbUrl, width, height, background });
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
