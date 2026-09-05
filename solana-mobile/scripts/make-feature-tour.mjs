#!/usr/bin/env node
/**
 * Records someone actually using three.ws on a Seeker: thumb taps, typed text,
 * flicked lists, a dragged 3D model, and the real waits in between.
 *
 * make-screencast.mjs is the 20 second panel tour, a scripted scroll down
 * /seeker for a store listing. This is the long form: it walks the app feature
 * by feature and every step is a real interaction with the live site. It types
 * a prompt and generates an actual avatar through /api/avatars/reconstruct, it
 * searches the real marketplace, opens a real agent, turns that agent's 3D
 * model with a real drag, and sends a real chat message to the real model
 * behind it. Nothing on screen is staged: if the site is broken, the run fails
 * instead of recording a pretty lie.
 *
 * A visible touch indicator follows the input (lib/hand.mjs), the same thing
 * Android's "Show taps" draws over a real screen recording. It is the only
 * pixel added to the page.
 *
 * The Android surfaces around the app (status bar, launcher, share sheet, Seed
 * Vault approval, dApp Store install) are still not faked here. They are system
 * UI, not app UI. Capture those in an emulator and cut them around this
 * footage: docs/seeker-video.md.
 *
 * Signed in is the point. The generation act posts to an endpoint that answers
 * 401 for anonymous callers, so mint the QA session first:
 *   npm run audit:web:login
 *
 * Usage:
 *   node solana-mobile/scripts/make-feature-tour.mjs --authed
 *   node solana-mobile/scripts/make-feature-tour.mjs --authed --acts=market,agent
 *   node solana-mobile/scripts/make-feature-tour.mjs --origin=http://localhost:3000 --authed
 *
 * Flags:
 *   --acts=a,b   which acts to record (default home,create,market,agent; verify is opt-in)
 *   --authed     replay .auth/audit-state.json (required by the create act)
 *   --origin=    record against a dev server instead of https://three.ws
 *   --out=       write somewhere other than marketing/seeker-video
 *   --fps=       output frame rate (default 30)
 *   --seed=      seed for the hand's jitter, so a rerun lands the same pixels
 *   --dpr=       capture density (default 3, the Seeker's own); 2 halves render time
 *                and still exceeds the 782px the device frame draws
 *   --live-css   keep CSS transitions running instead of snapping them settled
 *   --agent=     open a specific agent page in the agent act instead of picking
 *                one out of the marketplace (a path, e.g. /marketplace/agents/<id>)
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	ROOT, CSS, DPR, panelFor, contextOptions, launchOptions, encodeScreen, encodeDevice,
} from './lib/seeker-panel.mjs';
import { Hand, installHand } from './lib/hand.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = path.resolve(ROOT, String(args.out || 'marketing/seeker-video'));
const FPS = Number(args.fps || 30);
const SEED = Number(args.seed || 7);
const CAPTURE_DPR = Number(args.dpr || DPR);
const PANEL = panelFor(CAPTURE_DPR);
/* Our frames are not real time, so a CSS transition captured mid-flight is
   rendering at the wall clock's idea of progress, not the video's. Snapping
   every transition to its settled state is both the honest frame for a stepped
   capture and, on a page with a live WebGL hero, twice as fast to screenshot
   (3.3s to 1.5s on /marketplace). Pass --live-css to keep them running. */
const ANIMATIONS = args['live-css'] ? 'allow' : 'disabled';
const NAME = String(args.name || 'seeker-feature-tour');

const log = (...m) => console.log('[feature-tour]', ...m);

/* The one line of text this tour types into the product. It is also the search
   the marketplace act runs, so the video tells one story: describe a knight,
   build it, then go and find the knights other people built. */
const PROMPT = 'A medieval knight in battered steel plate, weathered red cloak';
const SEARCH = 'knight';
const CHAT = 'What can you do for me?';

/**
 * The tour. Each act stands on its own (it navigates if it is not already on
 * its page), so `--acts=agent` is a valid three-frame-per-second iteration
 * loop while you tune a step, and the default list plays as one continuous
 * session. Every act asserts what it expects to find; a missing selector or a
 * dead endpoint fails the run rather than recording a still frame.
 */
