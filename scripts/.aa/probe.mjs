import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 800 } });
const logs = [];
p.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 160)));
await p.goto('http://localhost:3007/asl-alphabet?letter=W', { waitUntil: 'networkidle' });
await p.waitForTimeout(3000);
const el = await p.$('.aa-stage-wrap');
for (const t of [0, 1200, 2500, 5000]) {
  if (t) await p.waitForTimeout(t === 1200 ? 1200 : 1300);
  await el.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/ac683624-d99b-4e76-bfbe-4e0283327d2c/scratchpad/seq-${t}.png` });
}
console.log(JSON.stringify(logs.filter((l) => !/WebSocket|vite/i.test(l)).slice(0, 8), null, 1));
await b.close();
