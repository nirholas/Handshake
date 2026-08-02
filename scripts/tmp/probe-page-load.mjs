import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage();
const pending = new Map();
p.on('request', r => pending.set(r, Date.now()));
p.on('requestfinished', r => pending.delete(r));
p.on('requestfailed', r => { console.log('FAILED', r.failure()?.errorText, r.url().slice(0,110)); pending.delete(r); });
const t0 = Date.now();
try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); console.log('domcontentloaded in', Date.now()-t0, 'ms'); }
catch (e) { console.log('goto FAILED after', Date.now()-t0, 'ms:', e.message.split('\n')[0]); }
console.log('--- still pending at exit ---');
for (const [r, t] of pending) console.log((Date.now()-t)+'ms', r.resourceType(), r.url().slice(0,120));
await b.close();
