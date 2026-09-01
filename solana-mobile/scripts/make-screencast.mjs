#!/usr/bin/env node
/**
 * Records a Seeker screen-recording video of the shipping three.ws app without
 * a Seeker in the room.
 *
 * This is not a mock-up. `ws.three.app` is a Trusted Web Activity: the APK is a
 * full-screen shell around https://three.ws/seeker, so what the phone renders in
 * the app IS this page. Driving that same page in Chromium at the Seeker's real
 * panel geometry (1200x2670 device pixels, 3x density) produces the identical
 * pixels the device would, and the tour below only touches links and sections
 * that exist on the live page.
 *
 * Two artefacts come out of one recording:
 *   seeker-screen.mp4   the raw 1200x2670 panel, for dropping into an edit
 *   seeker-device.mp4   the same panel seated in a Seeker-proportioned body,
 *                       1080x1920, ready to post
 *
 * What this deliberately does NOT fake: the Android status bar, the launcher,
 * the Seed Vault approval sheet, and the dApp Store install. Those are system
 * surfaces, not app surfaces, and inventing them would be inventing UI. Capture
 * them in an Android emulator (docs/seeker-video.md) and cut them around this.
 *
 * Usage:
 *   node solana-mobile/scripts/make-screencast.mjs
 *   node solana-mobile/scripts/make-screencast.mjs --origin=http://localhost:3000
 *   node solana-mobile/scripts/make-screencast.mjs --authed   # replays the audit session
 */
import sharp from 'sharp';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = path.resolve(ROOT, String(args.out || 'marketing/seeker-video'));
const AUTH_STATE = path.join(ROOT, '.auth/audit-state.json');

/* Seeker panel: 6.36" AMOLED, 1200x2670 at ~460ppi, which Android reports as a
   400x890 CSS viewport at density 3. Capturing at that density is what makes
   the frames real device pixels rather than an upscale. */
const CSS = { width: 400, height: 890 };
const DPR = 3;
const PANEL = { width: CSS.width * DPR, height: CSS.height * DPR };

/* Output composition. The screen keeps the panel's exact aspect ratio; the body
   reuses the bezel proportions and gradient the store frames already use, so
   the video and the listing screenshots read as one set of assets. */
const OUT_W = 1080;
const OUT_H = 1920;
const SCREEN_H = 1740;
const SCREEN_W = Math.round(SCREEN_H * (PANEL.width / PANEL.height)) & ~1;
const BEZEL = 20;
const BODY_W = SCREEN_W + BEZEL * 2;
const BODY_H = SCREEN_H + BEZEL * 2;
const BODY_X = Math.round((OUT_W - BODY_W) / 2);
const BODY_Y = Math.round((OUT_H - BODY_H) / 2);
const SCREEN_X = BODY_X + BEZEL;
const SCREEN_Y = BODY_Y + BEZEL;
const BG = '#080814';

/**
 * The tour. Every `click` selector and every `to` selector resolves on the live
 * page; a step that cannot find its target fails the run rather than silently
 * recording a still. A numeric `to` between 0 and 1 is a fraction of the page's
 * scrollable height, which keeps a step meaningful on pages of any length.
 */
const TOUR = [
  { hold: 2600, note: 'hero and the Seed Vault sign-in' },
  { to: '#agents', glide: 1500, hold: 1800, note: 'agents rail' },
  { to: '#verify', glide: 1400, hold: 2200, note: 'Seeker verification' },
  { to: 0, glide: 1200, hold: 900, note: 'back to the hero' },
  { click: 'a[href^="/marketplace"]', settle: 3600, note: 'tap Marketplace' },
  { to: 0.35, glide: 2600, hold: 1400, note: 'marketplace grid' },
  { to: 0.7, glide: 2600, hold: 2000, note: 'deeper into the grid' },
];

const log = (...m) => console.log('[screencast]', ...m);

