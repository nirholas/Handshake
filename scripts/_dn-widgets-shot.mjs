// Smoke-test the /dashboard-next/widgets page authenticated.
// Registers a throwaway account so /api/widgets returns the empty-state, then
// captures a screenshot and pageerror/console messages. Exit non-zero on any.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:3010/dashboard-next/widgets';
const out = process.argv[3] || '/tmp/dn-widgets.png';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
page.on('console', (m) => {
	if (m.type() === 'error') errs.push('[console.error] ' + m.text().slice(0, 200));
});
page.on('requestfailed', (r) => {
	const u = r.url();
	if (u.startsWith('chrome-extension://')) return;
	errs.push('REQ FAIL ' + u + ' ' + (r.failure()?.errorText || ''));
});

const origin = new URL(url).origin;
const handle = 'dnwx' + Date.now().toString(36);
const regRes = await ctx.request.post(`${origin}/api/auth/register`, {
	data: {
		email: `${handle}@example.test`,
		password: 'PassP4ss!2026',
		display_name: 'Widget Smoke',
	},
	headers: { 'content-type': 'application/json' },
});
if (!regRes.ok()) {
	console.warn('[register]', regRes.status(), (await regRes.text()).slice(0, 200));
}

// Need a CSRF token to POST through the api helper used by /api/widgets.
const csrfRes = await ctx.request.get(`${origin}/api/csrf-token`);
const csrfTok = csrfRes.ok() ? (await csrfRes.json())?.token : null;

// Seed two widgets so the populated-grid path actually renders, including
// the lazy-iframe + per-card stats lookups. Type 'turntable' so we don't
// need an avatar wired up just to make a row exist.
for (let i = 1; i <= 2; i++) {
	const created = await ctx.request.post(`${origin}/api/widgets`, {
		data: {
			type: 'turntable',
			name: `Smoke widget ${i}`,
			config: {},
			is_public: true,
		},
		headers: {
			'content-type': 'application/json',
			...(csrfTok ? { 'x-csrf-token': csrfTok } : {}),
		},
	});
	if (!created.ok()) {
		console.warn('[create widget]', created.status(), (await created.text()).slice(0, 200));
	}
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
// Empty state OR cards both qualify as "rendered" — wait for either.
await page.waitForFunction(
	() =>
		document.querySelector('[data-slot="grid"] [data-card]') ||
		document.querySelector('[data-slot="grid"] .dn-empty') ||
		document.querySelector('[data-slot="grid"] [data-retry]'),
	null,
	{ timeout: 20000 },
);
// Give iframes a beat to start mounting + stats to come back.
await page.waitForTimeout(2500);
await page.screenshot({ path: out, fullPage: false });
console.log('saved', out);

if (errs.length) {
	console.log('errors:');
	for (const e of errs) console.log(' ', e);
	process.exit(1);
}
await browser.close();
