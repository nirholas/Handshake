import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const log = [];
page.on('console', (m) => log.push(`console.${m.type()}: ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.url().includes('/api/knock')) log.push(`response ${r.status()} ${r.url()}`); });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.push(`navigated: ${f.url()}`); });
await page.goto('http://localhost:3077/knock', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
const state = await page.evaluate(() => {
	const ids = ['directory-loading', 'directory', 'directory-empty', 'owner-loading', 'owner', 'signed-out', 'inbox-loading'];
	const out = {};
	for (const id of ids) {
		const el = document.getElementById(id);
		out[id] = el ? (el.hidden ? 'hidden' : 'visible') : 'MISSING';
	}
	out.emptyMsg = document.querySelector('#directory-empty [data-msg]')?.textContent?.trim() ?? null;
	out.url = location.href;
	return out;
});
// Prove the endpoint is reachable from inside the page.
const direct = await page.evaluate(async () => {
	try {
		const res = await fetch('/api/knock/directory?limit=60');
		return { status: res.status, body: (await res.text()).slice(0, 200) };
	} catch (e) { return { error: String(e) }; }
});
console.log(JSON.stringify({ state, direct }, null, 1));
console.log(log.join('\n'));
await browser.close();
