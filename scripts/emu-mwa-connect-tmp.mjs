#!/usr/bin/env node
// Fire threeWsWallet.connect() inside the TWA (non-blocking) so the MWA
// association intent launches the wallet app. Result is stashed on
// window.__mwaResult for a later probe.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) {
	for (const p of ctx.pages()) {
		if (p.url().includes('three.ws')) { page = p; break; }
	}
}
if (!page) { console.error('three.ws page not found'); process.exit(1); }

await page.evaluate(() => {
	window.__mwaResult = window.threeWsWallet
		.connect()
		.then((r) => ({ ok: true, publicKey: r.publicKey?.toBase58?.() || String(r.publicKey) }))
		.catch((e) => ({ ok: false, error: String(e) }));
});
console.log('connect() fired');
await browser.close();
