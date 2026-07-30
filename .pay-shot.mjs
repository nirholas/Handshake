import { chromium } from 'playwright';
const b = await chromium.launch();
const errs = [];
for (const [w,h,name] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('console', m => { const t=m.text(); if((m.type()==='error'||m.type()==='warning') && !/vite|WebSocket/i.test(t)) errs.push(`[${name}] ${m.type()}: ${t}`); });
  p.on('pageerror', e => { if(!/WebSocket/i.test(e.message)) errs.push(`[${name}] pageerror: ${e.message}`); });
  await p.goto('http://localhost:3001/payments', { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const title = await p.title();
  const h1 = await p.locator('h1').first().innerText().catch(()=>'(none)');
  console.log(`${name}: title="${title}" h1="${h1}" overflow=${overflow}`);
  await p.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/967882b0-04bb-45dd-b03b-15088087b910/scratchpad/pay-${name}.png`, fullPage: name==='desktop' });
  await p.close();
}
await b.close();
console.log(errs.length ? 'CONSOLE ISSUES:\n' + errs.join('\n') : 'no console errors/warnings from page code');
