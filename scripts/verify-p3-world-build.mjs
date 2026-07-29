// Real browser verification of Phase 3 in /play: the persisted build loads from
// the durable world store on enter, offline placement writes back through it, and
// the tiered build radius / prop-upload UI are live. No mocks: a real Vite dev
// server, the real /api/world endpoints, the real Postgres-backed store.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3001';
const MINT = 'THREEsynthetic1111111111111111111111111111';
const URL = `${BASE}/play?coin=${MINT}&name=Synthetic&symbol=SYN`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.setDefaultNavigationTimeout(180000);
page.setDefaultTimeout(180000);

const errors = [];
const warnings = [];
const worldCalls = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') errors.push(m.text());
  if (t === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('request', (r) => { if (r.url().includes('/api/world/')) worldCalls.push(`${r.method()} ${r.url().replace(BASE, '')}`); });

await page.goto(URL, { waitUntil: 'commit', timeout: 180000 });

// Drop into the world (the lobby's zero-friction entry), then wait for the scene.
await page.waitForFunction(() => !!window.__CC__, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const phaseBefore = await page.evaluate(() => window.__CC__.phase);
if (phaseBefore === 'lobby') {
  await page.evaluate(() => window.__CC__._dropIn?.() ?? window.__CC__.enter({ mint: new URLSearchParams(location.search).get('coin'), name: 'Synthetic', symbol: 'SYN', image: '' }, {}));
}
await page.waitForFunction(() => window.__CC__?.phase === 'world' && !!window.__CC__.worldObjects, null, { timeout: 90000 });
// Give the store read + any room connect attempt time to settle.
await page.waitForTimeout(6000);

const state = await page.evaluate(() => {
  const g = window.__CC__;
  return {
    phase: g.phase,
    netStatus: g.net?.status,
    worldStoreId: g._worldStore?.worldId ?? null,
    storeEtag: g._worldStore?.etag ?? null,
    storeWritable: g._worldStore?.writable ?? null,
    totalObjects: g.worldObjects?.count ?? 0,
    localObjects: g.worldObjects?.localCount?.() ?? 0,
    localIds: (g.worldObjects?.localObjects?.() || []).map((o) => o.id),
    clearMaxRadius: g._buildPerms?.clearMaxRadius,
    propPaletteHasUpload: !!document.querySelector('.cc-prop-upload'),
  };
});
console.log('STATE', JSON.stringify(state, null, 1));

// P3.1 write path: place a prop with no room authority and confirm the store
// attempts a real save (anonymous sessions are refused by design, which is a
// designed state, not a silent failure).
const place = await page.evaluate(async () => {
  const g = window.__CC__;
  if (g._roomIsAuthority()) return { skipped: 'room is authority' };
  g.buildProp = 'crate';
  const ok = g._placeLocalProp({ x: 12, y: 0, z: 12 }, 0, '');
  const before = g.worldObjects.localCount();
  const outcome = await g._worldStore.flush();
  return { ok, before, outcome, denied: g._worldStore.denied, lastError: g._worldStore.lastError };
});
console.log('PLACE', JSON.stringify(place));

console.log('WORLD API CALLS', JSON.stringify(worldCalls, null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0, 20), null, 1));
console.log('WARNINGS', JSON.stringify(warnings.slice(0, 20), null, 1));

await page.screenshot({ path: process.env.SHOT || '/tmp/p3-play.png' });
await browser.close();
