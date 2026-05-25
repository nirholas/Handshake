// Smoke-test every dashboard-next page against the local dev server.
// Stubs only /api/auth/me (so the page renders past requireUser) and lets
// every other /api/* request flow to the real dev proxy. Reports console
// errors + failed network requests per page.

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:3011';
const OUT_DIR = process.argv[3] || '/tmp';

const PAGES = [
	{ name: 'home',                 path: '/pages/dashboard-next/index.html' },
	{ name: 'avatars',              path: '/pages/dashboard-next/avatars.html' },
	{ name: 'library-animations',   path: '/pages/dashboard-next/library.html#tab=animations' },
	{ name: 'library-memory',       path: '/pages/dashboard-next/library.html#tab=memory' },
	{ name: 'library-strategy',     path: '/pages/dashboard-next/library.html#tab=strategy' },
	{ name: 'library-voice',        path: '/pages/dashboard-next/library.html#tab=voice' },
	{ name: 'widgets',              path: '/pages/dashboard-next/widgets.html' },
	{ name: 'api',                  path: '/pages/dashboard-next/api.html' },
	{ name: 'monetize',             path: '/pages/dashboard-next/monetize.html' },
	{ name: 'account',              path: '/pages/dashboard-next/account.html' },
];

const ME = {
	id: 'u_demo',
	display_name: 'Nicholas',
	handle: 'nicholas',
	username: 'nicholas',
	email: 'nicholas@three.ws',
	plan: 'pro',
	created_at: new Date(Date.now() - 90 * 86400_000).toISOString(),
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] });

const summary = [];

for (const page of PAGES) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	const pageErrors = [];
	const failedReqs = [];
	const httpErrors = [];

	p.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message.slice(0, 240)));
	p.on('console',   (m) => { if (m.type() === 'error') pageErrors.push('CONSOLE ' + m.text().slice(0, 240)); });
	p.on('requestfailed', (r) => {
		const u = r.url();
		if (u.includes('analytics') || u.includes('posthog') || u.includes('favicon')) return;
		failedReqs.push(`${u.replace(BASE, '')} ${r.failure()?.errorText || ''}`);
	});
	p.on('response', (r) => {
		const u = r.url();
		if (!u.startsWith(BASE) && !u.startsWith('http://127.0.0.1')) return;
		if (u.includes('analytics') || u.includes('posthog')) return;
		const s = r.status();
		if (s >= 400) httpErrors.push(`${s} ${u.replace(BASE, '')}`);
	});

	// Stub just auth/me — everything else goes through.
	await ctx.route('**/api/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
	await ctx.route('**/api/csrf-token', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'audit' }) }));

	const url = BASE + page.path;
	try {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20_000 });
		await p.waitForTimeout(3500);
		await p.screenshot({ path: `${OUT_DIR}/dn-audit-${page.name}.png`, fullPage: false });
	} catch (e) {
		pageErrors.push('NAV_FAIL ' + e.message.slice(0, 200));
	}

	summary.push({ page: page.name, url: page.path, pageErrors, failedReqs, httpErrors });
	await ctx.close();
}

await browser.close();

for (const s of summary) {
	console.log(`\n=== ${s.page}  (${s.url}) ===`);
	if (s.pageErrors.length) {
		console.log('  page errors:');
		for (const e of s.pageErrors) console.log('   - ' + e);
	}
	if (s.failedReqs.length) {
		console.log('  failed requests:');
		for (const e of s.failedReqs.slice(0, 20)) console.log('   - ' + e);
	}
	if (s.httpErrors.length) {
		console.log('  http >=400:');
		for (const e of s.httpErrors.slice(0, 20)) console.log('   - ' + e);
	}
	if (!s.pageErrors.length && !s.failedReqs.length && !s.httpErrors.length) {
		console.log('  clean');
	}
}

const broken = summary.filter((s) => s.pageErrors.length || s.failedReqs.length || s.httpErrors.length);
console.log(`\n${broken.length} of ${summary.length} pages have issues.`);
process.exit(broken.length ? 1 : 0);
