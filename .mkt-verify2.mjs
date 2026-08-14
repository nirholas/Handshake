import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
for (const pat of ['**/api/marketplace/**', '**/api/avatars/**', '**/api/explore*']) {
  await p.route(pat, async (route) => {
    const u = new URL(route.request().url());
    try { const r = await fetch('https://three.ws' + u.pathname + u.search);
      route.fulfill({ status: r.status, contentType: r.headers.get('content-type') || 'application/json', body: await r.text() });
    } catch { route.abort(); }
  });
}
await p.goto('http://127.0.0.1:8099/marketplace', { waitUntil: 'load', timeout: 90000 });
for (const t of [1500, 3000]) {
  await p.waitForTimeout(t === 1500 ? 1500 : 1500);
  const st = await p.evaluate(() => [...document.querySelectorAll('.market-hero-slide')].map(s => {
    const mv = s.querySelector('model-viewer');
    return { slot: s.dataset.slot, active: s.classList.contains('active'), src: !!mv?.getAttribute('src'), dataSrc: !!mv?.dataset.src, rotate: mv?.hasAttribute('auto-rotate') };
  }));
  console.log('t=' + t + 'ms', JSON.stringify(st));
}
await b.close();
