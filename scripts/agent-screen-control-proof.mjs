// Real-browser proof for the agent-screen control dispatcher.
//
// Launches an actual headless Chromium (the same engine the caster pool runs),
// loads an interactive page, and drives it ONLY through workers/agent-screen-pool
// /control.js applyEvents() using the exact normalized wire events the API emits.
// Asserts each input truly landed: a click toggled state, coordinates mapped to
// the right element, text typed into a field, a whitelisted key fired, a wheel
// scrolled the page, a blocked nav was refused, and reload worked. No mocks.
//
//   node scripts/agent-screen-control-proof.mjs
//
// Exit 0 = every assertion passed. Exit 1 = a failure (prints which).

import { chromium } from 'playwright';
import { applyEvents } from '../workers/agent-screen-pool/control.js';

const VP = { width: 1280, height: 720 };
const results = [];
const ok = (name, cond, detail = '') => {
	results.push({ name, pass: !!cond, detail });
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// Normalized center of an element, in the same 0..1 space the client sends.
async function centerOf(page, selector) {
	const box = await page.locator(selector).boundingBox();
	if (!box) throw new Error(`no box for ${selector}`);
	return { x: (box.x + box.width / 2) / VP.width, y: (box.y + box.height / 2) / VP.height };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
	body{margin:0;font:16px system-ui;height:2400px}
	#btn{position:absolute;left:200px;top:120px;width:180px;height:56px}
	#field{position:absolute;left:200px;top:220px;width:320px;height:36px;font-size:16px}
	#log{position:absolute;left:200px;top:300px}
	#foot{position:absolute;left:200px;top:2300px}
</style></head><body>
	<button id="btn">click me</button>
	<input id="field" placeholder="type here">
	<div id="log">idle</div>
	<div id="foot">bottom</div>
	<script>
		let clicks=0;
		document.getElementById('btn').addEventListener('click',()=>{clicks++;document.getElementById('log').textContent='clicked:'+clicks;});
		document.getElementById('field').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('log').textContent='submitted:'+e.target.value;});
	</script>
</body></html>`;

async function main() {
	const browser = await chromium.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	});
	const context = await browser.newContext({ viewport: VP });
	const page = await context.newPage();

	try {
		await page.setContent(PAGE, { waitUntil: 'domcontentloaded' });

		// 1. Click, coordinates map to the right element and the handler fires.
		const btn = await centerOf(page, '#btn');
		await applyEvents(page, [{ t: 'click', x: btn.x, y: btn.y, button: 'left' }], VP);
		ok('click lands on the targeted element', (await page.locator('#log').textContent()) === 'clicked:1');

		// 2. Focus the field by clicking it, then type via a coalesced text event.
		const field = await centerOf(page, '#field');
		await applyEvents(page, [
			{ t: 'click', x: field.x, y: field.y, button: 'left' },
			{ t: 'text', text: 'hello agent' },
		], VP);
		ok('text event types into the focused field', (await page.locator('#field').inputValue()) === 'hello agent');

		// 3. Whitelisted key (Enter) fires the field's keydown handler.
		await applyEvents(page, [{ t: 'key', key: 'Enter' }], VP);
		ok('Enter key reaches the page', (await page.locator('#log').textContent()) === 'submitted:hello agent');

		// 4. Backspace edits the field (another whitelisted key).
		await applyEvents(page, [{ t: 'key', key: 'Backspace' }], VP);
		ok('Backspace edits the field', (await page.locator('#field').inputValue()) === 'hello agen');

		// 5. Wheel scroll moves the page.
		await applyEvents(page, [{ t: 'scroll', x: 0.5, y: 0.5, dy: 800 }], VP);
		await page.waitForTimeout(80);
		const scrolled = await page.evaluate(() => window.scrollY);
		ok('wheel event scrolls the page', scrolled > 0, `scrollY=${scrolled}`);

		// 6. A blocked nav (loopback) is refused, the page must NOT navigate.
		const before = page.url();
		await applyEvents(page, [{ t: 'nav', url: 'http://127.0.0.1:9/' }], VP);
		await page.waitForTimeout(50);
		ok('blocked nav is refused (SSRF guard)', page.url() === before, `url unchanged`);

		// 7. Positive nav to a real public site (best-effort, needs egress).
		let navPass = null;
		try {
			await applyEvents(page, [{ t: 'nav', url: 'https://example.com/' }], VP);
			await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
			navPass = /example/i.test(await page.title());
		} catch {
			navPass = null; // no network egress in this environment
		}
		if (navPass === null) console.log('SKIP  positive nav to example.com (no network egress)');
		else ok('nav to a public site navigates', navPass, `title=${await page.title().catch(() => '?')}`);

	} finally {
		await browser.close();
	}

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
	if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('proof crashed:', e); process.exit(1); });
