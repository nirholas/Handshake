import { chromium, devices } from 'playwright';

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({
	...devices['iPhone 13'],
	viewport: { width: 390, height: 844 },
});
const page = await ctx.newPage();

page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
page.on('console', (m) => {
	if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200));
});

const url = process.argv[2] || 'http://localhost:3000/app-next';
console.log('→ mobile:', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

await page.waitForFunction(
	() =>
		window.VIEWER?.viewer?.content &&
		window.VIEWER?.viewer?.animationManager?.getAnimationDefs?.()?.length > 0,
	{ timeout: 25000 },
);

await page.evaluate(async () => {
	const v = window.VIEWER.viewer;
	v.state.autoRotate = false;
	v.controls.autoRotate = false;
	await v.animationManager.ensureLoaded('idle').catch(() => {});
	v.animationManager.play('idle');
});
await page.waitForTimeout(2200);

await page.screenshot({ timeout: 60000, animations: 'disabled', path: '/tmp/app-next-mobile-hero.png' });
console.log('→ /tmp/app-next-mobile-hero.png');

// Animation sheet on mobile
await page.evaluate(() => document.getElementById('nxt-anim-btn').click());
await page.waitForTimeout(900);
await page.screenshot({ timeout: 60000, animations: 'disabled', path: '/tmp/app-next-mobile-sheet.png' });
console.log('→ /tmp/app-next-mobile-sheet.png');

await browser.close();

// Layout inspection: any overlaps?
const ctx2 = await (await chromium.launch({
	args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})).newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
const page2 = await ctx2.newPage();
await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page2.waitForFunction(() => window.VIEWER?.viewer?.content, { timeout: 25000 });
await page2.waitForTimeout(1000);

const overlay = await page2.evaluate(() => {
	const get = (id) => {
		const el = document.getElementById(id);
		if (!el || el.hidden) return null;
		const r = el.getBoundingClientRect();
		return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	return {
		viewport: { w: window.innerWidth, h: window.innerHeight },
		header: get('nxt-more-btn')?.y,
		chatDock: get('nxt-chat-input')?.y,
		actionBar: document.querySelector('.nxt-action-bar')?.getBoundingClientRect()?.y,
		chips: document.querySelector('.nxt-chat-chips')?.getBoundingClientRect()?.y,
		visibleHeader: !!document.querySelector('.nxt-brand')?.getBoundingClientRect()?.width,
		visibleChat: !!document.getElementById('nxt-chat-input')?.getBoundingClientRect()?.width,
		visibleActions: !!document.querySelector('.nxt-action-bar')?.getBoundingClientRect()?.width,
		presetsHidden: getComputedStyle(document.querySelector('.nxt-preset-cluster')).display === 'none',
	};
});
console.log('LAYOUT:', JSON.stringify(overlay, null, 2));
await page2.context().browser().close();
