/**
 * A visible thumb that drives a page the way a person does.
 *
 * The recordings this backs are frame-stepped (see seeker-panel.mjs), so every
 * pixel of motion is set from here, one output frame at a time: nothing is left
 * to a CSS transition or to the compositor, because those run on the wall clock
 * and the wall clock is not the video's clock. The payoff is that a rerun of
 * the same tour produces the same frames, and a 40 second video does not need
 * 40 seconds of a perfectly behaved live site.
 *
 * The thumb itself is a touch indicator, the same thing Android's "Show taps"
 * developer option draws over a real screen recording. It is the only pixel
 * this file adds to the page. Every tap, keystroke, and gesture underneath it
 * is dispatched as real input to the real page: the indicator reports the
 * interaction, it never stands in for one.
 *
 * Scrolling is the one motion driven from script rather than from the input
 * pipeline. Chromium's fling physics run on the wall clock, which would land a
 * different scroll offset on every stepped frame; `window.scrollTo` per frame
 * with a drag-then-momentum profile puts the same pixels on screen every run.
 */

export const TIP_PX = 38;

/** Installed into every document (page load and client-side navigation alike). */
export function installHand() {
	const ID = '__seeker_hand';
	const ensure = () => {
		const host = document.body || document.documentElement;
		if (!host) return null;
		let root = document.getElementById(ID);
		if (root && root.isConnected) return root;
		root = document.createElement('div');
		root.id = ID;
		root.setAttribute('aria-hidden', 'true');
		root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
		const ripple = document.createElement('div');
		ripple.style.cssText = 'position:absolute;border-radius:50%;border:2px solid rgba(255,255,255,0.8);'
			+ 'transform:translate(-50%,-50%);opacity:0;will-change:transform,opacity;';
		/* Translucent on purpose, and small: a touch indicator reports where the
		   finger is, it does not hide the control the finger is on. The contact
		   dot inside it is what the eye tracks between taps. */
		const tip = document.createElement('div');
		tip.style.cssText = 'position:absolute;width:38px;height:38px;border-radius:50%;opacity:0;'
			+ 'background:radial-gradient(circle at 40% 36%, rgba(255,255,255,0.34), rgba(255,255,255,0.17) 52%,'
			+ ' rgba(255,255,255,0.05) 74%, rgba(255,255,255,0) 78%);'
			+ 'box-shadow:0 0 0 1.25px rgba(255,255,255,0.3);will-change:transform,opacity;';
		const dot = document.createElement('div');
		dot.style.cssText = 'position:absolute;width:11px;height:11px;border-radius:50%;opacity:0;'
			+ 'background:rgba(255,255,255,0.92);box-shadow:0 0 10px rgba(255,255,255,0.55);'
			+ 'will-change:transform,opacity;';
		root.append(ripple, tip, dot);
		host.appendChild(root);
		return root;
	};

	window.__seekerHand = {
		ensure,
		set(s) {
			const root = ensure();
			if (!root) return;
			const [ripple, tip, dot] = root.children;
			for (const el of [tip, dot]) {
				el.style.left = `${s.x}px`;
				el.style.top = `${s.y}px`;
				el.style.transform = `translate(-50%,-50%) scale(${s.scale})`;
			}
			tip.style.opacity = String(s.opacity);
			dot.style.opacity = String(s.opacity * 0.9);
			ripple.style.left = `${s.x}px`;
			ripple.style.top = `${s.y}px`;
			ripple.style.width = `${s.rippleR * 2}px`;
			ripple.style.height = `${s.rippleR * 2}px`;
			ripple.style.opacity = String(s.rippleO);
		},
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure, { once: true });
	else ensure();
}

/* Deterministic jitter. A tour that lands on the exact pixel centre of every
   button twice in a row reads as a macro, and a tour seeded from Math.random
   cannot be re-recorded identically. Seeded noise gets both. */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeOutQuint = (x) => 1 - Math.pow(1 - x, 5);
const easeInQuad = (x) => x * x;

export class Hand {
	/**
	 * @param {import('playwright').Page} page
	 * @param {{ fps: number, shoot: () => Promise<void>, css: {width:number,height:number}, seed?: number, log?: (...a:any)=>void }} opts
	 */
	constructor(page, { fps, shoot, css, seed = 7, log = () => {} }) {
		this.page = page;
		this.fps = fps;
		this.shoot = shoot;
		this.css = css;
		this.log = log;
		this.rand = mulberry32(seed);
		this.state = { x: css.width / 2, y: css.height + 80, opacity: 0, scale: 1, rippleR: 0, rippleO: 0 };
		this.clock = 0;
		this.arcSign = 1;
	}

