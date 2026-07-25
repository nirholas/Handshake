import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
await p.goto('http://localhost:3000/scripts/.scratch/sign-preview.html?mod=old&word=AB&cols=2', { waitUntil: 'networkidle' });
console.log('title', await p.title());
await b.close();
