#!/usr/bin/env node
/**
 * Logs into Adobe/Mixamo via Playwright and extracts the bearer token.
 * Saves MIXAMO_TOKEN to .env.local so fetch-mixamo-catalog.mjs can use it.
 *
 * Usage:
 *   node scripts/get-mixamo-token.mjs
 *   # reads ADOBE_EMAIL / ADOBE_PASSWORD from .env.local
 *
 * Adobe may send a verification code to your email — enter it when prompted.
 */

import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ENV_PATH = join(process.cwd(), '.env.local');

function loadEnv() {
	const env = {};
	if (existsSync(ENV_PATH)) {
		for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
			const m = line.match(/^([A-Z_]+)=(.*)$/);
			if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
		}
	}
	return env;
}

function saveToken(token) {
	let contents = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
	if (contents.includes('MIXAMO_TOKEN=')) {
		contents = contents.replace(/^MIXAMO_TOKEN=.*$/m, `MIXAMO_TOKEN=${token}`);
	} else {
		contents = contents.trimEnd() + `\nMIXAMO_TOKEN=${token}\n`;
	}
	writeFileSync(ENV_PATH, contents);
	console.log('✅ MIXAMO_TOKEN saved to .env.local');
}

// Adobe's "Verify your identity" step is two screens: a confirmation screen
// ("we'll send you a code to n***@g***.com" + Continue button) that must be
// clicked before the email actually goes out, then the real code-entry screen.
// Detect which one we're on and only prompt for a code once inputs exist.
async function handleVerification(page, label) {
	let bodyText = await page.innerText('body').catch(() => '');
	if (!/Verify|verification|code/i.test(bodyText)) return bodyText;

	const hasCodeInput = await page
		.$('input[name="code"], input[aria-label*="code" i], input[placeholder*="code" i], input[type="text"], input[type="number"], input[inputmode="numeric"]')
		.then(Boolean)
		.catch(() => false);

	if (!hasCodeInput) {
		const continueBtn = await page.$('button:has-text("Continue")');
		if (continueBtn) {
			console.log(`   ${label}: confirmation screen — clicking Continue to trigger the email...`);
			await continueBtn.click();
			await page.waitForTimeout(3000);
			bodyText = await page.innerText('body').catch(() => '');
		}
	}

	if (/Verify|verification|code/i.test(bodyText)) {
		console.log(`\n📧 Adobe sent a verification code to your email (${label}).`);
		const code = await prompt('   Enter the code: ');
		await fillOtp(page, code);
		await page.waitForTimeout(3000);
		bodyText = await page.innerText('body').catch(() => '');
	}
	return bodyText;
}

async function fillOtp(page, code) {
	const single = await page.$('input[name="code"], input[aria-label*="code" i], input[placeholder*="code" i]');
	if (single) {
		await single.fill(code);
	} else {
		// Split-box OTP (one <input> per digit, type varies: text/tel/number/none).
		// fill()-ing each box programmatically skips the input events these UIs use
		// to auto-advance focus, so only the first box ever lands a digit. Instead
		// click the first box and type the whole code as real keystrokes — the
		// page's own JS advances focus per keystroke, same as a human typing it.
		let boxes = await page.$$('input:visible');
		if (boxes.length === 0) boxes = await page.$$('input');
		if (boxes.length >= code.length) {
			await boxes[0].click();
			await page.keyboard.type(code, { delay: 80 });
		} else if (boxes.length === 1) {
			await boxes[0].fill(code);
		}
	}
	await page.waitForTimeout(300);
	await page.click('button[type="submit"], button:has-text("Continue")').catch(() =>
		page.keyboard.press('Enter')
	);
}

const OTP_FILE = join(process.cwd(), '.mixamo-otp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prompt(question) {
	// A restarted process means a restarted login = a brand-new email that
	// invalidates whatever code was read from the previous one. So this must
	// NOT start a fresh process per code — it polls a file for the code while
	// the SAME browser session (which just sent the one and only email for
	// this run) stays open. Whoever has the code writes it to .mixamo-otp.
	if (process.env.ADOBE_OTP) {
		console.log(`${question}${process.env.ADOBE_OTP} (from ADOBE_OTP)`);
		return process.env.ADOBE_OTP.trim();
	}
	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input, output });
		const answer = await rl.question(question);
		rl.close();
		return answer.trim();
	}
	console.log(`${question}(waiting up to 4 min — write the code to ${OTP_FILE})`);
	try { rmSync(OTP_FILE, { force: true }); } catch {}
	for (let i = 0; i < 120; i++) {
		await sleep(2000);
		if (existsSync(OTP_FILE)) {
			const code = readFileSync(OTP_FILE, 'utf8').trim();
			if (code) {
				writeFileSync(OTP_FILE, '');
				return code;
			}
		}
	}
	throw new Error('timed out waiting for OTP code');
}