const ACTS = {
	/* The app's home screen, and the tap that starts a build. */
	home: async ({ page, hand, visit }) => {
		await visit('/seeker', { ready: '#hero-title', settle: 4200 });
		await hand.moveTo(CSS.width * 0.52, CSS.height * 0.66, { ms: 700 });
		await hand.hold(1100);
		await hand.bringIntoView('nav[aria-label="Create"]');
		await hand.hold(700);
		await hand.tapOn('a[href^="/create/prompt"]', { expect: '#prompt' });
		await hand.hold(600);
	},

	/* Prompt to rigged avatar, start to finish, on the real pipeline. */
	create: async ({ page, hand, visit }) => {
		await visit('/create/prompt', { ready: '#prompt', settle: 2600 });
		/* The walk companion parks itself in the corner of every page. Dismissing
		   it is a real preference the SDK persists, so one tap here clears it for
		   the rest of the session. */
		await hand.tapIfPresent('.walk-companion-close', { after: 500 });
		await hand.typeInto('#prompt', PROMPT);
		await hand.tapOn('#generate-btn', { expect: '.step[data-step="building"].active' });
		await hand.hold(1400);

		const waited = await hand.waitFor(async (p) => {
			const failed = await p.locator('#build-error.show').isVisible().catch(() => false);
			if (failed) throw new Error(`the build failed: ${(await p.locator('#build-error').innerText()).trim()}`);
			if (p.url().includes('/login')) throw new Error('the build bounced to /login; rerun with --authed after npm run audit:web:login');
			return p.locator('.step[data-step="done"].active').isVisible().catch(() => false);
		}, { timeout: 9 * 60_000, everyMs: 900, note: 'building the avatar (time-lapsed at one frame per 0.9s)' });
		log(`build finished in ${Math.round(waited / 1000)}s`);

		await page.waitForSelector('#done-model', { timeout: 30_000 });
		await page.waitForTimeout(3500);
		await hand.hold(900);
		await hand.dragAcross('#done-model', { dx: 150, ms: 1000 });
		await hand.hold(1200);
	},

	/* Search the live marketplace and open something out of the results. */
	market: async ({ page, hand, visit, origin }) => {
		/* Walked into from another act: take the app's own route there, through
		   the nav drawer. Started here with --acts=market: just open the page. */
		if (page.url().startsWith(origin) && !page.url().includes('/marketplace')) {
			/* Scoped to #nav-drawer on purpose. The desktop nav renders its own
			   copy of this link inside the Discover mega menu, which is display:
			   none at the Seeker's width, and an unscoped selector resolves to
			   that hidden copy and waits on it forever. */
			const drawerLink = '#nav-drawer a[href="/marketplace"]';
			await hand.tapOn('#nav-toggle', { expect: drawerLink });
			await hand.hold(500);
			await hand.tapOn(drawerLink, { expect: '#market-search' });
		}
		await visit('/marketplace', { ready: '#market-search', settle: 4200 });
		await hand.tapIfPresent('.walk-companion-close', { after: 400 });
		await hand.typeInto('#market-search', SEARCH, { settle: 900 });
		await hand.waitFor(
			(p) => p.locator('#market-grid a.title.card-profile-link').first().isVisible().catch(() => false),
			{ timeout: 30_000, everyMs: 200, note: `results for "${SEARCH}"` },
		);
		await hand.hold(700);
		await hand.scrollBy(760);
		await hand.hold(900);
		await hand.tapOn('#market-grid a.title.card-profile-link', { expect: '#av-stage' });
	},

	/* An agent's own page: turn the model, then talk to it. */
	agent: async ({ page, hand, visit }) => {
		if (!(await page.locator('#av-stage').count())) {
			/* Walked in from the market act, this never runs. Started here, either
			   pick up the agent named on the command line or go and find one. */
			if (args.agent) await visit(String(args.agent), { ready: '#av-stage', settle: 3000 });
			else {
				await visit('/marketplace', { ready: '#market-search', settle: 3500 });
				await hand.tapOn('#market-grid a.title.card-profile-link', { expect: '#av-stage' });
			}
		}
		await page.waitForSelector('#av-viewer', { timeout: 30_000 });
		await page.waitForTimeout(6000);
		await hand.tapIfPresent('.walk-companion-close', { after: 400 });
		await hand.hold(900);
		await hand.dragAcross('#av-viewer', { dx: 190, ms: 1100 });
		await hand.hold(800);
		await hand.tapOn('#av-tab-chat', { expect: '#av-chat-input' });
		await hand.hold(600);
		await hand.typeInto('#av-chat-input', CHAT, { settle: 400 });
		await hand.tapOn('#av-chat-send', { after: 200 });
		await hand.waitFor(
			(p) => p.locator('.av-chat-msg.assistant').first().isVisible().catch(() => false),
			{ timeout: 120_000, everyMs: 250, note: 'the agent answering' },
		);
		await hand.hold(2600);
	},

	/* Opt in with --acts=...,verify. It reads the Genesis Token out of the
	   signed-in wallet, so it only tells a story on a session that has one. */
	verify: async ({ page, hand, visit }) => {
		await visit('/seeker', { ready: '#hero-title', settle: 3000 });
		await hand.bringIntoView('#verify');
		await hand.hold(600);
		await hand.tapOn('#verify-btn', { after: 400 });
		await hand.waitFor(
			(p) => p.locator('#verify-msg').innerText().then((t) => t.trim().length > 0).catch(() => false),
			{ timeout: 45_000, everyMs: 200, note: 'the Genesis Token check' },
		);
		await hand.hold(2400);
	},
};

