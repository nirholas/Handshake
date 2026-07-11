import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
await page.goto('http://localhost:8090/markets/news', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const r = await page.evaluate(() => {
	const doc = document.documentElement;
	const main = document.querySelector('main');
	const out = { docScrollW: doc.scrollWidth, clientW: doc.clientWidth, mainW: main.getBoundingClientRect().width };
	// scrollWidth > clientWidth per element = internal overflow that may spill
	out.spillers = [...document.querySelectorAll('body *')]
		.filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible')
		.slice(0, 10)
		.map((el) => `${el.tagName}.${[...el.classList].join('.')} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
	const sel = document.getElementById('nw-source');
	out.sourceSelW = sel ? sel.getBoundingClientRect().width : null;
	const brk = document.getElementById('nwb-breaking');
	out.breakW = brk && !brk.hidden ? brk.scrollWidth + '/' + brk.clientWidth : 'hidden';
	return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
