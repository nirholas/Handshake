import { chromium } from 'playwright';

const url = 'http://localhost:3001/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const warnings = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
	const t = msg.type();
	const text = msg.text();
	// Filter Vite-injected dev-only HMR/source-map noise that doesn't reflect prod.
	if (text.includes('[vite]')) return;
	if (t === 'error') errors.push(`console.error: ${text}`);
	else if (t === 'warning') warnings.push(`console.warn: ${text}`);
});
page.on('requestfailed', (req) => {
	const u = req.url();
	// `/api/explore` is a Vercel function — not available in vite dev. We proxy it below,
	// so any request that *does* fail is a real bug worth reporting.
	errors.push(`requestfailed: ${u} -- ${req.failure()?.errorText}`);
});

// Proxy /api/* to production so dev exercises real endpoints.
await page.route('**/api/**', async (route) => {
	const orig = new URL(route.request().url());
	const prod = 'https://three.ws' + orig.pathname + orig.search;
	try {
		const r = await fetch(prod, { headers: { accept: 'application/json' } });
		const body = await r.text();
		await route.fulfill({
			status: r.status,
			headers: Object.fromEntries(r.headers.entries()),
			body,
		});
	} catch (e) {
		await route.abort();
	}
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

// Capture hero
await page.screenshot({ path: '/tmp/pro-hero.png' });

// Scroll to Act 2, wait for picker hydration to complete (≥2 buttons swapped in).
const parallax = await page.$('main.home-parallax');
async function scrollTo(frac) {
	await page.evaluate((f) => {
		const el = document.querySelector('main.home-parallax');
		if (el) el.scrollTop = Math.round(el.scrollHeight * f);
	}, frac);
	await page.waitForTimeout(600);
}

// Track whether the hydration fetch actually fired against /api/explore.
let exploreCalled = false;
page.on('request', (req) => {
	if (req.url().includes('/api/explore')) exploreCalled = true;
});

await scrollTo(0.25);
await page.waitForTimeout(1500);
// Force-trigger Act 2 init even if IntersectionObserver fights the parallax transforms,
// so we can confirm the hydration code path independent of scroll detection.
await page.evaluate(async () => {
	const canvas = document.getElementById('home-act2-canvas');
	if (canvas) canvas.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(4500); // give /api/explore + featured-GLB load time

const pickerLabels = await page.evaluate(() => {
	const btns = Array.from(document.querySelectorAll('.h-avatar-picker .h-av-opt'));
	return btns.map((b) => b.textContent.trim());
});
console.log('explore endpoint hit:', exploreCalled);
console.log('picker after hydration:', pickerLabels);

await scrollTo(1);
await page.waitForTimeout(800);
try {
	await page.screenshot({ path: '/tmp/pro-cta.png' });
} catch (e) {
	console.log('screenshot at end skipped:', e.message.split('\n')[0]);
}

console.log('errors:', errors.length);
errors.forEach((e) => console.log('  -', e));
console.log('warnings:', warnings.length);

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
