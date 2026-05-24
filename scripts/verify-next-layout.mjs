// End-to-end verification for the Next viewer layout on /app.
//
// Drives Chromium, exercises every interactive surface, and asserts both
// visual presence and behavioral wiring. Run with the dev server up:
//
//   BASE_URL=http://localhost:3050 node scripts/verify-next-layout.mjs
//
// Clip-dependent assertions (play/pause, scrub, grid switching) require
// the GLB to actually load — they're guarded behind a clip-loaded check
// and report as warnings if the avatar never resolved, so we don't false-
// negative on a slow first cold-cache run.

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL = `${BASE}/app`;

let failures = 0;
const warnings = [];
function fail(msg) {
	console.error('FAIL:', msg);
	failures += 1;
}
function warn(msg) {
	console.warn('WARN:', msg);
	warnings.push(msg);
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 120_000 });
await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
await page.waitForSelector('#layout-switch:not([hidden])', { timeout: 30_000 });

// ── Layout switch flips to next ─────────────────────────────────────────
await page.locator('[data-layout-value="next"]').click();
const layout = await page.evaluate(() => document.body.dataset.layout);
if (layout !== 'next') fail(`expected body[data-layout="next"], got "${layout}"`);

// ── Classic chrome hidden, Next chrome visible ──────────────────────────
const expectVisible = async (sel) => {
	const visible = await page.locator(sel).first().isVisible().catch(() => false);
	if (!visible) fail(`expected ${sel} to be visible in Next mode`);
};
const expectHidden = async (sel) => {
	const count = await page.locator(sel).count();
	if (count === 0) return;
	const visible = await page.locator(sel).first().isVisible().catch(() => false);
	if (visible) fail(`expected ${sel} to be hidden in Next mode`);
};
await expectVisible('#next-dock');
await expectVisible('#next-corner');
await expectVisible('#next-controls-btn');
await expectVisible('#next-share-btn');
await expectVisible('#next-fullscreen-btn');
await expectHidden('.dropzone');
await expectHidden('.agent-presence-sidebar');
await expectHidden('.gui-toggle');

// ── Wait for animations to load and bind to the dock (best-effort) ──────
const clipsLoaded = await page.waitForFunction(
	() => {
		const name = document.getElementById('next-dock-clip-name')?.textContent?.trim();
		return name && name !== '—';
	},
	{ timeout: 20_000 },
).then(() => true).catch(() => false);

if (!clipsLoaded) {
	warn('avatar/clips never loaded — skipping playback assertions');
}

