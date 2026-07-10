import { chromium } from 'playwright';

const ROUTES = process.argv.slice(2);
const browser = await chromium.launch();

for (const route of ROUTES) {
	const page = await browser.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(['exception', String(e).slice(0, 120)]));
	page.on('console', (m) => { if (m.type() === 'error') errs.push(['console', m.text().slice(0, 120)]); });
	page.on('requestfailed', (r) => errs.push(['req-failed', `${r.failure()?.errorText} ${r.url().slice(0, 90)}`]));
	page.on('response', (r) => { if (r.status() >= 400) errs.push(['http', `${r.status()} ${r.url().slice(0, 90)}`]); });

	try {
		await page.goto(`https://three.ws${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
		for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1400); await page.waitForTimeout(700); }
		await page.waitForTimeout(4000);
	} catch (e) {
		errs.push(['nav', String(e).slice(0, 100)]);
	}

	// collapse duplicates
	const counts = new Map();
	for (const [k, v] of errs) {
		const key = `${k}|${v.replace(/[0-9a-f]{20,}/g, '<cid>').replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, '<uuid>')}`;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	console.log(`\n=== ${route} — ${errs.length} error(s), ${counts.size} unique ===`);
	[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}× ${k}`));
	if (!errs.length) console.log('  clean');
	await page.close();
}
await browser.close();
