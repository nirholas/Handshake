// One-off evidence script for prompts/robinhood-chain/13-threews-play.md —
// full user journey: /worlds lobby -> Robinhood Chain tab -> click a real
// coin card -> lands on /play with the coin-flavored biome active.

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080';

async function run() {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on('pageerror', (err) => errors.push(err.message));
	page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

	await page.goto(`${BASE}/worlds`, { waitUntil: 'domcontentloaded', timeout: 30000 });
	await page.waitForTimeout(1500);
	await page.locator('.wl-tab[data-chain="robinhood-chain"]').click();
	await page.waitForTimeout(1000);

	const cardCount = await page.locator('#wl-worlds .wl-card').count();
	console.log('Robinhood tab card count:', cardCount);

	if (cardCount === 0) {
		console.log('No live Robinhood world cards right now (launch backlog empty) — falling back to direct nav to prove the /play route + biome wiring.');
		await page.goto(`${BASE}/play?coin=0x6b21b4567EfAd992B65f8a92457B45a74ed59486&name=LobbyE2E`, { waitUntil: 'domcontentloaded', timeout: 45000 });
	} else {
		const firstCard = page.locator('#wl-worlds .wl-card').first();
		const rhBadge = await firstCard.locator('.wl-card-chain').count();
		console.log('first card has RH badge:', rhBadge > 0);
		await Promise.all([
			page.waitForURL(/\/play\?/, { timeout: 15000 }).catch(() => null),
			firstCard.click(),
		]);
		console.log('landed on:', page.url());
	}

	await page.waitForTimeout(5000);
	const biome = await page.evaluate(() => ({
		id: window.__CC__?.env?.biome?.id || null,
		label: window.__CC__?.env?.biome?.label || null,
		mint: window.__CC__?.coin?.mint || null,
	}));
	console.log('active biome:', JSON.stringify(biome));
	await page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/bbd67923-b6d3-4593-92c8-9acb04d85900/scratchpad/rh-lobby-to-play.png' });

	await browser.close();
	console.log('\nconsole errors:', errors.length);
	for (const e of errors.slice(0, 15)) console.log(' -', e);
}

run().catch((err) => { console.error('FATAL', err); process.exit(1); });
