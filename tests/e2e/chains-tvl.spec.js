// /chains: the defects the route audit found, all of which reproduce on the
// pre-fix page.
//
// 1. Every row carries data-href and a click handler that navigates. Dragging
//    across a cell to copy a TVL figure ends in a click on that row, so the
//    page threw the selection away and left for /chain/:name instead. There was
//    no way to copy a number off the leaderboard.
//
// 2. The page wrapped the shared nav in its own <header>, and nav.html supplies
//    <header class="nav"> of its own. Two banner landmarks, one nested inside
//    the other, which is three axe violations and an ambiguous landmark tree.
//
// 3. src/chains.js briefly shipped its row-click helpers declared twice at
//    module scope. A redeclaration is a SyntaxError, so the module never
//    evaluated and the page sat on its skeleton forever. The hydration
//    assertions here fail loudly on any repeat of that.
//
// DeFiLlama is live, so the assertions are about structure and behaviour rather
// than a chain sitting at a particular rank.

import { test, expect } from '@playwright/test';
import { collectPageErrors } from './_support.js';

const ROWS = '#chains-table tbody tr';

async function loadPopulated(page) {
	await page.goto('/chains', { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForSelector(ROWS, { timeout: 60_000 });
}

test('/chains hydrates the live board from DeFiLlama with no uncaught error', async ({ page }) => {
	const errors = collectPageErrors(page);
	await loadPopulated(page);

	// A redeclaration SyntaxError shows up exactly here: the module never runs,
	// so no row, stat card or attribution line is ever painted.
	expect(await page.locator(ROWS).count()).toBeGreaterThan(1);
	await expect(page.locator('#chains-stats .cv-stat-card')).toHaveCount(3);
	await expect(page.locator('#chains-updated')).toContainText('Data: DeFiLlama');
	expect(errors).toEqual([]);

	// Every row links to a chain page that the route table actually serves.
	const hrefs = await page.locator(`${ROWS} td.name-cell a`).evaluateAll((a) => a.map((e) => e.getAttribute('href')));
	expect(hrefs.length).toBe(await page.locator(ROWS).count());
	for (const href of hrefs) expect(href).toMatch(/^\/chain\/[A-Za-z0-9 ._%-]{1,40}$/);
});

test('/chains lets a visitor select a figure out of a row instead of navigating away', async ({
	page,
}) => {
	await loadPopulated(page);

	const cell = page.locator(`${ROWS} td.price`).nth(1);
	const box = await cell.boundingBox();
	await page.mouse.move(box.x + 4, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 });
	await page.mouse.up();

	// The drag ends inside a row that has a click handler on it. Before the fix
	// this navigated and discarded the selection.
	await expect(page).toHaveURL(/\/chains$/);
	const selected = await page.evaluate(() => window.getSelection().toString().trim());
	expect(selected).toMatch(/\$/);
});

test('/chains still opens a chain page on a plain click anywhere in the row', async ({ page }) => {
	await loadPopulated(page);

	const row = page.locator(ROWS).first();
	const href = await row.getAttribute('data-href');
	expect(href).toMatch(/^\/chain\//);

	// Clicking a cell that is not the name anchor exercises the row handler
	// itself, which the drag guard must not have disabled.
	await row.locator('td.price').click();
	await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
});

test('/chains declares exactly one banner landmark', async ({ page }) => {
	await loadPopulated(page);

	const banners = page.locator('header, [role="banner"]');
	await expect(banners).toHaveCount(1);
	await expect(banners.first()).toHaveClass(/\bnav\b/);
});

test('/chains sorts by keyboard and keeps focus on the header that was activated', async ({
	page,
}) => {
	await loadPopulated(page);

	const dominance = page.locator('#chains-table th[data-key="share_pct"]');
	await expect(dominance).toHaveAttribute('aria-sort', 'none');
	await dominance.focus();
	await page.keyboard.press('Enter');

	// The header node is replaced by the re-render, so without the refocus the
	// keyboard user is dropped back to the document.
	await expect(page.locator('#chains-table th[data-key="share_pct"]')).toHaveAttribute(
		'aria-sort',
		'descending',
	);
	expect(await page.evaluate(() => document.activeElement.dataset.key)).toBe('share_pct');
});

test('/chains offers a working retry when the feed fails, and distinct copy when it is empty', async ({
	page,
}) => {
	await page.route('**/api/defi/chains', (r) => r.abort());
	await page.goto('/chains', { waitUntil: 'domcontentloaded', timeout: 60_000 });

	const failed = page.locator('#chains-table .cv-empty');
	await expect(failed).toContainText('temporarily unavailable');
	// A "$0.00" total would read as a claim that cross-chain TVL is zero.
	await expect(page.locator('#chains-stats .cv-stat-card')).toHaveCount(0);

	await page.unroute('**/api/defi/chains');
	await failed.locator('[data-act="retry"]').click();
	await page.waitForSelector(ROWS, { timeout: 60_000 });
	expect(await page.locator(ROWS).count()).toBeGreaterThan(1);

	await page.route('**/api/defi/chains', (r) =>
		r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ total_tvl: 0, chain_count: 0, chains: [], updated_at: Date.now() }),
		}),
	);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.locator('#chains-table .cv-empty')).toContainText('No chain TVL is being reported');
});

test('/chains fits a 320px viewport without a sideways scroll', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 900 });
	await loadPopulated(page);

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	);
	expect(overflow).toBe(false);

	// The rank and share-bar columns drop out below 640px so chain, TVL and
	// dominance all land inside the viewport rather than behind a scroller.
	const wrapScrolls = await page.evaluate(() => {
		const w = document.querySelector('#chains-table .cv-table-wrap');
		return w.scrollWidth > w.clientWidth + 1;
	});
	expect(wrapScrolls).toBe(false);
	await expect(page.locator('#chains-table th[data-key="tvl"]')).toBeVisible();
	await expect(page.locator('#chains-table th[data-key="share_pct"]')).toBeVisible();
});
