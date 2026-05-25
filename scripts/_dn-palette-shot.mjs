import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0,200)));
p.on('console', m => { if (m.type()==='error') errs.push('[err] ' + m.text().slice(0,200)); });
p.on('response', r => { if (r.status() >= 400) errs.push(`RESP ${r.status()} ${r.url().slice(0,200)}`); });
await p.goto('http://127.0.0.1:3010/dashboard-next', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('.dn-shell .dn-rail-item', { timeout: 20000 });
await p.keyboard.press('Meta+k');
await p.waitForSelector('#dn-palette[style*="flex"]', { timeout: 5000 });
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/dn-palette.png' });
console.log('saved /tmp/dn-palette.png');
// type a non-avatar query to exercise filtered/scored rendering
await p.keyboard.type('mon', { delay: 30 });
await p.waitForTimeout(200);
await p.screenshot({ path: '/tmp/dn-palette-query.png' });
console.log('saved /tmp/dn-palette-query.png');
if (errs.length) { errs.forEach(e => console.log('ERR', e)); process.exit(1); }
await b.close();
