import { chromium } from 'playwright';
const OUT = process.env.SHOT_DIR || process.cwd();
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Hold the entity fetch open so the skeleton is what the camera sees.
await p.route('**/api/agents/**', async (r) => { await new Promise((s) => setTimeout(s, 9000)); r.continue(); });
p.goto(process.argv[2], { waitUntil: 'commit' }).catch(() => {});
await p.waitForTimeout(3500);
await p.screenshot({ path: `${OUT}/v2-skeleton.png` });
console.log('aria-busy:', await p.$eval('#av-shell', (n) => n.getAttribute('aria-busy')));
console.log('status text:', await p.$eval('[role="status"]', (n) => n.innerText.trim()).catch(() => 'none'));
await b.close();
