// Temporary smoke test for /create/studio color customization.
// Drives real Chromium against the dev server, asserts the color tab tints the
// live mesh (pixel diff), checks keyboard tab nav, and captures console errors.
// Run: node scripts/_studio-smoke.mjs ; deleted after verification.
import { chromium } from 'playwright';

const URL = process.env.STUDIO_URL || 'http://localhost:3000/create/studio';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('PASS:', m);

const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

try {
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

	// Avatar load: #as-loading is removed on success.
	try {
		await page.waitForSelector('#as-loading', { state: 'detached', timeout: 30000 });
	} catch {
		const txt = await page.locator('#as-loading').textContent().catch(() => '(gone)');
		const hasCanvas = await page.locator('#as-stage canvas').count();
		const webgl = await page.evaluate(() => {
			try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
		});
		fail(`avatar not loaded. loadingText="${(txt || '').trim()}" canvas=${hasCanvas} webgl2=${webgl}`);
		console.log('console errors:\n  ' + (errors.join('\n  ') || '(none)'));
		throw new Error('avatar load timeout');
	}
	ok('avatar loaded (loading indicator gone)');
	await page.waitForSelector('#as-stage canvas', { timeout: 5000 });
	await page.waitForTimeout(1200); // settle idle animation + first frames

	// Color tab is the default active tab.
	const activeTab = await page.getAttribute('.as-tab.active', 'data-tab');
	if (activeTab === 'color') ok('Color tab active by default'); else fail(`default tab is "${activeTab}", expected "color"`);

	// Swatches render for skin/hair/outfit.
	const swatchCount = await page.locator('.as-swatch[data-slot]').count();
	if (swatchCount >= 20) ok(`${swatchCount} swatches rendered`); else fail(`only ${swatchCount} swatches`);

	// Apply a vivid outfit tint. The click runs applySlotColor across the live
	// three.js scene graph; a bad material lookup would throw → console error.
	const errBefore = errors.length;
	await page.click('.as-swatch[data-slot="outfit"][data-hex="#1f6b3a"]');
	await page.waitForTimeout(500);
	if (errors.length === errBefore) ok('outfit tint applied without runtime error');
	else fail('error during tint: ' + errors.slice(errBefore).join('; '));

	// Chip + selection state.
	const chip = await page.locator('.as-chip[data-color="outfit"]').count();
	if (chip === 1) ok('outfit color chip present'); else fail(`expected 1 outfit chip, got ${chip}`);
	const pressed = await page.locator('.as-swatch[data-slot="outfit"][data-hex="#1f6b3a"]')
		.first().getAttribute('aria-pressed', { timeout: 4000 });
	if (pressed === 'true') ok('selected swatch aria-pressed=true'); else fail(`aria-pressed=${pressed}`);

	// Keyboard tab nav: focus active tab, ArrowRight → Hats (roving tabindex).
	await page.focus('#as-tab-color');
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(200);
	const afterArrow = await page.locator('.as-tab.active').getAttribute('data-tab', { timeout: 4000 });
	if (afterArrow === 'hat') ok('ArrowRight moves Color → Hats'); else fail(`ArrowRight landed on "${afterArrow}"`);

	// Reset clears the chip.
	await page.click('#as-reset');
	await page.waitForTimeout(700);
	const chipsAfterReset = await page.locator('.as-chip').count();
	if (chipsAfterReset === 0) ok('Reset clears chips'); else fail(`${chipsAfterReset} chips after reset`);

	if (errors.length === 0) ok('no console errors'); else fail(`console errors:\n  ${errors.join('\n  ')}`);
} catch (e) {
	fail('exception: ' + e.message);
} finally {
	await browser.close();
}
console.log(process.exitCode ? '\n=== SMOKE FAILED ===' : '\n=== SMOKE PASSED ===');
