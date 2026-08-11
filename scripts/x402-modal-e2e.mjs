#!/usr/bin/env node
// Real-browser conformance for x402-modal-sdk (@three-ws/x402-modal).
//
// The package's `npm test` is a zero-dependency `node --test` run, so it covers
// the protocol and helper layers but cannot open the modal. This script covers
// what only a browser can: the global build binding `[data-x402-endpoint]`, the
// modal mounting and completing real discovery against a live three.ws x402
// route, cancellation staying silent, and the `data-x402-*` script-tag config
// applying under BOTH documented CDN URL shapes (the extensionless
// `unpkg.com/@three-ws/x402-modal/global` subpath and a self-hosted
// `x402.global.js`).
//
// Run from the repo root, after `npm --prefix x402-modal-sdk run build`:
//
//   node scripts/x402-modal-e2e.mjs
//
// Exits non-zero on the first failed assertion. Needs network: the demo route
// (https://three.ws/api/x402/dance-tip) is a live paid endpoint, probed only as
// far as its 402 challenge. Nothing is signed and nothing is spent.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', 'x402-modal-sdk');
const DEMO = 'https://three.ws/api/x402/dance-tip?dancer=1&dance=rumba';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json' };

// One static server for the package dir, plus two synthetic pages that load the
// same global build under different URL shapes.
const GLOBAL_BUILD = await readFile(join(ROOT, 'dist/x402.global.js')).catch(() => {
	console.error('dist/ is missing. Run: npm --prefix x402-modal-sdk run build');
	process.exit(1);
});

const configPage = (src) => `<!doctype html><meta charset="utf-8"><body>
<script type="module" src="${src}" data-x402-brand-label="Powered by Acme" data-x402-brand-href="https://acme.com"></script>
<button id="pay" data-x402-endpoint="${DEMO}">Pay</button>
</body>`;

const server = createServer(async (req, res) => {
	const path = new URL(req.url, 'http://x').pathname;
	// The CDN's extensionless subpath, serving the same bytes as the file.
	if (path === '/global') {
		res.writeHead(200, { 'content-type': 'text/javascript' });
		return res.end(GLOBAL_BUILD);
	}
	if (path === '/cdn-form.html') return html(res, configPage('/global'));
	if (path === '/file-form.html') return html(res, configPage('/dist/x402.global.js'));
	try {
		const file = join(ROOT, normalize(decodeURIComponent(path)));
		res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
		res.end(await readFile(file));
	} catch {
		res.writeHead(404).end('not found');
	}
});
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`  ok  ${name}`); };

// A 402 is the protocol working, not a page error; everything else is a real failure.
const watch = (page, errors) => {
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (m.type() === 'error' && !/status of 402/.test(m.text())) errors.push(m.text());
	});
};

const priceResolved = () => !/resolving/.test(document.querySelector('[data-network]')?.textContent || '');

try {
	console.log('examples/index.html');
	const errors = [];
	const page = await browser.newPage();
	watch(page, errors);
	await page.goto(`${origin}/examples/index.html`, { waitUntil: 'networkidle' });

	const api = await page.evaluate(() => Object.keys(window.X402 || {}));
	await check('the global build exposes window.X402', () => assert.deepEqual(api.sort(), ['configure', 'discover', 'init', 'pay', 'version']));
	await check('it auto-binds [data-x402-endpoint]', async () => assert.equal(await page.getAttribute('#declarative', 'data-x402-bound'), '1'));

	// Declarative button: modal mounts and runs real discovery against the live route.
	await page.click('#declarative');
	await page.waitForSelector('.x402-overlay .x402-modal', { timeout: 15_000 });
	await page.waitForFunction(priceResolved, { timeout: 30_000 });
	const price = (await page.textContent('[data-price]'))?.trim();
	const network = (await page.textContent('[data-network]'))?.trim();
	await check('discovery resolves a real price from the live 402', () => assert.match(price, /^[\d.]+\s*USDC$/));
	await check('discovery resolves the network', () => assert.ok(network && network !== 'resolving'));

	// Escape cancels; cancellation must not surface as an error to the merchant.
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => !document.querySelector('.x402-overlay'), { timeout: 10_000 });
	const out = (await page.textContent('#declarative-out'))?.trim();
	await check('cancelling closes the modal without firing x402:error', () => assert.doesNotMatch(out, /^Error:/));

	// Programmatic pay() rejects with code 'cancelled' when the user closes it.
	await page.click('#programmatic');
	await page.waitForSelector('.x402-overlay .x402-modal', { timeout: 15_000 });
	await page.waitForFunction(priceResolved, { timeout: 30_000 });
	await page.click('.x402-close');
	await page.waitForFunction(() => document.querySelector('#programmatic-out')?.textContent === 'cancelled.', { timeout: 10_000 });
	await check("pay() rejects with code 'cancelled' on close", () => assert.ok(true));

	// discover() runs headless in the page, off the ESM build.
	const accepts = await page.evaluate(async ([o, demo]) => {
		const { discover } = await import(`${o}/dist/x402-modal.mjs`);
		return (await discover({ endpoint: demo })).accepts.map((a) => a.network);
	}, [origin, DEMO]);
	await check('discover() returns accepts[] without opening any UI', () => assert.ok(accepts.length > 0));
	await check('the page logged no unexpected errors', () => assert.deepEqual(errors, []));
	await page.close();

	// The data-x402-* script-tag config must apply under both documented URL shapes.
	console.log('data-x402-* script-tag config');
	for (const [label, path] of [['CDN subpath (/global)', '/cdn-form.html'], ['self-hosted file (x402.global.js)', '/file-form.html']]) {
		const p = await browser.newPage();
		await p.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
		await p.click('#pay');
		await p.waitForSelector('.x402-foot', { timeout: 15_000 });
		const foot = (await p.textContent('.x402-foot'))?.replace(/\s+/g, ' ').trim();
		await check(`brand override applies via ${label}`, () => assert.match(foot, /Powered by Acme/));
		await p.close();
	}

	console.log(`\n${checks.length} checks passed.`);
} finally {
	await browser.close();
	server.close();
}
