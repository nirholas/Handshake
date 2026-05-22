// Headless smoke test for /demos/3d-home.html.
// Boots Chromium, loads the page, watches for console errors and failed
// requests, asserts the chips wire up and the avatar GLB loads, then exits.
// Run while `npm run dev` is up on port 3000.
import puppeteer from 'puppeteer';

const URL = process.env.URL || 'http://localhost:3000/demos/3d-home.html';
const PERFORM_CLIPS = ['wave', 'rumba', 'celebrate', 'taunt'];

const browser = await puppeteer.launch({
	executablePath: '/home/codespace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
	defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', msg => {
	const t = msg.type();
	if (t === 'error') consoleErrors.push(msg.text());
	if (process.env.LOG_ALL) console.log(`[browser ${t}] ${msg.text()}`);
});
page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
page.on('requestfailed', req => {
	const url = req.url();
	// Vite dev injects HMR/WebSocket — ignore those.
	if (url.includes('@vite') || url.startsWith('ws://')) return;
	failedRequests.push(`${req.method()} ${url} — ${req.failure()?.errorText}`);
});

page.on('response', async res => {
	const status = res.status();
	const url = res.url();
	if (status >= 400 && (url.includes('avatars/') || url.includes('animations/'))) {
		failedRequests.push(`HTTP ${status} ${url}`);
	}
});

const networked = [];
page.on('response', res => {
	const url = res.url();
	if (url.includes('avatars/') || url.includes('animations/clips/')) {
		networked.push(`${res.status()} ${url.replace(URL, '')}`);
	}
});

console.log(`→ ${URL}`);
// Vite's HMR WebSocket keeps the page from ever reaching networkidle, so just
// wait for DOM ready and let waitForFunction handle the rest.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// Wait for chips to be enabled (clips finished loading)
await page.waitForFunction(
	() => [...document.querySelectorAll('#anim-controls .chip')].every(c => !c.disabled),
	{ timeout: 15_000 },
);

// Baseline screenshot: avatar should be seated on the hero title.
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: '/tmp/3d-home-sit.png', fullPage: false });
console.log('baseline (sit) screenshot: /tmp/3d-home-sit.png');

const chips = await page.$$eval('#anim-controls .chip', els =>
	els.map(e => ({ clip: e.dataset.clip, label: e.textContent.trim(), disabled: e.disabled })),
);
console.log('chips:', chips);

// Click each chip in turn — verify aria-pressed flips, then resumes
for (const clip of PERFORM_CLIPS) {
	await page.click(`#anim-controls .chip[data-clip="${clip}"]`);
	await new Promise(r => setTimeout(r, 200));
	const pressed = await page.$eval(
		`#anim-controls .chip[data-clip="${clip}"]`,
		el => el.getAttribute('aria-pressed'),
	);
	console.log(`  ${clip} → aria-pressed=${pressed}`);
	if (pressed !== 'true') throw new Error(`chip ${clip} did not register as pressed`);
	// Wait for resume to sit cycle (rumba is a 6.2s loop; one-shots are ~3s)
	await page.waitForFunction(
		(c) => document.querySelector(`#anim-controls .chip[data-clip="${c}"]`).getAttribute('aria-pressed') === 'false',
		{ timeout: 14_000 },
		clip,
	);
	console.log(`  ${clip} resumed cycle ✓`);
}

console.log('\nNetwork (avatar + clips):');
for (const r of networked) console.log(`  ${r}`);

const ok = consoleErrors.length === 0 && failedRequests.length === 0;
if (!ok) {
	console.error('\nConsole errors:');
	for (const e of consoleErrors) console.error(`  ${e}`);
	console.error('\nFailed requests:');
	for (const r of failedRequests) console.error(`  ${r}`);
}

await page.screenshot({ path: '/tmp/3d-home-verify.png', fullPage: false });
console.log('\nscreenshot: /tmp/3d-home-verify.png');

await browser.close();
if (!ok) process.exit(1);
console.log('\nOK');
