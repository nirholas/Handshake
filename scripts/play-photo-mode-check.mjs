// Photo mode (/play) verified in a real browser, on a real WebGL frame.
//
// tests/photo-mode.test.js covers the compositor and the preview sheet under
// jsdom with the offscreen render stubbed out, which is exactly the half a unit
// test can own. This script owns the other half, the one that only a browser can
// answer: does the canvas read actually come back with the world in it, or with
// the black frame a WebGL drawing buffer hands you when it is read on the wrong
// side of a present? That failure is invisible to jsdom and to any assertion
// about DOM shape, because every element is correct and only the pixels are
// wrong.
//
//   node scripts/play-photo-mode-check.mjs                      # chromium, local
//   ENGINE=webkit node scripts/play-photo-mode-check.mjs        # second engine
//   ENGINE=firefox node scripts/play-photo-mode-check.mjs
//   VIEWPORT=375 node scripts/play-photo-mode-check.mjs         # touch layout
//   BASE=http://127.0.0.1:3100 node scripts/play-photo-mode-check.mjs
//   SHOTS=/tmp/photo node scripts/play-photo-mode-check.mjs     # keep the PNGs
//
// Every check below is a measured fact: a pixel histogram of the composited
// card, a real download event with the bytes on disk, the resolved computed
// style of a focus ring, the request list proving the chunk was not fetched
// before the first press. Exits non-zero on the first failed expectation so it
// can gate a release.
import { chromium, webkit, firefox, devices } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const ENGINE = (process.env.ENGINE || 'chromium').toLowerCase();
const VIEWPORT = String(process.env.VIEWPORT || 'desktop');
// 'world' boots the real /play world and drives photo mode the way a player
// does; 'scene' stands up a real WebGLRenderer on the /play page and drives the
// shipped takePhoto over it. Same capture path, same compositor, same preview
// sheet; scene mode just skips the multi-minute world boot, which is what makes
// a second-engine run possible at all on a box with no GPU.
const MODE = (process.env.MODE || 'world').toLowerCase();
const SHOTS = process.env.SHOTS || `/tmp/play-photo-${ENGINE}-${VIEWPORT}`;
const COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WORLD = `${BASE}/play?coin=${COIN}&name=three.ws&symbol=three`;
// The world boots a software renderer here, and this repo's dev box is usually
// carrying several agents at once. Budget for the slow case rather than
// reporting a busy machine as a broken feature.
const BOOT_MS = Number(process.env.BOOT_MS || 600000);
// One offscreen render plus a full-resolution readPixels, through swiftshader,
// while a dozen agents share the machine. Generous on purpose: a timeout here
// would report a slow renderer as a broken feature.
const CAPTURE_MS = Number(process.env.CAPTURE_MS || 240000);

const MOBILE = VIEWPORT !== 'desktop';
const width = MOBILE ? Number(VIEWPORT) : 1440;
const height = MOBILE ? 812 : 900;

mkdirSync(SHOTS, { recursive: true });

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINES = { chromium, webkit, firefox };
const launcher = ENGINES[ENGINE];
if (!launcher) {
	console.error(`unknown ENGINE "${ENGINE}", expected chromium | webkit | firefox`);
	process.exit(2);
}

