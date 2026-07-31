// Sweep the highest-priority pages at phone width for horizontal overflow,
// the defect class that just shipped on a brand-new page.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const pages = JSON.parse(readFileSync('data/pages.json', 'utf8'))
  .sections.flatMap((s) => s.pages)
  .sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))
  .slice(0, 24);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const rows = [];
for (const { path } of pages) {
  const p = await ctx.newPage();
  try {
    await p.goto('http://localhost:3021' + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(3000);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const worst = over > 1 ? await p.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const el = [...document.querySelectorAll('body *')].map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.right > w + 1 && r.width > 0)
        .sort((a, c) => c.r.right - a.r.right)[0];
      return el ? `${el.e.tagName.toLowerCase()}.${(el.e.className || '').toString().split(' ')[0]}` : '';
    }) : '';
    rows.push({ path, over, worst });
  } catch (e) {
    rows.push({ path, over: -1, worst: e.message.slice(0, 40) });
  }
  await p.close();
}
rows.filter((r) => r.over !== 0).forEach((r) => console.log(`${String(r.over).padStart(5)}px  ${r.path}  ${r.worst}`));
console.log(`\nclean: ${rows.filter((r) => r.over === 0).length}/${rows.length}`);
await b.close();
