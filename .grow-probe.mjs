import { chromium } from 'playwright';
const ids = process.argv.slice(3);
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 90000 });
const snap = () => p.evaluate((ids) => Object.fromEntries(ids.map((id) => {
  const el = document.getElementById(id);
  if (!el) return [id, 'missing'];
  const r = el.getBoundingClientRect();
  return [id, { h: Math.round(r.height), hidden: el.hidden, kids: el.children.length }];
})), ids);
await p.waitForTimeout(400); const t0 = await snap();
await p.waitForTimeout(9000);  const t1 = await snap();
for (const id of ids) console.log(id.padEnd(24), JSON.stringify(t0[id]), '->', JSON.stringify(t1[id]));
await b.close();
