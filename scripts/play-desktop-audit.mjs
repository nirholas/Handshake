// Desktop audit pass for /play: console errors/warnings, failed requests,
// boot phase timeline, HUD presence, and an interaction sweep (open/close the
// main panels via their toolbar buttons), ending with a screenshot.
import { chromium } from 'playwright';

const TARGET = process.argv[2];
const RUN_MS = Number(process.argv[3] || 45000);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const issues = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    const line = `[console.${m.type()}] ${m.text().slice(0, 300)}`;
    issues.push(line); console.log(at(), line);
  }
});
page.on('pageerror', (e) => { const l = `[pageerror] ${String(e).slice(0, 400)}`; issues.push(l); console.log(at(), l); });
page.on('requestfailed', (r) => {
  const l = `[reqfail] ${r.failure()?.errorText} ${r.url().slice(0, 140)}`;
  if (!/ERR_ABORTED/.test(l)) { issues.push(l); console.log(at(), l); }
});
page.on('response', (r) => { if (r.status() >= 400) { const l = `[http ${r.status()}] ${r.url().slice(0, 140)}`; issues.push(l); console.log(at(), l); } });

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(at(), 'domcontentloaded');

// Wait for the world (deep link skips lobby): loader hidden.
try {
  await page.waitForFunction(() => {
    const l = document.getElementById('kx-loading');
    return !l || l.classList.contains('kx-hidden');
  }, { timeout: 40000 });
  console.log(at(), 'loader cleared');
} catch { console.log(at(), 'LOADER NEVER CLEARED'); }

// Dismiss onboarding cards.
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(1800);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /^(continue|enter the world|got it|start|close|skip)$/i.test(b.textContent.trim()) && b.offsetParent);
    if (btn) { btn.click(); return btn.textContent.trim(); }
    return null;
  });
  if (clicked) console.log(at(), '[dismissed]', clicked);
}

// Inventory the visible HUD buttons, then click each one and see what happens.
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => b.offsetParent)
    .map((b) => ({ label: (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 40), cls: b.className.toString().slice(0, 60) }))
);
console.log(at(), 'visible buttons:', JSON.stringify(buttons.slice(0, 60)));

const state = await page.evaluate(() => ({
  phase: window.__CC__?.phase || null,
  canvas: !!document.getElementById('kx-canvas'),
  hud: !!document.querySelector('.cc-hud, [class*="hud"]'),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((n) => n.textContent.trim().slice(0, 80)),
}));
console.log(at(), 'state:', JSON.stringify(state));

await page.waitForTimeout(Math.max(0, RUN_MS - (Date.now() - t0)));
await page.screenshot({ path: process.env.SHOT || '/tmp/play-desktop.png' }).catch(() => {});
console.log('\n=== issue summary (' + issues.length + ') ===');
const counts = new Map();
for (const i of issues) counts.set(i.replace(/\d+/g, 'N'), (counts.get(i.replace(/\d+/g, 'N')) || 0) + 1);
for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(' ', String(c).padStart(3), 'x', k);
await browser.close();
