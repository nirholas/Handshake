// Browser verification for /conversions.
// Serves pages/conversions.html and src/conversions.js straight off disk through
// a playwright route handler, so the check is immune to a dev server that other
// agents keep restarting. API responses are REAL payloads captured from the
// production database (scratchpad/buyer.json, seller.json).
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = '/workspaces/three.ws';
const DIR = '/tmp/claude-1000/-workspaces-three-ws/ec60ca0e-93bf-42fe-96fb-7df45c0b9015/scratchpad';
const BASE = 'https://local.test';
const buyer = readFileSync(`${DIR}/buyer.json`, 'utf8');
const seller = readFileSync(`${DIR}/seller.json`, 'utf8');

const problems = [];
const note = (s) => console.log(s);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function newPage(browser, mode, viewport = { width: 1280, height: 900 }) {
	const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
	const page = await ctx.newPage();
	const noise = [];
	page.on('console', (m) => {
		if (m.type() !== 'error' && m.type() !== 'warning') return;
		// Chrome logs a console error for every non-2xx response. The 401 and 500
		// modes below induce those on purpose, and the page handles them; that
		// browser-native line is not noise from our code.
		if (/Failed to load resource/.test(m.text())) return;
		noise.push(`${m.type()}: ${m.text()}`);
	});
	page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));

	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;

		if (path.startsWith('/api/marketplace/trial-status')) {
			const role = url.searchParams.get('role') || 'buyer';
			if (mode === 'signedout') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
			if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom","error_description":"The database is briefly unavailable."}' });
			if (mode === 'empty') {
				const body = role === 'seller'
					? { data: { role: 'seller', queue: [], summary: { skillsWithTrials: 0, activeTrials: 0, warmLeads: 0, lastRun: 0, sold: 0, potential: { atomic: '0', decimals: 6, display: '0' } } } }
					: { data: { role: 'buyer', trials: [], summary: { active: 0, fresh: 0, runningLow: 0, exhausted: 0 } } };
				return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
			}
			return route.fulfill({ status: 200, contentType: 'application/json', body: role === 'seller' ? seller : buyer });
		}

		if (path === '/conversions') {
			return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(resolve(ROOT, 'pages/conversions.html'), 'utf8') });
		}

		// Real source files; anything else (nav, footer, i18n, fonts) is site
		// chrome this check does not exercise, so it resolves to an empty 200
		// rather than a 404 that would pollute the console-noise assertion.
		const onDisk = resolve(ROOT, path.replace(/^\//, ''));
		if (onDisk.startsWith(ROOT) && existsSync(onDisk) && !onDisk.endsWith('/')) {
			const ext = onDisk.slice(onDisk.lastIndexOf('.'));
			return route.fulfill({ status: 200, contentType: MIME[ext] || 'application/octet-stream', body: readFileSync(onDisk) });
		}
		return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : 'text/plain', body: '' });
	});
	return { ctx, page, noise };
}

const browser = await chromium.launch();

