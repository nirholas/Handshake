#!/usr/bin/env node
/**
 * capture-pipeline-studio.mjs
 *
 * Drives the Pipeline Studio (/cookbook/pipeline) through a real end-to-end run
 * in a real browser, then screenshots the result.
 *
 * This is both the page's verification harness and the source of its
 * documentation figures, deliberately. The Studio's whole claim is that it runs
 * the actual pipeline against the actual free API, so the only honest picture of
 * it is one taken after it really did that. Nothing here seeds state, stubs a
 * response, or fakes a verdict: it types prompts, presses Run, and waits for the
 * models to come back from the same GPU lane a visitor would hit.
 *
 * It also fails loudly on console errors and on a run that produces no models,
 * so a regression in the page shows up here before it ships.
 *
 *   node scripts/capture-pipeline-studio.mjs                     # against prod
 *   BASE_URL=http://localhost:3001 node scripts/capture-pipeline-studio.mjs
 *   node scripts/capture-pipeline-studio.mjs --prompts "a red clay mug"
 *
 * Output: public/cookbook/media/*.png, referenced from the cookbook docs as
 * `figure:img:` directives and picked up by scripts/capture-tutorial-media.mjs.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');
const OUT_DIR = resolve(ROOT, 'public/cookbook/media');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

// Three single-subject prompts: what the free draft lane is actually good at,
// and enough of them to show the worker pool doing more than one thing at once.
const PROMPTS = opt(
	'prompts',
	['a clay flower pot with a saucer', 'a woven wicker basket', 'a brass watering can'].join('\n'),
);

// A draft is 60 to 120 seconds and three of them run at once, so one wave plus
// generous headroom for a busy shared lane.
const RUN_TIMEOUT_MS = Number(opt('timeout', 8 * 60 * 1000));

async function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		deviceScaleFactor: 2,
		colorScheme: 'dark',
		reducedMotion: 'reduce',
	});
	// Start from a clean slate so the run captured is the run this script did,
	// not something a previous session left in localStorage.
	await context.addInitScript(`try{localStorage.removeItem('threews.pipeline-studio.v1')}catch(e){}`);

	const page = await context.newPage();
	const consoleErrors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text());
	});
	page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

	// "Failed to load resource" without a URL is an unactionable console line, so
	// record which request actually failed. Session probes are excluded: the nav
	// asks who you are on every page and a signed-out 401 is the correct answer.
	const badResponses = [];
	page.on('response', (res) => {
		if (res.status() < 400) return;
		const url = res.url();
		if (/\/api\/(auth|user|session|me)\b/.test(url)) return;
		badResponses.push(`HTTP ${res.status()} ${url.replace(BASE_URL, '')}`);
	});

	const failures = [];
	try {
		const url = `${BASE_URL}/cookbook/pipeline`;
		console.log(`opening ${url}`);
		const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
		if (!res || res.status() >= 400) throw new Error(`${url} returned HTTP ${res && res.status()}`);

		// The page has to be usable before it is photogenic.
		await page.waitForSelector('#pl-run', { state: 'visible', timeout: 20000 });
		await page.waitForSelector('.nav a', { timeout: 20000 });
		const navLinks = await page.locator('header a').count();
		if (navLinks < 10) failures.push(`site navigation did not mount (${navLinks} header links)`);

		const presets = await page.locator('.pl-preset').count();
		if (presets < 1) failures.push('no preset packs rendered');

		const prefilled = await page.locator('#pl-prompts').inputValue();
		if (!prefilled.trim()) failures.push('the prompt box arrived empty; it should open on a working pack');

		// Tooltips: hover the first hint and confirm it actually says something.
		await page.locator('.pl-hint').first().hover();
		await page.waitForTimeout(300);
		const tipText = (await page.locator('#pl-tip').textContent()) || '';
		if (tipText.trim().length < 20) failures.push('the first tooltip rendered empty');
		await page.keyboard.press('Escape');

		await page.fill('#pl-prompts', PROMPTS);
		const wanted = PROMPTS.split('\n').filter(Boolean).length;

		console.log(`running ${wanted} prompt(s) against ${BASE_URL} for real, this takes a couple of minutes`);
		const started = Date.now();
		await page.click('#pl-run');

		// Mid-run frame: at least one model finished and at least one is still
		// working. Worth its own figure because it shows the pool in motion.
		let midShot = null;
		const midDeadline = Date.now() + RUN_TIMEOUT_MS;
		while (Date.now() < midDeadline) {
			const done = await page.locator('.pl-card[data-status="pass"], .pl-card[data-status="fail"]').count();
			const busy = await page
				.locator('.pl-card[data-status="generating"], .pl-card[data-status="rendering"], .pl-card[data-status="inspecting"]')
				.count();
			if (done >= 1 && busy >= 1) {
				midShot = await page.locator('.pl-results').screenshot({ type: 'png' });
				console.log(`  mid-run frame captured at ${Math.round((Date.now() - started) / 1000)}s`);
				break;
			}
			if (done >= wanted) break;
			await page.waitForTimeout(2000);
		}

		// Then wait for the whole run to settle.
		await page.waitForFunction(
			(n) => document.querySelectorAll('.pl-card[data-status="pass"], .pl-card[data-status="fail"], .pl-card[data-status="error"]').length >= n,
			wanted,
			{ timeout: RUN_TIMEOUT_MS },
		);
		const elapsed = Math.round((Date.now() - started) / 1000);
		console.log(`  run finished in ${elapsed}s`);

		const built = await page.locator('.pl-card[data-status="pass"], .pl-card[data-status="fail"]').count();
		const broke = await page.locator('.pl-card[data-status="error"]').count();
		console.log(`  ${built} model(s) built, ${broke} failed to build`);
		if (built === 0) failures.push('the run produced no models at all');

		// The export panel only appears when there is something to export.
		if (built > 0 && (await page.locator('#pl-export').isHidden())) {
			failures.push('models were built but the export panel stayed hidden');
		}
		const repro = (await page.locator('#pl-repro').textContent()) || '';
		if (built > 0 && !repro.includes('asset_gate.py')) {
			failures.push('the reproduce block did not include the gate command');
		}

		// Let the stills finish decoding before the hero shot.
		await page.waitForTimeout(1500);
		await page.evaluate(() => window.scrollTo(0, 0));

		const shots = [
			['pipeline-studio-run.png', await page.locator('.pl-shell').screenshot({ type: 'png' })],
			['pipeline-studio-results.png', await page.locator('.pl-results').screenshot({ type: 'png' })],
			['pipeline-studio-controls.png', await page.locator('.pl-rail').screenshot({ type: 'png' })],
		];
		if (midShot) shots.push(['pipeline-studio-midrun.png', midShot]);

		for (const [name, buf] of shots) {
			const out = resolve(OUT_DIR, name);
			writeFileSync(out, buf);
			console.log(`  wrote public/cookbook/media/${name}  ${(buf.length / 1024).toFixed(0)} KB`);
		}
	} finally {
		await context.close();
		await browser.close();
	}

	// model-viewer and third-party CDNs are noisy on unrelated pages; only the
	// Studio's own failures matter, and it loads no third-party script.
	if (consoleErrors.length) {
		console.error(`\n${consoleErrors.length} console error(s):`);
		for (const e of consoleErrors.slice(0, 12)) console.error(`  ${e}`);
		failures.push(`${consoleErrors.length} console error(s)`);
	}

	if (failures.length) {
		console.error(`\ncapture-pipeline-studio: ${failures.length} problem(s):`);
		for (const f of failures) console.error(`  ${f}`);
		process.exit(1);
	}
	console.log('\ncapture-pipeline-studio: the Studio ran end to end and every check passed.');
}

main().catch((err) => {
	console.error(`capture-pipeline-studio: ${err.message}`);
	process.exit(1);
});
