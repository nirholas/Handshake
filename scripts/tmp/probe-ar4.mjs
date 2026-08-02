import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const inCorner = (el, mw) => { const r = el.getBoundingClientRect();
      if (!(r.width>0&&r.height>0)) return false; if (mw && r.width>mw) return false; return r.top<104 && r.left<232; };
    window.__svg = [...document.querySelectorAll('img,svg')].filter(e=>inCorner(e,360)).map(e => ({
      tag: e.tagName, cls: String(e.className.baseVal ?? e.className).slice(0,60),
      parent: e.parentElement && (e.parentElement.tagName + '.' + String(e.parentElement.className.baseVal ?? e.parentElement.className).slice(0,50)),
      closestInteractive: !!e.closest('button,a,[role="button"]'),
      closestLink: e.closest('a') && e.closest('a').getAttribute('href'),
      html: e.outerHTML.slice(0, 160),
    }));
  }, { once: true });
});
await p.goto('http://localhost:3000/ar', { waitUntil: 'domcontentloaded', timeout: 20000 });
await p.waitForTimeout(1000);
console.log(JSON.stringify(await p.evaluate(() => window.__svg), null, 1));
await b.close();
