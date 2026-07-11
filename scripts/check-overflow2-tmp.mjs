import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
await page.goto('http://localhost:8090/coins', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
console.log('coins:', await page.evaluate(() => `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}, boxSizing(main)=${getComputedStyle(document.querySelector('main')).boxSizing}`));
await browser.close();
