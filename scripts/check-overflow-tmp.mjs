import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
await page.goto('http://localhost:8090/markets/news', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const offenders = await page.evaluate(() => {
	const docW = document.documentElement.clientWidth;
	const out = [];
	for (const el of document.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (r.right > docW + 1 && r.width > 20) {
			out.push(`${el.tagName}.${[...el.classList].join('.')} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
		}
		if (out.length > 12) break;
	}
	return out;
});
console.log(offenders.join('\n'));
await browser.close();
