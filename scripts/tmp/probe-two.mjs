// Dump the rendered top-level structure of the two tour stops whose mounted
// app offered no candidate anchor to the first probe. Read-only.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3002';
const browser = await chromium.launch();
for (const route of ['/scene']) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 140)));
	page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 140)));
	await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await page.waitForTimeout(5000);
	const tree = await page.evaluate(() => {
		const rows = [];
		const walk = (el, depth) => {
			if (depth > 4) return;
			for (const c of el.children) {
				if (['SCRIPT', 'STYLE', 'LINK'].includes(c.tagName)) continue;
				const r = c.getBoundingClientRect();
				if (r.width >= 60 && r.height >= 24) {
					rows.push(
						`${'  '.repeat(depth)}${c.tagName.toLowerCase()}` +
							`${c.id ? '#' + c.id : ''}` +
							`${typeof c.className === 'string' && c.className ? '.' + c.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` +
							`  [${Math.round(r.width)}x${Math.round(r.height)} top:${Math.round(r.top)}] ` +
							(c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46),
					);
				}
				walk(c, depth + 1);
			}
		};
		walk(document.body, 0);
		return rows.slice(0, 40);
	});
	console.log(`\n=== ${route} ===`);
	console.log(tree.join('\n'));
	if (errors.length) console.log('  console errors:', errors.slice(0, 4));
	await page.close();
}
await browser.close();
