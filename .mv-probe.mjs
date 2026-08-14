import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto(url, { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(6000);
const r = await p.evaluate(() => {
  const mvs = [...document.querySelectorAll('model-viewer')];
  const vh = innerHeight;
  return {
    total: mvs.length,
    inViewport: mvs.filter(m => { const r = m.getBoundingClientRect(); return r.top < vh && r.bottom > 0; }).length,
    withSrc: mvs.filter(m => m.getAttribute('src')).length,
    withDataSrc: mvs.filter(m => m.dataset.src).length,
    canvases: document.querySelectorAll('canvas').length,
    domNodes: document.querySelectorAll('*').length,
  };
});
console.log(url, JSON.stringify(r, null, 1));
await b.close();
