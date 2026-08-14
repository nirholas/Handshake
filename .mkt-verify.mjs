import { chromium } from 'playwright';
const base = process.argv[2];
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
// Real marketplace data from production, local build under test.
for (const pat of ['**/api/marketplace/**', '**/api/avatars/**', '**/api/explore*']) {
  await p.route(pat, async (route) => {
    const u = new URL(route.request().url());
    try {
      const r = await fetch('https://three.ws' + u.pathname + u.search);
      route.fulfill({ status: r.status, contentType: r.headers.get('content-type') || 'application/json', body: await r.text() });
    } catch { route.abort(); }
  });
}
const glb = [];
p.on('request', (r) => { if (r.url().includes('.glb')) glb.push(r.url()); });
await p.goto(base + '/marketplace', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(3000);
const st = await p.evaluate(() => {
  const slides = [...document.querySelectorAll('.market-hero-slide')];
  return {
    heroSlides: slides.length,
    heroWithSrc: slides.filter(s => s.querySelector('model-viewer')?.getAttribute('src')).length,
    heroDeferred: slides.filter(s => s.querySelector('model-viewer')?.dataset.src).length,
  };
});
console.log(base, JSON.stringify(st), 'glbRequests=' + glb.length);
await b.close();