(async () => {
	const env = { ...loadEnv(), ...process.env };
	const email = env.ADOBE_EMAIL;
	const password = env.ADOBE_PASSWORD;

	if (!email || !password) {
		console.error('❌ ADOBE_EMAIL and ADOBE_PASSWORD must be set in .env.local');
		process.exit(1);
	}

	console.log(`🔐 Logging in as ${email}...`);

	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	let token = null;

	context.on('request', (req) => {
		const auth = req.headers()['authorization'];
		if (auth?.startsWith('Bearer ') && req.url().includes('mixamo.com')) {
			token = auth.slice(7);
		}
	});

	const page = await context.newPage();
	await page.goto('https://www.mixamo.com', { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2000);

	if (token) {
		console.log('✅ Already authenticated');
		saveToken(token);
		await browser.close();
		return;
	}

	// Click sign in button
	const signInSelectors = [
		'button:has-text("Log in")',
		'button:has-text("Sign In")',
		'a:has-text("Sign In")',
		'[data-id="sign-in"]',
	];

	let clicked = false;
	for (const sel of signInSelectors) {
		try {
			await page.click(sel, { timeout: 3000 });
			clicked = true;
			break;
		} catch { /* try next */ }
	}

	if (!clicked) {
		await page.screenshot({ path: 'scripts/debug-mixamo.png', fullPage: true });
		console.error('❌ Could not find Sign In button. Screenshot: scripts/debug-mixamo.png');
		await browser.close();
		process.exit(1);
	}

	// Handle popup or redirect
	let loginPage = page;
	try {
		const popup = await context.waitForEvent('page', { timeout: 5000 });
		loginPage = popup;
		console.log('   Popup detected');
	} catch { /* main page redirect */ }

	await loginPage.waitForURL(/adobeid|ims-na1|adobe\.com/, { timeout: 15000 }).catch(() => {});
	await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
	console.log(`   URL: ${loginPage.url()}`);
	await loginPage.screenshot({ path: 'scripts/debug-step1.png', fullPage: true });
	console.log('   Screenshot: scripts/debug-step1.png');

	// Step 1: Email
	console.log('   Filling email...');
	await loginPage.waitForSelector('input[type="email"]', { timeout: 15000, state: 'visible' });
	await loginPage.fill('input[type="email"]', email);
	await loginPage.screenshot({ path: 'scripts/debug-step2.png' });
	await loginPage.click('button[type="submit"]').catch(() => loginPage.keyboard.press('Enter'));
	await loginPage.waitForTimeout(3000);
	await loginPage.screenshot({ path: 'scripts/debug-step3.png' });
	console.log(`   After email submit URL: ${loginPage.url()}`);

	// Step 2 or 3: could be password, could be verify-identity, could be OTP
	let bodyText = await loginPage.innerText('body').catch(() => '');
	console.log(`   Page heading: ${bodyText.slice(0, 120).replace(/\n/g, ' ')}`);

	// Handle verification screen before password (some accounts see this first)
	bodyText = await handleVerification(loginPage, 'before password');
	await loginPage.screenshot({ path: 'scripts/debug-step4.png' });

	// Password step
	if (await loginPage.$('input[type="password"]').then(Boolean).catch(() => false)) {
		console.log('   Filling password...');
		await loginPage.fill('input[type="password"]', password, { force: true });
		await loginPage.click('button[type="submit"]').catch(() => loginPage.keyboard.press('Enter'));
		await loginPage.waitForTimeout(3000);
		await loginPage.screenshot({ path: 'scripts/debug-step5.png' });
		bodyText = await loginPage.innerText('body').catch(() => '');
		console.log(`   After password URL: ${loginPage.url()}`);
	}

	// Verification after password
	bodyText = await handleVerification(loginPage, 'after password');


	// Wait for redirect back to mixamo
	console.log('⏳ Waiting for authentication...');
	await page.waitForURL(/mixamo\.com/, { timeout: 30000 }).catch(() => {});
	await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

	if (!token) {
		await page.evaluate(() =>
			fetch('https://www.mixamo.com/api/v1/products?page=1&limit=1&type=Motion').catch(() => {})
		);
		await page.waitForTimeout(3000);
	}

	if (!token) {
		token = await page.evaluate(() =>
			localStorage.getItem('access_token') ||
			document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('access_token='))?.split('=')[1] ||
			null
		);
	}

	await browser.close();

	if (!token) {
		console.error('❌ Could not extract token.');
		console.error('   Manual fallback: log in at mixamo.com, open DevTools → Network,');
		console.error('   click any request to mixamo.com/api, copy the Authorization header');
		console.error('   (value after "Bearer "), and add to .env.local:');
		console.error('   MIXAMO_TOKEN=<paste-here>');
		process.exit(1);
	}

	console.log(`🎟  Token captured (${token.slice(0, 20)}...)`);
	saveToken(token);
})().catch((err) => {
	console.error('💥', err.message);
	process.exit(1);
});
