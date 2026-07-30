import { chromium } from 'playwright';
const browser = await chromium.launch();
const out = {};
for (const [label, width] of [['mobile320', 320], ['tablet768', 768], ['desktop1440', 1440]]) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto('http://localhost:3123/pages/mcp-tools.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mc-card');
  out[label] = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  await page.close();
}
// Light theme + keyboard shortcut
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript(() => localStorage.setItem('twx_theme', 'light'));
await page.goto('http://localhost:3123/pages/mcp-tools.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.mc-card');
out.lightTheme = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  cardText: getComputedStyle(document.querySelector('.mc-name')).color,
}));
await page.keyboard.press('/');
out.slashFocus = await page.evaluate(() => document.activeElement?.id);
console.log(JSON.stringify(out, null, 1));
await browser.close();
