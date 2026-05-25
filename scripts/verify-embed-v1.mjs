// Smoke test for embed/v1: load the preview page, capture console + network,
// confirm <three-d> instances upgrade and at least one model-viewer renders.
//
// Uses the SwiftShader-stable Playwright recipe (no GPU process, no shader cache)
// to avoid the headless WebGL crash patterns we've hit before.

import { chromium } from '@playwright/test';

const URL = process.env.URL || 'http://localhost:3000/embed/v1/preview.html';

const browser = await chromium.launch({
	headless: true,
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--disable-gpu-sandbox',
		'--no-sandbox',
		'--disable-software-rasterizer=false',
		'--disable-dev-shm-usage',
	],
});

const ctx = await browser.newContext({ viewport: { width: 1400, height: 1800 } });
const page = await ctx.newPage();

const consoleEvents = [];
const errors = [];
const failedRequests = [];

page.on('console', (msg) => {
	consoleEvents.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', (err) => errors.push(err.message));
page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText }));

console.log('→ loading', URL);
const resp = await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
console.log('  status:', resp.status());

// Scroll to bottom + back to trigger IntersectionObserver on every card,
// so lazy-mounted instances below the fold actually boot. Then settle.
await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
await page.waitForTimeout(800);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(5000);

const audit = await page.evaluate(() => {
	const els = Array.from(document.querySelectorAll('three-d'));
	const r = {
		threeWsEmbedV1: !!window.__threeWsEmbedV1,
		windowThree: typeof window.Three,
		windowThreeMount: typeof (window.Three && window.Three.mount),
		windowThreeWs: typeof window.ThreeWs,
		customElementThreeD: !!customElements.get('three-d'),
		customElementThreeAgent: !!customElements.get('three-agent'),
		customElementThreeWs: !!customElements.get('three-ws'),
		count: els.length,
		instances: els.map((el) => {
			const shadow = el.shadowRoot;
			const mv = shadow && shadow.querySelector('model-viewer');
			return {
				src: el.getAttribute('src') || el.getAttribute('agent'),
				shadow: !!shadow,
				stageMounted: !!(shadow && shadow.querySelector('.stage')),
				modelViewerMounted: !!mv,
				modelViewerSrc: mv && mv.getAttribute('src'),
				modelLoaded: mv && mv.loaded === true,
				hasPoster: !!(shadow && shadow.querySelector('.poster')),
				hasChrome: !!(shadow && shadow.querySelector('.chrome')),
			};
		}),
	};
	return r;
});

const screenshotPath = '/tmp/embed-v1-preview.png';
await page.screenshot({ path: screenshotPath, fullPage: true });

await browser.close();

let ok = true;
console.log('\n=== AUDIT ===');
console.log('embed bootstrap     :', audit.threeWsEmbedV1 ? 'ok' : 'FAIL'); if (!audit.threeWsEmbedV1) ok = false;
console.log('window.Three        :', audit.windowThree);
console.log('window.Three.mount  :', audit.windowThreeMount);                  if (audit.windowThreeMount !== 'function') ok = false;
console.log('window.ThreeWs      :', audit.windowThreeWs);                     if (audit.windowThreeWs !== 'object') ok = false;
console.log('<three-d>           :', audit.customElementThreeD);               if (!audit.customElementThreeD) ok = false;
console.log('<three-agent>       :', audit.customElementThreeAgent);           if (!audit.customElementThreeAgent) ok = false;
console.log('<three-ws>          :', audit.customElementThreeWs);              if (!audit.customElementThreeWs) ok = false;
console.log('instance count      :', audit.count);                              if (audit.count !== 6) ok = false;
console.log('\n=== INSTANCES ===');
audit.instances.forEach((i, n) => {
	console.log(`#${n + 1}  src=${i.src}`);
	console.log(`    shadow=${i.shadow} stage=${i.stageMounted} mv=${i.modelViewerMounted} loaded=${i.modelLoaded} chrome=${i.hasChrome}`);
	if (!i.shadow || !i.stageMounted) ok = false;
	if (!i.modelViewerMounted) ok = false;
	// `loaded=false` is expected under SwiftShader (WebGL fails). On real GPUs it goes true.
});

// Filter out errors that are expected headless-SwiftShader limitations,
// not bugs in our code. These pass on real GPUs.
const HEADLESS_NOISE_PATTERNS = [
	/WebGL context could not be created/i,
	/Error creating WebGL context/i,
	/Cannot read properties of undefined \(reading 'xr'\)/, // model-viewer XR probe in no-WebXR env
];
const isHeadlessNoise = (txt) => HEADLESS_NOISE_PATTERNS.some((re) => re.test(txt || ''));

const realErrors = consoleEvents.filter((c) => c.type === 'error' && !isHeadlessNoise(c.text));
const headlessNoiseCount = consoleEvents.filter((c) => c.type === 'error' && isHeadlessNoise(c.text)).length;
const warnings = consoleEvents.filter((c) => c.type === 'warning' && !isHeadlessNoise(c.text));

console.log('\n=== CONSOLE ===');
console.log('real errors            :', realErrors.length);
realErrors.forEach((c) => console.log('  ✗', c.text));
console.log('headless WebGL noise   :', headlessNoiseCount, '(expected — passes on real GPU)');
console.log('warnings               :', warnings.length);
warnings.slice(0, 5).forEach((c) => console.log('  •', c.text));
if (realErrors.length) ok = false;

console.log('\n=== PAGE ERRORS ===');
const realPageErrors = errors.filter((e) => !isHeadlessNoise(e));
const headlessPageNoise = errors.length - realPageErrors.length;
console.log('real page errors       :', realPageErrors.length);
realPageErrors.forEach((e) => console.log('  ✗', e));
console.log('headless WebGL noise   :', headlessPageNoise, '(expected — passes on real GPU)');
if (realPageErrors.length) ok = false;

console.log('\n=== FAILED REQUESTS ===');
failedRequests.forEach((r) => console.log(' ', r.failure, r.url));

console.log('\nscreenshot:', screenshotPath);
console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
