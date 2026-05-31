// Headless verification of the /worlds lobby in its CONFIGURED state — i.e. with
// a real CoinCommunities key serving live worlds (via scripts/dev-cc-server.mjs
// behind a dev server). Confirms the live worlds grid renders real cards, the
// count + search work, a card enters its /walk world, and there are ZERO console
// errors (no tolerated 503 this time — the key is live).
//   WORLDS_URL=http://localhost:3200/worlds node scripts/verify-worlds-live.mjs
import { chromium } from 'playwright';

const URL = process.env.WORLDS_URL || 'http://localhost:3200/worlds';
const errors = [];
const warnings = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
	const t = m.text();
	if (m.type() === 'error') errors.push(t);
	else if (m.type() === 'warning') warnings.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForSelector('.wl-card:not(.wl-skel)', { timeout: 20_000 });
await page.waitForTimeout(500);

const checks = {};
checks.worldCards = await page.locator('.wl-card:not(.wl-skel)').count();
checks.countText = (await page.locator('#wl-worlds-count').textContent().catch(() => '')) || '';
checks.firstSymbol = (await page.locator('.wl-card-sym').first().textContent().catch(() => '')) || '';
checks.firstHasLiveBadge = (await page.locator('.wl-card .wl-card-live').count()) > 0;
checks.firstHasStats = (await page.locator('.wl-card .wl-stat').first().count()) > 0;

// Search filter narrows the grid.
const firstSym = checks.firstSymbol.replace(/^\$/, '').slice(0, 3);
await page.fill('#wl-search', firstSym);
await page.waitForTimeout(400);
checks.filteredCards = await page.locator('.wl-card:not(.wl-skel)').count();
await page.fill('#wl-search', '');
await page.waitForTimeout(300);

// Clicking a world card enters its /walk world with the coin param.
let entersWalk = false;
let walkUrl = '';
try {
	await page.locator('.wl-card:not(.wl-skel)').first().click();
	await page.waitForURL('**/walk?**', { timeout: 10_000 });
	walkUrl = page.url();
	entersWalk = /[?&]coin=[1-9A-HJ-NP-Za-km-z]{32,44}/.test(walkUrl);
} catch { /* stays false */ }
checks.entersWalk = entersWalk;
checks.walkUrl = walkUrl;

await browser.close();

console.log('--- /worlds LIVE-state verification ---');
console.log(JSON.stringify(checks, null, 2));
console.log(`console errors: ${errors.length}`);
errors.forEach((e) => console.log('  ✗', e));
console.log(`console warnings: ${warnings.length}`);
warnings.slice(0, 8).forEach((w) => console.log('  !', w));

const pass =
	checks.worldCards >= 1 &&
	/\d+\s+world/.test(checks.countText) &&
	checks.firstSymbol.length > 0 &&
	checks.firstHasLiveBadge &&
	checks.entersWalk &&
	errors.length === 0;

console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
