#!/usr/bin/env node
/**
 * Draws the Android launch post's four images as one horizontal strip.
 *
 * X shows a four-image post as a swipe carousel: one image at a time, each in
 * a fixed cell of about 1.18:1 (measured 600x510 on desktop and on the phone
 * app on 2026-08-28), center-cropped to fit. The old 2x2 grid assumed a
 * collage; in a carousel its 16:9 tiles lose both edges. This draws a single
 * 4800x1020 picture and cuts it into four 1200x1020 tiles, so the tiles match
 * the cell and swiping reads as one continuous scene.
 *
 * Only the soft layers (glow, beam, floor) cross a seam. X's cell shape is not
 * documented and has changed once already; a gradient survives a few percent
 * of crop with nobody the wiser, a phone cut at a crease does not. Every hard
 * edge stays inside its own tile by SAFE pixels.
 *
 * Phones are the raw Seeker-resolution captures make-screenshots.mjs already
 * wrote for the Play listing (--keep-raw); nothing is captured here.
 *
 * Usage:
 *   npm run build:x-strip
 */
import sharp from 'sharp';
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'solana-mobile/publish-play/media/phone/raw');
const OUT = path.join(ROOT, 'marketing/android-launch/kit/strip');

const TILE_W = 1200;
const TILE_H = 1020;
const COUNT = 4;
const W = TILE_W * COUNT;
const H = TILE_H;
const SAFE = 56;
const BG = '#000000';

const SCREENS = { create: 'screen-1', market: 'screen-2', agent: 'screen-3', selfie: 'screen-4', chat: 'screen-5', portal: 'seam-2', discover: 'seam-3' };
const missing = Object.values(SCREENS).filter((s) => !existsSync(path.join(RAW, `${s}.png`)));
if (missing.length) throw new Error(`[x-strip] missing raw captures ${missing.join(', ')}: run make-screenshots.mjs --target=play --keep-raw first`);
const img = Object.fromEntries(Object.entries(SCREENS).map(([k, s]) => [k, `data:image/png;base64,${readFileSync(path.join(RAW, `${s}.png`)).toString('base64')}`]));

