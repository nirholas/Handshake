import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:3001/create/studio';
const out = process.argv[3] || '/tmp/studio.png';
const b = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']
});
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
await p.goto(url, { waitUntil: 'networkidle' }).catch(e=>console.log('goto:',e.message));
await p.waitForTimeout(6000);
await p.screenshot({ path: out, fullPage: false });
console.log('shot ->', out);
console.log('console errors:', errs.length ? '\n'+errs.join('\n') : 'none');
await b.close();
