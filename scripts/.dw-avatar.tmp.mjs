import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const warns = [];
page.on('console', (m) => { const t = m.text(); if (/docs-world/i.test(t)) warns.push(m.type()+': '+t); });
await page.goto('http://localhost:3004/docs/world', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__docsWorld !== undefined, { timeout: 60000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const p = window.__docsWorld.player;
  let skinned = 0, meshes = 0, bones = 0;
  p.root.traverse((n) => { if (n.isSkinnedMesh) skinned++; if (n.isMesh) meshes++; if (n.isBone) bones++; });
  return { meshes, skinnedMeshes: skinned, bones, height: +p.height.toFixed(2) };
});
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/2bb24e2a-01d6-4605-991f-31f1ec0d4995/scratchpad/dw-06-avatar.png' });
await browser.close();
console.log('player:', JSON.stringify(info));
console.log('docs-world logs:', warns.length ? warns : 'none');
