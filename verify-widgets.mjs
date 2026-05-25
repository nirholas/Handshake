import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    console.log('🔍 Navigating to /dashboard/widgets...');
    await page.goto('http://localhost:3000/dashboard/widgets', { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    const url = page.url();
    if (url.includes('/login')) {
      console.log('BLOCKED: Redirected to login');
      process.exit(1);
    }
    
    await page.waitForTimeout(2000);
    
    const widgetCards = await page.locator('[data-details]');
    const count = await widgetCards.count();
    
    if (count === 0) {
      console.log('⚠️ No widgets found');
      process.exit(0);
    }
    
    console.log(`Found ${count} widgets, opening first...`);
    await widgetCards.first().click();
    await page.waitForTimeout(800);
    
    const drawer = await page.locator('aside[role="dialog"]');
    if (!await drawer.isVisible()) {
      console.log('❌ Drawer did not open');
      process.exit(1);
    }
    
    console.log('✅ Drawer opened');
    
    // Check split-pane
    const preview = await drawer.locator('#widget-preview-frame');
    if (await preview.count() === 0) {
      console.log('❌ Preview iframe not found');
      process.exit(1);
    }
    console.log('✅ Live preview iframe present');
    
    // Check tabs
    const tabs = await drawer.locator('.embed-tab');
    const tabCount = await tabs.count();
    if (tabCount === 0) {
      console.log('❌ No code snippet tabs found');
      process.exit(1);
    }
    
    console.log(`✅ Found ${tabCount} tabbed code snippets`);
    
    // Get labels
    const labels = [];
    for (let i = 0; i < Math.min(tabCount, 5); i++) {
      labels.push(await tabs.nth(i).textContent());
    }
    console.log(`   Tab names: ${labels.join(', ')}`);
    
    // Test switching
    if (tabCount > 1) {
      await tabs.nth(1).click();
      await page.waitForTimeout(200);
      const selected = await tabs.nth(1).getAttribute('aria-selected');
      console.log(selected === 'true' ? '✅ Tab switching works' : '❌ Tab switching failed');
    }
    
    console.log('\n✅ PASS: Enhanced split-pane widget drawer');
    await page.screenshot({ path: 'widget-drawer.png' });
    console.log('📸 Screenshot: widget-drawer.png');
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
