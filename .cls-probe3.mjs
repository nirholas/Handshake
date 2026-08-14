import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto('https://three.ws/marketplace', { waitUntil: 'domcontentloaded', timeout: 90000 });
const snap = () => p.evaluate(() => {
  const out = [];
  document.querySelectorAll('body *').forEach((c) => {
    const r = c.getBoundingClientRect();
    if (!r.height && !r.width) return;
    const key = c.tagName.toLowerCase() + (c.id ? '#' + c.id : (c.className && typeof c.className === 'string' ? '.' + c.className.trim().split(/\s+/)[0] : ''));
    out.push({ key, h: Math.round(r.height), y: Math.round(r.top) });
  });
  return out;
});
await p.waitForTimeout(1200); const a = await snap();
await p.waitForTimeout(7000);  const c = await snap();
const am = new Map(); a.forEach((x, i) => am.set(i, x));
const grew = [];
c.forEach((x, i) => { const o = am.get(i); if (o && o.key === x.key && o.h !== x.h) grew.push({ key: x.key, from: o.h, to: x.h, dy: x.h - o.h, y: o.y }); });
grew.sort((x, y) => Math.abs(y.dy) - Math.abs(x.dy));
console.log('Elements whose height changed between 1.2s and 8.2s (top 20):');
grew.slice(0, 20).forEach(d => console.log('  y=' + d.y, d.key, d.from + '->' + d.to, (d.dy > 0 ? '+' : '') + d.dy));
await b.close();
