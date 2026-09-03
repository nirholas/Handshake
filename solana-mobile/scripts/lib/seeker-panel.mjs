/**
 * Seeker panel geometry, browser context, and video encoding, shared by every
 * script that records the shipping app as if it were running on the phone.
 *
 * `ws.three.app` is a Trusted Web Activity: the APK is a full-screen shell
 * around https://three.ws, so what the phone renders in the app IS the page.
 * Driving that page in Chromium at the Seeker's real panel geometry (1200x2670
 * device pixels, 3x density) produces the pixels the device would.
 *
 * Frames are STEPPED, not recorded in real time. Playwright's video recorder
 * ignores deviceScaleFactor: ask it for a 1200x2670 video of a 400x890 CSS
 * viewport and it draws the page at 400x890 in the corner and pads the rest
 * grey. Screenshots do honour the scale factor, so a recording is advanced one
 * output frame at a time and each frame is captured at full device resolution.
 * Wall-clock capture time is then decoupled from playback time, which also
 * makes a rerun of the same script produce the same video.
 */
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/* Seeker panel: 6.36" AMOLED, 1200x2670 at ~460ppi, which Android reports as a
   400x890 CSS viewport at density 3. Capturing at that density is what makes
   the frames real device pixels rather than an upscale. */
export const CSS = { width: 400, height: 890 };
export const DPR = 3;
export const PANEL = { width: CSS.width * DPR, height: CSS.height * DPR };

/* Output composition. The screen keeps the panel's exact aspect ratio; the body
   reuses the bezel proportions and gradient the store frames already use, so
   every video and the listing screenshots read as one set of assets. */
export const OUT_W = 1080;
export const OUT_H = 1920;
export const SCREEN_H = 1740;
export const SCREEN_W = Math.round(SCREEN_H * (PANEL.width / PANEL.height)) & ~1;
export const BEZEL = 20;
export const BODY_W = SCREEN_W + BEZEL * 2;
export const BODY_H = SCREEN_H + BEZEL * 2;
export const BODY_X = Math.round((OUT_W - BODY_W) / 2);
export const BODY_Y = Math.round((OUT_H - BODY_H) / 2);
export const SCREEN_X = BODY_X + BEZEL;
export const SCREEN_Y = BODY_Y + BEZEL;
export const BG = '#080814';

export const AUTH_STATE = path.join(ROOT, '.auth/audit-state.json');

/**
 * Chromium launch flags for a recording.
 *
 * `--disable-dev-shm-usage` is not optional in a container: Docker gives /dev/shm
 * 64 MB, and a heavy page (the marketplace document is 90k px tall with a live
 * WebGL hero) blows through that. The renderer then either crashes outright with
 * "Page crashed" or limps, which reads as the site being slow rather than as the
 * sandbox being small: a single 1200x2670 screenshot of /marketplace measured
 * 22s with the default shm and 4s with this flag.
 */
export function launchOptions() {
	return { args: ['--disable-dev-shm-usage'] };
}

/** The panel in device pixels at a given capture density. */
export function panelFor(dpr = DPR) {
	return { width: CSS.width * dpr, height: CSS.height * dpr };
}

/** The Android/Seeker browser context every recording runs in. */
export function contextOptions({ authed = false, dpr = DPR } = {}) {
	if (authed && !existsSync(AUTH_STATE)) {
		throw new Error(`--authed needs ${path.relative(ROOT, AUTH_STATE)}; mint it with: npm run audit:web:login`);
	}
	return {
		viewport: CSS,
		deviceScaleFactor: dpr,
		isMobile: true,
		hasTouch: true,
		colorScheme: 'dark',
		userAgent: 'Mozilla/5.0 (Linux; Android 15; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
		...(authed ? { storageState: AUTH_STATE } : {}),
	};
}

export function ffmpeg(argv) {
	const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
	if (r.error || r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.error?.message})`);
}

/** The backdrop and the phone body, drawn once at output resolution. */
export async function chromeArt(dir) {
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

/** The bare panel, at full device resolution. */
export function encodeScreen({ glob, fps, out }) {
	ffmpeg(['-framerate', String(fps), '-i', glob, '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
		'-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
}

/**
 * The same panel seated in the device body on the three.ws backdrop.
 *
 * Both stills are looped, so they never end on their own, and overlay's own
 * `shortest` does not reliably bound them: it left a composite growing past
 * 50 MB on a 30 second capture. The frame count does bound them, so every
 * looped input and the output carry an explicit -t.
 */
export async function encodeDevice({ glob, fps, out, work, seconds }) {
	const { bgPath, bezelPath } = await chromeArt(work);
	ffmpeg([
		'-loop', '1', '-t', seconds, '-i', bgPath,
		'-framerate', String(fps), '-i', glob,
		'-loop', '1', '-t', seconds, '-i', bezelPath,
		'-filter_complex',
		`[1:v]scale=${SCREEN_W}:${SCREEN_H}:flags=lanczos,setpts=PTS-STARTPTS[s];` +
		`[0:v][s]overlay=${SCREEN_X}:${SCREEN_Y}[a];` +
		`[a][2:v]overlay=0:0,format=yuv420p[v]`,
		'-map', '[v]', '-t', seconds, '-r', String(fps), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
		'-movflags', '+faststart', out,
	]);
}
