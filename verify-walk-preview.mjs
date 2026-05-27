import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ 
    args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Block heavy external scripts to avoid OOM
  await context.route('**/agent-3d/**', route => route.abort());
  
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(`PAGE ERROR: ${err.message}`));

  await page.goto('http://localhost:3002/home-next', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('Page loaded. URL:', page.url());

  const container = await page.waitForSelector('#walk-preview-container', { timeout: 5000 }).catch(() => null);
  console.log(`Container found: ${!!container}`);

  if (!container) {
    await page.screenshot({ path: '/tmp/walk-debug.png' });
    console.log('FAIL: no container. Debug screenshot at /tmp/walk-debug.png');
    await browser.close();
    return;
  }

  await container.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/walk-preview-loading.png' });
  console.log('Loading screenshot saved.');

  // Wait for avatar to load (Three.js scene)
  const loaded = await page.waitForSelector('[data-walk-loading].is-done', { timeout: 25000 }).catch(() => null);
  console.log(`Avatar loaded: ${!!loaded}`);

  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/walk-preview-loaded.png' });
  console.log('Loaded screenshot saved.');

  const hint = await page.locator('.walk-preview-hint').isVisible().catch(() => false);
  const code = await page.locator('#walk-preview-container .bento-code').isVisible().catch(() => false);
  const canvas = await page.locator('.walk-preview-canvas').boundingBox().catch(() => null);
  console.log(`Hint: ${hint}, Code: ${code}, Canvas: ${JSON.stringify(canvas)}`);

  const walkErrors = consoleErrors.filter(e => e.toLowerCase().includes('walk') || e.toLowerCase().includes('nipple'));
  console.log(`Walk-related errors: ${walkErrors.length}`);
  walkErrors.forEach(e => console.log(`  ${e.substring(0, 200)}`));
  console.log(`Total console errors: ${consoleErrors.length}`);
  
  await browser.close();
  console.log('Done.');
})();
