// Smoke-test every /dashboard-next page. Captures one screenshot per page
// and reports any page-error / console-error / failed-request. Exit code is
// the number of pages with issues. Deletes itself when caller is done — this
// file is intentionally not checked in long-term.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3010';
const PAGES = [
	{ slug: '',           name: 'home' },
	{ slug: '/avatars',   name: 'avatars' },
	{ slug: '/widgets',   name: 'widgets' },
	{ slug: '/library',   name: 'library' },
	{ slug: '/api',       name: 'api' },
	{ slug: '/monetize',  name: 'monetize' },
	{ slug: '/account',   name: 'account' },
];

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--no-sandbox', '--disable-gpu'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const results = [];
for (const { slug, name } of PAGES) {
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220));
	});
	page.on('requestfailed', (r) => {
		const u = r.url();
		// Ignore irrelevant 404s on optional analytics/sw assets.
		if (/posthog|sw\.js|workbox|favicon\.svg/.test(u)) return;
		errs.push('REQ FAIL ' + u + ' ' + r.failure()?.errorText);
	});
	const url = `${BASE}/dashboard-next${slug}`;
	const out = `/tmp/dn-${name}.png`;
	let status = 'ok';
	try {
		await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
		await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 25000 });
		// Settle for any in-flight 3D/component mounts.
		await page.waitForTimeout(1200);
		await page.screenshot({ path: out, fullPage: false });
	} catch (err) {
		status = 'fail: ' + (err?.message || err).slice(0, 200);
	}
	results.push({ name, url, out, status, errs });
	await page.close();
}

// Bonus: open the palette and screenshot it
{
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220)); });
	try {
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'networkidle', timeout: 45000 });
		await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
		await page.keyboard.press('Meta+K');
		await page.waitForTimeout(400);
		await page.fill('#dn-palette input, [data-role="palette-input"]', 'avatars').catch(() => {});
		await page.waitForTimeout(200);
		await page.screenshot({ path: '/tmp/dn-palette.png', fullPage: false });
		results.push({ name: 'palette', url: 'cmd-k', out: '/tmp/dn-palette.png', status: 'ok', errs });
	} catch (err) {
		results.push({ name: 'palette', url: 'cmd-k', out: '/tmp/dn-palette.png', status: 'fail: ' + (err?.message || err).slice(0, 200), errs });
	}
	await page.close();
}

// Open the drawer too
{
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220)); });
	try {
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'domcontentloaded' });
		await page.evaluate(() => localStorage.setItem('dn:drawer:open', '1'));
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'networkidle', timeout: 45000 });
		await page.waitForSelector('.dn-shell', { timeout: 20000 });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: '/tmp/dn-drawer.png', fullPage: false });
		results.push({ name: 'drawer-open', url: 'drawer', out: '/tmp/dn-drawer.png', status: 'ok', errs });
	} catch (err) {
		results.push({ name: 'drawer-open', url: 'drawer', out: '/tmp/dn-drawer.png', status: 'fail: ' + (err?.message || err).slice(0, 200), errs });
	}
	await page.close();
}

await browser.close();

console.log('\n=== SWEEP RESULTS ===');
let bad = 0;
for (const r of results) {
	const headline = r.status === 'ok' && r.errs.length === 0
		? '✓'
		: (r.status === 'ok' ? '⚠' : '✗');
	console.log(`${headline} ${r.name.padEnd(14)} ${r.out}`);
	if (r.status !== 'ok') {
		console.log(`     ${r.status}`);
		bad++;
	}
	for (const e of r.errs.slice(0, 6)) {
		console.log(`     ${e}`);
		if (e.startsWith('PAGEERROR') || e.startsWith('[err]')) bad++;
	}
	if (r.errs.length > 6) console.log(`     ... +${r.errs.length - 6} more`);
}
process.exit(bad > 0 ? 1 : 0);
