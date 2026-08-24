#!/usr/bin/env node
/**
 * Renders the $THREE pump.fun verification graphics to PNG.
 *
 * Source of truth is marketing/pumpfun-verified/partnership-card.html. Edit the
 * layout or copy there, re-run this, commit the PNGs. One layout renders two
 * crops: 16:9 for a timeline post and 1:1 for the surfaces that square-crop
 * (profile posts, Telegram previews, link cards).
 *
 * The page is served over HTTP rather than opened with file://, for the same
 * reason the OpenAI card renderer does it: a file:// load silently fails the
 * woff2 fetches and the card renders in DejaVu Sans instead of Inter and Space
 * Grotesk, which is not obviously wrong until you compare it to the house cards.
 * Any asset that fails to load fails this script rather than shipping a card
 * rendered with fallbacks.
 *
 * Usage:
 *   node scripts/render-pumpfun-verified.mjs
 *   node scripts/render-pumpfun-verified.mjs --scale=3 --out=/tmp/cards
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const SCALE = Number(args.scale) || 2;
const OUT_DIR = args.out ? resolve(String(args.out)) : join(ROOT, 'marketing', 'pumpfun-verified');
const CARD_PAGE = '/marketing/pumpfun-verified/partnership-card.html';

const CARDS = [
	{ hash: '', width: 1600, height: 900, file: 'three-ws-pumpfun-verified-16x9.png' },
	{ hash: '#square', width: 1600, height: 1600, file: 'three-ws-pumpfun-verified-1x1.png' },
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
const failures = [];

for (const card of CARDS) {
	const page = await browser.newPage({
		viewport: { width: card.width, height: card.height },
		deviceScaleFactor: SCALE,
	});
	page.on('requestfailed', (r) => failures.push(r.url()));
	page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });

	await page.goto(origin + CARD_PAGE + card.hash, { waitUntil: 'networkidle' });
	await page.evaluate(() => document.fonts.ready);

	const out = join(OUT_DIR, card.file);
	// The chrome cube mark is a smooth gradient that bands visibly under a
	// 256-color palette, so these stay truecolor. They compress well anyway:
	// the card is flat black everywhere the two marks are not.
	await sharp(await page.screenshot()).png({ compressionLevel: 9 }).toFile(out);
	console.log(`${card.file}  ${card.width * SCALE}x${card.height * SCALE}  ${Math.round(statSync(out).size / 1024)} KB  ->  ${out}`);
	await page.close();
}

await browser.close();
server.close();

if (failures.length) {
	console.error('\nAssets failed to load. The card rendered with fallbacks:');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
