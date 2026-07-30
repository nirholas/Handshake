import { chromium } from 'playwright';
const BASE = 'http://localhost:3004';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/websocket|vite.*connect/i.test(t)) return; // codespaces HMR noise
  errors.push(t);
});
const out = {};

await page.goto(BASE + '/docs/world', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__docsWorld !== undefined, { timeout: 60000 });
await page.waitForTimeout(3500);

out.hudVisible = await page.isVisible('#dw-hud');
out.loadingHidden = await page.isHidden('#dw-loading');
out.pavilions = await page.evaluate(() => window.__docsWorld.world.pavilions.length);
out.indexItems = await page.locator('.dw-index-item').count();
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-01-world.png' });

// Open the index overlay and teleport to a section
await page.click('#dw-index-btn');
await page.waitForTimeout(400);
out.indexOpen = await page.isVisible('#dw-index');
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-02-index.png' });
await page.locator('.dw-index-item').first().click();
await page.waitForTimeout(900);
out.panelOpenAfterIndex = await page.isVisible('#dw-panel');
out.panelTitle = await page.textContent('#dw-panel-title');
out.panelLinks = await page.locator('.dw-panel-link').count();
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-03-panel.png' });

// Open a real doc from the panel
await page.locator('.dw-panel-link').first().click();
await page.waitForTimeout(2500);
out.readerOpen = await page.isVisible('#dw-reader');
out.readerCrumb = await page.textContent('#dw-reader-crumb');
out.readerHasHeadings = await page.locator('#dw-reader-body h1, #dw-reader-body h2').count();
out.readerTextLen = (await page.textContent('#dw-reader-body') || '').trim().length;
out.hashAfterOpen = await page.evaluate(() => location.hash);
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-04-reader.png' });

// Pager
out.pagerNextLabel = await page.textContent('#dw-reader-next');
out.pagerPrevDisabled = await page.getAttribute('#dw-reader-prev', 'disabled') !== null;

// Escape closes the reader
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
out.readerClosedByEsc = await page.isHidden('#dw-reader');

// Deep link
await page.goto(BASE + '/docs/world#forge', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__docsWorld !== undefined, { timeout: 60000 });
await page.waitForTimeout(3000);
out.deepLinkReaderOpen = await page.isVisible('#dw-reader');
out.deepLinkCrumb = await page.textContent('#dw-reader-crumb');
out.deepLinkTextLen = (await page.textContent('#dw-reader-body') || '').trim().length;
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-05-deeplink.png' });

await browser.close();
console.log(JSON.stringify(out, null, 2));
console.log('CONSOLE ERRORS:', errors.length ? errors : 'none');
