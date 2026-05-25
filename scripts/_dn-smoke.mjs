import { chromium } from 'playwright';

const URL_BASE = 'http://127.0.0.1:3010';
const PAGES = [
	{ slug: '',          name: 'home' },
	{ slug: '/avatars',  name: 'avatars' },
	{ slug: '/library',  name: 'library' },
	{ slug: '/widgets',  name: 'widgets' },
	{ slug: '/api',      name: 'api' },
	{ slug: '/monetize', name: 'monetize' },
	{ slug: '/account',  name: 'account' },
];

const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const handle = 'dnsmoke' + Date.now().toString(36);
const reg = await ctx.request.post(`${URL_BASE}/api/auth/register`, {
	data: { email: `${handle}@example.test`, password: 'PassP4ss!2026', display_name: 'Smoke Tester' },
	headers: { 'content-type': 'application/json' },
});
if (reg.status() !== 201 && reg.status() !== 200) {
	console.error('register failed', reg.status(), (await reg.text()).slice(0, 200));
	process.exit(1);
}

let failed = false;
for (const page of PAGES) {
	const p = await ctx.newPage();
	const errs = [];
	p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
	p.on('console',  m => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 200)); });
	p.on('requestfailed', r => {
		const url = r.url();
		if (url.includes('posthog') || url.includes('us-assets')) return;
		const ftext = r.failure()?.errorText || '';
		if (ftext === 'net::ERR_ABORTED' && url.includes('hot-update')) return;
		errs.push('REQ FAIL ' + url + ' ' + ftext);
	});

	const url = `${URL_BASE}/dashboard-next${page.slug}`;
	const out = `/tmp/dn-${page.name}.png`;
	try {
		await p.goto(url, { waitUntil: 'load', timeout: 60000 });
		await p.waitForTimeout(5500);
		await p.screenshot({ path: out, fullPage: false });
		console.log(`[ok ] ${page.name.padEnd(10)} → ${out}${errs.length ? '  ('+errs.length+' errors)' : ''}`);
	} catch (e) {
		console.log(`[FAIL] ${page.name}: ${e.message.slice(0, 200)}`);
		failed = true;
	}
	if (errs.length) {
		failed = true;
		console.log('  errors:');
		for (const e of errs) console.log('    ' + e);
	}
	await p.close();
}

await b.close();
process.exit(failed ? 1 : 0);
