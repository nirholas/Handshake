// Temporary E2E harness for /receipts (deleted after the run).
import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import bs58pkg from 'bs58';
const bs58 = bs58pkg.default || bs58pkg;

const OUT = '/tmp/claude-1000/-workspaces-three-ws/bdacc6ae-94a1-4fd1-9a02-d84da1c248a1/scratchpad';
const kp = nacl.sign.keyPair();
const address = bs58.encode(kp.publicKey);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
page.on('response', (r) => {
	if (r.url().includes('my-receipts')) console.log('  API my-receipts →', r.status());
});

await page.exposeFunction('__sign', (bytes) =>
	Array.from(nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey)),
);
await page.addInitScript((addr) => {
	window.solana = {
		isPhantom: true,
		publicKey: { toString: () => addr },
		connect: async () => ({ publicKey: { toString: () => addr } }),
		signMessage: async (encoded) => ({
			signature: Uint8Array.from(await window.__sign(Array.from(encoded))),
		}),
	};
}, address);

await page.goto('http://localhost:3000/receipts', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#rc-signin', { state: 'visible' });
console.log('title:', await page.title());
console.log('signed-out card visible:', await page.locator('#rc-signin').isVisible());
await page.screenshot({ path: `${OUT}/rc-1-signedout.png` });

console.log('\n-- connect + sign + live fetch --');
await page.click('#rc-connect-solana');
await page.waitForSelector('#rc-vault:not([hidden])', { timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('.rc-skeleton'), { timeout: 30000 });
console.log('wallet chip:', (await page.locator('#rc-wallet-addr').textContent()).trim(), '·', (await page.locator('#rc-wallet-net').textContent()).trim());
console.log('KPIs:', await page.locator('#rc-k-total').textContent(), '/', await page.locator('#rc-k-endpoints').textContent(), '/', await page.locator('#rc-k-networks').textContent());
console.log('empty state shown:', await page.locator('#rc-empty').isVisible(), '·', (await page.locator('#rc-empty-title').textContent()).trim());
console.log('empty state has CTA link:', await page.locator('#rc-empty-body a').count());
await page.screenshot({ path: `${OUT}/rc-2-empty.png` });

console.log('\n-- populated render (injected rows through the real render path) --');
await page.evaluate(() => {
	window.dispatchEvent(new Event('resize'));
});
// Drive the real renderer via the module's own list markup by seeding through
// the API shape: reload with a stubbed fetch so renderVault() runs on real rows.
await page.route('**/api/x402/my-receipts*', (route) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({
			network: 'solana',
			address,
			count: 3,
			receipts: [
				{ id: 1, payer: address, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', resourceUrl: 'https://three.ws/api/x402/d/token-snapshot', format: 'jws', amountAtomics: '10000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', transaction: '5xTr4nsAcT10nS1gNaTuReF0rTeSt1nGpUrP0SeS0nLy1234567890abcd', receipt: { format: 'jws', signature: 'abc' }, issuedAt: new Date(Date.now() - 3600e3).toISOString() },
				{ id: 2, payer: address, network: 'eip155:8453', resourceUrl: 'https://three.ws/api/x402/d/whale-activity', format: 'jws', amountAtomics: '1000', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', transaction: '0xdeadbeef1234567890abcdef', receipt: { format: 'jws', signature: 'def' }, issuedAt: new Date(Date.now() - 7200e3).toISOString() },
				{ id: 3, payer: address, network: 'solana', resourceUrl: 'https://three.ws/api/x402/d/holder-concentration', format: 'jws', amountAtomics: null, asset: null, transaction: null, receipt: { format: 'jws', signature: 'ghi' }, issuedAt: new Date(Date.now() - 86400e3).toISOString() },
			],
		}),
	}),
);
await page.click('#rc-refresh');
await page.waitForFunction(() => document.querySelectorAll('.rc-row:not(.rc-skeleton)').length === 3, { timeout: 20000 });
console.log('rows rendered:', await page.locator('.rc-row').count());
console.log('KPIs:', await page.locator('#rc-k-total').textContent(), 'receipts /', await page.locator('#rc-k-endpoints').textContent(), 'endpoints /', await page.locator('#rc-k-networks').textContent());
const links = await page.locator('a.rc-tx').evaluateAll((els) => els.map((e) => e.href));
console.log('explorer links:', links);
console.log('SPEND tile:', (await page.locator('#rc-k-spend').textContent()).trim(), '|', (await page.locator('#rc-k-spend-note').textContent()).trim());
console.log('row amounts:', await page.locator('.rc-amount').allTextContents());
console.log('private tx cell:', await page.locator('.rc-tx-none').count());
await page.screenshot({ path: `${OUT}/rc-3-populated.png` });

console.log('\n-- search filter --');
await page.fill('#rc-search', 'whale');
await page.waitForTimeout(300);
console.log('rows after search "whale":', await page.locator('.rc-row').count());
await page.fill('#rc-search', 'zzzz');
await page.waitForTimeout(300);
console.log('no-match empty state:', (await page.locator('#rc-empty-title').textContent()).trim());
await page.screenshot({ path: `${OUT}/rc-4-nomatch.png` });
await page.fill('#rc-search', '');
await page.waitForTimeout(300);

console.log('\n-- keyboard + actions --');
await page.locator('body').click();
await page.keyboard.press('/');
console.log('"/" focuses search:', await page.evaluate(() => document.activeElement?.id));
await page.keyboard.press('Escape');
await page.locator('body').click();

const dl = page.waitForEvent('download', { timeout: 10000 });
await page.keyboard.press('e');
const csv = await dl;
console.log('CSV download:', csv.suggestedFilename());

const dl2 = page.waitForEvent('download', { timeout: 10000 });
await page.locator('[data-action="download"]').first().click();
console.log('JSON download:', (await dl2).suggestedFilename());

console.log('\n-- error state --');
await page.unroute('**/api/x402/my-receipts*');
await page.route('**/api/x402/my-receipts*', (route) =>
	route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'receipt_query_failed', error_description: 'Receipt store unreachable.' }) }),
);
await page.click('#rc-refresh');
await page.waitForSelector('#rc-load-error:not([hidden])', { timeout: 15000 });
console.log('error state:', (await page.locator('#rc-load-error-msg').textContent()).trim());
console.log('retry button present:', await page.locator('#rc-retry').isVisible());
await page.screenshot({ path: `${OUT}/rc-5-error.png` });

console.log('\n-- disconnect --');
await page.click('#rc-disconnect');
console.log('back to sign-in:', await page.locator('#rc-signin').isVisible());
console.log('session cleared:', await page.evaluate(() => sessionStorage.getItem('twx_receipts_session')));

console.log('\n-- responsive 375px --');
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(300);
const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
console.log('horizontal scroll at 375px:', hScroll);
await page.screenshot({ path: `${OUT}/rc-6-mobile.png` });

console.log('\nconsole errors:', errors.length ? errors : 'NONE');
await browser.close();
