// Capture the LIVE /play lobby from production (https://three.ws/play).
// Lobby-only: real pump.fun coin grid, no multiplayer WS handshake required.
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const browser = await chromium.launch({
	args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('https://three.ws/play', { waitUntil: 'domcontentloaded', timeout: 40000 });
const got = await page.waitForSelector('.cc-card:not(.cc-skeleton)', { timeout: 25000 }).then(() => true).catch(() => false);
console.log('real coin cards:', got);
await sleep(2500);
await page.screenshot({ path: '/tmp/play-lobby.png', animations: 'disabled', caret: 'hide', timeout: 30000 });
console.log('lobby saved; errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(0);
