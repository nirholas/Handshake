/**
 * The stage a product demo is filmed on: a desktop browser, a visible mouse, an
 * on-screen caption track, and a narrator.
 *
 * Where the Seeker recordings (solana-mobile/scripts/lib/seeker-panel.mjs) step
 * frames one at a time to reproduce a phone panel exactly, this films the
 * desktop site in REAL TIME with Playwright's own recorder. A product demo is
 * watched for its motion: the 3D scenes streaming in, a model spinning under
 * the cursor, a marketplace grid settling after a search. Stepped frames freeze
 * all of that, and the pages here run WebGL on nearly every route.
 *
 * Nothing on screen is staged. The pointer overlay is a listener: it follows
 * real mousemove and mousedown events dispatched into the page by Playwright,
 * the same way a screen recorder draws the host cursor over a real session. It
 * reports the interaction, it never stands in for one.
 *
 * The narration is spoken by the platform's own TTS endpoint (/api/tts/speak),
 * so a demo of three.ws is narrated by three.ws.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const AUTH_STATE = path.join(ROOT, '.auth/audit-state.json');

/* 1920x1080 at density 1: the frame every player, every social card, and every
   conference screen expects, and the viewport this site's desktop layout was
   designed against. */
export const STAGE = { width: 1920, height: 1080 };
export const FPS = 30;

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

/**
 * Chromium flags for a recording.
 *
 * `--disable-dev-shm-usage` is not optional in a container: Docker gives
 * /dev/shm 64 MB and these pages are enormous (the marketplace document is
 * 23k px tall with live model-viewer instances), so the renderer either crashes
 * or crawls, which reads on camera as the site being slow. `--hide-scrollbars`
 * removes the headless scrollbar without changing the layout width, and the
 * font flags keep type rendering identical between runs.
 */
export function launchOptions() {
	return {
		args: [
			'--disable-dev-shm-usage',
			'--hide-scrollbars',
			'--force-color-profile=srgb',
			'--font-render-hinting=none',
			'--autoplay-policy=no-user-gesture-required',
		],
	};
}

/** The desktop browser context a demo is filmed in. */
export function contextOptions({ authed = false, videoDir = null } = {}) {
	if (authed && !existsSync(AUTH_STATE)) {
		throw new Error(`--authed needs ${path.relative(ROOT, AUTH_STATE)}; mint it with: npm run audit:web:login`);
	}
	return {
		viewport: STAGE,
		deviceScaleFactor: 1,
		colorScheme: 'dark',
		locale: 'en-US',
		timezoneId: 'UTC',
		reducedMotion: 'no-preference',
		...(videoDir ? { recordVideo: { dir: videoDir, size: STAGE } } : {}),
		...(authed ? { storageState: AUTH_STATE } : {}),
	};
}

/**
 * The overlay, installed into every document (first load and every client-side
 * navigation alike). Three pieces, all `pointer-events:none` so none of them
 * can intercept an interaction:
 *
 *   cursor    an arrow that follows real pointer events, with a click ring
 *   caption   the lower third, carrying the same words the narrator speaks
 *   chapter   a full-frame title card between sections
 */