	frames(ms) { return Math.max(1, Math.round((ms / 1000) * this.fps)); }
	jitter(px) { return (this.rand() * 2 - 1) * px; }

	/** Re-install the indicator after a navigation and put it back where it was. */
	async ready() {
		await this.page.evaluate(installHand);
		await this.paint();
	}

	async paint() {
		await this.page.evaluate((s) => window.__seekerHand?.set(s), this.state);
	}

	/** One captured frame at the current state, with a breath of idle drift. */
	async frame({ drift = true } = {}) {
		this.clock += 1;
		if (drift && this.state.opacity > 0) {
			const t = this.clock / this.fps;
			this.state.x += Math.sin(t * 1.7) * 0.13;
			this.state.y += Math.cos(t * 1.3) * 0.11;
		}
		await this.paint();
		await this.shoot();
	}

	async hold(ms, opts) {
		for (let i = 0; i < this.frames(ms); i += 1) await this.frame(opts);
	}

	/**
	 * Travel to a point. Real thumbs do not move in straight lines or at a
	 * constant speed: the path bows, the hand accelerates away and decelerates
	 * into the target, then rings once before it settles.
	 */
	async moveTo(x, y, { ms } = {}) {
		const from = { x: this.state.x, y: this.state.y };
		const entering = this.state.opacity < 0.05;
		if (entering) {
			/* Coming back on screen: start from just below the bottom edge, the
			   way a thumb re-enters the frame on a phone. */
			from.x = x + this.jitter(30);
			from.y = this.css.height + 70;
			this.state.x = from.x;
			this.state.y = from.y;
		}
		const dist = Math.hypot(x - from.x, y - from.y);
		const dur = ms ?? Math.min(900, 210 + dist * 1.15);
		const total = this.frames(dur);
		/* Bow the path, alternating side to side so repeated trips down a list
		   do not trace the same line twice. */
		const bow = Math.min(46, dist * 0.14) * this.arcSign;
		this.arcSign *= -1;
		const mid = {
			x: (from.x + x) / 2 + (y - from.y) / (dist || 1) * bow,
			y: (from.y + y) / 2 - (x - from.x) / (dist || 1) * bow,
		};
		for (let i = 1; i <= total; i += 1) {
			const t = easeInOutCubic(i / total);
			const u = 1 - t;
			this.state.x = u * u * from.x + 2 * u * t * mid.x + t * t * x;
			this.state.y = u * u * from.y + 2 * u * t * mid.y + t * t * y;
			if (entering) this.state.opacity = Math.min(1, easeOutCubic(Math.min(1, (i / total) * 2.2)));
			await this.frame({ drift: false });
		}
		/* Damped settle, so the hand arrives instead of snapping. */
		if (dist > 60) {
			const dirX = (x - from.x) / (dist || 1);
			const dirY = (y - from.y) / (dist || 1);
			const settle = this.frames(160);
			for (let i = 1; i <= settle; i += 1) {
				const k = Math.sin((i / settle) * Math.PI * 1.5) * 2.6 * (1 - i / settle);
				this.state.x = x + dirX * k;
				this.state.y = y + dirY * k;
				await this.frame({ drift: false });
			}
		}
		this.state.x = x;
		this.state.y = y;
		this.state.opacity = 1;
	}

	/** Lift off the glass: used while typing, since the keyboard is the system's. */
	async lift({ ms = 260 } = {}) {
		if (this.state.opacity < 0.05) return;
		const total = this.frames(ms);
		const y0 = this.state.y;
		for (let i = 1; i <= total; i += 1) {
			const t = easeInQuad(i / total);
			this.state.opacity = 1 - t;
			this.state.y = y0 + t * 46;
			this.state.scale = 1 - t * 0.12;
			await this.frame({ drift: false });
		}
		this.state.opacity = 0;
		this.state.scale = 1;
	}

