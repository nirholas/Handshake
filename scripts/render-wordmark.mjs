#!/usr/bin/env node
/**
 * Renders the three.ws wordmark centred on a fixed-size canvas.
 *
 * This is the full-bleed companion to scripts/render-brand-assets.mjs. That
 * renderer exports trimmed, transparent marks sized to their own artwork; this
 * one fills an exact pixel canvas (4096 x 2304 by default, 16:9) with the
 * wordmark alone, which is what a wallpaper, a title card, a stage backdrop, or
 * a store banner needs.
 *
 * The type is drawn on a 2D canvas inside a real browser, against the same
 * /fonts/*.woff2 files the site serves, so the wordmark can never drift from
 * the product's typography. Drawing rather than screenshotting means the output
 * is exactly the requested pixel dimensions with no crop or rounding.
 *
 * Importable: scripts/render-play-assets.mjs calls renderWordmarks() for the
 * Play developer-page header rather than re-deriving the font plumbing.
 *
 * Usage:
 *   npm run build:wordmark
 *   node scripts/render-wordmark.mjs --width=1920 --height=1080 --fit=0.5
 *   node scripts/render-wordmark.mjs --out=/tmp/wordmark --variants=on-dark
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

export const WORD = 'three.ws';
/* Matches the lockup in marketing/brand/brand-assets.html: the wordmark is one
   mark, not two, so weight and tracking are copied rather than re-chosen. */
export const WEIGHT = 600;
export const TRACKING = -0.045; // em
/** Wordmark ink width as a fraction of canvas width. Leaves real clear space. */
export const FIT = 0.46;

export const VARIANTS = [
	{ id: 'on-dark', file: 'three-ws-wordmark-on-dark', bg: '#000000', fg: '#ffffff' },
	{ id: 'on-light', file: 'three-ws-wordmark-on-light', bg: '#ffffff', fg: '#0b0d0c' },
	{ id: 'transparent', file: 'three-ws-wordmark-transparent', bg: null, fg: '#ffffff' },
];

const MIME = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8' };

/** Resolve a request path against public/ first, then the repo root. */
function resolveAsset(urlPath) {
	const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
	for (const base of [PUBLIC, ROOT]) {
		const abs = join(base, rel);
		if (abs.startsWith(base) && existsSync(abs) && statSync(abs).isFile()) return abs;
	}
	return null;
}

/**
 * Serve the repo over HTTP so /fonts/*.woff2 resolve exactly as in production.
 * A file:// load silently falls back to a system face and ships a wrong logo.
 */
function startServer() {
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/') {
			res.writeHead(200, { 'content-type': MIME['.html'] });
			res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fonts/fonts.css"><body></body>');
			return;
		}
		const abs = resolveAsset(url.pathname);
		if (!abs) { res.writeHead(404).end('not found'); return; }
		res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' });
		createReadStream(abs).pipe(res);
	});
	return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * Screenshot an HTML fragment at an exact pixel size, against the repo's own
 * fonts. The page is served over HTTP so /fonts/*.woff2 resolve as they do in
 * production; a file:// load silently substitutes a system face.
 *
 * @param {string} bodyHtml  markup placed inside a full-bleed body
 * @param {{width:number,height:number}} size
 * @returns {Promise<Buffer>} opaque PNG at exactly the requested size
 */
export async function renderPage(bodyHtml, { width, height }) {
	const server = await startServer();
	const origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

	const failures = [];
	page.on('requestfailed', (r) => failures.push(r.url()));
	page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });

	try {
		await page.goto(origin + '/', { waitUntil: 'networkidle' });
		await page.setContent(
			`<!doctype html><meta charset="utf-8">` +
			`<base href="${origin}/">` +
			`<link rel="stylesheet" href="/fonts/fonts.css">` +
			`<style>*{box-sizing:border-box;margin:0;padding:0}` +
			`html,body{width:${width}px;height:${height}px;overflow:hidden}</style>` +
			`<body>${bodyHtml}</body>`,
			{ waitUntil: 'networkidle' },
		);
		await page.evaluate(() => document.fonts.ready);
		const ok = await page.evaluate(() => document.fonts.check('600 100px "Space Grotesk"'));
		if (!ok) throw new Error('Space Grotesk did not load; the artwork would render in a fallback face');

		const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
		if (failures.length) {
			throw new Error('assets failed to load, the artwork rendered with fallbacks:\n  ' + failures.join('\n  '));
		}
		return sharp(shot).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
	} finally {
		await browser.close();
		server.close();
	}
}