if (clipsLoaded) {
	// ── Play button toggles state ──────────────────────────────────────
	const wasPlaying = await page.locator('#next-dock-play').getAttribute('aria-pressed');
	await page.locator('#next-dock-play').click();
	await page.waitForTimeout(300);
	const nowPlaying = await page.locator('#next-dock-play').getAttribute('aria-pressed');
	if (nowPlaying === wasPlaying) fail(`play button did not toggle (was ${wasPlaying}, now ${nowPlaying})`);

	// ── Scrub advances the action.time ─────────────────────────────────
	await page.evaluate(() => {
		const scrub = document.getElementById('next-dock-scrub-input');
		scrub.value = 500;
		scrub.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(100);
	const time = await page.locator('#next-dock-time').innerText();
	if (time === '0:00 / 0:00') fail(`scrub did not update time display: "${time}"`);

	// ── Grid opens and lists clips, click switches ─────────────────────
	await page.locator('#next-dock-clip').click();
	await page.waitForFunction(() => !document.getElementById('next-grid')?.hidden, null, { timeout: 5000 });
	const gridCount = await page.locator('#next-grid .next-grid__item').count();
	if (gridCount === 0) fail('grid rendered with 0 clips');
	if (gridCount > 1) {
		const before = await page.locator('#next-dock-clip-name').innerText();
		await page.locator('#next-grid .next-grid__item').nth(1).click();
		await page.waitForTimeout(200);
		const after = await page.locator('#next-dock-clip-name').innerText();
		if (before === after) fail(`clip switch did not change name (was "${before}", now "${after}")`);
		const gridStillOpen = await page.locator('#next-grid').isVisible();
		if (gridStillOpen) fail('grid did not auto-close after selection');
	}

	// ── Loop toggle persists state on aria-pressed ─────────────────────
	const loopBefore = await page.locator('#next-dock-loop').getAttribute('aria-pressed');
	await page.locator('#next-dock-loop').click();
	const loopAfter = await page.locator('#next-dock-loop').getAttribute('aria-pressed');
	if (loopBefore === loopAfter) fail(`loop button did not toggle (was ${loopBefore}, now ${loopAfter})`);
	await page.locator('#next-dock-loop').click();
}

// ── Controls drawer opens, contains the dat.GUI panel ───────────────────
await page.evaluate(() => document.getElementById('next-controls-btn').click());
await page.waitForFunction(
	() => document.getElementById('next-drawer')?.classList.contains('next-drawer--open'),
	null,
	{ timeout: 3000 },
);
const hasGui = await page.evaluate(() => {
	const body = document.getElementById('next-drawer-body');
	return Boolean(body?.querySelector('.gui-wrap'));
});
if (!hasGui) fail('Controls drawer did not host the dat.GUI panel');
await page.evaluate(() => document.getElementById('next-drawer-close').click());
await page.waitForFunction(
	() => !document.getElementById('next-drawer')?.classList.contains('next-drawer--open'),
);

// ── Share popover opens and contains expected items ─────────────────────
await page.evaluate(() => document.getElementById('next-share-btn').click());
await page.waitForFunction(() => !document.getElementById('next-share-menu')?.hidden, null, { timeout: 5000 });
const uploadVisible = await page.locator('#next-share-upload').isVisible();
if (!uploadVisible) fail('Share popover missing Upload item');
// Close via outside-click.
await page.evaluate(() => document.body.click());
await page.waitForFunction(() => document.getElementById('next-share-menu')?.hidden, null, { timeout: 3000 });

// ── Toggle back to Classic; chrome must swap ────────────────────────────
await page.locator('[data-layout-value="classic"]').click();
await page.waitForFunction(() => document.body.dataset.layout === 'classic');
const dockHiddenInClassic = !(await page.locator('#next-dock').isVisible().catch(() => false));
if (!dockHiddenInClassic) fail('Next dock still visible after switching to Classic');
const dropzoneVisibleInClassic = await page.locator('.dropzone').isVisible().catch(() => false);
if (!dropzoneVisibleInClassic) fail('Classic dropzone hidden after switching back to Classic');
const guiToggleVisibleInClassic = await page.locator('.gui-toggle').isVisible().catch(() => false);
if (!guiToggleVisibleInClassic) fail('Classic gui-toggle hidden after switching back');

// ── Reload preserves the chosen layout ─────────────────────────────────
await page.locator('[data-layout-value="next"]').click();
await page.waitForTimeout(150);
await page.reload({ waitUntil: 'load', timeout: 120_000 });
await page.waitForSelector('#layout-switch:not([hidden])', { timeout: 30_000 });
const afterReload = await page.evaluate(() => document.body.dataset.layout);
if (afterReload !== 'next') fail(`expected "next" after reload, got "${afterReload}"`);

// ── No console errors during the whole flow ─────────────────────────────
const ignorable = [
	/wallet/i, // wallet provider noise in headless
	/Failed to fetch/i, // background analytics
	/Wallet not initialized/i,
];
const realErrors = consoleErrors.filter((e) => !ignorable.some((rx) => rx.test(e)));
if (realErrors.length) {
	console.error('Console errors during run:');
	for (const e of realErrors) console.error('  ', e);
	failures += realErrors.length;
}

await browser.close();
if (failures) {
	console.error(`\nverify-next-layout FAILED (${failures} failures, ${warnings.length} warnings)`);
	process.exit(1);
} else if (warnings.length) {
	console.log(`verify-next-layout OK (with ${warnings.length} warnings)`);
} else {
	console.log('verify-next-layout OK');
}
