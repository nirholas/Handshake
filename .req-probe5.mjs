import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.route('**/api/forge-gallery*', async (route) => {
  const u = new URL(route.request().url());
  const r = await fetch('https://three.ws' + u.pathname + u.search);
  route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
});
const reqs = [];
p.on('request', (r) => reqs.push(r.url()));
await p.goto('http://127.0.0.1:8099/', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(4000);
await p.evaluate(() => {
  const s = document.getElementById('home-community-forge');
  window.scrollTo({ top: s.getBoundingClientRect().top + scrollY - 200, behavior: 'instant' });
});
await p.waitForTimeout(7000);
const st = await p.evaluate(() => {
  const s = document.getElementById('home-community-forge');
  const r = s.getBoundingClientRect();
  const t = document.getElementById('hcf-track');
  return { scrollY: Math.round(scrollY), sectionTop: Math.round(r.top), viewers: t.querySelectorAll('model-viewer').length, posters: document.querySelectorAll('.hcf-poster').length };
});
console.log('mv bundle requested:', reqs.some(u => u.includes('model-viewer.min.js')));
console.log(JSON.stringify(st));
await b.close();
