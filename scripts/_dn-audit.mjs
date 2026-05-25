// Headless audit of /dashboard-next/* pages with mocked API.
// Run from repo root: node scripts/_dn-audit.mjs
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3010';
const PAGES = [
	{ slug: 'overview', path: '/dashboard-next' },
	{ slug: 'avatars',  path: '/dashboard-next/avatars' },
	{ slug: 'library',  path: '/dashboard-next/library' },
	{ slug: 'widgets',  path: '/dashboard-next/widgets' },
	{ slug: 'api',      path: '/dashboard-next/api' },
	{ slug: 'monetize', path: '/dashboard-next/monetize' },
	{ slug: 'account',  path: '/dashboard-next/account' },
];

const FAKE_USER = {
	id: '00000000-0000-0000-0000-000000000001',
	display_name: 'Test',
	email: 't@t',
	handle: 'test',
};

const MOCKS = [
	[/\/api\/auth\/me(\?|$)/,                    { user: FAKE_USER }],
	[/\/api\/csrf-token(\?|$)/,                  { token: 'x' }],
	[/\/api\/auth\/profile/,                     { user: FAKE_USER }],
	[/\/api\/auth\/logout/,                      { ok: true }],
	[/\/api\/auth\/wallets/,                     { wallets: [] }],
	[/\/api\/avatars\?/,                         { avatars: [], items: [], cursor: null }],
	[/\/api\/avatars\/[^/]+$/,                   { id: 'a1', name: 'Test', visibility: 'private' }],
	[/\/api\/widgets\/[^/]+\/stats/,             { calls: 0, revenue_atomics: '0', series: [] }],
	[/\/api\/widgets\/[^/]+\/transcripts/,       { transcripts: [] }],
	[/\/api\/widgets\/[^/]+\/duplicate/,         { id: 'w2' }],
	[/\/api\/widgets\/[^/]+$/,                   { ok: true }],
	[/\/api\/widgets(\?|$)/,                     { widgets: [], items: [] }],
	[/\/api\/keys(\?|$)/,                        { keys: [] }],
	[/\/api\/agents\/[^/]+\/payments/,           { payments: [] }],
	[/\/api\/agents\/[^/]+\/embed-policy/,       { policy: { allowed_origins: [] } }],
	[/\/api\/agents\/[^/]+\/animations/,         { ok: true }],
	[/\/api\/agents(\?|$)/,                      { agents: [] }],
	[/\/api\/agent-memory/,                      { memories: [], items: [] }],
	[/\/api\/agent-strategy/,                    { strategy: {} }],
	[/\/api\/animations\/presign/,               { url: 'https://example/upload', key: 'x' }],
	[/\/api\/tts\/eleven\/voices/,               { voices: [] }],
	[/\/api\/tts\/eleven$/,                      { ok: true }],
	[/\/api\/billing\/revenue/,                  { series: [], total_atomics: '0' }],
	[/\/api\/billing\/withdrawals/,              { withdrawals: [], items: [] }],
	[/\/api\/billing\/payout-wallets/,           { wallets: [] }],
	[/\/api\/billing\/summary/,                  { available_atomics: '0', pending_atomics: '0', lifetime_atomics: '0' }],
	[/\/api\/subscriptions\/plans/,              { plans: [] }],
	[/\/api\/subscriptions\/mine/,               { subscriptions: [] }],
	[/\/api\/users\/me\/earnings/,               { total_atomics: '0', breakdown: [] }],
	[/\/api\/audit-log/,                         { events: [], items: [] }],
	[/\/api\/sns\?/,                             { domain: null }],
	[/\/api\/mcp/,                               { ok: true }],
];

function jsonResponse(route, body) {
	return route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(body),
	});
}

async function auditPage(browser, { slug, path }) {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const errors = { pageerror: [], console: [], http: [], unmocked: [] };

	await ctx.route('**/api/**', (route) => {
		const url = route.request().url();
		for (const [re, body] of MOCKS) {
			if (re.test(url)) return jsonResponse(route, body);
		}
		errors.unmocked.push(`${route.request().method()} ${url.replace(BASE, '')}`);
		return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
	});

	const page = await ctx.newPage();
	page.on('pageerror', (err) => {
		errors.pageerror.push(`${err.name}: ${err.message}`);
	});
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			const text = msg.text();
			if (/Failed to load resource/i.test(text)) return;
			errors.console.push(text);
		}
	});
	page.on('response', (resp) => {
		const url = resp.url();
		const status = resp.status();
		if (status >= 400 && /\/api\//.test(url)) {
			errors.http.push(`${status} ${resp.request().method()} ${url.replace(BASE, '')}`);
		}
	});

	try {
		await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
		await page.waitForTimeout(3000);
		await page.screenshot({ path: `/tmp/dn-audit-${slug}.png`, fullPage: false });
	} catch (err) {
		errors.pageerror.push(`navigation: ${err.message}`);
	}

	await ctx.close();
	return { slug, path, errors };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
for (const p of PAGES) {
	try {
		const r = await auditPage(browser, p);
		results.push(r);
	} catch (e) {
		results.push({ slug: p.slug, path: p.path, errors: { pageerror: ['outer: ' + e.message], console: [], http: [], unmocked: [] } });
	}
}
await browser.close();

console.log('\n===== DASHBOARD-NEXT AUDIT =====\n');
for (const { slug, path, errors } of results) {
	const total = errors.pageerror.length + errors.console.length + errors.http.length + errors.unmocked.length;
	console.log(`── ${slug.padEnd(9)} ${path}  [${total} issues]`);
	if (errors.pageerror.length) {
		console.log('  pageerror:');
		for (const e of errors.pageerror) console.log('    • ' + e);
	}
	if (errors.console.length) {
		console.log('  console.error:');
		for (const e of errors.console) console.log('    • ' + e);
	}
	if (errors.http.length) {
		console.log('  http >=400:');
		for (const e of errors.http) console.log('    • ' + e);
	}
	if (errors.unmocked.length) {
		console.log('  unmocked endpoints (returned 404):');
		for (const e of errors.unmocked) console.log('    • ' + e);
	}
	console.log('');
}
