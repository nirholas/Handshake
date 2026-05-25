// Full-sweep verifier: opens every dashboard-next page in a real browser
// with a mocked /api/auth/me, captures any console errors / failed fetches
// (filtered to dashboard-next surface only), and screenshots each page.
//
// Usage: node scripts/_dn-fullsweep.mjs
// Output: /tmp/dn-sweep-<page>.png for every page; non-zero exit on errors.

import { chromium } from 'playwright';

const PAGES = [
	{ slug: '',          name: 'overview', sel: '.dn-shell .dn-rail-item' },
	{ slug: 'avatars',   name: 'avatars',  sel: '.dn-shell .dn-rail-item' },
	{ slug: 'widgets',   name: 'widgets',  sel: '.dn-shell .dn-rail-item' },
	{ slug: 'library',   name: 'library',  sel: '.dn-shell .dn-rail-item' },
	{ slug: 'api',       name: 'api',      sel: '.dn-shell .dn-rail-item' },
	{ slug: 'monetize',  name: 'monetize', sel: '.dn-shell .dn-rail-item' },
	{ slug: 'account',   name: 'account',  sel: '.dn-shell .dn-rail-item' },
];

const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });

// Mocks: keep responses minimal so home doesn't mount live <threews-avatar>
// (Three.js + SwiftShader headless = GPU crashes — see memory).
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
const me = { id: 'test-user', display_name: 'Test User', handle: 'tester', email: 't@x.com', plan: 'pro' };
await ctx.route('**/api/auth/me',                  (r) => r.fulfill(json({ user: me })));
await ctx.route('**/api/avatars*',                 (r) => r.fulfill(json({ avatars: [], next_cursor: null })));
await ctx.route('**/api/widgets*',                 (r) => r.fulfill(json({ widgets: [] })));
await ctx.route('**/api/agents*',                  (r) => r.fulfill(json({ agents: [] })));
await ctx.route('**/api/keys*',                    (r) => r.fulfill(json({ keys: [] })));
await ctx.route('**/api/animations*',              (r) => r.fulfill(json({ animations: [] })));
await ctx.route('**/api/billing/**',               (r) => r.fulfill(json({ revenue: 0, rows: [], series: [] })));
await ctx.route('**/api/notifications*',           (r) => r.fulfill(json({ notifications: [] })));
await ctx.route('**/api/subscriptions/**',         (r) => r.fulfill(json({ subscriptions: [] })));
await ctx.route('**/api/events*',                  (r) => r.fulfill(json({ events: [] })));
await ctx.route('**/api/me/**',                    (r) => r.fulfill(json({ }))); // earnings, totals, etc.
await ctx.route('**/api/strategy*',                (r) => r.fulfill(json({ strategy: null })));
await ctx.route('**/api/memories*',                (r) => r.fulfill(json({ memories: [] })));
await ctx.route('**/api/voice*',                   (r) => r.fulfill(json({ voices: [] })));
await ctx.route('**/api/csrf-token',               (r) => r.fulfill(json({ token: 'test-csrf' })));

let totalErrs = 0;
for (const page of PAGES) {
	const p = await ctx.newPage();
	const errs = [];
	p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message.slice(0, 220)}`));
	p.on('console',  (m) => { if (m.type() === 'error') errs.push(`[err] ${m.text().slice(0, 220)}`); });
	const url = `http://127.0.0.1:3010/dashboard-next${page.slug ? '/' + page.slug : ''}`;
	try {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await p.waitForSelector(page.sel, { timeout: 20000 });
		await p.waitForTimeout(1500); // let async fetches settle
		await p.screenshot({ path: `/tmp/dn-sweep-${page.name}.png`, fullPage: false });
	} catch (e) {
		errs.push(`NAV/WAIT failed: ${e.message.slice(0, 220)}`);
	}
	// Filter known unrelated browser-noise errors that aren't bugs in our code.
	const relevant = errs.filter((e) =>
		!/Failed to load resource: the server responded with a status of 4\d\d/.test(e) || // 4xx logged by browser auto-handler
		/PAGEERROR|TypeError|ReferenceError|SyntaxError|Uncaught/.test(e),
	);
	console.log(`${page.name}: ${relevant.length === 0 ? 'OK' : 'ERRORS'}`);
	for (const e of relevant) { console.log(`  ${e}`); totalErrs++; }
	await p.close();
}

await b.close();
process.exit(totalErrs > 0 ? 1 : 0);
