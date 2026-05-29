// Manual verification harness for the coin-communities flow.
// Loads the lobby, asserts real coins render, enters a coin world, and checks
// the coin HUD + totem build without console errors. Run: node scripts/verify-communities.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3004';
const errors = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
// Ignore noise the sandbox can't satisfy: external image hosts (ipfs/cdn),
// analytics, and the expected 401 from /api/avatars when not signed in. We only
// care about real JS errors from our own code.
const ignore = (t) => /Failed to load resource|ERR_NAME_NOT_RESOLVED|net::ERR|401 \(Unauthorized\)|posthog|ipfs|429|WebSocket connection|response code: 403/i.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`[pageerror] ${e.message}`); });

try {
	// ── Lobby ───────────────────────────────────────────────────────────────
	log('→ loading /communities');
	await page.goto(`${BASE}/communities`, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.coin-card:not(.is-skeleton)', { timeout: 15000 });
	const coinCount = await page.locator('.coin-card:not(.is-skeleton)').count();
	const avatarChips = await page.locator('.avatar-chip').count();
	log(`  coins rendered: ${coinCount}, avatar chips: ${avatarChips}`);
	if (coinCount < 1) errors.push('no coin cards rendered');

	// Pull the first coin's mint/symbol so we can verify the handoff URL.
	const first = await page.locator('.coin-card').first();
	const firstSymbol = (await first.locator('.coin-symbol').textContent())?.trim();
	log(`  first coin: ${firstSymbol}`);

	// ── Enter a coin world ────────────────────────────────────────────────────
	log('→ clicking first coin');
	await Promise.all([
		page.waitForURL(/\/walk\?.*coin=/, { timeout: 15000 }),
		first.click(),
	]);
	const url = new URL(page.url());
	log(`  navigated: ${url.pathname}?${url.searchParams.toString().slice(0, 90)}…`);
	if (!url.searchParams.get('coin')) errors.push('coin param missing on handoff');

	// Let the scene boot + HUD build.
	await page.waitForSelector('#walk-coin-hud', { timeout: 20000 });
	const hudTitle = (await page.locator('#walk-coin-hud .coin-title').textContent())?.trim();
	log(`  coin HUD title: ${hudTitle}`);
	const switchLink = await page.locator('#walk-coin-hud a[href="/communities"]').count();
	if (!switchLink) errors.push('HUD missing switch-community link');

	// Canvas present + non-zero size (scene mounted).
	const canvasOk = await page.evaluate(() => {
		const c = document.getElementById('walk-canvas');
		return !!c && c.width > 0 && c.height > 0;
	});
	log(`  walk canvas mounted: ${canvasOk}`);
	if (!canvasOk) errors.push('walk canvas not mounted');

	await page.waitForTimeout(2500); // let totem + a trade poll settle
	await page.screenshot({ path: '/tmp/coin-world.png' });
	log('  screenshot → /tmp/coin-world.png');

	// ── Mainland (no coin) still works ────────────────────────────────────────
	log('→ verifying mainland (no coin) has no coin HUD');
	await page.goto(`${BASE}/walk`, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(1500);
	const hudOnMainland = await page.locator('#walk-coin-hud').count();
	if (hudOnMainland !== 0) errors.push('coin HUD wrongly present on mainland /walk');
	log(`  coin HUD on mainland: ${hudOnMainland} (expect 0)`);
} catch (e) {
	errors.push(`[harness] ${e.message}`);
} finally {
	await browser.close();
}

if (errors.length) {
	console.error('\n❌ FAILURES:\n' + errors.map((e) => '  - ' + e).join('\n'));
	process.exit(1);
}
console.log('\n✅ all checks passed');
