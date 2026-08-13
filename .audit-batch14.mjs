import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const PATHS = [
	'/docs/sdk',
	'/docs/listings',
	'/tutorials',
	'/walkthroughs',
	'/walkthroughs/forge-your-first-3d-model',
	'/walkthroughs/build-your-first-agent',
	'/walkthroughs/embed-a-3d-avatar',
	'/walkthroughs/find-an-agent-worth-using',
];

const browser = await chromium.launch();
const report = [];

for (const path of PATHS) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const consoleErrors = [];
	const pageErrors = [];
	const failedRequests = [];

	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') {
			consoleErrors.push(`[${m.type()}] ${m.text()}`);
		}
	});
	page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
	page.on('requestfailed', (r) => {
		failedRequests.push(`${r.url()} :: ${(r.failure() || {}).errorText}`);
	});
	page.on('response', (r) => {
		if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
	});

	let status = 0;
	try {
		const resp = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 });
		status = resp ? resp.status() : 0;
	} catch (err) {
		pageErrors.push(`navigation: ${err.message}`);
	}

	await page.waitForTimeout(2500);

	const meta = await page.evaluate(() => ({
		title: document.title,
		description: (document.querySelector('meta[name="description"]') || {}).content || null,
		canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
		links: Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')),
		anchorIds: Array.from(document.querySelectorAll('[id]')).map((e) => e.id),
		bodyTextLen: (document.body.innerText || '').length,
		h1: (document.querySelector('h1') || {}).innerText || null,
	}));

	report.push({ path, status, consoleErrors, pageErrors, failedRequests, meta });
	await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
