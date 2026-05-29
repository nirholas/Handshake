// Verifies the /walk mobile-touch fixes:
//  1. joystick z-index lifts above the bottom HUD (z9)
//  2. on touch, the chat sits above the joystick band (~184px from bottom)
//  3. on touch, the keyboard help overlay does NOT auto-show on first visit
//     (and, as a control, DOES auto-show on desktop)
import puppeteer from 'puppeteer';

const URL = process.env.WALK_URL || 'http://localhost:3000/walk';

async function probe({ touch }) {
	const browser = await puppeteer.launch({
		headless: 'new',
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	});
	const page = await browser.newPage();
	if (touch) {
		// hasTouch + isMobile makes Chrome report pointer:coarse / hover:none
		// and exposes ontouchstart — both branches of IS_TOUCH are satisfied.
		await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
	} else {
		await page.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
	}
	const consoleErrors = [];
	page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
	page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

	// The walk page holds open sockets (multiplayer) so it never reaches
	// networkidle — wait for DOM + a settle window for joystick/help mount.
	await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.waitForSelector('#walk-joystick', { timeout: 20000 }).catch(() => {});
	await new Promise((r) => setTimeout(r, 2500));

	const result = await page.evaluate(() => {
		const isTouchDetected = matchMedia('(hover: none) and (pointer: coarse)').matches
			|| ('ontouchstart' in window && navigator.maxTouchPoints > 0);
		const cs = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const s = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return { zIndex: s.zIndex, bottom: s.bottom, width: s.width, display: s.display,
				visible: r.width > 0 && r.height > 0 && s.display !== 'none' };
		};
		const overlay = document.getElementById('walk-help-overlay');
		return {
			isTouchDetected,
			joystick: cs('#walk-joystick'),
			lookJoystick: cs('#walk-look-joystick'),
			chat: cs('.walk-chat'),
			helpOverlay: overlay ? {
				ariaHidden: overlay.getAttribute('aria-hidden'),
				opacity: getComputedStyle(overlay).opacity,
			} : null,
		};
	});
	await browser.close();
	return { ...result, consoleErrors };
}

const mobile = await probe({ touch: true });
const desktop = await probe({ touch: false });

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });

ok('mobile: touch detected', mobile.isTouchDetected === true, `IS_TOUCH=${mobile.isTouchDetected}`);
ok('mobile: joystick z-index = 9', mobile.joystick?.zIndex === '9', `z=${mobile.joystick?.zIndex}`);
ok('mobile: look-joystick z-index = 9', mobile.lookJoystick?.zIndex === '9', `z=${mobile.lookJoystick?.zIndex}`);
ok('mobile: chat lifted above stick band (bottom ≥ 180px)',
	parseFloat(mobile.chat?.bottom) >= 180, `bottom=${mobile.chat?.bottom}`);
ok('mobile: help overlay NOT auto-shown',
	!mobile.helpOverlay || mobile.helpOverlay.ariaHidden === 'true' || mobile.helpOverlay.opacity === '0',
	`aria-hidden=${mobile.helpOverlay?.ariaHidden} opacity=${mobile.helpOverlay?.opacity}`);
ok('mobile: no console errors', mobile.consoleErrors.length === 0, mobile.consoleErrors.slice(0, 3).join(' | '));

ok('desktop control: touch NOT detected', desktop.isTouchDetected === false, `IS_TOUCH=${desktop.isTouchDetected}`);
ok('desktop control: help overlay DOES auto-show (proves guard is the suppressor)',
	desktop.helpOverlay && desktop.helpOverlay.ariaHidden === 'false',
	`aria-hidden=${desktop.helpOverlay?.ariaHidden} opacity=${desktop.helpOverlay?.opacity}`);

let failed = 0;
for (const c of checks) {
	console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
	if (!c.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
