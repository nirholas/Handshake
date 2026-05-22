// Headless smoke check for /demos/agents/auto-rig.html.
// Loads the page, waits for the inline module + Gradio client CDN import to
// settle, and reports any page errors, console errors, or failed requests.
// Run with: node scripts/verify-auto-rig.mjs
//   BASE_URL=http://localhost:3001 node scripts/verify-auto-rig.mjs

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const URL  = `${BASE}/demos/agents/auto-rig.html`;

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
const failed = [];

page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
	if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});
page.on('requestfailed', (req) => {
	const u = req.url();
	if (/esm\.sh|huggingface/.test(u)) return;
	failed.push(`${u} (${req.failure()?.errorText})`);
});
page.on('response', (resp) => {
	const s = resp.status();
	const u = resp.url();
	if (s >= 400 && !/esm\.sh|huggingface/.test(u)) failed.push(`${u} → ${s}`);
});

console.log(`→ ${URL}`);
try {
	await page.goto(URL, { waitUntil: 'load', timeout: 20000 });
	await page.waitForTimeout(3500);
} catch (e) {
	console.log(`  ✖ navigation failed: ${e.message}`);
	await browser.close();
	process.exit(1);
}

const present = await page.evaluate(() => ({
	drop:      !!document.getElementById('drop'),
	fileInput: !!document.getElementById('file'),
	runBtn:    !!document.getElementById('run'),
	statusEl:  !!document.getElementById('status'),
	canvasIn:  !!document.getElementById('canvas-in'),
	canvasOut: !!document.getElementById('canvas-out'),
	temperature: !!document.getElementById('temperature'),
	useTransfer: !!document.getElementById('use_transfer'),
	runDisabled: document.getElementById('run')?.disabled === true,
	indexCard: false,
}));

// Also check the index page has the new card.
await page.goto(`${BASE}/demos/agents/`, { waitUntil: 'load', timeout: 20000 });
present.indexCard = await page.evaluate(() => !!document.querySelector('a[href="/demos/agents/auto-rig.html"]'));

let fail = 0;
console.log('\nDOM presence:');
for (const [k, v] of Object.entries(present)) {
	console.log(`  ${v ? '✓' : '✖'} ${k}`);
	if (!v) fail++;
}

if (errors.length) {
	console.log('\nErrors:');
	for (const e of errors) console.log(`  ✖ ${e}`);
	fail += errors.length;
} else {
	console.log('\nNo page or console errors.');
}

if (failed.length) {
	console.log('\nFailed requests:');
	for (const f of failed) console.log(`  ✖ ${f}`);
	fail += failed.length;
} else {
	console.log('No failed requests.');
}

await browser.close();
process.exit(fail > 0 ? 1 : 0);
