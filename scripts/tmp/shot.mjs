import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
for (const [slug, theme, name] of [['getting-started','dark','dark'],['text-to-3d','light','light']]) {
  const ctx = await b.newContext({ viewport: { width: 1240, height: 1100 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(`try{localStorage.setItem('twx_theme','${theme}')}catch(e){}`);
  const p = await ctx.newPage();
  await p.goto(`http://localhost:4599/tutorials/${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForSelector('.tfig-frame-img img', { timeout: 30000 }).catch(()=>{});
  await p.waitForTimeout(5000);
  await p.evaluate(() => { const f = document.querySelector('figure.tfig'); if (f) f.scrollIntoView({ block: 'center' }); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/tfig/shot-${name}.png` });
  await ctx.close();
}
// Lightbox open state
const ctx = await b.newContext({ viewport: { width: 1240, height: 900 } });
const p = await ctx.newPage();
await p.goto('http://localhost:4599/tutorials/text-to-3d', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForSelector('.tfig-zoom', { timeout: 30000 });
await p.waitForTimeout(4000);
await p.locator('.tfig-zoom').first().click();
await p.waitForTimeout(1200);
await p.screenshot({ path: '/tmp/tfig/shot-lightbox.png' });
await b.close();
console.log('shots written');
