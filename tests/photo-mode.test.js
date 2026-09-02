// @vitest-environment jsdom
//
// Photo mode (/play) — the share card people post. Exercises the whole press:
// the offscreen shot is stubbed (jsdom has no WebGL), everything downstream of
// it is the real module, so the compositor's geometry and the preview sheet are
// covered without standing up a browser.
//
// The regression that earned this file: the module's local `el()` helper had
// drifted from the canonical one in coincommunities-ui.js and lost both plain
// string children and `html:`. `appendChild('✕')` throws a TypeError in every
// browser, takePhoto swallowed it, and photo mode answered every single press
// with "Couldn't photograph the world just now" and no card at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

globalThis.self = globalThis;

// The offscreen render. Returns a canvas-shaped stub at the size asked for.
const shot = { canvas: null, width: 1600, height: 900 };
const captureSceneCanvas = vi.fn(() => (shot.width ? { ...shot, canvas: fakeShotCanvas() } : null));
vi.mock('../src/game/scene-capture.js', () => ({ captureSceneCanvas: (...a) => captureSceneCanvas(...a) }));

function fakeShotCanvas() {
	const c = document.createElement('canvas');
	c.width = shot.width;
	c.height = shot.height;
	return c;
}

// A 2D context that records nothing but answers every call composeCard makes.
// measureText is proportional to the string so fitText's ellipsis loop is
// really exercised rather than short-circuited by a constant width.
function stubContext() {
	return {
		fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: '', textAlign: 'left',
		fillRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {},
		beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, arc() {}, fill() {}, stroke() {},
		measureText: (t) => ({ width: String(t).length * 8 }),
		fillText() {},
	};
}

let blobs = [];
let lastEvent = null;

beforeEach(() => {
	vi.resetModules();
	captureSceneCanvas.mockClear();
	blobs = [];
	shot.width = 1600; shot.height = 900;
	lastEvent = null;

	HTMLCanvasElement.prototype.getContext = function getContext() { return stubContext(); };
	HTMLCanvasElement.prototype.toBlob = function toBlob(cb) {
		const blob = new Blob(['png'], { type: 'image/png' });
		blobs.push({ blob, width: this.width, height: this.height });
		cb(blob);
	};
	globalThis.URL.createObjectURL = vi.fn(() => 'blob:photo');
	globalThis.URL.revokeObjectURL = vi.fn();
	globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => lastEvent }));
	globalThis.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
	document.body.innerHTML = '';
	delete globalThis.ClipboardItem;
});

const ctxArgs = (over = {}) => ({
	renderer: {}, scene: {}, camera: {},
	coinLabel: '$THREE', worldLabel: 'three.ws', ...over,
});

async function press(over = {}) {
	const mod = await import('../src/game/photo-mode.js');
	const ok = await mod.takePhoto(ctxArgs(over));
	return { mod, ok };
}

describe('photo mode preview', () => {
	it('mounts a card with a preview image and both actions', async () => {
		const { mod, ok } = await press();
		expect(ok).toBe(true);
		expect(mod.photoPreviewOpen()).toBe(true);

		const root = document.getElementById('cc-photo');
		expect(root).toBeTruthy();
		expect(root.querySelector('.cc-photo-shot')?.getAttribute('src')).toBe('blob:photo');
		expect(root.querySelector('.cc-photo-close')).toBeTruthy();

		const dl = root.querySelector('a.cc-photo-primary');
		expect(dl.textContent).toContain('Download');
		expect(dl.getAttribute('download')).toMatch(/^threews-three-\d{4}-\d{2}-\d{2}_\d{6}\.png$/);
	});

	// The exact shape of the crash: a string child and an `html:` prop.
	it('renders the close glyph and the hint as real text, not attributes', async () => {
		await press();
		const root = document.getElementById('cc-photo');
		expect(root.querySelector('.cc-photo-close').textContent).toBe('✕');

		const hint = root.querySelector('.cc-photo-hint');
		expect(hint.hasAttribute('html')).toBe(false);
		expect(hint.textContent).toContain('takes another');
		expect(hint.querySelector('kbd')?.textContent).toBe('P');
	});

	it('closes on Escape, releases the object URL, and tells the host', async () => {
		const onClose = vi.fn();
		const { mod } = await press({ onClose });
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		// The host is told at once so the HUD button unlights with the keypress;
		// the node and its object URL go when the exit transition has run.
		expect(mod.photoPreviewOpen()).toBe(false);
		expect(onClose).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => {
			expect(document.getElementById('cc-photo')).toBeNull();
			expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
		});
	});

	// The hint promises P retakes, so the card must not swallow it: /play's own
	// window handler is what routes the key back into takePhoto.
	it('swallows stray keys but lets P through to the host', async () => {
		await press();
		const card = document.querySelector('.cc-photo-card');
		const seen = [];
		window.addEventListener('keydown', (e) => seen.push(e.key));

		card.querySelector('a.cc-photo-primary').dispatchEvent(
			new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		card.querySelector('a.cc-photo-primary').dispatchEvent(
			new KeyboardEvent('keydown', { key: 'p', bubbles: true }));

		expect(seen).toEqual(['p']);
	});

	it('a second press retakes over the open card instead of stacking a second one', async () => {
		const mod = await import('../src/game/photo-mode.js');
		await mod.takePhoto(ctxArgs());
		await mod.takePhoto(ctxArgs());
		expect(document.querySelectorAll('#cc-photo').length).toBe(1);
		expect(captureSceneCanvas).toHaveBeenCalledTimes(2);
	});

	it('reports a failed capture to the player instead of a blank card', async () => {
		shot.width = 0;
		const toast = vi.fn();
		const { ok } = await press({ toast });
		expect(ok).toBe(false);
		expect(document.getElementById('cc-photo')).toBeNull();
		expect(toast).toHaveBeenCalledWith(expect.stringContaining('Couldn’t photograph'), 'warn');
	});
});