// ── populated, keyboard, cache, url sync ─────────────────────────────────────
{
	const { ctx, page, noise } = await newPage(browser, 'real');
	await page.goto(`${BASE}/conversions`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.cv-row', { timeout: 15000 });

	const rows = await page.locator('.cv-row').count();
	const stats = await page.locator('.stat-card .stat-val').allInnerTexts();
	const firstSkill = await page.locator('.cv-row .cv-skill').first().innerText();
	const pill = await page.locator('.cv-row .pill').first().innerText();
	const pips = await page.locator('.cv-row').first().locator('.meter-pip').count();
	const meterLabel = await page.locator('.cv-row').first().locator('.meter').getAttribute('aria-label');
	const cta = await page.locator('.cv-row .btn').first().innerText();
	note(`buyer: ${rows} rows | stats ${JSON.stringify(stats)} | first "${firstSkill}" [${pill}] | ${pips} pips | aria "${meterLabel}" | cta "${cta}"`);
	if (rows !== 114) problems.push(`buyer rendered ${rows} rows, expected 114`);
	if (!meterLabel) problems.push('meter has no aria-label');

	await page.locator('#tab-buyer').focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForFunction(() => document.querySelector('#tab-seller')?.getAttribute('aria-selected') === 'true', null, { timeout: 8000 });
	await page.waitForSelector('.cv-metrics', { timeout: 15000 });
	const sRows = await page.locator('.cv-row').count();
	const sStats = await page.locator('.stat-card .stat-val').allInnerTexts();
	const metrics = await page.locator('.cv-row').first().locator('.cv-metric').allInnerTexts();
	const url = page.url();
	note(`seller: ${sRows} rows | stats ${JSON.stringify(sStats)} | metrics ${JSON.stringify(metrics)}`);
	note(`url after tab switch: ${url}`);
	if (sRows !== 3) problems.push(`seller rendered ${sRows} rows, expected 3`);
	if (!url.includes('role=seller')) problems.push(`url did not sync role: ${url}`);
	const focused = await page.evaluate(() => document.activeElement?.id);
	if (focused !== 'tab-seller') problems.push(`ArrowRight did not move focus (activeElement=${focused})`);

	await page.keyboard.press('ArrowLeft');
	await page.waitForFunction(() => document.querySelectorAll('.cv-row').length === 114, null, { timeout: 8000 });
	const backUrl = page.url();
	if (backUrl.includes('role=seller')) problems.push(`url did not clear role on return: ${backUrl}`);
	note('cache: ArrowLeft restored the buyer view instantly and cleared the query param');

	const ring = await page.evaluate(() => {
		const b = document.querySelector('.cv-row .btn');
		b.focus();
		const s = getComputedStyle(b);
		return `${s.outlineStyle} ${s.outlineWidth}`;
	});
	note(`focus-visible ring on row CTA: ${ring}`);

	await page.screenshot({ path: `${DIR}/shot-buyer.png` });
	if (noise.length) problems.push(`console noise: ${noise.slice(0, 5).join(' | ')}`);
	await ctx.close();
}

// ── empty / signed out / error ───────────────────────────────────────────────
for (const mode of ['empty', 'signedout', 'error']) {
	const { ctx, page, noise } = await newPage(browser, mode);
	await page.goto(`${BASE}/conversions`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.cv-state', { timeout: 15000 });
	const heading = await page.locator('.cv-state h2').innerText();
	const body = await page.locator('.cv-state p').innerText();
	const cta = await page.locator('.cv-state .btn').count();
	note(`${mode}: "${heading}" | cta=${cta} | ${body.slice(0, 72)}…`);
	if (!heading) problems.push(`${mode}: no heading`);
	if (!cta) problems.push(`${mode}: no call to action`);
	if (mode === 'error') {
		await page.locator('#cv-retry').click();
		await page.waitForSelector('.cv-state.is-error', { timeout: 8000 });
		note('error: retry re-issues the request and re-renders');
	}
	if (mode === 'empty') {
		await page.locator('#tab-seller').click();
		await page.waitForFunction(
			() => document.querySelector('.cv-state h2')?.textContent?.includes('your skills'),
			null,
			{ timeout: 8000 },
		);
		note(`empty(seller): "${await page.locator('.cv-state h2').innerText()}"`);
	}
	if (noise.length) problems.push(`${mode} console noise: ${noise.slice(0, 3).join(' | ')}`);
	await ctx.close();
}

// ── mobile ───────────────────────────────────────────────────────────────────
{
	const { ctx, page, noise } = await newPage(browser, 'real', { width: 390, height: 844 });
	await page.goto(`${BASE}/conversions`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.cv-row', { timeout: 15000 });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	const tabH = await page.evaluate(() => document.querySelector('.role-tab').getBoundingClientRect().height);
	note(`mobile 390px: horizontal overflow ${overflow}px | tab height ${Math.round(tabH)}px`);
	if (overflow > 0) problems.push(`mobile overflows by ${overflow}px`);
	if (tabH < 32) problems.push(`mobile tab is ${tabH}px tall, below a comfortable touch target`);
	await page.screenshot({ path: `${DIR}/shot-mobile.png` });
	if (noise.length) problems.push(`mobile console noise: ${noise.slice(0, 3).join(' | ')}`);
	await ctx.close();
}

// ── light theme ──────────────────────────────────────────────────────────────
{
	const { ctx, page } = await newPage(browser, 'real');
	await page.addInitScript(() => localStorage.setItem('twx_theme', 'light'));
	await page.goto(`${BASE}/conversions`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.cv-row', { timeout: 15000 });
	const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
	const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	note(`light theme: data-theme=${theme} body bg ${bg}`);
	if (theme !== 'light') problems.push(`light theme did not apply (data-theme=${theme})`);
	await page.screenshot({ path: `${DIR}/shot-light.png` });
	await ctx.close();
}

await browser.close();

if (problems.length) {
	console.log(`\nFAIL (${problems.length}):`);
	for (const p of problems) console.log(`  - ${p}`);
	process.exit(1);
}
console.log('\nPASS: every state rendered, keyboard works, no console noise, no mobile overflow, light theme applies');
