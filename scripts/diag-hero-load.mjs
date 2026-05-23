import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:3000/marketplace';
const browser = await chromium.launch();
const ctx = await browser.newContext({ bypassCSP: false });
const page = await ctx.newPage();

page.on('console', (msg) => {
	const t = msg.type();
	if (t === 'error' || t === 'warning') console.log('[' + t + ']', msg.text());
});
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
page.on('requestfailed', (req) => console.log('[reqfail]', req.url(), req.failure()?.errorText));

console.log('Navigating to', url);
await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(10000);

const summary = await page.evaluate(() => {
	const slides = [...document.querySelectorAll('.market-hero-slide')];
	return slides.map((s) => {
		const mv = s.querySelector('model-viewer');
		return {
			slot: s.dataset.slot,
			slideClasses: s.className,
			mvSrc: mv?.getAttribute('src') || mv?.getAttribute('data-src'),
			mvLoaded: mv?.loaded,
			mvModelIsVisible: mv?.modelIsVisible,
		};
	});
});
console.log(JSON.stringify(summary, null, 2));

await browser.close();
