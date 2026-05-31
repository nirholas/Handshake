// Headless verification of the /worlds lobby in its current production state
// (CoinCommunities unconfigured → 503). Confirms the page renders the graceful
// "offline" world layer, the manual-mint entry, the avatar picker, and emits no
// console errors. Run against a live dev server: node scripts/verify-worlds-lobby.mjs
import { chromium } from 'playwright';

const URL = process.env.WORLDS_URL || 'http://localhost:3000/worlds';
const errors = [];
const warnings = [];

// In the current production state CoinCommunities is unconfigured, so
// /api/community/worlds intentionally answers 503 and the lobby degrades to its
// "offline" world layer. The browser logs that 503 as a resource error — it is
// the only tolerated console noise; any other console error or uncaught
// exception is a real defect and fails the run.
const isExpected503 = (t) => /Failed to load resource/i.test(t) && /503/.test(t);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
	const t = m.text();
	if (m.type() === 'error') (isExpected503(t) ? warnings : errors).push(t);
	else if (m.type() === 'warning') warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
// The lobby fetches /api/community/worlds on boot; wait for the resulting state
// to render (unconfigured → empty block + manual mint form).
await page.waitForSelector('.wl-quick-btn', { timeout: 15_000 });
await page.waitForSelector('#wl-mint-input', { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(800);

const checks = {};
checks.quickAvatars = await page.locator('.wl-quick-btn').count();
checks.browseBtn = await page.locator('#wl-browse').count();
checks.idForm = await page.locator('#wl-id-form').count();
checks.enterMainland = await page.locator('#wl-enter-mainland').count();
checks.offlineHeading = (await page.locator('.wl-empty h3').first().textContent().catch(() => '')) || '';
checks.manualMint = await page.locator('#wl-mint-input').count();
checks.search = await page.locator('#wl-search').count();

// Exercise a quick-avatar pick → it resolves /api/avatars/<id> (proxies to
// prod) and flips the avatar panel to its "ready" state. Wait for that state
// deterministically rather than a fixed sleep so upstream latency can't flake.
let avatarPicked = false;
try {
	await page.locator('.wl-quick-btn').first().click();
	await page.waitForFunction(
		() => /ready to drop in/i.test(document.querySelector('.wl-avatar-sub')?.textContent || ''),
		{ timeout: 10_000 },
	);
	avatarPicked = true;
} catch { /* stays false → fails the gate below */ }
checks.avatarPicked = avatarPicked;

await browser.close();

console.log('--- /worlds dark-state verification ---');
console.log(JSON.stringify(checks, null, 2));
console.log(`console errors: ${errors.length}`);
errors.forEach((e) => console.log('  ✗', e));
console.log(`console warnings: ${warnings.length}`);
warnings.slice(0, 10).forEach((w) => console.log('  !', w));

const pass =
	checks.quickAvatars >= 4 &&
	checks.browseBtn === 1 &&
	checks.enterMainland === 1 &&
	checks.manualMint === 1 &&
	checks.avatarPicked === true &&
	/offline/i.test(checks.offlineHeading) &&
	errors.length === 0;

console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
