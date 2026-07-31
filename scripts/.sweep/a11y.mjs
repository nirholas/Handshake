import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const axe = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
const pages = JSON.parse(readFileSync('data/pages.json', 'utf8'))
  .sections.flatMap((s) => s.pages)
  .sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))
  .slice(0, 16);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
for (const { path } of pages) {
  const p = await ctx.newPage();
  try {
    await p.goto('http://localhost:3021' + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForTimeout(3500);
    await p.evaluate(axe);
    const res = await p.evaluate(async () => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
    const v = res.violations;
    console.log(`${v.length ? 'FAIL' : ' ok '} ${path}  ${v.map((x) => `${x.id}(${x.impact},${x.nodes.length})`).join(' ')}`);
  } catch (e) {
    console.log(`ERR  ${path} ${e.message.slice(0, 60)}`);
  }
  await p.close();
}
await b.close();
