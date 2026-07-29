import { chromium } from 'playwright';
const routes = ['/avatar-sdk', '/club'];
const browser = await chromium.launch();
for (const r of routes) {
  const page = await browser.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 120)));
  try {
    await page.goto('https://three.ws' + r, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
  } catch (e) { errs.push('NAV ' + e.message.slice(0, 80)); }
  const tex = errs.filter(e => /Couldn't load texture/.test(e));
  console.log(`${r}: total console errors=${errs.length} textureErrors=${tex.length}`);
  tex.slice(0, 2).forEach(t => console.log('   ', t));
  errs.filter(e => !/Couldn't load texture/.test(e)).slice(0, 4).forEach(t => console.log('   other:', t));
  await page.close();
}
await browser.close();
