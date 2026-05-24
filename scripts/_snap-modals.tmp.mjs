import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const glb = await readFile('/workspaces/three.ws/public/avatars/default.glb');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('PE:', e.message));

const b64 = Buffer.from(glb).toString('base64');
await page.addInitScript((b64) => {
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
    return true;
  })();
}, b64);

await page.goto('http://localhost:3000/create-review', { waitUntil: 'load' });
try { await page.evaluate(() => window.__seed); } catch {}
await page.waitForTimeout(1500);
await page.reload({ waitUntil: 'load' });

await page.waitForSelector('#mv-container canvas', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('viewer-loading')?.classList.contains('is-hidden'));
await page.waitForTimeout(3500);

await page.fill('#f-name', 'Nicholas');

async function shot(feat, file, dwell = 700) {
  await page.click(`[data-feature="${feat}"]`);
  await page.waitForSelector('.fm-backdrop');
  await page.waitForTimeout(dwell);
  const b = await page.locator('.fm-dialog').boundingBox();
  await page.screenshot({ path: file, clip: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: b.width + 48, height: b.height + 48 } });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fm-backdrop', { state: 'detached' });
}

await shot('identity', '/tmp/cr-final-identity.png', 1000);
await shot('paid', '/tmp/cr-final-paid.png');
await shot('embed', '/tmp/cr-final-embed.png', 1000);
await shot('reputation', '/tmp/cr-final-reputation.png');
await shot('download', '/tmp/cr-final-download.png');

await page.screenshot({ path: '/tmp/cr-final-page.png' });

await browser.close();
console.log('saved');
