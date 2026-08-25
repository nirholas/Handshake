// /compare: the defects the route audit found, all of which reproduce on the
// pre-fix page.
//
// 1. `.cmp-table td` (specificity 0,1,1) outranked a bare `.cv-up` / `.cv-down`
//    (0,1,0), so every percentage cell rendered the same neutral text colour and
//    a loss was indistinguishable from a gain. The one exception made it worse:
//    `.cmp-table td.best` forced green, so the smallest drawdown in a "From ATH"
//    row was painted green while still being a loss.
//
// 2. The overlay drew into a fixed 760-wide viewBox scaled down by CSS. On a
//    320px screen that is a 254px column, so the 10px axis labels rendered at
//    roughly 3px and the plot squashed to 100px tall.
//
// 3. Range reloads had no sequencing guard. Clicking 1Y and then 7D, with the
//    1Y response slower, repainted a year of history under a chart whose label
//    and pressed button both said 7 days.
//
// The upstream market API is fulfilled at the route layer, per the fidelity
// contract in _support.js: these assertions need a known sign on a known row
// and a controlled response order, neither of which a live feed can give. The
// module under test is the real shipped src/compare.js. Coin ids are synthetic
// so the fixtures name no project.

import { test, expect } from '@playwright/test';

const COINS = {
	'alpha-token': {
		symbol: 'ALFA',
		name: 'Alpha Token',
		// Up on the day, down from its high: the pair of signs the table has to
		// tell apart within a single column.
		h24: 4.2,
		d7: 11.5,
		d30: 18.25,
		ath_change_pct: -12.5,
		market_cap: 900_000_000,
	},
	'beta-token': {
		symbol: 'BETA',
		name: 'Beta Token',
		h24: -3.75,
		d7: -8.25,
		d30: 6.5,
		// The smaller drawdown, so it wins the row while still being a loss.
		ath_change_pct: -4.25,
		market_cap: 400_000_000,
	},
};

function detailFor(id) {
	const c = COINS[id];
	return {
		coin: {
			id,
			symbol: c.symbol,
			name: c.name,
			image: '',
			rank: 1,
			market: {
				price: 12.5,
				market_cap: c.market_cap,
				fdv: c.market_cap * 2,
				volume_24h: 25_000_000,
				change_pct: { h24: c.h24, d7: c.d7, d30: c.d30 },
				circulating: 72_000_000,
				ath: 40,
				ath_change_pct: c.ath_change_pct,
			},
		},
	};
}

/** A deterministic walk, dense enough that the chart has a real path to draw. */
function seriesFor(days, seed) {
	const end = Date.UTC(2026, 7, 25);
	const step = (days * 86_400_000) / 60;
	return Array.from({ length: 61 }, (_, i) => [
		end - (60 - i) * step,
		100 + seed * 10 + Math.sin((i + seed) / 6) * 12,
	]);
}

/**
 * Serve the two endpoints /compare reads. `slowDays` holds that window's OHLC
 * back so a later click can overtake it.
 */
async function stubMarketApi(page, { slowDays = null, slowMs = 4000 } = {}) {
	await page.route('**/api/coin/detail**', (route) => {
		const id = new URL(route.request().url()).searchParams.get('id');
		if (!COINS[id]) return route.fulfill({ status: 404, json: { error: 'not found' } });
		return route.fulfill({ json: detailFor(id) });
	});
	await page.route('**/api/coin/ohlc**', async (route) => {
		const params = new URL(route.request().url()).searchParams;
		const days = Number(params.get('days'));
		const id = params.get('id');
		if (slowDays !== null && days === slowDays) {
			await new Promise((resolve) => setTimeout(resolve, slowMs));
		}
		const seed = Object.keys(COINS).indexOf(id) + 1;
		return route.fulfill({ json: { data: seriesFor(days, seed) } });
	});
}

const BOTH = '/compare?ids=alpha-token,beta-token';

