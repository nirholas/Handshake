// Authenticated, full-stack audit of every /dashboard-next page.
//   - Logs in via the real session API (fixture user, falls back to register).
//   - Visits each page, waits for shell + 1.5s settle, snaps fullPage screenshot.
//   - Reports pageerror / console.error / requestfailed / 4xx-5xx /api/ responses.
//
// Usage: node scripts/_dn-full-audit.mjs [base-url]
import { chromium } from 'playwright';

const base = (process.argv[2] || 'http://127.0.0.1:3010').replace(/\/$/, '');

const PAGES = [
	{ slug: 'overview', path: '/dashboard-next' },
	{ slug: 'avatars',  path: '/dashboard-next/avatars' },
	{ slug: 'library',  path: '/dashboard-next/library' },
	{ slug: 'widgets',  path: '/dashboard-next/widgets' },
	{ slug: 'api',      path: '/dashboard-next/api' },
	{ slug: 'monetize', path: '/dashboard-next/monetize' },
	{ slug: 'account',  path: '/dashboard-next/account' },
];

const fixtureEmail = process.env.DN_FIXTURE_EMAIL || 'dnprobempknlt40@example.test';
const fixturePass = process.env.DN_FIXTURE_PASS || 'PassP4ss!2026';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

async function ensureSession() {
	let login = await ctx.request.post(`${base}/api/auth/login`, {
		data: { email: fixtureEmail, password: fixturePass },
		headers: { 'content-type': 'application/json' },
	});
	if (login.status() === 200) return 'login';
	const reg = await ctx.request.post(`${base}/api/auth/register`, {
		data: { email: fixtureEmail, password: fixturePass, display_name: 'DN Audit' },
		headers: { 'content-type': 'application/json' },
	});
	if (reg.status() !== 201) return `register:${reg.status()}`;
	login = await ctx.request.post(`${base}/api/auth/login`, {
		data: { email: fixtureEmail, password: fixturePass },
		headers: { 'content-type': 'application/json' },
	});
	return login.status() === 200 ? 'registered+login' : `login:${login.status()}`;
}
console.log('session', await ensureSession());

const summary = [];
for (const { slug, path } of PAGES) {
	const page = await ctx.newPage();
	const errs = [];
	const bad = [];
	page.on('pageerror', (e) => errs.push(`pageerror: ${e.message.slice(0, 220)}`));
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push(`console.error: ${m.text().slice(0, 220)}`);
	});
	page.on('requestfailed', (r) => errs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
	page.on('response', (r) => {
		if (r.status() >= 400 && /\/api\//.test(r.url())) {
			bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`);
		}
	});

	try {
		await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
		await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 15000 });
		await page.waitForTimeout(2000);
	} catch (e) {
		errs.push(`nav: ${e.message.slice(0, 220)}`);
	}
	const shot = `/tmp/dn-full-${slug}.png`;
	try { await page.screenshot({ path: shot, fullPage: true }); } catch {}
	summary.push({ slug, path, errors: errs, badRequests: bad, shot });
	await page.close();
}

await browser.close();
console.log('\n=== DASHBOARD-NEXT FULL AUDIT ===\n');
let total = 0;
for (const r of summary) {
	const count = r.errors.length + r.badRequests.length;
	total += count;
	console.log(`── ${r.slug.padEnd(9)} ${r.path}  issues=${count}  shot=${r.shot}`);
	for (const e of r.errors) console.log(`    ! ${e}`);
	for (const b of r.badRequests) console.log(`    @ ${b}`);
}
console.log(`\nTOTAL ISSUES: ${total}\n`);
