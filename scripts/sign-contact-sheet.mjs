#!/usr/bin/env node
/**
 * sign-contact-sheet.mjs: render the signing vocabulary (or the alphabet) as a
 * single reviewable image.
 *
 * The numeric tests in tests/sign-*.test.js prove a hand reaches the right point
 * and two hands actually meet. They cannot tell you whether a sign is LEGIBLE.
 * That is a judgement made by looking, and it is how the arm-behind-the-body bug
 * was caught in the first place. This drives a real browser through the real
 * retarget path and lays every sign out as one frame per cell, so a change to the
 * solver can be eyeballed across the whole vocabulary in one picture.
 *
 * Requires the dev server (`npm run dev`).
 *
 *   node scripts/sign-contact-sheet.mjs                        # whole vocabulary
 *   node scripts/sign-contact-sheet.mjs --letters              # the manual alphabet
 *   node scripts/sign-contact-sheet.mjs --words HAPPY,FALL     # a subset
 *   node scripts/sign-contact-sheet.mjs --sign FALL            # one sign over time
 *   node scripts/sign-contact-sheet.mjs --dominant Left        # left-handed signer
 *   node scripts/sign-contact-sheet.mjs --avatar /avatars/x.glb
 *   node scripts/sign-contact-sheet.mjs --out /tmp/sheet.png --cols 6
 *
 * Note: headless Chromium renders WebGL through SwiftShader. Avatars with many
 * morph targets animate far too slowly there to review this way; use a light rig.
 */

import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

if (has('help')) {
	console.log(import.meta.url && new URL(import.meta.url).pathname);
	console.log('see the header of this file for usage');
	process.exit(0);
}

const base = process.env.BASE_URL || 'http://localhost:3000';
const out = flag('out', '/tmp/sign-contact-sheet.png');
const query = new URLSearchParams();

if (has('letters')) {
	query.set('mode', 'letters');
	query.set('word', flag('word', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
} else if (flag('sign')) {
	query.set('mode', 'sign');
	query.set('word', flag('sign'));
	query.set('n', flag('frames', '8'));
} else if (flag('spell')) {
	query.set('mode', 'frames');
	query.set('word', flag('spell'));
	query.set('n', flag('frames', '12'));
} else {
	query.set('mode', 'vocab');
	if (flag('words')) query.set('words', flag('words'));
}
for (const name of ['cols', 'w', 'h', 'avatar', 'dominant']) {
	if (flag(name)) query.set(name, flag(name));
}

const url = `${base}/scripts/sign-contact-sheet.html?${query}`;
console.log(`rendering ${url}`);

const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
const problems = [];
page.on('console', (m) => {
	if (m.type() === 'error' && !/websocket|\[vite\]/i.test(m.text())) problems.push(m.text());
});
// The dev server's HMR socket cannot reach a headless page through a forwarded
// port; that failure says nothing about the render.
page.on('pageerror', (e) => {
	if (!/WebSocket/i.test(String(e))) problems.push(String(e));
});

let ok = true;
try {
	await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
	await page.waitForFunction(() => document.title === 'ready', null, { timeout: 120_000 });
	await page.waitForTimeout(300);
	const box = await (await page.$('canvas')).boundingBox();
	await page.screenshot({ path: out, clip: { x: 0, y: 0, width: box.width, height: box.height } });
	console.log(`wrote ${out} (${Math.round(box.width)}×${Math.round(box.height)})`);
} catch (err) {
	ok = false;
	console.error(`render failed: ${err.message}`);
	console.error(`is the dev server running? (npm run dev, or set BASE_URL)`);
}
if (problems.length) console.error(`page errors:\n  ${problems.join('\n  ')}`);
await browser.close();
process.exit(ok && !problems.length ? 0 : 1);
