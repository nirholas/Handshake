import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await page.goto('http://localhost:8090/markets/news', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => {
	const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { sel, top: Math.round(r.top), h: Math.round(r.height), mt: cs.marginTop, mb: cs.marginBottom, ai: cs.alignItems, pos: cs.position }; };
	return JSON.stringify([box('.nwb-head'), box('.nwb-head-id'), box('.nwb-head .cv-h1'), box('.nwb-head-tools'), box('.nwb-search'), box('.nwb-search input'), box('.nwb-controls'), box('.cv-crumbs')], null, 1);
}));
await browser.close();
