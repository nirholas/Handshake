import { chromium } from 'playwright';
const B='http://localhost:3011';
const SP='/tmp/claude-1000/-workspaces-three-ws/9f8558d8-4c0c-45ae-a84d-32e54541a9fe/scratchpad';
const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const out=[];
const mk=async(o={})=>{const c=await b.newContext({viewport:{width:1440,height:900},...o});const p=await c.newPage();
 const errs=[];p.on('console',m=>{if(m.type()==='error'&&!/vite|websocket/i.test(m.text()))errs.push(m.text().slice(0,160))});
 p.on('pageerror',e=>{if(!/websocket/i.test(e.message))errs.push('PAGEERR '+e.message.slice(0,160))});return {c,p,errs};};

// 1. Classic docs integrity + the 3D world handoff button
{ const {c,p,errs}=await mk();
  await p.goto(B+'/docs/',{waitUntil:'load',timeout:45000}); await p.waitForTimeout(4000);
  const r=await p.evaluate(()=>{
    const btn=[...document.querySelectorAll('a,button')].find(e=>/3d world/i.test(e.textContent||''));
    return {title:document.title, h1:(document.querySelector('h1')?.innerText||'').slice(0,70),
      sidebarLinks:document.querySelectorAll('nav a, .sidebar a, aside a').length,
      worldBtn: btn?{text:btn.textContent.trim().slice(0,30),href:btn.getAttribute('href')}:null,
      articleChars:(document.querySelector('main,article')?.innerText||'').length};
  });
  await p.screenshot({path:SP+'/classic-docs.png'});
  out.push({test:'classic docs',...r,errs}); await c.close(); }

// 2. Handoff: click 3D world from a specific doc, confirm it carries the page
{ const {c,p,errs}=await mk();
  await p.goto(B+'/docs/#forge',{waitUntil:'load',timeout:45000}); await p.waitForTimeout(3500);
  const btn=await p.$('a[href*="/docs/world"]');
  const href=btn?await btn.getAttribute('href'):null;
  out.push({test:'handoff button carries page',href,errs}); await c.close(); }

// 3. Mobile 390x844 - touch controls present
{ const {c,p,errs}=await mk({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
  await p.goto(B+'/docs/world',{waitUntil:'load',timeout:45000}); await p.waitForTimeout(7000);
  const r=await p.evaluate(()=>{
    const joy=document.querySelector('[class*=joy],[id*=joy],[class*=stick]');
    const overflowX=document.documentElement.scrollWidth>document.documentElement.clientWidth+2;
    return {joystick:!!joy, horizontalOverflow:overflowX, canvas:!!document.querySelector('canvas'),
      hud:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,110)};
  });
  await p.screenshot({path:SP+'/dw-mobile.png'});
  out.push({test:'mobile 390px',...r,errs}); await c.close(); }

// 4. Reduced motion honored
{ const {c,p,errs}=await mk({reducedMotion:'reduce'});
  await p.goto(B+'/docs/world',{waitUntil:'load',timeout:45000}); await p.waitForTimeout(6000);
  out.push({test:'prefers-reduced-motion',canvas:await p.evaluate(()=>!!document.querySelector('canvas')),errs}); await c.close(); }

// 5. Keyboard: Index chip reachable + focus visible
{ const {c,p,errs}=await mk();
  await p.goto(B+'/docs/world',{waitUntil:'load',timeout:45000}); await p.waitForTimeout(6000);
  const seq=[];
  for(let i=0;i<8;i++){ await p.keyboard.press('Tab');
    seq.push(await p.evaluate(()=>{const a=document.activeElement;return a?((a.tagName)+':'+(a.textContent||a.getAttribute('aria-label')||'').trim().slice(0,26)):'none';})); }
  out.push({test:'keyboard tab order',seq,errs}); await c.close(); }
await b.close();
console.log(JSON.stringify(out,null,1));
