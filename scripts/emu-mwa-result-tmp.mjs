#!/usr/bin/env node
// Read back window.__mwaResult (or report pending) from the TWA page.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) {
	for (const p of ctx.pages()) {
		if (p.url().includes('three.ws')) { page = p; break; }
	}
}
if (!page) { console.error('three.ws page not found'); process.exit(1); }

const result = await page.evaluate(() =>
	Promise.race([
		window.__mwaResult,
		new Promise((r) => setTimeout(() => r({ pending: true }), 3000)),
	]),
);
console.log(JSON.stringify(result, null, 1));
await browser.close();
