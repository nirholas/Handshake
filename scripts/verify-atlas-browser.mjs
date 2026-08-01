#!/usr/bin/env node
// Drive the Atlas palette in a real browser and prove the things a curl cannot:
// that Cmd+K actually opens it, that typing ranks results, that Enter navigates,
// and that the console stays clean throughout.
//
// Usage: node scripts/verify-atlas-browser.mjs [baseUrl]
//   defaults to http://localhost:3000 (npm run dev)

import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
const shots = [];
let failures = 0;

function check(label, ok, detail = '') {
	if (ok) console.log(`  ok    ${label}`);
	else {
		failures++;
		console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
	}
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

console.log(`\nAtlas palette, ${BASE}`);
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

check('the palette script loaded on a page that is not /atlas', await page.evaluate(() => !!window.__twsAtlas));

// Cmd+K on a Linux headless browser is Control+K.
await page.keyboard.press('Control+k');
await page.waitForSelector('.tws-atlas[data-open]', { timeout: 4000 });
check('Ctrl+K opens the overlay', await page.isVisible('.tws-atlas-card'));
check(
	'the empty state offers tasks instead of a blank box',
	(await page.locator('.tws-atlas-row[data-kind="intent"]').count()) > 0,
);
shots.push(['atlas-empty', await page.screenshot({ path: '/tmp/atlas-empty.png' })]);

await page.fill('.tws-atlas-input', 'get paid');
await page.waitForTimeout(250);
const firstIntent = await page.locator('.tws-atlas-row[data-kind="intent"] .tws-atlas-row-title span').first().textContent();
check('a goal query surfaces the task shortcut', /get paid/i.test(firstIntent || ''), firstIntent);
check(
	'the task renders its numbered steps as links',
	(await page.locator('.tws-atlas-row[data-kind="intent"] .tws-atlas-step a').count()) >= 2,
);

await page.fill('.tws-atlas-input', 'marketplce');
await page.waitForTimeout(250);
const typoTop = await page.locator('.tws-atlas-row[data-kind="page"] .tws-atlas-path').first().textContent();
check('a typo still finds the page', typoTop === '/marketplace', typoTop);

await page.fill('.tws-atlas-input', 'x402');
await page.waitForTimeout(250);
const x402Top = await page.locator('.tws-atlas-row[data-kind="page"] .tws-atlas-path').first().textContent();
check('the canonical route outranks its docs', x402Top === '/x402', x402Top);
check('matched letters are highlighted', (await page.locator('.tws-atlas-row mark').count()) > 0);
await page.screenshot({ path: '/tmp/atlas-search.png' });

// Keyboard navigation moves the selection.
const before = await page.getAttribute('.tws-atlas-input', 'aria-activedescendant');
await page.keyboard.press('ArrowDown');
const after = await page.getAttribute('.tws-atlas-input', 'aria-activedescendant');
check('arrow keys move the active row', before !== after, `${before} -> ${after}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape closes it', !(await page.isVisible('.tws-atlas-card')));

// Enter navigates.
await page.keyboard.press('Control+k');
await page.waitForSelector('.tws-atlas[data-open]');
await page.fill('.tws-atlas-input', '/status');
await page.waitForTimeout(250);
await page.keyboard.press('Enter');
await page.waitForURL('**/status', { timeout: 6000 });
check('Enter navigates to the selected route', page.url().endsWith('/status'));

// The map page.
await page.goto(`${BASE}/atlas`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.at-section', { timeout: 8000 });
const sections = await page.locator('.at-section').count();
const cards = await page.locator('.at-card').count();
check('the map renders every section', sections >= 10, `${sections} sections`);
check('the map renders the full route table', cards > 500, `${cards} cards`);
check('the section rail is populated', (await page.locator('.at-chip').count()) >= 10);
await page.screenshot({ path: '/tmp/atlas-map.png', fullPage: false });

await page.fill('#at-q', 'wallet');
await page.waitForTimeout(300);
const filtered = await page.locator('.at-card').count();
check('typing filters the map', filtered > 0 && filtered < cards, `${filtered} of ${cards}`);
check('the live region reports the count', /match/i.test((await page.textContent('#at-live')) || ''));
await page.screenshot({ path: '/tmp/atlas-map-filtered.png' });

// A shared filtered URL must restore its own state.
await page.goto(`${BASE}/atlas?q=x402`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
check('a shared ?q= link restores the filter', (await page.inputValue('#at-q')) === 'x402');

const realErrors = consoleErrors.filter((e) => !/favicon|manifest|404 \(Not Found\)|net::ERR/i.test(e));
check('no console errors from our code', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(
	failures === 0
		? `\nAll checks passed. Screenshots: /tmp/atlas-empty.png /tmp/atlas-search.png /tmp/atlas-map.png /tmp/atlas-map-filtered.png\n`
		: `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
