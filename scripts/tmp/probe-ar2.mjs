import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0,140)); });
p.on('pageerror', e => console.log('PAGEERR:', String(e).slice(0,200)));
await p.goto('http://localhost:3000/ar', { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => ({
  flag: window.__threeBrandMark,
  styleTag: !!document.getElementById('three-brand-mark-style'),
  noBrandAttr: document.documentElement.hasAttribute('data-no-brand-mark'),
  metaOff: !!document.querySelector('meta[name="brand-mark"][content="off"]'),
  chip: !!document.querySelector('.brand-mark-chip'),
}))));
await b.close();
