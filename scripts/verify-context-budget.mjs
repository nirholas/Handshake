// Verifies the <agent-3d> WebGL context budget: stacks 14 avatars (> budget),
// scrolls top→bottom→top, and asserts the browser never logs "Too many active
// WebGL contexts" — i.e. offscreen viewers released their contexts. Run while
// `npm run dev` is up on port 3000.
import puppeteer from 'puppeteer';

const URL = process.env.URL || 'http://localhost:3000/scripts/verify-context-budget.html';
const CHROME = '/home/codespace/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome';

const browser = await puppeteer.launch({
	executablePath: CHROME,
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
	defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();

let tooMany = 0;
let contextLost = 0;
const errors = [];
page.on('console', (msg) => {
	const t = msg.text();
	if (/Too many active WebGL contexts/i.test(t)) tooMany++;
	if (/Context Lost/i.test(t)) contextLost++;
	if (msg.type() === 'error') errors.push(t);
	if (process.env.LOG_ALL) console.log(`[${msg.type()}] ${t}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
// Let Vite transform the module graph and the avatars boot.
await new Promise((r) => setTimeout(r, 6000));

// Scroll through the whole stack and back so every viewer boots, then the
// offscreen ones get evicted by the budget.
const height = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0; y <= height; y += 500) {
	await page.evaluate((yy) => window.scrollTo(0, yy), y);
	await new Promise((r) => setTimeout(r, 250));
}
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 1500));

// Count canvases / live WebGL contexts across the page, piercing shadow DOM
// (each <agent-3d> renders inside its own shadow root).
const { canvases, live } = await page.evaluate(() => {
	const all = [];
	const walk = (root) => {
		for (const el of root.querySelectorAll('*')) {
			if (el.tagName === 'CANVAS') all.push(el);
			if (el.shadowRoot) walk(el.shadowRoot);
		}
	};
	walk(document);
	let live = 0;
	for (const c of all) {
		const gl = c.getContext('webgl2') || c.getContext('webgl');
		if (gl && !gl.isContextLost()) live++;
	}
	return { canvases: all.length, live };
});

await browser.close();

console.log(`agents stacked      : 14`);
console.log(`canvases (all roots): ${canvases}`);
console.log(`live WebGL contexts : ${live}`);
console.log(`"Too many" warnings : ${tooMany}`);
console.log(`page errors         : ${errors.length}`);
if (errors.length) console.log(errors.slice(0, 5).join('\n'));

if (tooMany > 0) {
	console.error('\nFAIL: browser exhausted its WebGL context budget.');
	process.exit(1);
}
if (errors.length > 0) {
	console.error('\nFAIL: page errors detected.');
	process.exit(1);
}
console.log('\nPASS: context budget held — no WebGL exhaustion.');
