import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
const bad = [];
p.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
await p.goto('http://localhost:4599/tutorials/getting-started', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForTimeout(6000);
console.log(bad.join('\n') || 'none');
await b.close();
