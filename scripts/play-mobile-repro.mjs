// Diagnostic harness for the "/play kicks mobile users out right after joining"
// report. Loads the live world in an emulated phone, drops into the $THREE home
// town the way a first-time visitor does, and records every console message,
// page error, websocket lifecycle event, failed request, transferred-bytes total
// and JS heap sample until the run window closes.
//
//   ENGINE=chromium node scripts/play-mobile-repro.mjs https://three.ws/play 120000
//   ENGINE=webkit   node scripts/play-mobile-repro.mjs https://three.ws/play 120000
//
// Chromium reports heap + transfer sizes; WebKit reproduces iOS Safari behaviour
// (memory kills, WebSocket lifecycle) but exposes no heap counters.
import { webkit, chromium, devices } from 'playwright';

const ENGINE = process.env.ENGINE === 'chromium' ? chromium : webkit;
const DEVICE = process.env.DEVICE || 'iPhone 14';
const TARGET = process.argv[2] || 'https://three.ws/play';
const RUN_MS = Number(process.argv[3] || 120000);

const browser = await ENGINE.launch({
	args: ENGINE === chromium ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : [],
});
const ctx = await browser.newContext({ ...devices[DEVICE] });
// Trace every animation-clip fetch back to its caller so a duplicated download
// can be attributed to the code that asked for it, not just counted.
await ctx.addInitScript(() => {
	window.__clipFetches = [];
	// GLTFLoader loads through XMLHttpRequest, not fetch, so model downloads need
	// their own hook to be attributable.
	window.__glbLoads = [];
	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		if (/\.glb(\?|$)/i.test(String(url))) window.__glbLoads.push({ url: String(url), stack: new Error().stack });
		return origOpen.call(this, method, url, ...rest);
	};
	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		const url = typeof input === 'string' ? input : input?.url || '';
		if (/\/animations\/(clips|manifest)/.test(url)) {
			window.__clipFetches.push({ url, stack: new Error().stack });
		}
		if (/\.glb(\?|$)/i.test(url)) window.__glbLoads.push({ url, stack: new Error().stack });
		return origFetch.call(this, input, init);
	};
});
const page = await ctx.newPage();
const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

let bytes = 0;
const byHost = new Map();
const biggest = [];

page.on('console', (m) => {
	const type = m.type();
	const cap = type === 'error' || type === 'warning' ? 400 : 200;
	console.log(at(), `[console.${type}]`, m.text().slice(0, cap));
});
page.on('pageerror', (e) => console.log(at(), '[pageerror]', String(e?.stack || e).slice(0, 800)));
page.on('crash', () => console.log(at(), '[PAGE CRASH]'));
page.on('requestfailed', (r) => console.log(at(), '[reqfail]', r.failure()?.errorText, r.url().slice(0, 140)));
page.on('response', async (r) => {
	if (r.status() >= 400) console.log(at(), '[http]', r.status(), r.url().slice(0, 140));
	try {
		const len = Number((await r.allHeaders())['content-length'] || 0);
		if (len > 0) {
			bytes += len;
			const host = new URL(r.url()).host;
			byHost.set(host, (byHost.get(host) || 0) + len);
			biggest.push([len, r.url()]);
		}
	} catch { /* response body gone, not worth failing the run over */ }
});
page.on('websocket', (ws) => {
	console.log(at(), '[ws OPEN]', ws.url().slice(0, 160));
	ws.on('close', () => console.log(at(), '[ws CLOSE]', ws.url().slice(0, 100)));
	ws.on('socketerror', (err) => console.log(at(), '[ws ERROR]', err));
});
page.on('framenavigated', (f) => {
	if (f === page.mainFrame()) console.log(at(), '[navigated]', f.url().slice(0, 160));
});

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(at(), 'domcontentloaded');

// Drive the cold-open intro: drop straight into the $THREE home town, the same
// zero-friction path a first-time mobile visitor takes.
try {
	await page.waitForSelector('.pi-btn-primary', { timeout: 25000 });
	await page.click('.pi-btn-primary');
	console.log(at(), '[action] clicked drop-in');
} catch (err) {
	console.log(at(), '[action] no intro CTA:', String(err).slice(0, 120));
}

