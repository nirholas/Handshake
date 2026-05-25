import { chromium } from 'playwright';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 400)));
page.on('console', (m) => {
	const t = m.type();
	if (t === 'error') console.log('[err]', m.text().slice(0, 300));
});

const url = process.argv[2] || 'http://localhost:3001/app';

// Set Next layout BEFORE the page loads so dock chrome paints right away.
await page.addInitScript(() => {
	try { localStorage.setItem('3dagent:viewer-layout', 'next'); } catch {}
});

console.log('→', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for the viewer + animations.
await page.waitForFunction(
	() =>
		window.VIEWER?.viewer?.content &&
		window.VIEWER?.viewer?.animationManager?.getAnimationDefs?.()?.length > 0,
	{ timeout: 25000 },
);

await page.evaluate(async () => {
	const v = window.VIEWER.viewer;
	v.state.autoRotate = false;
	if (v.controls) v.controls.autoRotate = false;
});
await page.waitForTimeout(1500);

// Confirm Next chrome is showing.
const layout = await page.evaluate(() => document.body.dataset.layout);
const dockBox = await page.evaluate(() => {
	const dock = document.getElementById('next-dock');
	const clip = document.getElementById('next-dock-clip');
	if (!dock) return { ok: false };
	const dr = dock.getBoundingClientRect();
	const cr = clip ? clip.getBoundingClientRect() : null;
	return {
		ok: true,
		dock: { x: dr.x, y: dr.y, w: dr.width, h: dr.height },
		clip: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
		clipText: clip ? clip.querySelector('#next-dock-clip-name')?.textContent : null,
	};
});
console.log('layout =', layout);
console.log('geometry =', JSON.stringify(dockBox, null, 2));

await page.screenshot({ path: '/tmp/app-next-dock-idle.png', timeout: 30000, animations: 'disabled' });
console.log('→ /tmp/app-next-dock-idle.png');

// Hover the dock — should expand the scrubber/time.
await page.hover('#next-dock');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/app-next-dock-hover.png', timeout: 30000, animations: 'disabled' });
console.log('→ /tmp/app-next-dock-hover.png');

await browser.close();
