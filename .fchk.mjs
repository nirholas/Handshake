import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:3000/docs/widgets', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
console.log(await p.evaluate(() => ({
  footers: document.querySelectorAll('footer').length,
  horizon: document.querySelectorAll('.h-footer-horizon').length,
  taglines: [...document.querySelectorAll('.h-footer-tagline')].map(e=>e.textContent.trim()),
  navs: document.querySelectorAll('.h-footer-links').length,
  mainId: document.querySelector('main')?.id || '(none)',
})));
await b.close();