// Clear the onboarding cards so the screenshot shows the world itself.
for (let i = 0; i < 6; i++) {
	await page.waitForTimeout(2500);
	const clicked = await page.evaluate(() => {
		const btn = [...document.querySelectorAll('button')]
			.find((b) => /^(continue|enter the world|got it|start|close|skip)$/i.test(b.textContent.trim()) && b.offsetParent);
		if (btn) { btn.click(); return btn.textContent.trim(); }
		return null;
	});
	if (clicked) console.log(at(), '[action] dismissed', clicked);
}

const deadline = Date.now() + RUN_MS;
let lastDom = '';
while (Date.now() < deadline) {
	await page.waitForTimeout(3000);
	try {
		const snap = await page.evaluate(() => {
			const loader = document.getElementById('kx-loading');
			const bootErr = loader && loader.querySelector('.kx-boot-error');
			const mem = performance.memory
				? Math.round(performance.memory.usedJSHeapSize / 1048576)
				: null;
			const cc = window.__CC__;
			return {
				phase: cc?.phase || null,
				crowd: document.querySelectorAll('.cc-label').length,
				loading: !!(loader && !loader.classList.contains('kx-hidden')),
				bootError: bootErr ? bootErr.textContent.slice(0, 200) : null,
				heapMB: mem,
				toasts: [...document.querySelectorAll('[class*="toast"]')].map((n) => n.textContent.trim().slice(0, 100)),
			};
		});
		const key = JSON.stringify({ ...snap, heapMB: undefined });
		if (key !== lastDom) { console.log(at(), '[dom]', JSON.stringify(snap)); lastDom = key; }
		else if (snap.heapMB != null) console.log(at(), '[heap]', snap.heapMB, 'MB · transferred', (bytes / 1048576).toFixed(1), 'MB');
	} catch (err) {
		console.log(at(), '[eval failed]', String(err).slice(0, 200));
	}
}

console.log('\n=== transfer totals ===');
console.log('total', (bytes / 1048576).toFixed(1), 'MB');
for (const [host, n] of [...byHost].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
	console.log(' ', (n / 1048576).toFixed(2).padStart(8), 'MB', host);
}
const counts = new Map();
for (const [, url] of biggest) counts.set(url, (counts.get(url) || 0) + 1);
console.log('\n=== most-repeated responses ===');
for (const [url, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
	console.log(' ', String(c).padStart(4), 'x', url.slice(0, 130));
}
console.log('\n=== 25 largest responses ===');
for (const [len, url] of biggest.sort((a, b) => b[0] - a[0]).slice(0, 25)) {
	console.log(' ', (len / 1048576).toFixed(2).padStart(8), 'MB', url.slice(0, 150));
}
const byPath = new Map();
for (const [len, url] of biggest) {
	const k = url.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/*');
	byPath.set(k, [(byPath.get(k)?.[0] || 0) + len, (byPath.get(k)?.[1] || 0) + 1]);
}
console.log('\n=== bytes by path group ===');
for (const [k, [n, c]] of [...byPath].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20)) {
	console.log(' ', (n / 1048576).toFixed(2).padStart(8), 'MB', String(c).padStart(4), 'x', k.slice(0, 120));
}

try {
	const glb = await page.evaluate(() => window.__glbLoads || []);
	console.log('\n=== GLB loads (' + glb.length + ') ===');
	const seen = new Set();
	for (const g of glb) {
		const frames = g.stack.split('\n').filter((l) => !/chunk-|node_modules/.test(l)).slice(1, 5).map((l) => l.trim().replace(/^at /, '')).join(' < ');
		const line = '  ' + g.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 70) + '  <-  ' + frames.slice(0, 220);
		if (!seen.has(line)) { seen.add(line); console.log(line); }
	}
	const traces = await page.evaluate(() => window.__clipFetches || []);
	const byUrl = new Map();
	for (const t of traces) {
		const k = t.url.replace(/^https?:\/\/[^/]+/, '');
		if (!byUrl.has(k)) byUrl.set(k, []);
		byUrl.get(k).push(t.stack);
	}
	console.log('\n=== in-page fetch() calls for clips ===');
	for (const [k, stacks] of [...byUrl].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
		console.log(' ', String(stacks.length).padStart(3), 'x', k);
		const frames = stacks[0].split('\n').slice(1, 7).map((l) => '        ' + l.trim());
		console.log(frames.join('\n'));
	}
} catch (err) {
	console.log('[trace read failed]', String(err).slice(0, 160));
}

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(() => {});
await browser.close();
