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
 * that exist on the live page. The geometry, the browser context, and the two
 * encodes live in lib/seeker-panel.mjs, which also explains why frames are
 * stepped rather than recorded in real time.
 *
 * Two artefacts come out of one run:
 *   seeker-screen.mp4   the bare 1200x2670 panel, for dropping into an edit
 *   seeker-device.mp4   the same panel seated in a Seeker-proportioned body,
 *                       1080x1920, ready to post
 *
 * This is the short listing tour: a scripted scroll down /seeker, no hands, no
 * typing. For a long-form video of someone actually using the app feature by
 * feature, run make-feature-tour.mjs instead.
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
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	ROOT, CSS, PANEL, OUT_W, OUT_H, contextOptions, launchOptions, encodeScreen, encodeDevice,
} from './lib/seeker-panel.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = path.resolve(ROOT, String(args.out || 'marketing/seeker-video'));
const FPS = Number(args.fps || 30);

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
	{ hold: 3000, note: 'hero and the Seed Vault sign-in' },
	{ to: '.grid', glide: 1800, hold: 1600, note: 'the Create lane' },
	{ to: '#verify', glide: 1600, hold: 2800, note: 'Seeker verification' },
	{ to: 0, glide: 1600, hold: 1200, note: 'back to the hero' },
];

const log = (...m) => console.log('[screencast]', ...m);
const frameCount = (ms) => Math.max(1, Math.round((ms / 1000) * FPS));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Where a step wants the page scrolled to, resolved once before the glide. */
async function resolveTarget(page, target) {
	return page.evaluate((t) => {
		const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
		if (typeof t === 'string') {
			const el = document.querySelector(t);
			if (!el) return { error: `${t} is not on the page` };
			/* A section that is present but empty collapses to zero height and sits
			   at the top of the document, so scrolling to it resolves to y=0 and the
			   tour records a still of the hero while reporting success. Signed out,
			   #agents and #mine are exactly that. Refuse it. */
			if (el.getBoundingClientRect().height < 1) {
				return { error: `${t} is on the page but has no height, so there is nothing to scroll to` };
			}
			return { y: Math.max(0, Math.min(max, window.scrollY + el.getBoundingClientRect().top - 72)) };
		}
		return { y: Math.max(0, Math.min(max, t > 0 && t < 1 ? t * max : t)) };
	}, target);
}

async function capture(frames) {
	mkdirSync(frames, { recursive: true });

	const browser = await chromium.launch(launchOptions());
	const ctx = await browser.newContext(contextOptions({ authed: Boolean(args.authed) }));

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
encodeScreen({ glob, fps: FPS, out: screenMp4 });

log('seating the panel in the device body');
await encodeDevice({ glob, fps: FPS, out: deviceMp4, work, seconds });

rmSync(work, { recursive: true, force: true });
log(`wrote ${path.relative(ROOT, screenMp4)} (${PANEL.width}x${PANEL.height}, ${seconds}s)`);
log(`wrote ${path.relative(ROOT, deviceMp4)} (${OUT_W}x${OUT_H}, ${seconds}s)`);
