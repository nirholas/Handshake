// Interaction smoke check — load each demo, wait for the avatar to mount,
// then exercise the page's primary trigger (button click, hover) and confirm
// no runtime errors fire during the animation sequence.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] });
let totalFail = 0;

async function run(route, action) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', msg => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });

	console.log(`\n→ ${route}`);
	await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 15000 });

	// Wait until the GLB + clips have loaded — the demos all set phase = 'idle'
	// (or 'confused' for 404) once the loader's .then fires. We poll the canvas
	// for ~3s, which is plenty of headroom on local dev.
	await page.waitForTimeout(2500);

	await action(page);
	// Let the triggered animation play out
	await page.waitForTimeout(3500);

	if (errors.length) {
		console.log(`  ✖ errors during interaction:`);
		errors.forEach(e => console.log(`    ${e}`));
		totalFail++;
	} else {
		console.log(`  ✓ interaction completed cleanly`);
	}
	await ctx.close();
}

// 404 — click "Back to lab" (goes to /demos/, which we know returns 200) so we
// can verify the run-off animation triggers without being polluted by errors
// from the redirect destination.
await run('/demos/404.html', async page => {
	await page.click('#lab-btn', { noWaitAfter: true });
});

// Checkout — click Add to cart, which triggers grab → run → cart thump
await run('/demos/checkout.html', async page => {
	await page.click('#add-btn');
});

// Pricing — hover Basic tier, then Enterprise, which should trigger two jumps
await run('/demos/pricing.html', async page => {
	await page.hover('#tier-basic');
	await page.waitForTimeout(1500);
	await page.hover('#tier-enterprise');
});

await browser.close();
console.log(`\n${totalFail === 0 ? '✓ all interactions clean' : `✖ ${totalFail} interaction(s) had errors`}`);
process.exit(totalFail === 0 ? 0 : 1);
