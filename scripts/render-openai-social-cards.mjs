#!/usr/bin/env node
/**
 * Renders the OpenAI Select Partner social cards to PNG.
 *
 * Source of truth is marketing/openai-select-partner/cards/social-card.html.
 * Edit the copy or layout there, re-run this, commit the PNGs. Each <section
 * class="card"> in that file is screenshotted at 2× into public/partners/openai/,
 * so the cards ship with the site and can be referenced by URL from X, LinkedIn,
 * the press release, and Open Graph tags.
 *
 * The page is served over HTTP (not file://) so /fonts/*.woff2 and the badge SVG
 * resolve exactly as they do in production; a file:// load silently falls back to
 * DejaVu Sans and ruins the typography.
 *
 * Usage:
 *   node scripts/render-openai-social-cards.mjs
 *   node scripts/render-openai-social-cards.mjs --scale=3 --out=/tmp/cards
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
const OUT_DIR = args.out ? resolve(String(args.out)) : join(PUBLIC, 'partners', 'openai');
const CARD_PAGE = '/marketing/openai-select-partner/cards/social-card.html';

// palette: false keeps a card in truecolor. The white lockup card is a smooth
// chrome gradient on flat white, where a 256-colour palette bands visibly.
const CARDS = [
	{ id: 'card-announce', file: 'social-card-announcement.png' },
	{ id: 'card-announce-short', file: 'social-card-openai-partner.png' },
	{ id: 'card-studio', file: 'social-card-studio.png' },
	{ id: 'card-logos', file: 'three-ws-openai-lockup.png', palette: false },
	{ id: 'card-logos-dark', file: 'three-ws-openai-lockup-dark.png', palette: false },
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
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 }, deviceScaleFactor: SCALE });

const failures = [];
page.on('requestfailed', (r) => failures.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });

await page.goto(origin + CARD_PAGE, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

for (const card of CARDS) {
	const el = page.locator(`#${card.id}`);
	const box = await el.boundingBox();
	if (!box || Math.round(box.width) !== 1600 || Math.round(box.height) !== 900) {
		throw new Error(`${card.id}: expected a 1600×900 card, measured ${box && `${box.width}×${box.height}`}`);
	}
	const out = join(OUT_DIR, card.file);
	// The film-grain layer makes raw truecolor PNGs incompressible (~3 MB each).
	// A dithered 256-color palette is visually identical on these dark cards and
	// keeps the OG images light enough for social crawlers.
	const raw = await el.screenshot();
	const png = card.palette === false
		? sharp(raw).png({ compressionLevel: 9 })
		: sharp(raw).png({ palette: true, quality: 90, dither: 1.0 });
	await png.toFile(out);
	const kb = Math.round(statSync(out).size / 1024);
	console.log(`${card.file}  ${1600 * SCALE}×${900 * SCALE}  ${kb} KB  →  ${out}`);
}

await browser.close();
server.close();

if (failures.length) {
	console.error('\nAssets failed to load. The card rendered with fallbacks:');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