	/** Touch down, fire the real input, and let the contact ring bloom away. */
	async tapAt(x, y, { press = 90, bloom = 300, after = 260 } = {}) {
		const down = this.frames(press);
		for (let i = 1; i <= down; i += 1) {
			const t = i / down;
			this.state.scale = 1 - 0.2 * t;
			this.state.rippleR = 15 + 5 * t;
			this.state.rippleO = 0.55 * t;
			await this.frame({ drift: false });
		}
		await this.page.touchscreen.tap(x, y);
		const up = this.frames(bloom);
		for (let i = 1; i <= up; i += 1) {
			const t = easeOutQuint(i / up);
			this.state.scale = 0.8 + 0.2 * t;
			this.state.rippleR = 20 + 34 * t;
			this.state.rippleO = 0.55 * (1 - t);
			await this.frame({ drift: false });
		}
		this.state.scale = 1;
		this.state.rippleO = 0;
		this.state.rippleR = 0;
		if (after) await this.hold(after);
	}

	/** Where on an element a thumb would actually land: near the middle, not on it. */
	async pointOn(selector, { bring = true } = {}) {
		const locator = this.page.locator(selector).first();
		await locator.waitFor({ state: 'visible', timeout: 20_000 });
		if (bring) await this.bringIntoView(selector);
		const box = await locator.boundingBox();
		if (!box) throw new Error(`${selector} has no box to tap`);
		return {
			x: box.x + box.width / 2 + this.jitter(Math.min(box.width * 0.18, 22)),
			y: box.y + box.height / 2 + this.jitter(Math.min(box.height * 0.2, 9)),
		};
	}

	async tapOn(selector, { expect, expectTimeout = 30_000, hoverMs = 140, after = 320 } = {}) {
		const { x, y } = await this.pointOn(selector);
		await this.moveTo(x, y);
		await this.hold(hoverMs);
		await this.tapAt(x, y, { after });
		if (expect) await this.waitFor(expect, { timeout: expectTimeout });
	}

	/** Tap something only if this build of the page actually renders it. */
	async tapIfPresent(selector, opts = {}) {
		const n = await this.page.locator(selector).count();
		if (!n) return false;
		if (!(await this.page.locator(selector).first().isVisible())) return false;
		await this.tapOn(selector, opts);
		return true;
	}

	/**
	 * Type into a field: tap it, take the hand off the glass (the keyboard is a
	 * system surface this recording does not draw), then send real keystrokes at
	 * a human cadence, slowing at spaces and punctuation the way people do.
	 */
	async typeInto(selector, text, { cps = 11, settle = 500 } = {}) {
		await this.tapOn(selector, { after: 180 });
		await this.lift();
		const base = 1000 / cps;
		for (const ch of text) {
			await this.page.keyboard.type(ch);
			let ms = base * (0.72 + this.rand() * 0.7);
			if (ch === ' ') ms *= 1.35;
			if (',.!?'.includes(ch)) ms *= 2.1;
			await this.hold(ms, { drift: false });
		}
		await this.hold(settle, { drift: false });
	}

	/** Current scroll offset and the furthest the document can go. */
	async scrollState() {
		return this.page.evaluate(() => ({
			y: window.scrollY,
			max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
		}));
	}

	/**
	 * One thumb flick: the page tracks the finger while it is down, then carries
	 * on and decays after it lifts. Positive dy scrolls further down the page,
	 * which is a finger travelling up the glass.
	 */
	async flick(dy, { dragMs = 340, glideMs = 620 } = {}) {
		const { y: y0, max } = await this.scrollState();
		const target = Math.max(0, Math.min(max, y0 + dy));
		const delta = target - y0;
		if (Math.abs(delta) < 2) return target;

		const drag = delta * 0.55;
		const startY = delta > 0
			? this.css.height * (0.68 + this.rand() * 0.06)
			: this.css.height * (0.3 + this.rand() * 0.06);
		const startX = this.css.width * 0.5 + this.jitter(46);
		const endY = Math.max(90, Math.min(this.css.height - 60, startY - drag));

		await this.moveTo(startX, startY);
		const down = this.frames(70);
		for (let i = 1; i <= down; i += 1) {
			this.state.scale = 1 - 0.14 * (i / down);
			await this.frame({ drift: false });
		}

		const dragFrames = this.frames(dragMs);
		for (let i = 1; i <= dragFrames; i += 1) {
			const t = easeInOutCubic(i / dragFrames);
			this.state.x = startX + this.jitter(0.4);
			this.state.y = startY + (endY - startY) * t;
			await this.page.evaluate((py) => window.scrollTo(0, py), y0 + drag * t);
			await this.frame({ drift: false });
		}

		const glideFrames = this.frames(glideMs);
		const restStart = y0 + drag;
		for (let i = 1; i <= glideFrames; i += 1) {
			const t = i / glideFrames;
			await this.page.evaluate((py) => window.scrollTo(0, py), restStart + (target - restStart) * easeOutQuint(t));
			/* The hand leaves the glass as the page keeps going. */
			this.state.opacity = 1 - easeInQuad(Math.min(1, t * 1.6));
			this.state.y = endY + easeInQuad(t) * 34;
			this.state.scale = 0.86 + 0.14 * t;
			await this.frame({ drift: false });
		}
		this.state.opacity = 0;
		this.state.scale = 1;
		await this.page.evaluate((py) => window.scrollTo(0, py), target);
		return target;
	}

