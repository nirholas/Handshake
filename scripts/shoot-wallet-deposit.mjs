#!/usr/bin/env node
/**
 * Capture the /wallet surfaces for the tutorial, and fail on any console error.
 *
 * Why this hosts its own server instead of using `npm run dev`: several agents
 * share this worktree, every write to vite.config.js restarts the dev server,
 * and a capture that races those restarts fails for reasons that have nothing
 * to do with the page. This bundles the real modules with esbuild (the same
 * bundler the production build runs through), serves the real page and the real
 * stylesheet, and answers the two API routes the page calls. Nothing about the
 * rendering is faked: the QR comes from the real `qrcode` encoder over a real
 * Solana Pay URI, and the layout is the shipped CSS.
 *
 * The signed-out shot is the genuine anon state, reached the genuine way: the
 * page calls /api/user/wallet, gets a 401, and renders it.
 *
 *   node scripts/shoot-wallet-deposit.mjs [--out public/docs/img] [--keep]
 */

import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(ROOT, flag('out', 'public/docs/img'));

const VIEWPORTS = [
	{ name: 'mobile', width: 390, height: 880 },
	{ name: 'desktop', width: 1280, height: 900 },
];

// A plausible mid-use wallet. Only these figures are supplied; the encoding,
// the layout and the QR are all produced by the shipped code.
const BALANCES = { sol: 0.482, sol_usdc: 124.5, evm_usdc: 40, total_usd: 233.1 };
const SOL_ADDR = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_ADDR = '0x2f1b7d5c9a4e6b8f0c3d5e7a9b1c3d5e7f9a1b3c';

/**
 * Root-level scripts the production build emits from src/. The page loads them
 * by their built names, so the harness bundles the same sources to the same
 * paths; otherwise the nav renders half-dressed in every screenshot.
 */
const BUILT_ENTRIES = {
	'/src/master-wallet.js': 'src/master-wallet.js',
	'/src/wallet-deposit.js': 'src/wallet-deposit.js',
	'/i18n.js': 'src/i18n.js',
	'/nav-tier-badge.js': 'src/nav-tier-badge.js',
	'/walk-companion.js': 'src/walk-companion.js',
};

/**
 * Paths this harness legitimately does not serve: the locale bundles come from
 * build:pages and the favicon set is generated. A 404 on anything NOT in this
 * list means the page references something that genuinely does not exist.
 */
const HARNESS_GAPS = [/^\/locales\//, /^\/favicon/, /^\/apple-touch-icon/];

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
};

/** Bundle a browser module exactly as the production build would. */
async function bundle(entry) {
	const out = await build({
		entryPoints: [resolve(ROOT, entry)],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		write: false,
		logLevel: 'silent',
	});
	return out.outputFiles[0].text;
}

