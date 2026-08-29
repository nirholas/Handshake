#!/usr/bin/env node
/**
 * Draws the single-image cards for the Android launch thread on X.
 *
 * The opener carries the four-tile grid (scripts/make-x-grid.mjs). Five of the
 * replies earn one image each, and only those five: an image belongs where it
 * does a job the words cannot, showing a feature or making a number tangible,
 * and a thread where every reply carries one reads as an ad. Each card is
 * 1600x900, the aspect X shows a lone image at without cropping, and every
 * phone in them is a live capture of the product at Seeker resolution.
 *
 * Cards, by the post they attach to (numbering from marketing/android-launch/kit/post.md):
 *   04-features.png    Forge, Scan and Portal, three phones
 *   07-launchpad.png   the launch screen beside the 3D agent that fronts the coin
 *   08-agents-work.png the live trading arena
 *   11-tiers.png       the hold-to-access ladder, from api/_lib/three-tier.js
 *   14-install.png     the three install steps beside the app's home screen
 *
 * Usage:
 *   npm run build:x-cards
 *   node scripts/make-x-thread-cards.mjs --origin=http://localhost:3000
 */
import sharp from 'sharp';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TIERS } from '../api/_lib/three-tier.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = args.out ? path.resolve(String(args.out)) : path.join(ROOT, 'marketing/android-launch/kit/cards');

const W = 1600;
const H = 900;
/* Same ground as the grid: true black, so the card and X's dark UI meet
   without a visible rectangle, with dim glows that fall off before the edge. */
const BG = '#000000';

const FONT_FACES = [
  ['Space Grotesk', '300 700', 'space-grotesk-latin.woff2'],
  ['Inter', '300 800', 'inter-latin.woff2'],
].map(([family, weight, file]) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path.join(ROOT, 'public/fonts', file)).toString('base64')}) format('woff2');}`).join('\n');
const MARK_URI = `data:image/png;base64,${readFileSync(path.join(ROOT, 'public/pwa-512x512.png')).toString('base64')}`;

/* Floating product widgets that are useful in the app and noise in a frame. */
const OVERLAY_SELECTORS = ['#tws-corner-stack', '.twx-i18n-fab', '.walk-companion', '.walk-c2w-fx', '.walk-trail-layer', '#market-sidebar-toggle'];

const SCREENS = {
  forge: { path: '/forge' },
  selfie: { path: '/create/selfie' },
  portal: { path: '/portal' },
  launch: { path: '/launch' },
  /* A listed agent whose stored render faces the camera, so the launchpad
     card shows the "living 3D agent as its face" the post promises. */
  agent: { path: '/agents/34706ed9-6277-4e84-8963-4fe5aca9c9c7' },
  arena: { path: '/play/arena' },
  home: { path: '/seeker' },
};

async function capture(ctx, spec) {
  const page = await ctx.newPage();
  const url = ORIGIN + spec.path;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  } catch {
    /* networkidle never settles on a page holding an open socket; the render is
       complete by the time the settle below elapses. */
  }
  await page.addStyleTag({ content: `${OVERLAY_SELECTORS.join(',')}{display:none!important}` });
  if (spec.scrollBy) await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' }), spec.scrollBy);
  await page.waitForTimeout(9000);
  const buf = await page.screenshot({ type: 'png' });
  await page.close();
  const means = (await sharp(buf).stats()).channels.map((c) => c.mean);
  if (means.every((m) => m < 6)) throw new Error(`[x-cards] capture of ${url} is effectively blank`);
  console.log(`[x-cards] captured ${url}`);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const phone = (src, { x, y, w, tilt = 0, turn = 0 }) =>
  `<div class="phone" style="left:${x}px;top:${y}px;width:${w}px;--tilt:${tilt}deg;--turn:${turn}deg"><img src="${src}" alt=""></div>`;

const BASE_CSS = `
${FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;background:${BG};color:#fff;overflow:hidden;position:relative;
  font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;
  background:
    radial-gradient(34% 40% at 22% 28%, rgba(78,120,255,.22), transparent 70%),
    radial-gradient(30% 36% at 80% 24%, rgba(56,180,255,.14), transparent 72%),
    radial-gradient(34% 40% at 30% 84%, rgba(140,84,255,.16), transparent 70%),
    radial-gradient(30% 36% at 84% 80%, rgba(104,96,255,.14), transparent 72%)}
