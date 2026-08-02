import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Snapshot the corner at the exact moment brand.js decides (DOMContentLoaded).
await p.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const CORNER = 'a[href="/"],a[href="/home"],button,summary,[class*="burger" i],[class*="hamburger" i],[class*="menu-toggle" i],[aria-label*="menu" i],[aria-label*="back" i],[aria-label*="home" i]';
    const BRAND = '.brand-mark,.wordmark-logo,.header-logo,.dn-rail-full,.nxt-brand-mark,.agent-header-logo,.pg-header-logo,[data-brand-mark]';
    const inCorner = (el, mw) => { const r = el.getBoundingClientRect();
      if (!(r.width>0&&r.height>0)) return false; if (mw && r.width>mw) return false; return r.top<104 && r.left<232; };
    window.__snap = {
      named: [...document.querySelectorAll(BRAND)].map(e=>e.tagName+'.'+String(e.className).slice(0,50)),
      occ: [...document.querySelectorAll(CORNER)].filter(e=>inCorner(e)).map(e=>e.tagName+'|'+String(e.className).slice(0,40)+'|'+(e.getAttribute('aria-label')||'')),
      imgs: [...document.querySelectorAll('img,svg')].filter(e=>inCorner(e,360)).map(e=>e.tagName),
    };
  }, { once: true });
});
await p.goto('http://localhost:3000/ar', { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(1200);
console.log(JSON.stringify(await p.evaluate(() => window.__snap), null, 1));
await b.close();
