import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('http://localhost:3000/forge', { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  async function capture(kind) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240; document.body.appendChild(c);
    let draw;
    if (kind === '2d') {
      const ctx = c.getContext('2d');
      draw = (t) => { ctx.fillStyle = `hsl(${t%360} 80% 50%)`; ctx.fillRect(0,0,320,240); };
    } else {
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { kind, error: 'no webgl' };
      draw = (t) => { gl.clearColor((t%100)/100, 0.3, 0.7, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
    }
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    let total = 0;
    rec.ondataavailable = e => { total += e.data.size; };
    const done = new Promise(r => rec.onstop = r);
    rec.start(200);
    const t0 = performance.now();
    while (performance.now() - t0 < 1200) {
      await new Promise(r => requestAnimationFrame(r));
      draw(performance.now() - t0);
    }
    rec.stop(); await done;
    for (const t of stream.getTracks()) t.stop();
    c.remove();
    return { kind, total };
  }
  return [await capture('2d'), await capture('webgl')];
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
