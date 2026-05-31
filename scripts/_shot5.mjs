import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const base='http://127.0.0.1:3002';
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1440,height:900}});
const grab=async(n)=>{const d=await p.evaluate(()=>{const c=document.querySelector('#as-stage canvas');return c?c.toDataURL('image/png'):null;});if(d)writeFileSync(n,Buffer.from(d.split(',')[1],'base64'));return !!d;};
await p.goto(base+'/create/studio',{waitUntil:'networkidle'}).catch(()=>{});
await p.waitForTimeout(7000);
await p.click('#as-tab-face').catch(()=>{});
await p.waitForTimeout(400);
// zoom in toward head target a few notches to frame the face
const c=await p.$('#as-stage canvas'); const box=await c.boundingBox();
await p.mouse.move(box.x+box.width/2, box.y+box.height*0.35);
for(let i=0;i<6;i++){await p.mouse.wheel(0,-120);await p.waitForTimeout(120);}
await p.waitForTimeout(1200);
console.log('neutral:',await grab('/tmp/f3-neutral.png'));
await p.click('button[data-expr="cheerful"]').catch(()=>{}); await p.waitForTimeout(1800);
console.log('cheerful:',await grab('/tmp/f3-cheerful.png'));
await b.close();
