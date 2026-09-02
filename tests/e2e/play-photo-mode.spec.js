// Photo mode (/play) measured in real browser engines.
//
// The failure this pins is the one a unit test cannot see: a WebGL screenshot
// that comes back as a black rectangle. `canvas.toDataURL()` on a context
// created without `preserveDrawingBuffer` returns black on every engine, so
// /play renders one frame into an offscreen target instead
// (src/game/scene-capture.js) and reads that back. Whether that actually
// produces pixels is a property of the GPU driver and the engine, not of our
// JavaScript, so it is measured here against real Chromium and real WebKit
// rather than asserted in jsdom.
//
// Everything from the press down is the shipped module: the real offscreen
// capture, the real compositor, the real preview sheet. Only the world is
// synthetic (one lit box on a known clear colour) so the pixels have an
// expected value to check against.

import { test, expect, chromium, webkit } from '@playwright/test';
import { serveHarness, collectPageErrors } from './_support.js';

const HARNESS = '**/e2e/photo-mode';
const URL = 'http://localhost:3000/e2e/photo-mode';

// The synthetic world's clear colour, distinctive enough that finding it in the
// PNG proves the shot is the scene and not an empty buffer. Set from a hex
// literal on purpose: three.js reads a hex as sRGB, so the value below is
// exactly what a correct capture must write back, which also pins the render
// target's colour-space handling (a target left in linear space comes back
// visibly washed out).
const CLEAR = { r: 18, g: 92, b: 176 };
const CLEAR_HEX = 0x125cb0;

// Vite re-bundles the moment it first sees a new dependency and drops the
// module requests that were in flight while it does, which surfaces as "Failed
// to fetch dynamically imported module" on a cold dev server. Retry rather than
// report a build-server restart as a product failure. Three.js is a large cold
// transform and WebKit is the slowest to get through it, hence the patience.
const RETRYING_IMPORT = `window.__imp = async (path) => {
	let last;
	for (let i = 0; i < 8; i++) {
		// A retry must ask for a NEW specifier, not the same one: JSC caches the
		// failed module record, so re-importing the identical path in WebKit
		// replays the original failure forever no matter how long you wait. Vite
		// serves the query-suffixed path as the same module, freshly transformed.
		const spec = i === 0 ? path : path + (path.includes('?') ? '&' : '?') + 'e2eRetry=' + i;
		try { return await import(spec); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200)); }
	}
	throw last;
};`;

// Build a real WebGL world, press the shutter through the real module, and
// report what landed: the preview chrome, and the decoded pixels of the PNG the
// player would download.
async function shoot(page, { width, height }) {
	return page.evaluate(async ({ w, h, clearHex }) => {
		const THREE = await window.__imp('/node_modules/three/build/three.module.js');
		const { takePhoto, photoPreviewOpen, closePhotoPreview } = await window.__imp('/src/game/photo-mode.js');

		const canvas = document.createElement('canvas');
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';
		document.body.appendChild(canvas);

		const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
		renderer.setPixelRatio(1);
		renderer.setSize(w, h, false);
		renderer.setClearColor(clearHex, 1);

		const scene = new THREE.Scene();
		scene.add(new THREE.AmbientLight(0xffffff, 2));
		const box = new THREE.Mesh(
			new THREE.BoxGeometry(1.4, 1.4, 1.4),
			new THREE.MeshBasicMaterial({ color: 0xffffff }),
		);
		scene.add(box);
		const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
		camera.position.set(0, 0, 4);
		camera.lookAt(0, 0, 0);
		renderer.render(scene, camera);

		const toasts = [];
		const shown = await takePhoto({
			renderer, scene, camera,
			coinLabel: '$THREE', worldLabel: 'three.ws',
			toast: (msg, kind) => toasts.push({ msg, kind }),
		});

		const root = document.getElementById('cc-photo');
		const img = root?.querySelector('.cc-photo-shot');
		const dl = root?.querySelector('a.cc-photo-primary');

		// Decode the PNG the player would download and sample it, so a black
		// frame cannot pass as a photo.
		const blob = await fetch(img.src).then((r) => r.blob());
		const bmp = await createImageBitmap(blob);
		const read = document.createElement('canvas');
		read.width = bmp.width; read.height = bmp.height;
		const ctx = read.getContext('2d');
		ctx.drawImage(bmp, 0, 0);
		const px = (x, y) => {
			const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
			return { r: d[0], g: d[1], b: d[2], a: d[3] };
		};
		// The whole frame, coarsely: how many samples are not near-black.
		let lit = 0, total = 0;
		for (let y = 4; y < bmp.height; y += 17) {
			for (let x = 4; x < bmp.width; x += 17) {
				const p = px(x, y);
				total++;
				if (p.r + p.g + p.b > 30) lit++;
			}
		}

		const result = {
			shown,
			previewOpen: photoPreviewOpen(),
			toasts,
			mime: blob.type,
			bytes: blob.size,
			png: { w: bmp.width, h: bmp.height },
			// A corner of the world, well inside the frame, and the middle of the
			// signature bar underneath it.
			corner: px(6, 6),
			centre: px(bmp.width / 2, bmp.height * 0.4),
			bar: px(bmp.width / 2, bmp.height - 8),
			litRatio: lit / total,
			download: dl?.getAttribute('download') || '',
			downloadText: dl?.textContent || '',
			closeGlyph: root?.querySelector('.cc-photo-close')?.textContent || '',
			hint: root?.querySelector('.cc-photo-hint')?.textContent || '',
			hintKbd: root?.querySelector('.cc-photo-hint kbd')?.textContent || '',
			hintIsAttribute: root?.querySelector('.cc-photo-hint')?.hasAttribute('html') ?? null,
			sub: root?.querySelector('.cc-photo-sub')?.textContent || '',
			kicker: root?.querySelector('.cc-photo-kicker')?.textContent || '',
			copyDisabled: root?.querySelector('button.cc-photo-btn')?.getAttribute('aria-disabled'),
			copyTitle: root?.querySelector('button.cc-photo-btn')?.getAttribute('title') || '',
			focused: document.activeElement?.className || '',
		};
		closePhotoPreview();
		renderer.dispose();
		canvas.remove();
		return result;
	}, { w: width, h: height, clearHex: CLEAR_HEX });
}

