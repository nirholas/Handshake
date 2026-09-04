#!/usr/bin/env node
/**
 * Films a person demoing three.ws, feature by feature, on the live site.
 *
 * The route is not hand-maintained: it is the same curriculum the in-product
 * Feature Tour walks (public/tour/curriculum.json, generated from
 * data/pages.json by scripts/build-tour.mjs), so a page that ships tomorrow is
 * one `npm run build:tour` away from being in the video, and the narration is
 * the page's own plain-language description rather than marketing invented
 * here. Chapters are the curriculum's sections.
 *
 * Every stop is the real page on the real origin. The flagship surfaces get a
 * hand-written act: the marketplace is really searched, an agent's model is
 * really turned with a drag, the agent really answers the message that is typed
 * to it, the forge really switches lanes. Every other stop is visited and read
 * through the way a presenter scrolls a page they are showing you. If a page is
 * broken, that shows up as a skipped stop in the run report instead of a pretty
 * lie in the film.
 *
 * The voice is the platform's own TTS lane (/api/tts/speak, free NVIDIA Magpie),
 * so three.ws narrates three.ws. Captions carry the same words.
 *
 * Usage:
 *   npm run demo:video                       # every feature, all chapters
 *   npm run demo:video -- --route=highlights # the short cut, ~23 stops
 *   npm run demo:video -- --sections=build,crypto --authed
 *   npm run demo:video -- --dry-run          # print the route and exit
 *
 * Flags:
 *   --route=full|highlights|quick   which stops (default full: every feature)
 *   --sections=a,b                  only these chapters (default: all, in order)
 *   --limit=n                       first n stops per chapter, for a smoke test
 *   --authed                        replay .auth/audit-state.json (signed-in surfaces)
 *   --origin=                       film a dev server instead of https://three.ws
 *   --out=                          output directory (default marketing/product-demo)
 *   --voice=                        TTS voice id (default nova)
 *   --no-voice                      caption-only, no narration track
 *   --reuse                         keep chapter mp4s that already exist
 *   --strict                        a failed stop fails the run
 *   --crf=                          x264 quality (default 22; lower is bigger)
 *   --dry-run                       print the plan, record nothing
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	ROOT, STAGE, FPS, Presenter, Narrator, installOverlay, launchOptions, contextOptions,
	encodeSection, concatParts, mediaInfo, readJson, sleep,
} from './lib/demo-stage.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = path.resolve(ROOT, String(args.out || 'marketing/product-demo'));
const WORK = path.join(OUT, '.raw');
const VOICE = String(args.voice || 'nova');
const CRF = Number(args.crf || 22);
const STRICT = Boolean(args.strict);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const log = (...m) => console.log('[demo]', ...m);

/* ── the script ─────────────────────────────────────────────────────────── */

const curriculum = readJson(path.join(ROOT, 'public/tour/curriculum.json'));

const OPENING = 'This is three dot w s, the 3D agent layer of the internet. Over the next few chapters '
	+ 'I am going to walk the whole platform with you, feature by feature, on the live site. Everything you '
	+ 'are about to see is the real product answering in real time.';
const CLOSING = 'That is the whole platform: build a body, give it a brain, put it to work, and let it '
	+ 'hold its own wallet. Everything in this film is live at three dot w s right now.';

/* A caption is read, narration is heard, and neither wants a raw slug. */
const say = (text) => String(text || '')
	.replace(/three\.ws/gi, 'three dot w s')
	.replace(/\bx402\b/gi, 'x four oh two')
	.replace(/\bERC-8004\b/gi, 'E R C 8004')
	/* build-tour.mjs writes the page descriptions with colons where the source
	   copy had a dash, which a synthesizer reads as a full stop mid-clause. */
	.replace(/(\w):\s+(?=[a-z])/g, '$1, ')
	.replace(/\s+/g, ' ')
	.trim();

/** The stop's own description, with the guide's lead-in sentence removed. */
function describe(stop) {
	const n = String(stop.narration || '');
	const i = n.indexOf(stop.title);
	const rest = i >= 0 ? n.slice(i + stop.title.length) : n;
	return rest.replace(/^[.?!,:;\s]+/, '').trim();
}

/** A quick stop gets one sentence; a highlight gets the whole line. */
function lineFor(stop) {
	const desc = describe(stop);
	if (stop.highlight) return `${stop.title}. ${desc}`.slice(0, 320);
	const first = desc.split(/(?<=[.!?:])\s+/)[0] || desc;
	const short = first.length > 108 ? `${first.slice(0, 105).replace(/[\s,;:]+\S*$/, '')}.` : first;
	return `${stop.title}. ${short}`;
}

/* ── acts ───────────────────────────────────────────────────────────────── */