/**
 * Draw the wordmark centred on each requested canvas.
 *
 * @param {Array<{width:number,height:number,bg:string|null,fg:string,fit?:number}>} specs
 * @returns {Promise<Array<{buffer:Buffer,size:number,ink:object,offset:object}>>}
 */
export async function renderWordmarks(specs) {
	const server = await startServer();
	const origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await chromium.launch();
	const page = await browser.newPage();

	const failures = [];
	page.on('requestfailed', (r) => failures.push(r.url()));
	page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });

	try {
		await page.goto(origin + '/', { waitUntil: 'networkidle' });

		/* A canvas silently substitutes a system face for a font it cannot see,
		   which ships a wrong-looking logo rather than an error. Load it
		   explicitly and assert it took before anything is drawn. */
		const fontOk = await page.evaluate(async ({ weight, word }) => {
			await document.fonts.load(`${weight} 100px "Space Grotesk"`, word);
			await document.fonts.ready;
			return document.fonts.check(`${weight} 100px "Space Grotesk"`);
		}, { weight: WEIGHT, word: WORD });
		if (!fontOk) throw new Error('Space Grotesk did not load; the wordmark would render in a fallback face');

		const out = [];
		for (const spec of specs) {
			const drawn = await page.evaluate(async (cfg) => {
				const canvas = document.createElement('canvas');
				canvas.width = cfg.width;
				canvas.height = cfg.height;
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				if (!('letterSpacing' in ctx)) throw new Error('canvas letterSpacing is unsupported; tracking would be wrong');

				const applyFont = (size) => {
					ctx.font = `${cfg.weight} ${size}px "Space Grotesk"`;
					ctx.letterSpacing = `${cfg.tracking * size}px`;
				};
				/** Ink box reported by the font metrics, before rasterisation. */
				const measure = (size) => {
					applyFont(size);
					const m = ctx.measureText(cfg.word);
					return {
						width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
						height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
						left: m.actualBoundingBoxLeft,
						ascent: m.actualBoundingBoxAscent,
					};
				};

				/* Ink width scales linearly with font size, so one probe gives the
				   exact size for the target width. */
				const probe = 1000;
				const size = (probe * (cfg.width * cfg.fit)) / measure(probe).width;
				const ink = measure(size);

				/** Bounds of what was actually painted, read back from the alpha channel. */
				const paintedBounds = () => {
					const { data } = ctx.getImageData(0, 0, cfg.width, cfg.height);
					let minX = cfg.width, maxX = -1, minY = cfg.height, maxY = -1;
					for (let y = 0; y < cfg.height; y++) {
						for (let x = 0; x < cfg.width; x++) {
							if (data[(y * cfg.width + x) * 4 + 3] > 8) {
								if (x < minX) minX = x;
								if (x > maxX) maxX = x;
								if (y < minY) minY = y;
								if (y > maxY) maxY = y;
							}
						}
					}
					return { minX, maxX, minY, maxY, cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2 };
				};

				/* Position by the ink box, not the line box: lowercase with
				   ascenders and no descenders rides visibly low when its line box
				   is centred. */
				const draw = (dx, dy) => {
					ctx.clearRect(0, 0, cfg.width, cfg.height);
					applyFont(size);
					ctx.fillStyle = cfg.fg;
					ctx.textAlign = 'left';
					ctx.textBaseline = 'alphabetic';
					ctx.fillText(
						cfg.word,
						(cfg.width - ink.width) / 2 + ink.left + dx,
						(cfg.height - ink.height) / 2 + ink.ascent + dy,
					);
				};

				/* Font metrics and the rasteriser disagree by a pixel or two once
				   antialiasing is on. Draw once on a transparent ground, measure
				   the pixels that actually landed, and redraw with that
				   correction, so the painted glyphs are centred rather than the
				   metrics that predicted them. */
				draw(0, 0);
				const first = paintedBounds();
				if (first.maxX < 0) throw new Error('nothing was painted; the wordmark failed to render');
				draw(cfg.width / 2 - first.cx, cfg.height / 2 - first.cy);
				const final = paintedBounds();

				/* The background goes on underneath, so the correction pass above
				   reads a clean alpha channel regardless of variant. */
				if (cfg.bg) {
					ctx.globalCompositeOperation = 'destination-over';
					ctx.fillStyle = cfg.bg;
					ctx.fillRect(0, 0, cfg.width, cfg.height);
					ctx.globalCompositeOperation = 'source-over';
				}

				const url = canvas.toDataURL('image/png');
				return {
					data: url.slice(url.indexOf(',') + 1),
					size,
					ink: { width: final.maxX - final.minX + 1, height: final.maxY - final.minY + 1 },
					offset: { x: final.cx - cfg.width / 2, y: final.cy - cfg.height / 2 },
				};
			}, {
				width: spec.width,
				height: spec.height,
				fit: spec.fit ?? FIT,
				word: WORD,
				weight: WEIGHT,
				tracking: TRACKING,
				bg: spec.bg,
				fg: spec.fg,
			});

			/* An opaque asset must not carry an alpha channel: a store slot
			   (Play's header image and feature graphic among them) requires
			   24-bit PNG, and the channel is dead weight everywhere else.
			   toDataURL only ever emits RGBA. */
			const raw = Buffer.from(drawn.data, 'base64');
			const pipeline = sharp(raw);
			const buffer = await (spec.bg ? pipeline.removeAlpha() : pipeline)
				.png({ compressionLevel: 9 })
				.toBuffer();

			out.push({ ...spec, buffer, size: drawn.size, ink: drawn.ink, offset: drawn.offset });
		}

		if (failures.length) {
			throw new Error('assets failed to load, the artwork rendered with fallbacks:\n  ' + failures.join('\n  '));
		}
		return out;
	} finally {
		await browser.close();
		server.close();
	}
}

