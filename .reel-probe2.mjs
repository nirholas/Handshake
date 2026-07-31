import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3000/forge', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.evaluate(() => document.dispatchEvent(new CustomEvent('forge:open-creation', { detail: { creation: { id:'p', prompt:'probe', glb_url:'https://three.ws/avatars/default.glb', backend:'trellis_selfhost' } } })));
await page.waitForFunction(() => document.getElementById('viewer')?.loaded === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(async () => {
  const v = document.getElementById('viewer');
  const canvases = [...v.shadowRoot.querySelectorAll('canvas')].map((c, i) => ({
    i, w: c.width, h: c.height, cls: c.className, id: c.id,
    ctx2d: !!c.getContext, parent: c.parentElement?.className,
    style: c.getAttribute('style')?.slice(0, 120) || '',
  }));
  // Also look for a canvas anywhere in the document that three's renderer owns
  const docCanvases = [...document.querySelectorAll('canvas')].map((c,i)=>({i,w:c.width,h:c.height,cls:c.className}));

  // Sanity: does MediaRecorder work at all here, on a plain 2D canvas?
  const plain = document.createElement('canvas');
  plain.width = 320; plain.height = 240;
  const ctx = plain.getContext('2d');
  const stream = plain.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  let total = 0;
  rec.ondataavailable = e => { total += e.data.size; };
  const done = new Promise(r => rec.onstop = r);
  rec.start(200);
  const t0 = performance.now();
  while (performance.now() - t0 < 900) {
    await new Promise(r => requestAnimationFrame(r));
    ctx.fillStyle = `hsl(${(performance.now()/5)%360} 80% 50%)`;
    ctx.fillRect(0,0,320,240);
  }
  rec.stop(); await done;
  return { canvases, docCanvases, plainCanvasBytes: total };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
