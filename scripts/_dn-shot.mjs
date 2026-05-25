import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const handle = 'dnhome' + Date.now().toString(36);
await ctx.request.post(`${new URL(url).origin}/api/auth/register`, {
  data: { email: `${handle}@example.test`, password: 'PassP4ss!2026', display_name: 'Sam Avery' },
  headers: { 'content-type': 'application/json' },
});
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.dn-shell .dn-rail-item');
await p.waitForTimeout(1500);
const dom = await p.evaluate(() => {
  const shell = document.querySelector('.dn-shell');
  const children = [...shell.children].map(c => ({
    tag: c.tagName,
    cls: c.className,
    id: c.id,
    w: c.clientWidth,
    cs_grid_area: getComputedStyle(c).gridArea,
    cs_display: getComputedStyle(c).display,
  }));
  return { html: shell.outerHTML.length, children, shellCS: getComputedStyle(shell).gridTemplateColumns };
});
console.log(JSON.stringify(dom, null, 2));
await b.close();
