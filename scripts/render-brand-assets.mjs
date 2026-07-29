#!/usr/bin/env node
/**
 * Renders the three.ws brand asset set to transparent PNGs.
 *
 * Source of truth is marketing/brand/brand-assets.html. Each element listed in
 * ASSETS below is screenshotted with omitBackground, so what lands in
 * public/brand/ is the artwork with a real alpha channel and no dead margin,
 * which is what a journalist, a partner deck, or a conference programme needs.
 *
 * The mark itself is not redrawn here: it is public/pwa-512x512.png (the shipped
 * app icon) trimmed of its transparent border. The wordmark is set in Space
 * Grotesk, the display face the site already uses, so the lockups match the
 * product rather than inventing a second identity.
 *
 * The page is served over HTTP (not file://) so /fonts/*.woff2 resolve exactly
 * as they do in production; a file:// load silently falls back to a system face
 * and the wordmark ships wrong.
 *
 * Usage:
 *   npm run build:brand-assets
 *   node scripts/render-brand-assets.mjs --scale=3 --out=/tmp/brand
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const SCALE = Number(args.scale) || 2;
const OUT_DIR = args.out ? resolve(String(args.out)) : join(PUBLIC, 'brand');
const PAGE = '/marketing/brand/brand-assets.html';

const ASSETS = [
	{ id: 'mark', file: 'three-ws-mark.png' },
	{ id: 'lockup-dark', file: 'three-ws-lockup-on-dark.png' },
	{ id: 'lockup-light', file: 'three-ws-lockup-on-light.png' },
	{ id: 'stack-dark', file: 'three-ws-stacked-on-dark.png' },
	{ id: 'stack-light', file: 'three-ws-stacked-on-light.png' },
];

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
};

/** Resolve a request path against public/ first, then the repo root. */
function resolveAsset(urlPath) {
	const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
	for (const base of [PUBLIC, ROOT]) {
		const abs = join(base, rel);
		if (abs.startsWith(base) && existsSync(abs) && statSync(abs).isFile()) return abs;
	}
	return null;
}

function startServer() {
	const server = createServer((req, res) => {
		const abs = resolveAsset(new URL(req.url, 'http://localhost').pathname);
		if (!abs) { res.writeHead(404).end('not found'); return; }
		res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' });
		createReadStream(abs).pipe(res);
	});
	return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: SCALE });

const failures = [];
page.on('requestfailed', (r) => failures.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });

await page.goto(origin + PAGE, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

for (const asset of ASSETS) {
	const el = page.locator(`#${asset.id}`);
	const box = await el.boundingBox();
	if (!box || box.width < 40 || box.height < 40) {
		throw new Error(`${asset.id}: element did not render (measured ${JSON.stringify(box)})`);
	}
	const out = join(OUT_DIR, asset.file);
	await el.screenshot({ path: out, omitBackground: true });
	const kb = Math.round(statSync(out).size / 1024);
	console.log(`${asset.file}  ${Math.round(box.width * SCALE)}×${Math.round(box.height * SCALE)}  ${kb} KB  →  ${out}`);
}

await browser.close();
server.close();

if (failures.length) {
	console.error('\nAssets failed to load. The artwork rendered with fallbacks:');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