.beam{position:absolute;left:4%;right:4%;top:40%;height:220px;transform:rotate(-5deg);
  background:linear-gradient(90deg, transparent, rgba(150,200,255,.09) 22%, rgba(190,220,255,.14) 50%, rgba(150,200,255,.09) 78%, transparent);
  filter:blur(60px)}
.lockup{position:absolute;left:72px;top:60px;display:flex;align-items:center;gap:16px}
.lockup img{width:64px;height:64px;border-radius:17px}
.lockup span{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:42px;letter-spacing:-.045em}
h1{font-family:'Space Grotesk',sans-serif;font-weight:600;letter-spacing:-.04em;line-height:1.02}
.phone{position:absolute;
  transform:translate(-50%,-50%) perspective(1800px) rotateY(var(--turn,0deg)) rotateX(3deg) rotate(var(--tilt,0deg));
  border-radius:34px;padding:8px;
  background:linear-gradient(135deg,#4a5070 0%,#2a2e44 26%,#12131f 62%,#31364f 100%);
  box-shadow:0 50px 100px rgba(0,0,0,.92), 0 12px 30px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.10) inset}
.phone img{display:block;width:100%;border-radius:27px;background:${BG}}
.phone::after{content:'';position:absolute;inset:8px;border-radius:27px;pointer-events:none;
  background:linear-gradient(118deg, rgba(255,255,255,.14) 0%, rgba(255,255,255,.03) 18%, transparent 42%)}
