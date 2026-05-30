// Headless proof that the /play joystick actually drives the avatar.
// Loads the real page, enters world phase, then performs a REAL mouse-drag on
// the joystick (the exact path the bug lived in: nipplejs v1 event parsing) and
// asserts the local avatar position changes. Fails loudly on any console error.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`${BASE}/pages/play.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__CC__, { timeout: 10000 });

// Put the scene into world phase (bypassing the multiplayer server — we are
// testing input→movement, not netcode) and mount the joystick.
const setup = await page.evaluate(() => {
	const cc = window.__CC__;
	cc.phase = 'world';
	document.getElementById('cc-lobby').hidden = true; // clear the overlay off the stick
	document.getElementById('cc-hud').hidden = false;
	cc._initJoystick();
	const z = document.getElementById('cc-joystick').getBoundingClientRect();
	return {
		nippleReady: !!cc._nipple,
		center: { x: z.x + z.width / 2, y: z.y + z.height / 2 },
		before: { x: cc.localPos.x, z: cc.localPos.z },
	};
});
if (!setup.nippleReady) { console.error('❌ nipplejs did not initialise'); await browser.close(); process.exit(1); }

// Real mouse drag: press on the stick, push UP (forward), hold.
await page.mouse.move(setup.center.x, setup.center.y);
await page.mouse.down();
await page.mouse.move(setup.center.x, setup.center.y - 46, { steps: 6 });

// Let the running rAF loop integrate the movement intent for a few frames.
await page.waitForTimeout(350);
const mid = await page.evaluate(() => ({
	joy: window.__CC__._joy ? { ...window.__CC__._joy } : null,
	pos: { x: window.__CC__.localPos.x, z: window.__CC__.localPos.z },
}));

await page.mouse.up();
await page.waitForTimeout(50);
const after = await page.evaluate(() => ({ joy: window.__CC__._joy }));

await browser.close();

const moved = Math.hypot(mid.pos.x - setup.before.x, mid.pos.z - setup.before.z);
console.log('console errors :', errors.length ? errors : 'none');
console.log('_joy on drag   :', mid.joy);
console.log('pos before     :', setup.before);
console.log('pos after drag :', mid.pos);
console.log('distance moved :', moved.toFixed(3), 'm');
console.log('_joy on release:', after.joy);

let pass = true;
if (errors.length) { console.error('❌ console errors present'); pass = false; }
if (!mid.joy) { console.error('❌ joystick drag did not set _joy (handler threw or no payload)'); pass = false; }
if (moved < 0.05) { console.error('❌ avatar did not move on joystick drag'); pass = false; }
if (after.joy !== null && after.joy !== undefined) { console.error('❌ _joy not cleared on release'); pass = false; }
console.log(pass ? '\n✅ JOYSTICK WORKS — a real drag moves the avatar' : '\n❌ JOYSTICK TEST FAILED');
process.exit(pass ? 0 : 1);
