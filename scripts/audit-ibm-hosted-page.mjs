#!/usr/bin/env node
// Proves the publish-once IBM partnership page still works on somebody else's
// domain.
//
// pages/ibm/hello.html is uploaded once onto a host we do not control (see
// pages/ibm/HOSTING.md). Everything about it is therefore the opposite of every
// other page in this repo: it runs on a FOREIGN ORIGIN, so every asset it names
// and every document it fetches from three.ws is a cross-origin request. Two
// whole classes of break are invisible to `npm run audit:console`, which loads
// /ibm/hello from three.ws itself, where all of it is same-origin:
//
//   1. A missing `access-control-allow-origin` on something the page reads.
//      On 2026-09-04 /x402.js, /i18n.js, /locales/*.json and /ibm/hello.live all
//      answered without one, so on the hosted copy the live-update fetch failed
//      silently (the page froze on its baked baseline, the exact thing HOSTING.md
//      promises will not happen), the language switcher never mounted, and the
//      paid demo never armed. On three.ws all four were perfect.
//   2. A root-relative URL in the fetched live document. It resolves against the
//      PUBLISHER'S origin once swapped in, so '/x402.js' asks ibm.com for a file
//      only three.ws has.
//
// This audit reproduces the hosted deployment exactly: it serves pages/ibm/ from
// a throwaway origin of its own and lets the page talk to a real three.ws over
// the network, so the browser applies its real cross-origin rules. Nothing is
// stubbed or intercepted; a proxy that answered for three.ws would satisfy CORS
// on the browser's behalf and blind the audit to the only failure it exists to
// catch. A console error is a failure, because on that page a console error
// means a visitor lost a demo.
//
// Usage:
//   node scripts/audit-ibm-hosted-page.mjs                 # against production
//   THREE_WS_ORIGIN=http://localhost:8080 node scripts/audit-ibm-hosted-page.mjs
//   HEADFUL=1 node scripts/audit-ibm-hosted-page.mjs       # watch it run
//
// Point THREE_WS_ORIGIN at a local `node server/index.mjs` to test THIS working
// tree; leave it off to test what the partner's visitors get right now. A local
// server needs a built dist/ (`npm run build`), because the page loads the
// agent-3d bundle from it like any visitor would.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { isIgnorableConsole } from './lib/console-noise.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = join(ROOT, 'pages/ibm');
const THREE_WS = (process.env.THREE_WS_ORIGIN || 'https://three.ws').replace(/\/$/, '');
const SETTLE_MS = Number(process.env.SETTLE_MS) || 12_000;

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
	'.json': 'application/json',
	'.png': 'image/png',
};

// The publisher's own web server: it holds hello.html and the files that travel
// with it (fonts/, vendor/, three.svg) and nothing else, which is precisely the
// deployment HOSTING.md describes.
function servePublisher() {
	return new Promise((resolve) => {
		const srv = createServer(async (req, res) => {
			const path = decodeURIComponent(req.url.split('?')[0]);
			const file = path === '/' || path === '/hello' ? 'hello.html' : path.replace(/^\//, '');
			if (file.includes('..')) {
				res.statusCode = 400;
				return res.end('bad path');
			}
			try {
				let bytes = await readFile(join(PAGE_DIR, file));
				// The published file names three.ws absolutely, which is the point of
				// baking it. Repoint those literals at the origin under test so a local
				// server can stand in for three.ws; against production this is a no-op.
				if (THREE_WS !== 'https://three.ws' && extname(file) === '.html') {
					bytes = Buffer.from(String(bytes).replaceAll('https://three.ws', THREE_WS));
				}
				res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
				res.end(bytes);
			} catch {
				res.statusCode = 404;
				res.end('not found');
			}
		});
		srv.listen(0, () => resolve({ srv, port: srv.address().port }));
	});
}

const { srv, port } = await servePublisher();
const publisherOrigin = `http://127.0.0.1:${port}`;

const problems = [];

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
const page = await browser.newPage();

// A paid demo answering 402 is the demo WORKING: the page asks an x402 endpoint
// for a price and gets one. The console sweep classifies auth- and
// payment-gated statuses the same way, and sharing its filter keeps the two
// audits agreeing about what counts as a defect.
const EXPECTED_STATUS = new Set([401, 402, 403, 429]);

page.on('console', (m) => {
	if (m.type() === 'error' && !isIgnorableConsole(m.text())) problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
	if (r.status() >= 400 && !EXPECTED_STATUS.has(r.status())) {
		problems.push(`http ${r.status()}: ${r.url()}`);
	}
});
page.on('requestfailed', (r) => {
	problems.push(`request failed: ${r.url()} (${r.failure()?.errorText || 'unknown'})`);
});

// The page gives its live fetch a 3 s budget, which is right for a visitor on a
// CDN-warm origin and wrong for the first cold request against a server this
// audit just started. Warm the document once so the measurement is of the page,
// not of a cold start this harness introduced.
await fetch(`${THREE_WS}/ibm/hello.live`, { headers: { origin: publisherOrigin } }).catch(() => {});

await page.goto(`${publisherOrigin}/hello`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(SETTLE_MS);

// The three guarantees the hosted copy makes, each of which failed silently at
// least once: the live document replaced the baked baseline, the runtime i18n
// mounted its switcher, and the x402 widget bound its payable element.
const state = await page.evaluate(() => ({
	source: document.documentElement.getAttribute('data-ibm-source'),
	langSwitcher: !!customElements.get('lang-switcher'),
	// `data-x402Bound` is set by x402.js on each payable element it binds, so
	// this is proof the script LOADED and ran, not merely that the markup for a
	// payable button is present (which it is even when the script was blocked).
	payable: !!document.querySelector('[data-x402-endpoint][data-x402-bound="1"]'),
}));

await browser.close();
srv.close();

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

console.log(`\nIBM hosted-page audit: publisher ${publisherOrigin}, three.ws ${THREE_WS}\n`);
const checks = [
	['live update applied (not frozen on the baked baseline)', state.source === 'live'],
	['runtime i18n mounted its language switcher', state.langSwitcher],
	['x402 widget bound its payable element', state.payable],
	['no console errors, page errors or failed requests', problems.length === 0],
];
for (const [label, ok] of checks) console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${label}`);

if (problems.length) {
	console.log(`\n${red(`${problems.length} problem(s):`)}`);
	for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
}

const failed = checks.some(([, ok]) => !ok);
console.log(failed ? `\n${red('FAILED')}\n` : `\n${green('The hosted copy works on a foreign origin.')}\n`);
process.exit(failed ? 1 : 0);
