import { chromium } from 'playwright';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await p.goto(`${BASE}/app`, { waitUntil: 'load', timeout: 120_000 });
await p.waitForSelector('#layout-switch:not([hidden])');
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/next_classic.png' });

await p.locator('[data-layout-value="next"]').click();
await p.waitForTimeout(1500);
await p.screenshot({ path: '/tmp/next_default.png' });

// Open grid
await p.evaluate(() => document.getElementById('next-dock-clip').click());
await p.waitForTimeout(400);
await p.screenshot({ path: '/tmp/next_grid.png' });
await p.evaluate(() => document.body.click());
await p.waitForTimeout(200);

// Open controls drawer
await p.evaluate(() => document.getElementById('next-controls-btn').click());
await p.waitForTimeout(600);
await p.screenshot({ path: '/tmp/next_drawer.png' });
await p.evaluate(() => document.getElementById('next-drawer-close').click());
await p.waitForTimeout(400);

// Open share popover
await p.evaluate(() => document.getElementById('next-share-btn').click());
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/next_share.png' });

await b.close();
console.log('shots saved');
