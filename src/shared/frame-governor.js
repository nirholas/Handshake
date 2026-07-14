// Shared frame governor — caps how often a rAF-driven 3D loop actually runs.
//
// requestAnimationFrame fires at the display's refresh rate: 120/144/240Hz
// panels render 2-4x the frames of a 60Hz one for zero visible benefit in
// our scenes, and an uncapped loop keeps the GPU pinned even when the user
// has clicked away to another window. That is exactly the "fans spin up and
// the laptop runs hot" complaint on /play and /club. The governor sits at
// the top of the loop: schedule rAF every frame as usual, but only run the
// sim + render body when the frame budget for the current cap has elapsed.
// Everything downstream is dt-based, so skipped frames simply arrive as a
// slightly larger delta on the next real one.
//
// It also owns the persisted "power saver" preference (one localStorage key
// shared by every 3D surface) so a user who turned it on in /play gets the
// same relief in /club without hunting for a second toggle.

const POWER_SAVER_KEY = 'tws-power-saver';
const POWER_SAVER_EVENT = 'tws-power-saver-change';

// One vocabulary for every surface, so the caps never drift between pages:
//  - ACTIVE : focused tab, user is playing/watching
//  - IDLE   : tab visible but window unfocused, or a background scene
//             (e.g. the /play lobby's ambient arena behind the coin grid)
//  - SAVER  : power-saver preference is on — hard 30fps everywhere
export const FPS_ACTIVE = 60;
export const FPS_IDLE = 30;
export const FPS_SAVER = 30;

/**
 * Create a frame-rate governor. Call `shouldRun(now, fpsCap)` at the top of
 * the rAF callback with the rAF timestamp; run the frame body only when it
 * returns true.
 *
 * The remainder-carry keeps the average rate honest on displays whose
 * refresh period doesn't divide the budget (a plain `last = now` on a 144Hz
 * panel quantizes a 60fps cap down to ~48fps), and the 0.5ms slack absorbs
 * timer jitter so a true 60Hz panel is never skipped.
 *
 * @returns {{ shouldRun(now: number, fpsCap: number): boolean, reset(): void }}
 */
export function createFrameGovernor() {
	let last = -Infinity;
	return {
		shouldRun(now, fpsCap) {
			if (!Number.isFinite(now)) return true;
			if (!Number.isFinite(fpsCap) || fpsCap <= 0) return false;
			const budget = 1000 / fpsCap - 0.5;
			if (now - last < budget) return false;
			// Carry the overshoot so skipped-frame quantization doesn't lower
			// the average rate; cap the carry at one budget so a long stall
			// (hidden tab, breakpoint) can't queue a burst of instant frames.
			last = Number.isFinite(last) ? now - ((now - last) % budget) : now;
			return true;
		},
		reset() { last = -Infinity; },
	};
}

/**
 * Read the persisted power-saver preference. Safe in private mode, sandboxed
 * iframes, and Node (vitest) — storage failures read as "off".
 */
export function getPowerSaver() {
	try { return localStorage.getItem(POWER_SAVER_KEY) === '1'; } catch { return false; }
}

/**
 * Persist the power-saver preference and notify listeners in this tab.
 * (Other tabs hear it through the native `storage` event.)
 */
export function setPowerSaver(on) {
	try { localStorage.setItem(POWER_SAVER_KEY, on ? '1' : '0'); } catch { /* storage disabled */ }
	if (typeof window !== 'undefined') {
		try { window.dispatchEvent(new CustomEvent(POWER_SAVER_EVENT, { detail: { on: !!on } })); } catch { /* CustomEvent unavailable */ }
	}
}

/**
 * Subscribe to power-saver changes from this tab (custom event) and other
 * tabs (storage event). Returns an unsubscribe function.
 *
 * @param {(on: boolean) => void} fn
 */
export function onPowerSaverChange(fn) {
	if (typeof window === 'undefined') return () => {};
	const onLocal = (e) => fn(!!e.detail?.on);
	const onStorage = (e) => { if (e.key === POWER_SAVER_KEY) fn(e.newValue === '1'); };
	window.addEventListener(POWER_SAVER_EVENT, onLocal);
	window.addEventListener('storage', onStorage);
	return () => {
		window.removeEventListener(POWER_SAVER_EVENT, onLocal);
		window.removeEventListener('storage', onStorage);
	};
}

/**
 * Track whether the window currently has focus, for the IDLE throttle.
 * `document.hasFocus()` seeds the state so a page opened in a background
 * window starts throttled instead of hot. Returns { focused } — read
 * `.focused` each frame; listeners keep it current.
 */
export function trackWindowFocus() {
	const state = { focused: true };
	if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
		try { state.focused = document.hasFocus(); } catch { /* keep default */ }
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('focus', () => { state.focused = true; });
		window.addEventListener('blur', () => { state.focused = false; });
	}
	return state;
}
