import puppeteer from 'puppeteer';
const BASE='http://localhost:3000';
const b = await puppeteer.launch({headless:true,pipe:true,timeout:90000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-dbus']});
const p = await b.newPage();
const featErrors=[];
p.on('console', m=>{ if(m.type()==='error' && !/xr|WebGL/i.test(m.text())) featErrors.push(m.text()); });
// deep-link
await p.goto(`${BASE}/marketplace/tools/650e9a5c-b35e-4f91-a4ec-4424d4fa6dca`, {waitUntil:'domcontentloaded'});
await p.waitForSelector('#tool-detail-body:not([hidden])', {timeout:15000});
console.log('DEEPLINK ok:', JSON.stringify(await p.$eval('#tool-detail-name',e=>e.textContent)), '| title:', JSON.stringify(await p.title()));
// not found
await p.goto(`${BASE}/marketplace/tools/00000000-0000-0000-0000-000000000000`, {waitUntil:'domcontentloaded'});
await p.waitForSelector('#tool-detail-empty:not([hidden])', {timeout:15000});
console.log('NOTFOUND ok:', JSON.stringify(await p.$eval('.tool-detail-empty-title',e=>e.textContent)), '| bodyHidden:', await p.$eval('#tool-detail-body',e=>e.hidden));
console.log('FEATURE CONSOLE ERRORS:', featErrors.length?JSON.stringify(featErrors):'none');
await b.close();
