import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 800 } });
p.on('console', (m) => {
  const t = m.text();
  if (/GL Driver|WebSocket|vite/i.test(t)) return;
  console.log('[' + m.type() + ']', t.slice(0, 200));
});
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await p.goto('http://localhost:3007/asl-alphabet', { waitUntil: 'networkidle' });
await p.waitForTimeout(6000);
console.log('status:', await p.textContent('#aa-status'));
await b.close();
