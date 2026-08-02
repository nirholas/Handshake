import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
// Pages that load brand.js are the candidate set; sample a spread of them.
const routes = ['/tour/atlas', '/changelog', '/docs', '/pricing', '/embed-demo', '/ar', '/walk', '/play'];
const b = await chromium.launch();
for (const r of routes) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const resp = await p.goto('http://localhost:3000' + r, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForTimeout(1600);
    const s = await p.evaluate(() => ({
      hasBrandJs: !!document.querySelector('script[src*="brand.js"]'),
      chip: !!document.querySelector('.brand-mark-chip'),
      brand: !!document.querySelector('.brand-mark,.wordmark-logo,.header-logo,.nxt-brand-mark'),
    }));
    console.log(r.padEnd(14), resp?.status(), JSON.stringify(s));
  } catch (e) { console.log(r.padEnd(14), 'ERR', e.message.split('\n')[0]); }
  await p.close();
}
await b.close();
