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
import { DEFAULT_THREE_BASE, resolveThreeCdn, THREE_VERSION, threeImportMap } from './three-cdn.js';
import { fetchModel } from './fetch-model.js';
import { scriptJson, safeCssColor } from './render-safe.js';

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


// Poster composition. A 26° yaw reads as a natural 3/4 portrait without hiding
// the front of the model; 1.22 leaves enough margin that a T-pose's fingertips
// stay inside even after the yaw shrinks the projected width.
const CAMERA_YAW_DEG = 26;
const FRAME_MARGIN = 1.22;

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
//
// The spawn errnos are here because they were missing: puppeteer wraps most
// launch faults as "Failed to launch the browser process", but when the kernel
// refuses the fork outright the raw Node error surfaces instead, and four
// avatars in the live backfill ledger sat permanently retired at attempts=3
// with last_error "spawn EFAULT", a container-level fault, charged to the
// model. ENOMEM/EAGAIN are the same class (fork under memory pressure).
// Exported as a pattern string, not just a compiled regex, because the repair
// path (resetInfrastructureFailures in avatar-thumbs.js) has to ask the same
// question in SQL. It used to carry its own hand-copied alternation, which drifts
// silently the moment this list grows: exactly what happened to the spawn errnos.
// The syntax below is the intersection of JS and POSIX ERE, so `~*` accepts it.
export const INFRA_ERROR_PATTERN =
	'connection closed|target closed|browser has disconnected|browser was not found|protocol error|session closed|websocket|econnreset|socket hang up|failed to launch|spawn e[a-z]+|enomem|eagain|resource temporarily unavailable';

const INFRA_ERROR_RE = new RegExp(INFRA_ERROR_PATTERN, 'i');

export function isBrowserInfrastructureError(err) {
	return INFRA_ERROR_RE.test(String(err?.message || err || ''));
}

// Bound simultaneous renders per container. Each render runs a software-GL
// WebGL scene in its own chromium page while holding the GLB's decoded
// buffers; a parallel burst stacked enough of those to push the container past
// its memory limit, and Cloud Run OOM-killed it mid-request (observed
// 2026-07-18: every in-flight render surfaced as a 502). Renders beyond the
// cap wait FIFO for a slot; the endpoint's per-IP rate limit bounds how deep
// the queue can grow.
const MAX_CONCURRENT_RENDERS = Math.max(1, Number(env.RENDER_GLB_CONCURRENCY) || 2);
let _activeRenders = 0;
const _renderWaiters = [];

function acquireRenderSlot() {
	if (_activeRenders < MAX_CONCURRENT_RENDERS) {
		_activeRenders += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => _renderWaiters.push(resolve));
}

function releaseRenderSlot() {
	const next = _renderWaiters.shift();
	if (next) next();
	else _activeRenders -= 1;
}

