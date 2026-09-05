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
 * The voice is the platform's own TTS lane, so three.ws narrates three.ws, and
 * captions carry the same words. Every line is synthesized before the camera
 * rolls: filming is real time, so a line fetched mid-take is dead air.
 *
 * Usage:
 *   npm run demo:video                       # every feature, all chapters
 *   npm run demo:video -- --route=highlights # the short cut, ~23 stops
 *   npm run demo:video -- --sections=build,crypto --authed
 *   npm run demo:video -- --dry-run          # print the route and exit
 *
 * Flags:
 *   --route=full|highlights         which stops (default full: every feature)
 *   --sections=a,b                  only these chapters (default: all, in order)
 *   --limit=n                       first n stops per chapter, for a smoke test
 *   --authed                        replay .auth/audit-state.json (signed-in surfaces)
 *   --origin=                       film a dev server instead of https://three.ws
 *   --out=                          output directory (default marketing/product-demo)
 *   --name=                         output basename (default three-ws-demo, per route)
 *   --narrator=edge|speak           which TTS lane to synthesize on (default edge)
 *   --voice=                        voice id for that lane (default en-US-AndrewMultilingualNeural)
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
	encodeSection, concatParts, mediaInfo, readJson, sleep, sessionCookie,
} from './lib/demo-stage.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = a.match(/^--([^=]+)(?:=(.*))?$/);
	return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ORIGIN = String(args.origin || 'https://three.ws').replace(/\/$/, '');
const OUT = path.resolve(ROOT, String(args.out || 'marketing/product-demo'));
const WORK = path.join(OUT, '.raw');
const LANE = String(args.narrator || 'edge');
const VOICE = args.voice ? String(args.voice) : null;
const CRF = Number(args.crf || 22);
const STRICT = Boolean(args.strict);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
/* Every route writes its own set of files, so filming the short cut never
   overwrites the chapters of the full film sitting beside it. */
const NAME = String(args.name || (String(args.route || 'full') === 'full' ? 'three-ws-demo' : `three-ws-demo-${args.route}`));
const log = (...m) => console.log('[demo]', ...m);

/* ── the script ─────────────────────────────────────────────────────────── */

const curriculum = readJson(path.join(ROOT, 'public/tour/curriculum.json'));

const OPENING = 'This is three.ws, the 3D agent layer of the internet. Over the next few chapters '
	+ 'I am going to walk the whole platform with you, feature by feature, on the live site. Everything you '
	+ 'are about to see is the real product answering in real time.';
const CLOSING = 'That is the whole platform: build a body, give it a brain, put it to work, and let it '
	+ 'hold its own wallet. Everything in this film is live at three.ws right now.';

/* Captions carry the words as they are written; the synthesizer is handed the
   same line with the pieces a reader parses silently spelled out for it. */
const SPOKEN = {
	'three.ws': 'three dot w s',
	x402: 'x four oh two',
	'ERC-8004': 'E R C 8004',
	USDC: 'U S D C',
	GLB: 'G L B',
	SDK: 'S D K',
	API: 'A P I',
	APIs: 'A P Is',
	MCP: 'M C P',
	HTML: 'H T M L',
	URL: 'U R L',
	IK: 'I K',
	FK: 'F K',
};
const SPOKEN_RE = new RegExp(`\\b(${Object.keys(SPOKEN).map((k) => k.replace(/[.\-]/g, '\\$&')).join('|')})\\b`, 'g');
const speech = (text) => String(text || '')
	.replace(SPOKEN_RE, (m) => SPOKEN[m] || m)
	.replace(/three\.ws/gi, 'three dot w s')
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
 * A hand-written act for a flagship surface: the real interaction a presenter
 * would perform, with the lines they would say while performing it. `beat`
 * speaks a line and waits it out, so the film is never clicking in silence and
 * never talking over a page that has not arrived yet.
 *
 * Nothing here fakes a result. A selector that has gone missing surfaces as a
 * skipped stop in the run report rather than as a still frame in the film.
 */
