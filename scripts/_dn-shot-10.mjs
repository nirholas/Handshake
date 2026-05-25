import { chromium } from 'playwright';
const url = process.argv[2]; const out = process.argv[3]; const sel = process.argv[4] || 'body';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
p.on('console',  m => { if (m.type() === 'error') errs.push('[err] ' + m.text().slice(0, 200)); });
p.on('requestfailed', r => errs.push('REQ FAIL ' + r.url() + ' ' + (r.failure()?.errorText || '')));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector(sel, { timeout: 20000 });
await p.waitForTimeout(800);
await p.screenshot({ path: out, fullPage: false });
console.log('saved', out);
if (errs.length) { console.log('errors:'); for (const e of errs) console.log(' ' + e); }
await b.close();
