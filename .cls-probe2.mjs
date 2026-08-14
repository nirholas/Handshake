import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto('https://three.ws/forge', { waitUntil: 'domcontentloaded', timeout: 90000 });
const snap = () => p.evaluate(() => {
  const ex = document.getElementById('examples');
  if (!ex) return null;
  const rail = ex.closest('.forge-rail') || document.body;
  const out = [];
  const walk = (el, depth) => {
    if (depth > 3) return;
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      out.push({ k: c.tagName.toLowerCase() + (c.id ? '#' + c.id : '.' + String(c.className).trim().split(/\s+/)[0]), h: Math.round(r.height), y: Math.round(r.top) });
      walk(c, depth + 1);
    }
  };
  walk(rail, 0);
  return out;
});
await p.waitForTimeout(1200); const a = await snap();
await p.waitForTimeout(7000);  const c = await snap();
const am = new Map(a.map((x, i) => [x.k + '#' + i, x]));
const diffs = [];
c.forEach((x, i) => { const o = am.get(x.k + '#' + i); if (o && (o.h !== x.h)) diffs.push({ k: x.k, from: o.h, to: x.h, dy: x.h - o.h }); });
diffs.sort((x, y) => Math.abs(y.dy) - Math.abs(x.dy));
console.log('Height changes in the forge rail between 1.2s and 8.2s:');
diffs.slice(0, 15).forEach(d => console.log('  ', d.k, d.from + 'px ->' + d.to + 'px', '(' + (d.dy > 0 ? '+' : '') + d.dy + ')'));
await b.close();
