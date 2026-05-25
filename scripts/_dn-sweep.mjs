// Smoke-test every /dashboard-next page. Stubs auth so the shell mounts
// in a headless browser without a real session cookie; downstream /api/*
// calls are allowed to fail naturally — we only care that the page
// renders and the chrome is intact.
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

const FAKE_USER = {
	id: 'usr_smoke_test',
	display_name: 'Smoke Test',
	handle: 'smoke',
	email: 'smoke@three.ws',
	email_verified: true,
	created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString(),
	plan: 'free',
};

const browser = await chromium.launch({
	args: ['--use-gl=swiftshader', '--no-sandbox', '--disable-gpu'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// Stub the calls that gate the shell. Everything else falls through to the
// dev-server proxy and is allowed to 401/404 — we report those but don't
// fail the smoke test on them.
await ctx.route('**/api/auth/me', (route) => {
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ user: FAKE_USER }),
	});
});
await ctx.route('**/api/csrf-token', (route) => {
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ token: 'csrf_smoke_test', expiresIn: 3600 }),
	});
});

const results = [];
for (const { slug, name } of PAGES) {
	const page = await ctx.newPage();
	const errs = [];
	const apiFails = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220));
	});
	page.on('requestfailed', (r) => {
		const u = r.url();
		if (/posthog|sw\.js|workbox|favicon\.svg/.test(u)) return;
		if (u.includes('/api/')) apiFails.push(u.replace(BASE, ''));
		else errs.push('REQ FAIL ' + u + ' ' + r.failure()?.errorText);
	});
	page.on('response', (resp) => {
		const u = resp.url();
		if (!u.includes('/api/')) return;
		if (resp.status() >= 400 && !apiFails.includes(u.replace(BASE, ''))) {
			apiFails.push(`${resp.status()} ${u.replace(BASE, '')}`);
		}
	});

	const url = `${BASE}/dashboard-next${slug}`;
	const out = `/tmp/dn-${name}.png`;
	let status = 'ok';
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 25000 });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: out, fullPage: false });
	} catch (err) {
		status = 'fail: ' + (err?.message || err).slice(0, 200);
	}
	results.push({ name, url, out, status, errs, apiFails });
	await page.close();
}

// Open the palette and screenshot it
{
	const page = await ctx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220)); });
	try {
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
		await page.waitForTimeout(500);
		await page.keyboard.press('Meta+K');
		await page.waitForTimeout(400);
		const input = await page.$('#dn-palette input, [data-role="palette-input"]');
		if (input) {
			await input.fill('account');
			await page.waitForTimeout(200);
		}
		await page.screenshot({ path: '/tmp/dn-palette.png', fullPage: false });
		results.push({ name: 'palette', url: '⌘K', out: '/tmp/dn-palette.png', status: 'ok', errs, apiFails: [] });
	} catch (err) {
		results.push({ name: 'palette', url: '⌘K', out: '/tmp/dn-palette.png', status: 'fail: ' + (err?.message || err).slice(0, 200), errs, apiFails: [] });
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
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('.dn-shell', { timeout: 20000 });
		await page.waitForTimeout(1800);
		await page.screenshot({ path: '/tmp/dn-drawer.png', fullPage: false });
		results.push({ name: 'drawer', url: 'drawer-open', out: '/tmp/dn-drawer.png', status: 'ok', errs, apiFails: [] });
	} catch (err) {
		results.push({ name: 'drawer', url: 'drawer-open', out: '/tmp/dn-drawer.png', status: 'fail: ' + (err?.message || err).slice(0, 200), errs, apiFails: [] });
	}
	await page.close();
}

// Mobile breakpoint test
{
	const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 800 } });
	await mobileCtx.route('**/api/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: FAKE_USER }) }));
	await mobileCtx.route('**/api/csrf-token', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'csrf', expiresIn: 3600 }) }));
	const page = await mobileCtx.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 220)));
	page.on('console', (m) => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 220)); });
	try {
		await page.goto(`${BASE}/dashboard-next`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('.dn-shell', { timeout: 20000 });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: '/tmp/dn-mobile.png', fullPage: true });
		results.push({ name: 'mobile-375', url: 'mobile', out: '/tmp/dn-mobile.png', status: 'ok', errs, apiFails: [] });
	} catch (err) {
		results.push({ name: 'mobile-375', url: 'mobile', out: '/tmp/dn-mobile.png', status: 'fail: ' + (err?.message || err).slice(0, 200), errs, apiFails: [] });
	}
	await page.close();
	await mobileCtx.close();
}

await browser.close();

console.log('\n=== SWEEP RESULTS ===\n');
let pageErrCount = 0;
let failCount = 0;
for (const r of results) {
	const headline =
		r.status !== 'ok' ? '✗' :
		r.errs.some((e) => e.startsWith('PAGEERROR')) ? '✗' :
		r.errs.length ? '⚠' : '✓';
	console.log(`${headline}  ${r.name.padEnd(14)}  ${r.out}`);
	if (r.status !== 'ok') {
		console.log(`     ${r.status}`);
		failCount++;
	}
	const trueErrs = r.errs.filter((e) => e.startsWith('PAGEERROR') || e.startsWith('[err]'));
	for (const e of trueErrs.slice(0, 4)) {
		console.log(`     ${e}`);
		pageErrCount++;
	}
	if (trueErrs.length > 4) console.log(`     ... +${trueErrs.length - 4} more page errors`);
	if (r.apiFails && r.apiFails.length) {
		const uniqFails = [...new Set(r.apiFails)].slice(0, 4);
		for (const f of uniqFails) console.log(`     api: ${f}`);
		if (r.apiFails.length > 4) console.log(`     ... +${r.apiFails.length - 4} more api 4xx`);
	}
}
console.log(`\nfails: ${failCount}, page-errors: ${pageErrCount}`);
process.exit(failCount > 0 || pageErrCount > 0 ? 1 : 0);
