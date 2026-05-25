import { chromium } from 'playwright';

// SwiftShader headless WebGL is flaky on three.js scenes (see memory:
// playwright-webgl-headless). Use the canonical recipe: --use-gl=swiftshader,
// --enable-unsafe-swiftshader, and an ignore-list for the known crash strings.
const browser = await chromium.launch({
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-dev-shm-usage',
	],
});
const ctx = await browser.newContext({
	viewport: { width: 1024, height: 720 },
	userAgent: 'Mozilla/5.0 walk-smoke-test',
});
const page = await ctx.newPage();

const consoleMessages = [];
const pageErrors = [];
page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) => pageErrors.push(err.message));

await page.goto('http://localhost:3000/walk', { waitUntil: 'domcontentloaded', timeout: 15000 });
// Give the avatar/animation manifest a moment to fetch + parse.
await page.waitForTimeout(4500);

const ui = await page.evaluate(() => ({
	hasArBtn: !!document.getElementById('walk-ar-toggle'),
	hasRecordBtn: !!document.getElementById('walk-record-btn'),
	hasArCta: !!document.getElementById('walk-ar-cta'),
	hasRecordStatus: !!document.getElementById('walk-record-status'),
	canvasSize: (() => {
		const c = /** @type {HTMLCanvasElement|null} */(document.getElementById('walk-canvas'));
		return c ? { w: c.width, h: c.height } : null;
	})(),
	statusText: document.getElementById('walk-status')?.textContent || null,
}));

const fatal = pageErrors.filter((m) =>
	!/swiftshader|webgl context|GroupMarkerNotSet|TextureProxy|GL_/i.test(m),
);
const errs = consoleMessages.filter((m) =>
	m.type === 'error' && !/swiftshader|webgl context|GroupMarkerNotSet|TextureProxy|GL_|Failed to load resource/i.test(m.text),
);

console.log('UI present:', JSON.stringify(ui, null, 2));
console.log('\nfatal pageerrors (filtered):', fatal);
console.log('console errors (filtered):', errs);
console.log('\nall pageerrors:', pageErrors);
console.log('all console (last 20):', consoleMessages.slice(-20));

await browser.close();

if (fatal.length > 0 || errs.length > 0) {
	process.exit(1);
}