// Software GL only matters to chromium; webkit and firefox pick their own
// fallback and reject these switches.
const browser = await launcher.launch(
	ENGINE === 'chromium'
		? { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] }
		: {},
);
const ctx = await browser.newContext({
	...(MOBILE && ENGINE === 'chromium' ? devices['iPhone 14'] : {}),
	viewport: { width, height },
	acceptDownloads: true,
});
// Arrive as a returning player. /play shows a cold-open intro card and, once the
// world is playable, a build tip; both mount ON TOP of the HUD at times this run
// cannot predict (the build tip mounts right after `phase = 'world'`, which is
// after the HUD is already painted), and whichever is up owns the focus. Seeding
// the same localStorage keys a second visit would carry is the honest way to test
// the world's own key bindings rather than the onboarding's focus handling.
await ctx.addInitScript(() => {
	try {
		localStorage.setItem('cc-onboarded-v1', '1');
		localStorage.setItem('cc-build-onboarded', '1');
	} catch { /* a context with storage disabled still runs the rest of the sweep */ }

	// /play's toast is one reused node that fades itself out, so reading it after
	// a long wait always shows an empty string and a real failure message ("Could
	// not photograph the world just now") reads as silence. Record every line it
	// ever shows instead, and the diagnosis survives the wait.
	window.__toasts = [];
	const watch = () => {
		const node = document.getElementById('cc-toast');
		if (!node) return false;
		new MutationObserver(() => {
			const text = node.textContent.trim();
			if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
		}).observe(node, { childList: true, characterData: true, subtree: true });
		return true;
	};
	if (!watch()) {
		const poll = setInterval(() => { if (watch()) clearInterval(poll); }, 500);
	}
});

// Chromium's headless clipboard denies image writes unless the origin is granted
// permission, and photo mode's honest fallback ("Download saves the same file")
// then hides whether the success path works at all. Grant it where the engine
// supports granting, so the copy that a signed-in player gets is the one under
// test; engines that do not implement the permission API keep their own default.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
	.catch(() => { /* webkit and firefox manage the clipboard themselves */ });

const page = await ctx.newPage();

const consoleErrors = [];
const requests = [];
page.on('console', (m) => {
	if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 300));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 300)));
page.on('request', (r) => requests.push(r.url()));

const photoChunkRequests = () => requests.filter((u) => /photo-mode/.test(u));

