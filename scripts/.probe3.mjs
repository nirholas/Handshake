import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const events = [];
page.on('console', m => events.push(m.type() + ': ' + m.text().slice(0, 160)));
page.on('pageerror', e => events.push('PAGEERROR: ' + e.message.slice(0, 160)));
page.on('response', r => { if (/concierge\.global\.js/.test(r.url())) events.push('RESPONSE ' + r.status() + ' ' + r.url()); });
page.on('requestfailed', r => events.push('REQFAILED ' + r.url().slice(0,100) + ' ' + r.failure()?.errorText));
await page.goto('https://three.ws/concierge', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(8000);
const state = await page.evaluate(() => ({
  hasGlobal: typeof window.ThreeWsConcierge,
  hasConcierge: typeof window.Concierge,
  instance: typeof window.__threeWsConcierge,
  scripts: [...document.querySelectorAll('script[src*="concierge.global"]')].map(s => ({ type: s.type || 'classic', src: s.getAttribute('src') })),
}));
console.log('EVENTS:'); events.forEach(e => console.log('  ', e));
console.log('STATE:', JSON.stringify(state, null, 2));
await browser.close();