function near(actual, expected, tolerance = 26) {
	return Math.abs(actual.r - expected.r) <= tolerance
		&& Math.abs(actual.g - expected.g) <= tolerance
		&& Math.abs(actual.b - expected.b) <= tolerance;
}

// Chromium and WebKit are different GL stacks (ANGLE/SwiftShader vs the WebKit
// GTK port), which is exactly why the shot is verified on both.
const ENGINES = [
	{ name: 'chromium', type: chromium },
	{ name: 'webkit', type: webkit },
];

for (const engine of ENGINES) {
	test.describe(`photo mode in ${engine.name}`, () => {
		let browser, page, errors;

		test.beforeAll(async () => {
			browser = await engine.type.launch();
			// Pay the cold Vite transform of the three.js graph once, outside the
			// tests, so the first assertion is not racing the build server.
			const warm = await browser.newPage({ baseURL: 'http://localhost:3000' });
			await serveHarness(warm, HARNESS, { title: 'warm-up' });
			await warm.addInitScript(RETRYING_IMPORT);
			await warm.goto(URL);
			await warm.evaluate(async () => {
				await window.__imp('/node_modules/three/build/three.module.js');
				await window.__imp('/src/game/photo-mode.js');
			});
			await warm.close();
		});
		test.afterAll(async () => { await browser?.close(); });

		test.beforeEach(async () => {
			page = await browser.newPage({ baseURL: 'http://localhost:3000' });
			errors = collectPageErrors(page);
			await serveHarness(page, HARNESS, { title: 'photo mode harness' });
			await page.addInitScript(RETRYING_IMPORT);
			await page.goto(URL);
		});
		test.afterEach(async () => { await page?.close(); });

		test('a landscape press produces a signed PNG of the world, not a black frame', async () => {
			const r = await shoot(page, { width: 960, height: 540 });

			expect(r.shown).toBe(true);
			expect(r.previewOpen).toBe(true);
			expect(r.toasts).toEqual([]);
			expect(r.mime).toBe('image/png');
			expect(r.bytes).toBeGreaterThan(1000);

			// The card is the shot plus a signature bar, never the shot alone.
			expect(r.png.w).toBe(960);
			expect(r.png.h).toBeGreaterThan(540);
			expect(r.png.h - 540).toBeGreaterThanOrEqual(54);
			expect(r.png.h - 540).toBeLessThanOrEqual(148);

			// The black-frame bug, measured three ways.
			expect(near(r.corner, CLEAR)).toBe(true);
			expect(r.centre.r + r.centre.g + r.centre.b).toBeGreaterThan(600); // the white box
			expect(r.litRatio).toBeGreaterThan(0.6);
			// Fully opaque: a transparent PNG is not a photo anyone posts.
			expect(r.corner.a).toBe(255);
			// The bar is the card's ink, so it is dark where the world is not.
			expect(r.bar.r + r.bar.g + r.bar.b).toBeLessThan(60);

			expect(r.download).toMatch(/^threews-three-\d{4}-\d{2}-\d{2}_\d{6}\.png$/);
			expect(r.downloadText).toContain('Download');
			expect(r.sub).toContain('×');
			expect(errors).toEqual([]);
		});

		test('the preview chrome renders as text, and focus lands on Download', async () => {
			const r = await shoot(page, { width: 800, height: 600 });
			// The el() regression: a string child threw, and `html:` became an
			// attribute, so the sheet never mounted and the hint was invisible.
			expect(r.closeGlyph).toBe('✕');
			expect(r.hintIsAttribute).toBe(false);
			expect(r.hint).toContain('takes another');
			expect(r.hintKbd).toBe('P');
			expect(r.kicker).toBe('Photo ready');
			expect(r.focused).toContain('cc-photo-primary');
			expect(errors).toEqual([]);
		});

		test('a portrait phone frame gets the same card, clamped', async () => {
			const r = await shoot(page, { width: 390, height: 780 });
			expect(r.png.w).toBe(390);
			// 780 * 0.078 = 60.8, inside the clamp.
			expect(r.png.h).toBe(780 + 61);
			expect(near(r.corner, CLEAR)).toBe(true);
			expect(r.litRatio).toBeGreaterThan(0.6);
			expect(errors).toEqual([]);
		});

		test('the copy button tells the truth about this engine', async () => {
			const r = await shoot(page, { width: 640, height: 360 });
			const supported = await page.evaluate(
				() => typeof ClipboardItem !== 'undefined' && typeof navigator?.clipboard?.write === 'function');
			if (supported) {
				expect(r.copyDisabled).toBeNull();
				expect(r.copyTitle).toContain('Copy the image');
			} else {
				expect(r.copyDisabled).toBe('true');
				expect(r.copyTitle).toContain('Download saves the same file');
			}
			expect(errors).toEqual([]);
		});
	});
}
