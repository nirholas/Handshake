/**
 * /animations regression cover for the browse surface's contracts, driven
 * against a small stubbed catalogue so each assertion is deterministic:
 *   • a library clip with no `thumb` in the manifest renders its icon and
 *     requests nothing (the CDN convention 404s for a third of the catalogue)
 *   • ?filter= presses the segmented button it filters by, and a ?sort= the
 *     control cannot represent falls back to Featured instead of blanking it
 *   • the detail dialog keeps no live transport while nothing is on the stage,
 *     traps Tab, and hands focus back to the card that opened it
 *
 * The preview engine itself (three.js, the avatar, the retarget pass) is left
 * to boot in the background: every assertion here is about the page's own state
 * machine, so none of them wait on WebGL.
 */

import { test, expect } from '@playwright/test';

const CURATED = [
	{ name: 'idle', url: '/animations/clips/idle.json', label: 'Idle', icon: '🧍', loop: true, duration: 15.8 },
];

// One library clip with a baked thumbnail, one without. The one without is the
// case that used to cost a doomed cross-origin request per card.
const LIBRARY = {
	clips: [
		{
			name: 'mx-test-thumbed',
			label: 'Thumbed Turn',
			loop: false,
			duration: 1.9,
			url: 'https://cdn.example.invalid/animations/library/clips/mx-test-thumbed.json',
			thumb: 'https://cdn.example.invalid/animations/library/thumbs/mx-test-thumbed.webp',
		},
		{
			name: 'mx-test-unthumbed',
			label: 'Unthumbed Walk',
			loop: true,
			duration: 2.4,
			url: 'https://cdn.example.invalid/animations/library/clips/mx-test-unthumbed.json',
		},
	],
	total: 2,
	next_offset: null,
};

// A 1x1 PNG, so a card that does publish a thumbnail keeps its <img> instead of
// falling back to the icon the way a broken one would.
const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);

async function stubCatalogue(page) {
	await page.route('**/animations/manifest.json', (r) => r.fulfill({ json: CURATED }));
	await page.route('**/api/animations/library**', (r) => r.fulfill({ json: LIBRARY }));
	await page.route('**/api/animations/clips**', (r) => r.fulfill({ json: { items: [], next_cursor: null } }));
	await page.route('https://cdn.example.invalid/**/thumbs/**', (r) =>
		r.fulfill({ contentType: 'image/png', body: PIXEL }),
	);
	// Clip payloads are never awaited here; no assertion depends on a preview.
	await page.route('https://cdn.example.invalid/**/clips/**', (r) => r.abort());
}

test.describe('/animations gallery', () => {
	test.beforeEach(async ({ page }) => {
		await stubCatalogue(page);
	});

	test('a library clip with no published thumbnail renders its icon and requests nothing', async ({ page }) => {
		test.setTimeout(90_000);
		const thumbRequests = [];
		page.on('request', (r) => {
			if (/\/thumbs\//.test(r.url())) thumbRequests.push(r.url());
		});

		await page.goto('/animations');
		await expect(page.locator('.ag-card')).toHaveCount(3);

		const unthumbed = page.locator('.ag-card', { hasText: 'Unthumbed Walk' });
		await expect(unthumbed.locator('img.ag-card-thumb')).toHaveCount(0);
		await expect(unthumbed.locator('.ag-card-thumb-fallback')).toBeVisible();

		const thumbed = page.locator('.ag-card', { hasText: 'Thumbed Turn' });
		await expect(thumbed.locator('img.ag-card-thumb')).toHaveAttribute(
			'src',
			LIBRARY.clips[0].thumb,
		);

		expect(thumbRequests.some((u) => u.includes('mx-test-unthumbed'))).toBe(false);
	});

	test('?filter= presses its button and an unrepresentable ?sort= falls back to Featured', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/animations?filter=once&sort=bogus&cat=bogus');
		await expect(page.locator('.ag-card')).toHaveCount(1);

		await expect(page.locator('[data-role="type-filter"] [data-filter="once"]')).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await expect(page.locator('[data-role="type-filter"] [data-filter=""]')).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		await expect(page.locator('[data-role="sort"]')).toHaveValue('featured');
		// An unknown category must not filter the grid down to nothing.
		await expect(page.locator('.ag-chip[aria-selected="true"]')).toHaveText(/All/);
		await expect(page.locator('.ag-card-title')).toHaveText('Thumbed Turn');
	});

	test('the detail dialog hides the transport until a clip plays, traps Tab, and restores focus', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/animations');
		await expect(page.locator('.ag-card')).toHaveCount(3);

		const details = page.locator('.ag-card', { hasText: 'Unthumbed Walk' }).locator('[data-details]');
		await details.focus();
		await details.click();

		const modal = page.locator('[data-role="modal"]');
		await expect(modal).toBeVisible();
		// Nothing is on the stage yet, so the transport must not be operable.
		await expect(page.locator('[data-role="modal-transport"]')).toBeHidden();

		// Tab must never walk out of a dialog that claims aria-modal.
		for (let i = 0; i < 10; i++) {
			await page.keyboard.press('Tab');
			const inside = await page.evaluate(() =>
				!!document.activeElement?.closest('[data-role="modal"]'),
			);
			expect(inside).toBe(true);
		}

		await page.keyboard.press('Escape');
		await expect(modal).toBeHidden();
		const returned = await page.evaluate(
			() => document.activeElement?.getAttribute('aria-label') || '',
		);
		expect(returned).toContain('Unthumbed Walk');
	});

	test('a catalogue that answers empty offers publishing; one that errors offers Retry', async ({ page }) => {
		test.setTimeout(90_000);
		await page.route('**/api/animations/library**', (r) => r.fulfill({ json: { clips: [], next_offset: null } }));
		await page.route('**/animations/manifest.json', (r) => r.fulfill({ json: [] }));
		await page.goto('/animations');
		await expect(page.locator('[data-role="empty"]')).toBeVisible();
		await expect(page.locator('[data-role="error"]')).toBeHidden();

		// Same empty result, but one source failed: that is an error, not an
		// invitation to be the first to publish.
		await page.route('**/api/animations/library**', (r) => r.abort());
		await page.goto('/animations');
		await expect(page.locator('[data-role="error"]')).toBeVisible();
		await expect(page.locator('[data-role="empty"]')).toBeHidden();
		await expect(page.locator('[data-role="retry"]')).toBeEnabled();
	});
});
