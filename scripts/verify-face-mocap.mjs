// Headless smoke check for /demos/agents/face-mocap.html.
// Loads the page (without actually granting camera permission — getUserMedia
// will reject in headless without --use-fake-ui), waits a beat, and reports
// any page errors, console errors, or failed module/asset requests.
// Run with: node scripts/verify-face-mocap.mjs

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL  = `${BASE}/demos/agents/face-mocap.html`;

const browser = await chromium.launch({
	args: [
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
	],
});
const ctx  = await browser.newContext({
	permissions: ['camera'],
});
const page = await ctx.newPage();

const errors = [];
const failed = [];

page.on('pageerror',   (e)   => errors.push(`pageerror: ${e.message}`));
page.on('console',     (msg) => {
	if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});
page.on('requestfailed', (req) => {
	const u = req.url();
	// MediaPipe loads its WASM + model from CDN — skip those if blocked offline.
	if (/cdn\.jsdelivr|googleapis/.test(u)) return;
	failed.push(`${u} (${req.failure()?.errorText})`);
});
page.on('response', (resp) => {
	const s = resp.status();
	const u = resp.url();
	if (s >= 400 && !/cdn\.jsdelivr|googleapis/.test(u)) failed.push(`${u} → ${s}`);
});

console.log(`→ ${URL}`);
try {
	await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
	// Give the in-page modules a beat to import and the avatar GLB to fetch.
	await page.waitForTimeout(3500);
} catch (e) {
	console.log(`  ✖ navigation failed: ${e.message}`);
	await browser.close();
	process.exit(1);
}

// Inspect DOM presence of the key UI elements (proves the script ran).
const present = await page.evaluate(() => ({
	overlay:   !!document.getElementById('overlay'),
	camCard:   !!document.getElementById('cam-card'),
	diag:      !!document.getElementById('diag'),
	controls:  !!document.getElementById('controls'),
	enableBtn: !!document.getElementById('enable-btn'),
	canvas:    !!document.getElementById('avatar-canvas'),
	video:     !!document.getElementById('cam-video'),
	overlayCanvas: !!document.getElementById('cam-overlay'),
}));

let fail = 0;
console.log('\nDOM presence:');
for (const [k, v] of Object.entries(present)) {
	console.log(`  ${v ? '✓' : '✖'} ${k}`);
	if (!v) fail++;
}

if (errors.length) {
	console.log('\nErrors:');
	for (const e of errors) console.log(`  ✖ ${e}`);
	fail += errors.length;
} else {
	console.log('\nNo page or console errors.');
}

if (failed.length) {
	console.log('\nFailed requests:');
	for (const f of failed) console.log(`  ✖ ${f}`);
	fail += failed.length;
} else {
	console.log('No failed requests.');
}

await browser.close();
process.exit(fail > 0 ? 1 : 0);
