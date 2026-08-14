import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
// Serve the LOCAL build, but answer its data calls from production so the
// community strip has the same real feed the deployed page sees.
await p.route('**/api/forge-gallery*', async (route) => {
  const u = new URL(route.request().url());
  const r = await fetch('https://three.ws' + u.pathname + u.search);
  route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
});
const reqs = [];
p.on('request', (r) => reqs.push(r.url()));
const has = (w) => reqs.some(u => u.includes(w));
await p.goto('http://127.0.0.1:8099/', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(5000);
console.log('at load+5s: model-viewer.min.js =', has('model-viewer.min.js') ? 'LOADED' : 'deferred',
            '| GLB fetches =', reqs.filter(u => u.endsWith('.glb')).length);
const st = await p.evaluate(() => {
  const s = document.getElementById('home-community-forge');
  const t = document.getElementById('hcf-track');
  return { hidden: s?.hidden, cards: t?.children.length, posters: document.querySelectorAll('.hcf-poster').length, viewers: t?.querySelectorAll('model-viewer').length };
});
console.log('strip state at load:', JSON.stringify(st));
// Scroll the strip into view.
await p.evaluate(() => document.getElementById('home-community-forge')?.scrollIntoView());
await p.waitForTimeout(6000);
console.log('after scrolling to strip: model-viewer.min.js =', has('model-viewer.min.js') ? 'LOADED' : 'deferred');
const st2 = await p.evaluate(() => {
  const t = document.getElementById('hcf-track');
  return { cards: t?.children.length, posters: document.querySelectorAll('.hcf-poster').length, viewers: t?.querySelectorAll('model-viewer').length };
});
console.log('strip state after:', JSON.stringify(st2));
await b.close();