/* CLI */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = Object.fromEntries(process.argv.slice(2).map((a) => {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		return m ? [m[1], m[2] ?? true] : [a, true];
	}));

	const width = Number(args.width) || 4096;
	const height = Number(args.height) || 2304;
	const fit = Number(args.fit) || FIT;
	const outDir = args.out ? resolve(String(args.out)) : join(PUBLIC, 'brand');

	const wanted = args.variants ? String(args.variants).split(',').map((s) => s.trim()) : null;
	const selected = wanted ? VARIANTS.filter((v) => wanted.includes(v.id)) : VARIANTS;
	if (!selected.length) throw new Error(`no variants matched: ${args.variants}`);

	mkdirSync(outDir, { recursive: true });
	const rendered = await renderWordmarks(selected.map((v) => ({ ...v, width, height, fit })));

	for (const r of rendered) {
		const out = join(outDir, `${r.file}-${width}x${height}.png`);
		writeFileSync(out, r.buffer);
		const kb = Math.round(statSync(out).size / 1024);
		console.log(
			`${r.file}-${width}x${height}.png  ${width}x${height}  ` +
			`type ${Math.round(r.size)}px, ink ${r.ink.width}x${r.ink.height}, ` +
			`off-centre ${r.offset.x.toFixed(1)},${r.offset.y.toFixed(1)}px  ${kb} KB  ->  ${out}`,
		);
	}
}