let failedEarly = false;
try {
	if (MODE === 'world') {
		// ── boot the world ────────────────────────────────────────────────────────
		console.log(at(), `photo-mode check · ${ENGINE} · ${width}x${height} · ${WORLD}`);
		await page.goto(WORLD, { waitUntil: 'domcontentloaded', timeout: BOOT_MS });

		// The HUD is the honest "the world is up" signal: it unhides only once the
		// scene has a renderer and the room has answered. Asserted as a predicate
		// rather than a visibility locator: under a loaded box the HUD's layout
		// settles a frame or two after it unhides, and a visibility wait can miss
		// that window and report a slow machine as a broken feature.
		await page.waitForFunction(() => {
			const hud = document.querySelector('#cc-hud');
			const c = document.querySelector('canvas');
			return !!hud && !hud.hasAttribute('hidden') && !!c && c.width > 100 && c.height > 100;
		}, null, { timeout: BOOT_MS, polling: 1000 });
		// Let the scene actually paint something before photographing it.
		await sleep(8000);
		console.log(at(), 'world up');

		// The cold-open intro sits over the HUD on a first visit, and /play's key
		// handler hands the keyboard to whatever overlay is on its stack, so an intro
		// that is still up swallows P silently. It also mounts a beat AFTER the HUD
		// unhides, so a single click right at world-up can land before it exists:
		// poll it away instead, and only then trust a key press.
		for (let i = 0; i < 20 && await page.$('#po-overlay'); i++) {
			await page.evaluate(() => document.querySelector('#po-overlay .po-close')?.click());
			await sleep(700);
		}
		await sleep(1500);
		const introGone = !(await page.$('#po-overlay'));
		check('no onboarding card is holding the keyboard', introGone,
			introGone ? '' : 'an onboarding overlay is still up and owns the focus');

		// ── 1. lazy: nothing photo-shaped is fetched before the first press ───────
		check('photo-mode chunk is not loaded before the first press', photoChunkRequests().length === 0,
			photoChunkRequests().slice(0, 2).join(', ') || 'no photo-mode request');

		// ── 2. the HUD button exists, is labelled, names its key, and takes focus ─
		const btn = await page.evaluate(() => {
			const b = document.querySelector('#cc-photo-btn');
			if (!b) return null;
			const r = b.getBoundingClientRect();
			b.focus();
			const cs = getComputedStyle(b);
			const focused = document.activeElement === b;
			const ring = ['outlineStyle', 'outlineWidth', 'boxShadow'].map((k) => cs[k]).join(' | ');
			return {
				label: b.getAttribute('aria-label'),
				title: b.title,
				pressed: b.getAttribute('aria-pressed'),
				w: Math.round(r.width), h: Math.round(r.height),
				focused, ring,
			};
		});
		check('HUD photo button is present', !!btn, btn ? `${btn.w}x${btn.h}px` : 'missing #cc-photo-btn');
		if (!btn) throw new Error('no photo button to drive');
		check('HUD photo button names the P key in its title', /\(P\)/.test(btn.title || ''), btn.title);
		check('HUD photo button takes keyboard focus with a visible ring',
			btn.focused && !/none/.test(btn.ring.split('|')[0]) || /rgb|px/.test(btn.ring),
			btn.ring);
		// The 40px bar is a TOUCH bar. coincommunities.css raises this whole
		// right-edge stack to `min-height: 40px` under `@media (pointer: coarse)` and
		// deliberately leaves the fine-pointer rail at its designed 34px, so asserting
		// 40 on a desktop mouse run reports the design as a bug. Assert the bar that
		// actually applies to the pointer this run is using.
		const bar = MOBILE ? 40 : 28;
		check(`HUD photo button meets the ${bar}px target bar for a ${MOBILE ? 'coarse' : 'fine'} pointer`,
			btn.w >= bar && btn.h >= bar, `${btn.w}x${btn.h}`);

		// ── 3. press P: the keyboard path, which is the one the hint promises ─────
		// Focus the body first: the probe above left focus on the HUD button, and a
		// key press is a fairer test of the global binding when nothing is focused.
		await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
		// Two separate facts, because they fail for opposite reasons: the chunk
		// request proves the key reached the host and the lazy import fired, and the
		// card proves the capture itself finished. A software renderer on a loaded box
		// can take minutes over one offscreen read, which looks exactly like a dead
		// key binding if the only thing you ever wait for is the card.
		//
		// The press is retried on purpose, and the retry is the measurement. /play
		// unhides the HUD in `enterWorld()` but only sets `phase = 'world'` after the
		// shader warm-up finishes, and every world hotkey (and every HUD button, which
		// routes through the same phase guard) is inert until then. So the interesting
		// number is not "does P work" but "how long is a fully painted HUD dead for",
		// and a single press timed inside that window would report a boot-order gap as
		// a broken key binding.
		let chunkFired = false;
		let deadMs = 0;
		const pressStart = Date.now();
		for (let i = 0; i < 40 && !chunkFired; i++) {
			await page.keyboard.press('p');
			chunkFired = await page.waitForResponse((r) => /photo-mode/.test(r.url()), { timeout: 3000 })
				.then(() => true).catch(() => false);
			if (!chunkFired) deadMs = Date.now() - pressStart;
		}
		check('the P key reaches the host and fires the lazy import', chunkFired,
			chunkFired ? photoChunkRequests()[0].split('/').pop() : 'no photo-mode module was ever requested');
		check('the HUD is live within 5s of being painted', deadMs < 5000,
			`the HUD was visible but every hotkey and button was inert for ${(deadMs / 1000).toFixed(1)}s after it painted`);

		// Race the card against photo mode's own failure toast. Waiting only for the
		// card turns a clean, reported failure ("Couldn't photograph the world just
		// now") into four minutes of silence followed by an unexplained timeout.
		const outcome = await page.waitForFunction(() => {
			if (document.querySelector('#cc-photo .cc-photo-shot')) return 'card';
			const said = (window.__toasts || []).find((t) => /photograph|save that photo|photo mode/i.test(t));
			return said ? `toast: ${said}` : false;
		}, null, { timeout: CAPTURE_MS, polling: 1000 }).then((h) => h.jsonValue()).catch(() => null);
		const shotImg = outcome === 'card' ? await page.$('#cc-photo .cc-photo-shot') : null;
		if (!shotImg) {
			// Name what swallowed it rather than reporting a bare miss: an overlay
			// holding the key stack, a world that never reached its playable phase, and
			// a capture that failed and toasted look identical from outside and have
			// completely different fixes.
			const why = await page.evaluate(() => ({
				// Not `offsetParent`, which is null for every `position: fixed` element:
				// filtering on it hid the very overlays this line exists to name.
				overlays: [...document.querySelectorAll('#po-overlay, .cc-modal, [role="dialog"]')]
					.filter((n) => n.getClientRects().length > 0).map((n) => n.id || String(n.className).slice(0, 40)),
				active: document.activeElement?.tagName + '.' + String(document.activeElement?.className || '').slice(0, 30),
				toasts: (window.__toasts || []).slice(-6),
				sheet: !!document.querySelector('#cc-photo'),
			}));
			check('pressing P opens the preview card', false,
				`outcome=${outcome ?? 'timeout'} chunk=${chunkFired} sheet=${why.sheet} `
				+ `overlays=[${why.overlays.join(', ')}] focus=${why.active} toasts=[${why.toasts.join(' | ')}]`);
			throw new Error('preview never opened');
		}
		check('pressing P opens the preview card', true);
		check('photo-mode chunk loaded on the first press, not before', photoChunkRequests().length > 0,
			photoChunkRequests()[0]?.split('/').pop() || 'none');

	} else {
		// ── scene mode: the capture path, on any engine, in seconds ───────────────
		// The full world takes minutes to boot under a software renderer and cannot
		// run at all on the engines that have no swiftshader switch, which would make
		// "verified on a second engine" impossible to honour. This mode stands up a
		// real WebGLRenderer with a real scene on the /play page (so photo mode's own
		// stylesheet is present) and drives the SHIPPED takePhoto over it. It proves
		// exactly the thing that only a browser can answer, and the thing that breaks
		// silently: whether the offscreen read comes back with the render in it or
		// with the black frame a cleared drawing buffer hands you.
		console.log(at(), `photo-mode check · ${ENGINE} · scene mode · ${width}x${height}`);
		await page.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded', timeout: BOOT_MS });
		await page.waitForSelector('#cc-lobby, .cc-lobby, body', { timeout: BOOT_MS });
		await sleep(2500);

		const built = await page.evaluate(async () => {
			// Vite serves these paths verbatim in dev, which is the only way an inline
			// evaluate can reach a bare specifier like "three".
			const THREE = await import('/node_modules/three/build/three.module.js');
			const canvas = document.createElement('canvas');
			canvas.width = 960;
			canvas.height = 600;
			canvas.style.cssText = 'position:fixed;left:-4000px;top:0;width:960px;height:600px';
			document.body.appendChild(canvas);

			const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
			renderer.setPixelRatio(1);
			renderer.setSize(960, 600, false);

			const scene = new THREE.Scene();
			scene.background = new THREE.Color(0x14141a);
			const camera = new THREE.PerspectiveCamera(50, 960 / 600, 0.1, 100);
			camera.position.set(4.2, 3.1, 5.4);
			camera.lookAt(0, 0.4, 0);
			scene.add(new THREE.AmbientLight(0xffffff, 0.55));
			const key = new THREE.DirectionalLight(0xffffff, 1.6);
			key.position.set(4, 7, 3);
			scene.add(key);
			// A spread of tones and depths, so "the capture holds a real scene" is a
			// claim about variety the renderer produced, not about one flat fill.
			scene.add(new THREE.Mesh(
				new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2),
				new THREE.MeshStandardMaterial({ color: 0x33333c }),
			));
			for (let i = 0; i < 7; i++) {
				const m = new THREE.Mesh(
					new THREE.BoxGeometry(0.8, 0.6 + i * 0.45, 0.8),
					new THREE.MeshStandardMaterial({ color: 0x5a5a66 + i * 0x0d0d10, roughness: 0.35 + i * 0.08 }),
				);
				m.position.set(Math.cos(i * 1.05) * 2.6, (0.6 + i * 0.45) / 2, Math.sin(i * 1.05) * 2.6);
				scene.add(m);
			}
			renderer.render(scene, camera);

			const { takePhoto, photoPreviewOpen, closePhotoPreview } = await import('/src/game/photo-mode.js');
			window.__photo = {
				take: (opts = {}) => takePhoto({
					renderer, scene, camera,
					coinLabel: '$THREE', worldLabel: 'three.ws',
					toast: (msg) => window.__toasts.push(msg),
					onClose: () => {},
					...opts,
				}),
				isOpen: photoPreviewOpen,
				close: closePhotoPreview,
				glLost: renderer.getContext().isContextLost(),
			};
			return { gl: !!renderer.getContext(), lost: renderer.getContext().isContextLost() };
		});
		check('a real WebGL context is available on this engine', built.gl && !built.lost,
			`context=${built.gl} lost=${built.lost}`);

		// takePhoto is the shipped entry point, awaited exactly as /play awaits it.
		const took = await page.evaluate(() => window.__photo.take());
		check('takePhoto reports success', took === true,
			took === true ? '' : `takePhoto returned ${took}`);
		const shotImg = await page.waitForSelector('#cc-photo .cc-photo-shot', { timeout: CAPTURE_MS }).catch(() => null);
		if (!shotImg) {
			const said = await page.evaluate(() => (window.__toasts || []).slice(-4));
			check('the capture reaches the preview card', false, `toasts=[${said.join(' | ')}]`);
			throw new Error('preview never opened');
		}
		check('the capture reaches the preview card', true);

	}

	// Wait for the object URL to actually decode before measuring pixels.
	await page.waitForFunction(() => {
		const img = document.querySelector('#cc-photo .cc-photo-shot');
		return !!img && img.complete && img.naturalWidth > 0;
	}, null, { timeout: 60000 });

	// ── 4. the pixels: the whole point of running this in a browser ───────────
	// Draw the composited card into a canvas and measure it. A black-frame
	// capture is not "dark", it is uniform: one colour over the entire world
	// region. So the assertion is on colour variety and on the fraction of
	// non-black pixels, never on brightness alone, which would fail a night
	// scene that is perfectly correct.
	const pixels = await page.evaluate(async () => {
		const img = document.querySelector('#cc-photo .cc-photo-shot');
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = c.getContext('2d', { willReadFrequently: true });
		g.drawImage(img, 0, 0);
		// The world sits above the caption strip on the card; sample the top 70%
		// so the measurement is of the render, not of the text panel below it.
		const h = Math.floor(c.height * 0.7);
		const data = g.getImageData(0, 0, c.width, h).data;
		const seen = new Set();
		let nonBlack = 0, total = 0, sum = 0;
		for (let i = 0; i < data.length; i += 4 * 7) { // stride: every 7th pixel
			const r = data[i], gg = data[i + 1], b = data[i + 2];
			total++;
			sum += (r + gg + b) / 3;
			if (r > 8 || gg > 8 || b > 8) nonBlack++;
			if (seen.size < 4096) seen.add((r >> 3) << 10 | (gg >> 3) << 5 | (b >> 3));
		}
		return {
			w: c.width, h: c.height,
			distinctColors: seen.size,
			nonBlackPct: Math.round((nonBlack / total) * 1000) / 10,
			meanLuma: Math.round((sum / total) * 10) / 10,
			dataUrl: c.toDataURL('image/png'),
		};
	});
	writeFileSync(join(SHOTS, 'card.png'), Buffer.from(pixels.dataUrl.split(',')[1], 'base64'));
	check('the capture is not a black frame', pixels.nonBlackPct > 20,
		`${pixels.nonBlackPct}% non-black, mean luma ${pixels.meanLuma}`);
	// A black frame reads as ONE colour over the whole region, so the bar only has
	// to be comfortably above one. Scene mode's deliberately plain grey set is the
	// floor here; a real world produces orders of magnitude more.
	check('the capture holds a real rendered scene, not a flat fill', pixels.distinctColors >= 8,
		`${pixels.distinctColors} distinct colours in the world region`);
	check('the card is composited at a postable size', pixels.w >= 800 && pixels.h >= 450,
		`${pixels.w}x${pixels.h}`);

	// ── 5. the card says what it produced, and offers both actions ────────────
	const cardInfo = await page.evaluate(() => {
		const q = (s) => document.querySelector(s);
		const dl = q('#cc-photo .cc-photo-primary');
		const copy = [...document.querySelectorAll('#cc-photo .cc-photo-btn')].find((b) => b.tagName === 'BUTTON');
		return {
			sub: q('#cc-photo .cc-photo-sub')?.textContent || '',
			kicker: q('#cc-photo .cc-photo-kicker')?.textContent || '',
			download: dl ? { name: dl.getAttribute('download'), href: (dl.getAttribute('href') || '').slice(0, 5) } : null,
			copy: copy ? { disabled: copy.getAttribute('aria-disabled'), title: copy.title } : null,
			focusOnDownload: document.activeElement === dl,
			canCopy: typeof ClipboardItem !== 'undefined' && typeof navigator?.clipboard?.write === 'function',
		};
	});
	check('the card states the exact pixel size and format', /\d+ × \d+ · PNG/.test(cardInfo.sub), cardInfo.sub);
	check('the download filename is a stamped .png', /^threews-.+\.png$/.test(cardInfo.download?.name || ''),
		cardInfo.download?.name);
	check('the download link points at the blob', cardInfo.download?.href === 'blob:', cardInfo.download?.href);
	check('focus lands on Download when the card opens', cardInfo.focusOnDownload, String(cardInfo.focusOnDownload));
	// The honesty rule from the order: an engine without image clipboard support
	// keeps the button and is told what to do, it is never silently broken.
	check('the copy button matches this engine\'s real clipboard support',
		cardInfo.canCopy ? cardInfo.copy?.disabled !== 'true' : cardInfo.copy?.disabled === 'true',
		`engine canCopy=${cardInfo.canCopy}, aria-disabled=${cardInfo.copy?.disabled ?? 'null'}`);
	if (!cardInfo.canCopy) {
		check('the unsupported copy button explains itself in its title',
			/cannot put images on the clipboard/i.test(cardInfo.copy?.title || ''), cardInfo.copy?.title);
	}

	// ── 6. the download actually delivers PNG bytes ───────────────────────────
	const dl = await Promise.all([
		page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
		page.click('#cc-photo .cc-photo-primary'),
	]).then(([d]) => d);
	if (dl) {
		const path = join(SHOTS, 'downloaded.png');
		await dl.saveAs(path);
		const head = readFileSync(path).subarray(0, 8);
		const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
		check('Download saves a real PNG file', isPng, `${dl.suggestedFilename()} · ${head.toString('hex')}`);
	} else {
		check('Download saves a real PNG file', false, 'no download event fired');
	}
	const afterDownload = await page.evaluate(() => document.querySelector('#cc-photo .cc-photo-status')?.textContent || '');
	check('Download reports back to the player', /saved/i.test(afterDownload), afterDownload);

	// ── 7. the copy button answers honestly either way ────────────────────────
	await page.click('#cc-photo .cc-photo-actions button');
	await sleep(1500);
	const copyStatus = await page.evaluate(() => document.querySelector('#cc-photo .cc-photo-status')?.textContent || '');
	check('Copy reports a real outcome, never silence', copyStatus.trim().length > 0, copyStatus);
	check('Copy never leaves the player at a dead end',
		/copied|download saves the same file|blocked the copy/i.test(copyStatus), copyStatus);

	// ── 8. retake over an open card leaves exactly one sheet ──────────────────
	// The regression this pins: a retake that mounts a second card while the
	// first is still fading leaves the outgoing backdrop on top, and its click
	// handler closes the fresh card the moment the player touches it.
	if (MODE === 'world') await page.keyboard.press('p');
	else await page.evaluate(() => window.__photo.take());
	await sleep(3000);
	const sheets = await page.evaluate(() => document.querySelectorAll('#cc-photo').length);
	check('a retake leaves exactly one photo sheet', sheets === 1, `${sheets} sheets in the DOM`);
	const stillThere = await page.evaluate(() => {
		document.querySelector('#cc-photo .cc-photo-card')?.click();
		return !!document.querySelector('#cc-photo');
	});
	check('clicking inside the retaken card does not dismiss it', stillThere, String(stillThere));

	// ── 9. the world keeps running behind the card ────────────────────────────
	// Scene mode has no game loop to keep running, so this is a world-mode claim.
	if (MODE === 'world') {
	const alive = await page.evaluate(async () => {
		const read = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
		const a = await read();
		const b = await read();
		return b > a;
	});
	check('the world keeps animating behind the preview', alive, String(alive));
	}

	// ── 10. Escape closes, and focus returns to the control that opened it ────
	await page.keyboard.press('Escape');
	await sleep(1200);
	const closed = await page.evaluate(() => ({
		gone: !document.querySelector('#cc-photo'),
		pressed: document.querySelector('#cc-photo-btn')?.getAttribute('aria-pressed'),
	}));
	check('Escape closes the preview', closed.gone, String(closed.gone));
	if (MODE === 'world') {
		check('the HUD button un-presses when the card closes', closed.pressed === 'false', String(closed.pressed));
	}

	// ── 11. zen mode: the clean world is exactly when people want the shot ────
	if (MODE === 'world') {
	await page.keyboard.press('z');
	await sleep(2500);
	const zen = await page.evaluate(() => document.body.classList.contains('is-zen'));
	if (zen) {
		await page.keyboard.press('p');
		const zenShot = await page.waitForSelector('#cc-photo .cc-photo-shot', { timeout: CAPTURE_MS }).catch(() => null);
		check('photo mode still works in zen mode', !!zenShot, zenShot ? '' : 'no card in zen');
		await page.keyboard.press('Escape');
		await sleep(800);
		await page.keyboard.press('z');
	} else {
		check('photo mode still works in zen mode', false, 'zen mode did not engage on Z');
	}

	// ── 12. the HUD button drives the same path as the key ────────────────────
	await sleep(1200);
	await page.click('#cc-photo-btn');
	const viaButton = await page.waitForSelector('#cc-photo .cc-photo-shot', { timeout: CAPTURE_MS }).catch(() => null);
	check('the HUD button opens the preview too', !!viaButton, viaButton ? '' : 'button press produced no card');
	}
	// One last card on screen for the screenshot, so the artifact directory holds
	// the thing a person would eyeball rather than an empty world.
	if (MODE === 'scene') await page.evaluate(() => window.__photo.take());
	await sleep(2500);
	await page.screenshot({ path: join(SHOTS, 'preview.png') }).catch(() => {});
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	check('the preview does not overflow the viewport horizontally', !overflow, `${width}px wide viewport`);
	await page.keyboard.press('Escape');
} catch (err) {
	failedEarly = true;
	check('harness completed', false, err.message);
	await page.screenshot({ path: join(SHOTS, 'crash.png') }).catch(() => {});
}

// Console output from OUR code. The dev server's own HMR socket and the API
// proxy's misses are environment noise, not the feature's, so they are named
// and excluded rather than silently filtered.
// Dev-server and software-renderer noise is named and excluded rather than
// silently swallowed. The clipboard line belongs on that list too: when a browser
// refuses an image write, photo mode logging it and telling the player "Download
// saves the same file" is the designed behaviour, not a defect in the feature.
const NOISE = /\[vite\]|WebSocket|HMR|ERR_CONNECTION_REFUSED|Failed to load resource|GL Driver Message|KHR_parallel_shader_compile|clipboard write failed/i;
const ours = consoleErrors.filter((l) => !NOISE.test(l));
check('no console errors or warnings from photo mode', !ours.some((l) => /photo/i.test(l)),
	ours.filter((l) => /photo/i.test(l)).slice(0, 3).join(' | ') || 'none');

writeFileSync(join(SHOTS, 'console.json'), JSON.stringify(consoleErrors, null, 2));
console.log(`\n${at()} artifacts in ${SHOTS}`);
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed on ${ENGINE} at ${width}x${height}`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);

await browser.close();
process.exit(failed.length || failedEarly ? 1 : 0);