// Inline viewer HTML — bundled into the function so the renderer needs no
// extra static assets. three.js + GLTFLoader load from unpkg pinned to the
// installed version. window.__renderDone signals readiness to puppeteer.
function viewerHtml({ glbBase64, width, height, background, backdrop, threeBase = DEFAULT_THREE_BASE }) {
	// A gradient backdrop renders as page CSS behind a transparent canvas: the
	// screenshot composites the two, so the scene itself stays background-free.
	// `background` reaches here straight from a public handler, and both slots
	// below are string interpolations into markup: the <style> block would take a
	// "</style><script>" breakout and the <script> block a "</script>" one, which
	// would run caller JS inside a page that has container network egress. Colors
	// are validated (safeCssColor) and script values escaped (scriptJson).
	const inner = safeCssColor(backdrop?.inner);
	const outer = safeCssColor(backdrop?.outer);
	const useGradient = Boolean(inner && outer);
	const bg = useGradient || background === 'transparent' ? 'null' : scriptJson(safeCssColor(background) || '#0a0a0a');
	const bodyBg = useGradient
		? `radial-gradient(ellipse 90% 70% at 50% 38%, ${inner}, ${outer})`
		: 'transparent';
	return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>html,body{margin:0;padding:0;background:${bodyBg};overflow:hidden}</style>
</head><body>
<canvas id="c" width="${width}" height="${height}" style="display:block;width:${width}px;height:${height}px"></canvas>
<script>window.__GLB_B64=${scriptJson(glbBase64)};</script>
<script type="importmap">{ "imports": ${scriptJson(threeImportMap(threeBase))} }</script>
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
const ADDONS = ${scriptJson(`${threeBase}examples/jsm/`)};
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
		// fills the frame with a small margin. The camera sits at a gentle 3/4
		// yaw instead of dead-on: a straight frontal shot flattens T-posed
		// avatars into identical paper cutouts, while the quarter turn shows
		// depth and silhouette. Distance honors both fov axes so tight margins
		// never crop on non-square frames.
		const box = new THREE.Box3().setFromObject(root);
		const size = new THREE.Vector3(); box.getSize(size);
		const center = new THREE.Vector3(); box.getCenter(center);
		root.position.sub(center);
		root.position.y += size.y * 0.05; // tiny lift so feet aren't dead-center
		const maxDim = Math.max(size.x, size.y, size.z);
		const fovV = THREE.MathUtils.degToRad(camera.fov);
		const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
		const dist = Math.max(
			(maxDim / 2) / Math.tan(fovV / 2),
			(maxDim / 2) / Math.tan(fovH / 2),
		) * ${JSON.stringify(FRAME_MARGIN)};
		const yaw = THREE.MathUtils.degToRad(${JSON.stringify(CAMERA_YAW_DEG)});
		camera.position.set(Math.sin(yaw) * dist, size.y * 0.08, Math.cos(yaw) * dist);
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
 * Render a GLB to a PNG buffer.
 *
 * Tries the in-process software rasterizer first (./render-cpu.js, roughly
 * 200-900 ms and no subprocess) and falls back to headless chromium for the
 * models it cannot decode on its own: Draco-compressed geometry and KTX2/Basis
 * textures, both of which need decoder binaries the CPU lane does not ship.
 *
 * Callers see one function and one PNG either way. Set RENDER_CPU_LANE=off to
 * pin every render back onto chromium without a deploy.
 *
 * @param {object} opts same shape as renderGlbToPngBrowser
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderGlbToPng(opts = {}) {
	if (!opts.glbUrl || typeof opts.glbUrl !== 'string') {
		throw Object.assign(new Error('glbUrl required'), { status: 400, code: 'invalid_args' });
	}
	// Read from process.env rather than ./env.js: that module exposes an
	// explicit allowlist of known keys, and an operational kill switch has to
	// work the moment it is set on the service, with no code change.
	if (process.env.RENDER_CPU_LANE !== 'off') {
		try {
			const { renderGlbToPngCpu } = await import('./render-cpu.js');
			const png = await renderGlbToPngCpu(opts);
			if (png?.length) return png;
		} catch (err) {
			// Never fatal: the browser lane can render everything this one can,
			// so a CPU miss costs latency, not a failed card. Logged with a stable
			// prefix so the fallback rate is greppable in Cloud Logging.
			console.warn('[render] cpu lane fell back to chromium:', err?.message || err);
		}
	}
	return renderGlbToPngBrowser(opts);
}

/**
 * Render a GLB to a PNG buffer via headless chromium. The failover lane: see
 * renderGlbToPng below for the one callers should use.
 *
 * @param {object} opts
 * @param {string} opts.glbUrl  - publicly reachable URL of the .glb
 * @param {number} [opts.width=1200]
 * @param {number} [opts.height=630]
 * @param {string} [opts.background='#0a0a0a'] - 'transparent' or hex color
 * @param {{inner: string, outer: string}} [opts.backdrop] - radial-gradient
 *   backdrop (center → edge). Takes precedence over `background`; used by the
 *   thumbnail pipeline to give every avatar its own tinted stage.
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderGlbToPngBrowser({ glbUrl, width = 1200, height = 630, background = '#0a0a0a', backdrop = null, maxBytes = DEFAULT_MAX_GLB_BYTES } = {}) {
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
	await acquireRenderSlot();
	try {
		try {
			return await renderOnce({ glbBase64, width, height, background, backdrop });
		} catch (err) {
			// The shared browser can die mid-render (an OOM-reaped chromium takes
			// every in-flight page with it). That says nothing about this GLB: the
			// disconnect handler already evicted the corpse, so one retry lands on
			// a freshly launched browser instead of surfacing an infra blip as a
			// render failure.
			if (!isBrowserInfrastructureError(err)) throw err;
			return await renderOnce({ glbBase64, width, height, background, backdrop });
		}
	} finally {
		releaseRenderSlot();
	}
}

// One page lifecycle on the shared browser: boot page, load the inline viewer,
// wait for the first clean frame, screenshot.
async function renderOnce({ glbBase64, width, height, background, backdrop }) {
	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: 1 });
		// Resolve which CDN still serves three.js before building the page. An
		// unpkg outage would otherwise hang the module import until the
		// watchdog below fires and every poster comes back blank.
		const { base: threeBase } = await resolveThreeCdn(THREE_VERSION);
		const html = viewerHtml({ glbBase64, width, height, background, backdrop, threeBase });
		// data: URL avoids needing a network fetch for the bootstrap page itself.
		// importmap dependencies (three, GLTFLoader) still come from the CDN.
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
