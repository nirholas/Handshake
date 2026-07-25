// Load the real /sign-language page, let the hero sign, screenshot, report console errors.
import { chromium } from 'playwright';

const browser = await chromium.launch({
	args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const msgs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => msgs.push(`[pageerror] ${e}`));
await page.goto('http://localhost:3000/sign-language', { waitUntil: 'load' });
await page.waitForTimeout(9000);
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/07298a69-ffef-4726-8a81-87336d28fc86/scratchpad/page-hero.png' });

// Vocabulary chips rendered?
const chips = await page.$$eval('.sl-vocab-chip', (els) => els.map((e) => e.textContent));
console.log('vocab chips:', chips.length, chips.slice(0, 8).join(', '));

// Type a mixed sentence and watch the status.
await page.fill('#sl-spell-input', 'happy to meet you');
await page.click('#sl-spell-btn');
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/07298a69-ffef-4726-8a81-87336d28fc86/scratchpad/page-sign.png' });
await page.waitForTimeout(6000);
console.log('status:', await page.textContent('#sl-status'));

console.log(msgs.length ? 'CONSOLE:\n' + msgs.join('\n') : 'no console errors/warnings');
await browser.close();