/*
 * A hand-written act for a flagship surface. Each one is a real interaction
 * with the real page: nothing here fakes a result, and a selector that has gone
 * missing surfaces as a skipped stop rather than a still frame.
 */
const ACTS = {
	'/': async (p) => {
		await p.hover('.nav-trigger:has-text("Build")', { hold: 1300 });
		await p.hover('.nav-trigger:has-text("Discover")', { hold: 1300 });
		await p.page.keyboard.press('Escape').catch(() => {});
		await p.readDown(700, { ms: 1500 });
		await p.type('#hero-forge-input', 'a brass astrolabe on a walnut stand', { cps: 17, settle: 900 });
		await p.readThrough({ budgetMs: 5000 });
	},

	'/what-is': async (p) => { await p.readThrough({ budgetMs: 7000 }); },

	'/discover': async (p) => {
		await p.type('input[placeholder*="Search by name"]', 'agent', { cps: 13, settle: 1400 });
		await p.clickIfPresent('button.tws-lc-chip:has-text("All agents")', { after: 1600 });
		await p.readDown(760, { ms: 1500 });
	},

	'/marketplace': async (p) => {
		await p.type('#market-search', 'knight', { cps: 12, settle: 1600 });
		await p.clickIfPresent('button.market-chip:has-text("Avatars")', { after: 1800 });
		await p.readDown(820, { ms: 1600 });
		await p.hover('#market-grid a.title.card-profile-link', { hold: 900 });
	},

	'/create-agent': async (p) => {
		await p.readThrough({ budgetMs: 6000 });
	},

	'/create/prompt': async (p) => {
		await p.type('#prompt', 'a medieval knight in battered steel plate, weathered red cloak', { cps: 16, settle: 900 });
		const fired = await p.clickIfPresent('#generate-btn', { after: 2200 });
		if (!fired) return;
		/* The real pipeline, at its real pace. The film watches the progress the
		   page reports for as long as the budget allows and then moves on; the
		   build keeps running on the server either way. */
		const deadline = Date.now() + 42_000;
		while (Date.now() < deadline) {
			if (await p.page.locator('.step[data-step="done"].active').isVisible().catch(() => false)) break;
			if (await p.page.locator('#build-error.show').isVisible().catch(() => false)) break;
			await sleep(700);
		}
		if (await p.page.locator('#done-model').isVisible().catch(() => false)) {
			await sleep(2500);
			await p.dragAcross('#done-model', { dx: 260, ms: 1300 });
		}
	},

	'/forge': async (p) => {
		await p.type('#prompt', 'a worn leather armchair, studio lit', { cps: 16, settle: 700 });
		await p.clickIfPresent('#tab-image', { after: 1500 });
		await p.clickIfPresent('#tab-sketch', { after: 1500 });
		await p.clickIfPresent('#tab-text', { after: 1200 });
		await p.readDown(900, { ms: 1600 });
		await p.clickIfPresent('button.showcase-sort-btn:has-text("Top this week")', { after: 1800 });
	},

	'/pose': async (p) => {
		await p.dragAcross('#pose-canvas', { dx: 320, ms: 1400 });
		await p.clickIfPresent('button.mode-btn:has-text("IK")', { after: 1200 });
		await p.type('#pose-bone-search', 'arm', { cps: 10, settle: 1200 });
	},

	'/playground': async (p) => {
		await p.dragAcross('#viewer', { dx: 340, ms: 1400 });
		await p.clickIfPresent('button.pill:has-text("Midnight")', { after: 1400 });
		await p.clickIfPresent('button.pill:has-text("Warm")', { after: 1400 });
		await p.clickIfPresent('#copy-embed', { after: 1400 });
	},

	'/brain': async (p) => {
		await p.type('#brDescribeInput', 'a sharp crypto trader who speaks in plain English', { cps: 16, settle: 900 });
		await p.clickIfPresent('#brBuildPersonaBtn', { after: 3200 });
		await p.clickIfPresent('button.br-tab:has-text("Playground")', { after: 2000 });
	},

	'/chat': async (p) => {
		const box = 'textarea[placeholder*="Type a message"]';
		if (!(await p.page.locator(box).count())) return;
		await p.type(box, 'What can you build for me?', { cps: 15, settle: 500 });
		await p.page.keyboard.press('Enter');
		await p.page.waitForTimeout(1200);
		for (let i = 0; i < 22; i += 1) {
			const answered = await p.page.evaluate(() => document.body.innerText.length).catch(() => 0);
			if (answered > 1200) break;
			await sleep(700);
		}
		await sleep(3500);
	},

	'/agents': async (p) => {
		await p.type('#ag-search', 'trader', { cps: 12, settle: 1500 });
		await p.readDown(700, { ms: 1400 });
	},

	'/pay': async (p) => {
		await p.clickIfPresent('button.chain-tab:has-text("BNB")', { after: 1500 });
		await p.clickIfPresent('button.chain-tab:has-text("Solana")', { after: 1500 });
		await p.type('#prompt', 'validate https://example.com', { cps: 16, settle: 900 });
		await p.readThrough({ budgetMs: 4000 });
	},

	'/launch': async (p) => { await p.readThrough({ budgetMs: 7000 }); },

	'/markets': async (p) => {
		await p.readDown(900, { ms: 1600 });
		await p.clickIfPresent('button.nw-star', { after: 1200 });
		await p.readDown(1100, { ms: 1700 });
	},

	'/holo': async (p) => {
		await p.clickIfPresent('button.hs-chip:has-text("$THREE")', { after: 1400 });
		await p.slideTo('#peelRange', 0.72, { ms: 1500 });
		await p.slideTo('#peelRange', 0.12, { ms: 1200 });
	},

	'/labs': async (p) => {
		await p.clickIfPresent('button.labs-filter:has-text("x402")', { after: 1600 });
		await p.clickIfPresent('button.labs-filter:has-text("All")', { after: 1200 });
		await p.readDown(820, { ms: 1600 });
	},

	'/diorama': async (p) => {
		await p.clickIfPresent('button.dio-chip', { after: 1600 });
		await p.type('#compose-input', 'a cliffside lighthouse in a storm', { cps: 16, settle: 900 });
		await p.readDown(600, { ms: 1400 });
	},

	'/walk': async (p) => {
		await p.readDown(760, { ms: 1500 });
		await p.clickIfPresent('#wl-copy', { after: 1400 });
		await p.readThrough({ budgetMs: 4500 });
	},

	'/profile': async (p) => { await p.readThrough({ budgetMs: 6000 }); },
};