const FONT_FACES = [
  ['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
  ['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');
const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;

/* Phone centres are given per tile (0..3) and inside it; the strip x is derived. */
const phone = (src, tile, { x, y, w, tilt = 0, turn = 0, back = false }) =>
  `<div class="phone${back ? ' back' : ''}" style="left:${tile * TILE_W + x}px;top:${y}px;width:${w}px;--tilt:${tilt}deg;--turn:${turn}deg"><img src="${src}" alt=""></div>`;
const cap = (tile, x, y, title, sub) =>
  `<div class="cap" style="left:${tile * TILE_W + x}px;top:${y}px"><b>${title}</b><small>${sub}</small></div>`;

const html = `<!doctype html><meta charset="utf-8"><style>
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:${BG};color:#fff;overflow:hidden;position:relative;
  font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;
  background:
    radial-gradient(14% 44% at 8% 30%, rgba(78,120,255,.22), transparent 70%),
    radial-gradient(12% 40% at 34% 78%, rgba(140,84,255,.16), transparent 72%),
    radial-gradient(14% 44% at 58% 22%, rgba(56,180,255,.16), transparent 70%),
    radial-gradient(12% 40% at 84% 74%, rgba(104,96,255,.16), transparent 72%)}
.beam{position:absolute;left:-4%;right:-4%;top:46%;height:260px;transform:rotate(-1.6deg);
  background:linear-gradient(90deg, transparent, rgba(150,200,255,.09) 14%, rgba(190,220,255,.14) 50%, rgba(150,200,255,.09) 86%, transparent);
  filter:blur(70px)}
.floor{position:absolute;left:0;right:0;bottom:0;height:300px;background:linear-gradient(180deg, transparent, rgba(0,0,0,.85))}
.lockup{position:absolute;left:${SAFE + 40}px;top:${SAFE + 36}px;display:flex;align-items:center;gap:18px}
.lockup img{width:74px;height:74px;border-radius:19px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:48px;letter-spacing:-.045em}
h1{position:absolute;left:${SAFE + 40}px;top:330px;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:118px;line-height:.98;letter-spacing:-.04em}
h1 em{font-style:normal;color:#8fb4ff}
.lede{position:absolute;left:${SAFE + 40}px;top:640px;max-width:${TILE_W - 2 * SAFE - 80}px;font-size:32px;line-height:1.42;color:#a7b6d3}
.small{position:absolute;left:${SAFE + 40}px;bottom:${SAFE + 30}px;font-size:26px;color:#7f90b0}
.phone{position:absolute;
  transform:translate(-50%,-50%) perspective(2000px) rotateY(var(--turn,0deg)) rotateX(3deg) rotate(var(--tilt,0deg));
  border-radius:40px;padding:9px;
  background:linear-gradient(135deg,#4a5070 0%,#2a2e44 26%,#12131f 62%,#31364f 100%);
  box-shadow:0 60px 110px rgba(0,0,0,.92), 0 14px 34px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.10) inset}
.phone img{display:block;width:100%;border-radius:32px;background:${BG}}
.phone::after{content:'';position:absolute;inset:9px;border-radius:32px;pointer-events:none;
  background:linear-gradient(118deg, rgba(255,255,255,.14) 0%, rgba(255,255,255,.03) 18%, transparent 42%)}
.phone.back{opacity:.9;filter:saturate(.94) brightness(.8)}
.cap{position:absolute;transform:translateX(-50%);text-align:center;width:520px}
.cap b{display:block;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:46px;letter-spacing:-.03em}
.cap small{display:block;margin-top:10px;font-size:26px;color:#8fa3c6}
.sign{position:absolute;right:${SAFE + 40}px;bottom:${SAFE + 30}px;display:flex;align-items:center;gap:16px}
.sign img{width:58px;height:58px;border-radius:15px}
.sign span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:40px;letter-spacing:-.045em}
</style><body>
<div class="glow"></div><div class="beam"></div><div class="floor"></div>

<!-- tile 1: the claim -->
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<h1>Now an<br><em>Android app.</em></h1>
<div class="lede">A 3D studio and an AI agent lab, in your pocket. Swipe.</div>
<div class="small">Android 6.0+ &middot; free &middot; open source</div>

<!-- tile 2: make -->
${cap(1, 600, SAFE + 30, 'Make anything', 'type it, photograph it, or take a selfie')}
${phone(img.selfie, 1, { x: 440, y: 640, w: 330, tilt: -3, turn: 10, back: true })}
${phone(img.create, 1, { x: 700, y: 610, w: 360, tilt: 2, turn: -6 })}

<!-- tile 3: bring it to life -->
${cap(2, 600, SAFE + 30, 'Give it a mind', 'a voice, skills, memory, and a body that moves')}
${phone(img.chat, 2, { x: 440, y: 640, w: 330, tilt: 3, turn: 10, back: true })}
${phone(img.agent, 2, { x: 700, y: 610, w: 360, tilt: -2, turn: -6 })}

<!-- tile 4: send it out -->
${cap(3, 560, SAFE + 30, 'Send it out', 'the marketplace, any website, your room in AR')}
${phone(img.portal, 3, { x: 420, y: 640, w: 330, tilt: -3, turn: 10, back: true })}
${phone(img.market, 3, { x: 680, y: 610, w: 360, tilt: 2, turn: -6 })}
<div class="sign"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
</body>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('600 118px "Space Grotesk"') && document.fonts.check('400 32px "Inter"');
  });
  if (!loaded) throw new Error('[x-strip] brand fonts did not load');
  const master = await page.screenshot({ type: 'png' });
  writeFileSync(path.join(OUT, 'android-launch-strip.png'), master);
  const names = ['01-left.png', '02.png', '03.png', '04-right.png'];
  for (const [i, name] of names.entries()) {
    const tile = await sharp(master).extract({ left: i * TILE_W, top: 0, width: TILE_W, height: TILE_H })
      .flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
    if (tile.length > 5 * 1024 * 1024) throw new Error(`[x-strip] ${name} is over X's 5 MB ceiling`);
    writeFileSync(path.join(OUT, name), tile);
    console.log(`[x-strip] ${name}  ${TILE_W}x${TILE_H}  ${Math.round(tile.length / 1024)} KB`);
  }
  console.log(`[x-strip] master: ${path.relative(ROOT, path.join(OUT, 'android-launch-strip.png'))} (${W}x${H}, not an upload)`);
} finally {
  await browser.close();
}
