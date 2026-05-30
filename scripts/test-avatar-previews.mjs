// Headless proof that the lobby avatar picker renders REAL model portraits, not
// emoji. Loads /play, waits for preset chips, then asserts at least one chip
// swapped its placeholder for a rendered <img.cc-avatar-render> data URL.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const errors = [];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`${BASE}/pages/play.html`, { waitUntil: 'load' });
// Dismiss the boot-loader overlay so the lobby (and its avatar chips) are the
// visible, interactable surface — otherwise the loader sits on top of them.
await page.waitForFunction(() => !!window.__CC__, { timeout: 15000 });
await page.evaluate(() => {
	document.getElementById('kx-loading')?.remove();
	document.getElementById('cc-loading')?.remove();
});
await page.waitForSelector('.cc-avatar-chip', { state: 'attached', timeout: 15000 });

// Wait until at least one chip finishes rendering its portrait (or all stop loading).
const rendered = await page.waitForFunction(() => {
	const chips = [...document.querySelectorAll('.cc-avatar-chip')];
	if (!chips.length) return false;
	const stillLoading = chips.some((c) => c.classList.contains('cc-avatar-loading'));
	const renders = document.querySelectorAll('img.cc-avatar-render').length;
	if (renders > 0) return { renders, total: chips.length };
	if (!stillLoading) return { renders: 0, total: chips.length };
	return false;
}, { timeout: 30000 }).then((h) => h.jsonValue());

const sample = await page.evaluate(() => {
	const img = document.querySelector('img.cc-avatar-render');
	return img ? { src: img.src.slice(0, 30), w: img.naturalWidth, h: img.naturalHeight } : null;
});

await browser.close();

console.log('chips:', rendered.total, 'rendered portraits:', rendered.renders);
console.log('sample:', JSON.stringify(sample));
const webglErrs = errors.filter((e) => !/favicon|colyseus|websocket|ws:|net::ERR/i.test(e));
if (webglErrs.length) { console.error('console errors:', webglErrs); process.exit(1); }
if (!rendered.renders) { console.error('FAIL: no rendered portraits — chips fell back to emoji/thumb'); process.exit(1); }
if (!sample || !sample.src.startsWith('data:image')) { console.error('FAIL: portrait is not a rendered data URL'); process.exit(1); }
console.log('PASS: avatar previews render the real model');