export function installOverlay() {
	const ID = '__demo_stage';
	if (window.__demoStage && document.getElementById(ID)?.isConnected) return;

	const build = () => {
		const host = document.body || document.documentElement;
		if (!host) return null;
		let root = document.getElementById(ID);
		if (root && root.isConnected) return root;
		root = document.createElement('div');
		root.id = ID;
		root.setAttribute('aria-hidden', 'true');
		root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
			+ 'font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;';

		const style = document.createElement('style');
		style.textContent = `
#${ID} .ds-cursor{position:absolute;left:0;top:0;width:26px;height:34px;opacity:0;
  transform:translate(-2px,-2px);filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));will-change:transform}
#${ID} .ds-ring{position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
  border:2px solid rgba(255,255,255,.95);opacity:0;will-change:transform,opacity}
#${ID} .ds-ring.ds-fire{animation:ds-pop .5s cubic-bezier(.2,.7,.3,1) forwards}
@keyframes ds-pop{0%{opacity:.9;transform:scale(.5)}100%{opacity:0;transform:scale(4.6)}}
#${ID} .ds-cap{position:absolute;left:50%;bottom:74px;transform:translateX(-50%) translateY(14px);
  max-width:1180px;box-sizing:border-box;padding:16px 28px 18px;border-radius:18px;opacity:0;
  background:rgba(9,9,20,.86);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px);
  box-shadow:0 24px 60px rgba(0,0,0,.5);transition:opacity .32s ease,transform .32s ease}
#${ID} .ds-cap.ds-on{opacity:1;transform:translateX(-50%) translateY(0)}
#${ID} .ds-kick{display:block;font-size:13px;letter-spacing:.16em;text-transform:uppercase;
  color:#8b7bff;font-weight:700;margin-bottom:7px}
#${ID} .ds-text{display:block;font-size:25px;line-height:1.38;color:#f2f3ff;font-weight:500}
#${ID} .ds-chap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:18px;background:rgba(6,6,14,.93);opacity:0;transition:opacity .5s ease;text-align:center}
#${ID} .ds-chap.ds-on{opacity:1}
#${ID} .ds-chap-n{font-size:15px;letter-spacing:.34em;text-transform:uppercase;color:#8b7bff;font-weight:700}
#${ID} .ds-chap-t{font-size:78px;line-height:1.06;font-weight:800;color:#fff;letter-spacing:-.02em;max-width:1200px}
#${ID} .ds-chap-s{font-size:24px;color:#b9bad6;max-width:900px;line-height:1.5}
#${ID} .ds-badge{position:absolute;right:34px;top:28px;display:flex;align-items:center;gap:9px;
  padding:9px 15px;border-radius:999px;background:rgba(9,9,20,.72);border:1px solid rgba(255,255,255,.13);
  color:#e8e9ff;font-size:15px;font-weight:600;letter-spacing:.01em;opacity:0;transition:opacity .4s ease}
#${ID} .ds-badge.ds-on{opacity:1}
#${ID} .ds-dot{width:8px;height:8px;border-radius:50%;background:#5ee6a8;box-shadow:0 0 10px #5ee6a8}`;

		const cursor = document.createElement('div');
		cursor.className = 'ds-cursor';
		cursor.innerHTML = '<svg viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg">'
			+ '<path d="M2 1.6 L2 26.4 L8.3 20.6 L12.4 30.6 L16.6 28.8 L12.6 19.1 L21.2 18.4 Z" '
			+ 'fill="#ffffff" stroke="rgba(10,10,20,.85)" stroke-width="1.6" stroke-linejoin="round"/></svg>';

		const ring = document.createElement('div');
		ring.className = 'ds-ring';

		const cap = document.createElement('div');
		cap.className = 'ds-cap';
		cap.innerHTML = '<span class="ds-kick"></span><span class="ds-text"></span>';

		const chap = document.createElement('div');
		chap.className = 'ds-chap';
		chap.innerHTML = '<span class="ds-chap-n"></span><span class="ds-chap-t"></span><span class="ds-chap-s"></span>';

		const badge = document.createElement('div');
		badge.className = 'ds-badge';
		badge.innerHTML = '<span class="ds-dot"></span><span class="ds-badge-t"></span>';

		root.append(style, chap, cap, badge, cursor, ring);
		host.appendChild(root);
		return root;
	};

	const at = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
	const place = () => {
		const root = document.getElementById(ID);
		if (!root) return;
		const cursor = root.querySelector('.ds-cursor');
		const ring = root.querySelector('.ds-ring');
		cursor.style.transform = `translate(${at.x - 2}px, ${at.y - 2}px)`;
		ring.style.transform = `translate(${at.x}px, ${at.y}px)`;
	};

	/* Capture phase, so a page that stops propagation on its own handlers still
	   moves the cursor: what is drawn is exactly where the real pointer is. */
	window.addEventListener('mousemove', (e) => {
		at.x = e.clientX;
		at.y = e.clientY;
		const root = build();
		if (!root) return;
		root.querySelector('.ds-cursor').style.opacity = '1';
		place();
	}, { capture: true, passive: true });

	window.addEventListener('mousedown', () => {
		const root = build();
		if (!root) return;
		const ring = root.querySelector('.ds-ring');
		ring.classList.remove('ds-fire');
		void ring.offsetWidth;
		ring.classList.add('ds-fire');
	}, { capture: true, passive: true });

	window.__demoStage = {
		ensure() { build(); place(); },
		cursor(on) {
			const root = build();
			if (root) root.querySelector('.ds-cursor').style.opacity = on ? '1' : '0';
		},
		caption(text, kicker) {
			const root = build();
			if (!root) return;
			const el = root.querySelector('.ds-cap');
			if (!text) { el.classList.remove('ds-on'); return; }
			el.querySelector('.ds-kick').textContent = kicker || '';
			el.querySelector('.ds-text').textContent = text;
			el.classList.add('ds-on');
		},
		badge(text) {
			const root = build();
			if (!root) return;
			const el = root.querySelector('.ds-badge');
			if (!text) { el.classList.remove('ds-on'); return; }
			el.querySelector('.ds-badge-t').textContent = text;
			el.classList.add('ds-on');
		},
		chapter(n, title, subtitle) {
			const root = build();
			if (!root) return;
			const el = root.querySelector('.ds-chap');
			if (!title) { el.classList.remove('ds-on'); return; }
			el.querySelector('.ds-chap-n').textContent = n || '';
			el.querySelector('.ds-chap-t').textContent = title;
			el.querySelector('.ds-chap-s').textContent = subtitle || '';
			el.classList.add('ds-on');
		},
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
	else build();
}

/**
 * The QA session as a Cookie header, for the API calls a recording makes on its
 * own behalf (the narration lane is signed-in-only, and its anonymous bucket is
 * far too small for a film).
 */
export function sessionCookie() {
	if (!existsSync(AUTH_STATE)) return null;
	const state = JSON.parse(readFileSync(AUTH_STATE, 'utf8'));
	const jar = (state.cookies || [])
		.filter((c) => String(c.domain || '').includes('three.ws'))
		.map((c) => `${c.name}=${c.value}`);
	return jar.length ? jar.join('; ') : null;
}

/**
 * A mouse that behaves like a hand on a demo machine: it bows its path, speeds
 * up in the middle, decelerates into the target, and pauses a beat before it
 * clicks. Every method dispatches real input; nothing here is a synthetic
 * event, so a click that lands on nothing fails the same way a person's would.
 */
export class Presenter {
	constructor(page, { log = () => {}, seed = 11 } = {}) {
		this.page = page;
		this.log = log;
		this.x = STAGE.width / 2;
		this.y = STAGE.height * 0.62;
		this.arc = 1;
		let a = seed >>> 0;
		this.rand = () => {
			a |= 0; a = (a + 0x6D2B79F5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	jitter(px) { return (this.rand() * 2 - 1) * px; }

	/** Re-install the overlay after a navigation and put the cursor back. */
	async ready() {
		await this.page.evaluate(installOverlay).catch(() => {});
		await this.page.mouse.move(this.x, this.y);
	}

	async moveTo(x, y, { ms } = {}) {
		const from = { x: this.x, y: this.y };
		const dist = Math.hypot(x - from.x, y - from.y);
		if (dist < 1) return;
		const dur = ms ?? Math.min(1150, 260 + dist * 0.62);
		const steps = Math.max(8, Math.round(dur / 12));
		const bow = Math.min(70, dist * 0.13) * this.arc;
		this.arc *= -1;
		const mid = {
			x: (from.x + x) / 2 + ((y - from.y) / dist) * bow,
			y: (from.y + y) / 2 - ((x - from.x) / dist) * bow,
		};
		for (let i = 1; i <= steps; i += 1) {
			const t = easeInOutCubic(i / steps);
			const u = 1 - t;
			const px = u * u * from.x + 2 * u * t * mid.x + t * t * x;
			const py = u * u * from.y + 2 * u * t * mid.y + t * t * y;
			await this.page.mouse.move(px, py);
			await sleep(dur / steps);
		}
		this.x = x;
		this.y = y;
		await this.page.mouse.move(x, y);
	}

	/** Where on an element a person would actually aim: near the middle, not on it. */
	async pointOn(selector, { scroll = true } = {}) {
		const el = this.locate(selector);
		await el.waitFor({ state: 'visible', timeout: 20_000 });
		if (scroll) await this.bringIntoView(selector);
		const box = await el.boundingBox();
		if (!box) throw new Error(`${selector} has no box to aim at`);
		return {
			x: box.x + box.width / 2 + this.jitter(Math.min(box.width * 0.16, 26)),
			y: box.y + box.height / 2 + this.jitter(Math.min(box.height * 0.18, 8)),
		};
	}

	locate(selector) {
		return typeof selector === 'string' ? this.page.locator(selector).first() : selector.first();
	}

	async hover(selector, { hold = 700 } = {}) {
		const { x, y } = await this.pointOn(selector);
		await this.moveTo(x, y);
		await sleep(hold);
	}

	async click(selector, { before = 240, after = 900, expect = null, expectTimeout = 30_000 } = {}) {
		const { x, y } = await this.pointOn(selector);
		await this.moveTo(x, y);
		await sleep(before);
		await this.page.mouse.down();
		await sleep(70);
		await this.page.mouse.up();
		await sleep(after);
		if (expect) await this.page.locator(expect).first().waitFor({ state: 'visible', timeout: expectTimeout });
	}

	/** Click something only if this build of the page renders it. */
	async clickIfPresent(selector, opts = {}) {
		const el = this.locate(selector);
		if (!(await el.count())) return false;
		if (!(await el.isVisible().catch(() => false))) return false;
		await this.click(selector, opts);
		return true;
	}

	/** Type at a human cadence, slowing at spaces and punctuation the way people do. */
	async type(selector, text, { cps = 15, settle = 700, clear = true } = {}) {
		await this.click(selector, { after: 220 });
		if (clear) {
			await this.page.keyboard.press('ControlOrMeta+a').catch(() => {});
			await this.page.keyboard.press('Backspace').catch(() => {});
		}
		const base = 1000 / cps;
		for (const ch of text) {
			await this.page.keyboard.type(ch);
			let ms = base * (0.7 + this.rand() * 0.75);
			if (ch === ' ') ms *= 1.3;
			if (',.!?'.includes(ch)) ms *= 2;
			await sleep(ms);
		}
		await sleep(settle);
	}

	async scrollState() {
		return this.page.evaluate(() => ({
			y: window.scrollY,
			max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
		}));
	}

	/**
	 * Read down the page with the wheel, the way someone scans a page they are
	 * showing you: several notches, easing in and out, with the cursor sitting
	 * where a hand would rest.
	 */
	async readDown(dy, { ms = 1400 } = {}) {
		const { y: y0, max } = await this.scrollState();
		const target = Math.max(0, Math.min(max, y0 + dy));
		const delta = target - y0;
		if (Math.abs(delta) < 4) return y0;
		const steps = Math.max(10, Math.round(ms / 34));
		let done = 0;
		for (let i = 1; i <= steps; i += 1) {
			const want = delta * easeInOutCubic(i / steps);
			const step = want - done;
			done = want;
			await this.page.mouse.wheel(0, step);
			await sleep(ms / steps);
		}
		await sleep(180);
		return (await this.scrollState()).y;
	}

	/** Walk the whole page top to bottom in reading-sized bites. */
	async readThrough({ budgetMs = 6000, bite = 620, pause = 520 } = {}) {
		const started = Date.now();
		for (let i = 0; i < 14; i += 1) {
			if (Date.now() - started > budgetMs) break;
			const before = (await this.scrollState()).y;
			const after = await this.readDown(bite, { ms: 1100 });
			if (Math.abs(after - before) < 6) break;
			await sleep(pause);
		}
	}

	async toTop({ ms = 900 } = {}) {
		const { y } = await this.scrollState();
		if (y < 8) return;
		await this.readDown(-y, { ms });
	}

	/** Put an element in the comfortable middle band of the frame. */
	async bringIntoView(selector, { top = 140, bottom = 260 } = {}) {
		const el = this.locate(selector);
		const pinned = await el.evaluate((node) => {
			for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
				const pos = getComputedStyle(n).position;
				if (pos === 'fixed' || pos === 'sticky') return true;
			}
			return false;
		}).catch(() => false);
		if (pinned) return;
		const box = await el.boundingBox();
		if (!box) return;
		if (box.y >= top && box.y + box.height <= STAGE.height - bottom) return;
		await this.readDown(box.y + box.height / 2 - STAGE.height * 0.42, { ms: 1000 });
	}

	/** Turn a 3D viewer by dragging it, because that is how a person turns one. */
	async dragAcross(selector, { dx = 320, dy = 0, ms = 1300 } = {}) {
		await this.bringIntoView(selector);
		const box = await this.locate(selector).boundingBox();
		if (!box) throw new Error(`${selector} has no box to drag`);
		const x0 = box.x + box.width * 0.5 - dx / 2;
		const y0 = box.y + Math.min(box.height * 0.55, box.height - 30) - dy / 2;
		await this.moveTo(x0, y0);
		await sleep(200);
		await this.page.mouse.down();
		const steps = Math.max(12, Math.round(ms / 16));
		for (let i = 1; i <= steps; i += 1) {
			const t = easeInOutCubic(i / steps);
			await this.page.mouse.move(x0 + dx * t, y0 + dy * t);
			await sleep(ms / steps);
		}
		await this.page.mouse.up();
		this.x = x0 + dx;
		this.y = y0 + dy;
		await sleep(320);
	}

	/** Drag a range input from wherever it sits to a fraction of its track. */
	async slideTo(selector, fraction, { ms = 1100 } = {}) {
		const box = await this.locate(selector).boundingBox();
		if (!box) throw new Error(`${selector} has no box to slide`);
		const y = box.y + box.height / 2;
		const from = await this.locate(selector).evaluate((el) => {
			const min = Number(el.min || 0);
			const max = Number(el.max || 100);
			return max === min ? 0 : (Number(el.value) - min) / (max - min);
		});
		const x0 = box.x + box.width * from;
		const x1 = box.x + box.width * Math.max(0, Math.min(1, fraction));
		await this.moveTo(x0, y);
		await this.page.mouse.down();
		const steps = Math.max(10, Math.round(ms / 18));
		for (let i = 1; i <= steps; i += 1) {
			await this.page.mouse.move(x0 + (x1 - x0) * easeOutCubic(i / steps), y);
			await sleep(ms / steps);
		}
		await this.page.mouse.up();
		this.x = x1;
		this.y = y;
		await sleep(300);
	}

	async showCursor(on) {
		await this.page.evaluate((v) => window.__demoStage?.cursor(v), on).catch(() => {});
	}

	async caption(text, kicker) {
		await this.page.evaluate(([t, k]) => window.__demoStage?.caption(t, k), [text, kicker]).catch(() => {});
	}

	async badge(text) {
		await this.page.evaluate((t) => window.__demoStage?.badge(t), text).catch(() => {});
	}

	async chapter(n, title, subtitle) {
		await this.page.evaluate(([a, b, c]) => window.__demoStage?.chapter(a, b, c), [n, title, subtitle]).catch(() => {});
	}
}

/* ── narration ──────────────────────────────────────────────────────────── */

export function ffprobeDuration(file) {
	const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr || r.status}`);
	return Math.round(Number(r.stdout.trim()) * 1000);
}

export function ffmpeg(argv, { quiet = true } = {}) {
	const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', quiet ? 'error' : 'info', '-y', ...argv],
		{ stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
	if (r.error || r.status !== 0) throw new Error(`ffmpeg failed (${r.status ?? r.error?.message})`);
}

/**
 * The voice of the demo, synthesized by the platform's own TTS lane.
 *
 * Clips are cached on the text, so a rerun of a tour whose script has not
 * changed costs no synthesis at all, and a section re-recorded on its own gets
 * exactly the audio the full run would have given it.
 */
export const NARRATOR_LANES = {
	/* Microsoft Edge Neural voices, proxied and cached in R2 by the platform.
	   Signed in, it allows 20 unique lines a minute, which is what makes a film
	   with a few hundred spoken lines possible at all. */
	edge: {
		endpoint: '/api/tts/edge',
		voice: 'en-US-AndrewMultilingualNeural',
		ext: 'mp3',
		body: (text, voice) => ({ text, voice }),
		perMinute: 20,
	},
	/* The platform's own free NVIDIA Magpie lane. Better suited to a handful of
	   lines than to a full film: it allows 40 an hour for a signed-in caller. */
	speak: {
		endpoint: '/api/tts/speak',
		voice: 'nova',
		ext: 'wav',
		body: (text, voice) => ({ text, voice, format: 'wav' }),
		perMinute: 0.6,
	},
};

export class Narrator {
	constructor({ origin, dir, lane = 'edge', voice = null, cookie = null, speechify = (t) => t, log = () => {}, enabled = true }) {
		this.lane = NARRATOR_LANES[lane];
		if (!this.lane) throw new Error(`unknown narrator lane "${lane}"; use ${Object.keys(NARRATOR_LANES).join(' or ')}`);
		this.laneId = lane;
		this.origin = origin;
		this.dir = dir;
		this.voice = voice || this.lane.voice;
		this.cookie = cookie;
		/* What is written on screen and what is spoken are not the same string:
		   a caption reads "three.ws", a synthesizer needs "three dot w s". The
		   cache is keyed on the spoken form, since that is what was rendered. */
		this.speechify = speechify;
		this.log = log;
		this.enabled = enabled;
		this.clips = [];
		this.t0 = 0;
		this.spacingMs = Math.ceil(60_000 / this.lane.perMinute) + 400;
		this.lastCall = 0;
		mkdirSync(dir, { recursive: true });
	}

	/** A fresh timeline: called when a section's recording starts. */
	open(t0) {
		this.clips = [];
		this.t0 = t0;
	}

	fileFor(text) {
		const key = createHash('sha1').update(`${this.laneId}\u0000${this.voice}\u0000${text}`).digest('hex').slice(0, 20);
		return path.join(this.dir, `${key}.wav`);
	}

	/**
	 * One line of speech, cached on disk by lane, voice and text.
	 *
	 * Every lane is rate limited (that is the point of a shared endpoint), so a
	 * 429 is a wait rather than a failure: the response carries how long, and a
	 * film with hundreds of lines will meet one. Requests are also spaced to the
	 * lane's own budget so the limiter is usually never reached.
	 */
	async synth(text) {
		const file = this.fileFor(text);
		if (existsSync(file)) return { file, ms: ffprobeDuration(file) };

		const raw = `${file}.${this.lane.ext}`;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const wait = this.spacingMs - (Date.now() - this.lastCall);
			if (wait > 0) await sleep(wait);
			this.lastCall = Date.now();
			const res = await fetch(`${this.origin}${this.lane.endpoint}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(this.cookie ? { cookie: this.cookie } : {}),
				},
				body: JSON.stringify(this.lane.body(text, this.voice)),
			});
			if (res.status === 429) {
				const body = await res.text();
				const after = Number(res.headers.get('retry-after')) || JSON.parse(body || '{}').retry_after || 60;
				this.log(`narrator rate limited, waiting ${after}s`);
				await sleep(Math.min(after, 300) * 1000 + 500);
				continue;
			}
			if (!res.ok) throw new Error(`TTS ${res.status} on ${this.lane.endpoint}: ${(await res.text()).slice(0, 180)}`);
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length < 1024) throw new Error(`TTS returned ${buf.length} bytes for "${text.slice(0, 40)}"`);
			writeFileSync(raw, buf);
			/* One format for every clip, so the track is a concatenation rather
			   than a re-encode per line. */
			ffmpeg(['-i', raw, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', file]);
			rmSync(raw, { force: true });
			return { file, ms: ffprobeDuration(file) };
		}
		throw new Error(`TTS stayed rate limited for "${text.slice(0, 40)}"`);
	}

	/**
	 * Synthesize a whole script before the camera rolls.
	 *
	 * Filming is real time, so a line that is fetched mid-take is dead air in
	 * the film. Warming the cache first moves every one of those waits out of
	 * the recording, and a rerun pays none of it twice.
	 */
	async warm(texts) {
		if (!this.enabled) return { made: 0, cached: 0 };
		const unique = [...new Set(texts.map((t) => this.speechify(String(t || '')).trim()).filter(Boolean))];
		const todo = unique.filter((t) => !existsSync(this.fileFor(t)));
		this.log(`narration: ${unique.length} lines, ${unique.length - todo.length} already synthesized`);
		if (!todo.length) return { made: 0, cached: unique.length };
		const eta = Math.ceil((todo.length * this.spacingMs) / 60_000);
		this.log(`synthesizing ${todo.length} lines on the ${this.laneId} lane (about ${eta} min)`);
		for (const [i, text] of todo.entries()) {
			await this.synth(text);
			if ((i + 1) % 20 === 0 || i + 1 === todo.length) this.log(`  ${i + 1}/${todo.length} lines`);
		}
		return { made: todo.length, cached: unique.length - todo.length };
	}

	/**
	 * Show a line and start speaking it. Returns the wall-clock time the line
	 * finishes, so the caller can act underneath it and then wait out the rest.
	 */
	async say(presenter, text, { kicker = '', caption = true } = {}) {
		if (caption) await presenter.caption(text, kicker);
		if (!this.enabled) return Date.now() + Math.min(9000, 900 + text.length * 46);
		const { file, ms } = await this.synth(this.speechify(text));
		this.clips.push({ at: Math.max(0, Date.now() - this.t0), file, ms });
		return Date.now() + ms;
	}

	/** Hold until the current line has finished, plus a beat to breathe. */
	async settle(until, { tail = 420 } = {}) {
		await sleep(until - Date.now() + tail);
	}

	/**
	 * Lay every clip on a single track at the offset it was spoken at.
	 *
	 * Clips never overlap (each line is waited out before the next one starts),
	 * so the track is an exact concatenation of silence and speech rather than
	 * a mix, which keeps it sample accurate over an hour-long tour.
	 */
	buildTrack(out, totalMs) {
		if (!this.clips.length) return null;
		const work = path.join(this.dir, `.track-${createHash('sha1').update(out).digest('hex').slice(0, 8)}`);
		mkdirSync(work, { recursive: true });
		const parts = [];
		let cursor = 0;
		let silences = 0;
		const silence = (ms) => {
			if (ms < 12) return;
			const f = path.join(work, `sil-${silences++}.wav`);
			ffmpeg(['-f', 'lavfi', '-t', (ms / 1000).toFixed(3),
				'-i', 'anullsrc=r=44100:cl=mono', '-c:a', 'pcm_s16le', f]);
			parts.push(f);
			cursor += ms;
		};
		for (const clip of this.clips) {
			silence(clip.at - cursor);
			parts.push(clip.file);
			cursor += clip.ms;
		}
		silence(Math.max(0, totalMs - cursor));
		const list = path.join(work, 'list.txt');
		writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
		ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', out]);
		return out;
	}
}

/* ── encoding ───────────────────────────────────────────────────────────── */

/** Playwright's webm plus the narration track, muxed into a shareable mp4. */
export function encodeSection({ webm, audio, out, fps = FPS, crf = 22 }) {
	const argv = ['-i', webm];
	if (audio) argv.push('-i', audio);
	argv.push(
		'-map', '0:v:0',
		...(audio ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000'] : []),
		'-vf', `fps=${fps},format=yuv420p`,
		'-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium',
		'-profile:v', 'high', '-level', '4.2', '-movflags', '+faststart',
		out,
	);
	ffmpeg(argv);
	return out;
}

/** Join the chapters into one film. Every part was encoded identically. */
export function concatParts(parts, out, work) {
	mkdirSync(work, { recursive: true });
	const list = path.join(work, 'chapters.txt');
	writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
	ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
	return out;
}

export function mediaInfo(file) {
	const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size',
		'-of', 'default=noprint_wrappers=1', file], { encoding: 'utf8' });
	const map = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
	return { seconds: Number(map.duration || 0), bytes: Number(map.size || 0) };
}

export function readJson(file) {
	return JSON.parse(readFileSync(file, 'utf8'));
}
