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
  const cs = [...v.shadowRoot.querySelectorAll('canvas')];
  const target = cs.find(x => x.id === 'webgl-canvas' && x.classList.contains('show')) || cs[0];
  const info = { picked: target.id || '(own)', cls: target.className, w: target.width, h: target.height };

  async function run(mode) {
    const stream = mode === 'fps' ? target.captureStream(30) : target.captureStream();
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    let total = 0, chunks = 0;
    rec.ondataavailable = e => { total += e.data.size; chunks++; };
    const done = new Promise(r => rec.onstop = r);
    rec.start(200);
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      await new Promise(r => requestAnimationFrame(r));
      const a = (performance.now() - t0) / 1500 * 360;
      v.cameraOrbit = `${a}deg 78deg auto`;
      v.jumpCameraToGoal?.();
      if (mode === 'manual') track.requestFrame?.();
    }
    rec.stop(); await done;
    for (const t of stream.getTracks()) t.stop();
    return { mode, total, chunks, hasRequestFrame: typeof track.requestFrame === 'function' };
  }
  info.fps = await run('fps');
  info.manual = await run('manual');
  return info;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
