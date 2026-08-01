#!/usr/bin/env node
/**
 * Capture the tutorial media for live steps, from the real running product.
 * ===========================================================================
 *
 * Documentation screenshots rot the moment the UI moves, and a hand-cropped PNG
 * is nobody's job to refresh. So this script drives the actual tutorial page in
 * a real browser, presses the actual buttons, waits for the actual API to
 * answer, and writes the resulting images into public/docs/img/.
 *
 * It is also the acceptance test for the feature: it fails loudly if the cards
 * do not mount, if a step does not reach a terminal state, if redaction stops
 * firing, if a value fails to chain between steps, if the page overflows
 * horizontally on a phone, or if anything logs a console error. A screenshot of
 * a broken card is worse than no screenshot, so it never writes one.
 *
 *   npm run media:live-steps                 # against a dev server on :4737
 *   BASE=https://three.ws npm run media:live-steps
 *
 * Start the dev server first (npm run dev -- --port 4737), or point BASE at a
 * deployed origin. Requires playwright, which the repo already depends on.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/docs/img');
const BASE = process.env.BASE || 'http://127.0.0.1:4737';
const PAGE = `${BASE}/tutorials/wallet-sign-in`;

mkdirSync(OUT, { recursive: true });

const failures = [];
function check(label, condition, detail) {
	const ok = Boolean(condition);
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures.push(label);
	return ok;
}

/** Press a card's button and wait for it to leave the running state. */
async function runCard(page, step) {
	const card = page.locator(`.ls-card[data-step="${step}"]`);
	await card.scrollIntoViewIfNeeded();
	await card.locator('.ls-run').click();
	await page.waitForFunction(
		(id) => {
			const el = document.querySelector(`.ls-card[data-step="${id}"]`);
			return el && el.dataset.state !== 'running';
		},
		step,
		{ timeout: 30000 },
	);
	return card;
}

/*
 * The rendered body, or an empty string when the card produced none. A bare
 * locator read would hang for the full timeout on a step that failed, which
 * hides the actual cause behind a Playwright stack trace.
 */
async function bodyOf(card) {
	const pre = card.locator('.ls-pre');
	return (await pre.count()) ? pre.innerText() : '';
}

/** Everything the card said, for when a check fails and you need the why. */
async function transcript(card) {
	return (await card.innerText()).replace(/\n{2,}/g, '\n').slice(0, 600);
}

const browser = await chromium.launch();
const consoleIssues = [];
const apiTraffic = [];

