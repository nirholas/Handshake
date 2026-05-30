// Headless probe: load /play, capture console errors + whether the lobby preset
// chips render a real model portrait or fall back to emoji/capsule.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:3030';
const logs = [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => logs.push(`reqfail: ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(`${BASE}/pages/play.html`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.waitForFunction(() => !!window.__CC__, { timeout: 20000 }).catch(() => logs.push('NO __CC__'));
await page.evaluate(() => { document.getElementById('kx-loading')?.remove(); document.getElementById('cc-loading')?.remove(); }).catch(() => {});

await page.waitForSelector('.cc-avatar-chip', { state: 'attached', timeout: 20000 }).catch(() => logs.push('NO chips'));
await page.waitForTimeout(9000);

const chipState = await page.evaluate(() => {
	const chips = [...document.querySelectorAll('.cc-avatar-chip')];
	return {
		total: chips.length,
		stillLoading: chips.filter((c) => c.classList.contains('cc-avatar-loading')).length,
		rendered: document.querySelectorAll('img.cc-avatar-render').length,
		emoji: document.querySelectorAll('.cc-avatar-chip .cc-avatar-glyph').length,
		thumbImg: document.querySelectorAll('.cc-avatar-chip img:not(.cc-avatar-render)').length,
	};
});

await browser.close();
console.log('chipState:', JSON.stringify(chipState));
console.log('--- console/network logs ---');
console.log(logs.join('\n'));
