// Core-path tests for the browser entry point (src/index.js) and the built
// bundle it produces.
//
// Two layers:
//   1. Off-browser import. The module is imported by bundlers and by SSR
//      frameworks (Next.js renders the React wrapper's tree on the server), so
//      `import`ing it outside a browser must not throw and must expose the
//      documented exports. Before 1.2.1 it threw `ReferenceError: location is
//      not defined` at module evaluation.
//   2. Real browser. A real HTTP server answers a real x402 402 challenge,
//      Chromium loads the real bundle, and a real click drives the modal to the
//      price it read off the wire. No stubs, no fake wallet: the flow is
//      asserted up to the point where a wallet signature would be required.
//      Skipped (not failed) when Playwright is unavailable, so the package
//      still tests standalone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solanaAccept } from '../server/checkout.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Clearly-synthetic placeholder address (valid base58, 32-44 chars).
const ADDR = 'So11111111111111111111111111111111111111112';

test('the client entry imports off-browser and exposes the documented API', async () => {
	assert.equal(typeof globalThis.window, 'undefined', 'this test must run without a DOM');
	const mod = await import('../src/index.js');
	for (const name of ['pay', 'configure', 'init', 'version', 'USDC_MINT_SOLANA', 'THREE_MINT', 'KNOWN_SOLANA_TOKENS']) {
		assert.ok(name in mod, `missing export: ${name}`);
	}
	assert.equal(typeof mod.pay, 'function');
	assert.equal(typeof mod.configure, 'function');
	assert.equal(typeof mod.init, 'function');
});

test('the exported version tracks package.json', async () => {
	const { version } = await import('../src/index.js');
	assert.equal(version, pkg.version);
});

test('configure shallow-merges nested config and returns the resolved config', async () => {
	const { configure } = await import('../src/index.js');
	const cfg = configure({ checkoutOrigin: 'https://pay.example.com', brand: { name: 'Example' } });
	assert.equal(cfg.checkoutOrigin, 'https://pay.example.com');
	assert.equal(cfg.brand.name, 'Example');
	// The untouched half of `brand` survives the merge.
	assert.equal(cfg.brand.url, 'https://three.ws');
	// Restore the defaults for any later test in this process.
	configure({ checkoutOrigin: null, brand: { name: 'three.ws', url: 'https://three.ws' } });
});

test('pay rejects without an endpoint', async () => {
	const { pay } = await import('../src/index.js');
	await assert.rejects(() => pay({}), /endpoint is required/);
});

test('the client and server agree on the well-known Solana mints', async () => {
	const client = await import('../src/index.js');
	const server = await import('../server/checkout.js');
	assert.equal(client.THREE_MINT, server.THREE_MINT);
	assert.equal(client.USDC_MINT_SOLANA, server.USDC_MINT_SOLANA);
});

// ── Real-browser core path ───────────────────────────────────────────────────

async function loadChromium() {
	try {
		const { chromium } = await import('playwright');
		return chromium;
	} catch {
		return null;
	}
}

// Prefer the built bundle so this also proves the build output runs in a
// browser; fall back to source when `npm run build` has not been run yet.
function bundlePath() {
	const min = join(root, 'dist/x402.min.js');
	return existsSync(min) ? min : join(root, 'src/index.js');
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>x402 core path</title></head>
<body>
<button id="buy"
  data-x402-endpoint="/api/paid/hello"
  data-x402-merchant="Core Path"
  data-x402-action="Say hello">Pay &amp; Run</button>
<script type="module" src="/x402.js"></script>
</body></html>`;

test('a real 402 challenge drives the modal to its price in a browser', async (t) => {
	const chromium = await loadChromium();
	if (!chromium) return t.skip('playwright is not installed');

	const bundle = await readFile(bundlePath(), 'utf8');
	const challenge = {
		x402Version: 2,
		error: 'Payment required',
		resource: { url: 'http://127.0.0.1/api/paid/hello', description: 'A friendly hello.', mimeType: 'application/json' },
		accepts: [solanaAccept({ token: 'usdc', uiAmount: 0.25, payTo: ADDR, feePayer: ADDR, maxTimeoutSeconds: 60 })],
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname === '/x402.js') {
			res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
			return res.end(bundle);
		}
		if (url.pathname === '/api/paid/hello') {
			res.writeHead(402, { 'content-type': 'application/json' });
			return res.end(JSON.stringify(challenge));
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(PAGE);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const consoleErrors = [];
		page.on('pageerror', (err) => consoleErrors.push(String(err)));
		await page.goto(`${base}/`, { waitUntil: 'load' });

		// The module exposes itself for inline scripts and auto-binds the button.
		await page.waitForFunction(() => Boolean(window.X402));
		const api = await page.evaluate(() => ({
			version: window.X402.version,
			keys: Object.keys(window.X402).sort(),
			usdc: window.X402.tokens.USDC_MINT_SOLANA,
			bound: document.getElementById('buy').dataset.x402Bound,
		}));
		assert.equal(api.version, pkg.version);
		assert.deepEqual(api.keys, ['configure', 'init', 'pay', 'tokens', 'version']);
		assert.equal(api.usdc, challenge.accepts[0].asset, 'the bundle disagrees with the server on the USDC mint');
		assert.equal(api.bound, '1', 'the auto-binder did not bind the button');

		// Click: the modal mounts, fetches the endpoint, and renders what the
		// real 402 said. 0.25 USDC at 6 decimals is 250000 atomic units.
		await page.click('#buy');
		const dialog = page.locator('.x402-overlay [role="dialog"]');
		await dialog.waitFor({ state: 'visible', timeout: 10_000 });
		await page.waitForFunction(() => document.querySelector('[data-price]')?.textContent?.includes('0.25'), null, { timeout: 10_000 });

		assert.match(await page.locator('[data-price]').innerText(), /0\.25/);
		assert.match(await page.locator('[data-price]').innerText(), /USDC/);
		assert.match(await page.locator('[data-network]').innerText(), /Solana/i);
		assert.equal(await page.locator('[data-action]').innerText(), 'Say hello');
		// textContent, not innerText: the header uppercases the merchant in CSS.
		assert.equal(await page.locator('[data-merchant]').textContent(), 'Core Path');

		// Esc closes the modal, which is how `pay()` reports a cancellation.
		await page.keyboard.press('Escape');
		await dialog.waitFor({ state: 'detached', timeout: 10_000 });

		assert.deepEqual(consoleErrors, [], 'the page threw');
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
});
