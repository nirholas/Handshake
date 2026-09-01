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
 * Frames are STEPPED, not recorded in real time. Playwright's video recorder
 * ignores deviceScaleFactor: ask it for a 1200x2670 video of a 400x890 CSS
 * viewport and it draws the page at 400x890 in the corner and pads the rest
 * grey. Screenshots do honour the scale factor, so the tour is advanced one
 * output frame at a time and each frame is captured at full device resolution.
 * Wall-clock capture time is then decoupled from playback time, which also
 * makes a rerun of the same tour produce the same video.
 *
 * Two artefacts come out of one run:
 *   seeker-screen.mp4   the bare 1200x2670 panel, for dropping into an edit
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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
const FPS = Number(args.fps || 30);

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
 * `glide` and `hold` are milliseconds of finished video, not of capture time.
 *
 * The tour stays on /seeker on purpose. That is the screen the app opens to,
 * and it is the only one composed for this aspect ratio. Carrying on into the
 * marketplace was tried and cut: its filter panel opens over the top half, the
 * corner stack (onboarding pill, language picker, claim card) lands on top of
 * the grid, and its Connect Wallet button contradicts the Seed Vault story the
 * rest of the video tells.
 */
const TOUR = [
  { hold: 2800, note: 'hero and the Seed Vault sign-in' },
  { to: '#agents', glide: 2200, hold: 2000, note: 'agents rail' },
  { to: '#verify', glide: 1800, hold: 2600, note: 'Seeker verification' },
  { to: 0, glide: 1800, hold: 1200, note: 'back to the hero' },
];

const log = (...m) => console.log('[screencast]', ...m);
const frameCount = (ms) => Math.max(1, Math.round((ms / 1000) * FPS));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function ffmpeg(argv) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.error?.message})`);
}

/** Where a step wants the page scrolled to, resolved once before the glide. */
async function resolveTarget(page, target) {
  return page.evaluate((t) => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (typeof t === 'string') {
      const el = document.querySelector(t);
      if (!el) return { error: t };
      return { y: Math.max(0, Math.min(max, window.scrollY + el.getBoundingClientRect().top - 72)) };
    }
    return { y: Math.max(0, Math.min(max, t > 0 && t < 1 ? t * max : t)) };
  }, target);
}

async function capture(frames) {
  mkdirSync(frames, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: CSS,
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    ...(args.authed ? { storageState: AUTH_STATE } : {}),
  });
  if (args.authed && !existsSync(AUTH_STATE)) {
    throw new Error(`--authed needs ${path.relative(ROOT, AUTH_STATE)}; mint it with: npm run audit:web:login`);
  }

  const page = await ctx.newPage();
  let n = 0;
  const shoot = () => page.screenshot({
    path: path.join(frames, `${String(n++).padStart(6, '0')}.jpg`),
    type: 'jpeg',
    quality: 94,
  });

  log(`opening ${ORIGIN}/seeker at ${PANEL.width}x${PANEL.height}`);
  /* `load` never settles on this page (the 3D scene keeps streaming), so the
     ready signal is the hero being on screen plus a beat for the avatar. */
  await page.goto(`${ORIGIN}/seeker`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#hero-title', { timeout: 30_000 });
  await page.waitForTimeout(4000);

  for (const step of TOUR) {
    log(step.note);
    if (step.click) {
      const target = page.locator(step.click).first();
      await target.waitFor({ state: 'visible', timeout: 15_000 });
      await target.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    if (step.to !== undefined) {
      const from = await page.evaluate(() => window.scrollY);
      const { y, error } = await resolveTarget(page, step.to);
      if (error) throw new Error(`tour target not on the page: ${error}`);
      const total = frameCount(step.glide ?? 1200);
      for (let i = 1; i <= total; i += 1) {
        await page.evaluate((py) => window.scrollTo(0, py), from + (y - from) * ease(i / total));
        await shoot();
      }
    }
    for (let i = 0; i < frameCount(step.hold ?? 600); i += 1) await shoot();
  }

  await ctx.close();
  await browser.close();
  log(`captured ${n} frames (${(n / FPS).toFixed(1)}s at ${FPS}fps)`);
  return n;
}

/** The backdrop and the phone body, drawn once at output resolution. */
async function chrome(dir) {
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

  const bgPath = path.join(dir, 'bg.png');
  const bezelPath = path.join(dir, 'bezel.png');
  await sharp(bg).png().toFile(bgPath);
  await sharp(bezel).png().toFile(bezelPath);
  return { bgPath, bezelPath };
}

mkdirSync(OUT, { recursive: true });
const work = path.join(OUT, '.raw');
rmSync(work, { recursive: true, force: true });
const frames = path.join(work, 'frames');
const count = await capture(frames);
const seconds = (count / FPS).toFixed(3);
const glob = path.join(frames, '%06d.jpg');
const screenMp4 = path.join(OUT, 'seeker-screen.mp4');
const deviceMp4 = path.join(OUT, 'seeker-device.mp4');

log('encoding the raw panel');
ffmpeg(['-framerate', String(FPS), '-i', glob, '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', screenMp4]);

log('seating the panel in the device body');
const { bgPath, bezelPath } = await chrome(work);
/* Both stills are looped, so they never end on their own, and overlay's own
   `shortest` does not reliably bound them: it left a composite growing past
   50 MB on a 30 second capture. The frame count does bound them, so every
   looped input and the output carry an explicit -t. */
ffmpeg([
  '-loop', '1', '-t', seconds, '-i', bgPath,
  '-framerate', String(FPS), '-i', glob,
  '-loop', '1', '-t', seconds, '-i', bezelPath,
  '-filter_complex',
  `[1:v]scale=${SCREEN_W}:${SCREEN_H}:flags=lanczos,setpts=PTS-STARTPTS[s];` +
  `[0:v][s]overlay=${SCREEN_X}:${SCREEN_Y}[a];` +
  `[a][2:v]overlay=0:0,format=yuv420p[v]`,
  '-map', '[v]', '-t', seconds, '-r', String(FPS), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
  '-movflags', '+faststart', deviceMp4,
]);

rmSync(work, { recursive: true, force: true });
log(`wrote ${path.relative(ROOT, screenMp4)} (${PANEL.width}x${PANEL.height}, ${seconds}s)`);
log(`wrote ${path.relative(ROOT, deviceMp4)} (${OUT_W}x${OUT_H}, ${seconds}s)`);
