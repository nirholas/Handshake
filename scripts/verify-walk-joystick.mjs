// Headless verify for /walk joystick on a desktop viewport.
// Confirms the joystick element is visible (not display:none) and nipplejs
// initialized a stick inside it. The downstream movement wiring is the same
// path that already works on touch devices, so once the stick exists and the
// zone has real dimensions, mouse-drag drives the avatar through the same
// move → tick → avatar.position pipeline. Run while `npm run dev` is up.
import puppeteer from 'puppeteer';

const URL = process.env.URL || 'http://localhost:3003/walk';

const browser = await puppeteer.launch({
	executablePath: '/home/codespace/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
	args: [
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--ignore-gpu-blocklist',
	],
	defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

console.log(`→ ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// Let nipplejs initialize.
await new Promise(r => setTimeout(r, 1500));

const state = await page.evaluate(() => {
	const el = document.getElementById('walk-joystick');
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	const nipple = el.querySelector('.nipple');
	const back = el.querySelector('.back');
	const front = el.querySelector('.front');
	return {
		display: cs.display,
		pointerEvents: cs.pointerEvents,
		width: r.width,
		height: r.height,
		left: r.left,
		bottom: window.innerHeight - r.bottom,
		hasNipple: !!nipple,
		hasBack: !!back,
		hasFront: !!front,
	};
});
console.log('joystick:', state);

const ok =
	state.display !== 'none' &&
	state.width > 0 &&
	state.height > 0 &&
	state.hasBack &&
	state.hasFront;

if (consoleErrors.length) {
	console.log('console errors:');
	for (const e of consoleErrors) console.log('  -', e);
}

await browser.close();

if (!ok) {
	console.error('FAIL — joystick not properly initialized on desktop');
	process.exit(1);
}
console.log('OK — joystick visible on desktop, nipplejs initialized');
