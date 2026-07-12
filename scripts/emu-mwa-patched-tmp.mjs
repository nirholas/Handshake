#!/usr/bin/env node
// Verify the MWA icon fix in the running emulator TWA without a deploy:
// 1. unregister the service worker + clear caches (so routing sees requests)
// 2. intercept JS bundles and hot-patch the absolute identity.icon to relative
// 3. reload, then fire threeWsWallet.connect() from a real click (user
//    activation is required to launch the solana-wallet:// intent)
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
let page = null, ctx = null;
for (const c of browser.contexts()) {
	for (const p of c.pages()) {
		if (p.url().includes('three.ws')) { page = p; ctx = c; break; }
	}
}
if (!page) { console.error('three.ws page not found'); process.exit(1); }

await page.evaluate(async () => {
	const regs = await navigator.serviceWorker.getRegistrations();
	for (const r of regs) await r.unregister();
	for (const k of await caches.keys()) await caches.delete(k);
});
console.log('sw + caches cleared');

const NEEDLE = 'https://three.ws/pwa-192x192.png';
let patched = 0;
await ctx.route('**/*.js', async (route) => {
	const resp = await route.fetch();
	let body = await resp.text();
	if (body.includes(`icon:"${NEEDLE}"`) || body.includes(`icon: '${NEEDLE}'`)) {
		body = body
			.replaceAll(`icon:"${NEEDLE}"`, 'icon:"/pwa-192x192.png"')
			.replaceAll(`icon: '${NEEDLE}'`, "icon: '/pwa-192x192.png'");
		patched += 1;
	}
	await route.fulfill({ response: resp, body });
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.threeWsWallet), null, { timeout: 30000 });
console.log('reloaded, threeWsWallet ready, bundles patched:', patched);

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
await page.click('#__mwa_test_btn');
console.log('connect() fired via real click');
await browser.close();
