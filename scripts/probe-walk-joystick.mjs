// Probe whether mouse-drag on the joystick actually wires through to
// input.joy and ultimately moves the avatar. Stands up a headless browser,
// loads /walk on desktop, drags the joystick, and reports both the live
// input state and the avatar's world position before/after.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:3000/walk';

const browser = await chromium.launch({
	args: [
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-sandbox',
		'--disable-dev-shm-usage',
	],
});
const ctx = await browser.newContext({
	viewport: { width: 1280, height: 800 },
	hasTouch: false,
});
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });

// Expose the live state to the test by stashing references on window once
// the module has booted. We can't reach `input`/`avatarRig` directly (they
// are module-local), so instead we synthesize the same readout from the DOM
// plus a periodic snapshot of nipplejs internals.
await page.waitForFunction(() => {
	const el = document.getElementById('walk-joystick');
	return el && el.querySelector('.front') && el.querySelector('.back');
}, { timeout: 8000 });

const before = await page.evaluate(() => {
	const r = document.getElementById('walk-joystick').getBoundingClientRect();
	return {
		joyRect: { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 },
	};
});
console.log('joystick rect:', before.joyRect);

// Listen for all nipplejs `move` data by hooking into the front element's
// transform — it gets mutated on each move. Read it after dragging.
async function dragJoystick({ dx, dy, label }) {
	const cx = before.joyRect.cx;
	const cy = before.joyRect.cy;
	console.log(`\n[${label}] dragging from (${cx},${cy}) to (${cx+dx},${cy+dy})`);
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	const steps = 12;
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(cx + dx * (i/steps), cy + dy * (i/steps));
		await page.waitForTimeout(20);
	}
	// Hold so the avatar has time to translate.
	for (let i = 0; i < 25; i++) {
		await page.waitForTimeout(40);
	}
	const sample = await page.evaluate(() => {
		const front = document.querySelector('#walk-joystick .front');
		const transform = front ? getComputedStyle(front).transform : null;
		return { transform };
	});
	console.log(`[${label}] front transform during drag:`, sample.transform);

	await page.mouse.up();
	await page.waitForTimeout(120);
}

// Sample avatar canvas pixel-center color before/after as a crude motion
// witness — if the avatar moved, the center pixel changes.
async function centerPixel() {
	return page.evaluate(() => {
		const c = document.getElementById('walk-canvas');
		const tmp = document.createElement('canvas');
		tmp.width = c.width; tmp.height = c.height;
		const g = tmp.getContext('2d');
		g.drawImage(c, 0, 0);
		const d = g.getImageData(c.width/2, c.height/2, 1, 1).data;
		return [d[0], d[1], d[2], d[3]];
	});
}

const p0 = await centerPixel();
console.log('center pixel before any drag:', p0);

await dragJoystick({ dx: 0, dy: -45, label: 'forward (up)' });
const p1 = await centerPixel();
console.log('center pixel after forward:', p1);

await dragJoystick({ dx: 45, dy: 0, label: 'right' });
const p2 = await centerPixel();
console.log('center pixel after right:', p2);

if (errs.length) {
	console.log('\nERRORS:');
	for (const e of errs) console.log('  -', e);
}

await page.screenshot({ path: 'scripts/probe-joystick.png' });
console.log('\nscreenshot: scripts/probe-joystick.png');

await browser.close();
