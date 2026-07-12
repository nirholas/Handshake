// One-off evidence script: two real headless browser clients joining the same
// Robinhood Chain coin's walk_world room on a LOCAL multiplayer server
// (workers/index.mjs proxies room reads through community-net.js unchanged —
// this proves the existing room system needs no changes for an EVM coin id).

import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';
const RH_COIN = '0x955b339944CbD4834156366D766C260C80956B44';
const LOCAL_MP = 'ws://localhost:2567';

async function client(browser, name) {
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	await page.addInitScript((url) => { window.GAME_SERVER_URL = url; }, LOCAL_MP);
	const logs = [];
	page.on('console', (msg) => {
		const t = msg.text();
		if (/room|colyseus|join/i.test(t)) logs.push(t);
	});
	await page.goto(`${BASE}/play?coin=${RH_COIN}&name=${name}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.waitForTimeout(30000);
	const status = await page.evaluate(() => ({
		phase: window.__CC__?.phase,
		status: window.__CC__?.net?.status || null, connected: !!window.__CC__?.net?.sessionId,
		sessionId: window.__CC__?.net?.sessionId || null,
	}));
	return { page, logs, status };
}

async function run() {
	const browser = await chromium.launch({ headless: true });
	const [a, b] = await Promise.all([client(browser, 'ClientA'), client(browser, 'ClientB')]);

	console.log('Client A:', JSON.stringify(a.status));
	console.log('Client A room logs:', a.logs.slice(0, 5));
	console.log('Client B:', JSON.stringify(b.status));
	console.log('Client B room logs:', b.logs.slice(0, 5));

	await a.page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/bbd67923-b6d3-4593-92c8-9acb04d85900/scratchpad/rh-mp-client-a.png' });
	await b.page.screenshot({ path: '/tmp/claude-1000/-workspaces-three-ws/bbd67923-b6d3-4593-92c8-9acb04d85900/scratchpad/rh-mp-client-b.png' });

	await browser.close();
}

run().catch((err) => { console.error('FATAL', err); process.exit(1); });
