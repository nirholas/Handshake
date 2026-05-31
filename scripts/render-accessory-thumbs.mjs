#!/usr/bin/env node
/**
 * Render PNG preview thumbnails for the Avatar Studio accessory catalog
 * (hats, glasses, earrings). Each preset in public/accessories/presets.json
 * with a `glbUrl` is rendered once in a headless Chromium with a controlled
 * three.js scene — bounding-box-fit camera, neutral studio environment for
 * correct PBR (metallic earrings/glasses), transparent background — captured
 * as a 512×512 PNG and written to public/accessories/thumbs/<preset-id>.png,
 * the path presets.json already points each `thumbnail` at.
 *
 * These are static assets committed to the repo so the studio's tile grid shows
 * real model previews instead of a generic per-kind emoji, and so the page
 * stops requesting (and 404-ing) thumbnails that don't exist.
 *
 * Usage:  node scripts/render-accessory-thumbs.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, basename } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT_DIR = join(PUBLIC, 'accessories', 'thumbs');
const SIZE = 512;
const THREE_VER = '0.160.0';

const presets = JSON.parse(readFileSync(join(PUBLIC, 'accessories', 'presets.json'), 'utf-8'));
const TARGETS = presets
	.filter((p) => p.glbUrl && p.thumbnail)
	.map((p) => ({ glb: p.glbUrl, out: basename(p.thumbnail) }));

const MIME = { '.glb': 'model/gltf-binary', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };

function startServer() {
	const server = createServer(async (req, res) => {
		try {
			const path = decodeURIComponent(req.url.split('?')[0]);
			const file = join(PUBLIC, path);
			if (!file.startsWith(PUBLIC)) return void res.writeHead(403).end();
			const body = await readFile(file);
			res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
			res.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

// A self-contained three.js renderer. Exposes window.__renderGLB(url) → dataURL.
const rendererHtml = () => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head>
<body>
<script type="importmap">
{ "imports": {
	"three": "https://unpkg.com/three@${THREE_VER}/build/three.module.js",
	"three/addons/": "https://unpkg.com/three@${THREE_VER}/examples/jsm/"
}}
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(SIZE, SIZE, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const loader = new GLTFLoader();

window.__renderGLB = async (url) => {
	const scene = new THREE.Scene();
	scene.environment = envTex;
	// Key + fill so non-metal fabric reads with form even off the IBL.
	const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 2.5); scene.add(key);
	scene.add(new THREE.HemisphereLight(0xffffff, 0x666a73, 1.0));

	const gltf = await loader.loadAsync(url);
	const model = gltf.scene;
	scene.add(model);

	// Frame to the geometry bounding box: center it, then pull the camera back
	// along a 3/4 view so the whole piece fits with a small margin.
	const box = new THREE.Box3().setFromObject(model);
	const size = new THREE.Vector3(); box.getSize(size);
	const center = new THREE.Vector3(); box.getCenter(center);
	model.position.sub(center); // recenter at origin

	const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.1;
	const fov = 30;
	const dist = (radius / Math.sin((fov / 2) * Math.PI / 180)) * 1.45;
	const camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 100);
	const dir = new THREE.Vector3(0.45, 0.28, 1).normalize();
	camera.position.copy(dir.multiplyScalar(dist));
	camera.lookAt(0, 0, 0);

	renderer.render(scene, camera);
	const url2 = renderer.domElement.toDataURL('image/png');

	scene.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); } });
	return url2;
};
window.__ready = true;
</script>
</body></html>`;

async function main() {
	if (TARGETS.length === 0) { console.error('[acc-thumbs] no targets'); process.exit(1); }
	mkdirSync(OUT_DIR, { recursive: true });
	const { server, port } = await startServer();
	const origin = `http://127.0.0.1:${port}`;
	console.log(`[acc-thumbs] static server on ${origin}, ${TARGETS.length} targets`);

	const browser = await chromium.launch({
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const ctx = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(e.message));
	await page.setContent(rendererHtml(), { waitUntil: 'load' });
	await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

	let ok = 0, fail = 0;
	for (const t of TARGETS) {
		try {
			console.log(`[acc-thumbs] rendering ${t.glb}…`);
			const dataUrl = await page.evaluate((u) => window.__renderGLB(u), origin + t.glb);
			const png = Buffer.from(dataUrl.split(',')[1], 'base64');
			writeFileSync(join(OUT_DIR, t.out), png);
			console.log(`[acc-thumbs] ✓ ${t.out} (${png.length} bytes)`);
			ok++;
		} catch (err) {
			console.error(`[acc-thumbs] ✗ ${t.glb}: ${err.message}`);
			fail++;
		}
	}

	if (errs.length) console.error('[acc-thumbs] page errors:\n  ' + errs.join('\n  '));
	await browser.close();
	server.close();
	console.log(`[acc-thumbs] done — ${ok} ok, ${fail} failed`);
	if (fail) process.exit(1);
}

main().catch((err) => { console.error('[acc-thumbs] fatal:', err); process.exit(1); });