.cap{position:absolute;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:34px;letter-spacing:-.03em;text-align:center;transform:translateX(-50%)}
.cap small{display:block;margin-top:8px;font-family:'Inter',sans-serif;font-weight:400;font-size:21px;color:#8fa3c6;letter-spacing:0}
.copy{position:absolute;left:72px;max-width:640px}
.copy h1{font-size:74px}
.copy p{margin-top:26px;font-size:27px;line-height:1.45;color:#a7b6d3}
`;

const CARDS = {
  '04-features.png': (s) => `
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy" style="top:200px;max-width:520px">
  <h1>Free.<br>No wallet.</h1>
  <p>Forge builds any object from a sentence or a photo. Scan turns one selfie into a rigged character. Portal turns any website into a world you can walk.</p>
</div>
${phone(s.forge, { x: 800, y: 560, w: 300, tilt: -4, turn: 10 })}
${phone(s.selfie, { x: 1090, y: 500, w: 330 })}
${phone(s.portal, { x: 1380, y: 560, w: 300, tilt: 4, turn: -10 })}
<div class="cap" style="left:800px;top:82px">Forge<small>type it, get a 3D model</small></div>
<div class="cap" style="left:1090px;top:82px">Scan<small>one selfie, one character</small></div>
<div class="cap" style="left:1380px;top:82px">Portal<small>walk any website</small></div>`,

  '07-launchpad.png': (s) => `
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy" style="top:230px">
  <h1>The launchpad,<br>in your pocket.</h1>
  <p>Launch a coin from your phone with a living 3D agent as its face. Every launch lands in one public feed.</p>
</div>
${phone(s.launch, { x: 1040, y: 540, w: 330, tilt: -3, turn: 10 })}
${phone(s.agent, { x: 1330, y: 490, w: 360, tilt: 3, turn: -8 })}
<div class="cap" style="left:1040px;top:82px">Launch<small>pick your agent, mint the coin</small></div>
<div class="cap" style="left:1330px;top:82px">Its face<small>a living 3D agent</small></div>`,

  '08-agents-work.png': (s) => `
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy" style="top:230px">
  <h1>Your agents<br>work.</h1>
  <p>They hold wallets, trade, sell services and pay each other. They compete in live arenas while you sleep.</p>
</div>
${phone(s.arena, { x: 1180, y: 520, w: 380, tilt: -3, turn: 8 })}`,

  '11-tiers.png': () => {
    const rows = TIERS.filter((t) => t.minUsd > 0).map((t) => `
      <tr><td class="t">${t.label}</td><td>$${t.minUsd.toLocaleString('en-US')}</td><td>${t.rateMultiplier}x</td><td>${t.discountBps / 100}% off</td></tr>`).join('');
    return `
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy" style="top:210px;max-width:560px">
  <h1>Hold $THREE.<br>Move up.</h1>
  <p>Your holding sets your tier. Free limits multiply and compute costs drop. You never spend it.</p>
</div>
<table class="tiers" style="position:absolute;left:820px;top:210px">
  <thead><tr><th>Tier</th><th>Hold</th><th>Free limits</th><th>Compute</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div style="position:absolute;left:820px;top:690px;font-size:20px;color:#6f7f9d;font-family:'Inter',sans-serif">FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump</div>
<style>
.tiers{border-collapse:collapse;font-size:30px}
.tiers th{font-weight:500;font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#7f90b0;text-align:left;padding:0 44px 18px 0}
.tiers td{padding:20px 44px 20px 0;border-top:1px solid rgba(255,255,255,.10);color:#dfe6f4}
.tiers td.t{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:34px;color:#fff;letter-spacing:-.02em}
.tiers tr:last-child td{color:#b8e8ff}
.tiers tr:last-child td.t{color:#b8e8ff}
</style>`;
  },

  '14-install.png': (s) => `
<div class="lockup"><img src="${MARK_URI}" alt=""><span>three.ws</span></div>
<div class="copy" style="top:200px;max-width:700px">
  <h1>Install it now.</h1>
  <ol class="steps">
    <li><b>1</b><span>Open the link on your phone</span></li>
    <li><b>2</b><span>Tap <em>Download anyway</em> when Chrome warns you. It does that for every app outside a store.</span></li>
    <li><b>3</b><span>Open the download and tap <em>Install</em></span></li>
  </ol>
  <p style="margin-top:34px;color:#b8e8ff;font-size:26px">Android 6 and up &middot; 3.95 MB &middot; free &middot; open source</p>
</div>
${phone(s.home, { x: 1200, y: 520, w: 380, tilt: 2, turn: -8 })}
<style>
.steps{list-style:none;margin-top:36px}
.steps li{display:flex;align-items:flex-start;gap:22px;margin-top:22px;font-size:27px;line-height:1.4;color:#dfe6f4}
.steps b{flex:none;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;
  background:rgba(120,180,255,.14);border:1px solid rgba(184,232,255,.36);color:#b8e8ff;
  font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:26px}
.steps em{font-style:normal;color:#fff;font-weight:500}
</style>`,
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-webgl'] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 432, height: 768 },
    deviceScaleFactor: 2.5,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  const shots = {};
  for (const [id, spec] of Object.entries(SCREENS)) shots[id] = await capture(ctx, spec);
  await ctx.close();

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (const [file, body] of Object.entries(CARDS)) {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE_CSS}</style><body><div class="glow"></div><div class="beam"></div>${body(shots)}</body>`, { waitUntil: 'load' });
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('600 74px "Space Grotesk"') && document.fonts.check('400 27px "Inter"');
    });
    if (!loaded) throw new Error(`[x-cards] brand fonts did not load for ${file}`);
    const png = await sharp(await page.screenshot({ type: 'png' })).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
    /* X re-encodes anything over 5 MB, which softens type. */
    if (png.length > 5 * 1024 * 1024) throw new Error(`[x-cards] ${file} is over X's 5 MB ceiling`);
    writeFileSync(path.join(OUT, file), png);
    console.log(`[x-cards] ${file}  ${W}x${H}  ${Math.round(png.length / 1024)} KB`);
  }
  await page.close();
} finally {
  await browser.close();
}
