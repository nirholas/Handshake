// Portal, driven the way a visitor drives it: type an address, get a place,
// walk it. A DOM assertion cannot see whether a world is walkable, so this spec
// reads the renderer's own player position before and after pressing a key.
//
// It runs against the Vite dev server, whose /api/* is proxied to a real API
// (production by default), so the world under test is built from a real page.
import { test, expect } from '@playwright/test';

const TARGET = 'example.com';

test.describe('/portal', () => {
	test('builds a world from an address and lets a visitor walk it', async ({ page }) => {
		test.setTimeout(180_000);
		const failures = [];
		page.on('pageerror', (err) => failures.push(err.message));

		await page.goto(`/portal?url=${encodeURIComponent(TARGET)}`);

		// The build overlay goes away only when a real world has been mounted.
		await expect(page.locator('#pt-loading')).toBeHidden({ timeout: 120_000 });
		await expect(page.locator('#pt-intro')).toBeHidden();
		await expect(page.locator('#pt-error')).toBeHidden();

		// The HUD reports what the page actually turned into.
		await expect(page.locator('#pt-site-title')).not.toHaveText(/^\s*$/);
		await expect(page.locator('#pt-site-meta')).toContainText(TARGET);
		await expect(page.locator('#pt-site-meta')).toContainText('section');
		await expect(page.locator('#pt-address')).toBeVisible();
		await expect(page.locator('#pt-map')).toBeVisible();

		// The world is live: the canvas has a real drawing buffer.
		const canvas = await page.evaluate(() => {
			const c = document.getElementById('pt-canvas');
			return { w: c.width, h: c.height };
		});
		expect(canvas.w).toBeGreaterThan(300);
		expect(canvas.h).toBeGreaterThan(200);

		// Walk. The avatar must actually move through the world.
		await page.waitForFunction(() => typeof window.__portalPlayer === 'function');
		const before = await page.evaluate(() => window.__portalPlayer());
		await page.keyboard.down('KeyW');
		await page.waitForTimeout(2000);
		await page.keyboard.up('KeyW');
		const after = await page.evaluate(() => window.__portalPlayer());
		const moved = Math.hypot(after.x - before.x, after.z - before.z);
		expect(moved).toBeGreaterThan(0.25);

		expect(failures).toEqual([]);
	});

	test('explains itself before a world exists, and after a bad address', async ({ page }) => {
		test.setTimeout(120_000);
		await page.goto('/portal');
		await expect(page.locator('#pt-intro')).toBeVisible();
		await expect(page.locator('#pt-intro-title')).toHaveText(/walk any website/i);
		await expect(page.locator('#pt-examples .pt-chip').first()).toBeVisible();

		await page.fill('#pt-intro-input', 'not a web address at all');
		await page.click('#pt-intro-form button[type="submit"]');
		await expect(page.locator('#pt-error')).toBeVisible({ timeout: 60_000 });
		await expect(page.locator('#pt-error-message')).not.toHaveText(/^\s*$/);
		// The failure state is a way forward, not a dead end.
		await expect(page.locator('#pt-error-form')).toBeVisible();
	});
});