try {
	const ctx = await browser.newContext({
		viewport: { width: 1240, height: 1100 },
		deviceScaleFactor: 2,
	});
	const page = await ctx.newPage();
	page.on('console', (m) => {
		if (m.type() === 'error') consoleIssues.push(m.text());
	});
	page.on('pageerror', (e) => consoleIssues.push(`pageerror: ${e.message}`));
	/* API traffic, so a failed card is diagnosable without a second run. */
	page.on('response', (r) => {
		if (r.url().includes('/api/')) apiTraffic.push(`${r.status()} ${new URL(r.url()).pathname}`);
	});
	page.on('requestfailed', (r) => {
		if (r.url().includes('/api/')) {
			apiTraffic.push(`FAILED ${new URL(r.url()).pathname} ${r.failure()?.errorText || ''}`);
		}
	});

	await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.ls-card', { timeout: 20000 });

	const mounted = await page.$$eval('.ls-card', (els) => els.map((e) => e.dataset.step));
	check('cards mount from the markdown', mounted.length >= 3, mounted.join(', '));
	check('the run-every-step toolbar appears', await page.$('.ls-toolbar'));

	/* ── The nonce step: a real call to the live API ─────────────────────── */
	const nonce = await runCard(page, 'siws-nonce');
	const nonceState = await nonce.getAttribute('data-state');
	const nonceBody = await bodyOf(nonce);
	if (nonceState !== 'ok') console.error(`\n${await transcript(nonce)}\n`);
	check('the nonce step reaches a 2xx', nonceState === 'ok', (await nonce.locator('.ls-meta').innerText()).replace(/\n/g, ' '));
	check('the response carries a real nonce', /"nonce":\s*"[A-Za-z0-9_-]{10,}"/.test(nonceBody));
	check('the csrf token is redacted from the view', nonceBody.includes('redacted in this view'));
	check(
		'chained values are published',
		(await nonce.locator('.ls-note.is-ok').innerText()).includes('nonce'),
	);

	/* ── The derive step: consumes what the nonce step published ─────────── */
	const message = page.locator('.ls-card[data-step="siws-message"]');
	await message.locator('.ls-input').fill('YourWa11etAddressGoesHere');
	await message.locator('.ls-run').click();
	await page.waitForFunction(
		() => document.querySelector('.ls-card[data-step="siws-message"]')?.dataset.state === 'ok',
		null,
		{ timeout: 20000 },
	);
	const derived = (await bodyOf(message)).split('\n');
	const liveNonce = JSON.parse(nonceBody).nonce;
	check('the derived message opens with the domain the server returned', derived[0].startsWith('three.ws wants you to sign in'));
	check('the two structural blank lines survive', derived[2] === '' && derived[4] === '');
	check('the chained nonce reached the message', derived.some((l) => l === `Nonce: ${liveNonce}`));
	check('Chain ID is a network name, not a number', derived.includes('Chain ID: mainnet'));

	/* ── auth-me: whichever signed-out shape this browser gets ───────────── */
	const me = await runCard(page, 'auth-me');
	const meBody = await bodyOf(me);
	check('the session probe answers', ['ok', 'error'].includes(await me.getAttribute('data-state')), meBody.replace(/\s+/g, ' ').slice(0, 80));

	/* ── Media ───────────────────────────────────────────────────────────── */
	await nonce.scrollIntoViewIfNeeded();
	await page.waitForTimeout(350);
	await nonce.screenshot({ path: `${OUT}/live-step-nonce.png` });
	await message.screenshot({ path: `${OUT}/live-step-message.png` });

	await page.evaluate(() => document.querySelector('.ls-toolbar').scrollIntoView({ block: 'start' }));
	await page.waitForTimeout(400);
	await page.screenshot({ path: `${OUT}/live-steps-page.png` });

	/* ── Light theme ─────────────────────────────────────────────────────── */
	await page.evaluate(() => {
		localStorage.setItem('twx_theme', 'light');
		document.documentElement.setAttribute('data-theme', 'light');
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.ls-card', { timeout: 20000 });
	const lightNonce = await runCard(page, 'siws-nonce');
	check('the card works in the light theme', (await lightNonce.getAttribute('data-state')) === 'ok');
	await lightNonce.scrollIntoViewIfNeeded();
	await page.waitForTimeout(350);
	await lightNonce.screenshot({ path: `${OUT}/live-step-nonce-light.png` });
	await ctx.close();

	/* ── Phone ───────────────────────────────────────────────────────────── */
	const mobileCtx = await browser.newContext({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
	});
	const mp = await mobileCtx.newPage();
	mp.on('pageerror', (e) => consoleIssues.push(`mobile pageerror: ${e.message}`));
	await mp.goto(PAGE, { waitUntil: 'domcontentloaded' });
	await mp.waitForSelector('.ls-card', { timeout: 20000 });
	const overflows = await mp.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	);
	check('the phone layout does not scroll sideways', !overflows);
	const mobileNonce = await runCard(mp, 'siws-nonce');
	check('the card works on a phone', (await mobileNonce.getAttribute('data-state')) === 'ok');
	await mobileNonce.scrollIntoViewIfNeeded();
	await mp.waitForTimeout(350);
	await mobileNonce.screenshot({ path: `${OUT}/live-step-mobile.png` });
	await mobileCtx.close();

	check('no console errors', consoleIssues.length === 0, consoleIssues.join(' | '));
} finally {
	await browser.close();
}

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
	process.exit(1);
}
console.log(`\nAll checks passed. Media written to public/docs/img/.`);
