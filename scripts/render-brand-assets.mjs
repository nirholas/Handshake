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
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import JSZip from 'jszip';

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

// One archive with everything a journalist on deadline needs: the marks just
// rendered, the OpenAI announcement graphics, and a README that carries the
// usage rules so the files can't travel without them.
const ZIP_EXTRAS = [
	['openai/social-card-announcement.png', join(PUBLIC, 'partners/openai/social-card-announcement.png')],
	['openai/social-card-openai-partner.png', join(PUBLIC, 'partners/openai/social-card-openai-partner.png')],
	['openai/social-card-studio.png', join(PUBLIC, 'partners/openai/social-card-studio.png')],
	['openai/three-ws-openai-lockup.png', join(PUBLIC, 'partners/openai/three-ws-openai-lockup.png')],
	['openai/openai-select-partner-badge.svg', join(PUBLIC, 'partners/openai/openai-select-partner.svg')],
];

const README = `three.ws press kit
==================

Everything here is current as of the build that produced this archive. The live
copy, with boilerplate and fast facts, is at https://three.ws/press

marks/
  three-ws-mark.png              The cube on its own. Transparent.
  three-ws-lockup-on-dark.png    Cube + wordmark, light type, for dark grounds.
  three-ws-lockup-on-light.png   Cube + wordmark, dark type, for light grounds.
  three-ws-stacked-on-dark.png   Stacked, light type, for square crops.
  three-ws-stacked-on-light.png  Stacked, dark type, for square crops.

openai/
  Announcement graphics for our OpenAI Select Partner status, plus OpenAI's
  badge as they supplied it. The badge is OpenAI's asset: reproduce it
  unaltered, and do not imply OpenAI endorses a three.ws product. three.ws is an
  independent member of the OpenAI Partner Network at the Select tier. OpenAI,
  ChatGPT, and the OpenAI Partner Network badge are trademarks of OpenAI.

Using the marks
  1. Use the files as they are. No recolouring, outlining, stretching,
     rotating, or rebuilding the cube from parts.
  2. Leave at least half the cube's height of clear space on every side.
  3. Write the name lowercase: three.ws.
  4. Do not lock our mark to another logo without asking.
  5. Editorial use is granted. Coverage, reviews, conference programmes, and
     partner materials need no permission. Using the mark as your own product
     mark, or in a way that implies we endorse a product, does.

Contact: partnerships@three.ws
`;

const zip = new JSZip();
for (const asset of ASSETS) zip.file('marks/' + asset.file, readFileSync(join(OUT_DIR, asset.file)));
for (const [name, src] of ZIP_EXTRAS) {
	if (existsSync(src)) zip.file(name, readFileSync(src));
	else console.warn(`  skipped (missing): ${src}`);
}
zip.file('README.txt', README);

const zipPath = join(OUT_DIR, 'three-ws-press-kit.zip');
writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
const zipBytes = statSync(zipPath).size;
console.log(`three-ws-press-kit.zip  ${Math.round(zipBytes / 1024)} KB  →  ${zipPath}`);

// Keep the size quoted on /press honest. A hand-typed number goes stale the
// first time an asset changes, and "6 MB" that is really 11 is the kind of
// small lie a journalist on a metered connection notices.
const PRESS_PAGE = join(ROOT, 'pages/press/index.html');
if (existsSync(PRESS_PAGE)) {
	const mb = (zipBytes / 1024 / 1024).toFixed(1);
	const before = readFileSync(PRESS_PAGE, 'utf8');
	const after = before.replace(/(<span data-zip-size>)[^<]*(<\/span>)/, `$1${mb} MB$2`);
	if (after !== before) {
		writeFileSync(PRESS_PAGE, after);
		console.log(`pages/press/index.html  zip size → ${mb} MB`);
	}
}

if (failures.length) {
	console.error('\nAssets failed to load. The artwork rendered with fallbacks:');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