function ffmpeg(argv) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.error?.message})`);
}

/** Eased scroll driven by rAF inside the page, so the capture sees real frames. */
async function glide(page, target, ms) {
  await page.evaluate(([t, d]) => new Promise((done) => {
    const el = typeof t === 'string' ? document.querySelector(t) : null;
    if (typeof t === 'string' && !el) { done(`missing:${t}`); return; }
    const from = window.scrollY;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const want = el ? from + el.getBoundingClientRect().top - 72 : (t > 0 && t < 1 ? t * max : t);
    const to = Math.max(0, Math.min(max, want));
    const t0 = performance.now();
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    (function step(now) {
      const p = Math.min(1, (now - t0) / d);
      window.scrollTo(0, from + (to - from) * ease(p));
      p < 1 ? requestAnimationFrame(step) : done(null);
    })(t0);
  }), [target, ms]).then((miss) => {
    if (miss) throw new Error(`tour target not on the page: ${String(miss).slice(8)}`);
  });
}

async function record() {
  mkdirSync(OUT, { recursive: true });
  const raw = path.join(OUT, '.raw');
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: CSS,
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    recordVideo: { dir: raw, size: PANEL },
    ...(args.authed && existsSync(AUTH_STATE) ? { storageState: AUTH_STATE } : {}),
  });
  if (args.authed && !existsSync(AUTH_STATE)) {
    throw new Error(`--authed needs ${path.relative(ROOT, AUTH_STATE)}; mint it with: npm run audit:web:login`);
  }

  const page = await ctx.newPage();
  log(`opening ${ORIGIN}/seeker at ${PANEL.width}x${PANEL.height}`);
  /* `load` never settles on this page (the 3D scene keeps streaming), so the
     ready signal is the hero being on screen plus a fixed beat for the avatar. */
  await page.goto(`${ORIGIN}/seeker`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#hero-title', { timeout: 30_000 });
  await page.waitForTimeout(4000);

  for (const step of TOUR) {
    log(step.note);
    if (step.click) {
      const target = page.locator(step.click).first();
      await target.waitFor({ state: 'visible', timeout: 15_000 });
      await target.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await target.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    }
    if (step.to !== undefined) await glide(page, step.to, step.glide ?? 1200);
    await page.waitForTimeout(step.settle ?? step.hold ?? 600);
  }

  await ctx.close();
  await browser.close();

  const webm = readdirSync(raw).filter((f) => f.endsWith('.webm')).map((f) => path.join(raw, f));
  if (webm.length !== 1) throw new Error(`expected one recording in ${raw}, found ${webm.length}`);
  return webm[0];
}

async function frames() {
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}">
  <defs><radialGradient id="g" cx="0.5" cy="0.4" r="0.66">
    <stop offset="0" stop-color="#4b32d6" stop-opacity="0.5"/>
    <stop offset="0.55" stop-color="#1b1650" stop-opacity="0.28"/>
    <stop offset="1" stop-color="${BG}" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="${OUT_W}" height="${OUT_H}" fill="${BG}"/>
  <rect width="${OUT_W}" height="${OUT_H}" fill="url(#g)"/>
</svg>`);

  const bezel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f3350"/><stop offset="0.58" stop-color="#12131f"/><stop offset="1" stop-color="#262a40"/>
    </linearGradient>
    <mask id="hole">
      <rect width="${OUT_W}" height="${OUT_H}" fill="black"/>
      <rect x="${BODY_X}" y="${BODY_Y}" width="${BODY_W}" height="${BODY_H}" rx="62" fill="white"/>
      <rect x="${SCREEN_X}" y="${SCREEN_Y}" width="${SCREEN_W}" height="${SCREEN_H}" rx="44" fill="black"/>
    </mask>
  </defs>
  <rect width="${OUT_W}" height="${OUT_H}" fill="url(#body)" mask="url(#hole)"/>
</svg>`);

  const bgPath = path.join(OUT, '.raw/bg.png');
  const bezelPath = path.join(OUT, '.raw/bezel.png');
  await sharp(bg).png().toFile(bgPath);
  await sharp(bezel).png().toFile(bezelPath);
  return { bgPath, bezelPath };
}

const source = await record();
const screenMp4 = path.join(OUT, 'seeker-screen.mp4');
const deviceMp4 = path.join(OUT, 'seeker-device.mp4');

log('encoding the raw panel');
ffmpeg(['-i', source, '-r', '30', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', screenMp4]);

log('seating the panel in the device body');
const { bgPath, bezelPath } = await frames();
ffmpeg([
  '-loop', '1', '-i', bgPath,
  '-i', source,
  '-loop', '1', '-i', bezelPath,
  '-filter_complex',
  `[1:v]scale=${SCREEN_W}:${SCREEN_H}:flags=lanczos,setpts=PTS-STARTPTS[s];` +
  `[0:v][s]overlay=${SCREEN_X}:${SCREEN_Y}:shortest=1[a];` +
  `[a][2:v]overlay=0:0,format=yuv420p[v]`,
  '-map', '[v]', '-r', '30', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', deviceMp4,
]);

rmSync(path.join(OUT, '.raw'), { recursive: true, force: true });
log(`wrote ${path.relative(ROOT, screenMp4)} (${PANEL.width}x${PANEL.height})`);
log(`wrote ${path.relative(ROOT, deviceMp4)} (${OUT_W}x${OUT_H})`);
