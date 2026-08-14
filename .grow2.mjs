import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto('https://three.ws/marketplace', { waitUntil: 'domcontentloaded', timeout: 90000 });
// Everything that sits above #market-grid in document order, keyed by a stable path.
const snap = () => p.evaluate(() => {
  const grid = document.getElementById('market-grid');
  const out = {};
  const key = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''));
  document.querySelectorAll('body > *, main > *, main > * > *').forEach((el) => {
    if (grid && (el.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) return;
    const r = el.getBoundingClientRect();
    out[key(el)] = Math.round(r.height);
  });
  out['@gridTop'] = grid ? Math.round(grid.getBoundingClientRect().top + scrollY) : -1;
  return out;
});
const times = [400, 1500, 3000, 6000, 9000];
const snaps = [];
let prev = 0;
for (const t of times) { await p.waitForTimeout(t - prev); prev = t; snaps.push(await snap()); }
const keys = [...new Set(snaps.flatMap(Object.keys))];
for (const k of keys) {
  const row = snaps.map(s => s[k] === undefined ? '-' : s[k]);
  if (new Set(row).size > 1) console.log(k.padEnd(34), row.join('  ->  '));
}
console.log('\n(columns = ' + times.map(t => t + 'ms').join(', ') + ')');
await b.close();
