import { chromium } from 'playwright';
const b = await chromium.launch();
const routes = ['/characters','/character/latest','/smart-money','/forever','/x402/studio','/markets/digest','/marketplace'];
for (const r of routes) {
  const p = await b.newPage();
  const errs=[];
  p.on('pageerror',e=>errs.push('EX:'+String(e).slice(0,70)));
  p.on('console',m=>{if(m.type()==='error')errs.push('C:'+m.text().slice(0,70));});
  p.on('requestfailed',rq=>{const f=rq.failure()?.errorText||'';if(/ORB|BLOCKED/i.test(f))errs.push('ORB:'+rq.url().slice(0,50));});
  try{
    await p.goto('https://three.ws'+r,{waitUntil:'domcontentloaded',timeout:45000});
    for(let i=0;i<4;i++){await p.mouse.wheel(0,1400);await p.waitForTimeout(600);}
    await p.waitForTimeout(3500);
  }catch(e){errs.push('NAV:'+String(e).slice(0,60));}
  // dedupe
  const seen=new Map();
  for(const e of errs){const k=e.replace(/[0-9a-f]{16,}/g,'*');seen.set(k,(seen.get(k)||0)+1);}
  const bodyLen = await p.evaluate(()=>document.body.innerText.trim().length).catch(()=>0);
  console.log(`${r}: errors=${errs.length} bodyTextLen=${bodyLen}`);
  [...seen.entries()].slice(0,4).forEach(([k,n])=>console.log(`   ${n}× ${k}`));
  await p.close();
}
await b.close();
