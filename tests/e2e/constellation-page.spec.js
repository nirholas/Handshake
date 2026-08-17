// /constellation: the defects the route audit found, all of which reproduce on
// the pre-fix page.
//
// 1. The page's only real interaction was unreliable. A press counted as a click
//    on a star only if it landed within a pixel or two of the sphere's geometry
//    AND released inside 450ms, so a slow or held click did nothing at all.
//    Movement is now the sole drag-vs-tap test and the pick resolves to the
//    nearest star in screen space.
// 2. Nothing reached the star list from the keyboard.
// 3. The page credited IBM Granite for whatever served, even when the embed
//    endpoint or /api/brain/chat had failed over to another provider.
// 4. A signed-out visitor hit "Analysis unavailable (unauthorized)" with no way
//    forward, and a failed token feed was a dead end with no retry.
//
// The token feed and both model lanes are live, so the assertions are about the
// page's structure and its honesty about what served, never about a particular
// token or provider being present.

import { test, expect } from '@playwright/test';

const LOAD = { waitUntil: 'domcontentloaded', timeout: 120_000 };

// Ready = the token feed landed and the galaxy replaced the loading overlay.
async function loadGalaxy(page) {
	await page.goto('/constellation', LOAD);
	await page.waitForFunction(
		() => document.getElementById('c-overlay')?.classList.contains('hidden'),
		null,
		{ timeout: 120_000 },
	);
}

// Sweep the canvas for a star, reporting the point and the symbol the page
// itself is naming there. The tooltip's INLINE opacity is the page's own
// decision; the computed value is unreliable in headless Chromium, which does
// not advance CSS transitions.
async function findStar(page) {
	const box = await page.locator('#c-scene').boundingBox();
	for (let ry = 0.25; ry <= 0.75; ry += 0.05) {
		for (let rx = 0.25; rx <= 0.75; rx += 0.05) {
			const x = box.x + box.width * rx;
			const y = box.y + box.height * ry;
			await page.mouse.move(x, y);
			await page.waitForTimeout(60);
			const hit = await page.evaluate(() => ({
				on: document.getElementById('c-tooltip').style.opacity === '1',
				sym: document.getElementById('c-tip-sym').textContent,
			}));
			if (hit.on) return { x, y, sym: hit.sym };
		}
	}
	throw new Error('no star found under the pointer sweep');
}

