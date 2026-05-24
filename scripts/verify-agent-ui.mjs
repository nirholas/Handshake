import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let failed = false;

async function checkPage(url, interact) {
	const page = await ctx.newPage();
	const errors = [];
	const failedReqs = [];
	page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
	page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));
	page.on('requestfailed', (req) => {
		const e = req.failure()?.errorText || 'unknown';
		if (!/aborted|cancelled/i.test(e)) failedReqs.push(`${req.url()} :: ${e}`);
	});

	console.log(`\n=== ${url} ===`);
	await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
	await page.waitForTimeout(2000);
	if (interact) await interact(page);
	await page.waitForTimeout(1000);

	if (errors.length) {
		console.log('errors:');
		for (const e of errors) console.log('  -', e);
		failed = true;
	}
	if (failedReqs.length) {
		console.log('failed requests:');
		for (const r of failedReqs) console.log('  -', r);
		failed = true;
	}
	const slug = url.split('/').pop().replace('.html', '');
	await page.screenshot({ path: `/tmp/agent-ui-${slug}.png` });
	await page.close();
}

await checkPage('http://localhost:3000/demos/404.html');

await checkPage('http://localhost:3000/demos/login.html', async (page) => {
	await page.click('#email');
	await page.waitForTimeout(900);
	await page.fill('#email', 'test@three.ws');
	await page.waitForTimeout(700);
	await page.click('#password');
	await page.waitForTimeout(1000);
	await page.fill('#password', 'wrong');
	await page.click('#submit-btn');
	await page.waitForTimeout(1400);
	await page.screenshot({ path: '/tmp/agent-ui-login-after-submit.png' });
});

await browser.close();
console.log(failed ? '\nFAIL' : '\nOK');
process.exit(failed ? 1 : 0);
