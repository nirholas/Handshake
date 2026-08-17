#!/usr/bin/env node
// Capture the real screenshots used by docs/skill-bundles.md.
//
// The docs show what the page actually looks like, so the images are taken from
// the running page rather than drawn. Regenerating them is one command, which is
// what keeps them from going stale the first time the layout changes.
//
//   npm run dev                       # in another shell
//   node scripts/capture-bundles-media.mjs
//   node scripts/capture-bundles-media.mjs --base https://three.ws
//
// Signed-out states are captured as-is. The authenticated builder needs the QA
// account in .env (AUDIT_EMAIL / AUDIT_PASSWORD); without it the script captures
// the states it can reach and says which ones it skipped, rather than failing.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/docs/img');

const args = process.argv.slice(2);
const base = (args[args.indexOf('--base') + 1] || '').startsWith('http')
	? args[args.indexOf('--base') + 1]
	: 'http://localhost:3000';

const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

mkdirSync(OUT, { recursive: true });

const shots = [];
const skipped = [];

async function shot(page, name, opts = {}) {
	const file = resolve(OUT, `${name}.png`);
	await page.screenshot({ path: file, ...opts });
	shots.push(name);
	console.log(`  wrote public/docs/img/${name}.png`);
}

const browser = await chromium.launch();
try {
	// ── signed out: the gate that explains why sign-in is needed ──────────
	const anon = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
	const page = await anon.newPage();
	await page.goto(`${base}/bundles`, { waitUntil: 'networkidle' });
	await page.waitForSelector('#bd-gate:not(.bd-hide), #bd-builder:not(.bd-hide)', { timeout: 15000 });
	console.log('signed-out view');
	await shot(page, 'bundles-signed-out', { clip: { x: 0, y: 0, width: 1280, height: 760 } });

	// ── phone layout: the steps and gate have to survive 390px ────────────
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
	const mob = await phone.newPage();
	await mob.goto(`${base}/bundles`, { waitUntil: 'networkidle' });
	await mob.waitForSelector('#bd-gate:not(.bd-hide), #bd-builder:not(.bd-hide)', { timeout: 15000 });
	console.log('phone layout');
	await shot(mob, 'bundles-mobile', { fullPage: false });
	await phone.close();
	await anon.close();

	// ── authenticated builder + pricing panel ─────────────────────────────
	if (!EMAIL || !PASSWORD) {
		skipped.push('bundles-builder', 'bundles-pricing');
		console.log('no AUDIT_EMAIL / AUDIT_PASSWORD in env: skipping the authenticated shots');
	} else {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
		const p = await ctx.newPage();
		await p.goto(`${base}/login?next=%2Fbundles`, { waitUntil: 'networkidle' });
		// The classic email/password form by id, not by input type. /login also
		// renders a Privy passwordless widget whose own `input[type="email"]`
		// comes first in the DOM, so a type-based selector filled that one
		// instead and every authenticated shot below was silently skipped.
		await p.waitForSelector('#email', { timeout: 20000 });
		await p.fill('#email', EMAIL);
		await p.fill('#password', PASSWORD);
		await p.click('form button[type="submit"]');
		await p.waitForURL(/\/bundles/, { timeout: 30000 }).catch(() => {});
		await p.waitForSelector('#bd-builder:not(.bd-hide), #bd-gate:not(.bd-hide)', { timeout: 20000 });

		if (await p.locator('#bd-builder:not(.bd-hide)').count()) {
			console.log('authenticated builder');
			await shot(p, 'bundles-builder', { clip: { x: 0, y: 0, width: 1280, height: 900 } });

			// Select the first two skills so the pricing panel has something to price.
			const boxes = p.locator('#bd-skills input[type="checkbox"]');
			if ((await boxes.count()) >= 2) {
				await boxes.nth(0).check();
				await boxes.nth(1).check();
				await p.waitForSelector('#bd-price-body:not(.bd-hide)', { timeout: 20000 });
				await p.locator('#bd-price-h').scrollIntoViewIfNeeded();
				console.log('pricing panel');
				await shot(p, 'bundles-pricing', { clip: { x: 0, y: 0, width: 1280, height: 900 } });
			} else {
				skipped.push('bundles-pricing (the QA agent has fewer than 2 priced skills)');
			}
		} else {
			skipped.push('bundles-builder', 'bundles-pricing');
		}
		await ctx.close();
	}
} finally {
	await browser.close();
}

console.log(`\ncaptured ${shots.length}: ${shots.join(', ')}`);
if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
