#!/usr/bin/env node
// Accessory thumbnail renderer.
//
// The /play wardrobe (src/game/cosmetics-wardrobe.js) and the character-studio
// preset picker both show a poster PNG per worn accessory. This renders one from
// the accessory's own GLB, so a thumbnail can never drift from the asset it
// stands for: whoever regenerates the GLB regenerates the poster from it.
//
// It draws with the repo's own Three.js (node_modules/three) inside headless
// Chromium via Playwright — no CDN, no external service, no network. The page is
// served from a throwaway local HTTP server rooted at the repo so the module
// graph and the GLB are same-origin.
//
// Output is a 512x512 PNG with a transparent background, three-point studio
// lighting and a soft neutral fill, matching the framing of the thumbs already
// in public/accessories/thumbs/.
//
// Usage:
//   node scripts/render-accessory-thumbs.mjs laurel-meetup
//   node scripts/render-accessory-thumbs.mjs            # every accessory GLB

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GLB_DIR = path.join(REPO, 'public', 'accessories');
const THUMB_DIR = path.join(GLB_DIR, 'thumbs');
const SIZE = 512;

const MIME = {
	'.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
	'.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
};

// Serve the repo read-only on an ephemeral port, with the harness page itself at
// HARNESS_PATH so the page, the Three.js module graph and the GLB all share one
// origin (an `about:blank` page gets a null origin and every module import fails
// CORS). Paths are resolved and then checked to still live under the repo, so a
// `..` in a URL can't escape it.
const HARNESS_PATH = '/__accessory-thumb.html';

function serveRepo(harnessHtml) {
	return new Promise((resolve) => {
		const server = createServer(async (req, res) => {
			const rel = decodeURIComponent((req.url || '/').split('?')[0]);
			if (rel === HARNESS_PATH) {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end(harnessHtml);
				return;
			}
			const file = path.resolve(REPO, '.' + rel);
			if (!file.startsWith(REPO)) { res.writeHead(403).end(); return; }
			try {
				const body = await readFile(file);
				res.writeHead(200, {
					'content-type': MIME[path.extname(file)] || 'application/octet-stream',
					'content-length': body.length,
				});
				res.end(body);
			} catch {
				res.writeHead(404).end();
			}
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">
{"imports":{"three":"/node_modules/three/build/three.module.js",
"three/addons/":"/node_modules/three/examples/jsm/"}}
</script>
<style>html,body{margin:0;background:transparent}canvas{display:block}</style>
</head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SIZE = ${SIZE};
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Three-point studio rig: a warm key from the front-left, a cool rim from
// behind-right to separate the silhouette against a transparent background, and
// a hemisphere fill so downward faces never go to pure black.
const key = new THREE.DirectionalLight(0xfff4e2, 3.1); key.position.set(-2.2, 2.6, 3.2);
const rim = new THREE.DirectionalLight(0xdce8ff, 2.0); rim.position.set(2.4, 1.2, -2.8);
scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x2a2a30, 1.35));

window.renderAccessory = async (url) => {
	const gltf = await new GLTFLoader().loadAsync(url);
	const model = gltf.scene;
  // Drop any previous subject so one page can render the whole batch.
	for (const child of [...scene.children]) if (child.userData.subject) scene.remove(child);
	model.userData.subject = true;
	scene.add(model);

	// Frame the model: recentre on its bounding box, then pull the camera back
	// far enough that the largest dimension fills ~78% of the frame at any scale.
	const box = new THREE.Box3().setFromObject(model);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	model.position.sub(center);
	const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.1;
	const camera = new THREE.PerspectiveCamera(35, 1, radius * 0.01, radius * 100);
	const dist = (radius / Math.sin((35 * Math.PI / 180) / 2)) * 0.78;
	// Three-quarter view from slightly above: reads volume better than a flat
	// front-on shot and matches the existing thumbs.
	camera.position.set(dist * 0.52, dist * 0.42, dist * 0.74);
	camera.lookAt(0, 0, 0);
	renderer.render(scene, camera);
	return renderer.domElement.toDataURL('image/png');
};
window.rendererReady = true;
</script></body></html>`;

async function main() {
	const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-')).map((n) => n.replace(/\.glb$/, ''));
	const names = (await readdir(GLB_DIR))
		.filter((f) => f.endsWith('.glb'))
		.map((f) => f.replace(/\.glb$/, ''))
		.filter((n) => !wanted.length || wanted.includes(n));
	const missing = wanted.filter((n) => !names.includes(n));
	if (missing.length) throw new Error(`No GLB for ${missing.join(', ')} in ${GLB_DIR}`);
	if (!names.length) { console.log('No accessory GLBs to render.'); return; }

	await mkdir(THUMB_DIR, { recursive: true });
	const { server, port } = await serveRepo();
	const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
	try {
		const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
		page.on('pageerror', (err) => { throw err; });
		await page.setContent(PAGE(port), { waitUntil: 'load' });
		await page.waitForFunction('window.rendererReady === true', null, { timeout: 30_000 });

		for (const name of names) {
			const dataUrl = await page.evaluate(
				([url]) => window.renderAccessory(url),
				[`http://127.0.0.1:${port}/public/accessories/${name}.glb`],
			);
			const png = Buffer.from(dataUrl.split(',')[1], 'base64');
			const out = path.join(THUMB_DIR, `${name}.png`);
			await writeFile(out, png);
			console.log(`  ${(name + '.png').padEnd(28)} ${png.length.toString().padStart(7)} bytes`);
		}
	} finally {
		await browser.close();
		server.close();
	}
	console.log(`Rendered ${names.length} accessory thumbnail(s) to ${THUMB_DIR}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