/**
 * Every other stop: arrive, let the page come alive, and read down it the way a
 * presenter scrolls a page they are showing you, pausing on whatever the
 * curriculum says the page is about.
 */
async function genericAct(p, stop) {
	const target = (stop.targets || [])[0];
	if (target) {
		const el = p.page.locator(target).first();
		if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
			await p.hover(target, { hold: 700 }).catch(() => {});
		}
	}
	await p.readThrough({ budgetMs: stop.highlight ? 7000 : 3400, bite: 640, pause: 380 });
}

/* ── route ──────────────────────────────────────────────────────────────── */

const ROUTE = String(args.route || 'full');
/* The curriculum carries every stop once, with the onboarding track repeating
   pages the sections already hold; the film visits each feature exactly once. */
function routeStops() {
	const stops = curriculum.stops.filter((s) => s.section !== 'onboarding');
	if (ROUTE === 'full') return stops;
	if (ROUTE === 'highlights') return stops.filter((s) => s.highlight);
	throw new Error(`unknown --route=${ROUTE}; use full or highlights`);
}

const wantSections = args.sections
	? String(args.sections).split(',').map((s) => s.trim()).filter(Boolean)
	: null;

const chapters = [];
for (const section of curriculum.sections) {
	if (section.id === 'onboarding') continue;
	if (wantSections && !wantSections.includes(section.id)) continue;
	const stops = routeStops().filter((s) => s.section === section.id).slice(0, LIMIT);
	if (stops.length) chapters.push({ ...section, stops });
}
if (!chapters.length) throw new Error('the route selected no stops');

const totalStops = chapters.reduce((n, c) => n + c.stops.length, 0);
log(`route ${ROUTE}: ${totalStops} stops across ${chapters.length} chapters against ${ORIGIN}`);
for (const c of chapters) log(`  ${c.title.padEnd(12)} ${String(c.stops.length).padStart(3)} stops`);

if (args['dry-run']) {
	for (const c of chapters) {
		console.log(`\n## ${c.title}`);
		for (const s of c.stops) console.log(`  ${s.highlight ? '*' : ' '} ${s.path.padEnd(34)} ${lineFor(s)}`);
	}
	process.exit(0);
}

/* ── filming ────────────────────────────────────────────────────────────── */

mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
const voiceDir = path.join(WORK, 'voice');
const narrator = new Narrator({ origin: ORIGIN, dir: voiceDir, voice: VOICE, log, enabled: !args['no-voice'] });

const skipped = [];
const parts = [];
const browser = await chromium.launch(launchOptions());

