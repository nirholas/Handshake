// Headless proof the ambient crowd spawns, lives, and chatters in /play.
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:3000';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// avoid lobby API dependency
await page.route('**/api/explore**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));

await page.goto(`${BASE}/pages/play.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__CC__, { timeout: 10000 });

// Drop into a world offline.
await page.evaluate(() => window.__CC__.enter({ mint: 'DemoMint', name: 'Doge', symbol: 'DOGE', image: '' }));

// Give the crowd time to attach, load avatars, walk, and chatter.
await page.waitForTimeout(7000);

const snap = await page.evaluate(() => {
	const labels = [...document.querySelectorAll('.cc-label')].map((n) => n.textContent);
	const chatMsgs = document.querySelectorAll('.cc-chat-log .cc-chat-msg').length;
	const online = document.querySelector('.cc-online span:last-child')?.textContent
		|| [...document.querySelectorAll('span')].map(s=>s.textContent).find(t=>/online/.test(t||''));
	return { phase: window.__CC__.phase, labelCount: labels.length, labels, chatMsgs, online };
});

// Capture a frame of the living world.
await page.screenshot({ path: '/tmp/play-ambient.png' });
await browser.close();

console.log('phase        :', snap.phase);
console.log('crowd labels :', snap.labelCount, snap.labels);
console.log('chat msgs    :', snap.chatMsgs);
console.log('online text  :', snap.online);
console.log('console errs :', errors.length ? errors : 'none');

let pass = true;
if (snap.phase !== 'world') { console.error('❌ did not reach world'); pass = false; }
if (snap.labelCount < 1) { console.error('❌ no ambient avatars spawned'); pass = false; }
if (errors.filter(e => !/Colyseus|WebSocket|connect failed|1006|game-server|run.app/i.test(e)).length) {
	console.error('❌ non-network console errors:', errors); pass = false;
}
console.log(pass ? '\n✅ AMBIENT CROWD LIVE — avatars present, screenshot at /tmp/play-ambient.png' : '\n❌ AMBIENT TEST FAILED');
process.exit(pass ? 0 : 1);
