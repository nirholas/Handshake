// Single-page screenshot, minimum-memory chromium config.
import { chromium } from 'playwright';
const url = process.argv[2];
const out = process.argv[3];
const b = await chromium.launch({
	args: [
		'--use-gl=swiftshader', '--no-sandbox', '--disable-gpu',
		'--disable-dev-shm-usage', '--single-process',
		'--disable-background-networking', '--disable-extensions',
		'--no-zygote', '--disable-features=IsolateOrigins,site-per-process',
		'--js-flags=--max-old-space-size=128',
	],
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
await ctx.route('**/api/auth/me', (r) => r.fulfill({
	status: 200, contentType: 'application/json',
	body: JSON.stringify({ user: {
		id: 'usr_smoke', display_name: 'Smoke Test', handle: 'smoke',
		email: 'smoke@three.ws', email_verified: true,
		created_at: new Date(Date.now() - 9e9).toISOString(), plan: 'free',
	} }),
}));
await ctx.route('**/api/csrf-token', (r) => r.fulfill({
	status: 200, contentType: 'application/json',
	body: JSON.stringify({ token: 'csrf_smoke', expiresIn: 3600 }),
}));
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 200)); });
try {
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 25000 });
	await p.waitForTimeout(1200);
	await p.screenshot({ path: out, fullPage: false });
	console.log('saved', out);
	for (const e of errs) console.log('  ' + e);
} catch (err) {
	console.log('FAIL', err?.message?.slice(0, 200) || err);
	for (const e of errs) console.log('  ' + e);
	process.exit(1);
}
await b.close();