const ACTS = {
	'/': async (p, { beat }) => {
		await p.hover('.nav-trigger:has-text("Build")', { hold: 1200 });
		await beat('The whole platform hangs off three menus. Build is where you make things.');
		await p.hover('.nav-trigger:has-text("Discover")', { hold: 1200 });
		await beat('Discover is where you find what everybody else has already made.');
		await p.page.keyboard.press('Escape').catch(() => {});
		await p.type('#hero-forge-input', 'a brass astrolabe on a walnut stand', { cps: 17, settle: 700 });
		await beat('The front page has a forge in it. Describe an object, and a real textured 3D model comes back in about a minute. No sign up.');
		await p.readThrough({ budgetMs: 4500 });
	},

	'/what-is': async (p, { beat }) => {
		await p.readThrough({ budgetMs: 5000 });
		await beat('A 3D agent is three things at once: a body you can see, a brain you can talk to, and a wallet it can spend from.');
	},

	'/discover': async (p, { beat }) => {
		await p.type('input[placeholder*="Search by name"]', 'agent', { cps: 13, settle: 1200 });
		await beat('Every agent here is registered on chain, on Solana and on the ERC-8004 registries, so the directory is not ours to fake.');
		await p.clickIfPresent('button.tws-lc-chip:has-text("All agents")', { after: 1500 });
		await p.readDown(760, { ms: 1500 });
	},

	'/marketplace': async (p, { beat }) => {
		await p.type('#market-search', 'knight', { cps: 12, settle: 1400 });
		await beat('Those cards are live 3D models, not thumbnails. Every one of them is rendering in the browser right now.');
		await p.clickIfPresent('button.market-chip:has-text("Avatars")', { after: 1600 });
		await p.readDown(820, { ms: 1600 });
		await p.hover('#market-grid a.title.card-profile-link', { hold: 800 });
	},

	'/create-agent': async (p, { beat }) => {
		await p.readThrough({ budgetMs: 5000 });
		await beat('Name, body, skills, personality, voice, wallet. Six steps, and the agent exists at its own address on the web.');
	},

	'/create/prompt': async (p, { beat }) => {
		await p.type('#prompt', 'a medieval knight in battered steel plate, weathered red cloak', { cps: 16, settle: 700 });
		const fired = await p.clickIfPresent('#generate-btn', { after: 2000 });
		if (!fired) {
			await beat('One sentence in, a rigged humanoid out. The pipeline generates the mesh, textures it, and fits a skeleton to it.');
			return;
		}
		await beat('That is the real pipeline running: a mesh generated from the words, textured, then rigged with a humanoid skeleton so it can be animated.');
		const deadline = Date.now() + 60_000;
		let spoke = false;
		while (Date.now() < deadline) {
			if (await p.page.locator('.step[data-step="done"].active').isVisible().catch(() => false)) break;
			if (await p.page.locator('#build-error.show').isVisible().catch(() => false)) break;
			if (!spoke && Date.now() > deadline - 42_000) {
				spoke = true;
				await beat('It takes about a minute. The progress you are watching is the job reporting its own stages, not a loading animation.');
			}
			await sleep(700);
		}
		if (await p.page.locator('#done-model').isVisible().catch(() => false)) {
			await sleep(2000);
			await p.dragAcross('#done-model', { dx: 260, ms: 1300 });
			await beat('There it is, turning under the cursor. That model is yours to download, embed, or sell.');
		}
	},

	'/forge': async (p, { beat }) => {
		await p.type('#prompt', 'a worn leather armchair, studio lit', { cps: 16, settle: 600 });
		await beat('The Forge is the same engine without the skeleton: any object, not just humanoids.');
		await p.clickIfPresent('#tab-image', { after: 1300 });
		await beat('It takes photographs too.');
		await p.clickIfPresent('#tab-sketch', { after: 1300 });
		await beat('Or a sketch. Several generation engines sit behind these tabs, each with live health status, and the request goes to whichever one is up.');
		await p.clickIfPresent('#tab-text', { after: 1100 });
		await p.readDown(900, { ms: 1600 });
		await p.clickIfPresent('button.showcase-sort-btn:has-text("Top this week")', { after: 1600 });
	},

	'/pose': async (p, { beat }) => {
		await p.dragAcross('#pose-canvas', { dx: 320, ms: 1400 });
		await beat('Any avatar on the platform can be posed here, bone by bone.');
		await p.clickIfPresent('button.mode-btn:has-text("IK")', { after: 1100 });
		await beat('Forward kinematics for single joints, inverse kinematics when you want to drag a hand and let the arm follow.');
		await p.type('#pose-bone-search', 'arm', { cps: 10, settle: 1000 });
	},

	'/playground': async (p, { beat }) => {
		await p.dragAcross('#viewer', { dx: 340, ms: 1400 });
		await beat('This is the embed, running exactly as it would on your own site.');
		await p.clickIfPresent('button.pill:has-text("Midnight")', { after: 1200 });
		await p.clickIfPresent('button.pill:has-text("Warm")', { after: 1200 });
		await beat('Lighting, background, shadow, auto rotate: every option here is an attribute on the tag.');
		await p.clickIfPresent('#copy-embed', { after: 1200 });
		await beat('And that is the snippet. Two lines of HTML, and the avatar is on your page.');
	},

	'/brain': async (p, { beat }) => {
		await p.type('#brDescribeInput', 'a sharp crypto trader who speaks in plain English', { cps: 16, settle: 700 });
		await beat('Describe the personality you want and the platform writes the system prompt for it.');
		await p.clickIfPresent('#brBuildPersonaBtn', { after: 3000 });
		await p.clickIfPresent('button.br-tab:has-text("Playground")', { after: 1800 });
		await beat('The playground sends one prompt to several models at once, side by side, with latency and token counts, so you can pick the brain on evidence.');
	},

	'/chat': async (p, { beat }) => {
		const box = 'textarea[placeholder*="Type a message"]';
		if (!(await p.page.locator(box).count())) return;
		await p.type(box, 'What can you build for me?', { cps: 15, settle: 400 });
		await p.page.keyboard.press('Enter');
		await beat('That is a real model answering, with tools and skills attached to it, and a wallet it can pay with.');
		await sleep(2500);
		await p.readDown(400, { ms: 900 });
	},

	'/agents': async (p, { beat }) => {
		await p.type('#ag-search', 'trader', { cps: 12, settle: 1300 });
		await beat('Every agent anyone has built on three.ws, searchable, each with its own page.');
		await p.readDown(700, { ms: 1400 });
	},

	'/pay': async (p, { beat }) => {
		await beat('This is machine to machine payment. An API answers a request with a price instead of a refusal, and the agent pays it.');
		await p.clickIfPresent('button.chain-tab:has-text("BNB")', { after: 1300 });
		await p.clickIfPresent('button.chain-tab:has-text("Solana")', { after: 1300 });
		await p.type('#prompt', 'validate https://example.com', { cps: 16, settle: 700 });
		await beat('Solana first, in USDC, settling in under a second and costing a fraction of a cent.');
		await p.readThrough({ budgetMs: 3500 });
	},

	'/launch': async (p, { beat }) => {
		await p.readThrough({ budgetMs: 5000 });
		await beat('An agent can have its own coin, minted in one flow from inside the platform, with the agent as the thing it is attached to.');
	},

	'/markets': async (p, { beat }) => {
		await p.readDown(900, { ms: 1600 });
		await beat('Live prices, news, screeners and on chain intelligence, so an agent that trades has something to trade on.');
		await p.clickIfPresent('button.nw-star', { after: 1100 });
		await p.readDown(1100, { ms: 1700 });
	},

	'/holo': async (p, { beat }) => {
		await p.clickIfPresent('button.hs-chip:has-text("$THREE")', { after: 1300 });
		await p.slideTo('#peelRange', 0.72, { ms: 1500 });
		await beat('Every pixel of that foil is procedural. No image assets, no video, just shaders running in the page.');
		await p.slideTo('#peelRange', 0.12, { ms: 1200 });
	},

	'/labs': async (p, { beat }) => {
		await p.clickIfPresent('button.labs-filter:has-text("x402")', { after: 1500 });
		await beat('Labs is the drawer everything experimental lives in, and most of it ends up shipping.');
		await p.clickIfPresent('button.labs-filter:has-text("All")', { after: 1100 });
		await p.readDown(820, { ms: 1600 });
	},

	'/diorama': async (p, { beat }) => {
		await p.clickIfPresent('button.dio-chip', { after: 1500 });
		await p.type('#compose-input', 'a cliffside lighthouse in a storm', { cps: 16, settle: 700 });
		await beat('Same idea as the forge, but for whole scenes: describe a little world and it gets built around you.');
		await p.readDown(600, { ms: 1400 });
	},

	'/walk': async (p, { beat }) => {
		await p.readDown(760, { ms: 1500 });
		await beat('Your avatar can walk across any website that carries the tag, not just ours. It is a script tag and a model URL.');
		await p.clickIfPresent('#wl-copy', { after: 1300 });
		await p.readThrough({ budgetMs: 3500 });
	},

	'/docs': async (p, { beat }) => {
		await p.readThrough({ budgetMs: 4500 });
		await beat('Every surface in this film has an API, an SDK, and a page in here explaining it.');
	},
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
const narrator = new Narrator({
	origin: ORIGIN,
	dir: voiceDir,
	lane: LANE,
	voice: VOICE,
	cookie: sessionCookie(),
	speechify: speech,
	log,
	enabled: !args['no-voice'],
});

/*
 * Every line the film will speak, synthesized before the camera rolls.
 *
 * Filming is real time, so a line fetched mid-take is dead air on screen: the
 * first cut of this film opened on 52 seconds of silence because the longest
 * line in it was being synthesized while the page sat there. The stop lines and
 * chapter intros are data, and an act's own beats are string literals in its
 * source, so the whole script can be collected up front.
 */
const BEAT_RE = /beat\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
function scriptLines() {
	const lines = [OPENING, CLOSING];
	for (const chapter of chapters) {
		lines.push(chapter.intro);
		for (const stop of chapter.stops) lines.push(lineFor(stop));
	}
	for (const act of Object.values(ACTS)) {
		for (const m of String(act).matchAll(BEAT_RE)) lines.push(m[1].replace(/\\'/g, "'"));
	}
	return lines;
}
await narrator.warm(scriptLines());

const skipped = [];
const parts = [];
const browser = await chromium.launch(launchOptions());

try {
	for (const [ci, chapter] of chapters.entries()) {
		const out = path.join(OUT, `${NAME}-${String(ci + 1).padStart(2, '0')}-${chapter.id}.mp4`);
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
		   product rather than over a blank tab. The card carries the words while
		   they are spoken, so the caption bar stays out of its way. */
		const first = chapter.stops[0];
		await page.goto(`${ORIGIN}${first.path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
		/* The card goes up as soon as the document exists, so the chapter opens
		   on a title rather than on a page still streaming its 3D scene in. */
		await p.showCursor(false);
		if (ci === 0) {
			/* The opening already welcomes the viewer, so chapter one does not
			   also read the guide's own welcome line back to them. */
			await p.chapter('', 'three.ws', OPENING);
			const until = await narrator.say(p, OPENING, { caption: false });
			await narrator.settle(until);
			await p.chapter('Chapter 1', chapter.title, '');
			await sleep(2600);
		} else {
			const intro = chapter.intro;
			await p.chapter(`Chapter ${ci + 1}`, chapter.title, intro);
			const introUntil = await narrator.say(p, intro, { caption: false });
			await narrator.settle(introUntil);
		}
		await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
		await p.ready();
		await p.chapter('', '', '');
		await p.showCursor(true);
		await sleep(700);

		for (const [si, stop] of chapter.stops.entries()) {
			const at = `${si + 1}/${chapter.stops.length}`;
			try {
				if (new URL(page.url()).pathname !== stop.path) {
					await page.goto(`${ORIGIN}${stop.path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
				}
				/* The line starts against the document as soon as it exists, so
				   the film never sits in silence waiting for a 3D scene to
				   stream in, and the caption is up while it arrives. */
				await p.badge(`three.ws${stop.path === '/' ? '' : stop.path}`);
				const until = await narrator.say(p, lineFor(stop), { kicker: chapter.title });
				await page.waitForLoadState('load', { timeout: 12_000 }).catch(() => {});
				await sleep(stop.highlight ? 1500 : 700);
				await p.ready();
				/* A line spoken from inside an act: the presenter keeps talking
				   while they click, which is what keeps the film from clicking
				   in silence on the surfaces that take a while to show. */
				const beat = async (text) => {
					const done = await narrator.say(p, text, { kicker: chapter.title });
					await narrator.settle(done, { tail: 260 });
				};
				const act = ACTS[stop.path] || ((pp, c) => genericAct(pp, c.stop));
				await act(p, { stop, beat, page });
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
			await p.badge('');
			await p.showCursor(false);
			await p.chapter('', 'three.ws', CLOSING);
			const until = await narrator.say(p, CLOSING, { caption: false });
			await narrator.settle(until, { tail: 1400 });
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

const full = path.join(OUT, `${NAME}.mp4`);
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
	narrator: args['no-voice'] ? null : { lane: LANE, voice: narrator.voice },
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
writeFileSync(path.join(OUT, `${NAME}-manifest.json`), `${JSON.stringify(manifest, null, '\t')}\n`);

log(`${manifest.recorded}/${totalStops} stops recorded, ${skipped.length} skipped`);
if (skipped.length) for (const s of skipped) log(`  skipped ${s.path}: ${s.why}`);
log(`film: ${manifest.film} (${Math.round(info.seconds / 60)}m ${Math.round(info.seconds % 60)}s, ${(info.bytes / 1e6).toFixed(0)} MB)`);
