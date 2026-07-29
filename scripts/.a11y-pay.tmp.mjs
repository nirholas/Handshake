import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://localhost:3311/pay', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(1500);
console.log(await p.evaluate(() => {
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    for (const r of list) if (r.selectorText === '*') return `[${sheet.href || 'inline'}] ${r.cssText.slice(0, 500)}`;
  }
  return 'not found';
}));
await b.close();
