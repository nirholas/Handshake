import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await p.goto('http://localhost:3007/asl-alphabet', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
const el = await p.$('.aa-stage-wrap');
await p.click('.aa-key[data-char="W"]');
for (const t of [400, 900, 1600]) {
  await p.waitForTimeout(t === 400 ? 400 : 500);
  await el.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/ac683624-d99b-4e76-bfbe-4e0283327d2c/scratchpad/click-${t}.png` });
}
console.log('status:', await p.textContent('#aa-status'));
console.log('errors:', errs);
await b.close();