/** Wait for the overlay to finish its first draw. */
async function drawn(page) {
	await expect(page.locator('#cmp-chart svg')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cmp-table tbody tr').first()).toBeVisible({ timeout: 30_000 });
}

test('the stats table colours every percentage by its sign, winners included', async ({ page }) => {
	await stubMarketApi(page);
	await page.goto(BOTH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await drawn(page);

	const cellColour = (row, col) =>
		page.evaluate(
			([r, c]) => {
				const tr = [...document.querySelectorAll('.cmp-table tbody tr')].find(
					(x) => x.querySelector('th').textContent.trim() === r,
				);
				const td = tr.querySelectorAll('td')[c];
				return { text: td.textContent.trim(), colour: getComputedStyle(td).color };
			},
			[row, col],
		);

	const up = await cellColour('24h %', 0);
	const down = await cellColour('24h %', 1);
	expect(up.text).toContain('+4.20');
	expect(down.text).toContain('-3.75');
	// Same row, opposite signs: they must not resolve to the same colour.
	expect(up.colour).not.toBe(down.colour);

	// "From ATH" is negative for both, and the row winner is the smaller loss.
	// Before the fix `.best` painted that cell green.
	const worstAth = await cellColour('From ATH', 0);
	const bestAth = await cellColour('From ATH', 1);
	expect(bestAth.text).toContain('(best)'); // marked for screen readers, not by colour alone
	expect(bestAth.colour).toBe(worstAth.colour);
	expect(bestAth.colour).not.toBe(up.colour);
});

test('the overlay is drawn at the width of its panel, with a legible date axis', async ({
	page,
}) => {
	await stubMarketApi(page);
	await page.setViewportSize({ width: 320, height: 900 });
	await page.goto(BOTH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await drawn(page);

	const svg = page.locator('#cmp-chart svg');
	const viewBox = await svg.getAttribute('viewBox');
	const box = await svg.boundingBox();
	const declared = Number(viewBox.split(' ')[2]);
	// 1:1 with the rendered box (a small clamp floor aside), never a 760-wide
	// desktop viewBox squeezed into a phone column.
	expect(declared).toBeLessThan(400);
	expect(box.height).toBeGreaterThan(200);

	// The reserved bottom band carries dates, not empty space.
	const axis = await page.$$eval('#cmp-chart svg text', (nodes) =>
		nodes.map((n) => n.textContent).filter((t) => !t.endsWith('%')),
	);
	expect(axis.length).toBeGreaterThanOrEqual(3);

	// A phone must not end up scrolling the page sideways.
	const overflows = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	);
	expect(overflows).toBe(false);
});

test('a slow range answer never repaints under a newer range', async ({ page }) => {
	await stubMarketApi(page, { slowDays: 365, slowMs: 4000 });
	await page.goto(BOTH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await drawn(page);

	await page.click('.cv-range-btn[data-days="365"]');
	await page.waitForTimeout(300);
	await page.click('.cv-range-btn[data-days="7"]');
	// Long enough for the held-back 1Y response to land after the 7D one.
	await page.waitForTimeout(9000);

	await expect(page.locator('.cv-range-btn[data-days="7"]')).toHaveAttribute(
		'aria-pressed',
		'true',
	);
	await expect(page.locator('#cmp-chart svg')).toHaveAttribute('aria-label', /over 7 days/);
	// The 7D window spans a week, so no axis tick may carry a year marker.
	const axis = await page.$$eval('#cmp-chart svg text', (nodes) =>
		nodes.map((n) => n.textContent).filter((t) => !t.endsWith('%')),
	);
	expect(axis.length).toBeGreaterThan(0);
	expect(axis.some((t) => t.includes("'"))).toBe(false);
});

test('a selection that resolves to nothing says so instead of offering a dead retry', async ({
	page,
}) => {
	await stubMarketApi(page);
	await page.goto('/compare?ids=no-such-token-here', {
		waitUntil: 'domcontentloaded',
		timeout: 60_000,
	});
	const state = page.locator('#cmp-chart .cv-chart-state');
	await expect(state).toContainText('exists in the market index', { timeout: 30_000 });
	await expect(page.locator('#cmp-chart-retry')).toHaveCount(0);
	await expect(page.locator('#cmp-table .cv-skel')).toHaveCount(0);
	await expect(page.locator('.cmp-issues')).toContainText('No coin matches');

	// The offered recovery clears the selection and the URL with it.
	await page.click('[data-drop-missing]');
	await expect(page.locator('.cmp-chip')).toHaveCount(0);
	await expect(state).toContainText('Add a coin');
	expect(new URL(page.url()).searchParams.get('ids')).toBeNull();
});
