import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const glb = await readFile('/workspaces/three.ws/public/avatars/default.glb');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });

const b64 = Buffer.from(glb).toString('base64');
await ctx.addInitScript((b64) => {
  if (location.pathname !== '/create-review') return;
  window.__seed = (async () => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'model/gltf-binary' });
    const id = '19b160abcdef';
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('three-ws-guest', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('avatars')) r.result.createObjectStore('avatars'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('avatars', 'readwrite');
      tx.objectStore('avatars').put({ blob, meta: { source: 'avaturn' }, id, name: `Avatar #${id.slice(0,6)}`, size: blob.size, createdAt: Date.now() }, 'pending');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  })();
}, b64);

async function snapOne(feat, file, dwell = 800) {
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/create-review', { waitUntil: 'load' });
  try { await page.evaluate(() => window.__seed); } catch {}
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#mv-container canvas', { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('viewer-loading')?.classList.contains('is-hidden'));
  await page.waitForTimeout(3000);
  await page.fill('#f-name', 'Nicholas');
  await page.evaluate((f) => document.querySelector(`[data-feature="${f}"]`).click(), feat);
  await page.waitForSelector('.fm-backdrop');
  await page.waitForTimeout(dwell);
  const b = await page.locator('.fm-dialog').boundingBox();
  await page.screenshot({ path: file, clip: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: b.width + 48, height: b.height + 48 } });
  await page.close();
}

for (const [feat, file, dwell] of [
  ['identity', '/tmp/cr-final-identity.png', 1100],
  ['paid', '/tmp/cr-final-paid.png', 700],
  ['embed', '/tmp/cr-final-embed.png', 1200],
  ['reputation', '/tmp/cr-final-reputation.png', 700],
  ['download', '/tmp/cr-final-download.png', 700],
]) {
  try { await snapOne(feat, file, dwell); console.log('shot', feat); } catch (e) { console.error('shot fail', feat, e.message); }
}

await browser.close();
console.log('done');
