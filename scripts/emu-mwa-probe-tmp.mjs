#!/usr/bin/env node
// Probe the three.ws TWA running in the emulator via CDP: check the MWA boot
// state (seeker-detect signals, threeWsWallet presence) inside the real app.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
	for (const p of ctx.pages()) {
		if (p.url().includes('three.ws')) { page = p; break; }
	}
}
if (!page) { console.error('three.ws page not found'); process.exit(1); }

const state = await page.evaluate(() => ({
	url: location.href,
	referrer: document.referrer,
	standalone: window.matchMedia('(display-mode: standalone)').matches,
	fullscreen: window.matchMedia('(display-mode: fullscreen)').matches,
	ua: navigator.userAgent.slice(0, 120),
	hasThreeWsWallet: typeof window.threeWsWallet !== 'undefined',
	windowSolanaSet: typeof window.solana !== 'undefined' && window.solana !== null,
	walletIsThreeWs: Boolean(window.solana?.isThreeWs),
}));
console.log(JSON.stringify(state, null, 1));
await browser.close();
