import { chromium } from 'playwright';
const errors=[]; const b=await chromium.launch(); const p=await b.newPage();
p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
p.on('pageerror',e=>errors.push('PAGEERR: '+e.message));
await p.goto('http://localhost:3001/marketplace',{waitUntil:'networkidle'});
await p.waitForTimeout(800);
// nav.js injects nav.html into #nav-container
const discoverTrigger = p.locator('.nav-trigger', { hasText: 'Discover' }).first();
await discoverTrigger.click(); await p.waitForTimeout(200);
const hasAgents = await p.locator('a[href="/agents"]').count();
const hasRep = await p.locator('a[href="/reputation"]').count();
const labsTrigger = p.locator('.nav-trigger', { hasText: 'Labs' }).first();
await labsTrigger.click(); await p.waitForTimeout(200);
const hasShopper = await p.locator('a[href="/shopper"]').count();
const hasFact = await p.locator('a[href="/fact-checker"]').count();
console.log('injected nav -> /agents:',hasAgents,'/reputation:',hasRep,'/shopper:',hasShopper,'/fact-checker:',hasFact);
const navErrors = errors.filter(e=>!/three\.ws\/agent-3d|ERR_CONNECTION_REFUSED|Failed to fetch|Failed to load resource/.test(e));
console.log('nav-related console errors:', navErrors.length?JSON.stringify(navErrors):'none');
await b.close();