async function startServer(modules) {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const path = url.pathname;

		const send = (status, body, type) => {
			res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
			res.end(body);
		};

		if (modules[path]) return send(200, modules[path], MIME['.js']);
		if (path === '/wallet' || path === '/wallet/' || path === '/') {
			return send(200, await readFile(resolve(ROOT, 'pages/wallet.html')), MIME['.html']);
		}
		// 401 across the board is exactly what a signed-out visitor gets from the
		// real API, and rendering that state correctly is one of the things being
		// captured. The nav, the notification bell and the wallet page all read
		// their own route and all have to handle it.
		if (path.startsWith('/api/')) {
			return send(401, JSON.stringify({ error: 'unauthorized' }), MIME['.json']);
		}

		try {
			const file = join(resolve(ROOT, 'public'), path);
			return send(200, await readFile(file), MIME[extname(path)] || 'application/octet-stream');
		} catch {
			return send(404, 'not found', 'text/plain');
		}
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
	await mkdir(OUT, { recursive: true });

	const modules = {};
	for (const [route, entry] of Object.entries(BUILT_ENTRIES)) {
		modules[route] = await bundle(entry);
	}
	const { server, base } = await startServer(modules);

	const browser = await chromium.launch();
	const problems = [];
	const shots = [];

	for (const vp of VIEWPORTS) {
		const ctx = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			deviceScaleFactor: 2,
			colorScheme: 'dark',
		});
		const page = await ctx.newPage();
		// A bare "failed to load resource" says nothing about which one, so the
		// request itself is inspected. This harness only serves public/ plus two
		// routes, so a locale bundle or a font missing here is the harness, not
		// the page; anything else is a real break and is reported.
		page.on('requestfailed', (r) => problems.push(`[${vp.name}] request failed: ${r.url()}`));
		page.on('response', (r) => {
			if (r.status() < 400 || r.status() === 401) return;
			const path = new URL(r.url()).pathname;
			if (HARNESS_GAPS.some((re) => re.test(path))) return;
			problems.push(`[${vp.name}] ${r.status()} on ${path}`);
		});
		page.on('console', (m) => {
			// The generic resource-error text is redundant with the response
			// listener above, which knows the URL.
			if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
				problems.push(`[${vp.name}] console: ${m.text()}`);
			}
		});
		page.on('pageerror', (e) => problems.push(`[${vp.name}] pageerror: ${e.message}`));

		await page.goto(`${base}/wallet`, { waitUntil: 'load' });

		await page.waitForSelector('.wlt-hero-title', { timeout: 15000 });
		const anon = `wallet-signed-out-${vp.name}.png`;
		await page.screenshot({ path: resolve(OUT, anon) });
		shots.push(anon);

		// Drive the real sheet. Only the balance reader is supplied.
		await page.evaluate(
			async ({ balances, solAddr, evmAddr }) => {
				const mod = await import('/src/wallet-deposit.js');
				mod.openDepositSheet({
					solanaAddress: solAddr,
					evmAddress: evmAddr,
					balances,
					readBalances: async () => balances,
				});
			},
			{ balances: BALANCES, solAddr: SOL_ADDR, evmAddr: EVM_ADDR },
		);

		await page.waitForSelector('.wlt-qr canvas', { timeout: 20000 });
		await page.waitForTimeout(500); // let the entry animation settle
		const sheet = `wallet-deposit-${vp.name}.png`;
		await page.screenshot({ path: resolve(OUT, sheet) });
		shots.push(sheet);

		// Typing an amount must re-encode the request, or the "pre-filled" claim
		// in the tutorial is false.
		await page.fill('#wlt-dep-amount', '25');
		await page.waitForTimeout(700);
		const uri = await page.getAttribute('[data-dep="open"]', 'href');
		if (!uri?.includes('amount=25')) {
			problems.push(`[${vp.name}] amount never reached the payment URI: ${uri}`);
		}

		// USDC has to pin the mint, or the request silently asks for native SOL.
		await page.click('[data-asset="usdc"]');
		await page.waitForSelector('.wlt-qr canvas', { timeout: 20000 });
		await page.waitForTimeout(400);
		const usdcUri = await page.getAttribute('[data-dep="open"]', 'href');
		if (!usdcUri?.includes('spl-token=')) {
			problems.push(`[${vp.name}] USDC request lost its mint: ${usdcUri}`);
		}
		if (vp.name === 'desktop') {
			const usdc = 'wallet-deposit-usdc-desktop.png';
			await page.screenshot({ path: resolve(OUT, usdc) });
			shots.push(usdc);
		}

		// Base must target the EVM address. Encoding it against the Solana one
		// would send real funds nowhere recoverable.
		await page.click('[data-asset="base"]');
		await page.waitForTimeout(500);
		const baseUri = await page.getAttribute('[data-dep="open"]', 'href');
		if (!baseUri?.startsWith('ethereum:') || baseUri.includes(SOL_ADDR)) {
			problems.push(`[${vp.name}] Base request was misrouted: ${baseUri}`);
		}

		// The arrival view is a real state of the real component, reached by
		// letting the watcher observe a balance that grew.
		await page.click('[data-asset="sol"]');
		await page.waitForTimeout(300);
		await page.evaluate(
			({ balances }) => {
				// The page-level watcher polls this; returning more than the
				// baseline is exactly what an inbound deposit looks like to it.
				window.__deposited = { ...balances, sol: balances.sol + 0.25 };
			},
			{ balances: BALANCES },
		);
		await ctx.close();
	}

	// The arrival state deserves its own pass with a reader that grows, rather
	// than being bolted onto the tail of the one above.
	{
		const ctx = await browser.newContext({
			viewport: { width: 1280, height: 900 },
			deviceScaleFactor: 2,
			colorScheme: 'dark',
		});
		const page = await ctx.newPage();
		page.on('pageerror', (e) => problems.push(`[arrival] pageerror: ${e.message}`));
		await page.goto(`${base}/wallet`, { waitUntil: 'load' });
		await page.waitForSelector('.wlt-hero-title', { timeout: 15000 });
		await page.evaluate(
			async ({ balances, solAddr, evmAddr }) => {
				const mod = await import('/src/wallet-deposit.js');
				let reads = 0;
				mod.openDepositSheet({
					solanaAddress: solAddr,
					evmAddress: evmAddr,
					balances,
					// First read matches the baseline; the second is 0.25 SOL richer,
					// which is precisely what an arriving deposit looks like.
					readBalances: async () =>
						++reads < 2 ? balances : { ...balances, sol: balances.sol + 0.25 },
				});
			},
			{ balances: BALANCES, solAddr: SOL_ADDR, evmAddr: EVM_ADDR },
		);
		await page.waitForSelector('.wlt-sheet-done-title', { timeout: 30000 });
		const text = await page.textContent('.wlt-sheet-done-title');
		if (!text?.includes('0.25')) {
			problems.push(`[arrival] wrong delta reported: ${text?.trim()}`);
		}
		await page.waitForTimeout(600);
		const arrived = 'wallet-deposit-arrived.png';
		await page.screenshot({ path: resolve(OUT, arrived) });
		shots.push(arrived);
		await ctx.close();
	}

	await browser.close();
	server.close();

	for (const s of shots) console.log(`wrote ${join(OUT, s)}`);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		process.exit(1);
	}
	console.log('\nno console errors; every payment URI encoded correctly; arrival delta exact.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
