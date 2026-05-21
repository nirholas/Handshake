#!/usr/bin/env node
/**
 * Headless verification of the SaaS prologue on /home.
 * Loads the home page in Chromium against the running dev server, asserts:
 *  - .h-saas exists and is positioned ABOVE the parallax hero
 *  - hero h2 rendered, 12+ marquee items, 4 tabs, copy button present
 *  - no console errors
 * Saves a full-page screenshot to /tmp/home-saas.png for visual review.
 */

import { chromium } from 'playwright';
import { argv } from 'node:process';

const BASE = argv[2] || 'http://localhost:3000';
const OUT = argv[3] || '/tmp/home-saas.png';

const consoleErrors = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	deviceScaleFactor: 1,
});
const page = await ctx.newPage();

page.on('console', (msg) => {
	if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(1500);

const saas = page.locator('.h-saas').first();
if (!(await saas.isVisible())) throw new Error('FAIL: .h-saas not visible');

const saasBox = await saas.boundingBox();
const heroBox = await page.locator('.h-hero-act').first().boundingBox();
if (!saasBox || !heroBox) throw new Error('FAIL: layout box missing');
if (saasBox.y >= heroBox.y) {
	throw new Error(
		`FAIL: prologue (y=${saasBox.y}) not above parallax hero (y=${heroBox.y})`,
	);
}

const h1 = (await page.locator('.h-saas-h1').first().innerText()).trim();
if (h1.length < 10) throw new Error('FAIL: SaaS h1 empty');

const marks = await page.locator('.h-saas-marquee-track .h-saas-mark').count();
if (marks < 12) throw new Error(`FAIL: expected 12+ marquee items, got ${marks}`);

const tabs = page.locator('[data-saas-tabs] [role="tab"]');
const tabCount = await tabs.count();
if (tabCount !== 4) throw new Error(`FAIL: expected 4 tabs, got ${tabCount}`);

await tabs.nth(2).click();
await page.waitForTimeout(140);
const panelText = await page.locator('[data-saas-tabpanel]').innerText();
if (!/DAO/i.test(panelText)) throw new Error('FAIL: tab switch did not update panel');

const copyBtns = await page.locator('[data-saas-copy]').count();
if (copyBtns === 0) throw new Error('FAIL: no copy button');

const statsResp = await page.evaluate(async () => {
	try {
		const r = await fetch('/api/home-stats');
		const txt = await r.text();
		let body = null;
		try {
			body = JSON.parse(txt);
		} catch {
			body = txt.slice(0, 80);
		}
		return { ok: r.ok, status: r.status, body };
	} catch (e) {
		return { ok: false, status: 0, err: String(e) };
	}
});

if (consoleErrors.length) {
	console.warn('--- console errors observed ---');
	consoleErrors.slice(0, 10).forEach((e) => console.warn('  ', e));
}

await page.screenshot({ path: OUT, fullPage: true });

console.log(JSON.stringify({
	prologueY: Math.round(saasBox.y),
	heroY: Math.round(heroBox.y),
	prologueHeight: Math.round(saasBox.height),
	h1: h1.slice(0, 90),
	marqueeItems: marks,
	tabs: tabCount,
	copyButtons: copyBtns,
	stats: statsResp,
	consoleErrors: consoleErrors.length,
	screenshot: OUT,
}, null, 2));

await browser.close();
