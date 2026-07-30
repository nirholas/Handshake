import { chromium } from 'playwright';
const B='http://localhost:3011';
const SP='/tmp/claude-1000/-workspaces-three-ws/9f8558d8-4c0c-45ae-a84d-32e54541a9fe/scratchpad';
const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const out=[];
for (const [name,vp,mob] of [['fix-mobile',{width:390,height:844},true],['fix-narrow320',{width:320,height:720},true],['fix-desktop',{width:1440,height:900},false]]) {
  const c=await b.newContext({viewport:vp,isMobile:mob,hasTouch:mob});
  const p=await c.newPage(); const errs=[];
  p.on('console',m=>{if(m.type()==='error'&&!/vite|websocket/i.test(m.text()))errs.push(m.text().slice(0,140))});
  p.on('pageerror',e=>{if(!/websocket/i.test(e.message))errs.push('PAGEERR '+e.message.slice(0,140))});
  await p.goto(B+'/docs/world',{waitUntil:'load',timeout:45000});
  await p.waitForTimeout(7000);
  const r=await p.evaluate(()=>({overflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth+2, canvas:!!document.querySelector('canvas')}));
  await p.screenshot({path:`${SP}/${name}.png`});
  out.push({name,...r,errs}); await c.close();
}
await b.close(); console.log(JSON.stringify(out,null,1));
