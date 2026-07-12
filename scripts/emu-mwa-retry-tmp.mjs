#!/usr/bin/env node
// Re-fire connect() via the injected button (warm wallet this time), without
// waiting for the cross-app navigation that made the previous click hang.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null;
for (const ctx of browser.contexts()) {
	for (const p of ctx.pages()) {
		if (p.url().includes('three.ws')) { page = p; break; }
	}
}
if (!page) { console.error('three.ws page not found'); process.exit(1); }

const hasBtn = await page.evaluate(() => Boolean(document.getElementById('__mwa_test_btn')));
if (!hasBtn) {
	await page.evaluate(() => {
		const btn = document.createElement('button');
		btn.id = '__mwa_test_btn';
		btn.textContent = 'MWA TEST';
		btn.style.cssText = 'position:fixed;top:120px;left:10px;z-index:2147483647;padding:20px;font-size:20px;';
		btn.addEventListener('click', () => {
			window.__mwaResult = window.threeWsWallet
				.connect()
				.then((r) => ({ ok: true, publicKey: r.publicKey?.toBase58?.() || String(r.publicKey) }))
				.catch((e) => ({ ok: false, error: String(e) }));
		});
		document.body.appendChild(btn);
	});
}
await page.click('#__mwa_test_btn', { noWaitAfter: true, timeout: 15000 });
console.log('connect() re-fired');
await browser.close();