describe('clipboard support', () => {
	it('copies a PNG where the browser allows it', async () => {
		const write = vi.fn(async () => {});
		globalThis.ClipboardItem = class { constructor(items) { this.items = items; } };
		Object.defineProperty(globalThis.navigator, 'clipboard', { value: { write }, configurable: true });

		await press();
		const copy = [...document.querySelectorAll('.cc-photo-btn')].find((b) => b.tagName === 'BUTTON');
		expect(copy.getAttribute('aria-disabled')).toBeNull();
		copy.click();
		await vi.waitFor(() => expect(write).toHaveBeenCalled());
		expect(Object.keys(write.mock.calls[0][0][0].items)).toEqual(['image/png']);
		await vi.waitFor(() =>
			expect(document.querySelector('.cc-photo-status').textContent).toContain('Copied'));
	});

	it('stays honest, not broken, where the clipboard cannot take an image', async () => {
		Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true });
		await press();
		const copy = [...document.querySelectorAll('.cc-photo-btn')].find((b) => b.tagName === 'BUTTON');
		expect(copy.getAttribute('aria-disabled')).toBe('true');
		expect(copy.getAttribute('title')).toContain('Download saves the same file');
		copy.click();
		expect(document.querySelector('.cc-photo-status').textContent).toContain('Download saves the same file');
		expect(document.querySelector('.cc-photo-status').getAttribute('data-kind')).toBe('warn');
	});
});

describe('the composited card', () => {
	it('adds a signature bar under a landscape shot', async () => {
		await press();
		const { width, height } = blobs.at(-1);
		expect(width).toBe(1600);
		// 900 * 0.078 = 70.2, inside the 54..148 clamp.
		expect(height).toBe(900 + 70);
	});

	it('clamps the bar on a tall portrait shot instead of letting it grow', async () => {
		shot.width = 1170; shot.height = 2532;
		await press();
		const { width, height } = blobs.at(-1);
		expect(width).toBe(1170);
		// 2532 * 0.078 = 197.5, clamped to the 148 ceiling.
		expect(height).toBe(2532 + 148);
	});

	it('keeps the bar legible on a tiny shot', async () => {
		shot.width = 320; shot.height = 180;
		await press();
		expect(blobs.at(-1).height).toBe(180 + 54);
	});

	it('stamps the card and the kicker while an event is live', async () => {
		const now = Date.now();
		lastEvent = {
			id: 'community-day',
			name: '$THREE Community Day 2026',
			startsAt: new Date(now - 60000).toISOString(),
			endsAt: new Date(now + 3600000).toISOString(),
		};
		await press();
		expect(document.querySelector('.cc-photo-kicker').textContent).toBe('Event photo');
		expect(document.querySelector('.cc-photo-h').textContent).toBe('$THREE Community Day 2026');
	});

	it('says nothing about an event when none is scheduled', async () => {
		lastEvent = { id: null, name: null, startsAt: null, endsAt: null };
		await press();
		expect(document.querySelector('.cc-photo-kicker').textContent).toBe('Photo ready');
		expect(document.querySelector('.cc-photo-h').textContent).toBe('Your shot of the world');
	});
});
