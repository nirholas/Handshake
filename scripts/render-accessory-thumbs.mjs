#!/usr/bin/env node
/**
 * Render PNG preview thumbnails for the Avatar Studio accessory catalog
 * (hats, glasses, earrings). Each preset in public/accessories/presets.json
 * with a `glbUrl` is rendered once in a headless Chromium via model-viewer,
 * captured as a 512×512 transparent PNG, and written to
 * public/accessories/thumbs/<preset-id>.png — the path presets.json already
 * points each `thumbnail` at.
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

// Derive targets from presets.json so the catalog stays the single source of
// truth — any accessory with a model GLB gets a thumbnail at its `thumbnail` path.
const presets = JSON.parse(readFileSync(join(PUBLIC, 'accessories', 'presets.json'), 'utf-8'));
const TARGETS = presets
	.filter((p) => p.glbUrl && p.thumbnail)
	.map((p) => ({ glb: p.glbUrl, out: basename(p.thumbnail) }));

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
	<model-viewer id="mv" interaction-prompt="none" exposure="1.1" shadow-intensity="0.6" tone-mapping="aces" camera-orbit="0deg 80deg auto"></model-viewer>
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
		// accessory — earrings to cowboy hat — fills the swatch the same way.
		const FOV = 26; // degrees
		const dims = mv.getDimensions(); // metres, post-load bounding box
		const maxDim = Math.max(dims.x, dims.y, dims.z);
		const radius = (maxDim / 2) / Math.tan((FOV / 2) * Math.PI / 180) * 1.15;
		mv.fieldOfView = `${FOV}deg`;
		mv.cameraTarget = 'auto auto auto';
		mv.cameraOrbit = `0deg 80deg ${radius}m`;
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
	if (TARGETS.length === 0) {
		console.error('[acc-thumbs] no accessory presets with glbUrl + thumbnail found');
		process.exit(1);
	}
	mkdirSync(OUT_DIR, { recursive: true });
	const { server, port } = await startServer();
	const origin = `http://127.0.0.1:${port}`;
	console.log(`[acc-thumbs] static server on ${origin}, ${TARGETS.length} targets`);

	const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
	const ctx = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	await page.setContent(viewerHtml(origin), { waitUntil: 'load' });
	await page.waitForFunction(() => !!customElements.get('model-viewer'), null, { timeout: 30000 });

	let ok = 0, fail = 0;
	for (const t of TARGETS) {
		try {
			console.log(`[acc-thumbs] rendering ${t.glb}…`);
			const png = await capture(page, origin + t.glb);
			writeFileSync(join(OUT_DIR, t.out), png);
			console.log(`[acc-thumbs] ✓ ${t.out} (${png.length} bytes)`);
			ok++;
		} catch (err) {
			console.error(`[acc-thumbs] ✗ ${t.glb}: ${err.message}`);
			fail++;
		}
	}

	await browser.close();
	server.close();
	console.log(`[acc-thumbs] done — ${ok} ok, ${fail} failed`);
	if (fail) process.exit(1);
}

main().catch((err) => {
	console.error('[acc-thumbs] fatal:', err);
	process.exit(1);
});
