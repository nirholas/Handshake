import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.route('**/api/forge-gallery*', async (route) => {
  const u = new URL(route.request().url());
  const r = await fetch('https://three.ws' + u.pathname + u.search);
  route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
});
p.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
p.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
await p.goto('http://127.0.0.1:8099/', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(4000);
const info = await p.evaluate(() => {
  const s = document.getElementById('home-community-forge');
  const r = s.getBoundingClientRect();
  const chain = [];
  for (let e = s; e && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e);
    chain.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '.' + String(e.className).trim().split(/\s+/)[0]) + ' display=' + cs.display + ' vis=' + cs.visibility + ' h=' + Math.round(e.getBoundingClientRect().height));
  }
  return { rect: { top: Math.round(r.top), h: Math.round(r.height) }, chain, liteClass: document.documentElement.className };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
