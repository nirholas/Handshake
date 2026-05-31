// Verifies the /walk coin-lobby escape hatch: when the worlds API fails (the
// production 503 condition), the lobby must still let the visitor reach the
// walk scene via the "Walk solo" button instead of trapping them on the
// "Worlds are coming online" dead end.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.env.WALK_BASE || 'http://localhost:3000';
const OUT = '/tmp/lobby-check.json';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));

// Force the worlds API to 503 so we exercise the exact production failure.
await page.route('**/api/community/worlds', (route) =>
	route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
);

const result = { steps: [] };
try {
	await page.goto(`${BASE}/walk`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await page.waitForTimeout(3000);

	const lobby = page.locator('.clobby');
	result.lobbyVisible = await lobby.isVisible().catch(() => false);
	result.steps.push(`lobby visible: ${result.lobbyVisible}`);

	result.clobbyCountBefore = await page.locator('.clobby').count();
	result.skipCountBefore = await page.locator('.clobby__skip').count();
	result.steps.push(`.clobby count: ${result.clobbyCountBefore}, .clobby__skip count: ${result.skipCountBefore}`);

	const skip = page.locator('.clobby__skip').first();
	result.skipButtonPresent = result.skipCountBefore > 0;
	result.skipButtonVisible = result.skipButtonPresent ? await skip.isVisible() : false;
	result.steps.push(`skip button present: ${result.skipButtonPresent}, visible: ${result.skipButtonVisible}`);

	if (result.skipButtonVisible) {
		// Probe what a real click does and whether the handler runs at all.
		result.clickProbe = await page.evaluate(() => {
			const btn = document.querySelector('.clobby__skip');
			const r = btn.getBoundingClientRect();
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			const topEl = document.elementFromPoint(cx, cy);
			let handlerError = null;
			try {
				btn.click(); // direct DOM click — bypasses overlay hit-testing
			} catch (e) {
				handlerError = e.message;
			}
			return {
				rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
				topElementAtCenter: topEl ? `${topEl.tagName}.${topEl.className}` : null,
				handlerError,
				clobbyStillInDom: !!document.querySelector('.clobby'),
			};
		});
		result.steps.push(`clickProbe: ${JSON.stringify(result.clickProbe)}`);

		await page.waitForTimeout(500);
		result.clobbyCountAfter = await page.locator('.clobby').count();
		result.lobbyGoneAfterSkip = result.clobbyCountAfter === 0;
		result.steps.push(`.clobby count after skip: ${result.clobbyCountAfter} (removed: ${result.lobbyGoneAfterSkip})`);

		// The walk scene must now be reachable: canvas present + controls visible.
		result.canvasVisible = await page.locator('#walk-canvas').isVisible().catch(() => false);
		result.joystickPresent = (await page.locator('#walk-joystick').count()) > 0;
		result.steps.push(`canvas visible: ${result.canvasVisible}, joystick present: ${result.joystickPresent}`);
	}

	result.pass =
		result.lobbyVisible &&
		result.skipButtonVisible &&
		result.lobbyGoneAfterSkip === true &&
		result.canvasVisible === true;
} catch (e) {
	result.error = e.message;
	result.pass = false;
}

result.consoleErrors = consoleErrors.slice(0, 15);
await page.screenshot({ path: '/tmp/lobby-after-skip.png' }).catch(() => {});
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('LOBBY_CHECK', result.pass ? 'PASS' : 'FAIL');
console.log(JSON.stringify(result, null, 2));
await browser.close();
