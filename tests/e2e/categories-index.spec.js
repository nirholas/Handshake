// /categories: the three defects the route audit found, all of which reproduce
// on the pre-fix page.
//
// 1. CoinGecko reports 750+ categories and the table rendered every one of them
//    on first paint, roughly 2,250 lazy coin icons in a single layout pass, with
//    no way to reach a sector but to scroll past everything ranked above it.
//    src/categories.js now pages 50 rows at a time behind a search box.
//
// 2. A failed fetch, an upstream reporting nothing, and a search that matched
//    nothing all rendered the same dead-end sentence with no control on it. Each
//    is now its own message with an action that recovers from it.
//
// 3. Sortable headers announced nothing to a screen reader (no aria-sort on the
//    inactive columns) and sorting by keyboard dropped focus back to the
//    document, because the header node is replaced by the re-render.
//
// The upstream list is live, so every assertion is about structure and counts
// rather than a specific category being present at a specific rank.

import { test, expect } from '@playwright/test';

const PAGE_SIZE = 50;
const ROWS = '#cat-table tbody tr';

async function loadPopulated(page) {
	await page.goto('/categories', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForSelector(ROWS, { timeout: 60_000 });
}

test('/categories pages the sector list instead of painting every row at once', async ({ page }) => {
	await loadPopulated(page);

	await expect(page.locator(ROWS)).toHaveCount(PAGE_SIZE);
	await expect(page.locator('#cat-count')).toHaveText(/Showing 50 of [\d,]+ categories/);

	// The avatar stack is three icons per row, so the row cap is what keeps the
	// image count off the four-figure mark the audit measured.
	expect(await page.locator('#cat-table img').count()).toBeLessThanOrEqual(PAGE_SIZE * 3);

	await page.click('#cat-table [data-act="more"]');
	await expect(page.locator(ROWS)).toHaveCount(PAGE_SIZE * 2);
	await expect(page.locator('#cat-count')).toHaveText(/Showing 100 of [\d,]+ categories/);
});

test('/categories search narrows the full list, and a miss offers its own way out', async ({ page }) => {
	await loadPopulated(page);
	const total = Number(
		(await page.locator('#cat-count').textContent()).match(/of ([\d,]+)/)[1].replace(/,/g, ''),
	);
	expect(total).toBeGreaterThan(PAGE_SIZE);

	// "stablecoin" matches several sectors well past the first page, so a hit
	// proves the filter reads the whole list and not just the rendered rows.
	await page.fill('#cat-search-input', 'stablecoin');
	await expect(page.locator('#cat-count')).toHaveText(/of [\d,]+ categories match/);
	const names = await page.locator('#cat-table tbody .nm').allTextContents();
	expect(names.length).toBeGreaterThan(0);
	for (const n of names) expect(n.toLowerCase()).toContain('stablecoin');

	await page.fill('#cat-search-input', 'zzz-no-such-sector');
	const miss = page.locator('#cat-table .cv-empty');
	await expect(miss).toContainText('No category matches');
	await miss.locator('[data-act="clear"]').click();

	await expect(page.locator(ROWS)).toHaveCount(PAGE_SIZE);
	await expect(page.locator('#cat-search-input')).toHaveValue('');
});

test('/categories offers a working retry when the feed fails, and distinct copy when it is empty', async ({
	page,
}) => {
	await page.route('**/api/coin/categories', (r) =>
		r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_error"}' }),
	);
	await page.goto('/categories', { waitUntil: 'domcontentloaded', timeout: 60_000 });

	const state = page.locator('#cat-table .cv-empty');
	await expect(state).toContainText('The market data provider did not answer');
	// The search box is meaningless with nothing to search, so it stays hidden.
	await expect(page.locator('#cat-search')).toBeHidden();

	// An empty upstream is a different fact and must not borrow the failure copy.
	await page.unroute('**/api/coin/categories');
	await page.route('**/api/coin/categories', (r) =>
		r.fulfill({ status: 200, contentType: 'application/json', body: '{"categories":[]}' }),
	);
	await state.locator('[data-act="retry"]').click();
	await expect(state).toContainText('No categories are being reported right now');

	// And the retry recovers for real once the feed answers again.
	await page.unroute('**/api/coin/categories');
	await state.locator('[data-act="retry"]').click();
	await expect(page.locator(ROWS)).toHaveCount(PAGE_SIZE, { timeout: 60_000 });
	await expect(page.locator('#cat-search')).toBeVisible();
});

test('/categories headers announce their sort state and keep keyboard focus', async ({ page }) => {
	await loadPopulated(page);

	// Every sortable column carries aria-sort; only the active one is not "none".
	const sorts = await page
		.locator('#cat-table th[data-key]')
		.evaluateAll((els) => els.map((e) => e.getAttribute('aria-sort')));
	expect(sorts.length).toBe(5);
	expect(sorts.every((s) => s !== null)).toBe(true);
	expect(sorts.filter((s) => s !== 'none')).toEqual(['ascending']);

	const header = page.locator('#cat-table th[data-key="market_cap"]');
	await header.focus();
	await page.keyboard.press('Enter');

	await expect(page.locator('#cat-table th[data-key="market_cap"]')).toHaveAttribute(
		'aria-sort',
		'descending',
	);
	// The re-render replaces the node, so focus has to be re-homed deliberately.
	expect(await page.evaluate(() => document.activeElement?.dataset?.key)).toBe('market_cap');
});
