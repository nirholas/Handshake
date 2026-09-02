#!/usr/bin/env node
/**
 * Renders the CoinMarketCap cover for the mobile-launch article
 * (docs/mobile-launch/coinmarketcap-article.md): one 16:9 composition,
 * which is exactly the 640x360 proportion CMC's uploader asks for.
 *
 * Same construction as the Android launch kit (scripts/make-x-grid.mjs):
 * drawn from the live brand fonts, the app mark, and real product captures
 * from the Play listing run, so the cover cannot show UI the app does not
 * have. Unlike the X grid there are no collage seams, so this is a single
 * clean plane: lockup top left, one headline, three phones.
 *
 * Usage:
 *   node marketing/mobile-launch/make-cmc-cover.mjs
 *   node marketing/mobile-launch/make-cmc-cover.mjs --out=/tmp/cover
 *
 * Outputs (in marketing/mobile-launch/ by default):
 *   cmc-cover-1280x720.png   upload this one; CMC accepts the proportion
 *   cmc-cover-640x360.png    the exact stated size, if the form insists
 */
import sharp from 'sharp';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = path.join(ROOT, 'solana-mobile/publish-play/media/phone/raw');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT = args.out ? path.resolve(String(args.out)) : path.join(ROOT, 'marketing/mobile-launch');

/* Drawn at 1920x1080 and downscaled, so type and bezels stay crisp. */
const W = 1920;
const H = 1080;
const BG = '#000000';

const FONT_FACES = [
	['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
	['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');

const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;

/* One capture per phone, from the Play listing run. */
const SCREENS = ['screen-3', 'screen-2', 'screen-4'];
const missing = SCREENS.filter((s) => !existsSync(path.join(RAW, `${s}.png`)));
if (missing.length) {
	throw new Error(
		`[cmc-cover] missing raw captures: ${missing.join(', ')}\n` +
		'Run: node solana-mobile/scripts/make-screenshots.mjs --target=play --keep-raw',
	);
}
const shots = Object.fromEntries(SCREENS.map((s) => [s, `data:image/png;base64,${readFileSync(path.join(RAW, `${s}.png`)).toString('base64')}`]));

/* Three phones under the headline: the centre one forward and larger, the
   flanks set back and turned toward it. Widths include the 13px bezel. */
const PHONES = [
	{ screen: 'screen-3', x: W * 0.30, y: 832, w: 268, tilt: -3, turn: 16, pitch: 6, back: true },
	{ screen: 'screen-4', x: W * 0.70, y: 832, w: 268, tilt: 3, turn: -16, pitch: 6, back: true },
	{ screen: 'screen-2', x: W * 0.50, y: 800, w: 316, tilt: 0, turn: 0, pitch: 5 },
].map(({ screen, x, y, w, tilt, turn, pitch, back }) =>
	`<div class="phone${back ? ' back' : ''}" style="left:${x}px;top:${y}px;width:${w}px;--tilt:${tilt}deg;--turn:${turn}deg;--pitch:${pitch}deg">
    <img src="${shots[screen]}" alt="">
  </div>`).join('\n');

const html = `<!doctype html><meta charset="utf-8"><style>
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:${BG};color:#fff;overflow:hidden;position:relative;
  font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;
  background:
    radial-gradient(34% 40% at 22% 26%, rgba(78,120,255,.20), transparent 70%),
    radial-gradient(30% 36% at 80% 20%, rgba(56,180,255,.14), transparent 72%),
    radial-gradient(46% 42% at 50% 96%, rgba(120,90,255,.20), transparent 70%)}
.beam{position:absolute;left:6%;right:6%;top:44%;height:260px;transform:rotate(-3deg);
  background:linear-gradient(90deg, transparent, rgba(150,200,255,.09) 22%, rgba(190,220,255,.13) 50%, rgba(150,200,255,.09) 78%, transparent);
  filter:blur(70px)}
/* The floor the phones stand on: a dim pool of light, falling to black. */
.floor{position:absolute;left:14%;right:14%;bottom:-140px;height:340px;border-radius:50%;
  background:radial-gradient(closest-side, rgba(110,140,255,.16), transparent 72%);filter:blur(40px)}

.lockup{position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:18px}
.lockup img{width:88px;height:88px;border-radius:22px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:58px;letter-spacing:-.045em}

.head{position:absolute;left:0;right:0;top:196px;text-align:center}
.head h1{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:108px;line-height:1.04;letter-spacing:-.04em}
.head h1 em{font-style:normal;color:#8fb4ff}
.head p{margin-top:26px;font-size:37px;color:#a7b7d9;letter-spacing:-.01em}

.phone{position:absolute;
  transform:translate(-50%,-50%) perspective(2200px) rotateY(var(--turn,0deg)) rotateX(var(--pitch,4deg)) rotate(var(--tilt,0deg));
  transform-style:preserve-3d;
  border-radius:44px;padding:13px;
  background:linear-gradient(135deg,#4a5070 0%,#2a2e44 26%,#12131f 62%,#31364f 100%);
  box-shadow:
    0 60px 110px rgba(0,0,0,.92),
    0 14px 34px rgba(0,0,0,.7),
    0 0 0 1px rgba(255,255,255,.10) inset,
    0 2px 0 rgba(255,255,255,.16) inset}
.phone img{display:block;width:100%;border-radius:33px;background:${BG}}
.phone::after{content:'';position:absolute;inset:13px;border-radius:33px;pointer-events:none;
  background:linear-gradient(118deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.04) 18%, transparent 42%)}
.phone.back{opacity:.92;filter:saturate(.94) brightness(.82)}
</style><body>
<div class="glow"></div><div class="beam"></div><div class="floor"></div>

<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>

<div class="head">
  <h1>Now on <em>Seeker</em>, Android<br>and iPhone.</h1>
  <p>A 3D agent studio in your pocket &middot; free &middot; open source</p>
</div>

${PHONES}
</body>`;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
	await page.setContent(html, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	const master = await page.screenshot({ type: 'png' });
	for (const [w, h] of [[1280, 720], [640, 360]]) {
		const buf = await sharp(master).removeAlpha().resize(w, h, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
		writeFileSync(path.join(OUT, `cmc-cover-${w}x${h}.png`), buf);
		console.log(`[cmc-cover] wrote cmc-cover-${w}x${h}.png (${(buf.length / 1024).toFixed(0)} KB)`);
	}
} finally {
	await browser.close();
}
