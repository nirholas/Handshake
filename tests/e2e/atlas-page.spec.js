/**
 * /atlas, the browsable half of Atlas, driven in a real browser.
 *
 * tests/atlas.test.js already pins the ranking and the build-time intent gate,
 * but every defect this file covers is invisible to a unit test because it only
 * exists once the results are laid out:
 *
 *   - A long unbroken query is echoed into the no-match state. With no wrapping
 *     rule it ran past its box and gave the whole document a horizontal
 *     scrollbar (1912px wide at a 1440px viewport), so the page slid sideways
 *     under the visitor while they typed.
 *   - type=search paints its own cancel button, which sat beside the page's
 *     own clear button and gave the row two x controls.
 *   - That clear button was a 16x18 target, under the 24x24 minimum.
 *
 * The two failure states are here for the same reason: they are only reachable
 * by making the index fetch fail, which nothing else in the suite does.
 */

import { test, expect } from '@playwright/test';

const ATLAS = '/atlas';
const INDEX = '**/atlas-index.json';

// Re-rendering 700 cards is real work and this suite shares a box with the rest
// of it, so the waits here are explicit rather than leaning on the 30s default.
// Kept well under the 300s per-test cap: three chained 90s waits blow the cap
// before any single one of them reports what it was actually waiting for.
const SLOW = 45_000;

/** The live region is the page's own statement of what it finished rendering. */
async function search(page, query) {
	await page.fill('#at-q', query, { timeout: SLOW });
	await page.waitForFunction((q) => document.getElementById('at-live').textContent.includes(`"${q}"`), query, {
		timeout: SLOW,
	});
}

async function loaded(page) {
	await page.goto(ATLAS);
	await page.waitForSelector('.at-card', { timeout: SLOW });
	await page.waitForFunction(() => document.getElementById('at-live').textContent.includes('sections.'), null, {
		timeout: SLOW,
	});
}

test.describe('/atlas map page', () => {
	test('browses every section, and search narrows to a ranked, highlighted list', async ({ page }) => {
		await loaded(page);

		expect(await page.locator('h1').count()).toBe(1);
		const all = await page.locator('.at-card').count();
		expect(all).toBeGreaterThan(100);
		expect(await page.locator('.at-section').count()).toBeGreaterThan(1);

		await search(page, 'wallet');
		const hits = await page.locator('.at-card').count();
		expect(hits).toBeGreaterThan(0);
		expect(hits).toBeLessThan(all);
		// Every result explains itself: the matched run is marked.
		expect(await page.locator('.at-card mark').count()).toBeGreaterThan(0);
		// The filtered view is a link you can send to someone.
		expect(page.url()).toContain('q=wallet');

		await page.click('#at-clear', { timeout: SLOW });
		await page.waitForFunction(() => document.getElementById('at-live').textContent.includes('sections.'), null, {
			timeout: SLOW,
		});
		expect(await page.locator('.at-card').count()).toBe(all);
		expect(page.url()).not.toContain('q=');
	});

	test('a long unbroken query never gives the page a horizontal scrollbar', async ({ page }) => {
		await loaded(page);
		// The no-match state echoes the query back, so this is the longest single
		// unbreakable run the page can ever be asked to lay out.
		await search(page, 'supercalifragilistic'.repeat(12));

		// Measured by resizing rather than reloading: the layout has to hold as the
		// viewport changes, and reloading a 700-card page per width makes this the
		// slowest test in the file for no extra coverage.
		for (const width of [320, 768, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			const box = await page.evaluate(() => {
				document.documentElement.getBoundingClientRect(); // settle layout before reading
				return {
					scrollW: document.documentElement.scrollWidth,
					clientW: document.documentElement.clientWidth,
				};
			});
			expect(box.scrollW, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(box.clientW + 1);
		}
	});

	test('the search row offers exactly one clear control, at a real tap size', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 900 });
		await loaded(page);
		await search(page, 'agent');

		const clear = await page.locator('#at-clear').boundingBox();
		expect(clear.width).toBeGreaterThanOrEqual(24);
		expect(clear.height).toBeGreaterThanOrEqual(24);
		expect(clear.x + clear.width).toBeLessThanOrEqual(320);

		// The browser paints its own cancel button inside a type=search field, which
		// is what gave this row two x controls. Chromium reports the pseudo-element's
		// computed appearance as `auto` whether or not the rule applies, and clicking
		// where the button sits is not a discriminator either (the glyph is narrower
		// than the box it lives in), so the check is that the suppressing rule is
		// present and actually matches this input.
		const suppressed = await page.evaluate(() => {
			const input = document.getElementById('at-q');
			const PSEUDO = /::-webkit-search-cancel-button/;
			for (const sheet of document.styleSheets) {
				let rules;
				try {
					rules = sheet.cssRules;
				} catch {
					continue; // cross-origin sheet, nothing of ours lives there
				}
				for (const rule of rules) {
					if (!rule.selectorText || !PSEUDO.test(rule.selectorText)) continue;
					const subject = rule.selectorText.replace(PSEUDO, '').trim();
					const hides = `${rule.style.appearance} ${rule.style.webkitAppearance}`.includes('none');
					if (hides && subject && input.matches(subject)) return true;
				}
			}
			return false;
		});
		expect(suppressed, 'the native search cancel button is not suppressed').toBe(true);

		// And the page's own button still does clear it.
		await page.click('#at-clear', { timeout: SLOW });
		await page.waitForFunction(() => document.getElementById('at-live').textContent.includes('sections.'), null, {
			timeout: SLOW,
		});
		expect(await page.inputValue('#at-q')).toBe('');
	});

	test('a query that matches nothing offers a way forward, not a void', async ({ page }) => {
		await loaded(page);
		await search(page, 'zzzqqqxyzzy');
		const state = page.locator('#at-body .at-state');
		await expect(state).toHaveCount(1, { timeout: SLOW });
		await expect(state).toContainText('No page matches');
		await expect(state).toContainText('shorter word');
	});

	test('an index that will not load says so and points at the sitemap', async ({ page }) => {
		await page.route(INDEX, (route) => route.abort());
		await page.goto(ATLAS);
		const state = page.locator('#at-body .at-state');
		await state.waitFor({ state: 'attached', timeout: SLOW });
		await expect(state).toContainText('The map did not load');
		await expect(page.locator('#at-body a')).toHaveAttribute('href', '/sitemap');
		await expect(page.locator('#at-live')).toContainText('failed to load');
	});

	test('an index with no pages in it says so rather than rendering a headline over nothing', async ({ page }) => {
		await page.route(INDEX, (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ version: 1, pageCount: 0, intentCount: 0, sections: [], pages: [], intents: [] }),
			}),
		);
		await page.goto(ATLAS);
		const state = page.locator('#at-body .at-state');
		await state.waitFor({ state: 'attached', timeout: SLOW });
		await expect(state).toContainText('The map is empty');
		await expect(page.locator('#at-body a')).toHaveAttribute('href', '/sitemap');
		// Nothing to start with either, so the task shortcuts stay out of the way.
		await expect(page.locator('#at-intents-wrap')).toBeHidden();
	});
});
