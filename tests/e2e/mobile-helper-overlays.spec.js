// Phone-width regression cover for the helper layer.
//
// Reported from an iPhone against production: the floating "Getting started"
// pill and the language control sat directly on top of the /app chat composer
// and its action row, the gallery's third card action ("Animate") was clipped
// mid-word past the card's edge, and the AR Studio's Add-models sheet rendered
// its tab pills sliced in half on a short viewport.
//
// Each one is invisible on a desktop viewport and to any unit test, because all
// three are geometry: two independently correct boxes landing on the same
// pixels. So they are asserted the way they were found, by measuring a real
// browser at a phone size.

import { test, expect } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

/** Do two rects share more than a hairline of area? */
function overlaps(a, b, tolerance = 2) {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return w > tolerance && h > tolerance;
}

test('helper widgets clear the page\'s own bottom chrome on /app', async ({ page }) => {
	await page.goto('/app', { waitUntil: 'domcontentloaded', timeout: 120_000 });
	await page.waitForSelector('#tws-corner-stack .tws-corner-item', { timeout: 60_000 });
	// The stack measures the page's docks on a settle timer; give it a beat.
	await page.waitForTimeout(2000);

	const stack = await page.locator('#tws-corner-stack').boundingBox();
	expect(stack).not.toBeNull();

	for (const selector of ['#nxt-chat-dock', '.nxt-action-bar--secondary']) {
		const dock = await page.locator(selector).first().boundingBox();
		if (!dock) continue; // the bar only renders in some auth states
		expect(
			overlaps(stack, dock),
			`${selector} is covered by the corner stack`,
		).toBe(false);
	}

	// The language control is the widget that landed inside the composer: on a
	// phone it renders its locale code, not the full language name.
	const lang = page.locator('#tws-corner-stack lang-switcher');
	if (await lang.count()) {
		const face = await lang.first().evaluate(
			(el) => el.shadowRoot?.querySelector('.face')?.textContent?.trim() || '',
		);
		expect(face).toMatch(/^[A-Z]{2,3}$/);
	}
});

test('every gallery card action stays inside its card', async ({ page }) => {
	await page.goto('/gallery/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
	await page.waitForSelector('.gallery-card-actions .gallery-card-btn', { timeout: 60_000 });

	const escapes = await page.evaluate(() => {
		const out = [];
		for (const card of document.querySelectorAll('.gallery-card')) {
			const cr = card.getBoundingClientRect();
			for (const btn of card.querySelectorAll('.gallery-card-btn')) {
				const br = btn.getBoundingClientRect();
				if (br.right > cr.right + 1 || br.left < cr.left - 1) {
					out.push(`${(btn.textContent || '').trim()} escapes its card`);
				}
				if (btn.scrollWidth > btn.clientWidth + 1) {
					out.push(`${(btn.textContent || '').trim()} is clipped`);
				}
			}
		}
		return out;
	});
	expect(escapes).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		PHONE.width,
	);
});

test('the AR Studio sheet keeps its tabs at full height on a short viewport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 480 });
	await page.goto('/ar-studio', { waitUntil: 'domcontentloaded', timeout: 120_000 });
	// The sheet only opens once the studio module has booted its WebGL scene, so
	// retry the click rather than racing it.
	await page.waitForSelector('#ars-add-btn', { state: 'visible', timeout: 60_000 });
	await expect(async () => {
		await page.click('#ars-add-btn');
		await expect(page.locator('#ars-tray')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 60_000 });
	await page.click('#ars-tab-community');
	await page.waitForTimeout(3000);

	// The sheet is a flex column capped at 72dvh. When its body could not
	// shrink, the head and the tab strip absorbed the squeeze and the pills
	// rendered as 16px slivers.
	const pill = await page.locator('.ars-tab').first().boundingBox();
	expect(pill.height).toBeGreaterThan(26);

	// Card labels are prompts, and a refined prompt is a multi-clause spec.
	const titles = await page.locator('.ars-item-title').allTextContents();
	for (const title of titles) {
		expect(title.trim().length).toBeLessThanOrEqual(50);
	}
});
