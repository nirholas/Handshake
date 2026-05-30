// Capture what /play actually looks like right now: lobby + in-world.
// Stubs the trending-coins API (Vercel fn not available in plain `vite dev`) so
// we can click into a world and screenshot the real 3D scene. Reports console
// errors. Screenshots land in /tmp.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Stub trending coins so the lobby populates.
const COINS = Array.from({ length: 8 }, (_, i) => ({
	mint: 'Mint' + i, name: ['Doge','Pepe','Bonk','Wif','Popcat','Mew','Goat','Moodeng'][i],
	symbol: ['DOGE','PEPE','BONK','WIF','POPCAT','MEW','GOAT','MOO'][i],
	image: '', marketCap: (i + 1) * 1.2e6,
}));
await page.route('**/api/pump/trending**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ coins: COINS, items: COINS }) }));
await page.route('**/api/explore**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));

await page.goto(`${BASE}/pages/play.html`, { waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/play-lobby.png' });
console.log('lobby captured');

// Enter a world directly via the scene API (offline — no server needed).
await page.waitForFunction(() => !!window.__CC__, { timeout: 8000 });
await page.evaluate(() => window.__CC__.enter({ mint: 'DemoMint', name: 'Doge', symbol: 'DOGE', image: '' }));
await page.waitForTimeout(4000); // let avatar + scene settle
await page.screenshot({ path: '/tmp/play-world.png' });
console.log('world captured');

await browser.close();
console.log('console errors:', errors.length ? errors : 'none');
