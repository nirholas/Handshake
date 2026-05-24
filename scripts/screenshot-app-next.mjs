import { chromium } from 'playwright';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200));
});

const baseUrl = process.argv[2] || 'http://localhost:3000/app-next';
console.log('→', baseUrl);

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

await page.waitForFunction(
	() =>
		window.VIEWER?.viewer?.content &&
		window.VIEWER?.viewer?.animationManager?.getAnimationDefs?.()?.length > 0,
	{ timeout: 20000 },
);

await page.evaluate(async () => {
	const mgr = window.VIEWER.viewer.animationManager;
	await mgr.ensureLoaded('av-waving').catch(() => {});
	mgr.play('av-waving');
});
await page.waitForTimeout(2200);
await page.screenshot({ path: '/tmp/app-next-hero.png' });
console.log('→ /tmp/app-next-hero.png');

// Animation sheet
await page.evaluate(() => document.getElementById('nxt-anim-btn').click());
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/app-next-sheet.png' });
console.log('→ /tmp/app-next-sheet.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Share popover
await page.evaluate(() => document.getElementById('nxt-share-btn').click());
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/app-next-share.png' });
console.log('→ /tmp/app-next-share.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
// Force close share
await page.evaluate(() => document.getElementById('nxt-share-popover').setAttribute('hidden', ''));

// Camera preset — wide
await page.evaluate(() => document.querySelector('[data-preset="wide"]').click());
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/app-next-wide.png' });
console.log('→ /tmp/app-next-wide.png');

// Back to body shot, then trigger a chat
await page.evaluate(() => document.querySelector('[data-preset="body"]').click());
await page.waitForTimeout(700);
await page.evaluate(() => document.querySelector('.nxt-chat-chip')?.click());
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/app-next-chat.png' });
console.log('→ /tmp/app-next-chat.png');

// Help overlay
await page.keyboard.down('Shift');
await page.keyboard.press('/');
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/app-next-help.png' });
console.log('→ /tmp/app-next-help.png');

await browser.close();
