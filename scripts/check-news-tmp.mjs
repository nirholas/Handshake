import { chromium } from 'playwright';

const BASE = 'http://localhost:8090';
const OUT = '/tmp/claude-1000/-workspaces-three-ws/7202a201-2f6a-47fa-a984-64069f93d10d/scratchpad';
const browser = await chromium.launch();
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));

await page.goto(`${BASE}/markets/news`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/news-desktop.png`, fullPage: false });

// Count real vs fallback media
const stats = await page.evaluate(() => {
	const imgs = [...document.querySelectorAll('.nw-media img, .nw-hero-media img')];
	return {
		title: document.querySelector('.cv-h1')?.textContent,
		date: document.getElementById('nwb-date')?.textContent,
		tabs: [...document.querySelectorAll('.nwb-tab span')].map((s) => s.textContent),
		breakingVisible: !document.getElementById('nwb-breaking').hidden,
		briefVisible: !document.getElementById('nwb-brief').hidden,
		briefPoints: document.querySelectorAll('.nwb-brief-list li').length,
		heroCount: document.querySelectorAll('.nw-hero').length,
		railRows: document.querySelectorAll('.nwb-rail .nw-row').length,
		gridCards: document.querySelectorAll('.nw-grid .nw-card').length,
		imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
		imgsTotal: imgs.length,
		fallbackTiles: document.querySelectorAll('.nw-fallback').length,
		stars: document.querySelectorAll('.nw-star').length,
	};
});
console.log(JSON.stringify(stats, null, 1));

// Exercise tabs: featured, trending, saved
for (const tab of ['featured', 'trending', 'saved', 'all']) {
	await page.click(`[data-tab="${tab}"]`);
	await page.waitForTimeout(tab === 'trending' ? 8000 : 2500);
	await page.screenshot({ path: `${OUT}/news-${tab}.png` });
	console.log(tab, 'url:', page.url());
}
// star a story then check saved
await page.click('[data-tab="headlines"]');
await page.waitForTimeout(2500);
await page.click('.nw-star');
await page.click('[data-tab="saved"]');
await page.waitForTimeout(500);
console.log('saved rows after star:', await page.locator('.nwb-saved .nw-row').count());
await page.screenshot({ path: `${OUT}/news-saved-after-star.png` });

// mobile
const mob = await browser.newPage({ viewport: { width: 375, height: 800 } });
await mob.goto(`${BASE}/markets/news`, { waitUntil: 'networkidle', timeout: 60000 });
await mob.waitForTimeout(2500);
await mob.screenshot({ path: `${OUT}/news-mobile.png`, fullPage: false });
const hscroll = await mob.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
console.log('mobile horizontal scroll:', hscroll);

console.log('CONSOLE ERRORS:', errors.length ? errors : 'none');
await browser.close();
