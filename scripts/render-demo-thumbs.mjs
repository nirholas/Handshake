#!/usr/bin/env node
/**
 * Render PNG preview thumbnails for the homepage playground's built-in demo
 * avatars. Each demo avatar maps to a local GLB; we render it once in a
 * headless Chromium via model-viewer, capture a 512×512 transparent PNG, and
 * write it to public/avatars/thumbs/<name>.png.
 *
 * These are static assets committed to the repo so the playground avatar
 * selector can show real model previews instead of letter initials, without
 * spinning up a WebGL context per swatch.
 *
 * Usage:  node scripts/render-demo-thumbs.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT_DIR = join(PUBLIC, 'avatars', 'thumbs');
const SIZE = 512;

// Unique GLBs behind the demo avatars (see loadAvatars() in pages/home.html).
const TARGETS = [
	{ glb: '/avatars/cz.glb', out: 'cz.png' },
	{ glb: '/avatars/default.glb', out: 'default.png' },
	{ glb: '/animations/soldier.glb', out: 'soldier.png' },
	{ glb: '/animations/robotexpressive.glb', out: 'robotexpressive.png' },
];

const MIME = {
	'.glb': 'model/gltf-binary',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.png': 'image/png',
};

function startServer() {
	const server = createServer(async (req, res) => {
		try {
			const path = decodeURIComponent(req.url.split('?')[0]);
			const file = join(PUBLIC, path);
			if (!file.startsWith(PUBLIC)) {
				res.writeHead(403).end();
				return;
			}
			const body = await readFile(file);
			res.writeHead(200, {
				'content-type': MIME[extname(file)] || 'application/octet-stream',
				'access-control-allow-origin': '*',
			});
			res.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	return new Promise((res) => {
		server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
	});
}

const viewerHtml = (origin) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>
	html,body { margin:0; padding:0; background: transparent; width:${SIZE}px; height:${SIZE}px; }
	model-viewer { width:100%; height:100%; --poster-color: transparent; background: transparent; }
</style>
<script type="module" src="${origin}/vendor/model-viewer.min.js" onerror="window.__mvFallback=1"></script>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>
</head>
<body>
	<model-viewer id="mv" interaction-prompt="none" exposure="1.05" shadow-intensity="0.7" tone-mapping="aces" camera-orbit="0deg 82deg auto"></model-viewer>
</body></html>`;

async function capture(page, src) {
	await page.evaluate(async (s) => {
		const mv = document.getElementById('mv');
		mv.setAttribute('src', s);
		await new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error('load timeout')), 25000);
			mv.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
			mv.addEventListener('error', () => { clearTimeout(t); rej(new Error('load error')); }, { once: true });
		});
		// Frame deterministically from the model's real bounding box so every
		// model — regardless of its native scale — fills the swatch the same way.
		const FOV = 26; // degrees
		const dims = mv.getDimensions(); // metres, post-load bounding box
		const maxDim = Math.max(dims.x, dims.y, dims.z);
		const radius = (maxDim / 2) / Math.tan((FOV / 2) * Math.PI / 180) * 1.12;
		mv.fieldOfView = `${FOV}deg`;
		mv.cameraTarget = 'auto auto auto';
		mv.cameraOrbit = `0deg 82deg ${radius}m`;
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	}, src);

	const dataUrl = await page.evaluate(async () => {
		const mv = document.getElementById('mv');
		const blob = await mv.toBlob({ idealAspect: true, mimeType: 'image/png' });
		return await new Promise((res) => {
			const fr = new FileReader();
			fr.onloadend = () => res(fr.result);
			fr.readAsDataURL(blob);
		});
	});
	return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const { server, port } = await startServer();
	const origin = `http://127.0.0.1:${port}`;
	console.log(`[thumbs] static server on ${origin}`);

	const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
	const ctx = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	await page.setContent(viewerHtml(origin), { waitUntil: 'load' });
	await page.waitForFunction(() => !!customElements.get('model-viewer'), null, { timeout: 30000 });

	let ok = 0, fail = 0;
	for (const t of TARGETS) {
		try {
			console.log(`[thumbs] rendering ${t.glb}…`);
			const png = await capture(page, origin + t.glb);
			writeFileSync(join(OUT_DIR, t.out), png);
			console.log(`[thumbs] ✓ ${t.out} (${png.length} bytes)`);
			ok++;
		} catch (err) {
			console.error(`[thumbs] ✗ ${t.glb}: ${err.message}`);
			fail++;
		}
	}

	await browser.close();
	server.close();
	console.log(`[thumbs] done — ${ok} ok, ${fail} failed`);
	if (fail) process.exit(1);
}

main().catch((err) => {
	console.error('[thumbs] fatal:', err);
	process.exit(1);
});
