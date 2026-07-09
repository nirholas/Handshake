import { renderGlbToPng } from '../api/_lib/render-glb.js';
const t0 = Date.now();
try {
  const png = await renderGlbToPng({
    glbUrl: 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/c96c2caf-3c36-4077-93cc-0019320577f3.glb',
    width: 768, height: 768, background: '#0a0a0a',
  });
  console.log('OK bytes=', png.length, 'ms=', Date.now()-t0, 'png?', png.subarray(0,4).toString('hex'));
} catch (e) { console.log('FAIL:', e.message); }
process.exit(0);
