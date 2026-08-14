import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1350, height: 940 } });
await p.goto(process.argv[2] + '/marketplace', { waitUntil: 'load', timeout: 90000 });
await p.waitForTimeout(3000);
const st = await p.evaluate(() => [...document.querySelectorAll('.market-hero-slide')].map(s => {
  const mv = s.querySelector('model-viewer');
  return (mv?.getAttribute('src') ? 'src' : mv?.dataset.src ? 'deferred' : 'none');
}));
console.log(process.argv[2], 'hero slides:', JSON.stringify(st));
await b.close();
