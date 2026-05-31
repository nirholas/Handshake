// Temporary smoke test for /create/studio color customization.
// Drives real Chromium against the dev server, asserts the color tab tints the
// live mesh (pixel diff), checks keyboard tab nav, and captures console errors.
// Run: node scripts/_studio-smoke.mjs ; deleted after verification.
import { chromium } from 'playwright';
import sharp from 'sharp';

const URL = process.env.STUDIO_URL || 'http://localhost:3000/create/studio';
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };
const ok = (m) => console.log('PASS:', m);

const centralMean = async (pngBuf) => {
	const img = sharp(pngBuf);
	const { width, height } = await img.metadata();
	const cw = Math.floor(width * 0.34), ch = Math.floor(height * 0.22);
	const left = Math.floor(width / 2 - cw / 2);
	const top = Math.floor(height * 0.34); // upper-torso band of the avatar
	const { data } = await img
		.extract({ left, top, width: cw, height: ch })
		.raw().toBuffer({ resolveWithObject: true });
	let r = 0, g = 0, b = 0, n = data.length / 3;
	for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
	return [r / n, g / n, b / n];
};

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

	const stage = page.locator('#as-stage');
	const before = await stage.screenshot();

	// Apply a vivid outfit tint and assert the central torso pixels shift.
	await page.click('.as-swatch[data-slot="outfit"][data-hex="#1f6b3a"]');
	await page.waitForTimeout(900);
	const after = await stage.screenshot();

	const [mb, ma] = [await centralMean(before), await centralMean(after)];
	const delta = Math.hypot(ma[0] - mb[0], ma[1] - mb[1], ma[2] - mb[2]);
	console.log('  central mean before', mb.map((x) => x.toFixed(0)), 'after', ma.map((x) => x.toFixed(0)), 'Δ', delta.toFixed(1));
	if (delta > 12) ok(`outfit tint changed the rendered mesh (Δ=${delta.toFixed(1)})`); else fail(`mesh did not visibly change (Δ=${delta.toFixed(1)})`);

	// Chip + selection state.
	const chip = await page.locator('.as-chip[data-color="outfit"]').count();
	if (chip === 1) ok('outfit color chip present'); else fail(`expected 1 outfit chip, got ${chip}`);
	const pressed = await page.getAttribute('.as-swatch[data-slot="outfit"][data-hex="#1f6b3a"]', 'aria-pressed');
	if (pressed === 'true') ok('selected swatch aria-pressed=true'); else fail(`aria-pressed=${pressed}`);

	// Keyboard tab nav: focus active tab, ArrowRight → Hats.
	await page.focus('#as-tab-color');
	await page.keyboard.press('ArrowRight');
	const afterArrow = await page.getAttribute('.as-tab.active', 'data-tab');
	if (afterArrow === 'hat') ok('ArrowRight moves Color → Hats'); else fail(`ArrowRight landed on "${afterArrow}"`);

	// Reset clears the chip.
	await page.click('#as-reset');
	await page.waitForTimeout(600);
	const chipsAfterReset = await page.locator('.as-chip').count();
	if (chipsAfterReset === 0) ok('Reset clears chips'); else fail(`${chipsAfterReset} chips after reset`);

	if (errors.length === 0) ok('no console errors'); else fail(`console errors:\n  ${errors.join('\n  ')}`);

	await page.screenshot({ path: 'scripts/_studio-after.png' });
	console.log('\nScreenshot: scripts/_studio-after.png');
} catch (e) {
	fail('exception: ' + e.message);
} finally {
	await browser.close();
}
console.log(process.exitCode ? '\n=== SMOKE FAILED ===' : '\n=== SMOKE PASSED ===');
