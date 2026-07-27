import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const apiCalls = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on('response', (r) => { if (r.url().includes('/api/')) apiCalls.push(`${r.status()} ${r.url().slice(0, 110)}`); });

await page.goto('https://three.ws/chat', { waitUntil: 'networkidle', timeout: 60000 });

// Send a real message through the free model chain.
const box = page.locator('textarea').first();
await box.click();
await box.fill('Reply with exactly: PONG');
await page.keyboard.press('Enter');

let reply = '';
for (let i = 0; i < 40; i += 1) {
  await page.waitForTimeout(1500);
  const t = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const idx = t.indexOf('Reply with exactly: PONG');
  if (idx >= 0) {
    const after = t.slice(idx + 24).trim();
    if (after.length > 10) { reply = after.slice(0, 200); break; }
  }
}
console.log('=== REPLY ===');
console.log(reply || '(no reply within 60s)');
console.log('=== API CALLS ===');
for (const c of apiCalls.slice(0, 12)) console.log(' ', c);
console.log('console errors:', errors.length);
for (const e of errors.slice(0, 8)) console.log('  ERR', e);

await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/42703d67-dc27-4d9d-9e8b-d69d40a2037b/scratchpad/chat-reply.png' });

// Nav overlap check across widths.
console.log('=== NAV OVERLAP ===');
for (const w of [1440, 1280, 1024, 768, 390]) {
  await page.setViewportSize({ width: w, height: 800 });
  await page.waitForTimeout(400);
  const boxes = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('header a, header button, nav a, nav button')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < 80) {
        out.push({ t: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 22), x: Math.round(r.left), r: Math.round(r.right), y: Math.round(r.top) });
      }
    }
    return out;
  });
  const overlaps = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j];
      if (Math.abs(a.y - b.y) < 20 && a.x < b.r && b.x < a.r) overlaps.push(`${a.t}|${b.t}`);
    }
  }
  const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(`${w}px: items=${boxes.length} overlaps=${overlaps.length} ${overlaps.slice(0, 4).join(', ')} hscroll=${bodyOverflow}`);
  await page.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/42703d67-dc27-4d9d-9e8b-d69d40a2037b/scratchpad/chat-${w}.png`, clip: { x: 0, y: 0, width: w, height: 90 } });
}

await browser.close();
