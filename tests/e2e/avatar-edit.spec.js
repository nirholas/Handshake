/**
 * Smoke test for the wardrobe editor's new RPM-style UX:
 *   • hover applies a preset to the 3D stage and marks the tile .previewing
 *   • leave reverts to the committed state
 *   • click commits and adds a chip
 *   • chip × removes the committed item
 *   • search filters the visible tiles
 *
 * Avatar auth is bypassed by intercepting /api/avatars/:id with a synthetic
 * owner-gated avatar that points at the public sample GLB.
 */

import { test, expect } from '@playwright/test';

const AVATAR_FIXTURE = {
	avatar: {
		id: 'test-avatar',
		owner_id: 'test-owner',
		name: 'Test Avatar',
		model_url: '/avatars/default.glb',
		base_model_url: '/avatars/default.glb',
		appearance: null,
	},
};

test('wardrobe editor: hover, commit, chip, search', async ({ page }) => {
	test.setTimeout(120_000);

	page.on('pageerror', (err) => {
		throw new Error(`Page error: ${err.message}`);
	});

	// Stub auth-gated avatar fetch + PATCH so the editor boots without a real
	// session. We don't intercept presets.json or the GLBs — those are served
	// by Vite from /public.
	await page.route('**/api/avatars/test-avatar', async (route) => {
		const req = route.request();
		if (req.method() === 'GET') {
			return route.fulfill({ json: AVATAR_FIXTURE });
		}
		if (req.method() === 'PATCH') {
			const body = JSON.parse(req.postData() || '{}');
			return route.fulfill({
				json: {
					avatar: {
						...AVATAR_FIXTURE.avatar,
						appearance: body.appearance || null,
						baked: false,
					},
				},
			});
		}
		return route.fallback();
	});

	await page.goto('/pages/avatar-edit.html?id=test-avatar');

	// Wait for the stage to mount and the first panel to render.
	await expect(page.locator('#ae-title')).toContainText('Test Avatar');
	await expect(page.locator('.ae-tab.active')).toHaveText(/Outfits/);
	await expect(page.locator('.ae-search')).toBeVisible();

	// Chip bar starts empty (placeholder copy via :empty::before).
	const chipBar = page.locator('#ae-chips');
	await expect(chipBar.locator('.ae-chip')).toHaveCount(0);

	// Hover the first real outfit tile and confirm the previewing class is set.
	const firstOutfit = page.locator('.ae-tile[data-id="outfit-casual"]');
	await expect(firstOutfit).toBeVisible();
	await firstOutfit.hover();
	await expect(firstOutfit).toHaveClass(/previewing/);
	await expect(page.locator('#ae-status')).toContainText(/Previewing/i);

	// Move mouse off — previewing class should drop.
	await page.locator('#ae-title').hover();
	await expect(firstOutfit).not.toHaveClass(/previewing/);

	// Click to commit. Chip appears in the chip bar.
	await firstOutfit.click();
	await expect(firstOutfit).toHaveClass(/selected/);

	// Diagnostic: peek at chip bar innerHTML after the click settles.
	await page.waitForTimeout(300);
	const debug = await page.evaluate(() => ({
		chipsHtml: document.getElementById('ae-chips')?.innerHTML,
		chipCount: document.querySelectorAll('#ae-chips .ae-chip').length,
		firstOutfitClass: document.querySelector('[data-id="outfit-casual"]')?.className,
	}));
	console.log('debug after outfit click:', JSON.stringify(debug));

	await expect(chipBar.locator('.ae-chip')).toHaveCount(1);
	await expect(chipBar.locator('.ae-chip')).toContainText('Casual');

	// Search filters: typing "form" should narrow outfits to "Formal".
	await page.locator('.ae-search').fill('form');
	await expect(page.locator('.ae-tile').filter({ hasText: 'Formal' })).toHaveCount(1);
	await expect(page.locator('.ae-tile').filter({ hasText: 'Casual' })).toHaveCount(0);
	// The None tile is hidden during search.
	await expect(page.locator('.ae-tile-none')).toHaveCount(0);

	// Clear search.
	await page.locator('.ae-search').fill('');

	// Remove via chip ×.
	await chipBar.locator('.ae-chip button[data-remove]').first().click();
	await expect(chipBar.locator('.ae-chip')).toHaveCount(0);

	// Switch to the Hats tab, hover a hat, confirm previewing.
	await page.locator('.ae-tab', { hasText: 'Hats' }).click();
	const beanie = page.locator('.ae-tile[data-id="hat-beanie"]');
	await beanie.hover();
	await expect(beanie).toHaveClass(/previewing/);
	await beanie.click();
	await expect(chipBar.locator('.ae-chip')).toContainText('Beanie');
});
