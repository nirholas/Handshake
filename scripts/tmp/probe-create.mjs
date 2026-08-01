import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.goto('http://localhost:3000/create', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
const out = await p.evaluate(() => {
  const chip = document.querySelector('.brand-mark-chip');
  const nav = document.querySelector('header.nav');
  const r = (e) => e ? (({x,y,width,height}) => ({x,y,width,height}))(e.getBoundingClientRect()) : null;
  const brandSel = '.brand-mark,.wordmark-logo,.header-logo,.dn-rail-full,.nxt-brand-mark,.agent-header-logo,.pg-header-logo,[data-brand-mark]';
  const named = [...document.querySelectorAll(brandSel)].filter(e => !e.closest('.brand-mark-chip'));
  return {
    chip: r(chip),
    chipZ: chip && getComputedStyle(chip).zIndex,
    nav: r(nav),
    navZ: nav && getComputedStyle(nav).zIndex,
    namedBrands: named.map(e => ({ cls: e.className && String(e.className).slice(0,60), rect: r(e), disp: getComputedStyle(e).display, vis: getComputedStyle(e).visibility })),
  };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
