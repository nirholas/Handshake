// Scratch probe: dump stable anchor candidates from live three.ws pages.
import { chromium } from 'playwright';

const BASE = 'https://three.ws';
const paths = process.argv.slice(2);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

for (const p of paths) {
	try {
		await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 });
		await page.waitForTimeout(3500);
		const out = await page.evaluate(() => {
			const rows = [];
			const seen = new Set();
			const push = (sel, el) => {
				if (seen.has(sel)) return;
				seen.add(sel);
				const r = el.getBoundingClientRect();
				if (r.width < 24 || r.height < 12) return;
				rows.push({
					sel,
					tag: el.tagName.toLowerCase(),
					text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
					box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
				});
			};
			document.querySelectorAll('[id]').forEach((el) => push('#' + el.id, el));
			document.querySelectorAll('main h1, main h2, main .hero, main section').forEach((el) => {
				if (el.id) return;
				const cls = (el.className || '').toString().trim().split(/\s+/)[0];
				if (cls) push(el.tagName.toLowerCase() + '.' + cls, el);
			});
			return { title: document.title, rows };
		});
		console.log('\n=== ' + p + ' :: ' + out.title + ' ===');
		for (const r of out.rows.slice(0, 60)) {
			console.log(`${r.sel}  [${r.box.join(',')}]  <${r.tag}> ${r.text}`);
		}
	} catch (e) {
		console.log('\n=== ' + p + ' FAILED: ' + e.message);
	}
}
await browser.close();
