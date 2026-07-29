// Does the "Couldn't load texture blob:" error reproduce only under the audit's
// parallel-page load, or does a single real user session hit it too?
import { chromium } from 'playwright';

const ROUTES = ['/avatar-sdk', '/play', '/club', '/tutorials/shopify-store-guide', '/gallery', '/character-library'];
const browser = await chromium.launch();

async function load(route, tag) {
	const page = await browser.newPage();
	let texErrors = 0;
	let otherErrors = 0;
	page.on('console', (m) => {
		if (m.type() !== 'error') return;
		if (/Couldn't load texture/.test(m.text())) texErrors++;
		else otherErrors++;
	});
	try {
		await page.goto('https://three.ws' + route, { waitUntil: 'networkidle', timeout: 25000 });
	} catch {
		try {
			await page.goto('https://three.ws' + route, { waitUntil: 'domcontentloaded', timeout: 25000 });
		} catch { /* nav failure counted by caller */ }
	}
	await page.waitForTimeout(2500);
	await page.close();
	console.log(`${tag} ${route}: texture-errors=${texErrors} other-errors=${otherErrors}`);
	return texErrors;
}

console.log('=== SEQUENTIAL (one page at a time, like a real user) ===');
let seq = 0;
for (const r of ROUTES) seq += await load(r, 'seq');

console.log('=== PARALLEL (all at once, like the audit harness) ===');
const par = (await Promise.all(ROUTES.map((r) => load(r, 'par')))).reduce((a, b) => a + b, 0);

console.log(`\nTOTALS  sequential=${seq}  parallel=${par}`);
await browser.close();
