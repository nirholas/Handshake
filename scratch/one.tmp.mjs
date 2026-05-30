import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.goto('http://localhost:3000/walk-embed?bg=%23ff0000&env=beach', { waitUntil:'domcontentloaded', timeout:15000 });
await p.waitForTimeout(4500);
const px = await p.evaluate(() => { const c=document.getElementById('walk-canvas'); const o=document.createElement('canvas'); o.width=c.width;o.height=c.height; const g=o.getContext('2d'); g.drawImage(c,0,0); const d=g.getImageData(Math.floor(c.width/2),6,1,1).data; return {r:d[0],g:d[1],b:d[2],a:d[3]}; });
process.stdout.write('RESULT bg=red+env=beach => ' + JSON.stringify(px) + '\n');
await b.close();