	/** A long distance is several flicks with a beat between them, not one glide. */
	async scrollBy(dy, { chunk = 520, betweenMs = 220 } = {}) {
		let left = dy;
		let guard = 0;
		while (Math.abs(left) > 8 && guard < 12) {
			const step = Math.sign(left) * Math.min(Math.abs(left), chunk);
			const before = (await this.scrollState()).y;
			const after = await this.flick(step);
			left -= after - before;
			if (Math.abs(after - before) < 2) break;
			guard += 1;
			if (Math.abs(left) > 8) await this.hold(betweenMs);
		}
	}

	/** Put an element in the comfortable middle band of the screen. */
	async bringIntoView(selector, { top = 150, bottom = 190 } = {}) {
		const box = await this.page.locator(selector).first().boundingBox();
		if (!box) return;
		const lo = top;
		const hi = this.css.height - bottom;
		if (box.y >= lo && box.y + box.height <= hi) return;
		const wanted = box.y + box.height / 2 - this.css.height * 0.44;
		await this.scrollBy(wanted);
	}

	/**
	 * Drag across an element, for the surfaces that answer a drag rather than a
	 * tap: the 3D viewers. Pointer events are the real ones, so the model turns
	 * because the page turned it.
	 */
	async dragAcross(selector, { dx = 200, dy = 0, ms = 900 } = {}) {
		await this.bringIntoView(selector);
		const box = await this.page.locator(selector).first().boundingBox();
		if (!box) throw new Error(`${selector} has no box to drag`);
		const x0 = box.x + box.width * 0.5 - dx / 2;
		const y0 = box.y + box.height * 0.55 - dy / 2;
		await this.moveTo(x0, y0);
		await this.page.mouse.move(x0, y0);
		await this.page.mouse.down();
		const down = this.frames(80);
		for (let i = 1; i <= down; i += 1) {
			this.state.scale = 1 - 0.16 * (i / down);
			await this.frame({ drift: false });
		}
		const total = this.frames(ms);
		for (let i = 1; i <= total; i += 1) {
			const t = easeInOutCubic(i / total);
			const px = x0 + dx * t;
			const py = y0 + dy * t;
			await this.page.mouse.move(px, py);
			this.state.x = px;
			this.state.y = py;
			await this.frame({ drift: false });
		}
		await this.page.mouse.up();
		const up = this.frames(180);
		for (let i = 1; i <= up; i += 1) {
			this.state.scale = 0.84 + 0.16 * (i / up);
			await this.frame({ drift: false });
		}
		this.state.scale = 1;
	}

	/**
	 * Wait on the real page while the recording keeps rolling, sampling one
	 * frame every `everyMs` of wall clock. A build that takes four minutes
	 * becomes a few seconds of honest time-lapse: the progress bar, the status
	 * line, and the elapsed clock are the page's own, at the page's own pace.
	 */
	async waitFor(condition, { timeout = 60_000, everyMs = 220, note = '' } = {}) {
		const started = Date.now();
		const done = typeof condition === 'function'
			? () => condition(this.page)
			: () => this.page.locator(condition).first().isVisible().catch(() => false);
		if (note) this.log(note);
		for (;;) {
			if (await done()) return Date.now() - started;
			if (Date.now() - started > timeout) {
				throw new Error(`timed out after ${Math.round((Date.now() - started) / 1000)}s waiting for ${note || condition}`);
			}
			await this.frame({ drift: this.state.opacity > 0 });
			const spent = Date.now() - started;
			const rest = everyMs - (spent % everyMs);
			if (rest > 5) await this.page.waitForTimeout(Math.min(rest, everyMs));
		}
	}
}
