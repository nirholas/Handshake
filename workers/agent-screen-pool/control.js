// control.js, the caster's input dispatcher. Turns sanitized wire events drained
// from the control channel (/api/agent-screen-control-drain) into real input on
// the live Chromium page via Playwright. Coordinates arrive NORMALIZED (0..1) so
// they map cleanly onto the caster's real viewport regardless of the driver's
// display size.
//
// The API already sanitizes every event, but this module re-clamps coordinates
// and re-guards navigation as defense in depth, the caster never trusts the
// queue blindly.

const VP_DEFAULT = { width: 1280, height: 720 };

const clamp01 = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	return v < 0 ? 0 : v > 1 ? 1 : v;
};

// Mirror of the API-side nav guard (src/shared/agent-screen-control.js). The
// worker is deployed standalone and cannot import repo-shared code, so the guard
// is duplicated here on purpose, keep the two in sync.
function ipv4Parts(host) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return null;
	const p = m.slice(1).map(Number);
	if (p.some((n) => n > 255)) return null;
	return p;
}
function isPrivateIpv4([a, b]) {
	if (a === 0 || a === 127 || a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}
export function isNavAllowed(rawUrl) {
	let u;
	try { u = new URL(String(rawUrl)); } catch { return false; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	let host = u.hostname.toLowerCase();
	if (!host) return false;
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (host === 'localhost' || host.endsWith('.localhost')) return false;
	if (host === 'metadata.google.internal' || host.endsWith('.internal')) return false;
	if (host === '::1' || host === '::') return false;
	if (/^fe80:/i.test(host)) return false;
	if (/^f[cd][0-9a-f]{2}:/i.test(host)) return false;
	const v4 = ipv4Parts(host);
	if (v4 && isPrivateIpv4(v4)) return false;
	return true;
}

// Map a normalized event's (x,y) to real pixels within the viewport.
function toPixels(ev, vp) {
	return [Math.round(clamp01(ev.x) * (vp.width - 1)), Math.round(clamp01(ev.y) * (vp.height - 1))];
}

// Apply ONE event to the page. Isolated try/catch so a click that lands mid
// navigation (or any transient Playwright error) never aborts the rest of the
// gesture. Returns true if the event likely changed the page enough to warrant an
// immediate fresh frame (click / key / nav), so the driver sees feedback fast.
async function applyOne(page, ev, vp) {
	try {
		switch (ev.t) {
			case 'move': {
				const [x, y] = toPixels(ev, vp);
				await page.mouse.move(x, y);
				return false;
			}
			case 'down': {
				const [x, y] = toPixels(ev, vp);
				await page.mouse.move(x, y);
				await page.mouse.down({ button: ev.button || 'left' });
				return false;
			}
			case 'up': {
				const [x, y] = toPixels(ev, vp);
				await page.mouse.move(x, y);
				await page.mouse.up({ button: ev.button || 'left' });
				return true;
			}
			case 'click': {
				const [x, y] = toPixels(ev, vp);
				await page.mouse.click(x, y, { button: ev.button || 'left' });
				return true;
			}
			case 'scroll': {
				const [x, y] = toPixels(ev, vp);
				await page.mouse.move(x, y);
				await page.mouse.wheel(0, Number(ev.dy) || 0);
				return true;
			}
			case 'key':
				await page.keyboard.press(String(ev.key));
				return true;
			case 'text':
				await page.keyboard.type(String(ev.text), { delay: 12 });
				return true;
			case 'nav':
				if (!isNavAllowed(ev.url)) return false;
				await page.goto(String(ev.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
				return true;
			case 'back':
				await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
				return true;
			case 'forward':
				await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
				return true;
			case 'reload':
				await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
				return true;
			default:
				return false;
		}
	} catch {
		return false;
	}
}

// Apply a batch of drained events in order. Returns { changed } where changed is
// true if any event warrants an immediate frame push.
export async function applyEvents(page, events, viewport = VP_DEFAULT) {
	if (!page || page.isClosed?.() || !Array.isArray(events) || !events.length) {
		return { changed: false };
	}
	const vp = {
		width: Number(viewport?.width) || VP_DEFAULT.width,
		height: Number(viewport?.height) || VP_DEFAULT.height,
	};
	let changed = false;
	for (const ev of events) {
		if (page.isClosed?.()) break;
		const c = await applyOne(page, ev, vp);
		changed = changed || c;
	}
	return { changed };
}
