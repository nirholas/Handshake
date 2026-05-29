import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const PAGES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/discover', '/agents', '/pay', '/login', '/start', '/create'];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

const report = {};
for (const path of PAGES) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 200)));
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
  } catch (e) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  await page.waitForTimeout(1200);

  const data = await page.evaluate(() => {
    const vw = window.innerWidth;
    const docW = document.documentElement.scrollWidth;
    // Elements that overflow horizontally past the viewport
    const overflowers = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed') continue;
      if (r.right > vw + 1.5 || r.left < -1.5) {
        // skip elements clipped by an ancestor (marquees / carousels / scrollers)
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = getComputedStyle(p);
          const ox = ps.overflowX;
          if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
            clipped = true;
            break;
          }
        }
        if (clipped) continue;
        overflowers.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 60),
          id: el.id || '',
          left: Math.round(r.left),
          right: Math.round(r.right),
          w: Math.round(r.width),
        });
      }
    }
    // Tap targets too small (interactive elements < 40px)
    const smallTargets = [];
    const interactive = document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [onclick]'
    );
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (r.height < 32 || r.width < 24) {
        smallTargets.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 50),
          text: (el.textContent || '').trim().slice(0, 30),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    // Text that may be too small
    return {
      vw,
      docW,
      hasHorizontalScroll: docW > vw + 1,
      overflowCount: overflowers.length,
      overflowers: overflowers.slice(0, 25),
      smallTargetCount: smallTargets.length,
      smallTargets: smallTargets.slice(0, 20),
      title: document.title,
    };
  });
  data.consoleErrors = consoleErrors.slice(0, 8);
  report[path] = data;
  await page.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