try {
	for (const [ci, chapter] of chapters.entries()) {
		const out = path.join(OUT, `three-ws-demo-${String(ci + 1).padStart(2, '0')}-${chapter.id}.mp4`);
		if (args.reuse && existsSync(out)) {
			log(`chapter ${chapter.title}: reusing ${path.basename(out)}`);
			parts.push(out);
			continue;
		}

		const videoDir = path.join(WORK, `video-${chapter.id}`);
		rmSync(videoDir, { recursive: true, force: true });
		mkdirSync(videoDir, { recursive: true });

		const ctx = await browser.newContext(contextOptions({ authed: Boolean(args.authed), videoDir }));
		ctx.setDefaultTimeout(45_000);
		await ctx.addInitScript(installOverlay);
		const page = await ctx.newPage();
		const t0 = Date.now();
		narrator.open(t0);
		const p = new Presenter(page, { log });

		log(`chapter ${ci + 1}/${chapters.length}: ${chapter.title} (${chapter.stops.length} stops)`);

		/* Open on the chapter's first page so the title card sits over the real
		   product rather than over a blank tab. */
		const first = chapter.stops[0];
		await page.goto(`${ORIGIN}${first.path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
		await page.waitForTimeout(2600);
		await p.ready();
		await p.chapter(`Chapter ${ci + 1}`, chapter.title, say(chapter.intro).slice(0, 190));
		if (ci === 0) {
			const until = await narrator.say(p, say(OPENING), { kicker: 'three.ws' });
			await narrator.settle(until);
		} else {
			await sleep(3000);
		}
		await p.chapter('', '', '');
		await sleep(700);

		for (const [si, stop] of chapter.stops.entries()) {
			const at = `${si + 1}/${chapter.stops.length}`;
			try {
				if (new URL(page.url()).pathname !== stop.path) {
					await page.goto(`${ORIGIN}${stop.path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
				}
				await p.ready();
				await p.badge(`three.ws${stop.path === '/' ? '' : stop.path}`);
				/* The line starts while the page is still settling, so the film
				   never sits in silence waiting for a 3D scene to stream in. */
				const until = await narrator.say(p, say(lineFor(stop)), { kicker: chapter.title });
				await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
				await sleep(stop.highlight ? 1800 : 900);
				await p.ready();
				const act = ACTS[stop.path] || ((ctxp) => genericAct(ctxp, stop));
				await act(p, stop);
				await narrator.settle(until);
				log(`  ${at} ${stop.path}`);
			} catch (err) {
				const why = String(err.message).split('\n')[0].slice(0, 140);
				skipped.push({ chapter: chapter.id, path: stop.path, why });
				log(`  ${at} ${stop.path} SKIPPED: ${why}`);
				if (STRICT) throw err;
			}
		}

		if (ci === chapters.length - 1) {
			await p.caption('', '');
			await p.chapter('three.ws', 'Build one yourself', 'three.ws');
			const until = await narrator.say(p, say(CLOSING), { kicker: '' });
			await narrator.settle(until, { tail: 1200 });
		}

		const spanMs = Date.now() - t0;
		await ctx.close();
		const webm = await page.video().path();
		log(`  chapter recorded in ${(spanMs / 1000).toFixed(0)}s, encoding`);
		const audio = narrator.buildTrack(path.join(WORK, `audio-${chapter.id}.wav`), spanMs);
		encodeSection({ webm, audio, out, fps: FPS, crf: CRF });
		rmSync(videoDir, { recursive: true, force: true });
		const info = mediaInfo(out);
		log(`  wrote ${path.relative(ROOT, out)} (${info.seconds.toFixed(0)}s, ${(info.bytes / 1e6).toFixed(0)} MB)`);
		parts.push(out);
	}
} finally {
	await browser.close();
}

const full = path.join(OUT, 'three-ws-demo.mp4');
if (parts.length > 1) {
	concatParts(parts, full, WORK);
	log(`wrote ${path.relative(ROOT, full)}`);
} else if (parts.length === 1) {
	log(`single chapter: ${path.relative(ROOT, parts[0])}`);
}

const film = existsSync(full) ? full : parts[0];
const info = film ? mediaInfo(film) : { seconds: 0, bytes: 0 };
const manifest = {
	generatedAt: new Date().toISOString(),
	origin: ORIGIN,
	route: ROUTE,
	authed: Boolean(args.authed),
	voice: args['no-voice'] ? null : VOICE,
	stage: `${STAGE.width}x${STAGE.height}@${FPS}`,
	stops: totalStops,
	recorded: totalStops - skipped.length,
	seconds: Math.round(info.seconds),
	bytes: info.bytes,
	film: film ? path.relative(ROOT, film) : null,
	chapters: parts.map((f, i) => ({
		id: chapters[i].id,
		title: chapters[i].title,
		file: path.relative(ROOT, f),
		seconds: Math.round(mediaInfo(f).seconds),
	})),
	skipped,
};
writeFileSync(path.join(OUT, 'demo-manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);

log(`${manifest.recorded}/${totalStops} stops recorded, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) log(`  skipped ${s.path}: ${s.why}`);
log(`film: ${manifest.film} (${Math.round(info.seconds / 60)}m ${Math.round(info.seconds % 60)}s, ${(info.bytes / 1e6).toFixed(0)} MB)`);