test('/constellation opens the star you pressed, even on a slow click', async ({ page }) => {
	await loadGalaxy(page);
	const star = await findStar(page);

	// The regression: a press held well past the old 450ms budget. It ends where
	// it started, so it is a click, not an orbit drag.
	await page.mouse.down();
	await page.waitForTimeout(700);
	await page.mouse.up();

	const panel = page.locator('#c-panel');
	await expect(panel).toHaveClass(/open/);
	await expect(panel).toHaveAttribute('aria-hidden', 'false');
	// The star that opened is the star the label named.
	await expect(page.locator('#c-panel-sym')).toHaveText(star.sym);
	await expect(page.locator('#c-panel-rank')).toHaveText(/^#\d+$/);

	// Both external links are built from the token's real mint.
	const links = page.locator('#c-panel-links a');
	await expect(links).toHaveCount(2);
	for (const href of await links.evaluateAll((els) => els.map((e) => e.href))) {
		expect(href).toMatch(
			/^https:\/\/(pump\.fun\/coin|solscan\.io\/token)\/[1-9A-HJ-NP-Za-km-z]{32,44}$/,
		);
	}

	// A drag orbits the camera instead of selecting, so nothing reopens.
	await page.locator('#c-close').click();
	await expect(panel).not.toHaveClass(/open/);
	await page.mouse.move(star.x, star.y);
	await page.mouse.down();
	await page.mouse.move(star.x + 90, star.y + 40, { steps: 6 });
	await page.mouse.up();
	await expect(panel).not.toHaveClass(/open/);
});

test('/constellation is operable from the keyboard and closes back to the galaxy', async ({
	page,
}) => {
	await loadGalaxy(page);

	await page.locator('#c-scene').focus();
	await page.keyboard.press('ArrowRight');
	// Every focused star is announced, so a screen reader can follow the walk.
	const live = page.locator('#c-a11y-live');
	await expect(live).toHaveText(/trending rank \d+\. 1 of \d+\./);
	const first = await live.textContent();

	await page.keyboard.press('ArrowRight');
	await expect(live).not.toHaveText(first);
	await expect(live).toHaveText(/2 of \d+\./);

	await page.keyboard.press('Enter');
	const panel = page.locator('#c-panel');
	await expect(panel).toHaveClass(/open/);
	// Focus follows the keyboard into the panel, and Escape hands it back.
	await expect(page.locator('#c-close')).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(panel).not.toHaveClass(/open/);
	// Closed means closed: the panel is only translated off-screen, so without
	// `inert` its controls stay in the tab order.
	await expect(panel).toHaveAttribute('inert', '');
	await expect(page.locator('#c-scene')).toBeFocused();
});

test('/constellation names the lane that actually served, and never invents Granite', async ({
	page,
}) => {
	await loadGalaxy(page);

	// Whatever embeds, the status has to name it. Crediting Granite is allowed
	// only when a Granite model is what came back.
	const status = page.locator('#c-status-text');
	await page.waitForFunction(
		() => !/Starting|embedding with/i.test(document.getElementById('c-status-text').textContent),
		null,
		{ timeout: 120_000 },
	);
	const text = await status.textContent();
	if (/Embedded by IBM\s*Granite/.test(text)) {
		expect(await status.locator('code').textContent()).toMatch(/granite/i);
	} else {
		// Either a fallback embedder placed the stars, or there is no semantic
		// layout at all. Both have to say so rather than claim Granite.
		expect(text).toMatch(/fallback embedder|Semantic layout off/i);
	}

	// A signed-out visitor gets a route forward, not a bare error code.
	await findStar(page);
	await page.mouse.down();
	await page.mouse.up();
	await expect(page.locator('#c-panel')).toHaveClass(/open/);
	const notice = page.locator('#c-analysis .c-notice');
	await expect(notice).toContainText('needs an account');
	await expect(notice.locator('a[href*="/login"]')).toHaveAttribute(
		'href',
		/next=%2Fconstellation/,
	);
	await expect(notice.locator('a[href*="/register"]')).toHaveAttribute(
		'href',
		/next=%2Fconstellation/,
	);
});

test('/constellation offers a working retry when the token feed fails, and fits a phone', async ({
	page,
}) => {
	await page.route('**/api/pump/trending*', (r) => r.abort('failed'));
	await page.goto('/constellation', LOAD);

	const overlay = page.locator('#c-overlay');
	await expect(overlay).not.toHaveClass(/hidden/);
	await expect(page.locator('#c-overlay-msg')).toContainText("Couldn't load live tokens");
	const retry = page.locator('#c-retry');
	await expect(retry).toBeVisible();

	// The retry is real: with the feed reachable again it builds the galaxy.
	await page.unroute('**/api/pump/trending*');
	await retry.click();
	await expect(overlay).toHaveClass(/hidden/, { timeout: 120_000 });
	await expect(page.locator('#c-status-text')).not.toHaveText(/Starting/);

	// The hint bar used to run off a narrow screen and sit under the language
	// switcher; nothing may overflow the viewport at phone width.
	await page.setViewportSize({ width: 320, height: 640 });
	await page.waitForTimeout(400);
	const layout = await page.evaluate(() => {
		const de = document.documentElement;
		const wide = [...document.querySelectorAll('.c-hint, .c-hud, #c-status, .c-badge, h1')]
			.map((el) => el.getBoundingClientRect())
			.filter((b) => b.width > 0 && (b.left < -1 || b.right > window.innerWidth + 1));
		return { hscroll: de.scrollWidth > de.clientWidth + 1, overflowing: wide.length };
	});
	expect(layout.hscroll).toBe(false);
	expect(layout.overflowing).toBe(0);
});
