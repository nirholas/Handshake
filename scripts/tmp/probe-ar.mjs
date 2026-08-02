import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:3000/ar', { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => {
  const CORNER = 'a[href="/"],a[href="/home"],button,summary,[class*="burger" i],[class*="hamburger" i],[class*="menu-toggle" i],[aria-label*="menu" i],[aria-label*="back" i],[aria-label*="home" i]';
  const inCorner = (el, maxWidth) => { const r = el.getBoundingClientRect();
    if (!(r.width>0&&r.height>0)) return false; if (maxWidth && r.width>maxWidth) return false;
    return r.top < 104 && r.left < 232; };
  const occ = [...document.querySelectorAll(CORNER)].filter(e=>inCorner(e));
  const imgs = [...document.querySelectorAll('img,svg')].filter(e=>inCorner(e,360));
  return { cornerOccupants: occ.map(e=>e.tagName+'.'+String(e.className).slice(0,40)),
           cornerImgs: imgs.map(e=>e.tagName+'.'+String(e.className.baseVal ?? e.className).slice(0,40)),
           chip: !!document.querySelector('.brand-mark-chip') };
}), null, 1));
await b.close();
