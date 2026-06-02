import puppeteer from 'puppeteer';
const url = 'http://localhost:3000/coin3d?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const browser = await puppeteer.launch({ headless: 'new',
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => !!window.__coin3d, { timeout: 25000 });
const px = await page.evaluate(() => {
  const { renderer, scene, camera } = window.__coin3d;
  renderer.render(scene, camera); // force a fresh draw this tick
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const cx = Math.floor(w/2)-50, cy = Math.floor(h/2)-50;
  const buf = new Uint8Array(100*100*4);
  gl.readPixels(cx, cy, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let lit=0, maxc=0;
  for (let i=0;i<buf.length;i+=4){ const m=Math.max(buf[i],buf[i+1],buf[i+2]); if(m>20) lit++; if(m>maxc) maxc=m; }
  return { drawBuffer:[w,h], litPixelsCenter: lit, maxChannel: maxc };
});
console.log('GL_PIXELS', JSON.stringify(px));
// element-level screenshot of the HUD card (reliable, avoids full-page compositing)
const hud = await page.$('#hud');
await page.addStyleTag({ content: '#hud{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:#11142e!important}' });
await new Promise(r=>setTimeout(r,300));
await hud.screenshot({ path: 'scripts/_hud.png' });
await browser.close();