const DEFAULT_ACTS = ['home', 'create', 'market', 'agent'];
const wanted = String(args.acts || DEFAULT_ACTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const act of wanted) {
	if (!ACTS[act]) throw new Error(`no act named "${act}"; known acts: ${Object.keys(ACTS).join(', ')}`);
}
if (wanted.includes('create') && !args.authed) {
	throw new Error('the create act generates a real avatar, which needs a session: rerun with --authed (mint it with npm run audit:web:login)');
}

mkdirSync(OUT, { recursive: true });
const work = path.join(OUT, `.raw-${NAME}`);
rmSync(work, { recursive: true, force: true });
const frames = path.join(work, 'frames');
mkdirSync(frames, { recursive: true });

const browser = await chromium.launch(launchOptions());
let count = 0;
try {
	const ctx = await browser.newContext(contextOptions({ authed: Boolean(args.authed), dpr: CAPTURE_DPR }));
	await ctx.addInitScript(installHand);
	const page = await ctx.newPage();

	/* A screenshot taken while a navigation is committing throws; the page is
	   blank at that moment anyway, so drop the frame rather than the run. */
	const shoot = async () => {
		try {
			await page.screenshot({
				path: path.join(frames, `${String(count).padStart(6, '0')}.jpg`),
				type: 'jpeg',
				quality: 92,
				animations: ANIMATIONS,
				timeout: 30_000,
			});
			count += 1;
		} catch (err) {
			if (!/navigat|context|closed|Timeout/i.test(err.message)) throw err;
		}
	};

	const hand = new Hand(page, { fps: FPS, shoot, css: CSS, seed: SEED, log });

	const visit = async (pathname, { ready, settle = 2500 } = {}) => {
		const here = new URL(page.url() === 'about:blank' ? ORIGIN : page.url()).pathname;
		if (here !== pathname) {
			log(`opening ${pathname}`);
			await page.goto(`${ORIGIN}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		}
		/* `load` never settles on these pages (the 3D scenes keep streaming), so
		   the ready signal is the page's own first meaningful element. */
		if (ready) await page.waitForSelector(ready, { timeout: 45_000 });
		await page.waitForTimeout(settle);
		await hand.ready();
	};

	log(`recording ${wanted.join(' -> ')} against ${ORIGIN} at ${PANEL.width}x${PANEL.height}`);
	for (const act of wanted) {
		log(`act: ${act}`);
		const at = count;
		await ACTS[act]({ page, hand, visit, log, origin: ORIGIN });
		log(`act ${act} added ${((count - at) / FPS).toFixed(1)}s`);
	}
	/* Leave the hand off the glass on the last frame. */
	await hand.lift();
	await hand.hold(500);
	await ctx.close();
} finally {
	await browser.close();
}

if (!count) throw new Error('captured no frames');
const seconds = (count / FPS).toFixed(3);
const glob = path.join(frames, '%06d.jpg');
const screenMp4 = path.join(OUT, `${NAME}-screen.mp4`);
const deviceMp4 = path.join(OUT, `${NAME}-device.mp4`);

log(`captured ${count} frames (${seconds}s at ${FPS}fps)`);
log('encoding the raw panel');
encodeScreen({ glob, fps: FPS, out: screenMp4 });
log('seating the panel in the device body');
await encodeDevice({ glob, fps: FPS, out: deviceMp4, work, seconds });
rmSync(work, { recursive: true, force: true });
log(`wrote ${path.relative(ROOT, screenMp4)} (${PANEL.width}x${PANEL.height}, ${seconds}s)`);
log(`wrote ${path.relative(ROOT, deviceMp4)} (1080x1920, ${seconds}s)`);
