// Full-sweep verifier — fresh browser per page, mocked auth.

import { chromium } from 'playwright';

const PAGES = [
	{ slug: '',          name: 'overview' },
	{ slug: 'avatars',   name: 'avatars'  },
	{ slug: 'widgets',   name: 'widgets'  },
	{ slug: 'library',   name: 'library'  },
	{ slug: 'api',       name: 'api'      },
	{ slug: 'monetize',  name: 'monetize' },
	{ slug: 'account',   name: 'account'  },
];

const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
const me = { id: 'test-user', display_name: 'Test User', handle: 'tester', email: 't@x.com', plan: 'pro' };

async function runPage({ slug, name }) {
	const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox','--disable-gpu'] });
	const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
	await ctx.route('**/api/auth/me',          (r) => r.fulfill(json({ user: me })));
	await ctx.route('**/api/csrf-token',       (r) => r.fulfill(json({ token: 'test-csrf' })));
	await ctx.route('**/api/avatars*',         (r) => r.fulfill(json({ avatars: [], next_cursor: null })));
	await ctx.route('**/api/widgets*',         (r) => r.fulfill(json({ widgets: [] })));
	await ctx.route('**/api/agents*',          (r) => r.fulfill(json({ agents: [] })));
	await ctx.route('**/api/keys*',            (r) => r.fulfill(json({ keys: [] })));
	await ctx.route('**/api/animations*',      (r) => r.fulfill(json({ animations: [] })));
	await ctx.route('**/api/billing/**',       (r) => r.fulfill(json({ revenue: 0, rows: [], series: [], summary: {}, withdrawals: [], wallets: [], plans: [] })));
	await ctx.route('**/api/notifications*',   (r) => r.fulfill(json({ notifications: [] })));
	await ctx.route('**/api/subscriptions/**', (r) => r.fulfill(json({ subscriptions: [], plans: [] })));
	await ctx.route('**/api/events*',          (r) => r.fulfill(json({ events: [] })));
	await ctx.route('**/api/users/**',         (r) => r.fulfill(json({ })));
	await ctx.route('**/api/me/**',            (r) => r.fulfill(json({ })));
	await ctx.route('**/api/strategy*',        (r) => r.fulfill(json({ strategy: null })));
	await ctx.route('**/api/memories*',        (r) => r.fulfill(json({ memories: [] })));
	await ctx.route('**/api/memory*',          (r) => r.fulfill(json({ memories: [] })));
	await ctx.route('**/api/voice*',           (r) => r.fulfill(json({ voices: [] })));
	await ctx.route('**/api/sessions*',        (r) => r.fulfill(json({ sessions: [] })));
	await ctx.route('**/api/auth/sessions*',   (r) => r.fulfill(json({ sessions: [] })));
	await ctx.route('**/api/auth/wallets*',    (r) => r.fulfill(json({ wallets: [] })));
	await ctx.route('**/api/embed-policy*',    (r) => r.fulfill(json({ policy: { hosts: [] } })));

	const p = await ctx.newPage();
	const errs = [];
	p.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message.slice(0, 240)}`));
	p.on('console',  (m) => { if (m.type() === 'error') errs.push(`[err] ${m.text().slice(0, 240)}`); });
	const url = `http://127.0.0.1:3010/dashboard-next${slug ? '/' + slug : ''}`;
	let status = 'OK';
	try {
		await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await p.waitForFunction(() => document.querySelector('.dn-shell .dn-rail-item') != null, { timeout: 20000 });
		await p.waitForTimeout(1800);
		await p.screenshot({ path: `/tmp/dn-sweep-${name}.png`, fullPage: false });
	} catch (e) {
		errs.push(`NAV/WAIT ${e.message.slice(0, 240)}`);
		status = 'FAILED';
	}
	const relevant = errs.filter((e) => /PAGEERROR|TypeError|ReferenceError|SyntaxError|Uncaught|NAV\/WAIT/.test(e));
	console.log(`${name}: ${relevant.length === 0 ? status : 'ERRORS'}`);
	for (const e of relevant) console.log(`  ${e}`);
	await b.close();
	return relevant.length;
}

let total = 0;
for (const page of PAGES) total += await runPage(page);
process.exit(total > 0 ? 1 : 0);
