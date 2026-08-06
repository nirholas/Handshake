#!/usr/bin/env node
// Prove, in a real browser, what /sign-mirror has to do on a machine with no
// hand in front of it: boot the course, draw the target skeleton, put the
// avatar on stage, select letters by click and by keyboard, honor the hand
// preference, and start the camera loop far enough to say "no hand in frame"
// when the fake device shows it an empty scene.
//
// Usage: node scripts/verify-sign-mirror.mjs [baseUrl]
//   defaults to http://localhost:3000 (npm run dev)

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
let failures = 0;

function check(label, ok, detail = '') {
	if (ok) console.log(`  ok    ${label}`);
	else {
		failures++;
		console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

// Software WebGL and /dev/shm off, same reasons as verify-sign-avatar.mjs.
// The fake media device gives getUserMedia a synthetic camera so the practice
// loop can be driven to its "no hand in frame" state without hardware.
const browser = await chromium.launch({
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--disable-dev-shm-usage',
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
	],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(60000);
page.setDefaultNavigationTimeout(60000);

const isDevNoise = (text) => /\[vite\]|WebSocket (connection|closed)/i.test(text);
const consoleErrors = [];
let phase = 'boot';
page.on('console', (m) => {
	if (m.type() === 'error' && !isDevNoise(m.text())) consoleErrors.push(`[${phase}] ${m.text()}`);
});
page.on('pageerror', (e) => {
	if (!isDevNoise(String(e))) consoleErrors.push(`[${phase}] ${String(e)}`);
});

console.log(`\nSign Mirror, ${BASE}/sign-mirror`);

phase = 'first load';
await page.goto(`${BASE}/sign-mirror`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });

// The course rail: five groups, the full 26-letter alphabet.
await page.waitForSelector('.sm-letter');
check('course rail renders all 26 letters', (await page.locator('.sm-letter').count()) === 26);
check('course rail has its five sections', (await page.locator('.sm-group').count()) === 5);

// The target diagram is drawn from the same handshape spec the avatar wears.
await page.waitForFunction(() => document.querySelectorAll('#sm-target line').length > 0);
const targetLines = await page.locator('#sm-target line').count();
check('target skeleton diagram is drawn', targetLines >= 20, `${targetLines} lines`);

// The avatar stage mounts (a canvas appears), or the page says why it cannot.
phase = 'stage mount';
const staged = await page
	.waitForSelector('#sm-stage canvas', { timeout: 60000 })
	.then(() => true)
	.catch(() => false);
const statusText = await page.locator('#sm-status').textContent();
check('avatar stage mounts or explains itself', staged || /diagram|scoring/i.test(statusText || ''), statusText || 'no status');

// Click selection: pick B, the card and the URL must follow.
phase = 'click selection';
await page.locator('.sm-letter[data-char="B"]').click();
await page.waitForFunction(() => document.querySelector('#sm-big')?.textContent === 'B');
check('clicking a letter updates the card', true);
check('clicking a letter deep-links it', new URL(page.url()).searchParams.get('letter') === 'B');
check(
	'selected letter is marked pressed',
	(await page.locator('.sm-letter[data-char="B"]').getAttribute('aria-pressed')) === 'true',
);

// Keyboard selection: pressing a letter key jumps to it.
phase = 'keyboard selection';
await page.keyboard.press('w');
await page.waitForFunction(() => document.querySelector('#sm-big')?.textContent === 'W');
check('pressing a letter key selects it', true);

// Shared-shape letters are explained, not failed: G names its twin Q.
phase = 'shared shape callout';
await page.locator('.sm-letter[data-char="G"]').click();
await page.waitForFunction(() => document.querySelector('#sm-big')?.textContent === 'G');
const sharedNote = await page.locator('#sm-shared').textContent();
check('shared-handshape letters explain their twin', /Q/.test(sharedNote || ''), sharedNote || 'empty');

// The hand preference redraws the target and persists.
phase = 'hand preference';
await page.locator('[data-hand="Left"]').click();
check(
	'left hand toggle presses in',
	(await page.locator('[data-hand="Left"]').getAttribute('aria-pressed')) === 'true',
);
const storedPrefs = await page.evaluate(() => localStorage.getItem('threews:sign-prefs') || '');
check('hand preference is stored for the other sign pages', /Left/.test(storedPrefs), storedPrefs);

// The camera loop: with the fake device there is a stream but never a hand,
// so the loop must reach its honest "no hand in frame" state. This exercises
// the MediaPipe landmarker load, the video pipeline, and the grading loop's
// empty branch end to end.
phase = 'camera loop';
await page.locator('#sm-camera').click();
const cameraRan = await page
	.waitForFunction(
		() => document.body.dataset.smCamera === 'on' && /no hand in frame/i.test(document.querySelector('#sm-hint')?.textContent || ''),
		{ timeout: 90000 },
	)
	.then(() => true)
	.catch(() => false);
if (cameraRan) {
	check('camera starts and reports no hand in frame', true);
	await page.locator('#sm-camera').click();
	check('camera stops cleanly', await page.evaluate(() => document.body.dataset.smCamera === 'off'));
} else {
	// No network to the model CDN (or no fake device): the page must have said
	// so in the status line rather than dying silently.
	const st = await page.locator('#sm-status').textContent();
	check('camera failure is explained to the user', /camera|tracker|diagram/i.test(st || ''), st || 'no status');
}

phase = 'teardown';
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

await browser.close();
if (failures) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log('\nAll sign-mirror checks passed.');
