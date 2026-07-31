import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://localhost:3000/forge', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.evaluate(() => document.dispatchEvent(new CustomEvent('forge:open-creation', { detail: { creation: { id:'p', prompt:'probe', glb_url:'https://three.ws/avatars/default.glb', backend:'trellis_selfhost' } } })));
await page.waitForFunction(() => document.getElementById('viewer')?.loaded === true, null, { timeout: 90000 });
await page.waitForTimeout(1500);
const out = await page.evaluate(async () => {
  const v = document.getElementById('viewer');
  const cs = [...v.shadowRoot.querySelectorAll('canvas')]; const c = cs.find(x => x.id === 'webgl-canvas' && x.classList.contains('show')) || cs[0];
  const info = { hasCanvas: !!c, w: c?.width, h: c?.height, hasCapture: typeof c?.captureStream === 'function', mp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E') };
  if (!c) return info;
  info.results = {};
  for (const mime of ['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']) {
    if (!MediaRecorder.isTypeSupported(mime)) { info.results[mime] = 'unsupported'; continue; }
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    let total = 0; let err = '';
    rec.ondataavailable = e => { total += e.data.size; };
    rec.onerror = e => { err = e.error?.name || 'error'; };
    const done = new Promise(r => rec.onstop = r);
    rec.start(200);
    const t0 = performance.now();
    while (performance.now() - t0 < 900) {
      await new Promise(r => requestAnimationFrame(r));
      const a = (performance.now() - t0) / 900 * 360;
      v.cameraOrbit = `${a}deg 78deg auto`; v.jumpCameraToGoal?.();
    }
    rec.stop(); await done;
    for (const t of stream.getTracks()) t.stop();
    info.results[mime] = err ? `err:${err}` : total;
  }
  return info;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
