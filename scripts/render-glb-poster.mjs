#!/usr/bin/env node
/**
 * Render a local GLB to a local poster image.
 *
 * A <model-viewer> card that ships with `src` set pays the whole model cost
 * during page load: /create's hero card spent 852 ms of unbroken main-thread
 * time decoding the 748 KB base avatar before the page could answer input. A
 * poster lets the card paint the finished frame immediately and load the live
 * model only when the visitor engages with it.
 *
 * Reuses scripts/glb-thumbnail-harness.html (the same headless model-viewer the
 * asset pipelines render their thumbnails with) so a poster matches the framing
 * and lighting of every other rendered thumbnail on the platform. Unlike
 * scripts/render-glb-thumbnails.mjs, which reads and writes R2, this one works
 * entirely on local files.
 *
 * Usage:
 *   node scripts/render-glb-poster.mjs public/avatars/default.glb public/avatars/default-poster.webp
 *   node scripts/render-glb-poster.mjs <in.glb> <out.(webp|png)> [--size=768] [--quality=82]
 *
 * Camera and lighting default to the shared harness's. Override them to match
 * the viewer the poster stands in for, so the live model does not visibly jump
 * when it loads over the poster:
 *   --orbit="15deg 80deg auto" --fov=30deg --exposure=0.95
 *   --shadow=0.4 --shadow-softness=0.8 --environment=neutral
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const HARNESS = resolve(here, 'glb-thumbnail-harness.html');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const m = a.match(/^--([^=]+)(?:=(.*))?$/);
			return [m[1], m[2] ?? true];
		}),
);
const [inPath, outPath] = positional;
if (!inPath || !outPath) {
	console.error('usage: node scripts/render-glb-poster.mjs <in.glb> <out.(webp|png)> [--size=768] [--quality=82] [--orbit=…] [--fov=…] [--exposure=…] [--shadow=…] [--shadow-softness=…] [--environment=…]');
	process.exit(2);
}
const glb = resolve(root, inPath);
const out = resolve(root, outPath);
if (!existsSync(glb)) {
	console.error(`[poster] no such GLB: ${glb}`);
	process.exit(2);
}
const size = Number(flags.size) || 768;
const quality = Number(flags.quality) || 82;

// The harness loads the model from a URL, and model-viewer applies the same
// cross-origin rules a browser would, so both files are served from one
// short-lived same-origin server on an ephemeral port.
const glbName = basename(glb);
// Most three.ws GLBs (this one included) ship EXT_meshopt_compression, which
// model-viewer does not wire a decoder for on its own, so the shared shim is
// injected ahead of the model-viewer module exactly as every page does it.
const MESHOPT_SHIM = resolve(root, 'public/model-viewer-meshopt.js');
const MV_TAG = '<script type="module" src="https://ajax.googleapis.com';
const server = createServer((req, res) => {
	// '/model/' with the slash: '/model-viewer-meshopt.js' also starts with
	// '/model', and serving it the GLB's bytes made the shim fail to parse and
	// the decoder never register.
	if (req.url.startsWith('/model/')) {
		res.writeHead(200, { 'content-type': 'model/gltf-binary' });
		res.end(readFileSync(glb));
		return;
	}
	if (req.url.startsWith('/model-viewer-meshopt.js')) {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(readFileSync(MESHOPT_SHIM));
		return;
	}
	const html = readFileSync(HARNESS, 'utf8').replace(
		MV_TAG,
		`<script src="/model-viewer-meshopt.js"></script>${MV_TAG}`,
	);
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import('playwright');
const browser = await chromium.launch({
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
	const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
	page.on('console', (m) => console.error('[poster][page]', m.type(), m.text().slice(0, 300)));
	page.on('pageerror', (e) => console.error('[poster][pageerror]', String(e).slice(0, 300)));
	await page.goto(origin, { waitUntil: 'load', timeout: 60_000 });
	await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
	// A poster is a still of the live viewer's first frame, so it has to be shot
	// with that viewer's camera and lighting or the model visibly jumps when the
	// real thing loads over it. These override the harness defaults.
	const look = {
		'camera-orbit': flags.orbit,
		'field-of-view': flags.fov,
		exposure: flags.exposure,
		'shadow-intensity': flags.shadow,
		'shadow-softness': flags['shadow-softness'],
		'environment-image': flags.environment,
	};
	await page.evaluate((attrs) => {
		const mv = document.getElementById('mv');
		for (const [k, v] of Object.entries(attrs)) if (v) mv.setAttribute(k, String(v));
	}, look);
	const dataUrl = await page.evaluate((u) => window.__renderGlb(u).catch((e) => { throw new Error(String(e && e.message || e)); }), `${origin}/model/${glbName}`);
	const png = Buffer.from(String(dataUrl).split(',')[1], 'base64');
	const sharp = (await import('sharp')).default;
	const img = sharp(png).resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
	const bytes = extname(out).toLowerCase() === '.webp'
		? await img.webp({ quality }).toBuffer()
		: await img.png({ compressionLevel: 9 }).toBuffer();
	writeFileSync(out, bytes);
	const meta = await sharp(bytes).metadata();
	console.log(`[poster] ${inPath} -> ${outPath} (${meta.width}x${meta.height}, ${(bytes.length / 1024).toFixed(1)} KiB)`);
} finally {
	await browser.close();
	server.close();
}
