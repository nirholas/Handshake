import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
await p.waitForTimeout(6000);

console.log('capability rows:');
for (const r of await p.$$eval('#av-skills-list .av-row', (ns) => ns.map((n) => n.innerText.replace(/\n/g, ' | '))))
  console.log('  ', r);
console.log('summary:', await p.$eval('.av-cap-summary', (n) => n.innerText.replace(/\n/g, ' ')).catch(() => 'none'));

const tabs = await p.$$eval('.av-tab', (ns) =>
  ns.map((n) => `${n.dataset.tab} sel=${n.getAttribute('aria-selected')} ti=${n.tabIndex} ctl=${n.getAttribute('aria-controls')}`));
console.log('tabs:'); tabs.forEach((t) => console.log('  ', t));

await p.click('.av-tab[data-tab="overview"]');
await p.waitForTimeout(300);
console.log('after click overview, url =', p.url());
await p.keyboard.press('ArrowRight');
await p.waitForTimeout(300);
console.log('after ArrowRight  focus =', await p.evaluate(() => document.activeElement?.dataset?.tab),
  '| selected =', await p.evaluate(() => document.querySelector('.av-tab.active')?.dataset.tab),
  '| url =', p.url());
await p.keyboard.press('End');
await p.waitForTimeout(300);
console.log('after End         focus =', await p.evaluate(() => document.activeElement?.dataset?.tab), '| url =', p.url());
await p.keyboard.press('ArrowRight');
await p.waitForTimeout(300);
console.log('wraps to          focus =', await p.evaluate(() => document.activeElement?.dataset?.tab));
console.log('panel roles ok:', await p.$$eval('.av-panel', (ns) => ns.every((n) => n.getAttribute('role') === 'tabpanel' && n.getAttribute('aria-labelledby'))));
console.log('shell aria-busy:', await p.$eval('#av-shell', (n) => n.getAttribute('aria-busy')));
await b.close();
