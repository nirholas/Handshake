import { chromium } from 'playwright';
const PORT = process.argv[2] || '3012';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
p.on('console',  m => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load resource/.test(t)) errs.push('[err] ' + t.slice(0, 200)); }});

const FAKE_ME = { id: 'u_test', email: 'demo@three.ws', display_name: 'Demo', handle: 'demo' };

async function setupAuthed() {
  await p.unroute('**/api/notifications**').catch(() => {});
  await p.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_ME) }));
  await p.route('**/api/csrf-token', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"t"}' }));
  await p.route('**/api/notifications**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ unread_count: 2, notifications: [
      { id: 'n1', type: 'payment_received', payload: { amount_usdc: 500000, from: '0xabc123def456' }, created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), read_at: null },
      { id: 'n2', type: 'skill_purchased',  payload: { amount_usdc: 100000, buyer: 'alice.eth' }, created_at: new Date(Date.now() - 17 * 60 * 1000).toISOString(), read_at: null },
      { id: 'n3', type: 'withdrawal_completed', payload: { amount_usdc: 2500000, tx: 'sig123' }, created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(), read_at: '2026-05-24T00:00:00Z' },
      { id: 'n4', type: 'auth_signin', payload: { ip: '198.51.100.10' }, created_at: new Date(Date.now() - 2 * 86400000).toISOString(), read_at: null },
    ] }),
  }));
}

const URL = `http://127.0.0.1:${PORT}/dashboard-next`;

console.log('--- A. drawer CLOSED state ---');
await setupAuthed();
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.removeItem('dn:drawer:open'); localStorage.removeItem('dn:drawer:filters'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.dn-shell', { timeout: 10000 });
await p.waitForTimeout(1500);
const closed = await p.evaluate(() => {
  const d = document.querySelector('.dn-drawer');
  return { display: d ? getComputedStyle(d).display : null, width: d ? d.getBoundingClientRect().width : null, shellOpen: document.querySelector('.dn-shell').getAttribute('data-drawer-open') };
});
console.log('closed=', JSON.stringify(closed));
await p.screenshot({ path: '/tmp/dn-drawer-closed.png' });

console.log('--- B. drawer OPEN with events ---');
await p.evaluate(() => { localStorage.setItem('dn:drawer:open', '1'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.dn-drawer[aria-label="Activity"]', { state: 'visible', timeout: 10000 });
await p.waitForTimeout(8000);
const opened = await p.evaluate(() => {
  const d = document.querySelector('.dn-drawer');
  const rows = document.querySelectorAll('.dnd-row');
  const days = [...document.querySelectorAll('.dnd-day')].map(e => e.innerText);
  const reads = [...rows].map(r => r.getAttribute('data-read'));
  return { width: d.getBoundingClientRect().width, rowCount: rows.length, days, reads };
});
console.log('opened=', JSON.stringify(opened));
const dEl = await p.$('.dn-drawer');
await dEl.screenshot({ path: '/tmp/dn-drawer-open.png' });

console.log('--- C. expand row ---');
await p.click('.dnd-row');
await p.waitForTimeout(400);
await dEl.screenshot({ path: '/tmp/dn-drawer-expanded.png' });

console.log('--- D. filter chip ---');
// Collapse first
await p.click('.dnd-row');
await p.waitForTimeout(150);
await p.click('.dnd-chip[data-filter="payment.received"]');
await p.waitForTimeout(400);
const filtered = await p.evaluate(() => ({
  visibleRows: document.querySelectorAll('.dnd-row').length,
  pressed: [...document.querySelectorAll('.dnd-chip[aria-pressed="true"]')].map(c => c.getAttribute('data-filter')),
  ls: localStorage.getItem('dn:drawer:filters'),
}));
console.log('filtered=', JSON.stringify(filtered));
await dEl.screenshot({ path: '/tmp/dn-drawer-filtered.png' });

console.log('--- E. signed-out state ---');
await p.unroute('**/api/notifications**');
await p.route('**/api/notifications**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
await p.evaluate(() => { localStorage.removeItem('dn:drawer:filters'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.dn-drawer', { state: 'visible' });
await p.waitForTimeout(7000);
const so = await p.evaluate(() => document.querySelector('.dn-drawer .dn-empty h3')?.innerText);
console.log('signedOut h3=', so);
const drEl = await p.$('.dn-drawer');
await drEl.screenshot({ path: '/tmp/dn-drawer-signedout.png' });

console.log('--- console errors ---');
for (const e of errs) console.log(' ', e);
if (errs.length) { console.log('FAIL: errors above'); process.exitCode = 1; }

await b.close();
