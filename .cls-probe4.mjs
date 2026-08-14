import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto('https://three.ws/forge', { waitUntil: 'domcontentloaded', timeout: 90000 });
const snap = () => p.evaluate(() => {
  const ex = document.getElementById('examples');
  const cs = getComputedStyle(ex);
  return {
    h: Math.round(ex.getBoundingClientRect().height),
    n: ex.children.length,
    font: cs.fontFamily,
    labels: [...ex.children].map(c => c.textContent.trim().slice(0, 34)),
    widths: [...ex.children].map(c => Math.round(c.getBoundingClientRect().width)),
    fontsReady: document.fonts.status,
  };
});
await p.waitForTimeout(1200); const a = await snap();
await p.waitForTimeout(7000);  const c = await snap();
console.log('T=1.2s  h=' + a.h, 'chips=' + a.n, 'fonts=' + a.fontsReady);
a.labels.forEach((l, i) => console.log('   ', String(a.widths[i]).padStart(4), l));
console.log('T=8.2s  h=' + c.h, 'chips=' + c.n, 'fonts=' + c.fontsReady);
c.labels.forEach((l, i) => console.log('   ', String(c.widths[i]).padStart(4), l));
await b.close();
