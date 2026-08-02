import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const seen = [];
await p.goto('http://localhost:3000/create', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 20; i++) {
  seen.push(await p.evaluate(() => !!document.querySelector('.brand-mark-chip')));
  await p.waitForTimeout(150);
}
console.log('chip present at any point during 3s:', seen.some(Boolean), '| samples:', seen.map(v => v ? 1 : 0).join(''));
await b.close();
