/**
 * Gallery picker smoke. Drives the page against the live /api/avatars/public
 * feed and the dev-server-served avatar-sdk bundle. Verifies:
 *   • cards render from real API data
 *   • selecting a card builds the preview pane
 *   • each handoff mode produces the correct payload in the preview
 *   • the embed snippet uses the new avatar-id attribute
 *   • ?id= deep-links auto-select on first paint
 *   • the SDK bundle resolves avatar-id against /api/avatars/:id
 */

import { test, expect } from '@playwright/test';

test.describe('demos/gallery-picker', () => {
	test('renders public avatars and produces correct handoff payloads', async ({ page }) => {
		test.setTimeout(90_000);

		page.on('pageerror', (err) => {
			throw new Error(`Page error: ${err.message}`);
		});

		await page.goto('/demos/gallery-picker.html');

		// Wait for at least one card from the live feed. The API degrades to
		// an empty array on DB failure, so we explicitly require >0 cards.
		const firstCard = page.locator('.card[data-id]').first();
		await firstCard.waitFor({ state: 'visible', timeout: 30_000 });

		const cardCount = await page.locator('.card[data-id]').count();
		expect(cardCount).toBeGreaterThan(0);

		const avatarId = await firstCard.getAttribute('data-id');
		expect(avatarId).toBeTruthy();

		await firstCard.click();

		// The preview pane should now show the avatar's name and enable CTA.
		await expect(page.locator('#cta')).toBeEnabled();

		// — Share-link mode (default)
		await expect(page.locator('#preview-foot')).toContainText(
			`https://three.ws/avatars/${avatarId}`,
		);

		// — GLB URL mode. The radio inputs are CSS-hidden (display:none) so the
		//   visible affordance is the wrapping <label>; click that to flip the
		//   input via native HTML behavior.
		await page.locator('label:has(input[name="mode"][value="glb"])').click();
		const glbText = await page.locator('#preview-foot').textContent();
		expect(glbText).toMatch(/^https?:\/\//);
		expect(glbText).toMatch(/\.glb($|\?)/i);

		// — Embed-snippet mode: must use the new `avatar-id` attribute, not the
		//   broken `<agent-3d avatar-id="">` that 404'd against the old element.
		await page.locator('label:has(input[name="mode"][value="embed"])').click();
		const embedText = await page.locator('#preview-foot').textContent();
		expect(embedText).toContain('/avatar-sdk/dist/index.mjs');
		expect(embedText).toContain(`avatar-id="${avatarId}"`);
		expect(embedText).toContain('<agent-3d');

		// URL should have been synced to include the selection.
		expect(page.url()).toContain(`id=${avatarId}`);
	});

	test('?id= deep-link auto-selects on first paint', async ({ page, request }) => {
		test.setTimeout(60_000);

		// Pull a real avatar id from the live feed so the test data matches
		// what the deep-link path will actually resolve.
		const res = await request.get('/api/avatars/public?limit=1');
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		const avatar = body?.avatars?.[0];
		test.skip(!avatar?.id, 'no public avatars available to deep-link to');

		page.on('pageerror', (err) => {
			throw new Error(`Page error: ${err.message}`);
		});

		await page.goto(`/demos/gallery-picker.html?id=${avatar.id}`);

		// CTA enables only once an avatar is selected — wait on that as the
		// "deep-link hydrated" signal, then assert the preview matches.
		await expect(page.locator('#cta')).toBeEnabled({ timeout: 30_000 });
		await expect(page.locator('#preview-foot')).toContainText(
			`https://three.ws/avatars/${avatar.id}`,
		);
	});

	test('SDK resolves <agent-3d avatar-id="..."> via /api/avatars/:id', async ({ page }) => {
		test.setTimeout(90_000);

		page.on('pageerror', (err) => {
			throw new Error(`Page error: ${err.message}`);
		});

		await page.goto('/demos/avatar-sdk.html');

		// Section 2 mounts a real public avatar by id once the SDK has
		// registered. Wait for the success line in its log.
		const byIdLog = page.locator('#byid-log');
		await expect(byIdLog).toContainText('mounted', { timeout: 30_000 });
		await expect(byIdLog).not.toContainText('failed');
	});
});
