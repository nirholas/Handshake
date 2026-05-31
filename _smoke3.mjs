import puppeteer from 'puppeteer';
const URL='http://localhost:3003/embed?mode=walking&width=320&height=480&env=beach&bg=transparent&controls=joystick&autoplay=true';
const b=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const p=await b.newPage();
const errs=[];
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
p.on('pageerror',e=>errs.push(e.message));
await p.goto(URL,{waitUntil:'networkidle2',timeout:30000});
await p.click('.ee-picker');
await p.waitForSelector('.agp-card',{timeout:10000});
await p.click('.agp-card');
await p.waitForSelector('.agp-cta:not([disabled])',{timeout:5000});
await p.click('.agp-cta');
await new Promise(r=>setTimeout(r,1500)); // let preview iframe boot the walk runtime
const trigText=await p.$eval('.ee-picker',e=>e.innerText.replace(/\s+/g,' ').trim());
console.log(JSON.stringify({trigText,errs},null,2));
await b.close();
