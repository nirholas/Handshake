/**
 * public/inline-behaviors.js, exercised the only way it can be trusted.
 *
 * This file replaced ~170 inline `onerror=` / `onclick=` attributes across the
 * site after the CSP stopped allowing them. Its failure mode is silent: a
 * broken avatar keeps the browser's broken-image glyph, a retry button does
 * nothing, a card opens behind the link you clicked. Nothing throws, no test
 * turns red, and the first report comes from a user.
 *
 * So each declared behaviour is driven here in a real browser against a real
 * image load failure, on a real page that has the script on it.
 */

import { test, expect } from '@playwright/test';

// Any page serves; the script is injected on all of them. /pay is small and
// has no heavy 3D module graph to transform on a cold dev server.
const HOST_PAGE = '/pay';

// A URL that is guaranteed to fail without leaving the origin.
const BROKEN = '/__inline-behaviors-no-such-image.png';

test.beforeEach(async ({ page }) => {
	await page.goto(HOST_PAGE);
	await page.waitForFunction(() => window.__inlineBehaviorsInstalled === true);
});

/** Render `html` into a fresh container and wait for the image to fail. */
async function mount(page, html) {
	await page.evaluate((markup) => {
		document.getElementById('ib-fixture')?.remove();
		const host = document.createElement('div');
		host.id = 'ib-fixture';
		host.innerHTML = markup;
		document.body.appendChild(host);
	}, html);
	// The delegated listener runs on the error event; give the failed load a
	// moment to land rather than racing it.
	await page.waitForFunction(() => {
		const img = document.querySelector('#ib-fixture img');
		return !img || img.complete;
	});
	await page.waitForTimeout(150);
}

test('data-fallback="hide" hides the broken image', async ({ page }) => {
	await mount(page, `<img src="${BROKEN}" data-fallback="hide" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCSS('display', 'none');
});

test('data-fallback="invisible" keeps the layout box', async ({ page }) => {
	await mount(page, `<img src="${BROKEN}" data-fallback="invisible" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCSS('visibility', 'hidden');
});

test('data-fallback="remove" drops the element', async ({ page }) => {
	await mount(page, `<img src="${BROKEN}" data-fallback="remove" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCount(0);
});

test('data-fallback="sibling" reveals the placeholder next to it', async ({ page }) => {
	await mount(
		page,
		`<img src="${BROKEN}" data-fallback="sibling" alt=""><span class="ph" style="display:none">AB</span>`,
	);
	await expect(page.locator('#ib-fixture img')).toHaveCSS('display', 'none');
	await expect(page.locator('#ib-fixture .ph')).toHaveCSS('display', 'flex');
});

test('data-fallback="text" swaps the image for its text', async ({ page }) => {
	await mount(page, `<img src="${BROKEN}" data-fallback="text" data-fallback-text="AB" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCount(0);
	await expect(page.locator('#ib-fixture')).toHaveText('AB');
});

test('data-fallback="parent-text" relabels the container', async ({ page }) => {
	await mount(
		page,
		`<div class="wrap"><img src="${BROKEN}" data-fallback="parent-text" data-fallback-text="SOL" alt=""></div>`,
	);
	await expect(page.locator('#ib-fixture .wrap')).toHaveText('SOL');
});

test('data-fallback="element" builds the declared placeholder', async ({ page }) => {
	await mount(
		page,
		`<img src="${BROKEN}" data-fallback="element" data-fallback-tag="span" data-fallback-class="ph mono" data-fallback-text="XY" alt="">`,
	);
	await expect(page.locator('#ib-fixture img')).toHaveCount(0);
	const ph = page.locator('#ib-fixture span.ph.mono');
	await expect(ph).toHaveCount(1);
	await expect(ph).toHaveText('XY');
});

test('data-fallback="closest" removes the wrapper it names', async ({ page }) => {
	await mount(
		page,
		`<div class="card"><img src="${BROKEN}" data-fallback="closest" data-fallback-closest=".card" alt=""></div>`,
	);
	await expect(page.locator('#ib-fixture .card')).toHaveCount(0);
});

test('data-fallback="keep" leaves the image alone', async ({ page }) => {
	await mount(page, `<img src="${BROKEN}" data-fallback="keep" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCount(1);
});

test('data-fallback-parent-class marks the container that lost its image', async ({ page }) => {
	await mount(
		page,
		`<div class="wrap"><img src="${BROKEN}" data-fallback="remove" data-fallback-parent-class="no-img" alt=""></div>`,
	);
	await expect(page.locator('#ib-fixture .wrap')).toHaveClass(/no-img/);
});

test('data-fallback-src swaps once, then runs the declared mode', async ({ page }) => {
	// Both URLs fail, so the retry happens and then the mode does.
	await mount(
		page,
		`<img src="${BROKEN}" data-fallback-src="${BROKEN}-2" data-fallback="hide" alt="">`,
	);
	await page.waitForTimeout(300);
	const img = page.locator('#ib-fixture img');
	await expect(img).toHaveAttribute('src', `${BROKEN}-2`);
	await expect(img).toHaveCSS('display', 'none');
});

test('an image that declares nothing is left untouched', async ({ page }) => {
	// src/shared/news-render.js owns data-fallback with different semantics, and
	// plain broken images all over the site must keep behaving as they always did.
	await mount(page, `<img src="${BROKEN}" alt=""><img src="${BROKEN}" data-fallback="AB" alt="">`);
	await expect(page.locator('#ib-fixture img')).toHaveCount(2);
});

test('data-stop-propagation keeps a click off the ancestor', async ({ page }) => {
	// Spans, not anchors: the real markup this replaces is a link inside a
	// clickable card, but the host page has its own delegated handler that turns
	// a link click into a view-transition navigation, which would take the
	// fixture with it. Propagation is what is under test, so drive it directly.
	await mount(
		page,
		`<div id="card"><span id="out" data-stop-propagation>out</span><span id="in">in</span></div>`,
	);
	await page.evaluate(() => {
		window.__cardClicks = 0;
		document.getElementById('card').addEventListener('click', () => {
			window.__cardClicks++;
		});
	});
	await page.locator('#ib-fixture #in').click();
	expect(await page.evaluate(() => window.__cardClicks)).toBe(1);
	await page.locator('#ib-fixture #out').click();
	expect(await page.evaluate(() => window.__cardClicks)).toBe(1);
});

test('data-action="reload" reloads the page', async ({ page }) => {
	await mount(page, `<button type="button" data-action="reload">Retry</button>`);
	await page.evaluate(() => {
		window.__stillHere = true;
	});
	await Promise.all([
		page.waitForLoadState('load'),
		page.locator('#ib-fixture [data-action="reload"]').click(),
	]);
	// The marker only survives if the document was never replaced.
	expect(await page.evaluate(() => window.__stillHere === true)).toBe(false);
});
